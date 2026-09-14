// tests/test-next-runtime.js
//
// Runtime smoke for the Next.js dependency (GHSA-2xp9-vwfh-vxw4 and
// GHSA-p293-qw3h-jr36, fixed in 15.5.24). `next build` only proves the app
// still compiles against the new version; this starts the production server
// on the built output (`next start`, the same entry point production uses)
// and fetches real routes, so a runtime regression in the router or the
// server surfaces here instead of in production.
//
// Requires a prior `next build` (the dependency-verification workflow runs
// it right before this script). Exits non-zero on any failure.
console.log('Running Next.js runtime smoke test...');

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NEXT_BIN = require.resolve('next/dist/bin/next', { paths: [ROOT] });
const READY_TIMEOUT_MS = 60000;
const ROUTES = ['/', '/products', '/about', '/contact'];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server not ready after ${READY_TIMEOUT_MS}ms: ${lastError}`);
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    await waitForServer(base + '/', child);
    for (const route of ROUTES) {
      const response = await fetch(base + route);
      const body = await response.text();
      assert.equal(response.status, 200, `${route} returned ${response.status}`);
      assert.match(body, /<html/i, `${route} did not return an HTML document`);
      console.log(`  ok - GET ${route} -> 200 (${body.length} bytes)`);
    }
    // A route that does not exist must be a clean 404, not a crash.
    const missing = await fetch(base + '/definitely-not-a-route');
    assert.equal(missing.status, 404);
    console.log('  ok - GET /definitely-not-a-route -> 404');
    const version = require(require.resolve('next/package.json', { paths: [ROOT] })).version;
    console.log(`Next.js runtime smoke test passed (next ${version}).`);
  } catch (error) {
    console.error('Next.js runtime smoke test FAILED:', error && error.stack ? error.stack : String(error));
    console.error('--- next start output ---\n' + output.slice(-4000));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

main();
