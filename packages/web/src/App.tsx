import { useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken, getWriteToken, setWriteToken, fmtBytes, fmtMB, fmtTime, fmtUptime } from './api';

// ── 类型（与 collector 对齐）──
interface ProbePoint { ts: number; latencyMs: number | null; ok: boolean }
interface AgentSummary { lastSeen: number; cpu?: number | null; memPct?: number | null; diskPct?: number | null }
interface ExitStatus { id: string; name: string; host: string; latest: ProbePoint | null; history: ProbePoint[]; mihomoDelay: number | null; agent?: AgentSummary | null }
interface DeviceStatus { id: string; name: string; host: string; role?: string; latest: ProbePoint | null; history: ProbePoint[]; agent?: AgentSummary | null }
interface GroupMember { name: string; type: string; delay: number | null; alive: boolean }
interface GroupStatus { name: string; type: string; now: string; members: GroupMember[] }
interface ConnRow { host: string; src: string; chains: string; up: number; down: number; rule: string }
interface AlertRow { id: number; ts: number; rule: string; severity: string; message: string; status: string }
interface AgentMetrics {
  cpu: number | null;
  memUsed: number | null; memTotal: number | null;
  swapUsed: number | null; swapTotal: number | null;
  diskUsed: number | null; diskTotal: number | null;
  load1: number | null; load5: number | null; load15: number | null;
  upBps: number | null; downBps: number | null;
  uptimeSec: number | null; procs: number | null;
  kernel?: string; os?: string;
  dataMp?: string; dataUsed?: number | null; dataTotal?: number | null;
}
interface DeviceMetricPoint extends AgentMetrics { ts: number }
interface NodeDetail {
  id: string; name: string; host: string; role?: string;
  kind: 'device' | 'exit';
  agentOnline: boolean; agentLastSeen: number | null;
  latest: ProbePoint | null;
  probeHistory: ProbePoint[];
  mihomoDelayHistory: ProbePoint[] | null;
  metricsLatest: AgentMetrics | null;
  metricsHistory: DeviceMetricPoint[];
  note?: string;
}
interface FleetStatus {
  fleet: string;
  router: { name: string; host: string; version: string | null; uptimeSec: number | null; reachable: boolean };
  counts: { devices: number; exits: number; groups: number; openAlerts: number; connections: number };
  traffic: { upBps: number; downBps: number };
  groupsNow: Record<string, string>;
  devices: DeviceStatus[];
  exits: ExitStatus[];
}

type Tab = 'fleet' | 'exits' | 'rules' | 'groups' | 'conns' | 'alerts';

interface CheckSpec { kind: string; group?: string; host?: string; port?: number; minDays?: number; max?: number; expect?: string; command?: string }
interface ActionSpec { kind: string; group?: string; host?: string; user?: string; port?: number; command?: string }
interface DiagItem { name: string; ok: boolean; detail: string }
interface DiagResult { ts: number; items: DiagItem[] }
interface LanRow { mac: string; ip: string; first_seen: number; last_seen: number }
interface RepairRow {
  id: string; name: string; enabled: boolean; everySeconds: number; failStreak?: number;
  check: CheckSpec; heal?: ActionSpec;
  state: { enabled: boolean; lastRun: number | null; lastOk: boolean | null; lastDetail: string; failStreak: number; healCount: number; lastHeal: number | null; nextRun: number | null };
}

// ── 通用 SVG 折线图（无依赖，移动优先）──
function LineChart({ points, color = 'var(--blue)', unit = '', height = 84, fmt }: {
  points: { ts: number; v: number | null }[];
  color?: string; unit?: string; height?: number; fmt?: (v: number) => string;
}) {
  const show = (v: number) => (fmt ? fmt(v) : v.toFixed(v < 10 ? 1 : 0) + unit);
  const vals = points.filter(p => p.v != null) as { ts: number; v: number }[];
  if (vals.length < 2) return <div className="chart-empty">暂无足够数据</div>;
  const max = Math.max(...vals.map(p => p.v));
  const min = Math.min(...vals.map(p => p.v));
  const span = max - min || 1;
  const W = 100;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => height - 4 - ((v - min) / span) * (height - 10);
  // null 断开成多段
  const segs: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (p.v == null) { if (cur.length > 1) segs.push(cur.join(' ')); cur = []; }
    else cur.push(`${x(i).toFixed(2)},${y(p.v).toFixed(2)}`);
  });
  if (cur.length > 1) segs.push(cur.join(' '));
  const last = vals[vals.length - 1];
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }}>
        {segs.map((s, i) => <polyline key={i} points={s} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="chart-meta">
        <span>{show(min)}</span>
        <span style={{ color }}>{fmtTime(last.ts)} · {show(last.v)}</span>
        <span>峰值 {show(max)}</span>
      </div>
    </div>
  );
}

// 延迟图：ok=false 的点画成红色刻度（离线段可视化）
function LatencyChart({ points, height = 84 }: { points: ProbePoint[]; height?: number }) {
  const nice = points.map(p => ({ ts: p.ts, v: p.ok && p.latencyMs != null ? p.latencyMs : null }));
  const fails = points.filter(p => !p.ok);
  return (
    <div className="chart">
      <div className="chart-wrap">
        <LineChartRaw points={nice} height={height} />
        {fails.length > 0 && (
          <div className="chart-fails">
            {points.map((p, i) => !p.ok ? <i key={i} style={{ left: `${(i / Math.max(points.length - 1, 1)) * 100}%` }} /> : null)}
          </div>
        )}
      </div>
      <div className="chart-meta">
        <span style={{ color: fails.length ? 'var(--red)' : undefined }}>{fails.length ? `${fails.length} 次探测失败` : '全部探测成功'}</span>
        <span>{nice.length} 个有效点</span>
      </div>
    </div>
  );
}
// 纯折线（不带 meta 行，供 LatencyChart 嵌套）
function LineChartRaw({ points, height }: { points: { ts: number; v: number | null }[]; height: number }) {
  const vals = points.filter(p => p.v != null) as { ts: number; v: number }[];
  if (vals.length < 2) return <div className="chart-empty">暂无足够数据</div>;
  const max = Math.max(...vals.map(p => p.v));
  const min = Math.min(...vals.map(p => p.v));
  const span = max - min || 1;
  const W = 100;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => height - 4 - ((v - min) / span) * (height - 10);
  const segs: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (p.v == null) { if (cur.length > 1) segs.push(cur.join(' ')); cur = []; }
    else cur.push(`${x(i).toFixed(2)},${y(p.v).toFixed(2)}`);
  });
  if (cur.length > 1) segs.push(cur.join(' '));
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height, display: 'block', width: '100%' }}>
      {segs.map((s, i) => <polyline key={i} points={s} fill="none" stroke="var(--blue)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}

function UsageBar({ label, used, total, unit }: { label: string; used: number | null; total: number | null; unit: string }) {
  if (used == null || !total) return null;
  const pct = Math.min(100, (used / total) * 100);
  const cls = pct > 90 ? 'bad' : pct > 75 ? 'warn' : 'ok';
  return (
    <div className="usage">
      <div className="usage-head">
        <span>{label}</span>
        <span className="usage-val">{used.toFixed(used >= 1024 ? 0 : 1)}{unit} / {total.toFixed(0)}{unit} · {pct.toFixed(0)}%</span>
      </div>
      <div className="usage-bar"><i className={cls} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function Spark({ points, w = 4 }: { points: ProbePoint[]; w?: number }) {
  const vals = points.slice(-24);
  if (!vals.length) return <span style={{ color: 'var(--dim)', fontSize: 11 }}>无数据</span>;
  const max = Math.max(...vals.map(v => v.latencyMs ?? 200), 60);
  return (
    <div className="spark">
      {vals.map((v, i) => (
        <i key={i} className={v.ok ? '' : 'bad'}
           style={{ height: `${Math.max(8, ((v.latencyMs ?? max) / max) * 100)}%` }} />
      ))}
    </div>
  );
}

function latBadge(p: ProbePoint | null, extra?: number | null) {
  if (!p || !p.ok) return <span className="badge bad">离线</span>;
  const v = p.latencyMs;
  if (v == null) return <span className="badge warn">异常</span>;
  const cls = v < 80 ? 'ok' : v < 250 ? 'warn' : 'bad';
  return <span className={`badge ${cls}`}>{v}ms</span>;
}

// agent 内联摘要（列表行右侧 / meta 里）
function agentMeta(a: AgentSummary | null | undefined): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.cpu != null) parts.push(`CPU ${a.cpu.toFixed(0)}%`);
  if (a.memPct != null) parts.push(`内存 ${a.memPct}%`);
  if (a.diskPct != null) parts.push(`磁盘 ${a.diskPct}%`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function Gate({ onDone }: { onDone: () => void }) {
  const [t, setT] = useState('');
  const [wt, setWt] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      setToken(t.trim()); setWriteToken(wt.trim());
      await api.status();
      onDone();
    } catch (e) {
      setErr((e as Error).message + '（请确认令牌与 collector 一致）');
    } finally { setBusy(false); }
  };

  return (
    <div className="gate">
      <h1>🛰️ NetPilot</h1>
      <p>全屋网络管家 · 首次使用请输入访问令牌<br/>读令牌用于查看；写令牌用于切换分组等控制操作（可留空）。</p>
      <input placeholder="读令牌 Read Token" value={t} onChange={e => setT(e.target.value)} />
      <input placeholder="写令牌 Write Token（可选）" value={wt} onChange={e => setWt(e.target.value)} />
      {err && <div className="err">{err}</div>}
      <button disabled={busy || !t.trim()} onClick={submit}>{busy ? '验证中…' : '进入'}</button>
    </div>
  );
}

// ── 节点详情页（设备/出口通用）──
function TrafficDaily({ id }: { id: string }) {
  const [rows, setRows] = useState<{ day: string; up: number; down: number }[]>([]);
  useEffect(() => {
    api.trafficDaily(14).then(all => {
      setRows(all.filter(r => r.id === id).map(r => ({ day: r.day, up: r.up, down: r.down })));
    }).catch(() => {});
  }, [id]);
  if (!rows.length) return null;
  const peak = Math.max(...rows.map(r => r.up + r.down), 1);
  return (
    <div className="card">
      <h2>流量统计 · 近 14 天</h2>
      {rows.map(r => (
        <div className="tbar-row" key={r.day}>
          <span className="tbar-day">{r.day.slice(5)}</span>
          <div className="tbar">
            <div className="tbar-up" style={{ width: `${(r.up / peak) * 100}%` }} />
            <div className="tbar-down" style={{ width: `${(r.down / peak) * 100}%` }} />
          </div>
          <span className="tbar-val">{fmtMB(r.up + r.down)}</span>
        </div>
      ))}
      <div className="chart-meta"><span style={{ color: 'var(--green)' }}>■上行</span><span style={{ color: 'var(--blue)' }}>■下行</span></div>
    </div>
  );
}

function DetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<NodeDetail | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { setD(await api.nodeDetail(id)); setErr(''); }
    catch (e) { setErr((e as Error).message); }
  }, [id]);

  useEffect(() => {
    setD(null);
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const m = d?.metricsLatest ?? null;
  const mh = d?.metricsHistory ?? [];
  const p = (sel: (x: DeviceMetricPoint) => number | null) => mh.map(x => ({ ts: x.ts, v: sel(x) }));

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>← 返回</button>
      {err && <div className="card" style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div>}
      {!d && !err && <div className="empty">加载中…</div>}
      {d && (
        <>
          <div className="card head-card">
            <div className="head-row">
              <div style={{ minWidth: 0 }}>
                <div className="head-name">{d.name}</div>
                <div className="meta">
                  {d.kind === 'exit' ? '出口节点' : '局域网设备'}{d.role ? ` · ${d.role}` : ''} · {d.host}
                </div>
                {m?.os && <div className="meta">{m.os}{m.kernel ? ` · ${m.kernel}` : ''}</div>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                {latBadge(d.latest)}
                <span className={`badge ${d.agentOnline ? 'info' : 'neu'}`}>
                  {d.agentOnline ? 'agent 在线' : d.agentLastSeen ? 'agent 停报' : '无 agent'}
                </span>
              </div>
            </div>
            {d.note && <div className="note">{d.note}</div>}
          </div>

          {/* 实时指标 */}
          {m && (
            <div className="card">
              <h2>系统指标{d.agentLastSeen ? ` · 更新于 ${fmtTime(d.agentLastSeen)}` : ''}</h2>
              <div className="grid metrics-grid">
                {m.cpu != null && <div className="stat"><div className={`v ${m.cpu > 90 ? 'bad' : ''}`}>{m.cpu.toFixed(0)}<small>%</small></div><div className="k">CPU</div></div>}
                {m.memUsed != null && m.memTotal ? <div className="stat"><div className="v">{((m.memUsed / m.memTotal) * 100).toFixed(0)}<small>%</small></div><div className="k">内存 {m.memUsed.toFixed(0)}/{m.memTotal.toFixed(0)} MB</div></div> : null}
                {m.diskUsed != null && m.diskTotal ? <div className="stat"><div className="v">{((m.diskUsed / m.diskTotal) * 100).toFixed(0)}<small>%</small></div><div className="k">磁盘 {m.diskUsed.toFixed(1)}/{m.diskTotal.toFixed(0)} GB</div></div> : null}
                {m.load1 != null && <div className="stat"><div className="v">{m.load1.toFixed(2)}</div><div className="k">负载 1m{m.load15 != null ? ` · 15m ${m.load15.toFixed(2)}` : ''}</div></div>}
                {m.upBps != null && <div className="stat"><div className="v" style={{ fontSize: 15, paddingTop: 3 }}>↑ {fmtBytes(m.upBps)}</div><div className="k">网卡上行</div></div>}
                {m.downBps != null && <div className="stat"><div className="v" style={{ fontSize: 15, paddingTop: 3 }}>↓ {fmtBytes(m.downBps)}</div><div className="k">网卡下行</div></div>}
                {m.uptimeSec != null && <div className="stat"><div className="v" style={{ fontSize: 15, paddingTop: 3 }}>{fmtUptime(m.uptimeSec)}</div><div className="k">运行时长</div></div>}
                {m.procs != null && <div className="stat"><div className="v">{m.procs}</div><div className="k">进程数</div></div>}
                {m.swapTotal ? <div className="stat"><div className="v">{((m.swapUsed ?? 0) / m.swapTotal * 100).toFixed(0)}<small>%</small></div><div className="k">Swap {m.swapUsed?.toFixed(0) ?? 0}/{m.swapTotal.toFixed(0)} MB</div></div> : null}
              </div>
              <UsageBar label="内存" used={m.memUsed} total={m.memTotal} unit=" MB" />
              <UsageBar label="磁盘（根分区）" used={m.diskUsed} total={m.diskTotal} unit=" GB" />
              <UsageBar label={`磁盘（${m.dataMp ?? '数据分区'}）`} used={m.dataUsed ?? null} total={m.dataTotal ?? null} unit=" GB" />
            </div>
          )}

          {/* 历史曲线 */}
          <div className="card">
            <h2>探针延迟 · 近 6 小时</h2>
            <LatencyChart points={d.probeHistory} />
          </div>
          {d.mihomoDelayHistory && (
            <div className="card">
              <h2>mihomo 拨测延迟 · 近 6 小时</h2>
              <LineChart points={d.mihomoDelayHistory.map(x => ({ ts: x.ts, v: x.ok && x.latencyMs != null ? x.latencyMs : null }))} unit="ms" color="var(--accent)" />
            </div>
          )}
          {mh.some(x => x.cpu != null) && (
            <div className="card">
              <h2>CPU · 近 24 小时</h2>
              <LineChart points={p(x => x.cpu)} unit="%" color="var(--accent)" />
            </div>
          )}
          {mh.some(x => x.memUsed != null) && (
            <div className="card">
              <h2>内存用量 · 近 24 小时</h2>
              <LineChart points={p(x => x.memUsed)} unit=" MB" color="var(--blue)" />
            </div>
          )}
          <TrafficDaily id={id} />

          {(mh.some(x => x.upBps != null || x.downBps != null)) && (
            <div className="card">
              <h2>网卡速率 · 近 24 小时</h2>
              <LineChart points={p(x => x.downBps)} fmt={fmtBytes} color="var(--blue)" />
              <div style={{ height: 10 }} />
              <LineChart points={p(x => x.upBps)} fmt={fmtBytes} color="var(--green)" />
              <div className="chart-meta"><span style={{ color: 'var(--blue)' }}>— 下行</span><span style={{ color: 'var(--green)' }}>— 上行</span></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [tab, setTab] = useState<Tab>('fleet');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [groups, setGroups] = useState<GroupStatus[]>([]);
  const [conns, setConns] = useState<ConnRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [repairs, setRepairs] = useState<RepairRow[]>([]);
  const [diag, setDiag] = useState<DiagResult | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [lanDevs, setLanDevs] = useState<LanRow[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('rule');
  const [offline, setOffline] = useState(!navigator.onLine);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);

  // 5s 主轮询（详情页时暂停，避免无谓请求）
  useEffect(() => {
    if (!authed || detailId) return;
    void refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [authed, detailId, refresh]);

  // 各 Tab 数据
  useEffect(() => {
    if (!authed || detailId) return;
    const load = async () => {
      try {
        if (tab === 'groups') setGroups(await api.groups());
        if (tab === 'conns') setConns(await api.connections(60));
        if (tab === 'alerts') setAlerts(await api.alerts());
        if (tab === 'rules') setRepairs(await api.repairs());
        if (tab === 'fleet') setLanDevs(await api.lan());
      } catch (e) { setErr((e as Error).message); }
    };
    void load();
    const id = setInterval(load, tab === 'conns' ? 5000 : 15000);
    return () => clearInterval(id);
  }, [authed, tab, detailId]);

  // M5a：离线/在线监听 + 告警角标（PWA Badging）
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const openAlertCount = alerts.filter(a => a.status === 'open').length;
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => void; clearAppBadge?: () => void };
    try {
      if (openAlertCount > 0) nav.setAppBadge?.(openAlertCount);
      else nav.clearAppBadge?.();
    } catch { /* Badging 不支持则忽略 */ }
  }, [openAlertCount]);

  if (!authed) return <Gate onDone={() => setAuthed(true)} />;

  const doSwitch = async (group: string, proxy: string) => {
    setBusy(true);
    try {
      await api.switchGroup(group, proxy);
      setGroups(await api.groups());
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };

  const doMode = async (m: string) => {
    setBusy(true);
    try { await api.setMode(m); setMode(m); } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };

  const openAlerts = alerts.filter(a => a.status === 'open').length;

  const doToggleRule = async (id: string, enabled: boolean) => {
    setBusy(true);
    try { await api.toggleRepair(id, enabled); setRepairs(await api.repairs()); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };

  const doRunRule = async (id: string) => {
    setBusy(true);
    try { await api.runRepair(id); await new Promise(r => setTimeout(r, 1500)); setRepairs(await api.repairs()); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          <span className={`dot ${status?.router.reachable ? '' : 'bad'}`} />
          NetPilot
        </h1>
        <div className="sub">
          {status ? `${status.router.name} · ${(status.router.version ?? '').startsWith('v') ? status.router.version : 'v' + (status.router.version ?? '?')}` : '连接中…'}
          {status?.router.uptimeSec != null && <> · 已运行 {fmtUptime(status.router.uptimeSec)}</>}
          {busy && <> <span className="spin" /></>}
        </div>
      </div>

      <div className="content">
        {offline && <div className="card offline-banner">⚠️ 网络已断开 —— 显示的是缓存界面，恢复联网后自动刷新</div>}
        {detailId
          ? <DetailView id={detailId} onBack={() => setDetailId(null)} />
          : <>
        {err && <div className="card" style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div>}

        {/* ── 舰队总览 ── */}
        {tab === 'fleet' && status && (
          <>
            <div className="grid">
              <div className="stat"><div className="v">{status.counts.devices}</div><div className="k">设备在线/总数</div></div>
              <div className="stat"><div className="v">{status.counts.exits}</div><div className="k">出口节点</div></div>
              <div className="stat"><div className="v">{status.counts.connections}</div><div className="k">活跃连接</div></div>
              <div className="stat"><div className={`v ${openAlerts ? 'bad' : 'ok'}`}>{openAlerts}</div><div className="k">未处理告警</div></div>
            </div>

            <div className="card">
              <h2>实时流量</h2>
              <div className="grid">
                <div className="stat"><div className="v" style={{ color: 'var(--accent)' }}>↑ {fmtBytes(status.traffic.upBps)}</div><div className="k">上传</div></div>
                <div className="stat"><div className="v" style={{ color: 'var(--blue)' }}>↓ {fmtBytes(status.traffic.downBps)}</div><div className="k">下载</div></div>
              </div>
            </div>

            <div className="card">
              <h2>一键诊断</h2>
              <div className="diag-actions">
                <button className="btn-primary" disabled={diagBusy}
                  onClick={async () => {
                    setDiagBusy(true); setDiag(null);
                    try { setDiag(await api.diagnose()); } catch (e) { alert((e as Error).message); }
                    finally { setDiagBusy(false); }
                  }}>
                  {diagBusy ? '诊断中…' : '🩺 运行诊断'}
                </button>
                <button className="btn-ghost" disabled={!getWriteToken()}
                  onClick={async () => { try { await api.notifyTest(); alert('测试通知已发送，查收手机'); } catch (e) { alert((e as Error).message); } }}>
                  🔔 测试通知
                </button>
              </div>
              {diag && (
                <div className="diag-list">
                  {diag.items.map((it, i) => (
                    <div className="row diag-row" key={i}>
                      <span className={`diag-dot ${it.ok ? 'ok' : 'bad'}`} />
                      <span className="diag-name">{it.name}</span>
                      <span className="diag-detail">{it.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <h2>设备（点击查看详情）</h2>
              {status.devices.map(d => (
                <button className="row link-row" key={d.id} onClick={() => setDetailId(d.id)}>
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{d.name}<span className="chev">›</span></div>
                    <div className="meta">{d.host}{agentMeta(d.agent)}{d.agent ? ' · agent 在线' : ''}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Spark points={d.history} />
                    {latBadge(d.latest)}
                  </div>
                </button>
              ))}
            </div>

            <div className="card">
              <h2>局域网设备 <span className="count-chip">{lanDevs.length}</span></h2>
              {lanDevs.length === 0 && <div className="empty">基线建立中（R68S ARP 首扫后 1-2 分钟）…</div>}
              {lanDevs.slice(0, 8).map(l => (
                <div className="row" key={l.mac}>
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{l.ip}</div>
                    <div className="meta">{l.mac}</div>
                  </div>
                  <span className="badge neu">{fmtTime(l.first_seen)} 首见</span>
                </div>
              ))}
              {lanDevs.length > 8 && <div className="meta" style={{ padding: '6px 4px 0' }}>…共 {lanDevs.length} 台</div>}
            </div>

            <div className="card">
              <h2>分组现状</h2>
              {Object.entries(status.groupsNow).map(([g, now]) => (
                <div className="row" key={g}>
                  <div className="name">{g}</div>
                  <span className="badge info">{now}</span>
                </div>
              ))}
            </div>

            <div className="card">
              <h2>代理模式</h2>
              <div className="mode-bar">
                {['rule', 'global', 'direct'].map(m => (
                  <button key={m} className={`chip ${mode === m ? 'active' : ''}`} onClick={() => doMode(m)}>
                    {m === 'rule' ? '智能分流' : m === 'global' ? '全局代理' : '全局直连'}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── 出口节点 ── */}
        {tab === 'exits' && status && (
          <>
            {status.exits.map(e => (
              <button className="card link-card" key={e.id} onClick={() => setDetailId(e.id)}>
                <div className="row" style={{ borderBottom: 'none', paddingBottom: 4 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{e.name}<span className="chev">›</span></div>
                    <div className="meta">{e.host}{agentMeta(e.agent)}{e.agent ? ' · agent 在线' : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {latBadge(e.latest)}
                    {e.mihomoDelay != null && <div className="meta">mihomo {e.mihomoDelay}ms</div>}
                  </div>
                </div>
                <Spark points={e.history} />
              </button>
            ))}
          </>
        )}

        {/* ── 守护规则（M3） ── */}
        {tab === 'rules' && (
          <>
            {!getWriteToken() && (
              <div className="card" style={{ color: 'var(--dim)', fontSize: 13 }}>
                当前只有读权限：可查看守护规则，开关与立即执行需要写令牌。
              </div>
            )}
            {repairs.length === 0 && <div className="empty">暂无守护规则</div>}
            {repairs.map(r => (
              <div className={`card rule-item ${r.state.lastOk === false ? 'rule-bad' : ''}`} key={r.id}>
                <div className="row" style={{ borderBottom: 'none', paddingBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="name">{r.name}</div>
                    <div className="meta">
                      {r.check.kind} · 每 {r.everySeconds >= 3600 ? `${Math.round(r.everySeconds / 3600)}h` : `${Math.round(r.everySeconds / 60)}min`}
                      {r.heal && r.heal.kind !== 'none' ? ` · 异常自动 ${r.heal.kind === 'ssh' ? 'SSH 修复' : '切最优节点'}` : ' · 仅告警'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {r.state.enabled
                      ? <span className={`badge ${r.state.lastOk === false ? 'bad' : 'ok'}`}>{r.state.lastOk === null ? '待首检' : r.state.lastOk ? '正常' : `异常×${r.state.failStreak}`}</span>
                      : <span className="badge neu">已停用</span>}
                  </div>
                </div>
                {r.state.lastDetail && <div className="meta" style={{ padding: '0 4px 8px', wordBreak: 'break-all' }}>最近：{r.state.lastDetail}</div>}
                <div className="meta" style={{ padding: '0 4px 8px' }}>
                  {r.state.lastRun ? `上次 ${fmtTime(r.state.lastRun)}` : '未运行'}
                  {r.state.nextRun ? ` · 下次 ${fmtTime(r.state.nextRun)}` : ''}
                  {r.state.healCount > 0 ? ` · 已自动修复 ${r.state.healCount} 次` : ''}
                </div>
                <div className="rule-actions">
                  <button className="chip" disabled={busy || !getWriteToken()}
                    onClick={() => doRunRule(r.id)}>立即执行</button>
                  <button className="chip" disabled={busy || !getWriteToken()}
                    onClick={() => doToggleRule(r.id, !r.state.enabled)}>
                    {r.state.enabled ? '停用' : '启用'}
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        {/* ── 分组管理 ── */}
        {tab === 'groups' && (
          <>
            {!getWriteToken() && (
              <div className="card" style={{ color: 'var(--dim)', fontSize: 13 }}>
                当前只有读权限。切换分组需要写令牌（首次进入时填写过就会记住）。
              </div>
            )}
            {groups.map(g => (
              <div className="card" key={g.name}>
                <div className="row" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                  <div>
                    <div className="name">{g.name}</div>
                    <div className="meta">{g.type} · 当前 {g.now}</div>
                  </div>
                </div>
                <div className="members">
                  {g.members.map(m => (
                    <button key={m.name}
                      className={`chip ${g.now === m.name ? 'active' : ''}`}
                      disabled={busy || !getWriteToken()}
                      onClick={() => doSwitch(g.name, m.name)}>
                      {m.name}
                      {m.delay != null && <span className="d">{m.delay}ms</span>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ── 连接 Top ── */}
        {tab === 'conns' && (
          <div className="card">
            <h2>活跃连接（按流量）</h2>
            {conns.length === 0 && <div className="empty">暂无连接</div>}
            {conns.map((c, i) => (
              <div className="row conn" key={i}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="host">{c.host}</div>
                  <div className="chains">{c.chains}</div>
                  <div className="meta">{c.src}</div>
                </div>
                <div className="bytes">↑{fmtMB(c.up)} ↓{fmtMB(c.down)}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── 告警 ── */}
        {tab === 'alerts' && (
          <>
            {alerts.length === 0 && <div className="empty">暂无告警 🎉</div>}
            {alerts.map(a => (
              <div className={`card alert-item ${a.severity === 'critical' ? 'crit' : ''}`} key={a.id}>
                <div className="row" style={{ borderBottom: 'none' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="name">{a.message}</div>
                    <div className="meta">{fmtTime(a.ts)} · {a.rule} · {a.severity}</div>
                  </div>
                  {a.status === 'open'
                    ? <button className="chip" onClick={async () => { await api.ackAlert(a.id); setAlerts(await api.alerts()); }}>确认</button>
                    : <span className="badge neu">已处理</span>}
                </div>
              </div>
            ))}
          </>
        )}
          </>
        }
      </div>

      {!detailId && (
      <div className="tabbar">
        {([
          ['fleet', '🏠', '舰队'],
          ['exits', '🌐', '出口'],
          ['rules', '🛡️', '守护'],
          ['groups', '🎛️', '分组'],
          ['conns', '📡', '连接'],
          ['alerts', '🔔', '告警'],
        ] as [Tab, string, string][]).map(([key, ico, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            <span className="ico">{ico}</span>
            {label}
            {key === 'alerts' && openAlerts > 0 && <span className="badge-dot">{openAlerts}</span>}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}
