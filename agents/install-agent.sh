#!/bin/sh
# netpilot agent 安装器 —— 在目标机上执行（scp 两个脚本过去，或 ssh 管道）
#
# push 模式（自装 cron 每分钟上报）：
#   AGENT_ID=hk AGENT_NAME='香港-VPS' NETPILOT_URL=http://<collector-host>:8898 \
#   NETPILOT_TOKEN=xxx sh install-agent.sh [agent脚本路径]
#
# pull 模式（只装脚本，collector SSH 来拉）：
#   MODE=pull AGENT_ID=aly AGENT_NAME='阿里云枢纽' sh install-agent.sh [agent脚本路径]
#
# root 装到 /usr/local/bin + /etc；无 sudo 自动降级 ~/.local/bin + ~/.config（用户级 crontab）
# 可选：DATA_MP=/vol1（额外数据分区）；NETPILOT_AGENT_CRON='*/2 * * * *'（自定义频率）
set -e

SCRIPT="${1:-}"
if [ -z "$SCRIPT" ]; then
  # ssh 管道安装时：脚本从 stdin 来，先落盘
  SCRIPT=/tmp/.netpilot-agent-install.sh
  cat > "$SCRIPT"
fi

: "${MODE:=push}"
: "${AGENT_ID:?AGENT_ID required}"
AGENT_NAME="${AGENT_NAME:-$AGENT_ID}"

if [ "$(id -u)" = "0" ]; then
  BIN_DIR=/usr/local/bin
  CONF_FILE=/etc/netpilot-agent.conf
  CRON_CMD="$BIN_DIR/netpilot-agent.sh"
  mkdir -p "$BIN_DIR"        # OpenWrt 默认没有 /usr/local/bin
else
  BIN_DIR="$HOME/.local/bin"
  CONF_FILE="$HOME/.config/netpilot-agent.conf"
  mkdir -p "$BIN_DIR" "$HOME/.config"
  CRON_CMD="$BIN_DIR/netpilot-agent.sh"
fi

# busybox 无 install applet 时 cp+chmod 同样可用
cp "$SCRIPT" "$BIN_DIR/netpilot-agent.sh"
chmod 755 "$BIN_DIR/netpilot-agent.sh"

{
  echo "AGENT_ID=\"$AGENT_ID\""
  echo "AGENT_NAME=\"$AGENT_NAME\""
  [ -n "${NETPILOT_URL:-}" ]   && echo "NETPILOT_URL=\"$NETPILOT_URL\""
  [ -n "${NETPILOT_TOKEN:-}" ] && echo "NETPILOT_TOKEN=\"$NETPILOT_TOKEN\""
  [ -n "${DATA_MP:-}" ]        && echo "DATA_MP=\"$DATA_MP\""
  echo "DEBUG=0"
} > "$CONF_FILE"
chmod 600 "$CONF_FILE"

if [ "$MODE" = "pull" ]; then
  echo "[install] pull 模式：仅安装脚本（$CRON_CMD --once 可用）"
  "$CRON_CMD" --once | head -c 200; echo
  exit 0
fi

: "${NETPILOT_URL:?NETPILOT_URL required for push mode}"
: "${NETPILOT_TOKEN:?NETPILOT_TOKEN required for push mode}"
# 注意不能写 : "${V:='* * * * *'}"——dash 会保留内层引号，cron 行会以 '* 开头
if [ -z "${NETPILOT_AGENT_CRON:-}" ]; then NETPILOT_AGENT_CRON='* * * * *'; fi

CRON_LINE="$NETPILOT_AGENT_CRON $CRON_CMD >/dev/null 2>&1"
# 部分发行版 `crontab -`（管道喂入）会静默失败/报 bad minute，统一走临时文件；
# grep -v 过滤后可能为空（crontab 里只有 netpilot 行）→ exit 1，set -e 会中断，必须 || true 兜底
TMP_CRON="$(mktemp /tmp/netpilot-cron.XXXXXX)"
{ crontab -l 2>/dev/null | grep -v 'netpilot-agent.sh' || true; echo "$CRON_LINE"; } > "$TMP_CRON"
crontab "$TMP_CRON"
rm -f "$TMP_CRON"

echo "[install] conf=$CONF_FILE cron=$(crontab -l 2>/dev/null | grep netpilot-agent.sh)"
if "$CRON_CMD"; then
  echo "[install] 首次上报 OK"
else
  echo "[install] 首次上报失败（检查 NETPILOT_URL 可达性/令牌）" >&2
  exit 1
fi
