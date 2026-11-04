// MCP server：让任何 MCP 兼容的 agent（ZCode/Claude 等）直接查询与管控舰队
// HTTP transport 挂 /mcp（StreamableHTTP），鉴权用同一个 Bearer token
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NetworkConfig } from '../core-src/types.ts';
import type { MihomoClient } from './mihomo.ts';
import type { Poller } from './poller.ts';
import type { RepairEngine } from './repairs.ts';
import * as store from './store.ts';

const execFileP = promisify(execFile);

export function createMcpServer(cfg: NetworkConfig, mihomo: MihomoClient, poller: Poller, includeWrite = true, repairs?: RepairEngine) {
  const server = new McpServer({ name: 'netpilot', version: '0.1.0' });
  const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });

  server.tool('fleet_status', '全屋网络舰队总览：路由器、设备、出口、分组、告警数量、实时流量', {}, async () =>
    json(poller.fleetStatus()));

  server.tool('list_exits', '出口节点清单（含最近延迟与 30 分钟历史、mihomo 侧实测延迟）', {}, async () =>
    json(poller.fleetStatus().exits));

  server.tool('list_devices', '局域网设备清单（探针状态 + agent 上报指标）', {}, async () => {
    const agents = store.listDevices();
    return json(poller.fleetStatus().devices.map(d => {
      const a = agents.find(x => x.id === d.id);
      return { ...d, agent: a ? { lastSeen: a.last_seen, metrics: JSON.parse(a.metrics || '{}') } : null };
    }));
  });

  server.tool('list_groups', 'OpenClash 分组与成员延迟', {}, async () =>
    json(poller.snapshotGroups()));

  server.tool('list_connections', '当前代理连接 Top N（按流量排序）',
    { limit: z.number().optional().describe('条数，默认 30') },
    async ({ limit }) => json(poller.snapshotConnections()
      .sort((a, b) => (b.up + b.down) - (a.up + a.down))
      .slice(0, Math.min(Number(limit ?? 30), 200))));

  server.tool('list_rules', '当前生效的代理规则（含命中次数）', {}, async () => {
    const r = await mihomo.rules() as { rules: Record<string, unknown>[] };
    return json(r.rules ?? []);
  });

  server.tool('list_alerts', '告警列表',
    { status: z.enum(['open', 'ack']).optional() },
    async ({ status }) => json(store.listAlerts(status)));

  server.tool('recent_events', '审计事件流（谁在什么时候做了什么）',
    { limit: z.number().optional() },
    async ({ limit }) => json(store.recentEvents(Number(limit ?? 30))));

  server.tool('probe_now', '立即对全部设备+出口跑一轮探针', {}, async () => {
    await poller.pollProbes();
    return json({ ok: true, ts: Date.now() });
  });

  server.tool('node_detail', '单节点详情（设备/出口通用）：探针 6h 历史、agent 系统指标快照（CPU/内存/磁盘/负载/网速/uptime）与 24h 时序',
    { id: z.string().describe('设备或出口 id：nas / r68s / win / mac / hk / usvps / aly / gcp') },
    async ({ id }) => {
      const d = poller.nodeDetail(id);
      if (!d) throw new Error(`unknown node: ${id}`);
      return json(d);
    });

  server.tool('list_repairs', 'M3 修复引擎规则清单：每条守护的检查类型/周期/启用状态/最近一次运行结果/连续失败轮数/自动修复次数', {}, async () =>
    json(repairs ? repairs.listRepairs() : []));

  // ── 以下为写操作工具：仅在 includeWrite（写令牌）时注册 ──
  if (includeWrite) {
  server.tool('switch_group', '切换代理分组出口（写操作，记审计日志）',
    {
      group: z.string().describe(`分组名，可用：${cfg.router.groups.join(' / ')}`),
      proxy: z.string().describe('目标节点或子组名'),
    },
    async ({ group, proxy }) => {
      if (!cfg.router.groups.includes(group)) throw new Error(`unknown group: ${group}`);
      await mihomo.selectProxy(group, proxy);
      store.logEvent('info', 'mcp', `switch_group ${group} -> ${proxy}`, { group, proxy });
      await poller.pollMihomo();
      return json({ ok: true, group, now: proxy });
    });

  server.tool('set_mode', '切换代理模式（写操作，记审计日志）',
    { mode: z.enum(['rule', 'global', 'direct']) },
    async ({ mode }) => {
      await mihomo.setMode(mode);
      store.logEvent('warn', 'mcp', `set_mode ${mode}`);
      return json({ ok: true, mode });
    });

  server.tool('restart_openclash', '重启 R68S 上的 OpenClash（写操作；约 30s 全家断外网）', {}, async () => {
    const ssh = cfg.router.ssh;
    if (!ssh) throw new Error('ssh not configured');
    await execFileP('sshpass', ['-p', ssh.password, 'ssh', '-o', 'StrictHostKeyChecking=no',
      `${ssh.user}@${cfg.router.host}`, '/etc/init.d/openclash restart']);
    store.logEvent('warn', 'mcp', 'restart_openclash via MCP');
    setTimeout(() => void poller.pollMihomo(), 20_000);
    return json({ ok: true, note: 'restarting, ~30s' });
  });

  server.tool('ack_alert', '确认/关闭一条告警（写操作）',
    { id: z.number() },
    async ({ id }) => json({ ok: store.ackAlert(Number(id)) }));

  server.tool('toggle_repair', '启用/停用一条 M3 守护规则（写操作，记审计；运行时覆盖 yaml 默认值，持久化在 DB）',
    { id: z.string().describe('规则 id，见 list_repairs'), enabled: z.boolean() },
    async ({ id, enabled }) => {
      if (!repairs) throw new Error('repair engine unavailable');
      return json({ ok: repairs.setEnabled(id, enabled), id, enabled });
    });

  server.tool('run_repair', '立即执行一条守护规则的检查（如异常会按规则触发修复+告警）（写操作）',
    { id: z.string().describe('规则 id，见 list_repairs') },
    async ({ id }) => {
      if (!repairs) throw new Error('repair engine unavailable');
      return json({ ok: await repairs.runNow(id), id });
    });
  }

  return server;
}

export function registerMcpHttp(
  app: FastifyInstance,
  factories: { read: () => McpServer; write: () => McpServer; resolveScope: (token: string | undefined) => 'read' | 'write' | null },
) {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, reply) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        return reply.status(400).send({ jsonrpc: '2.0', error: { code: -32000, message: 'initialize required (no valid mcp-session-id)' }, id: null });
      }
      // 按令牌scope选实例：读令牌=只有查询工具，写令牌=全部工具
      const auth = req.headers.authorization as string | undefined;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const scope = factories.resolveScope(token);
      if (!scope) return reply.status(401).send({ error: 'invalid token' });
      const factory = scope === 'write' ? factories.write : factories.read;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, transport!); },
      });
      transport.onclose = () => {
        for (const [k, v] of transports) if (v === transport) transports.delete(k);
      };
      await factory().connect(transport);
    }
    await reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  app.get('/mcp', async (_req, reply) => reply.status(405).send({ error: 'use POST (StreamableHTTP)' }));
}
