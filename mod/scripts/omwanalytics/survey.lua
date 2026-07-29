-- OpenMW Analytics — world placement survey (GLOBAL script, BUILD STEP — not telemetry)
--
-- Answers the question the corpus structurally cannot: WHERE items actually are. `10 Q3.6` rests
-- on the word *accessible*, and `/stats/sufficiency` emits `reachable: 'UNKNOWN'` on every row
-- precisely because nothing here existed. See `design docs/11 §13`.
--
-- ⚠️ THIS IS NOT A TELEMETRY EVENT SOURCE. It describes the WORLD, not a player's behaviour.
-- Routing it through the event pipeline would bloat `events` and pollute every sequence query --
-- exactly why `03` retired `Heartbeat`. So it prints behind its OWN sentinel:
--
--     OMWAS1 <json>        (survey)   vs   OMWA1 <json>   (telemetry)
--
-- The shipper matches the literal string 'OMWA1 ' with indexOf; 'OMWAS1 ' does not contain it
-- (the 'A' is followed by 'S', not '1'), so survey lines are INVISIBLE to it by construction
-- rather than by a filter someone has to maintain.
--
-- ⭐ WHY THIS IS A SEPARATE .omwscripts FILE. The survey must run against a CONTROLLED load order
-- (base + expansions + the measured mod, nothing else). Shipping it inside
-- `omwanalytics.omwscripts` would mean it loads during ordinary play on the author's real setup —
-- measured 2026-07-28 at **683 content files** — and a stray run would dump a contaminated survey
-- into the log. Living in its own content file means the normal profile CANNOT run it.
--
-- ⚠️ Lua cannot report an object's PROVENANCE: `recordId` carries no source file, so a survey run
-- on a modded setup silently bakes hundreds of personal mods' placements into a corpus meant to
-- describe the shared base. The resolution is NOT per-object attribution (impossible) but
-- CONSTRAINING THE UNIVERSE: `core.contentFiles.list` reports the complete set of files that could
-- have produced any object. If that set is the controlled set, every object necessarily came from
-- it. The list is emitted in the header and the INGEST REFUSES a manifest that fails the
-- allowlist -- a refusal, never a warning, because a warning over a destructive default is one
-- nobody reads twice (same rule as the multi-plugin corpus ingest).

local core   = require('openmw.core')
local world  = require('openmw.world')
local types  = require('openmw.types')
local json   = require('scripts.omwanalytics.json')

local SENTINEL = 'OMWAS1'

-- Budget per frame. The spike measured ~0.28 ms/cell for the three getAll sweeps, so 40 cells is
-- ~11 ms -- under a frame at 60fps even with container probing. Deliberately conservative: this
-- runs once, on a machine doing nothing else, and a survey that stutters is still correct while a
-- survey that trips a watchdog is not.
local CELLS_PER_FRAME = 40

-- `Container` includes harvestable FLORA (the spike's v1 probe was fooled by a mushroom), so a
-- container returning zero items is unremarkable and never treated as a signal.
local ITEM_TYPES = { types.Potion, types.Ingredient }

local started   = false
local finished  = false
local cellIndex = 1
local cells     = nil
local scanned   = 0

-- area -> { [recordId] = count }, plus a parallel exterior flag per area.
local counts    = {}
local isExt     = {}

-- ⭐ MUST match AreaEntered's convention (03): interior -> cell.name, exterior -> cell.region.
-- This is the entire payoff. Telemetry says WHERE PLAYERS FAIL, this says WHERE THE REMEDY IS,
-- and the two only join if both mean the same thing by "area". Raw cell ids would produce a table
-- that is correct and useless. Cells we cannot name are SKIPPED, exactly as player.lua skips them.
-- ⚠️ RETURNS (area, IS_EXTERIOR). Note the polarity, because it is the opposite of player.lua's:
-- `currentArea()` there returns (area, INTERIOR) and its caller reads `local area, interior = ...`.
-- The first version of this function was copied from it verbatim and the second value named
-- `exterior`, which inverted `is_exterior` on every one of 6,797 rows in the first real survey.
-- Nothing else was wrong -- areas, items and counts were all correct -- and the column is a
-- plausible-looking boolean either way, so it survived until an interior ("Vivec, Miun-Gei:
-- Enchanter") was seen flagged as exterior. Two functions with the same shape and opposite
-- polarity is a trap; the fix is to state the polarity in the name and the comment, not to
-- remember it.
local function areaOf(cell)
    if not cell then return nil end
    if cell.isExterior then
        local region = cell.region
        if region and region ~= '' then return region, true end    -- exterior -> region id
        return nil                                                 -- regionless exterior: skip
    end
    local name = cell.name
    if name and name ~= '' then return name, false end             -- interior -> cell name
    return nil                                                     -- unnamed interior: skip
end

local function tally(area, exterior, recordId, n)
    if not recordId or recordId == '' then return end
    local bucket = counts[area]
    if not bucket then
        bucket = {}
        counts[area] = bucket
        isExt[area]  = exterior
    end
    -- recordId is documented LOWERCASE here; the read side must join on lower(record_id) or the
    -- 12 mixed-case consumables silently vanish (03 ItemConsumed / 11 §13).
    bucket[recordId] = (bucket[recordId] or 0) + n
end

local function sweepCell(cell)
    local area, exterior = areaOf(cell)
    if not area then return end

    -- Loose items lying in the world.
    for _, ty in ipairs(ITEM_TYPES) do
        local ok, objs = pcall(function() return cell:getAll(ty) end)
        if ok and objs then
            for _, o in ipairs(objs) do
                tally(area, exterior, o.recordId, o.count or 1)
            end
        end
    end

    -- Items inside containers. Off-cell reads were verified to work in the spike (400 distant
    -- containers, 216 non-empty, 0 failures) -- and verified by COMPARISON, not by a single probe:
    -- distant containers came back MORE populated than the player's own cell, a result impossible
    -- if off-cell reads were degraded.
    local okC, containers = pcall(function() return cell:getAll(types.Container) end)
    if okC and containers then
        for _, c in ipairs(containers) do
            local okI, inv = pcall(function() return types.Container.inventory(c) end)
            if okI and inv then
                for _, ty in ipairs(ITEM_TYPES) do
                    local okG, items = pcall(function() return inv:getAll(ty) end)
                    if okG and items then
                        for _, it in ipairs(items) do
                            tally(area, exterior, it.recordId, it.count or 1)
                        end
                    end
                end
            end
        end
    end
end

local function emit(line)
    print(SENTINEL .. ' ' .. line)
end

-- ⚠️ `core.contentFiles.list` is ENGINE-BACKED USERDATA, not a plain Lua table.
--
-- json.lua encodes nil/boolean/number/string/table and returns 'null' for everything else, so on
-- the first real run (2026-07-28) the load order -- the ONE field the entire contamination guard
-- rests on -- serialised as `null`. Everything else about that run looked perfect: header present,
-- footer present, 2,912 cells, 6,797 rows reconciling exactly. Only the guard was empty.
--
-- It failed CLOSED (ingest refused, 0 rows written), which is the design working. But the lesson is
-- the day's own: a check is only worth what it can detect, and "the value is absent" and "I could
-- not represent this value" had been collapsed into the same output.
--
-- Copy into a real array. Returns nil (never an empty array) when the list cannot be read, so the
-- two cases stay distinguishable downstream.
local function readLoadOrder()
    local out = {}
    local ok = pcall(function()
        for _, name in ipairs(core.contentFiles.list) do
            out[#out + 1] = tostring(name)
        end
    end)
    if not ok or #out == 0 then return nil end
    return out
end

local function finish()
    finished = true

    -- HEADER FIRST, and it carries the load order. Stored even though ingest refuses a
    -- contaminated manifest, because "what world does this describe" must be answerable from the
    -- data alone rather than from whoever remembers how it was produced. It is also the STALENESS
    -- detector: the world changes when the load order does.
    local loadOrder = readLoadOrder()
    if not loadOrder then
        -- Loud, and in plain text so it is readable without the extractor. The header still goes
        -- out with a null load order so the ingest refuses explicitly rather than the manifest
        -- simply looking truncated.
        print('[OMWA survey] FATAL: could not read core.contentFiles.list -- the load order cannot '
            .. 'be recorded, so this survey CANNOT be trusted and will be refused at ingest.')
    end

    emit(json.encode({
        kind          = 'header',
        version       = 1,
        load_order    = loadOrder,
        cells_scanned = scanned,
    }))

    -- GRAIN: one row per (area, item), never per object instance. The spike projected ~200,000
    -- placements; one line each would be the retired-Heartbeat mistake at 200x scale. The GROUP BY
    -- happens HERE, in Lua, before anything is written.
    local rows = 0
    for area, bucket in pairs(counts) do
        for recordId, n in pairs(bucket) do
            emit(json.encode({
                kind        = 'placement',
                area        = area,
                is_exterior = isExt[area] and true or false,
                item_id     = recordId,
                count       = n,
            }))
            rows = rows + 1
        end
    end

    -- FOOTER LAST, carrying the row count. A truncated log (the survey is large, and OpenMW
    -- truncates on relaunch) would otherwise be indistinguishable from a completed short survey --
    -- the extractor asserts header.rows == observed, so a partial manifest CANNOT be ingested
    -- silently. Same conservation rule the corpus parser is built on: N in, N out, asserted.
    emit(json.encode({ kind = 'footer', rows = rows, cells_scanned = scanned }))
end

return {
    engineHandlers = {
        onUpdate = function()
            if finished then return end

            if not started then
                started = true
                cells = world.cells
                emit(json.encode({
                    kind  = 'begin',
                    cells = cells and #cells or 0,
                }))
            end

            if not cells then finished = true; return end

            local stop = math.min(cellIndex + CELLS_PER_FRAME - 1, #cells)
            for i = cellIndex, stop do
                local ok = pcall(sweepCell, cells[i])
                if ok then scanned = scanned + 1 end
            end
            cellIndex = stop + 1

            if cellIndex > #cells then finish() end
        end,
    },
}
