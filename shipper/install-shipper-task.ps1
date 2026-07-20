<#
.SYNOPSIS
    Register (or remove) a Windows Scheduled Task that keeps the shipper running.

.DESCRIPTION
    Starting the shipper by hand before every play session is easy to forget, and
    forgetting it loses that session's telemetry silently -- openmw.log is truncated on the
    next launch, so unshipped events are gone rather than merely delayed. This registers a
    logon task so collection is always on.

    Running it permanently is cheap: the shipper polls one file once a second and does
    nothing when OpenMW is not running.

    THE TASK RUNS HIDDEN, so its output is redirected to shipper/shipper.log. A background
    process with no visible output is exactly the kind of silent failure this project keeps
    tripping over -- check the log (or -Status) rather than assuming it is alive.

    Registering a task for the current user does not require elevation.

.PARAMETER Local
    Register the task to ship to a local API instead of the cloud.

.PARAMETER Uninstall
    Remove the task.

.PARAMETER Status
    Show whether the task exists, its state, and the tail of shipper.log.

.EXAMPLE
    .\install-shipper-task.ps1
    Install the logon task (cloud).

.EXAMPLE
    .\install-shipper-task.ps1 -Status
    Check it is alive and see recent activity.
#>
[CmdletBinding()]
param(
    [switch]$Local,
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$TaskName = 'OpenMW Analytics Shipper'
$logFile = Join-Path $here 'shipper.log'
$launcher = Join-Path $here 'start-shipper.ps1'

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

# --- status -----------------------------------------------------------------
if ($Status) {
    $task = Get-Task
    if (-not $task) {
        Write-Host "Task '$TaskName' is NOT installed." -ForegroundColor Yellow
        Write-Host "Install it with:  .\install-shipper-task.ps1"
        exit 0
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host ""
    Write-Host "Task    : $TaskName"
    Write-Host "State   : $($task.State)"
    Write-Host "Last run: $($info.LastRunTime)  (result $($info.LastTaskResult))"
    Write-Host "Next run: $($info.NextRunTime)"
    # A running shipper does NOT prove events are landing -- the API could be rejecting
    # them. The log is what shows delivery.
    if (Test-Path $logFile) {
        Write-Host ""
        Write-Host "--- tail of shipper.log ---" -ForegroundColor DarkGray
        Get-Content $logFile -Tail 12
    }
    else {
        Write-Host ""
        Write-Host "No shipper.log yet - the task has not produced output." -ForegroundColor Yellow
    }
    exit 0
}

# --- uninstall --------------------------------------------------------------
if ($Uninstall) {
    if (Get-Task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed task '$TaskName'." -ForegroundColor Green
    }
    else {
        Write-Host "Task '$TaskName' was not installed." -ForegroundColor Yellow
    }
    exit 0
}

# --- preflight --------------------------------------------------------------
if (-not (Test-Path $launcher)) { throw "Cannot find $launcher" }

# Fail now rather than at every logon: without a token the launcher exits 1 immediately and
# the task would look "installed" while collecting nothing.
if (-not $Local) {
    $envFile = Join-Path $here '.env'
    $hasToken = $false
    if (Test-Path $envFile) {
        $hasToken = (Get-Content $envFile | Where-Object { $_ -match '^\s*OMWA_INGEST_TOKEN\s*=\s*\S' }).Count -gt 0
    }
    if (-not $hasToken -and -not $env:OMWA_INGEST_TOKEN) {
        Write-Host ""
        Write-Host "No ingest token found - the task would start and immediately exit." -ForegroundColor Red
        Write-Host "Create $envFile containing:  OMWA_INGEST_TOKEN=<token>"
        Write-Host "(copy shipper/.env.example, it is gitignored)"
        Write-Host ""
        exit 1
    }
}

# --- register ---------------------------------------------------------------
$targetArg = if ($Local) { ' -Local' } else { '' }
# -Command (not -File) so stdout/stderr can be redirected into the log; *>> captures every
# stream and APPENDS, so restart history survives.
$inner = "& '$launcher'$targetArg -Quiet *>> '$logFile'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$inner`"" `
    -WorkingDirectory $here

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# ExecutionTimeLimit 0 = never kill it (default is 3 days). RestartCount/Interval bring it
# back if node dies. IgnoreNew stops a second copy racing the first for the same offset file.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

if (Get-Task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Replacing existing task..." -ForegroundColor DarkGray
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Tails openmw.log and ships OMWA telemetry events to the analytics API.' | Out-Null

Write-Host ""
Write-Host "Installed '$TaskName'." -ForegroundColor Green
Write-Host "  target : $(if ($Local) { 'LOCAL' } else { 'CLOUD' })"
Write-Host "  runs   : at logon, restarts up to 3x on failure"
Write-Host "  log    : $logFile"
Write-Host ""
Write-Host "Start it now without logging out:" -ForegroundColor DarkGray
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check it:" -ForegroundColor DarkGray
Write-Host "  .\install-shipper-task.ps1 -Status"
Write-Host "Remove it:" -ForegroundColor DarkGray
Write-Host "  .\install-shipper-task.ps1 -Uninstall"
Write-Host ""
