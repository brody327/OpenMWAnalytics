// Rendered when notFound() is thrown in this segment (an unknown mod id). Next maps
// this to a 404 status automatically. It is a Server Component and takes no props --
// the reason it renders is "the resource does not exist", so there is nothing to pass.

import Link from 'next/link';

export default function ModNotFound() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Mod not found</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        No mod with that id has reported any telemetry yet.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block text-sm underline decoration-dotted underline-offset-4"
      >
        ← Back to overview
      </Link>
    </main>
  );
}
