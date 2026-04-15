/**
 * Same seed as test-env/seed-de-weighted-assessments.ts, using this folder's instance/.env.
 *
 * Run: bun test-env-postgres/seed-de-weighted-assessments.ts
 */
process.env.QUERYABLE_FORMULA_TEST_ENV ??= 'test-env-postgres';
await import(new URL('../test-env/seed-de-weighted-assessments.ts', import.meta.url).href);
