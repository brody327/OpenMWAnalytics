import { createHash } from 'node:crypto';

// Parse + validate a world placement survey manifest (11 §13).
//
// Pure: string in, structured data out, no database and no I/O. Same split as `rankTopics` and
// `classifyGate` -- the RULES are the part worth testing, and they must be exercisable without a
// Postgres or a copy of Morrowind.

const SENTINEL = 'OMWAS1 ';

/** One `(area, item)` row. The GROUP BY already happened in Lua (11 §13 grain). */
export interface Placement {
  area: string;
  is_exterior: boolean;
  item_id: string;
  count: number;
}

export interface SurveyManifest {
  loadOrder: string[];
  loadOrderHash: string;
  cellsScanned: number;
  placements: Placement[];
}

/**
 * ⭐ THE ALLOWLIST — what a survey is permitted to have been run under.
 *
 * Lua cannot report an object's provenance, so we do not attempt per-object attribution. Instead
 * we CONSTRAIN THE UNIVERSE: if the set of loaded files is exactly the controlled set, every
 * object necessarily came from it.
 *
 * Stated as "required + nothing else" rather than as an exact ordered list, deliberately: an exact
 * list is a correctness claim about ORDER that this check does not actually need, and it would
 * break the moment the measured mod is renamed. What matters is that nothing UNEXPECTED could have
 * placed an object.
 */
export const REQUIRED_FILES = ['morrowind.esm', 'tribunal.esm', 'bloodmoon.esm'] as const;

/**
 * The measured mod, ITS HARD DEPENDENCIES, and our own scripts. Extended when a different mod is
 * measured.
 *
 * ⭐ Why a dependency of the measured mod belongs here rather than behind `--allow-extra`:
 * "the measured set" is *what a player running this mod necessarily has*. `OAAB_Data.esm` is a
 * required dependency of CCFF (confirmed by the author 2026-07-28), so every CCFF player has it and
 * anything it places IS reachable for them. Putting it behind a per-run flag would mean the honest
 * answer depended on remembering to pass an argument -- the same rot the refusal exists to prevent.
 */
export const PERMITTED_EXTRAS = [
  'the contrived case of flordius fastus.omwaddon',
  'the contrived case of flordius fastus.omwscripts',
  'oaab_data.esm', // hard dependency of CCFF -- see above
  'omwanalytics.omwscripts',
  'omwanalytics-survey.omwscripts',
] as const;

export interface LoadOrderVerdict {
  ok: boolean;
  missing: string[];
  /** Files present that are neither required nor permitted -- each one can place objects. */
  contaminants: string[];
}

export function validateLoadOrder(
  loadOrder: string[],
  permittedExtras: readonly string[] = PERMITTED_EXTRAS,
): LoadOrderVerdict {
  const seen = new Set(loadOrder.map((f) => f.toLowerCase()));
  const allowed = new Set<string>([...REQUIRED_FILES, ...permittedExtras.map((f) => f.toLowerCase())]);

  const missing = REQUIRED_FILES.filter((f) => !seen.has(f));
  const contaminants = loadOrder.filter((f) => !allowed.has(f.toLowerCase()));

  return { ok: missing.length === 0 && contaminants.length === 0, missing, contaminants };
}

/** Stable fingerprint of the load order — the staleness detector (11 §13). Order IS significant
 *  here even though the allowlist ignores it: a reorder can change which file wins an override,
 *  so a reordered load order describes a different world and must not compare equal. */
export function hashLoadOrder(loadOrder: string[]): string {
  return createHash('sha256').update(loadOrder.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Extract a manifest from raw `openmw.log` text.
 *
 * ⚠️ CONSERVATION CHECK, not decoration. The footer carries the row count the emitter believed it
 * wrote, and this asserts it against what was actually parsed. OpenMW TRUNCATES openmw.log on
 * relaunch and a survey is large, so a partial manifest is a realistic outcome -- and a truncated
 * survey is otherwise INDISTINGUISHABLE from a completed short one: fewer rows, no error, entirely
 * plausible areas. The corpus parser is built on the same rule (N in, N out, asserted) and it is
 * the single technique that has caught the most bugs in this project.
 */
export function parseSurveyManifest(text: string): SurveyManifest {
  let loadOrder: string[] | null = null;
  let sawHeader = false;
  let cellsScanned = 0;
  let footerRows: number | null = null;
  const placements: Placement[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const i = rawLine.indexOf(SENTINEL);
    if (i === -1) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(rawLine.slice(i + SENTINEL.length)) as Record<string, unknown>;
    } catch {
      throw new Error(`survey: unparseable line: ${rawLine.slice(i, i + 120)}`);
    }

    switch (obj.kind) {
      case 'begin':
        // A second 'begin' means two survey runs are interleaved in one log. Merging them would
        // silently double every count in the overlap.
        if (sawHeader || placements.length > 0) {
          throw new Error('survey: a second run starts in this log -- refusing to merge two surveys');
        }
        break;
      case 'header':
        sawHeader = true;
        loadOrder = (obj.load_order as string[]) ?? null;
        cellsScanned = Number(obj.cells_scanned ?? 0);
        break;
      case 'placement':
        placements.push({
          area: String(obj.area),
          is_exterior: Boolean(obj.is_exterior),
          item_id: String(obj.item_id).toLowerCase(),
          count: Number(obj.count),
        });
        break;
      case 'footer':
        footerRows = Number(obj.rows);
        break;
      default:
        throw new Error(`survey: unknown record kind ${String(obj.kind)}`);
    }
  }

  // Distinguish "no header at all" from "header present but the load order is missing". The first
  // real run hit the second case and got told the first, which sent the diagnosis in the wrong
  // direction: the manifest was complete, the guard field was not.
  if (!sawHeader) {
    throw new Error('survey: no header record found -- log truncated before the survey finished?');
  }
  if (loadOrder === null || loadOrder.length === 0) {
    throw new Error(
      'survey: the header carries NO LOAD ORDER, so this survey cannot be shown to describe the ' +
        'controlled world -- refusing. (Known cause: core.contentFiles.list is engine userdata and ' +
        'must be copied into a plain table before json.encode; see survey.lua readLoadOrder.)',
    );
  }
  if (footerRows === null) {
    throw new Error(
      'survey: no footer found -- the survey did not complete, or openmw.log was truncated. ' +
        'A partial survey describes a world that does not exist; refusing.',
    );
  }
  if (footerRows !== placements.length) {
    throw new Error(
      `survey: conservation check FAILED -- footer claims ${footerRows} rows, parsed ${placements.length}. ` +
        'The manifest is incomplete; refusing rather than ingesting a partial world.',
    );
  }

  return { loadOrder, loadOrderHash: hashLoadOrder(loadOrder), cellsScanned, placements };
}
