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

    // ⭐ Asserted at `commit` — the first paint — not after load. A page that flashes the wrong
    // theme and corrects itself still passes an after-load assertion, so that check could not
    // detect the failure the boot script exists to prevent.
    await page.reload({ waitUntil: 'commit' });
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
