# Ingestion Spike

Purpose: prove telemetry can leave OpenMW end to end, given the Lua sandbox
has **no network and no filesystem-write** access.

Path proven:

    Lua global script  --print()-->  openmw.log  --tail-->  Node shipper  --> (would POST)

## Files

- `scripts/omwanalytics/telemetry.lua` — GLOBAL script. Mints an anonymous
  persistent `installId` + per-launch `sessionId`, then emits `OMWA1`-prefixed
  JSON lines (a `SpikeStarted` event, then a `Heartbeat` every 5s).
- `scripts/omwanalytics/json.lua` — minimal JSON encoder (sandbox has none).
- `omwanalytics.omwscripts` — registers the global script.
- `shipper/tail-spike.mjs` — Node log tailer; extracts + parses our lines.

## Run

1. Enable the mod (either via the OpenMW Launcher → Data Files, or add these
   two lines to `C:\Documents\My Games\OpenMW\openmw.cfg`):

       data="C:\Documents\My Games\OpenMW\data\dev-mods\OpenMWAnalytics"
       content=omwanalytics.omwscripts

   (`content=` must appear after the `data=` entries.)

2. Start the shipper in a terminal:

       node "C:\Documents\My Games\OpenMW\data\dev-mods\OpenMWAnalytics\shipper\tail-spike.mjs"

3. Launch OpenMW and load/start any game.

## Expected

The shipper prints one `SpikeStarted` line, then a `Heartbeat` every ~5s, e.g.:

    [shipper] would POST: {"v":1,"type":"SpikeStarted","seq":1,...,"installId":"<uuid>","sessionId":"<uuid>",...}
    [shipper] would POST: {"v":1,"type":"Heartbeat","seq":2,...}

Relaunch the game and confirm: `installId` stays the same (persistent),
`sessionId` changes (fresh per launch), and the shipper logs
"truncation detected" when openmw.log is overwritten.

## Cleanup

Throwaway code. Once verified, remove the heartbeat and design the real
event model + emit API.
