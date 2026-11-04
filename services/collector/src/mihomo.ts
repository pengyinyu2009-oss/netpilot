// mihomo (OpenClash) 外部 API 客户端
import type { RouterSpec } from '../core-src/types.ts';

export class MihomoClient {
  private base: string;
  private secret: string;

  constructor(router: RouterSpec) {
    this.base = `http://${router.host}:${router.api.port}`;
    this.secret = router.api.secret;
  }

  private async get(path: string, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(this.base + path, {
        headers: { Authorization: `Bearer ${this.secret}` },
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`mihomo ${path} -> HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  version() { return this.get('/version'); }
  groups() { return this.get('/group'); }
  proxies() { return this.get('/proxies'); }
  connections() { return this.get('/connections'); }
  rules() { return this.get('/rules'); }
  configs() { return this.get('/configs'); }
  // 注意：/traffic 是流式端点，不可用 get() 拉取；速率由 connections 的 uploadTotal/downloadTotal 差分计算

  async selectProxy(group: string, name: string) {
    const r = await fetch(`${this.base}/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok && r.status !== 204) throw new Error(`select ${group} -> ${name} failed: HTTP ${r.status}`);
  }

  async setMode(mode: 'rule' | 'global' | 'direct') {
    const r = await fetch(`${this.base}/configs`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!r.ok && r.status !== 204) throw new Error(`setMode ${mode} failed: HTTP ${r.status}`);
  }

  // 对指定代理触发一次真实拨测（面板 alive=False 可能是陈旧标志）
  async delayOf(proxy: string, timeoutMs = 6000): Promise<number | null> {
    const path = `/proxies/${encodeURIComponent(proxy)}/delay`
      + `?timeout=${timeoutMs}&url=${encodeURIComponent('http://www.gstatic.com/generate_204')}`;
    try {
      const j = await this.get(path, timeoutMs + 3000) as { delay?: number };
      return j.delay ?? null;
    } catch { return null; }
  }

  // 对整组触发拨测，返回 {成员: 延迟ms}（switch_group_best 选点用）；失败返回 null
  async delayGroup(group: string, timeoutMs = 6000): Promise<Record<string, number> | null> {
    const path = `/group/${encodeURIComponent(group)}/delay`
      + `?timeout=${timeoutMs}&url=${encodeURIComponent('http://www.gstatic.com/generate_204')}`;
    try { return await this.get(path, timeoutMs + 3000) as Record<string, number>; }
    catch { return null; }
  }
}
