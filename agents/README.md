# NetPilot Agent 部署

单文件 agent，每 60s 上报 CPU/内存/温度到 collector `/api/agent/report`（AGENT_TOKEN 鉴权）。
`COLLECTOR` 同机用 `http://127.0.0.1:8898`；跨机建议 Tailscale URL `http://100.100.100.100:8898`（可漫游）。

## NAS (id=nas) — fnOS cron
```bash
# .env 已有 AGENT_TOKEN；脚本在 ~/netpilot/agents/
crontab -l | grep -v netpilot-agent | { cat; echo '* * * * * AGENT_ID=nas COLLECTOR=http://127.0.0.1:8898 TOKEN=<AGENT_TOKEN> /bin/sh /home/pengyinyu/netpilot/agents/netpilot-agent.sh'; } | crontab -
```

## Mac (id=mac) — launchd
`~/Library/LaunchAgents/com.netpilot.agent.plist`：/bin/sh 跑 repo 里的 netpilot-agent.sh，
EnvironmentVariables 注入 AGENT_ID/COLLECTOR/TOKEN，StartInterval=60 + RunAtLoad。
重装：改 plist 后 `launchctl unload && launchctl load`。

## Win (id=win) — schtasks
`C:\netpilot\agent.ps1`（安装时用真实 token 替换），计划任务 `NetPilotAgent`（/SC MINUTE /MO 1）：
```cmd
schtasks /Create /TN NetPilotAgent /SC MINUTE /MO 1 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\netpilot\agent.ps1" /F
```

## R68S (id=r68s) — OpenWrt cron
```sh
scp agents/netpilot-agent.sh root@192.168.1.1:/root/netpilot-agent.sh
# /etc/crontabs/root 追加：
* * * * * AGENT_ID=r68s COLLECTOR=http://<collector-host>:8898 TOKEN=<AGENT_TOKEN> /bin/sh /root/netpilot-agent.sh
/etc/init.d/cron restart
```

## 排坑
- sh 版走 dash/busybox 兼容写法（CPU 采样用 `set --`，勿用 `read A B C D`——首变量会吃到 "cpu" 标签）
- ps1 若上报消失：`schtasks /Query /TN NetPilotAgent` + 手动 `powershell -File C:\netpilot\agent.ps1` 看报错
