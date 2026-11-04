// NetPilot 共享类型（collector / web / agent / 未来各端壳共用）
export interface ProbeSpec {
  type: 'tcp' | 'http' | 'icmp';
  host?: string;            // 覆写目标地址（如 NAS 探针打 host.docker.internal 绕开 fnOS 策略路由黑洞）
  port?: number;
  url?: string;
  secret?: string;
}

// agent 深度监控：push=目标机自装 agent 上报；pull=collector 周期 SSH 拉取（目标机装 --once 脚本）
export interface AgentPullSpec {
  user: string;
  key: string;              // collector 容器内私钥路径
  everySeconds?: number;    // 默认 60
  script?: string;          // 默认 /usr/local/bin/netpilot-agent.sh
}

export interface DeviceSpec {
  id: string;
  name: string;
  host: string;
  role?: string;
  probes: ProbeSpec[];
  agent?: { pull?: AgentPullSpec };
  source?: 'yaml' | 'runtime';   // runtime = UI 添加（存 SQLite，重启自动合并）
}

export interface ExitSpec {
  id: string;
  name: string;
  host: string;
  probes: ProbeSpec[];
  agent?: { pull?: AgentPullSpec };
}

export interface RouterSpec {
  id: string;
  name: string;
  host: string;
  api: { port: number; secret: string };
  ssh?: { user: string; password: string };
  groups: string[];
  lanscan?: { enabled: boolean; everySeconds?: number };   // 局域网新设备发现（R68S ARP 扫描）
}

export interface NetworkConfig {
  fleet: { name: string; timezone: string };
  router: RouterSpec;
  devices: DeviceSpec[];
  exits: ExitSpec[];
  repairs: RepairSpec[];
}

// M3 修复引擎：每条守护=一条声明式规则（check 连续 failStreak 轮失败 → 执行 heal + 告警通知）
export type CheckSpec =
  | { kind: 'group_alive'; group: string; timeoutMs?: number }
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'cert_days'; host: string; port: number; minDays: number }
  | { kind: 'ssh_expect'; host: string; user: string; port?: number; key?: string; passwordEnv?: string; command: string; expect: string }
  | { kind: 'ssh_threshold'; host: string; user: string; port?: number; key?: string; passwordEnv?: string; command: string; max: number };

export type ActionSpec =
  | { kind: 'none' }
  | { kind: 'switch_group_best'; group: string }
  | { kind: 'ssh'; host: string; user: string; port?: number; key?: string; passwordEnv?: string; command: string };

export interface RepairSpec {
  id: string;
  name: string;
  enabled: boolean;
  everySeconds: number;
  failStreak?: number;      // 默认 2；确定性漂移类检查设 1
  check: CheckSpec;
  heal?: ActionSpec;
}

// 运行态（API 展示用）
export interface RepairState {
  enabled: boolean;          // 生效开关（含运行时覆盖）
  lastRun: number | null;
  lastOk: boolean | null;
  lastDetail: string;
  failStreak: number;
  healCount: number;         // 累计修复次数
  lastHeal: number | null;
  nextRun: number | null;
}

// ── API DTO ──
export interface ProbePoint { ts: number; latencyMs: number | null; ok: boolean }

// agent 单次上报/采样（数值缺失为 null，脚本首跑无网速差分基线时即如此）
export interface AgentMetrics {
  cpu: number | null;                                  // %
  memUsed: number | null; memTotal: number | null;     // MB
  swapUsed: number | null; swapTotal: number | null;   // MB
  diskUsed: number | null; diskTotal: number | null;   // GB（根分区）
  load1: number | null; load5: number | null; load15: number | null;
  upBps: number | null; downBps: number | null;        // B/s
  uptimeSec: number | null;
  procs: number | null;
  kernel?: string; os?: string;
  dataMp?: string; dataUsed?: number | null; dataTotal?: number | null;   // 可选数据分区（NAS 存储卷等）
}

export interface DeviceMetricPoint extends AgentMetrics { ts: number }

export interface AgentSummary { lastSeen: number; cpu?: number | null; memPct?: number | null; diskPct?: number | null }

export interface NodeDetail {
  id: string; name: string; host: string; role?: string;
  kind: 'device' | 'exit';
  agentOnline: boolean; agentLastSeen: number | null;
  latest: ProbePoint | null;
  probeHistory: ProbePoint[];          // 6h
  mihomoDelayHistory: ProbePoint[] | null;  // 仅出口
  metricsLatest: AgentMetrics | null;
  metricsHistory: DeviceMetricPoint[]; // 24h 降采样
  note?: string;
}

export interface ExitStatus {
  id: string; name: string; host: string;
  latest: ProbePoint | null;
  history: ProbePoint[];
  mihomoDelay: number | null;   // mihomo 侧同名节点的实测延迟
  agent?: AgentSummary | null;
}

export interface DeviceStatus {
  id: string; name: string; host: string; role?: string;
  latest: ProbePoint | null;
  history: ProbePoint[];
  agent?: AgentSummary | null;
}

export interface GroupMember {
  name: string; type: string; delay: number | null; alive: boolean;
}

export interface GroupStatus {
  name: string; type: string; now: string; members: GroupMember[];
}

export interface ConnRow {
  host: string; src: string; chains: string;
  up: number; down: number; rule: string;
}

export interface AlertRow {
  id: number; ts: number; rule: string; severity: string;
  message: string; status: 'open' | 'ack'; data?: unknown;
}

export interface FleetStatus {
  fleet: string;
  router: { name: string; host: string; version: string | null; uptimeSec: number | null; reachable: boolean };
  counts: { devices: number; exits: number; groups: number; openAlerts: number; connections: number };
  traffic: { upBps: number; downBps: number };
  groupsNow: Record<string, string>;
  devices: DeviceStatus[];
  exits: ExitStatus[];
}
