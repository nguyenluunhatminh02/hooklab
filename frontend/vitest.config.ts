import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Vitest 4 config key is `retry` (not the pre-4 `retries`; tsc rejects
    // `retries` — TS2769 — and the build typechecks this file via `tsc
    // --noEmit`). Repo convention (automation/ADVANCED.md): CI retries against
    // flaky network, local fails fast — never hide a flaky test.
    retry: process.env.CI ? 2 : 0,
    // The userEvent tree across 19 specs is > 5 s under machine contention;
    // 5 s default timed out twice during the 2026-10-10 verification (A′).
    testTimeout: 10_000,
    // Vitest 4 dropped `coverage.all`; a set `include` now does that job, so
    // every instrumentable file under src lands in the report even when no
    // spec imports it directly. main.tsx is the browser entry (nothing mounts
    // it under jsdom), src/test is setup plus its own spec, and the CSS files
    // carry no statements to count.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**'],
      exclude: [
        'src/main.tsx',
        'src/**/*.spec.{ts,tsx}',
        'src/test/**',
        'src/**/*.css',
      ],
    },
  },
});
