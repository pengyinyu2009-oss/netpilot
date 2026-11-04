# NetPilot agent (Windows)：CPU/内存/温度 上报 collector
# schtask 每 1 分钟执行；配置由安装时替换占位符
$Id     = "__AGENT_ID__"
$Url    = "__COLLECTOR__"
$Token  = "__TOKEN__"

$ErrorActionPreference = 'SilentlyContinue'
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os  = Get-CimInstance Win32_OperatingSystem
$memPct = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
$temp = $null
try {
  $t = (Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue |
        Measure-Object -Property CurrentTemperature -Maximum).Maximum
  if ($t) { $temp = [math]::Round($t / 10.0 - 273.15, 1) }
} catch {}

$body = @{ id = $Id; metrics = @{ cpu = $cpu; memPct = $memPct; temp = $temp } } | ConvertTo-Json
try {
  Invoke-RestMethod -Uri "$Url/api/agent/report" -Method Post -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $Token" } -Body $body -TimeoutSec 8 | Out-Null
} catch {}
