// M3 修复引擎：声明式守护规则（network.yaml repairs），30s 主循环按 everySeconds 到期调度
// check 连续 failStreak 轮失败 → 执行 heal（审计）→ 告警+通知；恢复自动关闭告警
import net from 'node:net';
import tls from 'node:tls';
import type { NetworkConfig, RepairSpec, RepairState, CheckSpec, ActionSpec } from '../core-src/types.ts';
import type { MihomoClient } from './mihomo.ts';
import { sshRun, type SshTarget } from './sshrun.ts';
import { alertWithNotify } from './notify.ts';
import * as store from './store.ts';

const TICK_MS = 30_000;

interface CheckResult { ok: boolean; detail: string }

function tcpAlive(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

// TLS 证书剩余有效天数（自签/不可达返回 -1）
function certDays(host: string, port: number, timeoutMs = 8000): Promise<number> {
  return new Promise(resolve => {
    let settled = false;
    const fin = (v: number) => { if (!settled) { settled = true; try { s.destroy(); } catch { /* */ } resolve(v); } };
    const s = tls.connect({ host, port, servername: host, timeout: timeoutMs, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      const to = c?.valid_to ? new Date(c.valid_to).getTime() : NaN;
      fin(Number.isNaN(to) ? -1 : Math.floor((to - Date.now()) / 86_400_000));
    });
    s.once('error', () => fin(-1));
    s.once('timeout', () => fin(-1));
  });
}

function targetOf(t: { host: string; user: string; port?: number; key?: string; passwordEnv?: string }): SshTarget {
  return { host: t.host, user: t.user, port: t.port, key: t.key, passwordEnv: t.passwordEnv };
}

const GROUP_NAME_FILTER = /^(剩余流量|套餐到期|最新地址|订阅|官网|群)|：/;

export class RepairEngine {
  private states = new Map<string, RepairState>();
  private lastValue = new Map<string, number>();   // ssh_threshold 基线/上一次取值
  private busy = new Set<string>();

  constructor(private cfg: NetworkConfig, private mihomo: MihomoClient) {
    for (const r of cfg.repairs) {
      this.states.set(r.id, {
        enabled: this.effectiveEnabled(r), lastRun: null, lastOk: null,
        lastDetail: '', failStreak: 0, healCount: 0, lastHeal: null, nextRun: null,
      });
    }
  }

  // 运行时开关覆盖 yaml（DB kv 持久化，容器重建不丢）
  private effectiveEnabled(r: RepairSpec): boolean {
    const v = store.getKv(`repair:${r.id}:enabled`);
    return v == null ? r.enabled : v === '1';
  }

  listRepairs(): (RepairSpec & { state: RepairState })[] {
    return this.cfg.repairs.map(r => ({ ...r, state: this.states.get(r.id)! }));
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const r = this.cfg.repairs.find(x => x.id === id);
    if (!r) return false;
    store.setKv(`repair:${id}:enabled`, enabled ? '1' : '0');
    const s = this.states.get(id)!;
    s.enabled = enabled;
    store.logEvent('info', 'repair', `规则 ${r.name} 已${enabled ? '启用' : '停用'}`);
    return true;
  }

  async runNow(id: string): Promise<boolean> {
    const r = this.cfg.repairs.find(x => x.id === id);
    if (!r) return false;
    await this.runRule(r);
    return true;
  }

  start() {
    if (!this.cfg.repairs.length) return;
    console.log(`[netpilot] repairs: ${this.cfg.repairs.map(r => r.id).join(', ')}`);
    setInterval(() => void this.tick(), TICK_MS).unref();
  }

  private async tick() {
    const now = Date.now();
    for (const r of this.cfg.repairs) {
      const s = this.states.get(r.id)!;
      if (!s.enabled || this.busy.has(r.id)) continue;
      if (s.lastRun != null && now - s.lastRun < r.everySeconds * 1000) continue;
      await this.runRule(r);
    }
  }

  private async runRule(r: RepairSpec) {
    const s = this.states.get(r.id)!;
    if (this.busy.has(r.id)) return;
    this.busy.add(r.id);
    s.lastRun = Date.now();
    try {
      const res = await this.check(r.check);
      const wasFailing = s.failStreak > 0;
      s.lastOk = res.ok;
      s.lastDetail = res.detail.slice(0, 300);
      if (res.ok) {
        if (wasFailing) {
          s.failStreak = 0;
          store.ackAlertsByRulePrefix(`repair:${r.id}`);
          store.logEvent('info', 'repair', `✅ ${r.name} 恢复正常（${s.lastDetail}）`);
        } else {
          s.failStreak = 0;
        }
      } else {
        s.failStreak += 1;
        const threshold = r.failStreak ?? 2;
        if (s.failStreak >= threshold) {
          let healNote = '';
          if (r.heal && r.heal.kind !== 'none') {
            store.logEvent('warn', 'repair', `🔧 ${r.name} 第 ${s.failStreak} 轮异常，执行修复动作（${s.lastDetail}）`);
            try {
              await this.heal(r.heal);
              s.healCount += 1;
              s.lastHeal = Date.now();
              healNote = '，已执行自动修复';
            } catch (e) {
              healNote = `，修复动作失败：${(e as Error).message}`.slice(0, 120);
              store.logEvent('error', 'repair', `${r.name} 修复动作失败：${(e as Error).message}`);
            }
          }
          alertWithNotify(`repair:${r.id}`, 'warning',
            `${r.name} 连续 ${s.failStreak} 轮检查异常（${s.lastDetail}）${healNote}`,
            { rule: r.id, detail: s.lastDetail });
        }
      }
    } catch (e) {
      s.lastOk = false;
      s.lastDetail = `check error: ${(e as Error).message}`.slice(0, 300);
      s.failStreak += 1;
    } finally {
      s.nextRun = s.lastRun! + r.everySeconds * 1000;
      this.busy.delete(r.id);
    }
  }

  private async check(c: CheckSpec): Promise<CheckResult> {
    switch (c.kind) {
      case 'group_alive': {
        const g = await this.mihomo.groups() as { proxies: { name: string; now?: string }[] };
        const now = g.proxies.find(x => x.name === c.group)?.now;
        if (!now) return { ok: false, detail: `${c.group} 当前无选中节点` };
        const d = await this.mihomo.delayOf(now, c.timeoutMs ?? 6000);
        return d != null
          ? { ok: true, detail: `${c.group} → ${now} ${d}ms` }
          : { ok: false, detail: `${c.group} → ${now} 拨测超时/失败` };
      }
      case 'tcp': {
        const ok = await tcpAlive(c.host, c.port);
        return ok ? { ok: true, detail: `${c.host}:${c.port} 可达` }
                  : { ok: false, detail: `${c.host}:${c.port} 不可达` };
      }
      case 'cert_days': {
        const days = await certDays(c.host, c.port);
        return days < 0
          ? { ok: false, detail: `${c.host}:${c.port} 证书获取失败` }
          : days < c.minDays
            ? { ok: false, detail: `${c.host}:${c.port} 证书仅剩 ${days} 天（阈值 ${c.minDays}）` }
            : { ok: true, detail: `${c.host}:${c.port} 证书剩余 ${days} 天` };
      }
      case 'ssh_expect': {
        const out = await sshRun(targetOf(c), c.command);
        const re = new RegExp(c.expect, 's');
        const hit = re.test(out.trim());   // Windows PowerShell 输出带 \r\n，先裁剪再匹配
        return hit ? { ok: true, detail: out.trim().slice(0, 200) || '匹配' }
                   : { ok: false, detail: `输出不匹配 ${c.expect}：${out.trim().slice(0, 200)}` };
      }
      case 'ssh_threshold': {
        const out = await sshRun(targetOf(c), c.command);
        const v = parseInt(out.trim().match(/-?\d+/)?.[0] ?? 'NaN', 10);
        if (Number.isNaN(v)) return { ok: false, detail: `无法解析数值：${out.trim().slice(0, 120)}` };
        this.lastValue.set(`${c.host}:${c.command}`, v);
        return v <= c.max
          ? { ok: true, detail: `当前值 ${v}（阈值 ${c.max}）` }
          : { ok: false, detail: `当前值 ${v} 超阈值 ${c.max}` };
      }
    }
  }

  private async heal(a: ActionSpec): Promise<string> {
    switch (a.kind) {
      case 'none':
        return 'noop';
      case 'ssh': {
        const out = await sshRun(targetOf(a), a.command, 40_000);
        store.logEvent('warn', 'repair', `SSH 修复动作已执行 @${a.user}@${a.host}：${a.command.slice(0, 120)}`);
        return out.trim().slice(0, 200);
      }
      case 'switch_group_best': {
        // 整组拨测 → 从存活成员里选延迟最低者 → 切换
        const delays = await this.mihomo.delayGroup(a.group, 5000);
        if (!delays || !Object.keys(delays).length) throw new Error('整组拨测无存活成员');
        const best = Object.entries(delays)
          .filter(([n]) => !GROUP_NAME_FILTER.test(n) && n !== 'DIRECT' && n !== 'REJECT')
          .sort((x, y) => x[1] - y[1])[0];
        if (!best) throw new Error('无可用成员');
        await this.mihomo.selectProxy(a.group, best[0]);
        store.logEvent('warn', 'repair', `switch_group_best ${a.group} → ${best[0]}（${best[1]}ms）`);
        return `${a.group} → ${best[0]} ${best[1]}ms`;
      }
    }
  }
}
