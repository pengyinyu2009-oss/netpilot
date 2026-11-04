#!/bin/sh
# netpilot-agent —— /proc 采样；push 到 collector，或 --once 输出 JSON（供 collector SSH 拉取）
#
# 配置 /etc/netpilot-agent.conf（由 install-agent.sh 生成）：
#   AGENT_ID=hk                # 节点 id，须与 network.yaml 的 devices/exits id 一致
#   AGENT_NAME='香港-VPS'
#   NETPILOT_URL=http://<collector-host>:8898   # push 模式 collector 地址（--once 模式忽略）
#   NETPILOT_TOKEN=xxxx        # push 模式 agent 令牌（--once 模式忽略）
#   DATA_MP=/vol1              # 可选：额外数据分区挂载点（NAS 存储卷）
#   DEBUG=1                    # 可选：失败写 /tmp/netpilot-agent.log
#
# cron（push 模式）：* * * * * /usr/local/bin/netpilot-agent.sh >/dev/null 2>&1
# 拉取（pull 模式）：collector ssh 执行 `/usr/local/bin/netpilot-agent.sh --once`

# 配置查找顺序：$NETPILOT_AGENT_CONF → /etc/netpilot-agent.conf（root 安装）
#   → ~/.config/netpilot-agent.conf（用户级安装，无 sudo 时）
if [ -z "${NETPILOT_AGENT_CONF:-}" ]; then
  if [ -f /etc/netpilot-agent.conf ]; then NETPILOT_AGENT_CONF=/etc/netpilot-agent.conf
  elif [ -f "$HOME/.config/netpilot-agent.conf" ]; then NETPILOT_AGENT_CONF="$HOME/.config/netpilot-agent.conf"
  fi
fi
[ -n "${NETPILOT_AGENT_CONF:-}" ] && [ -f "$NETPILOT_AGENT_CONF" ] && . "$NETPILOT_AGENT_CONF"
: "${DISK_MP:=/}"

# 先记住模式标记：下面的 set -- 会覆盖位置参数（meminfo/loadavg/df 都用它拆字段）
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

# 数值或 null（空/非数值 → JSON null）
jnum() { case "$1" in ''|*[!0-9eE.+-]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

IS_MAC=0
uname -s | grep -q Darwin && IS_MAC=1

if [ "$IS_MAC" = "1" ]; then
  # ── macOS：iostat/vm_stat/sysctl/netstat（无 /proc）──
  CPU=$(iostat -c 2 2>/dev/null | tail -1 | awk '{printf "%.1f", 100-$NF}')
  set -- $(vm_stat 2>/dev/null | awk -v ps="$(sysctl -n hw.pagesize)" '
    /^Pages free/         {free=$3+0}
    /^Pages active/       {act=$3+0}
    /^Pages inactive/     {ina=$3+0}
    /^Pages speculative/  {spec=$3+0}
    /^Pages wired down/   {wir=$4+0}
    /^Pages compressed/   {comp=$3+0}
    END {
      total=int(('"$(sysctl -n hw.memsize)"')/ps);
      used=act+wir+comp;
      printf "%d %d", total*ps/1048576, used*ps/1048576}')
  MEM_TOTAL=$1; MEM_USED=$2
  set -- $(sysctl -n vm.swapusage 2>/dev/null | awk '{gsub(/M/,"");print $3,$6}')
  SWAP_TOTAL=$1; SWAP_USED=$2
  set -- $(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1,$2,$3}')
  LOAD1=$1; LOAD5=$2; LOAD15=$3
  # 注意 usec 里也含 "sec"——按字段精确匹配，别用贪婪 sed
  BOOT=$(sysctl -n kern.boottime 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="sec"){v=$(i+2); gsub(/,/,"",v); print v}}')
  UPTIME=$(( $(date +%s) - ${BOOT:-$(date +%s)} ))
  PROCS=$(ps ax 2>/dev/null | wc -l | tr -d ' ')
  set -- $(netstat -ib 2>/dev/null | awk 'NR>1 && !seen[$1]++ && $1 !~ /^lo/ {r+=$7; t+=$10} END {print r+0, t+0}')
  rx=$1; tx=$2
  KERNEL=$(uname -r)
  OS=$(printf '%s %s' "$(sw_vers -productName 2>/dev/null)" "$(sw_vers -productVersion 2>/dev/null)" | cut -c1-60)
else
  # ── Linux：/proc + /sys ──
  CPU=$(awk 'BEGIN{
    while((getline l < "/proc/stat")>0) if(l~/^cpu /){split(l,a," ");t1=a[2]+a[3]+a[4]+a[5]+a[6]+a[7]+a[8]+a[9];i1=a[5]+a[6];break}
    close("/proc/stat"); system("sleep 1");
    while((getline l < "/proc/stat")>0) if(l~/^cpu /){split(l,a," ");t2=a[2]+a[3]+a[4]+a[5]+a[6]+a[7]+a[8]+a[9];i2=a[5]+a[6];break}
    printf "%.1f",(t2>t1)?(100*(t2-t1-(i2-i1))/(t2-t1)):0}')
  set -- $(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{av=$2}/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}/^SwapTotal:/{st=$2}/^SwapFree:/{sf=$2}END{if(!av)av=f+b+c;printf "%d %d %d %d",t/1024,(t-av)/1024,st/1024,(st-sf)/1024}' /proc/meminfo)
  MEM_TOTAL=$1; MEM_USED=$2; SWAP_TOTAL=$3; SWAP_USED=$4
  set -- $(cat /proc/loadavg); LOAD1=$1; LOAD5=$2; LOAD15=$3
  UPTIME=$(awk '{print int($1)}' /proc/uptime)
  PROCS=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)
  rx=0; tx=0
  for s in /sys/class/net/*/statistics; do
    d=${s%/statistics}; d=${d##*/}
    [ "$d" = "lo" ] && continue
    r=$(cat "$s/rx_bytes" 2>/dev/null); t=$(cat "$s/tx_bytes" 2>/dev/null)
    case "${r:-}" in ''|*[!0-9]*) ;; *) rx=$((rx+r)) ;; esac
    case "${t:-}" in ''|*[!0-9]*) ;; *) tx=$((tx+t)) ;; esac
  done
  KERNEL=$(uname -r)
  OS=$( ( . /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME" ) || uname -s 2>/dev/null )
  OS=$(printf '%s' "$OS" | sed 's/"//g' | cut -c1-60)
fi

# ── disk（根分区必采；DATA_MP 可选，GB）──
set -- $(df -Pk / | awk 'NR==2{printf "%d %d",$3/1048576,$2/1048576}')
DISK_USED=$1; DISK_TOTAL=$2
DATA_MP_USED=""; DATA_MP_TOTAL=""
if [ -n "${DATA_MP:-}" ] && [ "$DATA_MP" != "/" ] && df -Pk "$DATA_MP" >/dev/null 2>&1; then
  set -- $(df -Pk "$DATA_MP" | awk 'NR==2{printf "%d %d",$3/1048576,$2/1048576}')
  DATA_MP_USED=$1; DATA_MP_TOTAL=$2
fi

# ── 网速差分（两系统共通：字节计数差 / 间隔；回绕或首跑输出 null）──
STATE="${NETPILOT_AGENT_STATE:-/tmp/.netpilot-net-state}"
NOW=$(date +%s)
UPBPS=""; DOWNBPS=""
if [ -f "$STATE" ]; then
  set -- $(cat "$STATE")
  dt=$((NOW - $3))
  if [ "$dt" -gt 0 ] && [ "$1" -le "$rx" ] && [ "$2" -le "$tx" ]; then
    DOWNBPS=$(( (rx - $1) / dt )); UPBPS=$(( (tx - $2) / dt ))
  fi
fi
printf '%s %s %s\n' "$rx" "$tx" "$NOW" > "$STATE"

# ── 组 JSON（extra：数据分区）──
EXTRA=""
if [ -n "${DATA_MP:-}" ] && [ -n "$DATA_MP_TOTAL" ]; then
  EXTRA=$(printf ',"dataMp":"%s","dataUsed":%s,"dataTotal":%s' "$DATA_MP" "$(jnum "$DATA_MP_USED")" "$(jnum "$DATA_MP_TOTAL")")
fi

JSON=$(printf '{"cpu":%s,"memUsed":%s,"memTotal":%s,"swapUsed":%s,"swapTotal":%s,"diskUsed":%s,"diskTotal":%s,"load1":%s,"load5":%s,"load15":%s,"upBps":%s,"downBps":%s,"uptimeSec":%s,"procs":%s,"kernel":"%s","os":"%s"%s}' \
  "$(jnum "$CPU")" "$(jnum "$MEM_USED")" "$(jnum "$MEM_TOTAL")" "$(jnum "$SWAP_USED")" "$(jnum "$SWAP_TOTAL")" \
  "$(jnum "$DISK_USED")" "$(jnum "$DISK_TOTAL")" \
  "$(jnum "$LOAD1")" "$(jnum "$LOAD5")" "$(jnum "$LOAD15")" \
  "$(jnum "$DOWNBPS")" "$(jnum "$UPBPS")" "$(jnum "$UPTIME")" "$(jnum "$PROCS")" \
  "$KERNEL" "$OS" "$EXTRA")

# ── 输出 ──
if [ "$ONCE" = "1" ]; then
  printf '%s\n' "$JSON"
  exit 0
fi

if [ -z "${NETPILOT_URL:-}" ] || [ -z "${AGENT_ID:-}" ]; then
  echo "netpilot-agent: NETPILOT_URL / AGENT_ID not configured in ${NETPILOT_AGENT_CONF:-<no conf found>}" >&2
  exit 1
fi

if curl -sf -m 10 -X POST \
     -H "Authorization: Bearer ${NETPILOT_TOKEN:-}" -H 'Content-Type: application/json' \
     -d "{\"id\":\"${AGENT_ID}\",\"name\":\"${AGENT_NAME:-$AGENT_ID}\",\"metrics\":$JSON}" \
     "$NETPILOT_URL/api/agent/report" >/dev/null; then
  [ "${DEBUG:-0}" = 1 ] && echo "$(date '+%F %T') report ok" >> /tmp/netpilot-agent.log
  exit 0
else
  [ "${DEBUG:-0}" = 1 ] && echo "$(date '+%F %T') report FAILED" >> /tmp/netpilot-agent.log
  exit 1
fi
