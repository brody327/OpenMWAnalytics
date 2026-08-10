import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchBox } from './SearchBox';

// SEARCH BOX — same contract as the filter bar: its whole observable job is deciding whether to
// navigate, and to what URL. Every test below is about a case where it must decide NOT to.
//
// That emphasis is deliberate. Hybrid retrieval is the most expensive query in the platform
// (tsvector + an HNSW probe + RRF fusion), so a search this component fires needlessly is not a
// wasted render — it is a wasted round of the costliest work the API does.

const push = vi.fn();
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => params,
}));

beforeEach(() => {
  push.mockClear();
  params = new URLSearchParams();
});

const box = () => screen.getByRole('searchbox', { name: /search the game corpus/i });

describe('SearchBox', () => {
  test('a query navigates to an encoded /search URL', async () => {
    render(<SearchBox />);
    await userEvent.type(box(), 'restore strength potion{Enter}');

    expect(push).toHaveBeenCalledOnce();
    // Encoding matters: an unescaped '&' or '#' in a query would truncate the search server-side
    // and silently return results for a prefix of what the user typed.
    expect(push).toHaveBeenCalledWith('/search?q=restore%20strength%20potion');
  });

  // ⚠️ THE NEXT TWO TESTS ARE WEAKER THAN THEIR NAMES SUGGEST — established by mutation, and
  // written down rather than left as a comfortable assumption.
  //
  // An empty box is blocked TWICE: `submit()` returns early on a blank query, and the submit
  // button is `disabled`, which also suppresses the form's implicit Enter submission. Removing
  // either guard alone leaves these two green; only removing BOTH turns them red (verified).
  //
  // They are kept because they pin the user-visible contract, which is what actually matters —
  // but they cannot detect a single-layer regression. `the trim guard holds on its own` below
  // covers that half by submitting the form directly, past the button.

  test('an EMPTY query does not search (contract; two layers enforce it)', async () => {
    render(<SearchBox />);
    await userEvent.type(box(), '{Enter}');
    expect(push).not.toHaveBeenCalled();
  });

  test('a whitespace-only query does not search either', async () => {
    // The case an emptiness check misses. Without the trim, '   ' is a non-empty string that
    // would run the full hybrid query and match nothing.
    render(<SearchBox />);
    await userEvent.type(box(), '   {Enter}');
    expect(push).not.toHaveBeenCalled();
  });

  test('⭐ the trim guard holds ON ITS OWN, with the disabled button bypassed', () => {
    // Submitting the <form> directly is not a contrived path: a browser fires implicit submission
    // from Enter in a text field, and whether a disabled submit button suppresses that has varied
    // across browsers. So this is both the isolation of layer two AND the real-world case where
    // layer one is the only thing standing.
    render(<SearchBox />);
    const input = box();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(push).not.toHaveBeenCalled();
  });

  test('⭐ re-submitting the query already in the URL does not search again', async () => {
    // Pressing Enter twice, or submitting an unchanged box after a page load, must be a no-op —
    // the results on screen are already the answer.
    params = new URLSearchParams({ q: 'mortar' });
    render(<SearchBox />);
    await userEvent.type(box(), '{Enter}');
    expect(push).not.toHaveBeenCalled();
  });

  test('the paired case: CHANGING the query does search', async () => {
    // Without this, every "does not search" test above is satisfied by a component that never
    // searches at all.
    params = new URLSearchParams({ q: 'mortar' });
    render(<SearchBox />);
    await userEvent.clear(box());
    await userEvent.type(box(), 'pestle{Enter}');
    expect(push).toHaveBeenCalledWith('/search?q=pestle');
  });

  test('the box is seeded from the URL, so a shared link renders its own query', async () => {
    params = new URLSearchParams({ q: 'mortar' });
    render(<SearchBox />);
    expect(box()).toHaveValue('mortar');
  });

  test('the submit button is disabled while the box is empty', () => {
    render(<SearchBox />);
    expect(screen.getByRole('button', { name: /search/i })).toBeDisabled();
  });
});
