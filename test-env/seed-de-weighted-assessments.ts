/**
 * Applies de_NDR (stub) + de_weighted_assessments to a running local Directus test instance.
 *
 * Prereqs: `bun run test:setup` then start Directus (`bun run test` or start.sh).
 * Postgres: `bun run test:pg:setup` then `bun run test:pg:start`, then `bun run test:pg:seed`
 * (or `bun test-env-postgres/seed-de-weighted-assessments.ts`).
 *
 * Schema JSON is always read from `test-env/schema/` (shared with test-env-postgres).
 *
 * Run: bun test-env/seed-de-weighted-assessments.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const marker = join(d, 'test-env', 'schema', 'de-weighted-assessments-fields.json');
    if (existsSync(marker)) return d;
    const parent = dirname(d);
    if (parent === d) {
      throw new Error(
        'Could not find repo root (missing test-env/schema/de-weighted-assessments-fields.json)',
      );
    }
    d = parent;
  }
}

const repoRoot = findRepoRoot();
const FIELDS_PATH = join(repoRoot, 'test-env', 'schema', 'de-weighted-assessments-fields.json');

/** Directory of the running script (test-env or test-env-postgres). */
const scriptPackageDir = dirname(fileURLToPath(import.meta.url));
/** Root of the env that contains `instance/` and `.env`. */
const testInstanceEnvRoot = process.env.QUERYABLE_FORMULA_TEST_ENV
  ? resolve(process.cwd(), process.env.QUERYABLE_FORMULA_TEST_ENV)
  : scriptPackageDir;

const COLLECTION = 'de_weighted_assessments';

function loadEnvFromInstance() {
  const envFile = join(testInstanceEnvRoot, 'instance', '.env');
  if (!existsSync(envFile)) return;
  const text = readFileSync(envFile, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFromInstance();

function omitNulls<T>(v: T): T {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(omitNulls) as T;
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) continue;
      o[k] = omitNulls(val);
    }
    return o as T;
  }
  return v;
}

async function api(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${PUBLIC_URL}${path}`, { ...init, headers });
}

async function login(): Promise<string> {
  const res = await fetch(`${PUBLIC_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(
      `Login failed (${res.status}): ${await res.text()}\n` +
        `Is Directus running at ${PUBLIC_URL}?`,
    );
  }
  const json = (await res.json()) as { data?: { access_token?: string } };
  const token = json.data?.access_token;
  if (!token) throw new Error('No access_token in login response');
  return token;
}

async function ensureCollection(token: string, body: Record<string, unknown>, name: string) {
  const get = await api(token, `/collections/${name}`);
  if (get.ok) {
    console.log(`→ Collection '${name}' already exists, skipping create.`);
    return;
  }
  const res = await api(token, '/collections', {
    method: 'POST',
    body: JSON.stringify(omitNulls(body)),
  });
  if (!res.ok) {
    throw new Error(`Create collection '${name}' failed: ${res.status} ${await res.text()}`);
  }
  console.log(`→ Created collection '${name}'.`);
}

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://127.0.0.1:8055';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin';

const deNdr = {
  collection: 'de_NDR',
  meta: {
    icon: 'badge',
    note: 'Stub subjects collection for de_weighted_assessments.subject (test seed)',
    display_template: '{{name}} ({{identification}})',
  },
  schema: {},
  fields: [
    {
      field: 'id',
      type: 'integer',
      meta: {
        hidden: true,
        interface: 'input',
        readonly: true,
        width: 'full',
      },
      schema: {
        is_primary_key: true,
        has_auto_increment: true,
        is_nullable: false,
      },
    },
    {
      field: 'name',
      type: 'string',
      meta: { interface: 'input', width: 'full' },
      schema: { is_nullable: true },
    },
    {
      field: 'identification',
      type: 'string',
      meta: { interface: 'input', width: 'full' },
      schema: { is_nullable: true },
    },
  ],
};

const rawFields = JSON.parse(readFileSync(FIELDS_PATH, 'utf8')) as Record<string, unknown>[];

const mainPayload = {
  collection: COLLECTION,
  meta: {
    icon: 'assignment',
    note: 'DE weighted assessments (seeded for queryable-formula test env)',
  },
  schema: {},
  fields: rawFields.map((f) => omitNulls(f)),
};

await (async function main() {
  console.log(`Using Directus at ${PUBLIC_URL}`);
  const token = await login();
  await ensureCollection(token, deNdr, 'de_NDR');
  await ensureCollection(token, mainPayload, COLLECTION);
  console.log('Done.');
})();
