-- Minimal JSON encoder for the analytics event subset:
-- nil, boolean, number, string, and tables (array or object).
-- The OpenMW Lua sandbox ships no JSON library, so we provide our own.
-- Kept deliberately small; it only needs to encode data we control.

local function escape(s)
    return (s:gsub('[%z\1-\31\\"]', function(c)
        local map = {
            ['"'] = '\\"', ['\\'] = '\\\\',
            ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
        }
        return map[c] or string.format('\\u%04x', string.byte(c))
    end))
end

local function isArray(t)
    local n = 0
    for _ in pairs(t) do n = n + 1 end
    return n == #t
end

local encode
encode = function(v)
    local t = type(v)
    if v == nil then
        return 'null'
    elseif t == 'boolean' then
        return tostring(v)
    elseif t == 'number' then
        -- NaN/inf are not valid JSON; emit null rather than a broken token.
        if v ~= v or v == math.huge or v == -math.huge then return 'null' end
        return string.format('%.14g', v)
    elseif t == 'string' then
        return '"' .. escape(v) .. '"'
    elseif t == 'table' then
        -- Empty tables are ambiguous in Lua; treat as an object ({}),
        -- since our event payloads are objects far more often than arrays.
        if next(v) == nil then return '{}' end
        local parts = {}
        if isArray(v) then
            for i = 1, #v do parts[i] = encode(v[i]) end
            return '[' .. table.concat(parts, ',') .. ']'
        else
            for k, val in pairs(v) do
                parts[#parts + 1] = '"' .. escape(tostring(k)) .. '":' .. encode(val)
            end
            return '{' .. table.concat(parts, ',') .. '}'
        end
    end
    return 'null'
end

return { encode = encode }
