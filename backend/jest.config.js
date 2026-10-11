/** @type {import('jest').Config} — CJS so `jest` runs without ts-node (P0 gate). */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // allowJs: @nestjs/passport@12 ships ESM .js files that must go through
    // ts-jest as well (tsconfig.json itself stays allowJs-off — typecheck unaffected).
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
  // Only @nestjs/passport is ESM ("type": "module"); everything else keeps the
  // default ignore so node_modules stays untransformed.
  transformIgnorePatterns: ['/node_modules/(?!(@nestjs/passport)/)'],
  // src/generated is the Prisma client output, rewritten on every `prisma
  // generate` — nothing in it is ours to test. main.ts is the Nest bootstrap,
  // which only runs when the app starts. Both were dragging the reported
  // percentages down (statements 91.52 -> 94.45, lines 92.44 -> 95.82).
  collectCoverageFrom: ['**/*.(t|j)s', '!generated/**', '!main.ts'],
  coverageDirectory: '../coverage',
  coverageReporters: ['text', 'json-summary'],
  testEnvironment: 'node',
  // P0 acceptance allows an empty suite; flip off once real specs land.
  passWithNoTests: true,
};
