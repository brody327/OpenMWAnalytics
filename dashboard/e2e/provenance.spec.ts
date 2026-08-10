import { test, expect } from '@playwright/test';

// PROVENANCE — the rules that keep fabricated data from being read as real.
//
// ⭐ These assert INVARIANTS, not snapshots. The manual checks run while building this were
// snapshot-shaped ("exactly 6 gate cards"), which is brittle: one new gate and the suite fails for
// a non-bug. Every assertion here is a rule that must hold whatever the data does.
//
// This is the highest-value file in the suite, because the mistakes it catches are silent ones. On
// 2026-08-09 production was seeded with 180,003 synthetic events for demo volume. Nothing about a
// fabricated number looks wrong on screen — the whole defence is that findings exclude them in SQL
// and mixed views say so. Both halves are one careless edit from being untrue, and neither would
// throw.

const BANNER = /Includes seeded demo data/i;

test.describe('seeded-data labelling', () => {
  test('⭐ /gaps does NOT show the seeded banner — findings are real-only', async ({ page }) => {
    // The failure this prevents: someone hoists the banner into layout.tsx because that is less
    // code. It would then be shown on the ONE page whose numbers are entirely genuine — a false
    // label, undermining the only view a mod author should act on.
    await page.goto('/gaps');
    await expect(page.getByRole('heading', { name: /content gaps/i })).toBeVisible();
    await expect(page.getByText(BANNER)).toHaveCount(0);
  });

  test('/events DOES show the seeded banner — its volume is mostly generated', async ({ page }) => {
    // The paired allow case. Without it, "no banner on /gaps" is satisfied by deleting the banner
    // entirely, and the test above would still pass while every view lost its label.
    await page.goto('/events');
    await expect(page.getByText(BANNER).first()).toBeVisible();
  });

  test('the landing page labels the registry, not the finding', async ({ page }) => {
    // Placement is the difference between a true label and a false one: the banner describes the
    // volume figures below it, and the finding above it is computed from real play only.
    await page.goto('/');
    const banner = page.getByText(BANNER).first();
    await expect(banner).toBeVisible();

    const findingHeading = page.getByRole('heading', { name: /nothing in the loaded content/i });
    if ((await findingHeading.count()) > 0) {
      // Assert ORDER: the finding must appear before the banner in the document.
      const order = await page.evaluate(() => {
        const h = [...document.querySelectorAll('h2')].find((e) =>
          /nothing in the loaded content/i.test(e.textContent ?? ''),
        );
        const b = [...document.querySelectorAll('div,p')].find((e) =>
          /Includes seeded demo data/i.test(e.textContent ?? ''),
        );
        if (!h || !b) return null;
        // Node.DOCUMENT_POSITION_FOLLOWING === 4
        return (h.compareDocumentPosition(b) & 4) !== 0;
      });
      expect(order, 'the finding must render ABOVE the seeded-data banner').toBe(true);
    }
  });
});

test.describe('generated content is always marked as generated', () => {
  test('⭐ any rendered insight carries the generated+reviewed badge', async ({ page }) => {
    // A model-written sentence renders in the same font and the same confident register as a
    // computed one. The badge is the only thing distinguishing them, so an insight without it is
    // indistinguishable from a measurement.
    await page.goto('/gaps');

    const recommendations = page.getByText(/^Do this:/);
    const count = await recommendations.count();

    // Vacuously true if nothing is approved — assert the relationship, and say so when it is
    // untested rather than reporting a pass that examined nothing.
    test.skip(count === 0, 'no approved insight is live to check');

    const badges = page.getByText(/Generated · reviewed/);
    expect(await badges.count()).toBeGreaterThanOrEqual(count);
  });

  test('an insight that cites records shows them, so a reader can check it', async ({ page }) => {
    await page.goto('/gaps');
    const badge = page.getByText(/Generated · reviewed/).first();
    test.skip((await badge.count()) === 0, 'no approved insight is live to check');
    await expect(page.getByText(/Cited records:/).first()).toBeVisible();
  });
});
