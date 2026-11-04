import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, env } from './config.ts';
import { initStore, logEvent, listDevices, accTraffic, pruneTraffic, applyRuntimeDevices } from './store.ts';
import { MihomoClient } from './mihomo.ts';
import { Poller } from './poller.ts';
import { Puller } from './puller.ts';
import { LanScanner } from './lanscan.ts';
import { RepairEngine } from './repairs.ts';
import { registerRoutes } from './routes.ts';
import { createMcpServer, registerMcpHttp } from './mcp.ts';

async function main() {
  if (!env.readToken || !env.writeToken) {
    console.error('[netpilot] NETPILOT_READ_TOKEN / NETPILOT_WRITE_TOKEN 未设置，拒绝启动');
    process.exit(1);
  }
  if (!env.agentToken) {
    console.warn('[netpilot] NETPILOT_AGENT_TOKEN 未设置：push 型 agent 将无法上报');
  }

  initStore(env.dbPath);
  const cfg = loadConfig();
  const merged = applyRuntimeDevices(cfg.devices);   // UI 添加的设备（SQLite 持久化）启动时并入
  if (merged > 0) console.log(`[netpilot] merged ${merged} runtime devices`);
  const mihomo = new MihomoClient(cfg.router);
  const poller = new Poller(cfg, mihomo);
  const puller = new Puller(cfg);
  const repairs = new RepairEngine(cfg, mihomo);

  const app = Fastify({ logger: { level: process.env.NETPILOT_LOG ?? 'info' }, bodyLimit: 4 * 1024 * 1024 });

  registerRoutes(app, cfg, mihomo, poller, repairs);
  registerMcpHttp(app, {
    read: () => createMcpServer(cfg, mihomo, poller, false, repairs),
    write: () => createMcpServer(cfg, mihomo, poller, true, repairs),
    resolveScope: (token) => {
      if (token && token === env.writeToken) return 'write';
      if (token && token === env.readToken) return 'read';
      return null;
    },
  });

  // 前端静态资源（docker 单容器部署时 web/dist 被打进镜像）
  const webDist = '/app/web/dist';
  if (fs.existsSync(webDist)) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp') || req.url.startsWith('/healthz')) {
        reply.code(404).send({ error: 'not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
    console.log('[netpilot] serving web from', webDist);
  }

  await poller.start();
  puller.start();
  repairs.start();
  new LanScanner(cfg).start();

  // 流量日统计：每 60s 从 agent 最新上报采样累计（采样间隔=循环间隔）
  const sampleTraffic = () => {
    for (const r of listDevices()) {
      try {
        const m = JSON.parse(r.metrics || '{}') as { upBps?: number | null; downBps?: number | null };
        accTraffic(r.id, m.upBps ?? null, m.downBps ?? null, 60);
      } catch { /* 单条坏数据不致命 */ }
    }
  };
  setInterval(sampleTraffic, 60_000).unref();
  pruneTraffic(60);
  setInterval(() => pruneTraffic(60), 86_400_000).unref();
  logEvent('info', 'system', `netpilot collector 启动 fleet=${cfg.fleet.name}`);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(`[netpilot] listening on :${env.port}`);
}

main().catch(e => { console.error(e); process.exit(1); });
