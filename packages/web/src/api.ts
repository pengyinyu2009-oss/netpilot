// NetPilot 前端 API 客户端（与 collector REST 对应；未来鸿蒙/任何客户端按同一契约实现）
// 原生外壳（Capacitor/Tauri/鸿蒙）注入 globalThis.__NETPILOT_API__ = 'http://host:8898'，Web 同源留空
const BASE = (globalThis as { __NETPILOT_API__?: string }).__NETPILOT_API__ ?? '';
const TOKEN_KEY = 'netpilot_token';
const WRITE_KEY = 'netpilot_write_token';

export function getToken(): string { return localStorage.getItem(TOKEN_KEY) ?? ''; }
export function setToken(t: string) { localStorage.setItem(TOKEN_KEY, t); }
export function getWriteToken(): string { return localStorage.getItem(WRITE_KEY) ?? ''; }
export function setWriteToken(t: string) { localStorage.setItem(WRITE_KEY, t); }
export const hasWrite = () => !!getWriteToken();

async function req(path: string, init: RequestInit = {}, write = false) {
  const token = write ? getWriteToken() : getToken();
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (r.status === 401 || r.status === 403) {
    const need = write ? 'write' : 'read';
    throw new Error(`令牌无效或缺失（需要 ${need} 令牌）`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export const api = {
  status: () => req('/api/status'),
  exits: () => req('/api/exits'),
  groups: () => req('/api/groups'),
  connections: (limit = 50) => req(`/api/connections?limit=${limit}`),
  rules: () => req('/api/rules'),
  alerts: (status?: string) => req(`/api/alerts${status ? `?status=${status}` : ''}`),
  devices: () => req('/api/devices'),
  nodeDetail: (id: string) => req(`/api/nodes/${encodeURIComponent(id)}/detail`),
  repairs: () => req('/api/repairs'),
  toggleRepair: (id: string, enabled: boolean) =>
    req(`/api/repairs/${encodeURIComponent(id)}/toggle`, { method: 'PUT', body: JSON.stringify({ enabled }) }, true),
  runRepair: (id: string) => req(`/api/repairs/${encodeURIComponent(id)}/run`, { method: 'POST' }, true),
  switchGroup: (group: string, proxy: string) =>
    req(`/api/groups/${encodeURIComponent(group)}`, { method: 'PUT', body: JSON.stringify({ proxy }) }, true),
  setMode: (mode: string) => req('/api/mode', { method: 'PUT', body: JSON.stringify({ mode }) }, true),
  ackAlert: (id: number) => req(`/api/alerts/${id}/ack`, { method: 'POST' }, true),
  restartRouter: () => req('/api/router/restart', { method: 'POST' }, true),
  diagnose: () => req('/api/diagnose'),
  lan: () => req('/api/lan'),
  trafficDaily: (days = 14) => req(`/api/traffic/daily?days=${days}`),
  notifyTest: () => req('/api/notify/test', { method: 'POST' }, true),
  onboarding: () => req('/api/onboarding'),
  dismissOnboarding: () => req('/api/onboarding/dismiss', { method: 'POST' }, true),
};

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B/s`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB/s`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB/s`;
  return `${(n / 1073741824).toFixed(2)} GB/s`;
}

export function fmtMB(n: number): string {
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtUptime(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
  return `${Math.floor(sec / 86400)} 天 ${(Math.round((sec % 86400) / 3600))} 小时`;
}
