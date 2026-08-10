// The wordmark mark: a crescent moon behind a magnifying glass — Morrowind's two moons, and the
// act of looking closely at something. The flavour touch (design docs 13 §4) that carries the
// most meaning and the least IP: a crescent and a lens are not anyone's crest.
//
// ⚠️ WHY THIS IS INLINE SVG WITH A `<mask>`, and not the four positioned divs the prototype used.
// The prototype punched the crescent by drawing a second circle in the PAGE BACKGROUND COLOUR
// over the first. That works only where the background is a known solid — it is a hole painted to
// look like a hole. Move the mark onto a card, a hover state, or the grain texture and the fake
// hole shows as a differently-coloured disc. A real `<mask>` cuts the geometry, so it composites
// correctly on anything.
//
// ⚠️ AND WHY IT IS NOT A PNG OR AN <img src="icon.svg">. The mark takes its colour from
// `currentColor`, so it follows the theme. A raster export bakes in one theme's bronze, and an
// external <img> gets its own document — CSS variables and currentColor do not cross that
// boundary. Inline is the only form where "one asset, two themes" is true.
//
// The source of these coordinates is `design_handoff/assets/icon.svg`; the ids are suffixed
// because an SVG `id` is document-global, and two of these on one page would otherwise share a
// mask definition.

export function MarkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 26 24"
      width={26}
      height={24}
      className={className}
      aria-hidden
      focusable="false"
    >
      <mask id="omwa-crescent-cut">
        <rect x="0" y="0" width="26" height="24" fill="white" />
        <circle cx="13" cy="10" r="8" fill="black" />
      </mask>
      <circle cx="8" cy="10" r="8" fill="currentColor" mask="url(#omwa-crescent-cut)" />
      <circle cx="13.5" cy="10.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <line
        x1="16.8"
        y1="13.8"
        x2="20.5"
        y2="17.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
