#!/bin/sh
# NetPilot 初始化：预检 → 生成 .env → 拷模板 → 起服务 → 等健康 → 打印下一步
# 用法：sh scripts/setup.sh
set -e
cd "$(dirname "$0")/.."
BOLD=''; [ -t 1 ] && BOLD='\033[1m'; NC=''; [ -t 1 ] && NC='\033[0m'
say() { printf "\033[1;34m[setup]\033[0m %s\n" "$1"; }

# ── 预检 ──
command -v docker >/dev/null 2>&1 || { echo "❌ 未检测到 docker，请先安装 Docker（群晖/飞牛在容器面板里装）"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "❌ docker compose 不可用（需要 Docker Compose V2）"; exit 1; }
docker info >/dev/null 2>&1 || { echo "❌ docker 守护进程没跑（sudo systemctl start docker / 打开 Docker Desktop）"; exit 1; }
PORT=$(grep -E '^NETPILOT_PORT=' .env 2>/dev/null | cut -d= -f2 || true)
PORT=${PORT:-8898}
if docker ps --format '{{.Ports}}' | grep -q ":$PORT->"; then
  echo "❌ 端口 $PORT 已被占用：改 .env 的 NETPILOT_PORT 或停掉占用进程"; exit 1
fi

# ── .env 与配置模板 ──
[ -f .env ] || cp .env.example .env
[ -f network.yaml ] || cp network.example.yaml network.yaml
fill() {  # 就地填充空令牌（避免追加重复行）
  var=$1; line="${var}=$(openssl rand -hex 16)"
  if grep -q "^${var}=..*" .env; then return 0; fi
  if grep -q "^${var}=" .env; then
    sed -i.bak "s|^${var}=.*|${line}|" .env && rm -f .env.bak
  else
    echo "$line" >> .env
  fi
}
fill NETPILOT_READ_TOKEN; fill NETPILOT_WRITE_TOKEN; fill NETPILOT_AGENT_TOKEN
tok() { grep "^$1=" .env | head -1 | cut -d= -f2; }

say "构建镜像并启动（首次约 3-8 分钟，前端在容器内构建，本机无需 Node）…"
docker compose up -d --build

# ── 等健康检查真正就绪 ──
say "等待服务就绪…"
i=0
until curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "❌ 等待超时，看日志：docker logs netpilot-collector"; exit 1; }
  sleep 2
done

# ── 本机 IP 与收尾指引 ──
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
[ -z "$IP" ] && IP=$(ifconfig 2>/dev/null | awk '/inet /{print $2; exit}')
[ -z "$IP" ] && IP="<本机IP>"

cat <<EOF

✅ 部署完成！

   打开面板：http://${IP}:${PORT}
   读令牌（首次进入粘贴）：$(tok NETPILOT_READ_TOKEN)

${BOLD}接下来（3 步，各设备 1 分钟）：${NC}
   1. 编辑 network.yaml，把示例设备改成你家的（IP/名字），然后：
        docker compose up -d
   2. 给每台机器装 agent（把下面命令里的 IP 换成面板地址，在各机器上执行）：
        scp agents/netpilot-agent.sh agents/install-agent.sh <机器>:/tmp/
        ssh <机器> 'AGENT_ID=mypc AGENT_NAME="我的电脑" \\
          NETPILOT_URL=http://${IP}:${PORT} NETPILOT_TOKEN=$(tok NETPILOT_AGENT_TOKEN) \\
          sh /tmp/install-agent.sh'
   3. 手机装 ntfy/Bark App 订阅通知（.env 里 NOTIFY_PROVIDER 配置）

   全部说明：README.md ｜ 令牌与配置都在 .env / network.yaml（勿外泄）
EOF
