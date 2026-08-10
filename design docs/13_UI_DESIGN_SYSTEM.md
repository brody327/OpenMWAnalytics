# 13 — UI Design System

Companion to `07_DASHBOARD.md` (the read-side data design). This doc owns the *visual* decisions:
palette, type, light/dark, and the Morrowind-flavour treatment — and the reasoning behind each, in
the same Why / How / Tradeoffs form as the rest of `design docs/`.

**Provenance.** This started as an external design handoff
(`design_handoff_openmw_analytics_dashboard/`): a self-contained HTML prototype, a token table, a
production `icon.svg`, and per-screen specs. That folder is the *reference*, not the source of
truth — this doc is. Where the two disagree, §7 records why.

---

## 1. Starting point

The shipped dashboard was Tailwind + Geist, zinc-based, with semantic accents already load-bearing
*in the copy*: red for a gate with no remedy, violet for a generated insight, amber for a
warning/small-sample state. So the palette was not invented from nothing — it was given light *and*
dark values for hues the product had already committed to meaning.

The one genuine gap: the site had no theme **control**, only an OS-driven `prefers-color-scheme`.

## 2. Palette

Warm-neutral base (hue ~55–60, chroma 0.004–0.014) rather than pure grey — an ash/parchment
register that stays close enough to neutral that the data colours still read as the coloured
things.

Defined in **OKLCH** because the hue angle is stable across lightness: red at 25° reads as the same
red in both modes, where an equivalent HSL pair drifts. Each accent family holds its hue and trades
only lightness/chroma, so "the red one" is recognisably one colour across the whole site.

- **Neutrals:** `bg` / `surface` / `surfaceRaised` / `border` / `borderStrong` / `text` /
  `textMuted` / `textFaint`.
- **Semantic accents**, each with a text tone + a soft background + a border tone: **red** (no
  remedy — retune or write content), **violet** (generated insight, always paired with a
  review-state label), **amber** (gamble-only / small-sample / degraded), **green** (a reliable
  remedy exists), **blue** (meters and neutral data).
- **Bronze** — one low-chroma accent reserved for the flavour touches (wordmark mark, toggle knob).
  It never carries semantic meaning, which is exactly why it is the one token exempt from being
  re-tuned for contrast against a flipped surface: nothing is decoded from it.

Both modes are full palettes, **not** one filtered into the other. Contrast was set per mode.

> Values live in `dashboard/app/globals.css`, which is the executable copy. They are not duplicated
> here — a table in a doc beside a stylesheet is a second source of truth with no check able to
> notice it drifting.

### ⚠️ One token was changed from the handoff, by measurement

`textFaint` — **53%** light (spec: 58%), **62%** dark (spec: 52%).

A WCAG audit over the *rendered* pages in both themes (text colour vs. the first non-transparent
ancestor background, sampled through a canvas because the palette computes to `lab()` and cannot be
regex-parsed as sRGB) found `textFaint` was the **only** token in the handoff failing AA:

| pair | spec | measured |
| --- | --- | --- |
| `textFaint` on dark `bg` | 52% | **3.34:1** (need 4.5) |
| `textFaint` on light `bg` | 58% | **4.17:1** (need 4.5) |

Every other token clears AA on every surface it lands on. Hue and chroma are untouched and the
muted→faint step survives (70→62 dark, 45→53 light), so the three-level hierarchy the design
depends on is intact.

⭐ **Why this token mattered more than "small grey text is a bit light."** `textFaint` carries the
`n = …` sample-size lines, the `Cited records:` provenance line, and the mono record ids — the exact
lines `10 §3.3` exists to protect. Making the caveat the hardest thing on the page to read inverts
the point of showing it.

**`textFaint` is calibrated against the three NEUTRAL surfaces only.** On a tinted card it measured
2.75–2.78:1, so the sample-size and citation lines inside red/violet panels use `textMuted`
instead. Raising `textFaint` far enough to clear a tint would have collapsed it into `textMuted`
everywhere else.

## 3. Type

- **Body / data / mono:** system sans and `ui-monospace` for ids and payloads — matching the
  register the dashboard already had: dry, technical, unadorned.
- **Display (`Spectral`, one serif):** **page H1s and the wordmark only.** Not section headings, not
  card titles. It is the one place the "old codex" gesture appears in typography; everything a
  developer reads *for information* stays in the plain sans.

Loaded through `next/font/google` with **only weights 500 and 600** — a serif has real per-weight
weight, and the full family would ship several hundred KB to render about eight words per page.

## 4. Morrowind flavour — deliberately light

A gesture, not a theme. This is an internal dev tool; its job is to be scannable, not immersive.

1. **The mark** — a crescent moon behind a magnifying glass: Morrowind's moons, and the act of
   looking closely. Not any specific game crest.
2. **`Spectral` for page titles**, per §3.
3. **A dot-grain background texture** at ~2% alpha, disabled by `[data-flavor="off"]`.

Explicitly avoided: parchment textures on cards, lore copy, decorative borders, and any
Bethesda-specific iconography. The flavour should read as *made by people who love this game*, not
as a skin over their IP.

## 5. Light / dark — the mechanism

A real, user-controlled toggle in the top bar, not `prefers-color-scheme`. An internal tool's users
have a preference regardless of their OS setting.

**The theme lives in the `data-theme` attribute on `<html>`.** Not React state, not context, not
localStorage. Three things read it and must never disagree:

1. CSS — every semantic token (`globals.css`)
2. Recharts — needs concrete strings, because it writes `fill`/`stroke` as SVG *presentation
   attributes*, where a class cannot reach and `var()` does not resolve
3. The boot script, which runs before React exists

React state could not be the source of truth for (1) or (3), so making it one would mean keeping a
copy in sync with the DOM — the duplicated-state failure `EventFilters` avoids by letting the URL
own the query. `lib/theme.ts` subscribes to the attribute via `MutationObserver` rather than owning
it; localStorage is *persistence*, read once, by the boot script.

### ⭐ The boot script is load-bearing, not an optimisation

The server renders one document for everybody and cannot know a visitor's theme. If the code that
sets `data-theme` is React, it cannot run until the bundle hydrates — and the browser will have
painted a full light page by then. A synchronous inline `<script>` in `<head>` is the only thing
that beats first paint.

Precedence: **localStorage** (an explicit choice) → **`prefers-color-scheme`** (a first visit) →
light. The `try/catch` is required: reading localStorage *throws* in Safari private mode, and
unguarded that exception would leave the whole site light for those users.

⚠️ **`prefers-color-scheme` no longer reaches the stylesheet at all.** Honouring the OS default is
now entirely this script's job. Delete it and the site does not fall back to the OS — it pins
everyone to light.

### ⚠️ `@custom-variant dark` is kept as a trap guard

`globals.css` retargets Tailwind's `dark:` prefix at the attribute. It currently carries **no**
markup — the refresh converted every `dark:` utility to tokens, because the palette moved from zinc
to a warm neutral and all of them named a zinc.

It is kept anyway. `dark:` is the reflex: it is what Tailwind's docs show, what an LLM will suggest,
and what any third-party component ships. Without that line, the next `dark:bg-…` written here would
key off the OS while everything around it keys off the toggle — a page half-themed for exactly the
users who set a preference disagreeing with their OS.

### The accepted cost, stated

`useTheme`'s **server snapshot is `light`**, because the server must give React an answer matching
the HTML it sent. CSS-driven colour has **no** flash (the boot script sets the attribute before
paint). **Recharts colours do** — one frame of light axes on a dark page, because they are JS values
baked into SVG attributes during hydration. Removing it would mean either no server-rendered charts
or a theme cookie the server can read; both were judged more expensive than one frame.

## 6. Component inventory

| Component | Where | Notes |
| --- | --- | --- |
| Top bar (wordmark + tabs + theme toggle) | all screens | sticky, full-bleed; content below gets the measure |
| Finding card (red) | Overview | the `no_remedy` gate, chosen from live data |
| Pipeline list | Overview | six-step dotted list |
| Insight card (violet) | Overview, `/gaps` | badge + headline + "Do this:" |
| Mod registry card | Overview | id in mono, events/sessions counts |
| Summary tile | `/gaps` | count + label + a note carrying the number's SCOPE |
| Ranking row (meter) | Mod detail | proportional bar, raw→adjusted side by side |
| Skill band tile | Mod detail | near-miss/blue → moderate/amber → build-gap/red; the tint is the ordinal encoding |
| Gate card | `/gaps` | verdict badge + optional generated panel |
| Event row | `/events` | collapsed payload preview, expands to full JSON |

## 7. Where the implementation departs from the handoff, and why

| # | Handoff says | Built | Why |
| --- | --- | --- | --- |
| 1 | Verdict badge tinted **violet** when a gate has a pending insight | verdict stays red/amber/green | Violet has exactly one meaning (§2): *a machine wrote this*. A verdict is computed by SQL over parsed game files; colouring it violet would say a model decided it |
| 2 | `/gaps` stat strip includes **"pending review"** | third tile is "reviewed insights live" | `GET /insights` serves `status='approved'` only, enforced in SQL with no widening parameter. The page **cannot** count pending items, and a `0` would publish a number nobody measured |
| 3 | Search has a **Hybrid / Word-match-only toggle** | rendered from `result.mode` | The handoff's own state notes say this should reflect the API's actual degradation. A user cannot switch the embedding provider off, and offering the choice implies a deliberately worse search is a feature |
| 4 | Theme toggle is a `<div onClick>` | `<button role="switch" aria-checked>` | A div is not focusable, not keyboard-reachable, and announces nothing. The pixel spec (44×24 pill, 18px knob, 2px↔22px travel) is reproduced exactly; only the element changed |
| 5 | Five nav tabs, including **"Mod Detail"** | four | `/mods/[modId]` is a dynamic segment with no canonical instance. A tab would have to hardcode a mod id, and be wrong for every other mod |
| 6 | Design-system doc §4 describes a **rotated-square (diamond)** mark | crescent + magnifier | The doc was stale against its own final asset — `assets/icon.svg` ships the crescent. The asset won |
| 7 | Icon built as four positioned `<div>`s | inline SVG with a real `<mask>` | The prototype punched the crescent by painting a disc in the *page background colour* — a hole that only looks like a hole where the background is a known solid. It breaks on a card, a hover state, or the grain |
| 8 | `textFaint` at 58% / 52% | 53% / 62% | §2 — measured, the only token failing AA |

**No page copy changed.** Every string, sample-size line and section order on the Overview and
`/gaps` is a load-bearing claim, several pinned by `e2e/provenance.spec.ts`. Colour, type and
spacing moved; the argument did not.

## 8. What was verified, and how

Run against a local dev server pointed at the **production** API, so the pages rendered real data.

| check | result |
| --- | --- |
| `next build` · `tsc` · `eslint` | clean |
| 17 component tests | pass |
| **11 E2E** (gaps invariants + provenance) | pass |
| Theme applied on all 5 screens × 2 themes | pass |
| Toggle flips the attribute **and** persists to localStorage | pass |
| ⭐ Preference applied **at first paint after reload** | pass — asserted at `waitUntil: 'commit'`, which is the observation a flashing page is structurally incapable of producing. Asserting the attribute *after* load would pass in a broken world too |
| ⭐ Charts follow the toggle, and equal the `--border` token | pass — the specific regression risk of repointing `useDarkMode` off `matchMedia`. If the hook had been left alone, every chart would have kept the OS's theme while the page followed the toggle |
| Toggle operable by keyboard (Enter) | pass |
| **WCAG AA over every rendered page, both themes** | pass — after fixing `textFaint` and one chart legend |

⚠️ **Two of my own checks were wrong before they were right**, and both failed the same way — a
comparison that looked authoritative while comparing the wrong things:

1. The contrast audit parsed `lab(51.2%, 1.35, 2.66)` as sRGB and reported **1.02:1** for plainly
   legible text. Believable-looking numbers, entirely meaningless. Fixed by painting each colour to
   a 1×1 canvas and reading the pixel — by definition what the user sees.
2. The chart assertion compared the SVG attribute against the literal `oklch(...)` string, but
   `getPropertyValue` returns the browser's *computed* serialisation. Fixed by comparing against
   the token as the page itself resolves it.

### ⭐⭐ I REPORTED "zero console warnings" AND IT WAS FALSE. The check could not fail.

Six duplicate-React-key warnings were live on `/mods/ccff` the whole time. A dev-build console
capture had been run over all five pages and reported clean; the user found them in thirty seconds
by clicking around.

**Why it could not have caught them.** The capture navigated with `page.goto` — a cold document
load, where React **hydrates** server HTML. `warnOnInvalidKey` lives on the **reconcile** path,
which is what a `<Link>` click runs. So the script was checking a claim ("no warnings on cold
load") strictly weaker than the one being reported ("no warnings"), and the gap between them is
exactly where the bug lived.

Two further weaknesses, each independently sufficient to hide it: a flat 3-second wait on a
~23,000px page whose table sits at the bottom, and no scroll, so the subtree never rendered.

**Established by mutation.** The key was reverted, and the fixed script went red with exactly six
messages, all on the client-nav pass and none on the cold-load pass. Then restored, and green.
Without that step "it passes now" would have been the same unearned green as before.

> This is `feedback-check-must-be-able-to-fail` turned on my own verification, in the same session
> where I wrote §8's claim that the chart check was designed to be able to fail. One check was; the
> other was not, and I did not ask the question of both.

### The bug itself: `check_id`-shaped, again

`skills.byStat` is keyed `(skill, stat_type, trigger)`. The table keyed on `(skill, trigger)` —
dropping `stat_type`, which the payload varies on and the table **renders as a visible column**.
Measured against live data: 18 rows, 12 of them colliding into 6 pairs, because `personality`,
`agility`, `security`, `acrobatics`, `strength` and `alchemy` are each recorded as both an
`attribute` and a `skill`.

Identical in shape to `12 §6` (`check_id` is not a gate key) and to the `GateList` key this project
already fixed once. **Pre-existing** — the diff shows only the `className` changing on that row —
so the refresh did not introduce it, it exposed it.

### ✅ The same grain error in `MarginChart` — surfaced, decided, then fixed

Found while auditing every other composite key after the table bug. `/stats/skills` `byCheck` has
grain **(check_id, skill, stat_type)** — 205 rows over 21 checks, twelve rows for
`ccff_j_mortar:force` alone (security/attribute, security/skill, personality/attribute, … each with
its own attempts and margins).

`MarginChart` labelled each bar `labelFor(d.check_id)` and fed that to a category axis, so twelve
distinct rows drew twelve bars under one label and the file's own header comment — *"one bar per
check that has ever been failed"* — was false.

⭐ **Nothing could have caught it.** Recharts sets no React keys here, so there was no console
warning (unlike the sibling table defect). Playwright cannot read a category axis meaningfully.

It was **raised as a decision rather than fixed on sight**: which dimensions identify a bar is a
product question `07 §5b` documents, and the source-of-truth rule says to surface the ambiguity.
Three options were offered; the author chose to make the code match the documented design.

**The aggregation rule is not new.** The representative row is the one with the **greatest** (least
negative) margin — the closest anyone got. That is `07 §5c` applied one level up: `failureDistance`
already collapses many *attempts* to `max(margin)` for exactly this reason, so collapsing many
*stats* the same way keeps one rule in the product instead of two.

⚠️ **`attempts` is deliberately NOT summed.** One player action can test several stats, so the rows
overlap and a sum would report a check-level total the payload cannot support. The figure shown
belongs to the single winning row, and the tooltip names that stat.

Verified: 205 rows → **21 bars, 21 distinct labels**, against live production data. Eight tests pin
the rule (`SkillCharts.test.tsx`), each **mutation-checked** — reversing the comparison, summing
attempts, and dropping the null guard each turn a different subset red.

### ⭐⭐⭐ A TIMESTAMP BROKE THE THEME, IN PRODUCTION ONLY. The best bug of the session.

Found by re-running the theme audit **against production after deploying** — every pre-push check
had been local, and a local check was structurally incapable of seeing this.

**Symptom.** `/events` loaded dark, then flipped to light a few hundred ms later. 6/6 reproducible
on the deployed site. Not reproducible against `next dev` **or** a local `next start`, both of
which showed one write and stayed dark.

**Diagnosis, in three measurements** — each one taken because the previous guess was wrong:

| # | instrument | what it said |
| --- | --- | --- |
| 1 | stack-trace trap on `setAttribute` | **two** writes: `dark` from the boot script, then `light` **from the minified React chunk** |
| 2 | (after removing `data-theme` from the JSX) same trap | one write, but the attribute ended up `null` — and **no** removal was logged |
| 3 | `MutationObserver` + identity check | **zero** mutations, and `documentElement !== the element captured at boot` |

Measurement 3 is the one that cracked it. The root element was not being *edited*, it was being
**replaced** — which is what React does when hydration fails. The console then named it:
**Minified React error #418, `args[]=text`**.

**Root cause.** `fmtTime` in `EventFeed` — a Client Component — called
`toLocaleString(undefined, …)`: no locale, no time zone. That renders once on the server and again
during hydration, on different machines. Vercel is UTC and picks up the server locale; the browser
uses the visitor's. Different strings ⇒ failed hydration ⇒ React discards the server HTML and
re-renders the document ⇒ **`<html>` is replaced, and the boot script's `data-theme` goes with it.**

⭐ **The lesson is the chain, not the fix.** A date format string, in one Client Component, on one
page, silently disabled a site-wide feature — in production only, via a mechanism (`<html>` being
replaced) that neither of the first two instruments could see. Nothing logged anything a reader
would connect to "the theme".

⚠️ **`suppressHydrationWarning` was NOT the fix and would have hidden this.** It suppresses the
*warning* about a mismatch, not the *reconciliation* that follows it.

**Two fixes, and a decision.** The attribute is gone from the JSX (React cannot own what it never
renders), and the timestamp is now explicit `en-US` + `UTC`, labelled. The server cannot know the
visitor's zone, so the only deterministic options are "always UTC" or "render nothing until after
mount"; UTC wins on merit — the feed exists to correlate a row against `openmw.log` and Postgres,
and both are UTC. Two latent instances of the same class (bare `toLocaleString()` on numbers in
`EventFeed` and `EventFilters`) were pinned to `en-US` while there.

**The permanent check is the ROOT-CAUSE one, not the symptom.** `e2e/theme.spec.ts` asserts every
page hydrates cleanly in **`Asia/Kolkata` + `de-DE`** — a half-hour offset so even the date can
differ, and a locale whose number separators differ. Running it as en-US/UTC would agree with the
server *by accident* and pass while broken. It can only mean anything against a deployment, which
is what the suite targets by default.

⭐ Mutation-checked against the real failure rather than a simulated one: run against the
still-broken production it failed on `/events` with the right diagnostic, four other pages green.

⚠️ **And it caught a bad assertion of my own.** The reload check used `waitUntil: 'commit'`, which
fires before inline `<head>` scripts are guaranteed to have run. It had been passing *because* the
server HTML still seeded `data-theme` — i.e. because of the bug being fixed. Now
`domcontentloaded`.

## 9. Responsive — the header set a 476px minimum width for the whole site

Reported by the author on a phone: the theme toggle was off-screen and pages scrolled sideways.

**Measured across 5 pages × 5 widths.** Below 476px the toggle sat at exactly `right: 476` at
*every* viewport, and the document scrolled by precisely `476 − viewport`. One element set a floor
and every page inherited it.

**Cause, and it is two flexbox defaults doing what they are documented to do.** The wordmark was
`shrink-0`, so its long mono subtitle never yielded. The tab list was `flex-1 flex-wrap` — and a
flex item's default `min-width: auto` refuses to shrink below its content, so instead of
compressing, the tabs *wrapped into a vertical stack* beside the wordmark and pushed the toggle
past the edge.

### ⭐ No hamburger, and that is a decision rather than a shortcut

A disclosure menu costs open/close state, a focus trap, `aria-expanded`, an outside-click handler
and an escape key — to hide **four short words** behind an extra tap. A horizontally scrollable row
keeps every destination visible and one tap away with no JavaScript at all. Reach for the menu when
the nav outgrows a row, not before.

| | layout |
| --- | --- |
| `< md` | row 1 `[mark + wordmark ......... toggle]`, row 2 `[tabs → scrollable]` |
| `≥ md` | `[mark + wordmark] [tabs centred] [toggle]` |

The toggle is `shrink-0` and `ml-auto` on mobile, so the control the user came for is the last
thing that would ever be squeezed. The mono subtitle is hidden below `sm`: at 320px it is the
single widest element in the header, and a truncated "INTERNAL TELEME…" communicates nothing.

### Charts: the Y axis was a fixed pixel width chosen against a 920px container

`ResponsiveContainer` makes the SVG fluid — that is the easy half. A horizontal bar chart's **Y
axis is a fixed `width`**, and these were 140–190px. On a 320px phone a 190px axis left ~90px for
the bars, so the chart was mostly labels and the data was 4px slivers.

`lib/useChartWidth` measures **the element** with a `ResizeObserver`, not `window.innerWidth` —
the question is "how wide is this chart", and those differ whenever it sits in a card or a grid
column, which is every chart here. `axisWidth()` then clamps to `max(72, min(design, 40%))`.
Measured after: labels went from ~70% of the chart to ~40%, and the −70 outlier reads as an
outlier again.

### Also fixed

Long check ids (`ccff_jeanus_inventory_lockbox_puzzle:guess` — 43 unbreakable characters) got
`break-all`; without it one token dragged the whole page into horizontal scroll. The search input
got `min-w-0` so it can actually shrink, and its button `shrink-0`, which had been pushed off a
320px screen. Page gutters are `px-4` below `sm`.

### ⚠️ A viewport is an input, and the suite only ever ran at one value of it

`e2e/responsive.spec.ts` — 21 tests over 5 pages × 4 widths, asserting no horizontal document
scroll and that the toggle is inside the viewport, plus a paired case that every nav destination
is still reachable at 320px (a header could satisfy every other assertion by hiding the nav) and
that the tab strip **scrolls rather than wraps**, since wrapping is what broke it.

⭐ Mutation-checked against the real failure: **16 of 21 failed against unfixed production**, all
45 E2E pass against the fixed build.

⚠️ **My detector cried wolf first, and that was worth fixing before trusting it.** It flagged 7
elements wider than the viewport that were all inside `overflow-x-auto` containers — the tab strip
and the wide data tables, which are *designed* to extend past the edge. An element wider than the
screen is only a bug if nothing can scroll it. A check that reports intentional behaviour as a
defect is one people learn to ignore.

### One defect the audit found that predates this work

`Legend` paints each label in its **series colour**, and `wrapperStyle.color` does not override it —
the colour is set per item. "Retried the topic" was rendering as 12px text in the ramp's lightest
blue: **2.05:1**, the worst contrast in the app. The swatch already encodes the series, so the label
now renders as ink (`FrictionCharts`).
