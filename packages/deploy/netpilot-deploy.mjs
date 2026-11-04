#!/usr/bin/env node
// netpilot deploy —— 新设备一键入网（M4）
//   安装 agent（linux/mac/win 三形态）+ 注册到 network.yaml（自动备份可回滚）+ 验证上报
// 零 npm 依赖，仅用 node 内置 + 目标机 SSH；在能直达 collector 与目标机的机器上运行
//
// Linux/mac push agent:
//   node netpilot-deploy.mjs --for linux --host 1.2.3.4 [--port 22] --user root \
//     --id myvps --name '我的VPS' --url http://100.100.100.100:8898 --token <AGENT_TOKEN> \
//     [--yaml ~/netpilot/network.yaml] [--key ~/.ssh/id_ed25519] [--dry-run]
// Windows (SSH 目标须可达，agent 经 schtask 每分钟上报):
//   node netpilot-deploy.mjs --for win --host 192.168.1.20 --user pyy --key ~/.ssh/key --id win ...
// 仅注册（改 network.yaml，不装 agent）:
//   node netpilot-deploy.mjs --register --kind device --id tablet --host 192.168.1.40 --probes icmp --yaml ...
// 回滚最近一次 yaml 变更:
//   node netpilot-deploy.mjs --rollback --yaml ...
// 验证某设备已上报:
//   node netpilot-deploy.mjs --verify --id win --url http://... --token <READ_TOKEN>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const A = process.argv.slice(2);
const arg = (k, d = '') => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : d; };
const has = k => A.includes('--' + k);
const repo = arg('repo', '.');
const yamlPath = arg('yaml', path.join(repo, 'network.yaml'));

function sh(cmd, args, input) {
  return execFileSync(cmd, args, { input, encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] });
}
function sshArgs(host, user, port, key) {
  const a = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=12'];
  if (port) a.push('-p', String(port));
  if (key) a.push('-i', key);
  a.push(`${user}@${host}`);
  return a;
}
const step = m => console.log(`[deploy] ${m}`);
const die = m => { console.error(`[deploy] ✗ ${m}`); process.exit(1); };

const AGENT_SH = path.join(repo, 'agents', 'netpilot-agent.sh');
const INSTALL_SH = path.join(repo, 'agents', 'install-agent.sh');

// Windows agent 模板（ASCII-only：PS5.1 无 BOM 读中文注释会坏）
const WIN_AGENT_PS1 = `# NetPilot agent (Windows): reports CPU/mem/disk/net/uptime/procs/temp to collector.
# schtask \\NetPilotAgent runs this every minute.
$Id     = '__ID__'
$Name   = '__NAME__'
$Url    = '__URL__'
$Token  = '__TOKEN__'
$ErrorActionPreference = 'SilentlyContinue'
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os  = Get-CimInstance Win32_OperatingSystem
$memTotalMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
$memUsedMB  = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1024)
$uptime = $null
try { $uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds } catch {}
$diskTotalGB = $null; $diskUsedGB = $null
$c = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
if ($c.Size) { $diskTotalGB = [math]::Round($c.Size / 1GB, 1); $diskUsedGB = [math]::Round(($c.Size - $c.FreeSpace) / 1GB, 1) }
$procs = (Get-Process).Count
$rx = 0; $tx = 0
Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface |
  Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo' } |
  ForEach-Object { $rx += $_.BytesReceivedPersec; $tx += $_.BytesSentPersec }
$temp = $null
try {
  $t = (Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue |
        Measure-Object -Property CurrentTemperature -Maximum).Maximum
  if ($t) { $temp = [math]::Round($t / 10.0 - 273.15, 1) }
} catch {}
$m = @{ cpu = $cpu; memUsed = $memUsedMB; memTotal = $memTotalMB;
        diskUsed = $diskUsedGB; diskTotal = $diskTotalGB;
        upBps = $tx; downBps = $rx; uptimeSec = $uptime; procs = $procs; temp = $temp }
$body = @{ id = $Id; name = $Name; metrics = $m } | ConvertTo-Json -Depth 3
try {
  Invoke-RestMethod -Uri "$Url/api/agent/report" -Method Post -ContentType 'application/json' \`
    -Headers @{ Authorization = "Bearer $Token" } -Body $body -TimeoutSec 8 | Out-Null
} catch {}
`;

const MAC_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.netpilot.agent</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>__BIN__/netpilot-agent.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_ID</key><string>__ID__</string>
    <key>AGENT_NAME</key><string>__NAME__</string>
    <key>NETPILOT_URL</key><string>__URL__</string>
    <key>NETPILOT_TOKEN</key><string>__TOKEN__</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
</dict>
</plist>
`;

function registerYaml(id, kind, host, role, probes) {
  if (!fs.existsSync(yamlPath)) die(`yaml 不存在: ${yamlPath}`);
  const raw = fs.readFileSync(yamlPath, 'utf8');
  if (new RegExp(`^\\s*- id: ${id}\\b`, 'm').test(raw)) { step(`yaml 已含 ${id}，跳过注册`); return; }
  const bak = `${yamlPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(yamlPath, bak);
  step(`yaml 备份 → ${bak}`);
  const lines = probes.split(',').map(p => {
    const [t, port] = p.trim().split(':');
    return port ? `      - { type: ${t}, port: ${port} }` : `      - { type: ${t} }`;
  });
  const block = [
    `  - id: ${id}`,
    `    name: ${arg('name', id)}`,
    `    host: ${host}`,
    ...(role ? [`    role: ${role}`] : []),
    `    probes:`,
    ...(lines.length ? lines : ['      - { type: tcp, port: 22 }']),
  ].join('\n') + '\n';
  const header = kind === 'exit' ? 'exits:' : 'devices:';
  // 在段头那一「行」结束后插入（段头可能带行内注释，不能按 token 位置切）
  const m = new RegExp(`^${header}[^\\n]*\\n`, 'm').exec(raw);
  if (!m) die(`yaml 缺少 ${header} 段`);
  const out = raw.slice(0, m.index + m[0].length) + block + raw.slice(m.index + m[0].length);
  fs.writeFileSync(yamlPath, out);
  step(`已注册 ${kind} ${id} → ${yamlPath}`);
}

async function verify(id, url, token) {
  const r = await fetch(`${url.replace(/\/$/, '')}/api/devices`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) die(`verify 失败: HTTP ${r.status}`);
  const list = await r.json();
  const d = list.find(x => x.id === id);
  if (!d) die(`verify: ${id} 未出现在 /api/devices`);
  console.log(`[deploy] ✓ verify: ${id} 上报于 ${new Date(d.last_seen).toLocaleString('zh-CN')} metrics=${(d.metrics || '').slice(0, 80)}`);
}

(async () => {
  const id = arg('id');
  const url = arg('url');
  const token = arg('token');
  const host = arg('host');
  const user = arg('user', 'root');
  const port = Number(arg('port', '0')) || undefined;
  const key = arg('key') || undefined;
  const dry = has('dry-run');

  if (has('rollback')) {
    const dir = path.dirname(yamlPath);
    const baks = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(yamlPath) + '.bak-')).sort();
    if (!baks.length) die('无备份可回滚');
    const latest = baks[baks.length - 1];
    fs.copyFileSync(path.join(dir, latest), yamlPath);
    console.log(`[deploy] ✓ 已回滚 ${path.basename(yamlPath)} ← ${latest}`);
    return;
  }

  if (has('verify')) {
    if (!id || !url) die('--verify 需要 --id --url');
    await verify(id, url, arg('read-token') || token);
    return;
  }

  if (has('register')) {
    if (!id || !host) die('--register 需要 --id --host');
    registerYaml(id, arg('kind', 'device'), host, arg('role'), arg('probes', 'tcp:22'));
    return;
  }

  // ── agent 安装 ──
  const for_ = arg('for', 'linux');
  if (!id || !host || !url || !token) die('agent 安装需要 --id --host --url --token');
  const name = arg('name', id);
  const sa = sshArgs(host, user, port, key);

  step(`preflight: ssh ${user}@${host}`);
  sh('ssh', [...sa, 'echo ok']);

  if (dry) { step('(dry-run) 预检通过，未做任何变更'); return; }

  if (for_ === 'linux') {
    step('推送 agent 脚本');
    sh('ssh', [...sa, 'cat > /tmp/np-agent.sh'], fs.readFileSync(AGENT_SH));
    sh('ssh', [...sa, 'cat > /tmp/np-install.sh'], fs.readFileSync(INSTALL_SH));
    step('安装（cron + conf + 首报）');
    const envs = `AGENT_ID=${id} AGENT_NAME='${name}' NETPILOT_URL=${url} NETPILOT_TOKEN=${token} DATA_MP='${arg('data-mp')}'`;
    sh('ssh', [...sa, `${envs} sh /tmp/np-install.sh /tmp/np-agent.sh && rm -f /tmp/np-agent.sh /tmp/np-install.sh`]);
  } else if (for_ === 'mac') {
    step('推送 agent 脚本（macOS 分支支持 /proc 缺失环境）');
    sh('ssh', [...sa, 'mkdir -p ~/.local/bin ~/.config && cat > ~/.local/bin/netpilot-agent.sh'], fs.readFileSync(AGENT_SH));
    sh('ssh', [...sa, 'chmod 755 ~/.local/bin/netpilot-agent.sh']);
    step('写配置 + launchd plist');
    const conf = `AGENT_ID="${id}"\nAGENT_NAME="${name}"\nNETPILOT_URL="${url}"\nNETPILOT_TOKEN="${token}"\nDEBUG=0\n`;
    sh('ssh', [...sa, 'cat > ~/.config/netpilot-agent.conf && chmod 600 ~/.config/netpilot-agent.conf'], conf);
    const remoteHome = sh('ssh', [...sa, 'echo $HOME']).trim();
    const plist = MAC_PLIST.replaceAll('__ID__', id).replaceAll('__NAME__', name)
      .replaceAll('__URL__', url).replaceAll('__TOKEN__', token).replaceAll('__BIN__', remoteHome);
    sh('ssh', [...sa, 'cat > /tmp/com.netpilot.agent.plist'], plist);
    sh('ssh', [...sa, 'launchctl bootout gui/$(id -u)/com.netpilot.agent 2>/dev/null; launchctl bootstrap gui/$(id -u) /tmp/com.netpilot.agent.plist && rm /tmp/com.netpilot.agent.plist']);
  } else if (for_ === 'win') {
    step('写 C:/netpilot/agent.ps1 + 注册 schtask');
    const ps1 = WIN_AGENT_PS1.replaceAll('__ID__', id).replaceAll('__NAME__', name).replaceAll('__URL__', url).replaceAll('__TOKEN__', token);
    sh('ssh', [...sa, 'mkdir C:\\netpilot 2>nul & echo ok']);
    const tmp = path.join(os.tmpdir(), `netpilot-agent-${id}.ps1`);
    fs.writeFileSync(tmp, ps1.replace(/\n/g, '\r\n'));   // Windows 记事本/PS5.1 友好
    sh('scp', [...sa.slice(0, -1), tmp, `${user}@${host}:C:/netpilot/agent.ps1`]);
    fs.unlinkSync(tmp);
    sh('ssh', [...sa, 'schtasks /Create /F /TN NetPilotAgent /SC MINUTE /MO 1 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\\netpilot\\agent.ps1"']);
  } else {
    die(`未知 --for: ${for_}（linux|mac|win）`);
  }

  step(`注册到 network.yaml（${arg('yaml-kind', for_ === 'linux' && has('as-exit') ? 'exit' : 'device')}）`);
  registerYaml(id, has('as-exit') ? 'exit' : 'device', host, arg('role'), arg('probes', 'tcp:22'));

  step('等待首次上报…');
  await new Promise(r => setTimeout(r, 5000));
  await verify(id, url, arg('read-token') || token);
  console.log('[deploy] ✅ 完成');
})().catch(e => die(e.message));
