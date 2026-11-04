#!/bin/sh
# NetPilot 初始化：生成 .env → 拷贝配置模板 → 起服务 → 打印入口
# 用法：sh scripts/setup.sh   （首次部署；改配置见 network.yaml）
set -e
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.example .env
[ -f network.yaml ] || cp network.example.yaml network.yaml

# 生成三个令牌（仅首次；已有则保留）
gen() { openssl rand -hex 16; }
grep -q '^NETPILOT_READ_TOKEN=..*' .env || echo "NETPILOT_READ_TOKEN=$(gen)" >> .env
grep -q '^NETPILOT_WRITE_TOKEN=..*' .env || echo "NETPILOT_WRITE_TOKEN=$(gen)" >> .env
grep -q '^NETPILOT_AGENT_TOKEN=..*' .env || echo "NETPILOT_AGENT_TOKEN=$(gen)" >> .env

echo "[setup] .env 与 network.yaml 就绪（改 network.yaml 填你的设备）"
echo "[setup] 构建并启动（前端容器内构建，无需本机 Node）…"
docker compose up -d --build
PORT=$(grep '^NETPILOT_PORT=' .env | cut -d= -f2 || echo 8898)
echo ""
echo "✅ 完成：http://<本机IP>:${PORT:-8898}"
echo "   读令牌 = .env 的 NETPILOT_READ_TOKEN"
echo "   下一步：按 agents/README.md 给各设备装 agent"
