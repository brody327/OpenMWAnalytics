-- OpenMW Analytics — player-context area detector (PLAYER / local script)
--
-- Detects "meaningful area" changes and forwards them to the GLOBAL emitter.
--
-- Why a separate player script? Area is player-context: only a local script
-- attached to the player can read `self.cell`. Identity and the single per-session
-- `seq` stream live in the GLOBAL script (telemetry.lua), so we do NOT emit here --
-- we forward via core.sendGlobalEvent and let the global emit() stamp the envelope.
-- That keeps one monotonic seq stream instead of two competing counters.
--
-- Grain = meaningful area (see design docs/03_EVENT_REGISTRY.md):
--   exterior -> region id (cell.region) ; interior -> cell name (cell.name).
-- Unnamed exterior grid cells collapse to their region (low cardinality, high
-- signal). Cells we can't name (regionless exterior, unnamed interior) are skipped.

local self = require('openmw.self')
local core = require('openmw.core')

local THROTTLE = 0.25   -- s; the cell changes rarely, no need to check every frame
local accum = 0
local lastKey = nil

-- Returns (area, interior) for the player's current cell, or nil if there is no
-- meaningful area to report (caller then emits nothing).
local function currentArea()
    local cell = self.cell
    if not cell then return nil end
    if cell.isExterior then
        local region = cell.region          -- string id, may be nil/empty
        if region and region ~= '' then return region, false end
        return nil                          -- regionless exterior: not meaningful
    else
        local name = cell.name
        if name and name ~= '' then return name, true end
        return nil                          -- unnamed interior: skip
    end
end

local function check()
    local area, interior = currentArea()
    if not area then return end
    local key = (interior and 'in:' or 'ex:') .. area   -- namespace so an interior
    if key == lastKey then return end                   -- can't collide with a region
    lastKey = key
    core.sendGlobalEvent('OMWA_Emit', {
        type = 'AreaEntered',
        data = { area = area, interior = interior },
    })
end

return {
    engineHandlers = {
        onUpdate = function(dt)
            accum = accum + dt
            if accum < THROTTLE then return end
            accum = 0
            check()
        end,
    },
}
