import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// RTL does not auto-clean under Vitest's globals-off mode. Without this, each test renders into
// a document that still holds the previous test's DOM, and `getByRole` starts throwing
// "found multiple elements" — a failure that looks like a component bug and is not one.
afterEach(cleanup);
