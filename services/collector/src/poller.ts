// 轮询器：把 mihomo 状态与探针结果落入 SQLite，并维护内存快照供 API 读取
import type { NetworkConfig, ConnRow, GroupStatus, FleetStatus, NodeDetail } from '../core-src/types.ts';
import type { MihomoClient } from './mihomo.ts';
import * as store from './store.ts';
import { alertWithNotify } from './notify.ts';
import { runProbeGroup } from './probe.ts';
import { normalizeMetrics } from './ingest.ts';

const HIST_MS = 6 * 60 * 60 * 1000;   // 保留 6 小时细粒度历史

interface GroupsResp {
  proxies: { name: string; type: string; now?: string; all?: string[] }[];
}

export class Poller {
  private connSnapshot: ConnRow[] = [];
  private lastGroups: GroupStatus[] = [];
  private routerVersion: string | null = null;
  private routerUp = false;
  private traffic = { upBps: 0, downBps: 0 };
  private prevTotal: { ts: number; up: number; down: number } | null = null;
  private probeFailStreak = new Map<string, number>();   // 探针连续失败计数 → 告警

  constructor(private cfg: NetworkConfig, private mihomo: MihomoClient) {}

  snapshotConnections() { return this.connSnapshot; }
  snapshotGroups() { return this.lastGroups; }
  routerInfo() { return { version: this.routerVersion, reachable: this.routerUp }; }
  trafficNow() { return this.traffic; }

  // ── mihomo 侧：分组/成员/连接/流量，5s 一次 ──
  async pollMihomo() {
    try {
      const [g, c] = await Promise.all([
        this.mihomo.groups() as Promise<GroupsResp>,
        this.mihomo.connections(),
      ]);
      this.routerUp = true;
      // GLOBAL 是内置模式选择器，不展示；provider 信息项（剩余流量/套餐到期等）不是代理节点
      this.lastGroups = g.proxies
        .filter(x => x.name !== 'GLOBAL')
        .map(x => ({
          name: x.name, type: x.type, now: x.now ?? '', members: [],
        }));
      // 成员延迟从 /proxies 拿（mihomo 自己的 history）
      try {
        const px = await this.mihomo.proxies() as { proxies: Record<string, { type: string; alive: boolean; history: { delay: number }[] }> };
        for (const grp of this.lastGroups) {
          const full = (g.proxies.find(x => x.name === grp.name));
          const all = (full?.all ?? []) as string[];
          grp.members = all
            .filter(n => !/^(剩余流量|套餐到期|最新地址|订阅|官网|群)|：/.test(n) && n !== 'DIRECT' && n !== 'REJECT')
            .map(n => {
              const p = px.proxies[n];
              const h = p?.history ?? [];
              return { name: n, type: p?.type ?? '?', delay: h.length ? h[h.length - 1].delay : null, alive: !!p?.alive };
            });
        }
      } catch { /* 成员延迟缺失不致命 */ }
      // mihomo /connections 元素是宽松结构，用 unknown 收窄避免 any 传染
      const rawConns = (c.connections ?? []) as unknown as Array<{
        metadata?: Record<string, string>;
        chains?: string[];
        upload?: number;
        download?: number;
        rule?: string;
      }>;
      this.connSnapshot = rawConns
        .slice(0, 200)
        .map(x => {
          const m = x.metadata ?? {};
          return {
            host: m.host || m.destinationIP || '?',
            src: m.sourceIP || '',
            chains: (x.chains ?? []).join(' / '),
            up: x.upload ?? 0,
            down: x.download ?? 0,
            rule: x.rule ?? '',
          };
        });
      // 流量速率：connections 的累计总量差分（/traffic 是流式端点不可拉）
      const now = Date.now();
      const upTotal = (c as { uploadTotal?: number }).uploadTotal ?? 0;
      const downTotal = (c as { downloadTotal?: number }).downloadTotal ?? 0;
      if (this.prevTotal && now > this.prevTotal.ts) {
        const dt = (now - this.prevTotal.ts) / 1000;
        this.traffic = {
          upBps: Math.max(0, (upTotal - this.prevTotal.up) / dt),
          downBps: Math.max(0, (downTotal - this.prevTotal.down) / dt),
        };
      }
      this.prevTotal = { ts: now, up: upTotal, down: downTotal };
    } catch {
      this.routerUp = false;
    }
  }

  // ── 探针：设备 + 出口，30s 一次，结果入库；连续失败 3 轮触发告警（同规则去重）──
  // 告警豁免：agent 心跳新鲜的节点（探针断 ≠ 节点挂）、role=mobile（平板休眠是常态）
  async pollProbes() {
    const targets: { key: string; id: string; host: string; mobile: boolean; specs: NetworkConfig['devices'][number]['probes'] }[] = [
      ...this.cfg.devices.map(d => ({ key: `dev:${d.id}`, id: d.id, host: d.host, mobile: d.role === 'mobile', specs: d.probes })),
      ...this.cfg.exits.map(e => ({ key: `exit:${e.id}`, id: e.id, host: e.host, mobile: false, specs: e.probes })),
    ];
    await Promise.all(targets.map(async t => {
      const p = await runProbeGroup(t.specs, t.host);
      store.saveMetric(t.key, p);
      const name = t.key.split(':').pop() ?? t.key;
      const kind = t.key.startsWith('exit:') ? '出口' : '设备';
      const agentFresh = (() => {
        const a = store.agentInfo(t.id);
        return !!a && Date.now() - a.lastSeen < 3 * 60_000;
      })();
      if (!p.ok) {
        const n = (this.probeFailStreak.get(t.key) ?? 0) + 1;
        this.probeFailStreak.set(t.key, n);
        if (n === 3 && !t.mobile && !agentFresh) {
          alertWithNotify(`probe_down:${t.key}`, 'warning',
            `${kind} ${name} 探针连续 3 轮不通（${t.host}）`, { host: t.host });
        }
      } else if ((this.probeFailStreak.get(t.key) ?? 0) >= 3) {
        store.logEvent('info', 'probe', `${kind} ${name} 探针恢复`);
      }
      if (p.ok) this.probeFailStreak.delete(t.key);
    }));
    store.pruneMetrics(Date.now() - HIST_MS);
    store.pruneDeviceMetrics(Date.now() - 24 * 60 * 60 * 1000);   // agent 指标保留 24h
  }

  // ── mihomo 节点拨测：关键节点 60s 一次（刷新延迟历史）──
  async pollNodeDelays() {
    const nodes = ['香港-VPS', '美国-VPS', 'WARP-US', 'GCP-US'];
    await Promise.all(nodes.map(async n => {
      const d = await this.mihomo.delayOf(n, 5000);
      store.saveMetric(`node:${n}`, { ts: Date.now(), latencyMs: d, ok: d !== null });
    }));
    try { await this.mihomo.delayGroup('机场自动', 5000); } catch { /* ignore */ }
  }

  // ── 组装舰队状态（API 用）──
  fleetStatus(): FleetStatus {
    const since = Date.now() - 30 * 60 * 1000;
    // agent 最新快照 → 列表行内联摘要（CPU/内存/磁盘百分比）
    const agentSummary = (id: string) => {
      const a = store.agentInfo(id);
      if (!a) return null;
      const m = a.metrics as Record<string, number | null>;
      const memPct = m.memUsed != null && m.memTotal ? Math.round((m.memUsed / m.memTotal) * 100) : null;
      const diskPct = m.diskUsed != null && m.diskTotal ? Math.round((m.diskUsed / m.diskTotal) * 100) : null;
      return { lastSeen: a.lastSeen, cpu: m.cpu ?? null, memPct, diskPct };
    };
    const devices = this.cfg.devices.map(d => {
      const h = store.history(`dev:${d.id}`, since);
      return {
        id: d.id, name: d.name, host: d.host, role: d.role,
        latest: h.length ? h[h.length - 1] : null, history: h,
        agent: agentSummary(d.id),
      };
    });
    const exits = this.cfg.exits.map(e => {
      const h = store.history(`exit:${e.id}`, since);
      const nodeName = e.name.split(' ')[0];
      return {
        id: e.id, name: e.name, host: e.host,
        latest: h.length ? h[h.length - 1] : null, history: h,
        mihomoDelay: null as number | null,
        agent: agentSummary(e.id),
      };
    });
    // mihomo 节点延迟（最新一条）
    for (const ex of exits) {
      const h = store.history(`node:${ex.name.split(' ')[0]}`, since);
      ex.mihomoDelay = h.length ? h[h.length - 1].latencyMs : null;
    }
    // R68S agent 上报的 uptime 填进路由器信息
    const routerAgent = store.agentInfo(this.cfg.router.id);
    const routerUptime = routerAgent
      ? (routerAgent.metrics as Record<string, number | null>).uptimeSec ?? null
      : null;
    const groupsNow: Record<string, string> = {};
    for (const g of this.lastGroups) groupsNow[g.name] = g.now;
    return {
      fleet: this.cfg.fleet.name,
      router: {
        name: this.cfg.router.name, host: this.cfg.router.host,
        version: this.routerVersion, uptimeSec: routerUptime, reachable: this.routerUp,
      },
      counts: {
        devices: devices.length, exits: exits.length,
        groups: this.lastGroups.length, openAlerts: store.openAlertCount(),
        connections: this.connSnapshot.length,
      },
      traffic: this.traffic,
      groupsNow, devices, exits,
    };
  }

  // ── 节点详情（设备/出口通用）：探针 6h + agent 指标最新快照 + 24h 时序 ──
  nodeDetail(id: string): NodeDetail | null {
    const dev = this.cfg.devices.find(d => d.id === id);
    const exit = this.cfg.exits.find(e => e.id === id);
    if (!dev && !exit) return null;
    const kind: 'device' | 'exit' = dev ? 'device' : 'exit';
    const now = Date.now();

    const probeHistory = store.historyDownsampled(`${kind === 'device' ? 'dev' : 'exit'}:${id}`, now - 6 * 3600_000, 240);
    const mihomoDelayHistory = exit
      ? store.historyDownsampled(`node:${exit.name.split(' ')[0]}`, now - 6 * 3600_000, 240)
      : null;

    const agent = store.agentInfo(id);
    const metricsLatest = agent ? normalizeMetrics(agent.metrics) : null;
    const metricsHistory = store.deviceMetricHistory(id, now - 24 * 3600_000, 288);
    const agentLastSeen = agent?.lastSeen ?? null;
    const agentOnline = agentLastSeen != null && now - agentLastSeen < 3 * 60_000;

    let note: string | undefined;
    if (!agent) {
      if (id === 'gcp') note = '未部署 agent：GCP SSH 凭据过期，恢复后即可拉取系统指标';
      else if (kind === 'exit') note = '未部署 netpilot agent，仅有探针与拨测数据';
      else note = '未部署 netpilot agent，仅有探针数据';
    } else if (!agentOnline) {
      note = `agent 数据停止于 ${new Date(agentLastSeen!).toLocaleTimeString('zh-CN', { hour12: false })}`;
    }

    return {
      id, name: (dev ?? exit)!.name, host: (dev ?? exit)!.host,
      role: dev?.role, kind,
      agentOnline, agentLastSeen,
      latest: probeHistory.length ? probeHistory[probeHistory.length - 1] : null,
      probeHistory, mihomoDelayHistory,
      metricsLatest, metricsHistory, note,
    };
  }

  async start() {
    // 版本号低频获取
    const grabVersion = async () => {
      try { const v = await this.mihomo.version() as { version?: string }; this.routerVersion = v.version ?? null; }
      catch { this.routerUp = false; }
    };
    await grabVersion();
    setInterval(grabVersion, 60_000).unref();
    await this.pollMihomo();
    setInterval(() => void this.pollMihomo(), 5_000).unref();
    await this.pollProbes();
    setInterval(() => void this.pollProbes(), 30_000).unref();
    await this.pollNodeDelays();
    setInterval(() => void this.pollNodeDelays(), 60_000).unref();
  }
}
