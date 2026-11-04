import { DatabaseSync } from 'node:sqlite';
import type { ProbePoint, AgentMetrics, DeviceMetricPoint, DeviceSpec } from '../core-src/types.ts';

let db: DatabaseSync;

export function initStore(path: string) {
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      target TEXT NOT NULL, ts INTEGER NOT NULL,
      latency_ms REAL, ok INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_target_ts ON metrics(target, ts);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, data TEXT
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      rule TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'warning',
      message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', data TEXT
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT, last_seen INTEGER, metrics TEXT
    );
    CREATE TABLE IF NOT EXISTS device_metrics (
      device_id TEXT NOT NULL, ts INTEGER NOT NULL,
      cpu REAL, mem_used REAL, mem_total REAL, swap_used REAL, swap_total REAL,
      disk_used REAL, disk_total REAL,
      load1 REAL, load5 REAL, load15 REAL,
      up_bps REAL, down_bps REAL, uptime_sec INTEGER, extra TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dm_dev_ts ON device_metrics(device_id, ts);
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY, v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS traffic_daily (
      day TEXT NOT NULL, id TEXT NOT NULL,
      up_bytes REAL NOT NULL DEFAULT 0, down_bytes REAL NOT NULL DEFAULT 0,
      samples INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, id)
    );
    CREATE TABLE IF NOT EXISTS lan_devices (
      mac TEXT PRIMARY KEY, ip TEXT,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_devices (
      id TEXT PRIMARY KEY, name TEXT, host TEXT, role TEXT,
      probes TEXT NOT NULL, created_ts INTEGER NOT NULL
    );
  `);
  return db;
}

// ── metrics（探针）──
const insertMetric = () => db.prepare(
  'INSERT INTO metrics (target, ts, latency_ms, ok) VALUES (?, ?, ?, ?)');

export function saveMetric(target: string, p: ProbePoint) {
  insertMetric().run(target, p.ts, p.latencyMs, p.ok ? 1 : 0);
}

export function history(target: string, sinceTs: number, limit = 120): ProbePoint[] {
  const rows = db.prepare(
    'SELECT ts, latency_ms, ok FROM metrics WHERE target = ? AND ts >= ? ORDER BY ts DESC LIMIT ?'
  ).all(target, sinceTs, limit) as { ts: number; latency_ms: number | null; ok: number }[];
  return rows.reverse().map(r => ({ ts: r.ts, latencyMs: r.latency_ms, ok: !!r.ok }));
}

export function pruneMetrics(olderThanTs: number) {
  db.prepare('DELETE FROM metrics WHERE ts < ?').run(olderThanTs);
}

// 详情页用：长时间窗探针历史降采样到 ≤maxPoints（每桶取最后一条）
export function historyDownsampled(target: string, sinceTs: number, maxPoints = 240): ProbePoint[] {
  const rows = db.prepare(
    'SELECT ts, latency_ms, ok FROM metrics WHERE target = ? AND ts >= ? ORDER BY ts ASC'
  ).all(target, sinceTs) as { ts: number; latency_ms: number | null; ok: number }[];
  if (rows.length <= maxPoints) return rows.map(r => ({ ts: r.ts, latencyMs: r.latency_ms, ok: !!r.ok }));
  const step = Math.ceil(rows.length / maxPoints);
  const out: ProbePoint[] = [];
  let lastPicked = -1;
  for (let i = 0; i < rows.length; i += step) {
    out.push({ ts: rows[i].ts, latencyMs: rows[i].latency_ms, ok: !!rows[i].ok });
    lastPicked = i;
  }
  if (lastPicked !== rows.length - 1) {
    const r = rows[rows.length - 1];
    out.push({ ts: r.ts, latencyMs: r.latency_ms, ok: !!r.ok });
  }
  return out;
}

// ── device metrics（agent 系统指标，保留 24h）──
export function saveDeviceMetrics(id: string, m: AgentMetrics) {
  db.prepare(`INSERT INTO device_metrics
    (device_id, ts, cpu, mem_used, mem_total, swap_used, swap_total,
     disk_used, disk_total, load1, load5, load15, up_bps, down_bps, uptime_sec, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, Date.now(), m.cpu, m.memUsed, m.memTotal, m.swapUsed, m.swapTotal,
      m.diskUsed, m.diskTotal, m.load1, m.load5, m.load15,
      m.upBps, m.downBps, m.uptimeSec,
      (m.kernel || m.os || m.procs != null || m.dataMp)
        ? JSON.stringify({ kernel: m.kernel, os: m.os, procs: m.procs,
            dataMp: m.dataMp, dataUsed: m.dataUsed, dataTotal: m.dataTotal }) : null);
}

// 24h 原始 60s 采样降采样到 ≤maxPoints 个点（每个时间桶取最后一条）
export function deviceMetricHistory(id: string, sinceTs: number, maxPoints = 288): DeviceMetricPoint[] {
  const rows = db.prepare(
    `SELECT ts, cpu, mem_used, mem_total, swap_used, swap_total,
            disk_used, disk_total, load1, load5, load15, up_bps, down_bps, uptime_sec, extra
     FROM device_metrics WHERE device_id = ? AND ts >= ? ORDER BY ts ASC`
  ).all(id, sinceTs) as Record<string, unknown>[];
  if (rows.length <= maxPoints) return rows.map(mapMetricRow);
  const step = Math.ceil(rows.length / maxPoints);
  const out: DeviceMetricPoint[] = [];
  let lastPicked = -1;
  for (let i = 0; i < rows.length; i += step) { out.push(mapMetricRow(rows[i])); lastPicked = i; }
  if (lastPicked !== rows.length - 1) out.push(mapMetricRow(rows[rows.length - 1]));  // 末点必须是最新一条
  return out;
}

function mapMetricRow(r: Record<string, unknown>): DeviceMetricPoint {
  const extra = typeof r.extra === 'string' && r.extra
    ? JSON.parse(r.extra) as { kernel?: string; os?: string; procs?: number; dataMp?: string; dataUsed?: number | null; dataTotal?: number | null }
    : {};
  return {
    ts: Number(r.ts),
    cpu: (r.cpu as number | null) ?? null,
    memUsed: (r.mem_used as number | null) ?? null,
    memTotal: (r.mem_total as number | null) ?? null,
    swapUsed: (r.swap_used as number | null) ?? null,
    swapTotal: (r.swap_total as number | null) ?? null,
    diskUsed: (r.disk_used as number | null) ?? null,
    diskTotal: (r.disk_total as number | null) ?? null,
    load1: (r.load1 as number | null) ?? null,
    load5: (r.load5 as number | null) ?? null,
    load15: (r.load15 as number | null) ?? null,
    upBps: (r.up_bps as number | null) ?? null,
    downBps: (r.down_bps as number | null) ?? null,
    uptimeSec: (r.uptime_sec as number | null) ?? null,
    kernel: extra.kernel, os: extra.os, procs: extra.procs ?? null,
    dataMp: extra.dataMp, dataUsed: extra.dataUsed ?? null, dataTotal: extra.dataTotal ?? null,
  };
}

export function pruneDeviceMetrics(olderThanTs: number) {
  db.prepare('DELETE FROM device_metrics WHERE ts < ?').run(olderThanTs);
}

// ── events / alerts ──
export function logEvent(level: string, source: string, message: string, data?: unknown) {
  db.prepare('INSERT INTO events (ts, level, source, message, data) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), level, source, message, data ? JSON.stringify(data) : null);
}

export function recentEvents(limit = 50) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}

export function raiseAlert(rule: string, severity: string, message: string, data?: unknown) {
  db.prepare('INSERT INTO alerts (ts, rule, severity, message, data) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), rule, severity, message, data ? JSON.stringify(data) : null);
}

// 同 rule 已有未处理告警则不重复报（探针/阈值类告警的去重闸）
export function raiseAlertOnce(rule: string, severity: string, message: string, data?: unknown): boolean {
  const dup = db.prepare("SELECT 1 FROM alerts WHERE rule = ? AND status = 'open' LIMIT 1").get(rule);
  if (dup) return false;
  raiseAlert(rule, severity, message, data);
  return true;
}

export function listAlerts(status?: string, limit = 50) {
  if (status) {
    return db.prepare('SELECT * FROM alerts WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);
  }
  return db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit);
}

export function ackAlert(id: number) {
  const r = db.prepare("UPDATE alerts SET status = 'ack' WHERE id = ?").run(id);
  return Number(r.changes) > 0;
}

// 按规则前缀自动关闭（agent 恢复时清 agent_down:* 告警，免手工 ack）
export function ackAlertsByRulePrefix(prefix: string): number {
  const r = db.prepare("UPDATE alerts SET status = 'ack' WHERE status = 'open' AND rule LIKE ?")
    .run(prefix + '%');
  return Number(r.changes);
}

export function openAlertCount(): number {
  return (db.prepare("SELECT COUNT(*) c FROM alerts WHERE status = 'open'").get() as { c: number }).c;
}

// ── kv（运行时开关等轻量持久化；network.yaml 是容器内 ro 挂载，不能就地改）──
export function getKv(key: string): string | null {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  return r?.v ?? null;
}

export function setKv(key: string, value: string) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, value);
}

// ── devices（agent 注册表：最新快照供列表/详情用）──
export function upsertDevice(id: string, name: string, metrics: Record<string, unknown>) {
  db.prepare(`INSERT INTO devices (id, name, last_seen, metrics) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen, metrics = excluded.metrics`)
    .run(id, name, Date.now(), JSON.stringify(metrics));
}

export function agentInfo(id: string): { lastSeen: number; metrics: Record<string, unknown> } | null {
  const r = db.prepare('SELECT last_seen, metrics FROM devices WHERE id = ?').get(id) as
    { last_seen: number; metrics: string } | undefined;
  if (!r) return null;
  try { return { lastSeen: r.last_seen, metrics: JSON.parse(r.metrics || '{}') }; }
  catch { return { lastSeen: r.last_seen, metrics: {} }; }
}

export function listDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all() as {
    id: string; name: string; last_seen: number; metrics: string;
  }[];
}

// ── traffic_daily（每设备日流量累计；由 index.ts 每 60s 从 agent 上报的 Bps 采样累加）──
export function accTraffic(id: string, upBps: number | null, downBps: number | null, seconds: number) {
  if (upBps == null && downBps == null) return;
  const day = new Date().toLocaleDateString('sv-SE');   // YYYY-MM-DD（本地时区）
  db.prepare(`INSERT INTO traffic_daily (day, id, up_bytes, down_bytes, samples) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(day, id) DO UPDATE SET
      up_bytes = up_bytes + excluded.up_bytes,
      down_bytes = down_bytes + excluded.down_bytes,
      samples = samples + 1`)
    .run(day, id, (upBps ?? 0) * seconds, (downBps ?? 0) * seconds);
}

export function dailyTraffic(days = 14): { day: string; id: string; up: number; down: number }[] {
  const cutoff = new Date(Date.now() - (days - 1) * 86_400_000).toLocaleDateString('sv-SE');
  const rows = db.prepare(
    'SELECT day, id, up_bytes, down_bytes FROM traffic_daily WHERE day >= ? ORDER BY day ASC, id ASC'
  ).all(cutoff) as { day: string; id: string; up_bytes: number; down_bytes: number }[];
  return rows.map(r => ({ day: r.day, id: r.id, up: r.up_bytes, down: r.down_bytes }));
}

export function pruneTraffic(olderThanDays = 60) {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toLocaleDateString('sv-SE');
  db.prepare('DELETE FROM traffic_daily WHERE day < ?').run(cutoff);
}

// ── lan_devices（R68S ARP 扫描基线；基线建立后的新 MAC 触发新设备告警）──
export function lanScan(entries: { mac: string; ip: string }[]): { mac: string; ip: string }[] {
  const now = Date.now();
  const fresh: { mac: string; ip: string }[] = [];
  const baseline = getKv('lan_baseline_done') === '1';
  const sel = db.prepare('SELECT mac FROM lan_devices WHERE mac = ?');
  const ins = db.prepare('INSERT INTO lan_devices (mac, ip, first_seen, last_seen) VALUES (?, ?, ?, ?)');
  const upd = db.prepare('UPDATE lan_devices SET ip = ?, last_seen = ? WHERE mac = ?');
  for (const e of entries) {
    if (sel.get(e.mac)) upd.run(e.ip, now, e.mac);
    else { ins.run(e.mac, e.ip, now, now); if (baseline) fresh.push(e); }
  }
  return fresh;
}

export function lanBaselineDone() { setKv('lan_baseline_done', '1'); }

export function lanList(): { mac: string; ip: string; first_seen: number; last_seen: number }[] {
  return db.prepare('SELECT mac, ip, first_seen, last_seen FROM lan_devices ORDER BY first_seen DESC').all() as
    { mac: string; ip: string; first_seen: number; last_seen: number }[];
}

// ── runtime_devices（UI 添加的设备；network.yaml 是 ro 挂载，增设备走这里持久化）──
export interface RuntimeDevice {
  id: string; name: string; host: string; role: string;
  probes: string;          // JSON 字符串（DB 原文）
  created_ts: number;
}

export function listRuntimeDevices(): RuntimeDevice[] {
  return db.prepare('SELECT * FROM runtime_devices ORDER BY created_ts ASC').all() as unknown as RuntimeDevice[];
}

export function addRuntimeDevice(d: Omit<RuntimeDevice, 'created_ts' | 'probes'> & { probes: unknown }): void {
  db.prepare(`INSERT INTO runtime_devices (id, name, host, role, probes, created_ts) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(d.id, d.name, d.host, d.role, JSON.stringify(d.probes), Date.now());
}

export function removeRuntimeDevice(id: string): boolean {
  return Number(db.prepare('DELETE FROM runtime_devices WHERE id = ?').run(id).changes) > 0;
}

// 启动时把持久化的 runtime 设备并入 cfg.devices（yaml 里已有同 id 的跳过）
export function applyRuntimeDevices(devices: DeviceSpec[]): number {
  let n = 0;
  for (const r of listRuntimeDevices()) {
    if (devices.some(d => d.id === r.id)) continue;
    devices.push({
      id: r.id, name: r.name, host: r.host, role: r.role,
      probes: JSON.parse(r.probes || '[]'), source: 'runtime',
    });
    n++;
  }
  return n;
}
