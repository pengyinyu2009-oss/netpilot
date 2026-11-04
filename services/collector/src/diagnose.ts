// 一键诊断：舰队健康一页 pass/fail
import type { NetworkConfig } from '../core-src/types.ts';
import type { Poller } from './poller.ts';
import type { MihomoClient } from './mihomo.ts';
import type { RepairEngine } from './repairs.ts';
import * as store from './store.ts';

interface DiagItem { name: string; ok: boolean; detail: string }

export async function diagnose(cfg: NetworkConfig, mihomo: MihomoClient, poller: Poller, repairs: RepairEngine) {
  const s = poller.fleetStatus();
  const items: DiagItem[] = [];
  const now = Date.now();

  items.push({ name: 'R68S OpenClash', ok: s.router.reachable,
    detail: s.router.reachable ? `mihomo ${s.router.version ?? '?'} · ${s.counts.connections} 连接` : 'API 不可达' });

  for (const d of s.devices) {
    const ok = d.latest?.ok ?? false;
    items.push({ name: `${d.name} 探针`, ok, detail: ok ? `${d.latest?.latencyMs ?? '?'}ms` : '探针失败' });
  }

  for (const d of s.devices) {
    // 移动设备/网关类（ICMP-only，无法装 agent）不算缺 agent
    if (d.role === 'mobile' || d.role === 'gateway') continue;
    const age = d.agent ? Math.round((now - d.agent.lastSeen) / 60000) : null;
    const ok = age != null && age <= 5;
    items.push({ name: `${d.name} agent`, ok,
      detail: age == null ? '未装 agent' : `${age} 分钟前上报` });
  }

  for (const e of s.exits) {
    const ok = e.latest?.ok ?? false;
    items.push({ name: e.name, ok,
      detail: ok ? `${e.latest?.latencyMs ?? '?'}ms` : '探针失败' });
  }

  {
    const t0 = Date.now();
    let ok = false; let detail = '';
    try {
      const dns = await import('node:dns');
      await dns.promises.resolve('www.baidu.com');
      ok = true; detail = `解析 ${Date.now() - t0}ms`;
    } catch (e) { detail = (e as Error).message; }
    items.push({ name: 'DNS 解析', ok, detail });
  }


  const failing = repairs.listRepairs().filter(r => r.state.enabled && r.state.lastOk === false);
  items.push({ name: '守护规则', ok: failing.length === 0,
    detail: failing.length ? `${failing.length} 条异常：${failing.map(r => r.name).join('、')}` : '全部正常' });
  const openA = store.openAlertCount();
  items.push({ name: '未处理告警', ok: openA === 0, detail: `${openA} 条` });
  return { ts: Date.now(), items };
}
