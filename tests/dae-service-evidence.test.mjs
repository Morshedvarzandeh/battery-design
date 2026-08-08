import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const javascriptTestNames = (source) => [...source.matchAll(
  /^test\('([^']+)'/gmu,
)].map((match) => match[1]);
const rustTestNames = (source) => [...source.matchAll(
  /^\s*#\[test\]\s*\n\s*fn\s+([a-z0-9_]+)\s*\(/gmu,
)].map((match) => match[1]);
const namesSha256 = (names) => createHash('sha256')
  .update(`${names.join('\n')}\n`, 'utf8')
  .digest('hex');

const SERVICE_PROTOCOL_BASELINE_TREE = '789bfc8f560d4e090466f98a29c27d9e20ba3b31';
const SERVICE_PROTOCOL_BASELINE_SOURCE_COUNTS = Object.freeze({
  'tests/api.test.mjs': 17,
  'tests/packaged-tree.test.mjs': 4,
  'tests/runner-security.test.mjs': 9,
  'tests/simulation-worker.test.mjs': 5,
});
const SERVICE_PROTOCOL_NAME_FILTER = /\b(runner|worker|protocol|server|staging|package|bootstrap|ports?|fallback|malformed|unbounded|cancels?|isolated)\b/u;
const SERVICE_PROTOCOL_POPULATION_SHA256 = 'd2746feb185d4b9819ea94c9314bb0a6e6d0138ef63930d2c128b37a4ca6dc9f';
const SERVICE_PROTOCOL_MATCHES_SHA256 = '59d29f9629e3c8a14331206411f177b94970f01e3c33f0a625f7a493e1fbcbf0';

// Frozen from the four sources above at the post-KLU Iteration 4 tree. This
// historical function-name population is a denominator, not a live count.
const SERVICE_PROTOCOL_POPULATION = Object.freeze([
  'CLI range guards fail readably instead of hanging',
  'CLI reports modeled thermal peak separately from the cell rating',
  'EU passport applicability is one governed result across API, findings and ontology',
  'Godot uses the hashed shell bridge instead of JavaScript eval',
  'Tauri generates a cryptographic token, authenticates readiness and has a CSP fallback',
  'a one-field specification produces a complete, honest design',
  'bus sizing includes passenger load and a client-supplied route',
  'desktop bootstrap scrubs the URL token and attaches it to every API call',
  'every application designs without throwing',
  'governed custom marine traces survive the API and foreign policies are refused',
  'headless marine output identifies both vessels and keeps TwinShip evidence honest',
  'installed-package smoke canonicalizes artifact paths before apt sees Tauri filenames',
  'installed-package smoke launches the Cargo GUI instead of an arbitrary sidecar',
  'listings are complete and self-describing',
  'marine shore equipment is governed identically by the headless API contract',
  'one canonical marine policy trace owns energy, S/P and trace identity',
  'runner FMU export binds one strict DesignSpec to the returned port and layout resources',
  'runner is authenticated, loopback-only in its advertised URL, and reports real surfaces',
  'runner refuses privileged/default HTTP ports whose browser origin is ambiguous',
  'runner rejects malformed paths and unbounded work without terminating',
  'semantic claims are generated, never accepted from the caller',
  'software clients can select a policy without losing profileId compatibility',
  'staged desktop tree imports and starts from an isolated output',
  'staging refuses repository children and arbitrary existing directories',
  'the MCP server fails safely',
  'the MCP server speaks the protocol and returns real answers',
  'the brief answers the questions a customer actually asks',
  'the headless engine agrees with the modules the UI uses',
  'the result is plain data — it survives JSON without loss',
  'unknown inputs are corrected in the open, never silently',
  'worker client cancels stale work and accepts only the latest answer',
  'worker client reports an explicit unavailable fallback boundary',
  'worker dispatcher returns the identical advanced simulation',
  'worker dispatcher returns the identical level-1 simulation',
  'worker threshold counts profile, passes, charging and comparisons',
]);

const SERVICE_PROTOCOL_MATCHES = Object.freeze([
  'Tauri generates a cryptographic token, authenticates readiness and has a CSP fallback',
  'desktop bootstrap scrubs the URL token and attaches it to every API call',
  'installed-package smoke canonicalizes artifact paths before apt sees Tauri filenames',
  'installed-package smoke launches the Cargo GUI instead of an arbitrary sidecar',
  'runner FMU export binds one strict DesignSpec to the returned port and layout resources',
  'runner is authenticated, loopback-only in its advertised URL, and reports real surfaces',
  'runner refuses privileged/default HTTP ports whose browser origin is ambiguous',
  'runner rejects malformed paths and unbounded work without terminating',
  'staged desktop tree imports and starts from an isolated output',
  'staging refuses repository children and arbitrary existing directories',
  'the MCP server fails safely',
  'the MCP server speaks the protocol and returns real answers',
  'worker client cancels stale work and accepts only the latest answer',
  'worker client reports an explicit unavailable fallback boundary',
  'worker dispatcher returns the identical advanced simulation',
  'worker dispatcher returns the identical level-1 simulation',
  'worker threshold counts profile, passes, charging and comparisons',
]);

const PHASE_1_FRAMING_CASES = Object.freeze([
  'framing_canonical_request_round_trips_as_one_frame',
  'framing_header_split_at_every_byte_boundary_reassembles_once',
  'framing_payload_split_at_every_byte_boundary_reassembles_once',
  'framing_extra_bytes_or_second_frame_fail_closed',
  'framing_bad_magic_is_rejected_before_payload_read',
  'framing_unknown_version_or_wrong_message_kind_fail_closed',
  'framing_zero_length_is_rejected_before_json_decode',
  'framing_over_limit_length_is_rejected_before_payload_allocation',
  'framing_eof_during_header_or_payload_emits_no_frame',
]);
const PHASE_1_FRAMING_CASES_SHA256 = '018c01d9953e9e659f1816831ef73d305c20ffd7b00b199ca5515b493fc1d106';
const PLANNED_SERVICE_CAMPAIGN_TARGET_COUNTS = Object.freeze([9, 9, 9, 9, 10]);

test('service protocol denominator freezes the post-KLU 35-name process boundary', () => {
  assert.equal(SERVICE_PROTOCOL_BASELINE_TREE, '789bfc8f560d4e090466f98a29c27d9e20ba3b31');
  assert.deepEqual(SERVICE_PROTOCOL_BASELINE_SOURCE_COUNTS, {
    'tests/api.test.mjs': 17,
    'tests/packaged-tree.test.mjs': 4,
    'tests/runner-security.test.mjs': 9,
    'tests/simulation-worker.test.mjs': 5,
  });
  assert.equal(
    Object.values(SERVICE_PROTOCOL_BASELINE_SOURCE_COUNTS)
      .reduce((total, count) => total + count, 0),
    35,
  );
  assert.equal(SERVICE_PROTOCOL_POPULATION.length, 35);
  assert.equal(new Set(SERVICE_PROTOCOL_POPULATION).size, 35);
  assert.deepEqual(SERVICE_PROTOCOL_POPULATION, [...SERVICE_PROTOCOL_POPULATION].sort());
  assert.equal(namesSha256(SERVICE_PROTOCOL_POPULATION), SERVICE_PROTOCOL_POPULATION_SHA256);
  assert.equal(
    SERVICE_PROTOCOL_NAME_FILTER.source,
    '\\b(runner|worker|protocol|server|staging|package|bootstrap|ports?|fallback|malformed|unbounded|cancels?|isolated)\\b',
  );
  assert.equal(SERVICE_PROTOCOL_NAME_FILTER.flags, 'u', 'the filter is exact and case-sensitive');
  assert.deepEqual(
    SERVICE_PROTOCOL_POPULATION.filter((name) => SERVICE_PROTOCOL_NAME_FILTER.test(name)),
    SERVICE_PROTOCOL_MATCHES,
  );
  assert.equal(SERVICE_PROTOCOL_MATCHES.length, 17);
  assert.equal(namesSha256(SERVICE_PROTOCOL_MATCHES), SERVICE_PROTOCOL_MATCHES_SHA256);

  const retainedCurrentNames = new Set(
    Object.keys(SERVICE_PROTOCOL_BASELINE_SOURCE_COUNTS)
      .flatMap((path) => javascriptTestNames(read(path))),
  );
  for (const name of SERVICE_PROTOCOL_POPULATION) {
    assert.ok(retainedCurrentNames.has(name), `retained post-KLU baseline case: ${name}`);
  }
});

test('Phase 1 owns the exact nine-case framing roster and remains partial evidence', () => {
  const manifest = read('rust-dae-service/Cargo.toml');
  const framingNames = rustTestNames(read('rust-dae-service/tests/service_framing_campaign.rs'));

  assert.match(
    manifest,
    /\[\[test\]\]\s*name = "service_framing_campaign"\s*path = "tests\/service_framing_campaign\.rs"/u,
  );
  assert.equal(framingNames.length, 9);
  assert.equal(new Set(framingNames).size, 9);
  assert.deepEqual([...framingNames].sort(), [...PHASE_1_FRAMING_CASES].sort());
  assert.equal(
    namesSha256([...framingNames].sort()),
    PHASE_1_FRAMING_CASES_SHA256,
  );

  assert.equal(SERVICE_PROTOCOL_MATCHES.length, 17);
  assert.equal((framingNames.length / SERVICE_PROTOCOL_MATCHES.length).toFixed(2), '0.53');
  assert.ok(framingNames.length < 2 * SERVICE_PROTOCOL_MATCHES.length);
  const plannedCampaignCases = PLANNED_SERVICE_CAMPAIGN_TARGET_COUNTS
    .reduce((total, count) => total + count, 0);
  assert.equal(plannedCampaignCases, 46);
  assert.ok(plannedCampaignCases >= 2 * SERVICE_PROTOCOL_MATCHES.length);
  assert.equal((plannedCampaignCases / SERVICE_PROTOCOL_MATCHES.length).toFixed(2), '2.71');
});

test('isolated Rust 1.77.2 CI executes exactly nine framing cases in both profiles', () => {
  const workflow = read('.github/workflows/ci.yml');
  const start = workflow.indexOf('\n  dae-service-protocol:');
  const end = workflow.indexOf('\n  sundials-native-build:', start);
  assert.ok(start >= 0 && end > start, 'the isolated service-protocol job is present');
  const job = workflow.slice(start, end);

  assert.match(job, /toolchain: 1\.77\.2/u);
  assert.match(job, /RUSTFLAGS: -Dwarnings/u);
  assert.match(job, /CARGO_TARGET_DIR=\$RUNNER_TEMP\/battery-design-dae-service-target/u);
  assert.equal(
    (job.match(/cargo test --locked(?: --release)? --manifest-path rust-dae-service\/Cargo\.toml \\\n\s*--test service_framing_campaign/gu) ?? []).length,
    2,
  );
  assert.equal(
    (job.match(/Exercise exactly 9 service framing cases in (?:debug|release)/gu) ?? []).length,
    2,
  );
  assert.equal(
    (job.match(/test result: ok\\\. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;/gu) ?? []).length,
    2,
  );
  assert.equal((job.match(/grep -Ec '\^test result:'/gu) ?? []).length, 2);
  assert.match(workflow, /Isolated source-only framing gate[\s\S]*does not launch a service process,[\s\S]*call a native solver,[\s\S]*product artifact/iu);
});

test('guide reports Phase 1 framing evidence without claiming a service runtime', () => {
  const guide = read('docs/EQUATION_SOLVER.md').replace(/\s+/gu, ' ');

  assert.match(guide, /native service Phase 1: framing only[\s\S]*source-only `rust-dae-service\/`[\s\S]*codec boundary, not a service runtime/i);
  assert.match(guide, /does not open a listener[\s\S]*spawn or supervise[\s\S]*call the dense or KLU backend[\s\S]*return a native solve result[\s\S]*release artifact/i);
  assert.match(guide, /JSON\.stringify\(-0\)[\s\S]*exact little-endian bytes[\s\S]*canonical standard base64[\s\S]*exact `f64` bits[\s\S]*not evidence that a native solver has consumed/i);
  assert.match(guide, /789bfc8f560d4e090466f98a29c27d9e20ba3b31[\s\S]*35 test names[\s\S]*case-sensitive word-boundary filter[\s\S]*produces 17 matches/i);
  assert.match(guide, /d2746feb185d4b9819ea94c9314bb0a6e6d0138ef63930d2c128b37a4ca6dc9f[\s\S]*59d29f9629e3c8a14331206411f177b94970f01e3c33f0a625f7a493e1fbcbf0/i);
  assert.match(guide, /nine-case framing target is partial[\s\S]*9 \/ 17 = 0\.53[\s\S]*not a two-times claim[\s\S]*46 cases[\s\S]*9 \+ 9 \+ 9 \+ 9 \+ 10[\s\S]*46 \/ 17 = 2\.71[\s\S]*only after all five targets exist and pass/i);
  assert.match(guide, /remaining 37 planned cases[\s\S]*service process[\s\S]*request-to-solver mapping[\s\S]*not implemented by Phase 1/i);
  assert.match(guide, /does not provide index reduction[\s\S]*qualify general implicit DAEs[\s\S]*expose a native service or desktop integration[\s\S]*WebAssembly ABI/i);
});

test('canonical f64 wire fixes the demonstrated JSON signed-zero loss', () => {
  assert.equal(JSON.stringify(-0), '0');
  const jsonDecoded = JSON.parse(JSON.stringify(-0));
  assert.ok(Object.is(jsonDecoded, 0));
  assert.ok(!Object.is(jsonDecoded, -0));

  const protocol = read('rust-dae-service/src/protocol.rs');
  const campaign = read('rust-dae-service/tests/service_framing_campaign.rs');
  assert.match(protocol, /pub struct F64BlockWire/u);
  assert.match(protocol, /pub fn from_values[\s\S]*to_le_bytes/u);
  assert.match(protocol, /pub fn decode_values[\s\S]*decode_base64[\s\S]*from_le_bytes/u);
  assert.match(protocol, /fn encode_base64/u);
  assert.match(protocol, /fn decode_base64/u);
  assert.match(protocol, /ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\+\//u);
  assert.match(campaign, /framing_canonical_request_round_trips_as_one_frame[\s\S]*-0\.0_f64[\s\S]*to_bits\(\)/u);
  assert.match(campaign, /invalid_base64[\s\S]*noncanonical_padding[\s\S]*F64BlockError::NonCanonicalBase64/u);
});
