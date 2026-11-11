// The fault-check fixtures (examples/benchmark-app/fault-fixtures/), run by
// `npm run benchmark:check` against a Bench Shop it serves itself
// (scripts/bench-shop-run.js sets BASE_URL). Never part of the main suite,
// whose testDir is tests/.
export default {
  testDir: '.',
  outputDir: '../../../test-results/fault-fixtures',
  timeout: 15000,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.BASE_URL, actionTimeout: 5000 },
};
