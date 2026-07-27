-- OpenMW Analytics — player-context area detector (PLAYER / local script)
--
-- Detects "meaningful area" changes and forwards them to the GLOBAL emitter.
--
-- Why a separate player script? Area is player-context: only a local script
-- attached to the player can read `self.cell`. Identity and the single per-session
-- `seq` stream live in the GLOBAL script (telemetry.lua), so we do NOT emit here --
-- we forward via the track() SDK helper (which sends OMWA_Track) and let the global
-- emit() stamp the envelope. That keeps one monotonic seq stream, not two counters.
--
-- Grain = meaningful area (see design docs/03_EVENT_REGISTRY.md):
--   exterior -> region id (cell.region) ; interior -> cell name (cell.name).
-- Unnamed exterior grid cells collapse to their region (low cardinality, high
-- signal). Cells we can't name (regionless exterior, unnamed interior) are skipped.

local self  = require('openmw.self')
local types = require('openmw.types')
-- First-party use of our own public SDK helper (dogfooding). Unguarded require:
-- track.lua always ships in this mod, so unlike a third party we don't pcall it.
-- 'base' = unmodded engine behaviour. This mod authors no content, so the events it emits
-- describe the base game, not a mod (design docs 02 mod_id).
local track = require('scripts.omwanalytics.track')('base')

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
    track('AreaEntered', { area = area, interior = interior })
end

-- ItemConsumed (design docs 03) --------------------------------------------------------------
--
-- Drinking a potion is a BASE-GAME mechanic, agnostic to which mod is watching -- exactly like
-- AreaEntered above, which is why this lives here under mod_id 'base' rather than in CCFF.
-- Scoping it to one mod would make it useless to every other mod, and would chain it to CCFF's
-- still-unverified instrumentation.
--
-- Answers 10 Q3.5 (do players reach for consumables to clear a stat gate?) and supplies the
-- behavioural half of Q3.6 (does the game contain an accessible remedy at all?).
--
-- ⚠️ WHY onConsume AND NOT the ItemUsage interface. `I.ItemUsage.addHandlerForType` is the
-- obvious seam and it is the WRONG one: per its own docs it cannot intercept actions performed
-- by mwscripts, by the AI ("drinking a potion in combat"), or from the QUICK-KEYS MENU -- which
-- is how players actually drink potions mid-dialogue. An event built on it would look entirely
-- functional while systematically missing the dominant path: fewer rows, no error, plausible
-- numbers. onConsume is an engine handler downstream of *why* the item was consumed, so it has
-- no such hole.
--
-- ⚠️ NOTE the payload carries NO effects. record_effects (design docs 11) already holds every
-- magic effect for all 34,810 game records, so what the item DOES is a join, not a field. Keeping
-- it out is grain discipline AND the telemetry x corpus synthesis 10 Q3.6 is built on.
--
-- ⚠️ recordId is documented to return LOWERCASE. 12 of 353 consumables in the corpus have
-- mixed-case ids (`ingred_Dae_cursed_emerald_01`), so the read side MUST join on
-- lower(record_id) or it will silently drop them -- they would read as "never consumed".
-- Recorded here because the hazard is created at this end and paid for at the other.
local function itemType(item)
    -- onConsume fires for anything consumable; potions and ingredients are the two that carry
    -- fortify effects. Anything else is reported honestly as 'other' rather than guessed at.
    if types.Potion.objectIsInstance(item) then return 'potion' end
    if types.Ingredient.objectIsInstance(item) then return 'ingredient' end
    return 'other'
end

return {
    engineHandlers = {
        onUpdate = function(dt)
            accum = accum + dt
            if accum < THROTTLE then return end
            accum = 0
            check()
        end,

        -- The item has already been removed from inventory and its count set to zero by the
        -- time this fires (same contract as onActivated), so read the record, never the count.
        onConsume = function(item)
            if not item then return end
            local id = item.recordId
            if not id or id == '' then return end
            track('ItemConsumed', { item_id = id, item_type = itemType(item) })
        end,
    },
}
