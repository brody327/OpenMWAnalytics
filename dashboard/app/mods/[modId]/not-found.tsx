// Rendered when notFound() is thrown in this segment (an unknown mod id). Next maps
// this to a 404 status automatically. It is a Server Component and takes no props --
// the reason it renders is "the resource does not exist", so there is nothing to pass.

import Link from 'next/link';

export default function ModNotFound() {
  return (
    <main className="mx-auto w-full max-w-[920px] px-7 pt-10 pb-20">
      <h1 className="font-display text-[26px] font-semibold text-text">Mod not found</h1>
      <p className="mt-2.5 text-sm text-text-muted">
        No mod with that id has reported any telemetry yet.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block text-[13px] text-text-muted underline decoration-dotted underline-offset-4 transition-colors hover:text-text"
      >
        ← Back to overview
      </Link>
    </main>
  );
}
