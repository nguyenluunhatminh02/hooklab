import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest runs with `globals: false`, so Testing Library cannot self-register
// its cleanup hook — mount/unmount between tests here instead.
afterEach(() => {
  cleanup();
  localStorage.clear();
});
