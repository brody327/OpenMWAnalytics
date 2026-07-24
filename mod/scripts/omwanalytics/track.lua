-- OpenMW Analytics — public tracking helper (the SDK surface).
--
--   local track = require('scripts.omwanalytics.track')('ccff')   -- declare your mod ONCE
--   track('ConfrontationAttempted', { suspect = id, passed = false })
--
-- ⚠️ BREAKING CHANGE (2026-07-23): this module is now a FACTORY. It takes your mod id and
-- returns the tracker. Previously it *was* the tracker.
--
-- WHY the id is bound once at require() instead of passed per call: a per-call id has to be
-- repeated at every call site (CCFF has eight), and one missed argument silently mislabels a
-- slice of your data -- the kind of bug that surfaces months later as a chart that is quietly
-- wrong. Declared once, forgetting it is a load-time error instead.
--
-- WHY this is a hard break rather than an overload: a backward-compatible
-- `track('ccff')` / `track('MyEvent', data)` dual form is genuinely AMBIGUOUS -- both are a
-- single string argument, and nothing distinguishes a mod id from an event name. An API where
-- two meanings share one signature cannot be made unambiguous by documentation, so a clean
-- break is the honest option.
--
-- WHY your mod must declare an id at all: it cannot be derived. OpenMW's Lua sandbox exposes
-- only coroutine/math/string/table/os -- there is no `debug` library, so we cannot introspect
-- the caller -- and every event funnels through one global script, so the openmw.log line is
-- always attributed to telemetry.lua regardless of origin. Declaration is the only mechanism.
--
-- CHOOSING AN ID: lowercase, `[a-z0-9._-]`, <=64 chars; convention is your content file's
-- basename ('ccff'). It names the CONTENT DOMAIN the events are about, not the code emitting
-- them -- which is why engine-level events about unmodded Morrowind use 'base'. It is NOT
-- authenticated; the platform records what you claim.
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
--     do
--         local ok, m = pcall(require, 'scripts.omwanalytics.track')
--         if ok then track = m('ccff') end
--     end
--     if track then track('MyEvent', { ... }) end
-- The event contract (types + data shapes) is governed by design docs/03_EVENT_REGISTRY.

local core = require('openmw.core')

-- Factory: takes your mod id, returns the tracker bound to it.
--
-- Fails LOUDLY (error) on a missing/empty id, unlike everything else in this file, which
-- degrades quietly. That asymmetry is deliberate: a bad id is a mistake made once, at load,
-- by the mod author who can fix it immediately -- so a hard error is cheap and unmissable.
-- A bad *event*, by contrast, happens at runtime in a player's game, where crashing someone's
-- session over telemetry would be indefensible.
return function(modId)
    if type(modId) ~= 'string' or modId == '' then
        error('omwanalytics/track: a mod id is required -- '
            .. "require('scripts.omwanalytics.track')('your_mod_id')", 2)
    end

    -- Returns true if the event was handed off to the emitter, false if the caller
    -- passed something obviously wrong (empty/non-string type). A false here is a
    -- programming error in the caller, distinct from the emitter later dropping a
    -- structurally-valid-but-oversized payload.
    return function(eventType, data)
        if type(eventType) ~= 'string' or eventType == '' then return false end
        core.sendGlobalEvent('OMWA_Track', {
            type   = eventType,
            data   = data or {},
            mod_id = modId,
        })
        return true
    end
end
