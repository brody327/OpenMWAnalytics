import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventFilters } from './EventFilters';
import type { ModRow } from '../lib/events';

// THE FILTER BAR — the one place in the dashboard where real logic runs in the browser.
//
// This component holds no filter state: it reads filters from the URL and writes new ones back,
// and the answer arrives as fresh props from the server. So the ONLY externally visible thing it
// does is construct a URL and hand it to the router. That URL is therefore the entire contract,
// and asserting on it is asserting on the component's actual job — not on a mock.
//
// ⚠️ What is stubbed and why it is legitimate: `next/navigation` is a framework boundary with no
// implementation of ours behind it. `useSearchParams` is replaced by a real `URLSearchParams`
// (not a fake returning canned strings), and `router.push` is a spy that records the URL. The
// logic under test — which params are set, which are deleted, and what happens to the cursor —
// runs for real.

const push = vi.fn();
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/events',
  useSearchParams: () => params,
}));

const mods: ModRow[] = [
  { mod_id: 'ccff', display_name: 'Cell Crime & Faction Fixes', events: 1234 } as ModRow,
];

/** The query string the component last asked the router to navigate to. */
const pushedParams = () => new URLSearchParams(String(push.mock.calls.at(-1)?.[0]).split('?')[1]);

beforeEach(() => {
  push.mockClear();
  params = new URLSearchParams();
});

describe('EventFilters', () => {
  test('⭐⭐ changing a filter DROPS the cursor', async () => {
    // The load-bearing rule, and the one whose absence is invisible. A cursor encodes a position
    // within a specific ordering of a specific result set. Carried across a filter change it
    // points into a result set that no longer exists — so the page returns a wrong slice, with no
    // error, no empty state, and entirely plausible-looking rows. Nothing else in the system
    // would catch that.
    params = new URLSearchParams({ cursor: 'eyJ0cyI6MTIzfQ==', mod_id: 'ccff' });
    render(<EventFilters mods={mods} />);

    await userEvent.selectOptions(screen.getByLabelText('Event type'), 'AreaEntered');

    expect(push).toHaveBeenCalledOnce();
    const next = pushedParams();
    expect(next.get('cursor'), 'the stale cursor must not survive a filter change').toBeNull();
    expect(next.get('type')).toBe('AreaEntered');
    expect(next.get('mod_id'), 'unrelated filters must be preserved').toBe('ccff');
  });

  test('⭐ clearing a filter DELETES the param rather than setting it empty', async () => {
    // `?type=` is not the same request as no `type` at all: an empty string still travels
    // upstream and can be compared against, so the API would filter for events whose type is the
    // empty string and return nothing. The failure looks like "there is no data".
    params = new URLSearchParams({ type: 'AreaEntered' });
    render(<EventFilters mods={mods} />);

    await userEvent.selectOptions(screen.getByLabelText('Event type'), '');

    const next = pushedParams();
    expect(next.has('type'), 'the key itself must be gone, not merely blank').toBe(false);
    expect(String(push.mock.calls.at(-1)?.[0])).not.toContain('type=');
  });

  test('the session-id box commits on SUBMIT, not on every keystroke', async () => {
    // Draft state is local on purpose. Committing per character would mean a server round-trip
    // and a browser-history entry for every letter of a 36-character uuid — Back would need 36
    // presses to undo one filter.
    render(<EventFilters mods={mods} />);
    const input = screen.getByLabelText('Session id');

    await userEvent.type(input, 'abc');
    expect(push, 'typing alone must not navigate').not.toHaveBeenCalled();

    await userEvent.type(input, '{Enter}');
    expect(push).toHaveBeenCalledOnce();
    expect(pushedParams().get('session_id')).toBe('abc');
  });

  test('Clear removes every filter at once, and counts them honestly', async () => {
    params = new URLSearchParams({ mod_id: 'ccff', type: 'AreaEntered', env: 'dev' });
    render(<EventFilters mods={mods} />);

    const clear = screen.getByRole('button', { name: /clear 3 filters/i });
    await userEvent.click(clear);

    const next = pushedParams();
    for (const key of ['mod_id', 'type', 'env', 'session_id', 'suspect', 'topic']) {
      expect(next.has(key), `${key} survived Clear`).toBe(false);
    }
  });

  test('the Clear button is absent when nothing is filtered', () => {
    // The paired case for the count above: a button that always reads "Clear 3 filters" would
    // satisfy the previous test without the count ever being computed.
    render(<EventFilters mods={mods} />);
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  test('the mod dropdown reflects the URL rather than local state', () => {
    // Proves the "no second copy of the state" claim in the component's own header comment: the
    // control is driven by the URL, so a deep link renders in the correct state with no effect
    // syncing anything.
    params = new URLSearchParams({ mod_id: 'ccff' });
    render(<EventFilters mods={mods} />);
    expect(screen.getByLabelText('Mod')).toHaveValue('ccff');
  });
});
