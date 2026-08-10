# 13 — UI Design System

Companion to `07_DASHBOARD.md` (the read-side data design). This doc owns the *visual*
decisions: palette, type, light/dark, and the Morrowind-flavor treatment — and the
reasoning behind each, in the same spirit as the rest of `design docs/`.

## 1. Starting point

The existing dashboard (`dashboard/app/`) is Tailwind + Geist, zinc-based, with
semantic accent colors already load-bearing in the copy: red for a gate with no
remedy, violet for a generated-and-reviewed insight, amber for a warning/small-sample
state. Rather than inventing a new palette, this system **keeps those four hues** and
gives them light *and* dark values, since the shipped site only had an OS-driven
`prefers-color-scheme` toggle, not a real one.

## 2. Palette

Warm-neutral base (slightly warm rather than pure grey, in keeping with an ash/parchment
mood) defined in OKLCH so light and dark share the same hue/chroma family and only trade
lightness:

- **Neutrals:** `bg` / `surface` / `surfaceRaised` / `border` / `borderStrong` /
  `text` / `textMuted` / `textFaint`.
- **Semantic accents** (each with a text tone + a soft background + a border tone,
  tuned per-mode for contrast): **red** (no remedy — retune or write content), **violet**
  (generated insight, always paired with a review-state label), **amber** (gamble-only /
  small-sample), **green** (approved / passing), **blue** (ranking meters, neutral data).
- **Bronze** — one additional low-chroma accent reserved for the Morrowind touches
  (wordmark mark, toggle knob). It never carries semantic meaning, so it can't be
  confused with a status color.

Both modes are full palettes computed in `Component.palette(theme)`, not a filter over
one set — dark isn't "light, inverted," so contrast was set per-mode instead of derived.

## 3. Type

- **Body / data / mono:** system sans (`-apple-system, Helvetica, Arial`) and
  `ui-monospace` for ids/check codes — matches the existing dashboard's register: dry,
  technical, unadorned.
- **Display (`Spectral`, one serif):** page titles and the wordmark only. It's the one
  place the "ancient text / codex" flavor shows up in typography — everything a
  developer actually reads for information stays in the plain sans.

## 4. Morrowind flavor — kept deliberately light

Per direction, the flavor is a gesture, not a theme: this is an internal dev tool, and
its job is to be scannable, not immersive. Three touches, no more:

1. A small rotated-square (diamond) mark beside the wordmark — evokes an heraldic/rune
   mark without copying any specific game crest.
2. `Spectral` for headings only, suggesting an old book without hurting legibility of
   data.
3. A barely-visible dot-grain background texture (togglable via the `flavorIntensity`
   prop) — a nod to ash/parchment, opacity low enough to disappear at a glance.

Explicitly avoided: parchment textures on cards, lore copy, decorative borders, and any
Bethesda-specific iconography — the flavor should read as "made by people who love this
game," not as a skin over their IP.

## 5. Light/dark

A real, user-controlled toggle (top bar, top-right) rather than `prefers-color-scheme`
— an internal tool's users have their own preference regardless of OS setting. Both
palettes are computed from one `theme` state value so every screen re-themes atomically
with no partial-update flashes.

## 6. Component inventory

| Component | Where used | Notes |
| --- | --- | --- |
| Top bar (wordmark + nav tabs + theme toggle) | all screens | sticky, persists across screen switches |
| Finding card (red) | Overview | mirrors the "no remedy" gate copy from `page.tsx` |
| Pipeline list | Overview | six-step dotted list |
| Insight card (violet) | Overview, AI Recommendations | badge + headline + "Do this:" recommendation line |
| Mod registry card | Overview | id in mono, events/sessions counts |
| Ranking row (meter) | Mod Detail | proportional bar, raw→adjusted rate shown side by side |
| Pass-rate bar | Mod Detail | single-hue green fill, topic label truncated |
| Friction stacked bar | Mod Detail | 4-step single-hue ordinal ramp, re-derived per theme |
| Skill band tile | Mod Detail | near-miss / moderate-gap / build-gap, each states the implied work |
| Gate card | AI Recommendations | verdict badge + optional generated-insight block + approve/reject (demo of the human-review gate) |

## 7. Process notes

Built as one Design Component (`OpenMW Analytics.dc.html`) with three screens toggled
by local state rather than three files, since they share a top bar, palette, and data
shapes. Two tweakable props exposed: `initialTheme` (default `dark`) and
`flavorIntensity` (`subtle` default, `off` to strip the grain texture entirely) — both
are alternative UI treatments, not copy/color edits, which is what the props are for.

Placeholder data (mod names, gate ids, numbers) is invented but shaped like the real
pipeline's output (matches field names and value ranges from `07_DASHBOARD.md` and
`12_AI_INSIGHTS.md`) so swapping in live API responses later should not require
restructuring the screens.
