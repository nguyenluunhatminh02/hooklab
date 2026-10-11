/** @type {import('jest').Config} — e2e run: rootDir repo-relative so backend/test/ matches. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(@nestjs/passport)/)'],
  testEnvironment: 'node',
  testTimeout: 60000,
};
