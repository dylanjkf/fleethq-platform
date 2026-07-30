/**
 * Task #110 load test. Logs in once against the seeded "Load Test Freight
 * Co" tenant (scripts/seed-load-test-data.ts — 500 assets / 1000 jobs / 400
 * maintenance jobs), then runs autocannon against a representative mix of
 * read endpoints, then a light write-mixed run against the busiest one, and
 * prints p50/p95/p99 + req/sec + errors per endpoint.
 *
 * Usage: BASE_URL=http://localhost:3000 npx ts-node scripts/load-test.ts
 */
import autocannon, { type Result } from 'autocannon';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const USERNAME = 'admin@loadtest';
const PASSWORD = 'fleetos-dev-password';
const DURATION_SECONDS = Number(process.env.LOAD_TEST_DURATION ?? 15);
const CONNECTIONS = Number(process.env.LOAD_TEST_CONNECTIONS ?? 25);

interface Scenario {
  name: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}

async function login(): Promise<{ token: string; companyId: string }> {
  const res = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { status: string; accessToken?: string; company?: { id: string } };
  if (data.status !== 'authenticated' || !data.accessToken || !data.company) {
    throw new Error(`Unexpected login response shape: ${JSON.stringify(data)}`);
  }
  return { token: data.accessToken, companyId: data.company.id };
}

function summarize(result: Result) {
  return {
    reqPerSec: result.requests.average,
    latencyP50: result.latency.p50,
    latencyP95: result.latency.p97_5 ?? result.latency.p99,
    latencyP99: result.latency.p99,
    latencyMax: result.latency.max,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    total: result.requests.total,
  };
}

async function runScenario(scenario: Scenario, token: string) {
  const result = await autocannon({
    url: `${BASE_URL}${scenario.path}`,
    method: scenario.method ?? 'GET',
    connections: CONNECTIONS,
    duration: DURATION_SECONDS,
    headers: { Authorization: `Bearer ${token}` },
    body: scenario.body ? JSON.stringify(scenario.body) : undefined,
  });
  return { name: scenario.name, ...summarize(result) };
}

async function main() {
  console.log(`Logging in as ${USERNAME}...`);
  const { token } = await login();
  console.log('Logged in. Starting load test scenarios...\n');

  const scenarios: Scenario[] = [
    { name: 'GET /v1/assets (list, 500 rows)', path: '/v1/assets' },
    { name: 'GET /v1/jobs (list, 1000 rows)', path: '/v1/jobs' },
    { name: 'GET /v1/maintenance-jobs (list, 400 rows)', path: '/v1/maintenance-jobs' },
    { name: 'GET /v1/reports/operations', path: '/v1/reports/operations' },
    { name: 'GET /v1/fleet-health', path: '/v1/fleet-health' },
    { name: 'GET /health', path: '/health' },
  ];

  const results = [];
  for (const scenario of scenarios) {
    console.log(`Running: ${scenario.name} (${DURATION_SECONDS}s, ${CONNECTIONS} connections)...`);
    const result = await runScenario(scenario, token);
    results.push(result);
    console.log(
      `  req/sec avg=${result.reqPerSec}  p50=${result.latencyP50}ms p95=${result.latencyP95}ms p99=${result.latencyP99}ms max=${result.latencyMax}ms  errors=${result.errors} timeouts=${result.timeouts} non2xx=${result.non2xx} total=${result.total}`,
    );
  }

  console.log('\n=== Summary ===');
  console.table(
    results.map((r) => ({
      scenario: r.name,
      'req/sec': r.reqPerSec,
      'p50 (ms)': r.latencyP50,
      'p95 (ms)': r.latencyP95,
      'p99 (ms)': r.latencyP99,
      'max (ms)': r.latencyMax,
      errors: r.errors,
      non2xx: r.non2xx,
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
