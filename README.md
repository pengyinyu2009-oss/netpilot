# NetPilot

自托管的全屋网络管控与可观测面板。一台 collector 常驻 Docker，统一看**所有设备**（NAS / PC / 手机 / 路由器 / 各家 VPS）：探针、CPU/内存/磁盘、代理分组、出口延迟、守护自愈、告警推送。

- **通用**：任何能跑 Docker 的 Linux/群晖/NAS 皆可部署；不依赖任何特定硬件
- **两种采集**：push（目标机 agent 上报，agent 是 60KB 单文件脚本）与 pull（collector 经 SSH 拉取，覆盖无内网的 VPS）
- **声明式**：监控谁、探什么、坏了自动修什么，全写在 `network.yaml`
- **可裁剪**：没有 Clash/mihomo 也能用——设备监控/守护/告警全照常

## 3 分钟部署

```bash
git clone <repo> netpilot && cd netpilot
sh scripts/setup.sh
```

脚本会做四件事：生成 `.env`（三枚令牌）→ 从模板拷 `network.yaml` → 容器内构建前端并启动 → 打印访问地址。

打开 `http://<本机IP>:8898`，输入 `.env` 里的 `NETPILOT_READ_TOKEN` 即进面板。

> 之后：改 `network.yaml` 填你的设备 → `docker compose up -d` → 按 [agents/README.md](agents/README.md) 给机器装 agent。

## 界面

苹果风浅色 PWA（桌面+手机皆宜）：舰队总览 / 出口 / 守护 / 分组 / 连接 / 告警 六页签，设备详情含 6h 探针曲线与 24h 指标曲线，一键诊断把健康面收敛成一页 pass/fail。手机可「添加到主屏幕」离线访问。

## 配置（network.yaml）

```yaml
devices:
  - id: nas                      # agent 上报按 id 对号
    name: NAS
    host: 192.168.1.10
    probes:
      - { type: tcp, port: 22 }
      - { type: tcp, port: 22, host: host.docker.internal }   # 容器探宿主机必用
      - { type: icmp }                                       # 电视/平板等
exits:
  - id: vps
    host: 203.0.113.10
    agent:                        # 无内网的 VPS：collector 经 SSH 拉取
      pull: { user: root, key: /app/keys/vps }
repairs:
  - id: tunnel-guard             # 坏了自动修
    everySeconds: 120
    check: { kind: tcp, host: 203.0.113.10, port: 8443 }
    heal:  { kind: ssh, host: ..., key: /app/keys/vps, command: "systemctl restart wg-quick@wg0" }
```

完整字段说明见 [network.example.yaml](network.example.yaml)；REST/MCP/agent 契约见 [docs/client-api.md](docs/client-api.md)。

## 给机器装 agent（60KB 单文件）

```bash
scp agents/netpilot-agent.sh agents/install-agent.sh target:/tmp/
ssh target 'AGENT_ID=laptop AGENT_NAME="笔记本" \
  NETPILOT_URL=http://<collectorIP>:8898 NETPILOT_TOKEN=<AGENT_TOKEN> \
  sh /tmp/install-agent.sh'
```

自动完成：装脚本 → 注册 cron/launchd/schtasks → 立即上报一次。Windows 用 `netpilot-agent.ps1` + 计划任务（agents/README.md 有命令）。VPS 不想装 agent 就配 `agent.pull`（上面示例）。

## 通知（告警推送）

`.env`：`NOTIFY_PROVIDER=bark|ntfy|telegram|webhook`，对应填 URL/令牌；同一告警 30 分钟冷却，免刷屏。设备离线/恢复、新设备接入、守护异常都会推送到你手机。

## 常见问题

- **容器探宿主机失败**：宿主机有源地址策略路由时回包黑洞 → 探针打 `host.docker.internal`（compose 已默认挂 host-gateway）
- **拉不到 Docker Hub**：`NETPILOT_WEB_IMAGE=本地镜像 docker compose build` 换基础镜像
- **没有 Clash**：router 段随便填一台机，分组页为空不影响其余功能

安全边界：只监听内网（勿映射公网）；读/写/agent 三令牌分离；私钥只进 `./keys/`（已 gitignore）；所有写操作落审计事件。MIT License。

## 目录

```
services/collector/   collector（Fastify + SQLite + REST/MCP）
packages/web/         PWA 前端（Vite + React）
packages/core/        共享类型
agents/               单文件 agent + 安装器（通用件）
scripts/setup.sh      一键初始化
docs/                 API 契约
examples/home-net/    一份真实家庭网络配置（含专用脚本）参考
```

## 示例：真实部署长什么样

[examples/home-net.yaml](examples/home-net.yaml) 是一套运行中的家庭网络配置：8 台设备、4 个 VPS 出口、7 条守护规则、agent 双模式混用——照它抄改比从零写快。

MIT License，见 [LICENSE](LICENSE)。
