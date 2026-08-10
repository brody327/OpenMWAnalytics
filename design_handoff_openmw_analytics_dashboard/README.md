# Handoff: OpenMW Analytics Dashboard — Visual Refresh

## Overview
A visual/UX design pass over the existing `dashboard/` (Next.js + Tailwind) app: a real
light/dark toggle, a cohesive palette built on the app's existing semantic colors, and
subtle Morrowind-flavor touches. Covers five screens: Overview, Mod Detail, Event
Explorer, Search, and AI Recommendations.

## About the design files
`OpenMW Analytics.dc.html` in this folder is a **design reference**, not production
code. It's a single self-contained HTML prototype (streaming "Design Component" format)
built to show layout, color, type, and interaction — it is not React, ships no real data,
and should not be copied into the codebase as-is. The task is to **recreate these screens
inside the existing `dashboard/` Next.js app**, using its existing component patterns
(`app/components/*.tsx`), Tailwind setup, and data-fetching (`app/lib/*`) — wiring each
screen to the real API instead of the placeholder arrays in the prototype.

## Fidelity
**High-fidelity.** Colors, type, spacing, and component shapes below are final; implement
them pixel-close using Tailwind utilities/`@theme` tokens rather than eyeballing.

## Screens

### 1. Top bar (persistent, all screens)
- Sticky header, `padding: 14px 28px`, bottom border 1px, background = `surface`.
- Left: 26×24px icon (see **Assets**) + wordmark stack: "OpenMW Analytics" in Spectral
  600, 17px, next to a small-caps mono subtitle "INTERNAL TELEMETRY & INSIGHT TOOL",
  10px, 1px letter-spacing, `textFaint`.
- Center: nav tabs (Overview / Mod Detail / Events / Search / Recommendations), each
  `padding: 8px 16px`, `border-radius: 6px`, `font-size: 13px/500`. Active tab:
  background `surfaceRaised`, text `text`. Inactive: transparent background, `textMuted`.
- Right: theme toggle — 44×24px pill, 1px border, knob 18×18px circle that slides
  left/right (2px ↔ 22px) on click. Knob color: bronze in dark mode, `surface` in light.

### 2. Overview
- Eyebrow (12px/600, uppercase, 1.2px tracking, `textFaint`) → H1 (Spectral 600, 30px)
  → intro paragraph (15px, `textMuted`, max-width 640px, `<em>` for emphasis).
- **Finding card**: red-tinted (`redBg` background, `redBorder` border, 10px radius,
  22px padding). Eyebrow in `red`, then a bold headline, a body paragraph with inline
  `<strong>`/`<code>`, a muted supporting paragraph, an `n = …` sample-size line in
  `textFaint`, and a text link in `red`.
- **Pipeline list**: "How it gets there" H2 (15px/600) + muted description, then 6 rows,
  each a 5px dot + bold lead-in word + muted trailing text.
- **AI insight teaser**: violet-tinted card, same shape as finding card but violet
  tokens; contains a "Generated · reviewed" pill badge (violet bg, bg-colored text,
  10px/600 uppercase) + mono check-id + headline + "Do this:" recommendation line.
- **Mod registry**: 2-column grid, 12px gap, cards with 1px border, 10px radius, 16px
  padding; mod name (15px/600), mono id (11px, `textFaint`), then events/sessions counts.

### 3. Mod Detail
- Breadcrumb (12px, `textFaint`) → H1 (Spectral, 26px) → events/sessions summary line.
- **Ranking list**: each row = topic label (truncates, `overflow:hidden`/`nowrap`) on
  the left, `n=… · raw NN% → adj NN%` in mono on the right (also `nowrap`, `flex-shrink:0`
  — this wrapped and overlapped the bar below it in an earlier pass, keep the no-wrap
  rule), then a 6px-tall rounded meter bar (`blue` fill on `surfaceRaised` track) sized
  to the row's relative `stuck_score`.
- **Confrontation pass-rate**: topic label (fixed 180px, truncated) + a 16px-tall
  `green`-filled bar + right-aligned mono percentage.
- **Friction**: one row per topic, a 12.5px muted topic label above a 16px-tall bar made
  of 4 segments in a single-hue blue ordinal ramp (lightest→darkest = most severe),
  proportioned to each topic's bucket shares.
- **Skill margin bands**: 3-column grid of tiles (near-miss/blue, moderate-gap/amber,
  build-gap/red), each: big count (22px/600, tinted), bold label, muted explanatory note
  stating the implied work (not just the number).

### 4. Event Explorer
- H1 + description, then two native `<select>` filters (mod, event type) — 12.5px,
  7×10px padding, bordered, `surface` background.
- Event rows: bordered/rounded cards, click to expand. Header line: mono timestamp,
  mono session id, a mod badge (pill, `surfaceRaised` bg), bold event type. Below: a
  mono one-line summary. Expanded: a `<pre>` block (`surfaceRaised` bg, mono, wrapped)
  showing the full JSON payload.

### 5. Search
- H1 + description explaining hybrid (lexical + vector, fused) search.
- Search bar: text input (flex:1, 10×14px padding, rounded 8px) + a `blue`-filled
  "Search" button, same height.
- Mode switcher: two-tab segmented control, "Hybrid" / "Word-match only" — same active/
  inactive treatment as the top nav tabs.
- In word-match-only mode: an amber degradation banner ("meaning search unavailable")
  above the results, and vector-only hits drop out of the list.
- Result cards: type eyebrow (10.5px/600 uppercase, `textFaint`) + title (14.5px/600),
  a `text #N` badge (blue tint) and/or `meaning #N` badge (violet tint) top-right, a
  snippet (13.5px, `textMuted`), and a mono record id.

### 6. AI Recommendations
- H1 + description, then a 3-up stat strip (gates surveyed / no-remedy count / pending
  review), each a bordered tile with the relevant tint on the latter two.
- Gate cards: mono check-id, bold "`Stat` ≥ `threshold`" line, a verdict pill badge
  top-right (no_remedy=red, gamble_only=amber, remedy exists+pending=violet, remedy
  exists+approved=green), an `n = …` fails line.
  - If a generated insight exists: a nested `surfaceRaised` panel with a "Generated"
    badge, a review-status label (pending=amber / approved=green / rejected=faint),
    headline, "Do this:" recommendation, a mono "cites: …" line, and — only while
    pending — Approve (green filled) / Reject (bordered) buttons.
  - If not: an italic "No reviewed insight for this gate yet." line.

## Interactions & behavior
- Theme toggle: click anywhere on the pill, instantly re-themes the whole page (no
  transition beyond a 0.15s color fade) — implement as global state (context or a
  `data-theme` attribute + CSS variables), not per-component state.
- Nav tabs: click swaps the visible screen; no URL routing in the prototype, but the
  real app should route these as real Next.js pages (`/`, `/mods/[modId]`, `/events`,
  `/search`, `/gaps`) per the existing app structure.
- Event rows: click toggles an expanded payload block; only one row's summary/mono line
  changes, nothing else shifts.
- Search mode toggle: switching to "Word-match only" removes vector-only results and
  shows the degradation banner — mirrors the real API's `mode: 'lexical'` fallback
  described in `07_DASHBOARD.md` §8.
- Approve/Reject on a gate's insight: flips its status label and hides the action row
  (in the real app this is `POST /insights/:id/review`).

## State management
- `theme`: `'light' | 'dark'`, drives every color token.
- `screen`: which of the 5 views is active (replace with real routing).
- `eventFilterMod`, `eventFilterType`: Event Explorer filters (in the real app, keep
  these in the URL query string per the existing `/events` design — see
  `07_DASHBOARD.md` §6, "filter state lives in the URL").
- `expandedEvent`: id of the currently expanded event row (local UI state, not shared).
- `searchMode`: `'hybrid' | 'lexical'` — in the real app this should reflect the API's
  actual degradation, not a manual toggle.
- Per-gate review status: keyed by `check_id` in the prototype; the real gate key is the
  full grain `(check_id, stat, stat_kind, threshold)` per `12_AI_INSIGHTS.md` §6 — don't
  regress to `check_id`-only keys when wiring this up.

## Design tokens
Two full palettes (not light-inverted-to-dark), OKLCH, one hue family per accent so
light/dark only trade lightness/chroma:

**Dark**
| Token | Value |
| --- | --- |
| bg | oklch(15% 0.008 55) |
| surface | oklch(19% 0.008 55) |
| surfaceRaised | oklch(23% 0.01 55) |
| border | oklch(30% 0.012 55) |
| borderStrong | oklch(40% 0.014 55) |
| text | oklch(93% 0.004 60) |
| textMuted | oklch(70% 0.008 60) |
| textFaint | oklch(52% 0.008 60) |
| red / redBg / redBorder | oklch(75% 0.15 25) / oklch(27% 0.05 25) / oklch(40% 0.08 25) |
| violet / violetBg / violetBorder | oklch(78% 0.12 295) / oklch(27% 0.045 295) / oklch(40% 0.075 295) |
| amber / amberBg / amberBorder | oklch(80% 0.13 75) / oklch(27% 0.045 75) / oklch(42% 0.07 75) |
| blue / blueBg / blueBorder | oklch(76% 0.11 235) / oklch(26% 0.04 235) / oklch(38% 0.07 235) |
| green / greenBg / greenBorder | oklch(76% 0.12 150) / oklch(26% 0.045 150) / oklch(38% 0.07 150) |
| bronze (icon only) | oklch(70% 0.08 60) |

**Light**
| Token | Value |
| --- | --- |
| bg | oklch(98% 0.004 60) |
| surface | oklch(99% 0.002 60) |
| surfaceRaised | oklch(96% 0.005 60) |
| border | oklch(88% 0.007 60) |
| borderStrong | oklch(78% 0.009 60) |
| text | oklch(22% 0.006 60) |
| textMuted | oklch(45% 0.008 60) |
| textFaint | oklch(58% 0.008 60) |
| red / redBg / redBorder | oklch(48% 0.16 25) / oklch(95% 0.03 25) / oklch(80% 0.09 25) |
| violet / violetBg / violetBorder | oklch(50% 0.15 295) / oklch(95% 0.025 295) / oklch(80% 0.08 295) |
| amber / amberBg / amberBorder | oklch(52% 0.13 75) / oklch(95% 0.03 75) / oklch(80% 0.08 75) |
| blue / blueBg / blueBorder | oklch(50% 0.13 235) / oklch(95% 0.025 235) / oklch(80% 0.07 235) |
| green / greenBg / greenBorder | oklch(48% 0.13 150) / oklch(95% 0.025 150) / oklch(80% 0.07 150) |
| bronze (icon only) | oklch(50% 0.07 60) |

**Type**: system sans stack (`-apple-system, Helvetica, Arial`) for all body/data text;
`ui-monospace` for ids/codes/payloads (matches the shipped app's existing choice);
**Spectral** (Google Font, weights 500/600) for page H1s and the wordmark only — nowhere
else. Don't introduce a third typeface.

**Radii**: 4px (badges/pills), 6-8px (buttons, filters, small cards), 10px (section
cards). **Borders**: 1px throughout, 1.5-2px only on the icon's ring/crescent stroke.

## Assets — the icon
The wordmark icon (crescent moon + magnifying glass, handle pointing down-right) was
built and iterated in the prototype as four inline-styled `<div>`s: a solid circle, a
second circle painted in the *background* color to punch out the crescent, a ringed
circle for the lens, and a short rotated bar for the handle. That approach only works
because it assumes a known solid background behind it — good enough for the prototype's
own top bar, not for a reusable production asset.

**`assets/icon.svg`** in this folder is the production-ready version of the same shape,
built with a real SVG `<mask>` so it composites correctly on any background. It reads
its color from `--icon-color` (fill it with the `bronze` token per theme — bronze never
changes with the other accents, so this is the one place in the system that ISN'T
swapped for contrast, just for the two bronze values above). Use it as an inline SVG
(so the CSS variable is live) or a React icon component — not a flattened PNG, since a
raster export bakes in one theme's color.

`assets/icon-reference.png` is a 4x screenshot of the prototype's rendering, for visual
comparison only — not for import.

## Files in this folder
- `OpenMW Analytics.dc.html` — the full interactive prototype (open directly in a
  browser). Reference for exact spacing/behavior beyond what's described above.
- `13_UI_DESIGN_SYSTEM.md` — the design-system doc (palette rationale, Morrowind-flavor
  scope, component inventory), written for the project's own `design docs/` folder.
- `assets/icon.svg`, `assets/icon-reference.png` — see above.
