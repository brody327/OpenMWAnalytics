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

-- --- public ingress: OMWA_Track -------------------------------------------
-- The single validated entry point for every event forwarded from a local/player
-- script -- our own (AreaEntered) AND any third party's (via the require-able
-- scripts/omwanalytics/track.lua helper). Detection lives caller-side; identity +
-- the one monotonic seq stream live here.
--
-- This is the TRUST BOUNDARY. The track.lua helper runs in the caller's untrusted
-- context, so we re-validate here and cannot rely on it: type must be a non-empty
-- string, data must be a JSON-encodable table within key/size caps. Anything that
-- fails is DROPPED (seq is not consumed) with a one-line warning -- a runaway or
-- malicious mod cannot bloat the stream or desync the seq counter.
local MAX_DATA_KEYS  = 32
local MAX_DATA_BYTES = 2048   -- serialized json.encode(data) byte cap

local function countKeys(t)
    local n = 0
    for _ in pairs(t) do n = n + 1 end
    return n
end

-- Returns ok:boolean, reason:string|nil. reason is set only when ok == false.
local function validateTrack(e)
    if type(e) ~= 'table' then return false, 'event is not a table' end
    if type(e.type) ~= 'string' or e.type == '' then return false, 'type must be a non-empty string' end
    local data = e.data
    if data == nil then return true end                       -- empty data is fine
    if type(data) ~= 'table' then return false, 'data must be a table' end
    if countKeys(data) > MAX_DATA_KEYS then
        return false, 'data exceeds ' .. MAX_DATA_KEYS .. ' keys'
    end
    local ok, encoded = pcall(json.encode, data)
    if not ok then return false, 'data is not JSON-encodable' end
    if #encoded > MAX_DATA_BYTES then
        return false, 'data exceeds ' .. MAX_DATA_BYTES .. ' bytes'
    end
    return true
end

return {
    eventHandlers = {
        OMWA_Track = function(e)
            local ok, reason = validateTrack(e)
            if not ok then
                -- Not an OMWA1 event line -- a plain operator warning, ignored by the shipper.
                print('[OMWAnalytics] dropped invalid OMWA_Track event: ' .. tostring(reason)
                    .. ' (type=' .. tostring(type(e) == 'table' and e.type or e) .. ')')
                return
            end
            emit(e.type, e.data or {})
        end,
    },
}
