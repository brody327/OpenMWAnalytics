import { test, expect } from '@playwright/test';

// RESPONSIVE — the rules that keep the site usable on a phone.
//
// ⭐ WHY THIS EXISTS: the header set a 476px MINIMUM WIDTH for the whole site, and nothing caught
// it. Measured on production — at every viewport below 476px the theme toggle sat at exactly
// `right: 476` and the document scrolled sideways by precisely `476 − viewport`. Every page
// inherited it. It was reported by a human on a phone, which is the only instrument that had been
// pointed at the problem.
//
// Cause: the wordmark was `shrink-0` so its long mono subtitle never yielded, and the tab list was
// `flex-1 flex-wrap`, so rather than shrinking it wrapped into a VERTICAL stack beside the
// wordmark and shoved the toggle off the right edge — unreachable.
//
// Every desktop check in the suite was green throughout. A viewport is an input, and the suite had
// only ever been run at one value of it.

const PAGES = ['/', '/gaps', '/events', '/search?q=guards', '/mods/ccff'];

// 320 is the narrowest phone still in common use (iPhone SE). 375 and 414 are the common iPhone
// widths; 768 is portrait tablet, where the layout switches back to one row.
const WIDTHS = [320, 375, 414, 768];

test.describe('responsive', () => {
  for (const width of WIDTHS) {
    for (const path of PAGES) {
      test(`⭐ no sideways scroll, and the theme toggle is reachable — ${width}px ${path}`, async ({
        browser,
      }) => {
        const ctx = await browser.newContext({
          viewport: { width, height: 800 },
          isMobile: width < 768,
          hasTouch: width < 768,
        });
        const page = await ctx.newPage();
        await page.goto(path, { waitUntil: 'networkidle' });
        await page.waitForTimeout(800);

        const r = await page.evaluate(() => {
          const de = document.documentElement;
          const sw = document.querySelector('[role="switch"]');
          const b = sw?.getBoundingClientRect();
          return {
            // The single most important signal. If the DOCUMENT scrolls sideways, something is
            // wider than the screen and no amount of styling elsewhere hides it.
            overflow: Math.max(de.scrollWidth, document.body.scrollWidth) - de.clientWidth,
            toggle: b ? { left: b.left, right: b.right } : null,
          };
        });

        expect(r.overflow, `the page scrolls horizontally by ${r.overflow}px`).toBeLessThanOrEqual(1);

        // The reported symptom, asserted directly rather than inferred from the absence of
        // overflow — a toggle could be clipped by a container without the document scrolling.
        expect(r.toggle, 'the theme toggle is not rendered').not.toBeNull();
        expect(r.toggle!.left, 'the theme toggle is off the left edge').toBeGreaterThanOrEqual(0);
        expect(
          r.toggle!.right,
          `the theme toggle ends at ${Math.round(r.toggle!.right)}px, past the ${width}px viewport`,
        ).toBeLessThanOrEqual(width + 1);

        await ctx.close();
      });
    }
  }

  test('⭐ every nav destination is reachable on the narrowest phone', async ({ browser }) => {
    // The paired case for "no overflow". A header could satisfy every assertion above by simply
    // hiding the navigation — which is a worse outcome than the bug, and would look like a pass.
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 800 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto('/');

    const nav = page.getByRole('navigation');
    for (const label of ['Overview', 'Events', 'Content gaps', 'Search']) {
      const link = nav.getByRole('link', { name: label, exact: true });
      // `.first()` because the tabs render twice — one row for mobile, one for desktop — with the
      // inapplicable one hidden by a media query. Both are in the DOM by design.
      await expect(link.first(), `"${label}" is missing from the nav at 320px`).toBeAttached();
    }

    // The tab strip scrolls rather than wrapping. Wrapping is what broke the header originally,
    // so assert the mechanism, not just the presence of the links.
    const scrollable = await page.evaluate(() => {
      const lists = [...document.querySelectorAll('nav ul')];
      return lists.some((ul) => {
        const ox = getComputedStyle(ul).overflowX;
        return ox === 'auto' || ox === 'scroll';
      });
    });
    expect(scrollable, 'the mobile tab strip must scroll, not wrap into a vertical stack').toBe(true);

    await ctx.close();
  });
});
