// Parser for `esmtool dump -p` output (design docs 11 §8).
//
// ⚠️ WHY THIS IS A NAMED, TESTED COMPONENT AND NOT A REGEX IN A SCRIPT: esmtool has NO
// structured output mode -- no JSON, no CSV (`--help` offers dump/clone/comp, --raw, --type,
// --plain, --quiet and nothing else). We are parsing a HUMAN-READABLE DEBUG DUMP, which is an
// interface nobody promised to keep stable. An OpenMW release that reformats one line breaks
// ingest SILENTLY: records simply stop matching and the corpus quietly shrinks. The fixture in
// parseEsmDump.test.ts is the tripwire -- it fails loudly on a format change, which is the only
// reason this is safe to depend on.
//
// Pure: string in, records out. No file I/O and no database, so the whole format contract is
// testable against a 40-line fixture instead of a 31 MB dump.
//
// FORMAT NOTES, all verified against Morrowind.esm on 2026-07-26 (not assumed):
//
//   Record: ALCH "potion_skooma_01"        <- record header; the quoted id is the natural key
//     Name: Skooma
//     Effect[0]: Fortify Attribute (79)    <- INDEXED effect, sub-fields nested at 4 spaces
//       Attribute: Speed (4)
//       Range: Self (0)
//       Duration: 60
//       Magnitude: 20-20
//
//   Record: INGR "ingred_dreugh_wax_01"
//     Effect: Fortify Attribute (79)       <- ⚠️ DIFFERENT SHAPE: no index, no Range/Duration/
//     Skill: Invalid (-1)                     Magnitude, and sub-fields sit at the SAME indent
//     Attribute: Strength (0)                 as the effect line. A parser keyed on indentation
//                                             mis-attributes these to the record.
//   Record: DIAL "A1_6_AddhiranirrInformant"
//   Record: INFO "30643123741319511643"    <- ⚠️ id is a meaningless hash. The topic lives in
//     Text: I'm told that Addhiranirr...      the PRECEDING DIAL, so DIAL is carried as state.
//
//   Record: BOOK "BookSkill_Enchant1"
//     Text:                                <- ⚠️ block form, unlike INFO's inline `Text: ...`
//   START--------------------------------------
//   <DIV ALIGN="CENTER">...<BR>            <- Morrowind's HTML-ish markup
//   END----------------------------------------

export type AffectedKind = 'skill' | 'attribute';

export interface ParsedEffect {
  ordinal: number;
  effectId: number;
  effectName: string;          // 'Fortify Attribute' | 'Drain Attribute' | 'Fortify Skill' | ...
  affected: string | null;     // lower-cased 'personality' | 'speechcraft' | ...
  affectedKind: AffectedKind | null;
  magnitudeMin: number | null;
  magnitudeMax: number | null;
  duration: number | null;
  range: string | null;
}

export interface ParsedRecord {
  recordId: string;
  type: string;                // ALCH | SPEL | ENCH | INGR | INFO | BOOK | CELL | NPC_ | ...
  name: string | null;
  fullText: string;
  effects: ParsedEffect[];
}

export interface ParseResult {
  records: ParsedRecord[];
  /** Records parsed but DROPPED for having no name and no prose. Surfaced, never silent:
   *  a number that jumps after an OpenMW upgrade is the format-drift alarm. */
  skippedEmpty: number;
}

// ⚠️ THE QUOTED ID IS OPTIONAL, and getting this wrong is the worst bug this parser can have.
// 5,286 of Morrowind.esm's 48,295 record headers print as bare `Record: SKIL ` with NO id:
// SKIL (27), MGEF (137), CELL (2,538), LAND (1,390), PGRD (1,194).
//
// An earlier version required the id. A non-matching header does not start a new record, so
// every field that followed was silently attributed to the PREVIOUS record -- 5,286 records
// worth of cross-contamination, with no error and plausible-looking output. It was caught only
// because emitted + skipped + DIAL did not add up to the header count. **Reconciling a total is
// what surfaced it; no individual record looked wrong.**
const RECORD_RE = /^Record: (\S+?)\s*(?:"(.*)")?\s*$/;
// Identity for the id-less types that still have one: `ID: Block (0)` / `Index: Water Breathing (0)`.
// The numeric index is the stable key -- display names are localized, the enum ordinal is not.
const IDENTITY_RE = /^\s+(?:ID|Index): (.+?) \((-?\d+)\)\s*$/;
// SKIL and MGEF carry real prose here. This is what makes them worth indexing at all: 137 magic
// effects and 27 skills, each explaining what it does -- directly relevant to a tool whose
// flagship question is "what content could serve this check".
const DESCRIPTION_RE = /^\s+Description: (.+)$/;
// Matches BOTH effect shapes. The optional [N] is exactly the ALCH-vs-INGR difference; the
// ordinal is re-derived from position anyway, so a missing index costs nothing.
const EFFECT_RE = /^\s+Effect(?:\[(\d+)\])?: (.+?) \((-?\d+)\)\s*$/;
const TARGET_RE = /^\s+(Skill|Attribute): (.+?) \((-?\d+)\)\s*$/;
const RANGE_RE = /^\s+Range: (.+?) \((-?\d+)\)\s*$/;
const DURATION_RE = /^\s+Duration: (-?\d+)\s*$/;
const MAGNITUDE_RE = /^\s+Magnitude: (-?\d+)-(-?\d+)\s*$/;
const NAME_RE = /^\s+Name: (.*)$/;
const INLINE_TEXT_RE = /^\s+Text: (.+)$/;
const BLOCK_TEXT_RE = /^\s+Text:\s*$/;
const BLOCK_START_RE = /^START-+\s*$/;
const BLOCK_END_RE = /^END-+\s*$/;

/**
 * Strip Morrowind's book markup down to plain text, PRESERVING paragraph structure -- because
 * the paragraph is the chunk boundary (11 §4), so destroying it here would force chunking to
 * guess. <BR> becomes a line break; block tags become a paragraph break; everything else goes.
 * Case-insensitive: the corpus contains both <BR> (15,938) and <br> (83).
 */
export function stripBookMarkup(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:div|p)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')      // FONT, IMG, B, and any stray tag
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseEsmDump(dump: string): ParseResult {
  const records: ParsedRecord[] = [];
  let skippedEmpty = 0;

  // --- parser state ---
  let current: ParsedRecord | null = null;
  let currentEffect: ParsedEffect | null = null;
  // The parent DIAL for any INFO that follows. Load-bearing: an INFO's own id is a numeric
  // hash, so without this every dialogue result in the UI reads '30643123741319511643'.
  let currentDial: string | null = null;
  let inTextBlock = false;
  let blockLines: string[] = [];
  let pendingBlock = false;   // saw `Text:` with no value; the START line should be next

  const flush = () => {
    if (!current) return;
    // DIAL is a CONTAINER, not content: it carries a StringId and a Type and nothing else --
    // its text lives entirely in the INFO records that follow it. We consume it for the
    // parent-topic state above and never emit it, so `skippedEmpty` stays a genuine anomaly
    // counter rather than a mix of "structural" and "something is wrong".
    if (current.type === 'DIAL') {
      current = null;
      currentEffect = null;
      return;
    }
    // Id-less records that carry a name are still real content -- notably the 1,240 named CELLs,
    // which are the join target for AreaEntered.area (11 §3). Synthesize a stable key from the
    // name; LAND and PGRD have neither name nor prose and fall through to skippedEmpty.
    if (!current.recordId && current.name) {
      current.recordId = `${current.type}:${current.name}`;
    }
    // ⚠️ HAVING EFFECTS IS ENOUGH TO BE CONTENT. ENCH records carry no Name: and no prose --
    // only Type/Cost/Charge and their effects -- so an "empty" test of (name || text) dropped
    // all 708 of them along with 1,069 effects, which is the entire "enchanted gear" vehicle
    // for 11 §1B. Caught by reconciling parsed effects against the dump's effect lines, the
    // same technique that caught the id-less headers; neither was visible record-by-record.
    //
    // It is also structural: record_effects.record_id is an FK to game_records, so discarding
    // the parent makes its effects unstorable. A record that owns rows in a child table must
    // exist regardless of how little text it has.
    const hasContent = Boolean(current.fullText || current.name || current.effects.length);
    if (!current.recordId || !hasContent) {
      skippedEmpty += 1;
    } else {
      // Records with no prose (potions, spells, cells, enchantments) are still worth indexing --
      // their name IS their content, and failing that their id is. The real semantics live in
      // record_effects, which is relational precisely so they are queryable rather than embedded.
      if (!current.fullText) current.fullText = current.name ?? current.recordId;
      records.push(current);
    }
    current = null;
    currentEffect = null;
  };

  for (const line of dump.split(/\r?\n/)) {
    // --- book/script text blocks win over everything: their contents are arbitrary text and
    // must NOT be interpreted as fields. A book quoting `Name: ...` would otherwise corrupt
    // the record it belongs to.
    if (inTextBlock) {
      if (BLOCK_END_RE.test(line)) {
        inTextBlock = false;
        if (current) current.fullText = stripBookMarkup(blockLines.join('\n'));
        blockLines = [];
      } else {
        blockLines.push(line);
      }
      continue;
    }
    if (pendingBlock && BLOCK_START_RE.test(line)) {
      pendingBlock = false;
      inTextBlock = true;
      blockLines = [];
      continue;
    }

    const rec = RECORD_RE.exec(line);
    if (rec) {
      flush();
      pendingBlock = false;
      const [, type, quotedId] = rec;
      const recordId = quotedId ?? '';
      if (type === 'DIAL') currentDial = recordId;
      current = {
        recordId,
        type,
        // An INFO inherits its parent topic as its display name. Everything else names itself.
        name: type === 'INFO' ? currentDial : null,
        fullText: '',
        effects: [],
      };
      continue;
    }

    if (!current) continue;   // esmtool's file header (Author/Description/version) -- not a record

    const eff = EFFECT_RE.exec(line);
    if (eff) {
      currentEffect = {
        // Positional, NOT esmtool's [N]: INGR omits the index entirely, and this is half of the
        // (record_id, ordinal) primary key, so it must exist for every shape.
        ordinal: current.effects.length,
        effectId: Number(eff[3]),
        effectName: eff[2].trim(),
        affected: null,
        affectedKind: null,
        magnitudeMin: null,
        magnitudeMax: null,
        duration: null,
        range: null,
      };
      current.effects.push(currentEffect);
      continue;
    }

    // Effect sub-fields are matched by KEY while an effect is open, deliberately NOT by
    // indentation -- indentation is exactly what differs between ALCH and INGR.
    if (currentEffect) {
      const tgt = TARGET_RE.exec(line);
      if (tgt) {
        // INGR prints BOTH Skill: and Attribute: for every effect and marks the unused one
        // 'Invalid (-1)'. Writing that through would populate `affected` with a non-existent
        // target and make the pre-filter return records that cannot serve the check.
        if (tgt[2] !== 'Invalid' && Number(tgt[3]) >= 0) {
          currentEffect.affected = tgt[2].trim().toLowerCase();
          currentEffect.affectedKind = tgt[1] === 'Skill' ? 'skill' : 'attribute';
        }
        continue;
      }
      const rng = RANGE_RE.exec(line);
      if (rng) { currentEffect.range = rng[1].trim().toLowerCase(); continue; }
      const dur = DURATION_RE.exec(line);
      if (dur) { currentEffect.duration = Number(dur[1]); continue; }
      const mag = MAGNITUDE_RE.exec(line);
      if (mag) {
        currentEffect.magnitudeMin = Number(mag[1]);
        currentEffect.magnitudeMax = Number(mag[2]);
        continue;
      }
    }

    const nm = NAME_RE.exec(line);
    // INFO's name comes from its parent DIAL and must not be overwritten -- INFO records carry
    // no Name: line, but guarding here keeps the rule in one place.
    if (nm && current.type !== 'INFO') { current.name = nm[1].trim() || null; continue; }

    // Identity for a header that had no quoted id (SKIL/MGEF). Guarded on `!current.recordId`
    // so a type that happens to print an `Index:` line cannot overwrite a real id.
    if (!current.recordId) {
      const ident = IDENTITY_RE.exec(line);
      if (ident) {
        current.recordId = `${current.type}:${ident[2]}`;
        current.name = ident[1].trim();
        continue;
      }
    }
    // Prose for SKIL/MGEF. Never overwrites -- a BOOK's block text or an INFO's line wins.
    const desc = DESCRIPTION_RE.exec(line);
    if (desc && !current.fullText) { current.fullText = desc[1].trim(); continue; }

    if (BLOCK_TEXT_RE.test(line)) { pendingBlock = true; continue; }
    const inline = INLINE_TEXT_RE.exec(line);
    if (inline) { current.fullText = inline[1].trim(); continue; }
  }

  flush();
  return { records, skippedEmpty };
}
