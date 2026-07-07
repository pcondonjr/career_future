<#
  scripts/dashboard-watchdog.ps1

  Checks whether neon-dashboard-server.cjs (localhost:3002) is listening.
  If not, starts it. Registered as a scheduled task that fires at logon and
  repeats every 24 hours (see: schtasks /query /tn "CF-DashboardWatchdog").

  Run manually to test: powershell -ExecutionPolicy Bypass -File scripts\dashboard-watchdog.ps1
#>

$ErrorActionPreference = 'Stop'

$Port        = 3002
$ProjectDir  = "C:\Users\pcond\vs-code-projects\career-future"
$LogDir      = Join-Path $ProjectDir "logs"
$WatchdogLog = Join-Path $LogDir "watchdog.log"
$OutLog      = Join-Path $LogDir "neon-dashboard.log"
$ErrLog      = Join-Path $LogDir "neon-dashboard-err.log"

function Write-WatchdogLog($message) {
    $line = "$(Get-Date -Format o) - $message"
    Add-Content -Path $WatchdogLog -Value $line
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if ($listening) {
    $currentPid = $listening[0].OwningProcess
    Write-WatchdogLog "OK - port $Port already listening (PID $currentPid)."
} else {
    Write-WatchdogLog "Port $Port not listening - starting neon-dashboard-server.cjs."
    Start-Process -FilePath "node" `
        -ArgumentList "neon-dashboard-server.cjs" `
        -WorkingDirectory $ProjectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog
    Start-Sleep -Seconds 3
    $recheck = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($recheck) {
        $newPid = $recheck[0].OwningProcess
        Write-WatchdogLog "Restart succeeded - port $Port now listening (PID $newPid)."
    } else {
        Write-WatchdogLog "Restart attempted but port $Port still not listening - check $ErrLog."
    }
}
