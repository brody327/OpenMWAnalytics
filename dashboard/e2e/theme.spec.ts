import { test, expect } from '@playwright/test';

// THEME — the rules the light/dark system must never break (design docs 13 §5).
//
// ⭐⭐ WHY THIS FILE IS AN E2E TEST AND NOT A UNIT TEST, stated plainly because it is the whole
// lesson: the bug that motivated it **did not reproduce locally**. `next dev` and a local
// `next start` both behaved perfectly. It appeared only on the deployed site.
//
// Rendering `data-theme` as a prop on <html> made React the OWNER of that attribute, so it
// reasserted "light" on a root re-render and silently undid the pre-paint boot script.
// `suppressHydrationWarning` suppresses the WARNING about the mismatch, not the RECONCILIATION
// that follows — which is why nothing complained anywhere.
//
// Measured with a stack-trace trap on `setAttribute`: two writes on `/events`, "dark" from the
// boot script then "light" from the minified React chunk. One write locally, two in production.
//
// So the only environment that can detect it is a real deployment, which is exactly what this
// suite targets by default. It was found by re-running the theme audit against production AFTER
// deploying — the post-deploy check earning its keep.

const PAGES = ['/', '/gaps', '/events', '/search?q=guards', '/mods/ccff'];

// ── The ROOT CAUSE test, added after the theme test caught only the symptom ───────────────────
//
// ⭐ The theme revert on /events was not a theme bug. It was a HYDRATION FAILURE: a timestamp
// formatted with no locale and no time zone inside a Client Component, so Vercel (UTC) and the
// browser (the visitor's zone) produced different text. React responds by discarding the server
// HTML and re-rendering the document from scratch — REPLACING the <html> element, and taking the
// boot script's `data-theme` with it.
//
// Testing only the theme would leave the next hydration mismatch free to break something else,
// silently. This asserts the cause directly.
//
// ⚠️ IT CANNOT BE RUN LOCALLY AND MEAN ANYTHING. `next dev` and `next start` render both passes
// on one machine, in one zone, with one locale, so the strings always match. Only a deployment
// where the server and the browser genuinely differ can produce the failure — which is precisely
// what this suite targets by default.
test.describe('hydration', () => {
  for (const path of PAGES) {
    test(`⭐ hydrates cleanly, in a NON-UTC zone and a non-English locale — ${path}`, async ({
      browser,
    }) => {
      // Deliberately hostile to the bug: a zone far from UTC and a locale whose number formatting
      // differs (1.234,5 rather than 1,234.5). A test running as en-US/UTC would agree with the
      // server by accident and pass while broken — the definition of a check that cannot fail.
      const ctx = await browser.newContext({
        timezoneId: 'Asia/Kolkata', // +05:30 — a half-hour offset, so even the date can differ
        locale: 'de-DE',
      });
      const page = await ctx.newPage();

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto(path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      // React minifies these in production. #418/#423/#425 are the hydration family; the text is
      // matched too so a future non-minified build is still caught.
      const hydration = errors.filter((e) =>
        /Minified React error #(418|419|420|421|422|423|425)|[Hh]ydration failed|did not match/.test(
          e,
        ),
      );

      expect(
        hydration,
        `hydration error on ${path}. This replaces <html> and silently drops data-theme. ` +
          `Look for a Client Component formatting a date or number without an explicit ` +
          `locale AND timeZone.\n${hydration.join('\n')}`,
      ).toEqual([]);

      await ctx.close();
    });
  }
});

/**
 * Read `data-theme` repeatedly over ~4s.
 *
 * ⚠️ SAMPLING, NOT A SINGLE READ, AND THAT IS THE POINT. The failure is a RE-RENDER that lands
 * some hundreds of milliseconds after load, so a single reading can fall on either side of it —
 * a check that reads once passes or fails by luck. Returning the whole series lets the assertion
 * be "it never changed", which a reverting page is structurally incapable of satisfying.
 */
async function sampleTheme(page: import('@playwright/test').Page, ms = 4000) {
  const samples: (string | null)[] = [];
  const step = 250;
  for (let i = 0; i < ms / step; i++) {
    samples.push(await page.evaluate(() => document.documentElement.getAttribute('data-theme')));
    await page.waitForTimeout(step);
  }
  return samples;
}

test.describe('theme', () => {
  for (const path of PAGES) {
    test(`⭐ a stored preference survives load and never reverts — ${path}`, async ({ page }) => {
      // Seeded the way the toggle writes it, so this exercises the real boot-script path
      // (localStorage → attribute before first paint) rather than a post-hydration flip.
      await page.addInitScript(() => localStorage.setItem('omwa-theme', 'dark'));
      await page.goto(path, { waitUntil: 'domcontentloaded' });

      const samples = await sampleTheme(page);

      expect(samples[0], 'the boot script must apply the preference before React runs').toBe('dark');
      expect(
        new Set(samples).size,
        `data-theme changed after load: ${samples.join(' → ')}. Something is reasserting it — ` +
          'check that layout.tsx does not render data-theme as a prop on <html>.',
      ).toBe(1);
    });
  }

  test('the toggle flips the theme and persists it across a reload', async ({ page }) => {
    await page.goto('/');
    const before = await page.getAttribute('html', 'data-theme');

    await page.getByRole('switch', { name: /dark mode/i }).click();
    const after = await page.getAttribute('html', 'data-theme');
    expect(after, 'clicking the toggle must change the theme').not.toBe(before);
    expect(await page.evaluate(() => localStorage.getItem('omwa-theme'))).toBe(after);

    // ⭐ Asserted at `domcontentloaded`, NOT after full load. A page that flashes the wrong theme
    // and corrects itself during hydration still passes an after-load assertion, so that check
    // could not detect the failure the boot script exists to prevent.
    //
    // ⚠️ NOT `commit`, which was tried first and is too early: it fires when the navigation is
    // committed, before inline <head> scripts have necessarily run. That was fine only while the
    // server HTML still seeded `data-theme` — i.e. the assertion was passing because of the very
    // bug being fixed. `domcontentloaded` is the earliest moment the boot script is guaranteed to
    // have executed, and it is still long before hydration.
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(
      await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
      'the preference must be applied at first paint, not after hydration',
    ).toBe(after);
  });

  test('⭐ the toggle is operable by keyboard', async ({ page }) => {
    // It is a <button role="switch">, not the handoff's <div onClick>, specifically so this works.
    // Without the assertion, that reason is an unverified claim in a comment.
    await page.goto('/');
    const before = await page.getAttribute('html', 'data-theme');
    await page.getByRole('switch', { name: /dark mode/i }).focus();
    await page.keyboard.press('Enter');
    expect(await page.getAttribute('html', 'data-theme')).not.toBe(before);
  });

  test('⭐ charts follow the toggle, and use the palette tokens', async ({ page }) => {
    // The specific regression risk of repointing `useDarkMode` off `matchMedia`. Left alone it
    // would have failed silently: the page themes correctly while every Recharts surface keeps
    // painting the OS's theme.
    await page.goto('/mods/ccff');
    await page.locator('svg.recharts-surface').first().waitFor({ timeout: 60_000 });

    const gridStroke = () =>
      page.locator('svg.recharts-surface line').first().getAttribute('stroke');

    const before = await gridStroke();
    await page.getByRole('switch', { name: /dark mode/i }).click();
    await page.waitForTimeout(600);
    const after = await gridStroke();

    expect(after, 'chart chrome is frozen to one theme').not.toBe(before);

    // Not merely "it changed" — that passes on any re-render. Assert it equals the token as the
    // page itself resolves it, which only a chart genuinely reading the palette can satisfy.
    const token = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--border').trim(),
    );
    expect(after).toBe(token);
  });
});
