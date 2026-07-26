import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEsmDump, stripBookMarkup } from './parseEsmDump.js';

// FIXTURE: verbatim excerpts from `esmtool dump -p Morrowind.esm` (2026-07-26), trimmed to the
// shapes that matter. This is the format contract. If an OpenMW release changes the dump, THIS
// is what fails -- loudly, here -- instead of ingest quietly producing a smaller corpus.
const FIXTURE = `Using default (English) font encoding.
Loading TES3 file: "Morrowind.esm"
Author: Bethesda Softworks
Description: The main data file For Morrowind
File format version: 1.2

Record: ALCH "potion_skooma_01"
Record flags: [None] (0x00000000)
  Name: Skooma
  Weight: 1
  Value: 500
  Effect[0]: Fortify Attribute (79)
    Attribute: Speed (4)
    Range: Self (0)
    Duration: 60
    Magnitude: 20-20
  Effect[1]: Drain Attribute (17)
    Attribute: Intelligence (1)
    Range: Self (0)
    Duration: 60
    Magnitude: 20-20
  Deleted: 0

Record: INGR "ingred_dreugh_wax_01"
Record flags: [None] (0x00000000)
  Name: Dreugh Wax
  Weight: 0.2
  Effect: Fortify Attribute (79)
  Skill: Invalid (-1)
  Attribute: Strength (0)
  Effect: Drain Attribute (17)
  Skill: Invalid (-1)
  Attribute: Luck (7)
  Deleted: 0

Record: DIAL "A1_6_AddhiranirrInformant"
Record flags: [None] (0x00000000)
  Deleted: 0

Record: INFO "30643123741319511643"
Record flags: [None] (0x00000000)
  Id: "30643123741319511643"
  Text: I'm told that Addhiranirr is hiding because a Census and Excise agent is in the area.
  Type: Journal
  Deleted: 0

Record: BOOK "BookSkill_Enchant1"
Record flags: [None] (0x00000000)
  Name: Feyfolken I
  Value: 300
  Text:
START--------------------------------------
<DIV ALIGN="CENTER"><FONT COLOR="000000" SIZE="3" FACE="Magic Cards"><BR>
Feyfolken<BR>
by Waughin Jarth<BR><BR>
<DIV ALIGN="LEFT"><BR>
The Great Sage was a tall, untidy man.<BR>
  Name: this line is book CONTENT, not a field
END----------------------------------------
  Deleted: 0

Record: ENCH "test magic axe"
Record flags: [None] (0x00000000)
  Type: Cast Once (0)
  Cost: 4
  Charge: 4
  Effect[0]: Fortify Maximum Magicka (84)
    Skill: Axe (6)
    Range: Self (0)
    Duration: 1
    Magnitude: 1-15
  Deleted: 0

Record: MGEF
Record flags: [None] (0x00000000)
  Index: Water Breathing (0)
  Description: This effect permits the subject to breathe underwater for the duration.
  Icon: s\\Tx_S_water_breath.tga
  Deleted: 0

Record: CELL
Record flags: [None] (0x00000000)
  Name: Balmora, Council Club
  Flags: Interior NoSleep (0x00000005)
  Deleted: 0

Record: LAND
Record flags: [None] (0x00000000)
  Coordinates: (23,7)
  Deleted: 0

Record: SNDG "no_name_no_text_00"
Record flags: [None] (0x00000000)
  Deleted: 0
`;

const parsed = parseEsmDump(FIXTURE);
const byId = new Map(parsed.records.map((r) => [r.recordId, r]));

test('skips the esmtool file header and finds every content record', () => {
  // DIAL is a container (consumed as state for INFO naming, never emitted); LAND and SNDG are
  // dropped as genuinely empty.
  assert.deepEqual(
    parsed.records.map((r) => r.type),
    ['ALCH', 'INGR', 'INFO', 'BOOK', 'ENCH', 'MGEF', 'CELL'],
  );
  assert.equal(parsed.skippedEmpty, 2);
});

// ⚠️ REGRESSION: ENCH has no Name: and no prose -- only Type/Cost/Charge and its effects. An
// "empty" test of (name || text) discarded all 708 enchantments and 1,069 effects, silently
// removing the "enchanted gear" vehicle from 11 §1B.
test('a record with effects but no name and no prose is KEPT', () => {
  const ench = byId.get('test magic axe')!;
  assert.ok(ench, 'effects alone make a record worth storing');
  assert.equal(ench.effects.length, 1);
  assert.equal(ench.effects[0].affected, 'axe');
  assert.equal(ench.effects[0].affectedKind, 'skill');
  // record_effects.record_id is an FK to game_records: no parent row, no effects.
  assert.equal(ench.fullText, 'test magic axe', 'falls back to the id so full_text stays NOT NULL');
});

// The effects-level twin of the header reconciliation. Both bugs were invisible record-by-record
// and both showed up as a total that did not add up.
test('every effect line in the input is accounted for', () => {
  const effectLines = (FIXTURE.match(/^\s+Effect(\[\d+\])?: /gm) ?? []).length;
  const parsedEffects = parsed.records.reduce((n, r) => n + r.effects.length, 0);
  assert.equal(parsedEffects, effectLines);
});

// ⚠️ THE REGRESSION TEST FOR THE WORST BUG THIS PARSER HAD. 5,286 of Morrowind.esm's headers
// print with no quoted id (`Record: CELL `). Requiring the id meant those headers did not start
// a new record, so their fields were silently folded into the PREVIOUS record.
test('a header with NO quoted id still starts a new record', () => {
  const book = byId.get('BookSkill_Enchant1')!;
  // MGEF follows BOOK in the fixture. If the id-less header were ignored, the effect's
  // Description would have overwritten -- or appended to -- the book that precedes it.
  assert.match(book.fullText, /The Great Sage was a tall, untidy man\./);
  assert.doesNotMatch(book.fullText, /breathe underwater/);
  assert.equal(book.name, 'Feyfolken I');
});

test('SKIL/MGEF identity comes from the Index line, keyed on the stable enum ordinal', () => {
  const mgef = byId.get('MGEF:0')!;
  assert.ok(mgef, 'MGEF should be keyed by its numeric index, not its display name');
  assert.equal(mgef.name, 'Water Breathing');
  // Description is the prose that makes these 137 records worth indexing at all.
  assert.match(mgef.fullText, /breathe underwater/);
});

test('a named CELL survives with a synthesized key (the AreaEntered join target)', () => {
  const cell = byId.get('CELL:Balmora, Council Club')!;
  assert.ok(cell, '1,240 named cells are what AreaEntered.area joins to (11 §3)');
  assert.equal(cell.name, 'Balmora, Council Club');
});

// The invariant that CAUGHT the id-less bug: no individual record looked wrong, the TOTAL did
// not add up. Encoding it here means the next format drift is caught the same way.
test('every record header is accounted for: emitted + skipped + containers == headers', () => {
  const headers = (FIXTURE.match(/^Record: /gm) ?? []).length;
  const containers = (FIXTURE.match(/^Record: DIAL/gm) ?? []).length;
  assert.equal(parsed.records.length + parsed.skippedEmpty + containers, headers);
});

test('ALCH: indexed effects keep target, range, duration and magnitude', () => {
  const skooma = byId.get('potion_skooma_01')!;
  assert.equal(skooma.name, 'Skooma');
  assert.equal(skooma.effects.length, 2);
  assert.deepEqual(skooma.effects[0], {
    ordinal: 0,
    effectId: 79,
    effectName: 'Fortify Attribute',
    affected: 'speed',
    affectedKind: 'attribute',
    magnitudeMin: 20,
    magnitudeMax: 20,
    duration: 60,
    range: 'self',
  });
  // Direction matters: Drain is the OPPOSITE of a buff, so effect_name -- not just the target --
  // is load-bearing for "what could serve this check" (11 §1B).
  assert.equal(skooma.effects[1].effectName, 'Drain Attribute');
  assert.equal(skooma.effects[1].affected, 'intelligence');
});

test('INGR: the flat, un-indexed effect shape parses to the same structure', () => {
  const wax = byId.get('ingred_dreugh_wax_01')!;
  assert.equal(wax.effects.length, 2);
  // Ordinals are positional because INGR omits esmtool's [N] entirely -- and ordinal is half
  // of record_effects' primary key.
  assert.deepEqual(wax.effects.map((e) => e.ordinal), [0, 1]);
  assert.equal(wax.effects[0].affected, 'strength');
  assert.equal(wax.effects[1].affected, 'luck');
});

test('INGR: "Invalid (-1)" is never written through as a target', () => {
  const wax = byId.get('ingred_dreugh_wax_01')!;
  // INGR prints BOTH Skill: and Attribute: for every effect. Storing the placeholder would make
  // the pre-filter return records that cannot serve the check at all.
  for (const e of wax.effects) {
    assert.notEqual(e.affected, 'invalid');
    assert.equal(e.affectedKind, 'attribute');
  }
});

test('INFO inherits its display name from the preceding DIAL', () => {
  const info = byId.get('A1_6_AddhiranirrInformant#30643123741319511643')!;
  // Without this the UI renders a search hit as '30643123741319511643'.
  assert.equal(info.name, 'A1_6_AddhiranirrInformant');
  assert.match(info.fullText, /^I'm told that Addhiranirr is hiding/);
});

// ⚠️ REGRESSION: an INFO id is unique only WITHIN its topic. 99 ids repeat across topics in
// Morrowind.esm, so keying on the bare id silently merges unrelated dialogue -- and Postgres
// only complains (21000) because the batch happens to contain both in one statement.
test('INFO ids are keyed by topic, so the same id under two topics does not collide', () => {
  const dump = `Record: DIAL "attack on a guar hide trader"
Record flags: [None] (0x00000000)
  Deleted: 0

Record: INFO "12345"
  Text: The first version of the rumour.
  Deleted: 0

Record: DIAL "Attack on guar hide trader"
Record flags: [None] (0x00000000)
  Deleted: 0

Record: INFO "12345"
  Text: The second version, under a topic differing only in case.
  Deleted: 0
`;
  const { records } = parseEsmDump(dump);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((r) => r.recordId)).size, 2, 'ids must not collide');
  assert.match(records[0].fullText, /first version/);
  assert.match(records[1].fullText, /second version/);
});

test('BOOK: block text is captured, markup stripped, paragraphs preserved', () => {
  const book = byId.get('BookSkill_Enchant1')!;
  assert.equal(book.name, 'Feyfolken I');
  assert.doesNotMatch(book.fullText, /<[^>]+>/, 'no markup should survive');
  assert.match(book.fullText, /Feyfolken/);
  assert.match(book.fullText, /The Great Sage was a tall, untidy man\./);
  // The paragraph boundary is the chunk boundary (11 §4) -- flattening it here would force
  // chunking to guess where a book's sections begin.
  assert.match(book.fullText, /\n/);
});

test('a field-shaped line INSIDE a text block does not corrupt the record', () => {
  const book = byId.get('BookSkill_Enchant1')!;
  // Book contents are arbitrary text. A book that happens to contain "  Name: ..." must not
  // rename the record -- this is the class of bug that produces one wrong row in 34,000.
  assert.equal(book.name, 'Feyfolken I');
  assert.match(book.fullText, /this line is book CONTENT/);
});

test('records with neither name nor prose are dropped and COUNTED, never silent', () => {
  assert.equal(byId.has('no_name_no_text_00'), false);
  // LAND too: coordinates only, no name and no prose, and no id to synthesize a key from.
  assert.equal(parsed.records.some((r) => r.type === 'LAND'), false);
  // A jump in this number after an OpenMW upgrade is the format-drift alarm.
  assert.equal(parsed.skippedEmpty, 2);
});

test('stripBookMarkup handles mixed-case tags and collapses blank runs', () => {
  const out = stripBookMarkup('<DIV>one<BR><br>two</DIV><FONT SIZE="3">three</FONT>');
  assert.doesNotMatch(out, /<[^>]+>/);
  assert.match(out, /one/);
  assert.match(out, /two/);
  assert.match(out, /three/);
  assert.doesNotMatch(out, /\n{3,}/);
});
