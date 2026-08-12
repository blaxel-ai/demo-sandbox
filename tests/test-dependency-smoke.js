// tests/test-dependency-smoke.js
//
// Smoke test for two dependency bumps that clear newly-surfaced high-severity
// Dependabot alerts: js-yaml (GHSA-5p4m-2wfm-xmqj) and nanoid
// (GHSA-2v37-7h3g-55p8 / GHSA-28wg-ghj8-5hjv). Both are dev-only transitives
// with no prior test coverage in this repo -- eslint's own @eslint/eslintrc
// chain pulls js-yaml, and postcss's non-secure id generator pulls nanoid --
// so this is new coverage, not a replacement for anything.
//
// Run standalone (`node tests/test-dependency-smoke.js`, wired as the
// `test:dependency-smoke` npm script) rather than folded into the existing
// `npm test` chain: that chain's tests/test3.js intentionally asserts a false
// statement and always exits 1 (see README/PR history -- a pre-existing,
// unrelated demo bug, not touched here), and the chain is `&&`-joined, so
// anything appended after it would never run. See the report for how this is
// wired into CI as its own step instead.
console.log('Running dependency smoke test (js-yaml, nanoid)...');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

function fail(message) {
  console.error(`Dependency smoke test FAILED: ${message}`);
  process.exit(1);
}

function buildOmapDocument(entryCount) {
  let doc = '--- !!omap\n';
  for (let i = 0; i < entryCount; i++) {
    doc += `- key${i}: ${i}\n`;
  }
  return doc;
}

try {
  // --- js-yaml: GHSA-5p4m-2wfm-xmqj (quadratic !!omap resolution) ---
  //
  // resolveYamlOmap() used Array.prototype.indexOf() in a loop to detect
  // duplicate keys, making a document with N !!omap entries cost O(n^2).
  // 4.3.1 replaces that with a Set-backed lookup (O(n)). Parsed output is
  // byte-identical before and after the fix, so only timing discriminates
  // the two versions -- there is no bounded-output assertion to fall back
  // on here.
  //
  // Calibrated directly against this tree's own installed copy (see report
  // VALIDATION): at n=150,000 the patched 4.3.1 here takes ~180-230ms
  // (min of 3), while a scratch install of the still-vulnerable 4.3.0 takes
  // ~9.9s on the identical document -- roughly a 45-55x gap. The 3000ms
  // bound below is a hang detector, not a performance benchmark: comfortable
  // margin above the patched timing and well below the vulnerable timing,
  // wide enough to absorb a slow/shared CI runner.
  const yaml = require('js-yaml');
  const entryCount = 150000;
  const omapDoc = buildOmapDocument(entryCount);

  const durationsMs = [];
  for (let i = 0; i < 3; i++) {
    const start = process.hrtime.bigint();
    const parsed = yaml.load(omapDoc);
    const end = process.hrtime.bigint();
    // js-yaml resolves !!omap to an array of single-key objects (order
    // preserved), not a Map -- confirmed against the installed copy.
    assert.ok(Array.isArray(parsed), 'yaml.load() did not resolve the document to an array for !!omap');
    assert.equal(parsed.length, entryCount, 'yaml.load() resolved the wrong number of !!omap entries');
    durationsMs.push(Number(end - start) / 1e6);
  }
  const minMs = Math.min(...durationsMs);
  assert.ok(
    minMs < 3000,
    `js-yaml took ${minMs.toFixed(1)}ms (min of 3 runs) to resolve a ${entryCount}-entry !!omap; ` +
      `the 4.3.1 fix for GHSA-5p4m-2wfm-xmqj keeps this under ~250ms here, while unpatched 4.3.0 ` +
      'takes ~9.9s on the identical input',
  );
  console.log(`  ok - js-yaml resolved a ${entryCount}-entry !!omap in ${minMs.toFixed(1)}ms (min of 3)`);

  // Small round trip too, so a totally broken parser (not just a slow one)
  // is also caught here.
  const roundTrip = yaml.load(yaml.dump({ a: 1, b: [2, 3], c: 'text' }));
  assert.deepEqual(roundTrip, { a: 1, b: [2, 3], c: 'text' });
  console.log('  ok - js-yaml dump/load round trip');

  // --- nanoid: GHSA-2v37-7h3g-55p8 / GHSA-28wg-ghj8-5hjv (size-0 hang) ---
  //
  // customAlphabet()/customRandom() built their id with a `while (true)`
  // loop that only stops once `id.length` reaches the requested size. For
  // size <= 0 that condition is never true, so the call hangs forever.
  // 3.3.17 (the max first_patched version on the 3.x line, clearing every
  // advisory on that line, not just the one this alert names) adds
  // `if (size <= 0) return ""` before the loop.
  //
  // A hung call cannot be observed from inside this same process without
  // blocking the whole test run forever (a genuine infinite loop, not just
  // a slow one), so this spawns a short-lived child process that requires
  // this tree's own installed nanoid copy (via require.resolve, not a
  // scratch install) and calls both functions with size 0. execFileSync's
  // own `timeout` kills the child if it does not return, turning a
  // regression into a clean, fast test failure instead of a stuck process.
  // Verified manually against a scratch install of nanoid@3.3.16 (the
  // version immediately before this fix line): the identical call never
  // returns and has to be killed.
  const nanoidEntryPoint = require.resolve('nanoid');
  const script = `
    const { customAlphabet, customRandom } = require(${JSON.stringify(nanoidEntryPoint)});
    const start = process.hrtime.bigint();
    const alphabetResult = customAlphabet("abcdef", 0)();
    const randomResult = customRandom("abcdef", 0, (size) => new Uint8Array(size))();
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    process.stdout.write(JSON.stringify({ alphabetResult, randomResult, elapsedMs }));
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    timeout: 5000,
    encoding: 'utf8',
  });
  const { alphabetResult, randomResult, elapsedMs } = JSON.parse(output);
  assert.equal(alphabetResult, '', 'customAlphabet(alphabet, 0)() must return an empty string, not hang');
  assert.equal(randomResult, '', 'customRandom(alphabet, 0, rng)() must return an empty string, not hang');
  assert.ok(elapsedMs < 1000, `expected a near-instant return, took ${elapsedMs.toFixed(1)}ms`);
  console.log(`  ok - nanoid customAlphabet/customRandom returned immediately for size 0 (${elapsedMs.toFixed(1)}ms)`);

  // Also exercise the actual production-adjacent call: postcss's
  // non-secure id generator (require("nanoid/non-secure").nanoid(6), see
  // node_modules/postcss/lib/input.js) is the one real consumer of this
  // package in this tree, and it always calls it with a fixed, hardcoded
  // size -- never the vulnerable zero-size shape -- so this just confirms
  // the bump did not disturb that path's normal behavior.
  const { nanoid } = require('nanoid/non-secure');
  const id = nanoid(6);
  assert.equal(typeof id, 'string');
  assert.equal(id.length, 6);
  console.log(`  ok - postcss's non-secure nanoid(6) entry point still produces a well-formed id ("${id}")`);

  console.log('Dependency smoke test passed.');
} catch (error) {
  fail(error && error.stack ? error.stack : String(error));
}
