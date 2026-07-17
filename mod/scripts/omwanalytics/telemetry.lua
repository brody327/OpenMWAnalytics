-- OpenMW Analytics — ingestion spike (GLOBAL script)
--
-- Goal of this spike: prove the ingestion channel end to end.
--   1. A global script can mint a persistent, anonymous install id.
--   2. It can emit structured, sentinel-prefixed lines to openmw.log.
--   3. An external Node "shipper" can tail the log and parse them.
--
-- This is throwaway-quality on purpose. Once verified, the real event
-- model and emit API get designed properly.

local core    = require('openmw.core')
local storage = require('openmw.storage')
local time    = require('openmw_aux.time')
local json    = require('scripts.omwanalytics.json')

local SENTINEL     = 'OMWA1'          -- version tag the shipper greps for
local SECTION_NAME = 'OMWAnalytics'   -- persistent global storage section

-- --- anonymous ids --------------------------------------------------------
-- Random v4-style UUID. math.random is seeded by the engine at startup;
-- we fold in getRealTime() for a little extra entropy. NOT cryptographic --
-- fine for an anonymous analytics id, never use for anything security-bearing.
local function uuid4()
    local template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    return (template:gsub('[xy]', function(c)
        local r = math.random(0, 15)
        if c == 'y' then r = (r % 4) + 8 end   -- RFC 4122 variant bits
        return string.format('%x', r)
    end))
end

-- installId: minted once, persisted forever (survives all saves/launches).
local section = storage.globalSection(SECTION_NAME)
local installId = section:get('installId')
if not installId then
    installId = uuid4()
    section:set('installId', installId)   -- Persistent by default -> global_storage.bin
end

-- sessionId: fresh every launch.
local sessionId = uuid4()
local seq = 0

-- --- emit -----------------------------------------------------------------
local function emit(eventType, data)
    seq = seq + 1
    print(SENTINEL .. ' ' .. json.encode({
        v          = 1,
        type       = eventType,
        seq        = seq,
        ts         = os.time() * 1000,   -- event time: epoch milliseconds (wire contract)
        install_id = installId,          -- snake_case keys to match the API/DB
        session_id = sessionId,
        data       = data or {},
    }))
end

-- Runs once each time the script context starts (new game, load, reloadlua).
emit('SpikeStarted', { note = 'ingestion spike online' })

-- Heartbeat so we can watch a live stream arrive in the shipper.
time.runRepeatedly(function() emit('Heartbeat', {}) end, 5 * time.second)

-- Receive events forwarded from local/player scripts (e.g. AreaEntered from
-- scripts/omwanalytics/player.lua) and emit them on the single global seq stream.
-- Detection lives player-side; identity + ordering live here.
return {
    eventHandlers = {
        OMWA_Emit = function(e)
            if type(e) ~= 'table' or type(e.type) ~= 'string' then return end
            emit(e.type, e.data or {})
        end,
    },
}
