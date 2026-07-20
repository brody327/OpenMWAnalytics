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
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

$CloudApi = 'https://api.omwanalytics.com/events'
$LocalApi = 'http://localhost:4000/events'
$target = if ($Local) { $LocalApi } else { $CloudApi }

# --- resolve the token: -Token > shipper/.env > environment ------------------
if (-not $Token) {
    $envFile = Join-Path $here '.env'
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match '^\s*OMWA_INGEST_TOKEN\s*=\s*(.+?)\s*$') {
                # Strip surrounding quotes if present.
                $Token = $Matches[1].Trim('"').Trim("'")
            }
        }
    }
}
if (-not $Token) { $Token = $env:OMWA_INGEST_TOKEN }

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
$colour = if ($Local) { 'Yellow' } else { 'Cyan' }
$label = if ($Local) { 'LOCAL' } else { 'CLOUD' }
Write-Host ''
Write-Host "  shipping to $label -> $target" -ForegroundColor $colour
if ($Token) {
    # Show only enough to tell two tokens apart. Never print the whole thing.
    $hint = if ($Token.Length -gt 8) { $Token.Substring(0, 4) + '...' + $Token.Substring($Token.Length - 4) } else { '(short)' }
    Write-Host "  token       $hint" -ForegroundColor DarkGray
}
Write-Host '  Ctrl+C to stop. Leave this running while you play.' -ForegroundColor DarkGray
Write-Host ''

# --- run --------------------------------------------------------------------
$env:OMWA_API = $target
if ($Token) { $env:OMWA_INGEST_TOKEN = $Token }

Push-Location $here
try {
    if ($LogPath) { node ship.mjs $LogPath } else { node ship.mjs }
}
finally {
    Pop-Location
}
