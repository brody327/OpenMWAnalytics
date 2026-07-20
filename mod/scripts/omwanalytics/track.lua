-- OpenMW Analytics — public tracking helper (the SDK surface).
--
--   local track = require('scripts.omwanalytics.track')
--   track('ConfrontationAttempted', { suspect = id, passed = false })
--
-- require() this from any GLOBAL / LOCAL / PLAYER / MENU script and call
-- track(type, data) to report a gameplay event to the analytics platform. It wraps
-- the OMWA_Track global event so callers never hand-write the wire envelope or the
-- event name.
--
-- WHY an event (not an openmw interface): interfaces are shared only *within* one
-- script context (global<->global, player<->player). Telemetry is collected by a
-- GLOBAL script, but instrumentation usually lives in local/player scripts, so
-- crossing that boundary requires sendGlobalEvent. This helper is that one line.
--
-- GLOBAL callers work too (CCFF's evidence_bridge.lua is one): core.sendGlobalEvent
-- is available in global scripts -- it is restricted only in LOAD scripts, and in
-- menu scripts while the game is not running (see openmw.menu#menu.getState). The
-- global->global hop still lands in telemetry.lua's OMWA_Track handler unchanged.
--
-- TRUST: this code runs in the *caller's* context, which the platform does not
-- trust. The client-side check below is a DX nicety only — the GLOBAL emitter
-- (telemetry.lua) RE-VALIDATES every event (type/shape + key & size caps) and drops
-- anything that fails. Never rely on this helper for enforcement.
--
-- GRACEFUL DEGRADATION: a third party should guard the require itself, because
-- require() of an absent module errors when the analytics mod is not installed:
--     local track
--     do local ok, m = pcall(require, 'scripts.omwanalytics.track'); if ok then track = m end end
--     if track then track('MyEvent', { ... }) end
-- The event contract (types + data shapes) is governed by design docs/03_EVENT_REGISTRY.

local core = require('openmw.core')

-- Returns true if the event was handed off to the emitter, false if the caller
-- passed something obviously wrong (empty/non-string type). A false here is a
-- programming error in the caller, distinct from the emitter later dropping a
-- structurally-valid-but-oversized payload.
return function(eventType, data)
    if type(eventType) ~= 'string' or eventType == '' then return false end
    core.sendGlobalEvent('OMWA_Track', { type = eventType, data = data or {} })
    return true
end
