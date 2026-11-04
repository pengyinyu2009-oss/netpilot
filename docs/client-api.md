# NetPilot 客户端契约（REST / MCP）

认证：`Authorization: Bearer <token>`；读/写/agent 三令牌分离（.env）。
所有写操作（含 heal、切换分组）落 `/api/events` 审计。

## REST（前缀 /api，read 令牌可读，write 令牌可写）
| 端点 | 方法 | 权限 | 说明 |
|---|---|---|---|
| /status | GET | read | 舰队总览（设备/出口/分组/流量/告警数） |
| /exits /groups /connections /rules | GET | read | 出口 / 分组成员延迟 / 连接 Top / mihomo 规则 |
| /devices | GET | read | agent 注册表（最新指标快照） |
| /nodes/:id/detail | GET | read | 单节点详情（探针 6h + agent 指标 24h） |
| /diagnose | GET | read | 一键诊断（路由/设备/出口/DNS/守护/告警 pass-fail） |
| /lan | GET | read | 局域网设备基线（ARP 扫描） |
| /traffic/daily?days=14 | GET | read | 每设备日流量累计 |
| /alerts /events | GET | read | 告警与审计事件流 |
| /groups/:name | PUT | write | 切换分组出口 |
| /mode | PUT | write | 代理模式 rule/global/direct |
| /repairs/:id/toggle·run | PUT·POST | write | 守护规则开关 / 立即执行 |
| /alerts/:id/ack | POST | write | 确认告警 |
| /notify/test | POST | write | 测试通知 |
| /router/restart | POST | write | 重启 OpenClash（sshpass 走 router.ssh 凭据） |
| /agent/report | POST | agent | agent 上报（AGENT_TOKEN） |

## MCP（/mcp，Streamable HTTP）
initialize 后带 `mcp-session-id`；读令牌 9 只读工具 / 写令牌 13 全量工具
（fleet_status / node_detail / probe_now / switch_group / set_mode / toggle_repair / run_repair /
restart_openclash / list_alerts / ack_alert / recent_events / list_devices / list_exits / list_rules / list_groups / list_connections / list_repairs 等）。

## agent 上报格式
`POST /api/agent/report`：`{"id":"nas","name":"NAS","metrics":{cpu,memUsed,memTotal,swapUsed,swapTotal,
diskUsed,diskTotal,load1,load5,load15,upBps,downBps,uptimeSec,procs,kernel,os,...}}`
缺失字段自动为 null；`--once` 模式（pull）输出同结构 JSON 到 stdout。
