import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetworkConfig } from '../core-src/types.ts';
import type { MihomoClient } from './mihomo.ts';
import type { Poller } from './poller.ts';
import type { RepairEngine } from './repairs.ts';
import * as store from './store.ts';
import { requireScope } from './auth.ts';
import { ingestReport } from './ingest.ts';
import { diagnose } from './diagnose.ts';
import { notify } from './notify.ts';
import { env } from './config.ts';

const execFileP = promisify(execFile);

export function registerRoutes(app: FastifyInstance, cfg: NetworkConfig, mihomo: MihomoClient, poller: Poller, repairs: RepairEngine) {

  // 健康检查（免鉴权，供探活）
  app.get('/healthz', async () => ({ ok: true, ts: Date.now() }));

  // ── 查询（read）──
  app.get('/api/status', { preHandler: requireScope('read') }, async () => poller.fleetStatus());

  app.get('/api/exits', { preHandler: requireScope('read') }, async () => {
    const s = poller.fleetStatus();
    return s.exits;
  });

  app.get('/api/groups', { preHandler: requireScope('read') }, async () => poller.snapshotGroups());

  app.get('/api/connections', { preHandler: requireScope('read') }, async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return poller.snapshotConnections()
      .sort((a, b) => (b.up + b.down) - (a.up + a.down))
      .slice(0, Math.min(limit, 200));
  });

  app.get('/api/rules', { preHandler: requireScope('read') }, async () => {
    const r = await mihomo.rules() as { rules: Record<string, unknown>[] };
    return r.rules ?? [];
  });

  app.get('/api/alerts', { preHandler: requireScope('read') }, async (req) => {
    const status = (req.query as { status?: string }).status;
    return store.listAlerts(status);
  });

  app.get('/api/events', { preHandler: requireScope('read') }, async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return store.recentEvents(limit);
  });

  // 节点详情（设备与出口通用）：探针 6h + agent 指标快照 + 24h 时序
  app.get('/api/nodes/:id/detail', { preHandler: requireScope('read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = poller.nodeDetail(id);
    return d ?? reply.code(404).send({ error: `unknown node ${id}` });
  });

  // ── M3 修复引擎 ──
  app.get('/api/repairs', { preHandler: requireScope('read') }, async () => repairs.listRepairs());

  app.put('/api/repairs/:id/toggle', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) required' });
    return repairs.setEnabled(id, enabled) ? { ok: true, id, enabled } : reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/repairs/:id/run', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return (await repairs.runNow(id)) ? { ok: true, id } : reply.code(404).send({ error: 'not found' });
  });

  // ── 控制（write）──
  app.put('/api/groups/:name', { preHandler: requireScope('write') }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const { proxy } = (req.body ?? {}) as { proxy?: string };
    if (!proxy) return reply.code(400).send({ error: 'proxy required' });
    if (!cfg.router.groups.includes(name)) return reply.code(400).send({ error: `unknown group ${name}` });
    try {
      await mihomo.selectProxy(name, proxy);
      store.logEvent('info', 'api', `switch group ${name} -> ${proxy}`);
      await poller.pollMihomo();
      return { ok: true, group: name, now: proxy };
    } catch (e) {
      store.logEvent('error', 'api', `switch failed: ${(e as Error).message}`);
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.put('/api/mode', { preHandler: requireScope('write') }, async (req, reply) => {
    const { mode } = (req.body ?? {}) as { mode?: string };
    if (!['rule', 'global', 'direct'].includes(mode ?? '')) {
      return reply.code(400).send({ error: 'mode must be rule|global|direct' });
    }
    try {
      await mihomo.setMode(mode as 'rule' | 'global' | 'direct');
      store.logEvent('warn', 'api', `mode switched to ${mode}`);
      return { ok: true, mode };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/api/router/restart', { preHandler: requireScope('write') }, async (_req, reply) => {
    const ssh = cfg.router.ssh;
    if (!ssh) return reply.code(501).send({ error: 'ssh not configured' });
    try {
      await execFileP('sshpass', ['-p', ssh.password, 'ssh', '-o', 'StrictHostKeyChecking=no',
        `${ssh.user}@${cfg.router.host}`, '/etc/init.d/openclash restart']);
      store.logEvent('warn', 'api', 'OpenClash restarted via API');
      setTimeout(() => void poller.pollMihomo(), 20_000);
      return { ok: true };
    } catch (e) {
      store.logEvent('error', 'api', `restart failed: ${(e as Error).message}`);
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/api/alerts/:id/ack', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = store.ackAlert(Number(id));
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // ── agent 上报（push 模式；独立 agent 令牌，只进不读）──
  app.post('/api/agent/report', async (req, reply) => {
    if (!env.agentToken) return reply.code(503).send({ error: 'agent token not configured' });
    const h = req.headers.authorization;
    if (h !== `Bearer ${env.agentToken}`) return reply.code(401).send({ error: 'invalid agent token' });
    const body = (req.body ?? {}) as { id?: string; name?: string; metrics?: Record<string, unknown> };
    if (!body.id || typeof body.id !== 'string') return reply.code(400).send({ error: 'id required' });
    if (!body.metrics || typeof body.metrics !== 'object') return reply.code(400).send({ error: 'metrics required' });
    try {
      ingestReport(body.id, body.name, body.metrics);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/devices', { preHandler: requireScope('read') }, async () => store.listDevices());

  // ── 设备管理（UI 添加/删除；runtime 源存 SQLite，yaml 源只读不可删）──
  app.post('/api/devices', { preHandler: requireScope('write') }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      id?: string; name?: string; host?: string; role?: string;
      probes?: { type?: string; port?: number }[];
    };
    const id = (b.id ?? '').trim();
    const host = (b.host ?? '').trim();
    if (!id || !host) return reply.code(400).send({ error: 'id 与 host 必填' });
    if (!/^[\w.-]{1,40}$/.test(id)) return reply.code(400).send({ error: 'id 只能字母数字._-' });
    if (cfg.devices.some(d => d.id === id)) return reply.code(409).send({ error: `id ${id} 已存在` });
    // 探针：默认 icmp；tcp 需端口
    const specs = (b.probes?.length ? b.probes : [{ type: 'icmp' }])
      .map(p => p.type === 'tcp' && p.port ? { type: 'tcp' as const, port: Number(p.port) } : { type: 'icmp' as const })
      .slice(0, 3);
    const name = (b.name ?? '').trim() || id;
    const role = (b.role ?? '').trim() || 'workstation';
    store.addRuntimeDevice({ id, name, host, role, probes: specs });
    cfg.devices.push({ id, name, host, role, probes: specs, source: 'runtime' });
    store.logEvent('info', 'api', `add runtime device ${id} (${host})`);
    return { ok: true, id };
  });

  app.delete('/api/devices/:id', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const i = cfg.devices.findIndex(d => d.id === id);
    if (i < 0) return reply.code(404).send({ error: 'not found' });
    if (cfg.devices[i].source !== 'runtime') {
      return reply.code(403).send({ error: '配置文件里的设备不可删除（改 network.yaml）' });
    }
    store.removeRuntimeDevice(id);
    cfg.devices.splice(i, 1);
    store.logEvent('warn', 'api', `remove runtime device ${id}`);
    return { ok: true };
  });

  // ── 上手引导：模板未改/全探针失败且无 agent 时提示三步配置 ──
  app.get('/api/onboarding', { preHandler: requireScope('read') }, async (req) => {
    const dismissed = store.getKv('onboarding_dismissed') === '1';
    const s = poller.fleetStatus();
    const devs = s.devices;
    const templateUntouched = devs.length > 0 &&
      devs.every(d => /^(192\.0\.2\.|203\.0\.113\.|198\.51\.100\.)/.test(d.host));
    const anyProbeOk = devs.some(d => d.latest?.ok);
    const agentCount = store.listDevices().length;
    const needsSetup = !dismissed && (templateUntouched || (!anyProbeOk && agentCount === 0));
    return {
      needsSetup, dismissed, templateUntouched,
      deviceCount: devs.length, anyProbeOk, agentCount,
      collectorUrl: `http://${req.headers.host ?? ''}`,
    };
  });

  // dismiss 是本地 UI 偏好，读令牌即可（新人首次只粘读令牌）
  app.post('/api/onboarding/dismiss', { preHandler: requireScope('read') }, async () => {
    store.setKv('onboarding_dismissed', '1');
    return { ok: true };
  });

  // ── 诊断 / 流量统计 / 局域网 / 通知测试 ──
  app.get('/api/diagnose', { preHandler: requireScope('read') }, async () => diagnose(cfg, mihomo, poller, repairs));
  app.get('/api/traffic/daily', { preHandler: requireScope('read') }, async (req) => {
    const days = Number((req.query as { days?: string }).days ?? 14);
    return store.dailyTraffic(Math.min(Math.max(1, days), 60));
  });
  app.get('/api/lan', { preHandler: requireScope('read') }, async () => store.lanList());
  app.post('/api/notify/test', { preHandler: requireScope('write') }, async () => {
    await notify('test', {
      title: 'NetPilot 通知通道测试',
      message: `这是一条测试通知 @ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      severity: 'info',
    });
    return { ok: true };
  });
}
