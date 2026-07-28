import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSurveyManifest,
  validateLoadOrder,
  hashLoadOrder,
  type Placement,
} from './surveyManifest.js';

const S = 'OMWAS1 ';
const CONTROLLED = ['Morrowind.esm', 'Tribunal.esm', 'Bloodmoon.esm', 'omwanalytics-survey.omwscripts'];

const line = (o: unknown) => S + JSON.stringify(o);

function manifest(placements: Placement[], opts: { rows?: number; loadOrder?: string[] } = {}): string {
  return [
    'some unrelated openmw chatter',
    line({ kind: 'begin', cells: 3 }),
    line({ kind: 'header', version: 1, load_order: opts.loadOrder ?? CONTROLLED, cells_scanned: 3 }),
    ...placements.map((p) => line({ kind: 'placement', ...p })),
    'Global[script]: something else entirely',
    line({ kind: 'footer', rows: opts.rows ?? placements.length, cells_scanned: 3 }),
  ].join('\n');
}

const P: Placement[] = [
  { area: 'Balmora, Council Club', is_exterior: false, item_id: 'potion_skooma_01', count: 2 },
  { area: 'Bitter Coast Region', is_exterior: true, item_id: 'ingred_bittergreen_petals_01', count: 7 },
];

test('parses placements and ignores non-survey log lines', () => {
  const m = parseSurveyManifest(manifest(P));
  assert.equal(m.placements.length, 2);
  assert.equal(m.cellsScanned, 3);
  assert.deepEqual(m.loadOrder, CONTROLLED);
});

test('⭐ conservation check: a truncated manifest is REFUSED, not silently ingested', () => {
  // The realistic failure: OpenMW truncates openmw.log on relaunch and a survey is large, so a
  // partial survey is likely. It is otherwise indistinguishable from a completed short one --
  // fewer rows, no error, entirely plausible areas.
  const truncated = manifest(P, { rows: 9 });
  assert.throws(() => parseSurveyManifest(truncated), /conservation check FAILED.*9.*parsed 2/s);
});

test('a manifest with no footer is REFUSED (survey never finished)', () => {
  const noFooter = manifest(P).split('\n').filter((l) => !l.includes('"footer"')).join('\n');
  assert.throws(() => parseSurveyManifest(noFooter), /did not complete/);
});

test('two interleaved survey runs in one log are REFUSED, never merged', () => {
  // Merging would silently double every count in the overlap -- plausible numbers, no error.
  assert.throws(() => parseSurveyManifest(manifest(P) + '\n' + manifest(P)), /refusing to merge/);
});

test('item ids are lowercased at the boundary', () => {
  const m = parseSurveyManifest(
    manifest([{ area: 'X', is_exterior: false, item_id: 'Ingred_Dae_Cursed_Emerald_01', count: 1 }]),
  );
  // The corpus stores mixed case; Lua reports lowercase. Normalising HERE means the read side has
  // one rule (lower(record_id)) instead of two conventions meeting in a join.
  assert.equal(m.placements[0]!.item_id, 'ingred_dae_cursed_emerald_01');
});

test('⭐ the controlled load order passes', () => {
  const v = validateLoadOrder(CONTROLLED);
  assert.equal(v.ok, true);
  assert.deepEqual(v.contaminants, []);
  assert.deepEqual(v.missing, []);
});

test('⭐⭐ a real modded load order is REFUSED, and every contaminant is named', () => {
  // The author's actual setup measured 683 content files on 2026-07-28. Any one of them can place
  // an object, and Lua cannot say which did -- so the check is on the SET, not the objects.
  const modded = [...CONTROLLED, 'Tamriel_Data.esm', 'RepopulatedMorrowind.ESM'];
  const v = validateLoadOrder(modded);
  assert.equal(v.ok, false);
  assert.deepEqual(v.contaminants, ['Tamriel_Data.esm', 'RepopulatedMorrowind.ESM']);
});

test("⭐ the CCFF_Testing_Base profile's real load order passes", () => {
  // Verbatim from launcher.cfg after wiring the analytics scripts in (2026-07-28). OAAB_Data.esm
  // is a HARD DEPENDENCY of CCFF (confirmed by the author), so every CCFF player has it and
  // anything it places is genuinely reachable for them -- it is part of the measured set, not a
  // contaminant. Pinned as a test so removing it from PERMITTED_EXTRAS fails loudly instead of
  // silently refusing every real survey.
  const profile = [
    'Morrowind.esm',
    'Tribunal.esm',
    'Bloodmoon.esm',
    'OAAB_Data.esm',
    'The Contrived Case of Flordius Fastus.omwaddon',
    'The Contrived Case of Flordius Fastus.omwscripts',
    'omwanalytics.omwscripts',
    'omwanalytics-survey.omwscripts',
  ];
  const v = validateLoadOrder(profile);
  assert.deepEqual(v.contaminants, []);
  assert.equal(v.ok, true);
});

test('a missing expansion is REFUSED (the survey would describe a smaller world)', () => {
  const v = validateLoadOrder(['Morrowind.esm', 'omwanalytics-survey.omwscripts']);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ['tribunal.esm', 'bloodmoon.esm']);
});

test('the allowlist is case-insensitive (openmw.cfg casing is inconsistent)', () => {
  assert.equal(validateLoadOrder(['MORROWIND.ESM', 'tribunal.esm', 'BloodMoon.esm']).ok, true);
});

test('⭐ reordering the load order changes the hash', () => {
  // Order is ignored by the ALLOWLIST but must not be ignored by the FINGERPRINT: a reorder can
  // change which file wins an override, so it describes a different world and must not compare
  // equal to the old survey. This is the staleness detector, and a hash that ignored order would
  // report "same world" across a genuinely different one.
  const a = hashLoadOrder(['Morrowind.esm', 'Tribunal.esm']);
  const b = hashLoadOrder(['Tribunal.esm', 'Morrowind.esm']);
  assert.notEqual(a, b);
});
