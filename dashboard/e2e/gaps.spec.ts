import { test, expect } from '@playwright/test';

// CONTENT GAPS — the rules the findings view must never break.
//
// Invariants, not snapshots. The gate count changes as people play; none of these care.

test.describe('/gaps invariants', () => {
  test('⭐ every gate card is a DISTINCT gate — check_id alone is not a key', async ({ page }) => {
    // Context: `ccff_j_mortar:force` resolves to SIXTEEN gates — security@25 through security@100,
    // plus alchemy, shortblade, luck, personality — with verdicts ranging from no_remedy to
    // remedy_exists. The grain is (check_id, stat, stat_kind, threshold), and getting that wrong
    // once collapsed 25 rows into 14 duplicate React keys AND handed the security@25 insight to
    // the shortblade@25 card.
    //
    // ⚠️ BE HONEST ABOUT WHAT THIS CATCHES. It asserts the rendered cards are unique on that
    // tuple, so it catches genuinely DUPLICATED cards. It does **not** catch the React-key half of
    // that bug: reverting `key={gateKey(g)}` to `key={g.check_id}` still renders distinct DOM, and
    // React strips duplicate-key warnings from production builds, so there is nothing to observe
    // here either. Catching that specifically needs a dev-server run asserting on console output.
    //
    // Recorded rather than quietly overclaimed — a test whose comment describes a bug it cannot
    // detect is exactly the decoration this project keeps deleting.
    await page.goto('/gaps');

    const grains = await page.evaluate(() =>
      [...document.querySelectorAll('li')]
        .map((li) => {
          const id = li.querySelector('h3')?.textContent?.trim();
          const sub = li.querySelector('h3 + p')?.textContent?.replace(/\s+/g, ' ').trim();
          return id && sub ? `${id}|${sub}` : null;
        })
        .filter(Boolean),
    );

    expect(grains.length, 'expected at least one gate card').toBeGreaterThan(0);
    expect(new Set(grains).size, `duplicate gate cards rendered: ${grains.join(' ; ')}`).toBe(
      grains.length,
    );
  });

  test('the rendered card count matches the count the page claims', async ({ page }) => {
    // Internal consistency. "Showing the worst N of M" is generated from the API payload while the
    // cards come from the array — if truncation logic drifts, these disagree and a reader is told
    // something the page is not showing.
    await page.goto('/gaps');
    const claimed = await page.evaluate(() => {
      const m = document.body.textContent?.match(/Showing the worst\s+([\d,]+)\s+of/);
      return m ? Number(m[1].replace(/,/g, '')) : null;
    });
    test.skip(claimed === null, 'page did not render the "showing N of M" line');

    const cards = await page.locator('li h3').count();
    expect(cards).toBe(claimed);
  });

  test('⭐ every gate states its reachability — absence must never be silent', async ({ page }) => {
    // `UNKNOWN` is a value that must RENDER. Omitting it when the survey cannot answer would let a
    // reader assume "not listed" means "not reachable" — the exact overclaim the endpoint was
    // built to prevent, arriving through the UI instead.
    await page.goto('/gaps');
    const cards = page.locator('li h3');
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);

    const labelled = await page
      .getByText(/Found in the world|Not found in the world|Reachability unknown/)
      .count();
    expect(labelled, 'every gate card must carry a reachability label').toBeGreaterThanOrEqual(n);
  });

  test('the merchant caveat from the API is rendered verbatim', async ({ page }) => {
    // The API ships this note ON the payload so a consumer cannot lose it. A UI that dropped it
    // would be making a claim the API did not: NOT_PLACED means "not found lying in the world",
    // NOT "unobtainable" — merchants are deliberately outside the survey.
    await page.goto('/gaps');
    await expect(page.getByText(/MERCHANT INVENTORIES ARE NOT SURVEYED/i)).toBeVisible();
  });

  test('a gate with no reviewed insight says so, rather than showing nothing', async ({ page }) => {
    // "No insight was generated" and "the model found nothing" are different facts. Blank space
    // lets a reader pick either.
    await page.goto('/gaps');
    const withInsight = await page.getByText(/Generated · reviewed/).count();
    const withoutInsight = await page.getByText(/No reviewed insight for this gate yet/).count();
    const cards = await page.locator('li h3').count();
    expect(withInsight + withoutInsight).toBe(cards);
  });
});

test.describe('navigation', () => {
  test('every nav destination renders without an error state', async ({ page }) => {
    // Headings are matched exactly as rendered — `/events` is titled "Event explorer", singular.
    // The first draft guessed `/events/i` and this test failed, which is the point of pinning the
    // real string rather than a substring that happens to look right.
    for (const [path, heading] of [
      ['/', /what players did/i],
      ['/gaps', /content gaps/i],
      ['/events', /event explorer/i],
      ['/search', /corpus search/i],
    ] as const) {
      const res = await page.goto(path);
      expect(res?.status(), `${path} should be 200`).toBe(200);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
      // An upstream failure renders a labelled degradation state rather than throwing — assert we
      // are not looking at one, otherwise every check above could pass against an empty page.
      await expect(page.getByText(/Could not reach the analytics API/i)).toHaveCount(0);
    }
  });
});
