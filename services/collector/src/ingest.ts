// agent 上报统一入口：push（/api/agent/report）与 pull（SSH 拉取）共用
// 职责：校验/规整字段 → 落库（快照 + 时序）→ 阈值告警（同规则去重）
import type { AgentMetrics } from '../core-src/types.ts';
import * as store from './store.ts';
import { alertWithNotify } from './notify.ts';

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= 120 ? v : undefined;

export function normalizeMetrics(raw: Record<string, unknown>): AgentMetrics {
  return {
    cpu: num(raw.cpu),
    memUsed: num(raw.memUsed), memTotal: num(raw.memTotal),
    swapUsed: num(raw.swapUsed), swapTotal: num(raw.swapTotal),
    diskUsed: num(raw.diskUsed), diskTotal: num(raw.diskTotal),
    load1: num(raw.load1), load5: num(raw.load5), load15: num(raw.load15),
    upBps: num(raw.upBps), downBps: num(raw.downBps),
    uptimeSec: num(raw.uptimeSec),
    procs: num(raw.procs),
    kernel: str(raw.kernel), os: str(raw.os),
    dataMp: str(raw.dataMp), dataUsed: num(raw.dataUsed), dataTotal: num(raw.dataTotal),
  };
}

const ALERT_THRESHOLDS = {
  cpuPct: 95,          // 连续 2 个采样 ≥95% 才告警（下方 streak 计数）
  memPct: 92,
  diskPct: 92,
};

const cpuStreak = new Map<string, number>();   // 进程内存活，重启清零（可接受：顶多多报一次）

export function ingestReport(id: string, name: string | undefined, raw: Record<string, unknown>) {
  const cleanId = String(id).slice(0, 64).trim();
  if (!cleanId) throw new Error('id required');
  const m = normalizeMetrics(raw);
  store.upsertDevice(cleanId, name?.slice(0, 64) || cleanId, raw);
  store.saveDeviceMetrics(cleanId, m);

  // 阈值告警：CPU 需连续 2 个采样 ≥ 阈值才报（单次尖峰太吵）；内存/磁盘单采样即报（同样有 open 去重）
  const label = name || cleanId;
  const cpuCount = (cpuStreak.get(cleanId) ?? 0) + (m.cpu != null && m.cpu >= ALERT_THRESHOLDS.cpuPct ? 1 : 0);
  cpuStreak.set(cleanId, cpuCount);
  if (cpuCount >= 2) {
    alertWithNotify(`agent_cpu:${cleanId}`, 'warning',
      `${label} CPU 连续 ${cpuCount} 次采样 ≥${ALERT_THRESHOLDS.cpuPct}%（当前 ${m.cpu?.toFixed(0)}%）`, { cpu: m.cpu });
  }
  if (m.cpu != null && m.cpu < ALERT_THRESHOLDS.cpuPct - 10) cpuStreak.delete(cleanId);
  if (m.memUsed != null && m.memTotal && m.memTotal > 0 &&
      (m.memUsed / m.memTotal) * 100 >= ALERT_THRESHOLDS.memPct) {
    alertWithNotify(`agent_mem:${cleanId}`, 'warning',
      `${label} 内存 ${((m.memUsed / m.memTotal) * 100).toFixed(0)}%（${m.memUsed}/${m.memTotal} MB）`,
      { memUsed: m.memUsed, memTotal: m.memTotal });
  }
  if (m.diskUsed != null && m.diskTotal && m.diskTotal > 0 &&
      (m.diskUsed / m.diskTotal) * 100 >= ALERT_THRESHOLDS.diskPct) {
    alertWithNotify(`agent_disk:${cleanId}`, 'warning',
      `${label} 磁盘 ${((m.diskUsed / m.diskTotal) * 100).toFixed(0)}%（${m.diskUsed}/${m.diskTotal} GB）`,
      { diskUsed: m.diskUsed, diskTotal: m.diskTotal });
  }
  return m;
}
