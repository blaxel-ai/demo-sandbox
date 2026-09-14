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
console.log('Running dependency smoke test (js-yaml, nanoid, sharp)...');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

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
  //
  // CORRECTION (2026-08-13): this repo was originally bumped to 3.3.17,
  // read off GHSA-2v37-7h3g-55p8's own first_patched field at the time.
  // That advisory has since been revised (updated_at 2026-08-13) and now
  // lists first_patched 3.3.18, vulnerable_range "< 3.3.18" -- so 3.3.17
  // does not actually close this alert; re-pinned to 3.3.18.
  //
  // IMPORTANT: the two assertions below do NOT discriminate 3.3.17 from
  // 3.3.18. Diffing the two npm tarballs directly (`diff -rq`) shows only
  // one file differs beyond README/package.json: `async/index.native.js`
  // (the React Native async build), where `customRandom`'s size<=0 guard
  // was added in 3.3.18. The synchronous `index.cjs` build tested here --
  // the only one this repo's dependency graph (postcss's non-secure id
  // generator) ever reaches -- already had the size<=0 guard in 3.3.17;
  // verified by installing both versions fresh and calling
  // `customAlphabet('abcdef', 0)()` / `customRandom(...)` on each: both
  // return '' in <1ms, identically. So this test still correctly proves
  // the real 3.3.16 -> 3.3.17 hang fix (confirmed via the revert-check
  // below), but it cannot and does not prove 3.3.18 over 3.3.17 -- that
  // gap is unreachable code for this repo. Closure of this alert at 3.3.18
  // rests on matching the advisory's version floor plus the lockfile/
  // resolved-tree proof in the report, not on this test's output.
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

  // --- js-yaml: GHSA-2883-xcg3-v3hh (empty merge sources not charged) ---
  //
  // `maxTotalMergeKeys` (default 10000) is meant to bound the CPU spent on
  // `<<` merge keys, but before 4.3.2 an empty mapping `{}` in a merge
  // sequence was not counted, so `N` empty mappings merged `K` times cost
  // O(N*K) with the counter stuck at 0. 4.3.2 charges every merged source
  // (and hard-limits a merge sequence to 100 entries), so the document
  // below is rejected almost immediately with a YAMLException instead of
  // being processed in full. This is a bounded-behaviour assertion, not a
  // timing one: 4.3.1 loads this document successfully (in seconds), 4.3.2
  // throws. The advisory's own input shape is used, sized so a vulnerable
  // build still finishes in seconds rather than hanging the runner.
  const mergeCount = 5000;
  const mergeDoc =
    'arr: &arr [' + '{},'.repeat(mergeCount).slice(0, -1) + ']\n' +
    'targets:\n' +
    '  - <<: *arr\n'.repeat(mergeCount);
  const mergeStart = process.hrtime.bigint();
  assert.throws(
    () => yaml.load(mergeDoc),
    (error) => error instanceof yaml.YAMLException && /merge/i.test(error.message),
    'js-yaml accepted a merge sequence of thousands of empty mappings; 4.3.2 rejects it (GHSA-2883-xcg3-v3hh)',
  );
  const mergeMs = Number(process.hrtime.bigint() - mergeStart) / 1e6;
  assert.ok(mergeMs < 3000, `rejecting the merge document took ${mergeMs.toFixed(1)}ms; expected near-immediate`);
  console.log(`  ok - js-yaml rejected ${mergeCount} empty merge sources in ${mergeMs.toFixed(1)}ms`);

  // Legitimate merge keys must keep working after the fix.
  const merged = yaml.load('base: &base {a: 1, b: 2}\nchild:\n  <<: *base\n  b: 3\n');
  assert.deepEqual(merged.child, { a: 1, b: 3 });
  console.log('  ok - js-yaml still resolves an ordinary merge key');

  // --- sharp: GHSA-rgj7-g3m4-5g8c (libheif vulnerabilities, fixed in 0.35.4) ---
  //
  // sharp is not imported by this repo; it is Next.js's optional image
  // optimizer, pinned through `overrides` so both lockfiles resolve the
  // same copy. The fix is in the bundled libheif (1.23.2 ships with sharp
  // 0.35.4), so this loads sharp exactly the way Next.js does (resolved
  // from next's own directory, which also works under pnpm's strict layout),
  // checks the libheif the prebuilt binary carries, and runs a real
  // encode/decode round trip so a broken native binary fails here rather
  // than at the first optimized image in production.
  const nextDir = path.dirname(require.resolve('next/package.json'));
  const sharp = require(require.resolve('sharp', { paths: [nextDir] }));
  const heif = String(sharp.versions.heif || '');
  const [heifMajor, heifMinor, heifPatch] = heif.split('.').map(Number);
  assert.ok(
    heifMajor > 1 || (heifMajor === 1 && (heifMinor > 23 || (heifMinor === 23 && heifPatch >= 2))),
    `sharp ${sharp.versions.sharp} bundles libheif ${heif || '(unknown)'}, below the 1.23.2 that fixes GHSA-rgj7-g3m4-5g8c`,
  );
  sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 200, g: 20, b: 20 } } })
    .png()
    .toBuffer()
    .then((png) => sharp(png).resize(4, 3).png().toBuffer())
    .then((resized) => sharp(resized).metadata())
    .then((meta) => {
      assert.equal(meta.width, 4);
      assert.equal(meta.height, 3);
      assert.equal(meta.format, 'png');
      console.log(`  ok - sharp ${sharp.versions.sharp} (libheif ${heif}) encode/resize/decode round trip`);
      console.log('Dependency smoke test passed.');
    })
    .catch((error) => fail(error && error.stack ? error.stack : String(error)));

} catch (error) {
  fail(error && error.stack ? error.stack : String(error));
}
