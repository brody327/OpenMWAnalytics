-- OpenMW Analytics — telemetry emitter (GLOBAL script)
--
-- The one place an event becomes a wire line. Responsibilities:
--   1. mint + persist the anonymous install id; mint a per-launch session id;
--   2. own the single monotonic `seq` stream shared by every event source;
--   3. validate at the trust boundary (see OMWA_Track below);
--   4. print sentinel-prefixed JSON to openmw.log for the shipper to tail.
--
-- The Lua sandbox has no network and no filesystem write, so emitting to the log
-- IS the egress mechanism (design docs 01 / 02).

local storage = require('openmw.storage')
local json    = require('scripts.omwanalytics.json')

local SENTINEL     = 'OMWA1'          -- version tag the shipper greps for
local SECTION_NAME = 'OMWAnalytics'   -- persistent global storage section

-- --- anonymous ids --------------------------------------------------------
-- Random v4-style UUID, seeded by the engine's startup seeding of math.random.
-- NOT cryptographic -- fine for an anonymous analytics id, never use for
-- anything security-bearing.
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

-- NOTE: no events fire at context start. The `SpikeStarted` + 5s `Heartbeat`
-- placeholders were REMOVED 2026-07-20: they answered no product question (design
-- doc 10's rule) and actively corrupted sequence analysis -- a heartbeat every 5s
-- meant the row following almost any real event was a heartbeat, so LEAD() over the
-- stream reported idling instead of behaviour (07 §4). Platform liveness is /health's
-- job, not the product event log's. If true session *duration* is ever needed, that
-- is a deliberate coarse SessionPinged justified by a doc-10 question, not a 5s ping.

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

-- mod_id: which mod's CONTENT the event is about (design docs 02). Self-declared by the
-- caller and NOT verifiable -- OpenMW's sandbox has no `debug` library, so we cannot
-- introspect who called us, and the log line is always attributed to this script. So we
-- validate the FORMAT and nothing more.
--
-- A malformed id is normalised to 'unknown' rather than dropping the event: the id is
-- metadata, and losing real telemetry over a bad label is the worse failure. Same posture
-- as the API's env fallback.
local MOD_ID_PATTERN = '^[a-z0-9][a-z0-9._%-]*$'
local MAX_MOD_ID_LEN = 64

local function normalizeModId(raw)
    if type(raw) ~= 'string' then return 'unknown' end
    local id = raw:lower()
    if #id == 0 or #id > MAX_MOD_ID_LEN then return 'unknown' end
    if not id:match(MOD_ID_PATTERN) then return 'unknown' end
    return id
end

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
            emit(e.type, e.data or {}, normalizeModId(e.mod_id))
        end,
    },
}
