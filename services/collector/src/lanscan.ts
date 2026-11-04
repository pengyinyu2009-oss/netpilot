// 局域网新设备发现：周期 SSH 到 R68S 读 ARP 表（ip -4 neigh），基线之后新出现的 MAC
// 触发告警 + ntfy 通知；known 集合持久化在 SQLite，重启不丢基线
import type { NetworkConfig } from '../core-src/types.ts';
import { sshRun } from './sshrun.ts';
import { alertWithNotify } from './notify.ts';
import * as store from './store.ts';

export class LanScanner {
  private timer: NodeJS.Timeout | null = null;

  constructor(private cfg: NetworkConfig) {}

  start() {
    const spec = this.cfg.router.lanscan;
    if (!spec?.enabled) { console.log('[lanscan] disabled'); return; }
    const everyMs = Math.max(30, spec.everySeconds ?? 60) * 1000;
    const run = async () => {
      try { await this.scan(); }
      catch (e) { store.logEvent('warn', 'lanscan', `扫描失败: ${(e as Error).message}`); }
    };
    setTimeout(run, 15_000);   // 启动 15s 后首扫（建基线）
    setInterval(run, everyMs);
  }

  private async scan() {
    const r = this.cfg.router;
    const ssh = r.ssh;
    if (!ssh) throw new Error('router.ssh 未配置');
    const out = await sshRun(
      { host: r.host, user: ssh.user, passwordEnv: 'R68S_SSH_PASSWORD' },
      'ip -4 neigh show 2>/dev/null || ip neigh show',
      20_000,
    );
    const seen = new Map<string, string>();
    for (const line of out.split('\n')) {
      const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]{17})/i);
      if (!m) continue;
      seen.set(m[2].toLowerCase(), m[1]);
    }
    const fresh = store.lanScan([...seen].map(([mac, ip]) => ({ mac, ip })));
    store.lanBaselineDone();   // 首扫建基线后封口，之后的增量才告警
    for (const f of fresh) {
      store.logEvent('info', 'lanscan', `新设备接入 ${f.ip} (${f.mac})`);
      alertWithNotify('lan-new', 'info', `局域网新设备接入：${f.ip} (${f.mac})`, { mac: f.mac, ip: f.ip });
    }
  }
}
