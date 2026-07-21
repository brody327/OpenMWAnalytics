<#
.SYNOPSIS
    Start the OpenMW Analytics shipper against the cloud API (or a local one).

.DESCRIPTION
    Wraps `node ship.mjs` so "start the shipper" is one command instead of three
    environment variables you have to remember correctly.

    WHY THIS EXISTS: the shipper silently defaults to http://localhost:4000/events when
    OMWA_API is unset. Forget it in a fresh terminal and your play session ships to the
    LOCAL database while the public dashboard sits empty -- and nothing errors, so you
    only find out much later. This script makes the destination explicit and loud, and
    refuses to start against the cloud without a token rather than failing 401 per batch.

    The token is read from shipper/.env (gitignored), or from -Token, or from the
    OMWA_INGEST_TOKEN environment variable. It is never stored in this file.

.PARAMETER Local
    Ship to http://localhost:4000/events instead of the cloud. No token needed unless
    the local API has one configured.

.PARAMETER Token
    Ingest token. Overrides shipper/.env and the environment.

.PARAMETER LogPath
    Path to openmw.log. Defaults to the shipper's own default.

.PARAMETER Quiet
    Suppress the banner. Used by the scheduled task, where nothing reads stdout.

.PARAMETER Env
    Ingest provenance: 'dev' (you exercising paths) or 'prod' (a real play session).
    Defaults to 'prod'. Use -Env dev when generating test data, so authoring traffic never
    gets counted as player behaviour.

.EXAMPLE
    .\start-shipper.ps1
    Ship to the cloud using the token from shipper/.env.

.EXAMPLE
    .\start-shipper.ps1 -Local
    Ship to a local dev API.
#>
[CmdletBinding()]
param(
    [switch]$Local,
    [string]$Token,
    [string]$LogPath,
    [switch]$Quiet,
    [ValidateSet('dev', 'prod')]
    [string]$Env = $(if ($env:OMWA_ENV) { $env:OMWA_ENV } else { 'prod' })
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

$CloudApi = 'https://api.omwanalytics.com/events'
$LocalApi = 'http://localhost:4000/events'
$target = if ($Local) { $LocalApi } else { $CloudApi }

# --- read shipper/.env: token + env ------------------------------------------
# BOTH must come from the file, not just the token: the Scheduled Task runs with a bare
# environment, so anything sourced only from $env:* silently falls back to its default at
# every logon. That would have quietly stamped the author's own sessions as 'prod'.
$fileToken = $null
$fileEnv = $null
$envFile = Join-Path $here '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*OMWA_INGEST_TOKEN\s*=\s*(.+?)\s*$') {
            $fileToken = $Matches[1].Trim('"').Trim("'")   # strip quotes if present
        }
        elseif ($line -match '^\s*OMWA_ENV\s*=\s*(.+?)\s*$') {
            $fileEnv = $Matches[1].Trim('"').Trim("'").ToLower()
        }
    }
}

# Precedence: explicit parameter > .env file > process environment > default.
if (-not $Token) { $Token = $fileToken }
if (-not $Token) { $Token = $env:OMWA_INGEST_TOKEN }
if (-not $PSBoundParameters.ContainsKey('Env') -and $fileEnv) {
    if ($fileEnv -notin @('dev', 'prod')) { throw "OMWA_ENV in $envFile must be 'dev' or 'prod', got '$fileEnv'" }
    $Env = $fileEnv
}

# Fail fast rather than let every batch 401 in a retry loop. The shipper holds its
# offset on failure so nothing would be lost -- but a wall of 401s is a worse way to
# learn about a missing token than one line here.
if (-not $Local -and -not $Token) {
    Write-Host ''
    Write-Host 'No ingest token found. The cloud API will reject every batch.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Fix it with ONE of:' -ForegroundColor Yellow
    Write-Host "  1. Create $here\.env containing:   OMWA_INGEST_TOKEN=<token>"
    Write-Host '     (shipper/.env is gitignored - safe for secrets)'
    Write-Host '  2. Pass it directly:               .\start-shipper.ps1 -Token <token>'
    Write-Host ''
    Write-Host 'Read the current value from the cluster with:' -ForegroundColor DarkGray
    Write-Host "  kubectl get secret omwa-api-secrets -o jsonpath='{.data.OMWA_INGEST_TOKEN}' | base64 -d" -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

# --- announce the destination LOUDLY ----------------------------------------
# Shipping to the wrong place is this tool's most likely and least visible failure.
$label = if ($Local) { 'LOCAL' } else { 'CLOUD' }
if ($Quiet) {
    # Unattended (scheduled task): one timestamped line so the log shows restarts.
    Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] start-shipper -> $label $target (env=$Env)"
}
else {
    $colour = if ($Local) { 'Yellow' } else { 'Cyan' }
    Write-Host ''
    Write-Host "  shipping to $label -> $target" -ForegroundColor $colour
    # Loud when marking data as authoring traffic -- mislabelling in either direction
    # quietly corrupts the analysis, so the state is always on screen.
    if ($Env -eq 'dev') {
        Write-Host "  env         DEV - recorded as authoring data, excluded from player metrics" -ForegroundColor Yellow
    }
    else {
        Write-Host "  env         prod (real play session)" -ForegroundColor DarkGray
    }
    if ($Token) {
        # Show only enough to tell two tokens apart. Never print the whole thing.
        $hint = if ($Token.Length -gt 8) { $Token.Substring(0, 4) + '...' + $Token.Substring($Token.Length - 4) } else { '(short)' }
        Write-Host "  token       $hint" -ForegroundColor DarkGray
    }
    Write-Host '  Ctrl+C to stop. Leave this running while you play.' -ForegroundColor DarkGray
    Write-Host ''
}

# --- run --------------------------------------------------------------------
$env:OMWA_API = $target
$env:OMWA_ENV = $Env
if ($Token) { $env:OMWA_INGEST_TOKEN = $Token }

Push-Location $here
try {
    if ($LogPath) { node ship.mjs $LogPath } else { node ship.mjs }
}
finally {
    Pop-Location
}
