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
const PHASE_2_ADMISSION_CASES = Object.freeze([
  'admission_invalid_utf8_is_rejected_before_request_construction',
  'admission_malformed_or_trailing_json_is_rejected_atomically',
  'admission_duplicate_keys_and_unknown_fields_fail_closed',
  'admission_missing_or_mismatched_contract_identity_fails_closed',
  'admission_request_byte_limit_reaches_decode_exactly_and_plus_one_fails_preallocation',
  'admission_dense_dimension_limit_passes_exactly_and_plus_one_fails',
  'admission_klu_dimension_nonzero_and_known_csc_limits_are_independent',
  'admission_output_row_and_result_value_limits_are_independent',
  'admission_sum_fan_in_and_total_input_slot_limits_fail_preallocation',
]);
const PHASE_2_ADMISSION_CASES_SOURCE_ORDER_SHA256 = '6e8e25774ee7036954a772fcf2bf7f397fc6a53fbf845597fff1ae605f5ea9b4';
const PHASE_2_ADMISSION_CASES_SHA256 = 'f2f0564db3d6c6da82b23ccb67314092890629fc9bd40f32c1f53df098099274';
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

test('Phase 1 owns the exact nine-case framing roster', () => {
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

});

test('Phase 2 owns the revised nine-case admission roster and cumulative evidence remains partial', () => {
  const manifest = read('rust-dae-service/Cargo.toml');
  const admissionNames = rustTestNames(read('rust-dae-service/tests/service_admission_campaign.rs'));

  assert.match(
    manifest,
    /\[\[test\]\]\s*name = "service_admission_campaign"\s*path = "tests\/service_admission_campaign\.rs"/u,
  );
  assert.equal(admissionNames.length, 9);
  assert.equal(new Set(admissionNames).size, 9);
  assert.deepEqual(admissionNames, PHASE_2_ADMISSION_CASES);
  assert.equal(
    namesSha256(admissionNames),
    PHASE_2_ADMISSION_CASES_SOURCE_ORDER_SHA256,
  );
  assert.equal(
    namesSha256([...admissionNames].sort()),
    PHASE_2_ADMISSION_CASES_SHA256,
  );

  const currentCampaignCases = PHASE_1_FRAMING_CASES.length + admissionNames.length;
  assert.equal(currentCampaignCases, 18);
  assert.equal((currentCampaignCases / SERVICE_PROTOCOL_MATCHES.length).toFixed(2), '1.06');
  assert.ok(currentCampaignCases < 2 * SERVICE_PROTOCOL_MATCHES.length);
  const plannedCampaignCases = PLANNED_SERVICE_CAMPAIGN_TARGET_COUNTS
    .reduce((total, count) => total + count, 0);
  assert.equal(plannedCampaignCases, 46);
  assert.ok(plannedCampaignCases >= 2 * SERVICE_PROTOCOL_MATCHES.length);
  assert.equal((plannedCampaignCases / SERVICE_PROTOCOL_MATCHES.length).toFixed(2), '2.71');
});

test('Phase 2 source orders bounded admission before core allocation and native validation', () => {
  const admission = read('rust-dae-service/src/admission.rs');
  const protocol = read('rust-dae-service/src/protocol.rs');
  const campaign = read('rust-dae-service/tests/service_admission_campaign.rs');
  const coreDae = read('rust-core/src/dae.rs');
  const coreEquations = read('rust-core/src/equations.rs');
  const native = read('rust-dae-native/src/lib.rs');

  assert.match(admission, /pub const MAX_SUM_FAN_IN: usize = 4_096;/u);
  assert.match(admission, /pub const MAX_TOTAL_INPUT_SLOTS: usize = 100_000;/u);
  assert.match(admission, /pub const MAX_ALGEBRAIC_ITERATIONS: usize = 100;/u);
  assert.match(admission, /pub const MAX_IMPLICIT_ITERATIONS: usize = 100;/u);
  assert.match(admission, /pub const MAX_CYCLIC_ALGEBRAIC_VARIABLES: usize = 256;/u);
  assert.match(admission, /pub const MAX_KLU_DIMENSION: usize = 10_000;/u);
  assert.match(admission, /pub const MAX_KLU_NONZEROS: usize = 30_000;/u);
  assert.match(admission, /pub const MAX_KLU_KNOWN_CSC_BYTES: usize = 720 \* 1024;/u);
  assert.match(admission, /MAX_DENSE_DIMENSION as NATIVE_MAX_DENSE_DIMENSION[\s\S]*MAX_KLU_DIMENSION as NATIVE_MAX_KLU_DIMENSION/u);
  assert.match(admission, /assert!\(MAX_DENSE_DIMENSION <= NATIVE_MAX_DENSE_DIMENSION\);[\s\S]*assert!\(MAX_KLU_DIMENSION <= NATIVE_MAX_KLU_DIMENSION\);[\s\S]*assert!\(MAX_KLU_NONZEROS <= NATIVE_MAX_KLU_NONZEROS\);[\s\S]*assert!\(MAX_KLU_KNOWN_CSC_BYTES <= NATIVE_MAX_KLU_KNOWN_CSC_BYTES\);/u);
  assert.match(native, /pub const MAX_KLU_NONZEROS: usize = 1_000_000;/u);
  assert.match(native, /pub const MAX_KLU_KNOWN_CSC_BYTES: usize = 64 \* 1024 \* 1024;/u);

  assert.match(admission, /pub fn admit_request_frame[\s\S]*check_declared_block\(&request\.graph_transport[\s\S]*decode_finite_block\(&request\.graph_transport[\s\S]*preflight_graph_transport\(&graph_values[\s\S]*decode_graph_transport\(&graph_values[\s\S]*check_transport_settings\(&decoded\.settings[\s\S]*summary\.has_algebraic_loop[\s\S]*DaeResidualSystem::lower[\s\S]*settings\s*\.validate_for\(&system\)/u);
  assert.match(admission, /fn check_declared_block[\s\S]*checked_mul\(std::mem::size_of::<f64>\(\)\)[\s\S]*checked_add\(2\)[\s\S]*checked_div\(3\)[\s\S]*checked_mul\(4\)[\s\S]*block\.data\.len\(\) != encoded_bytes[\s\S]*EncodedLengthMismatch/u);
  assert.match(admission, /fn preflight_graph_transport[\s\S]*AdmissionLimit::SumFanIn[\s\S]*MAX_SUM_FAN_IN[\s\S]*checked_add\(inputs\)[\s\S]*AdmissionLimit::TotalInputSlots[\s\S]*MAX_TOTAL_INPUT_SLOTS/u);
  assert.match(admission, /fn check_transport_settings[\s\S]*AdmissionLimit::AlgebraicIterations[\s\S]*MAX_ALGEBRAIC_ITERATIONS[\s\S]*AdmissionLimit::ImplicitIterations[\s\S]*MAX_IMPLICIT_ITERATIONS/u);
  assert.match(admission, /NativeDaeBackendWire::Dense => \{[\s\S]*AdmittedNativeSettings::Dense\(settings\),[\s\S]*NativeExecutionAvailability::Unavailable \{[\s\S]*backend: NATIVE_IDA_BACKEND_ID,[\s\S]*required_feature: REQUIRED_FEATURE,/u);
  assert.match(admission, /NativeDaeBackendWire::Klu => \{[\s\S]*AdmittedNativeSettings::Klu\(settings\),[\s\S]*NativeExecutionAvailability::Unavailable \{[\s\S]*backend: NATIVE_IDA_KLU_BACKEND_ID,[\s\S]*required_feature: REQUIRED_KLU_FEATURE,/u);
  assert.doesNotMatch(admission, /IdaDenseBackend|IdaKluBackend|SUNLinSol_|\bunsafe\b|\bffi\b/u);

  assert.match(protocol, /pub fn decode_values[\s\S]*decode_base64\(&self\.data\)[\s\S]*self\.count as usize[\s\S]*checked_mul\(std::mem::size_of::<f64>\(\)\)/u);
  assert.match(protocol, /pub fn decode_request_frame[\s\S]*validate_request_blocks\(&request\)/u);
  assert.match(coreEquations, /vec!\[None; block\.kind\.input_count\(\)\]/u);
  assert.match(coreEquations, /let mut jacobian = vec!\[vec!\[0\.0; n\]; n\]/u);
  assert.match(coreDae, /pub fn lower[\s\S]*graph\.evaluate\(initialization_time_s, &state, settings\)/u);

  assert.match(campaign, /admission_duplicate_keys_and_unknown_fields_fail_closed[\s\S]*top_duplicate[\s\S]*nested_duplicate[\s\S]*duplicate JSON object key[\s\S]*wallTimeMs[\s\S]*cpuSeconds[\s\S]*memoryBytes/u);
  assert.match(campaign, /admission_request_byte_limit_reaches_decode_exactly_and_plus_one_fails_preallocation[\s\S]*tiny_count\.graph_transport\.count = 1[\s\S]*"A"\.repeat\(MAX_FRAME_PAYLOAD_BYTES \/ 2\)[\s\S]*AdmissionError::EncodedLengthMismatch/u);
  assert.match(campaign, /admission_klu_dimension_nonzero_and_known_csc_limits_are_independent[\s\S]*accounting\(\)\.nonzeros, MAX_KLU_NONZEROS[\s\S]*accounting\(\)\.known_csc_bytes,[\s\S]*MAX_KLU_KNOWN_CSC_BYTES[\s\S]*AdmissionLimit::KluKnownCscBytes/u);
  assert.match(campaign, /admission_sum_fan_in_and_total_input_slot_limits_fail_preallocation[\s\S]*MAX_SUM_FAN_IN \+ 1[\s\S]*AdmissionLimit::TotalInputSlots[\s\S]*MAX_TOTAL_INPUT_SLOTS \+ 1[\s\S]*cyclic_gain_graph\(MAX_CYCLIC_ALGEBRAIC_VARIABLES \+ 1\)[\s\S]*AdmissionLimit::CyclicAlgebraicVariables/u);
  assert.match(campaign, /max_restarts: MAX_EVENT_RESTARTS as u32[\s\S]*expect\("exact event-restart boundary"\)[\s\S]*settings\.event_policy == IdaEventPolicy::Restart[\s\S]*max_restarts: MAX_EVENT_RESTARTS,[\s\S]*max_restarts: \(MAX_EVENT_RESTARTS \+ 1\) as u32[\s\S]*AdmissionLimit::EventRestarts/u);
});

test('isolated Rust 1.77.2 CI executes exactly eighteen cases in two blocks per profile', () => {
  const workflow = read('.github/workflows/ci.yml');
  const start = workflow.indexOf('\n  # Isolated source-only framing and admission gate.');
  const jobStart = workflow.indexOf('\n  dae-service-protocol:', start);
  const end = workflow.indexOf('\n  sundials-native-build:', start);
  assert.ok(start >= 0 && jobStart > start && end > jobStart, 'the isolated service-protocol job is present');
  const job = workflow.slice(start, end);

  assert.match(job, /toolchain: 1\.77\.2/u);
  assert.match(job, /RUSTFLAGS: -Dwarnings/u);
  assert.match(job, /CARGO_TARGET_DIR=\$RUNNER_TEMP\/battery-design-dae-service-target/u);
  assert.equal(
    (job.match(/cargo test --locked(?: --release)? --manifest-path rust-dae-service\/Cargo\.toml \\\n\s*--test service_framing_campaign \\\n\s*--test service_admission_campaign/gu) ?? []).length,
    2,
  );
  assert.equal(
    (job.match(/Exercise exactly 18 service framing and admission cases in (?:debug|release)/gu) ?? []).length,
    2,
  );
  assert.equal(
    (job.match(/test result: ok\\\. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;/gu) ?? []).length,
    2,
  );
  assert.equal((job.match(/filtered out;' "\$log"\)" -eq 2/gu) ?? []).length, 2);
  assert.equal((job.match(/grep -Ec '\^test result:' "\$log"\)" -eq 2/gu) ?? []).length, 2);
  assert.equal((job.match(/END \{ print total \+ 0 \}' "\$log"\)" -eq 18/gu) ?? []).length, 2);
  assert.match(job, /Isolated source-only framing and admission gate[\s\S]*does not launch a[\s\S]*service process,[\s\S]*call a native solver,[\s\S]*product artifact/iu);
});

test('guide reports Phase 1 framing and Phase 2 admission without claiming a runtime', () => {
  const source = read('docs/EQUATION_SOLVER.md');
  const start = source.indexOf('### Iteration 4 native service Phases 1 and 2:');
  const end = source.indexOf('\n### ', start + 4);
  assert.ok(start >= 0 && end > start, 'the Phase 1/2 service section is bounded');
  const guide = source.slice(start, end).replace(/\s+/gu, ' ');
  const completeGuide = source.replace(/\s+/gu, ' ');

  assert.match(guide, /native service Phases 1 and 2: framing and strict admission[\s\S]*source-only `rust-dae-service\/`[\s\S]*Phase 1 owns the codec boundary[\s\S]*Phase 2 preflights caller-controlled allocation shape before core decode,[\s\S]*then lowers the bounded graph and derives a native-free plan/i);
  assert.match(guide, /18 tests per profile:[\s\S]*18 in debug[\s\S]*same 18 in release[\s\S]*does not turn the campaign numerator into 36 unique cases/i);
  assert.match(guide, /do not open a listener[\s\S]*spawn or supervise[\s\S]*call the dense or KLU backend[\s\S]*return a native solve result[\s\S]*release artifact/i);
  assert.match(guide, /JSON\.stringify\(-0\)[\s\S]*exact little-endian bytes[\s\S]*canonical standard base64[\s\S]*exact `f64` bits[\s\S]*not evidence that a native solver has consumed/i);
  assert.match(guide, /rejects invalid UTF-8[\s\S]*malformed or trailing JSON[\s\S]*duplicate keys[\s\S]*unknown fields[\s\S]*mismatched contract identity[\s\S]*atomically/i);
  assert.match(guide, /request-byte ceiling[\s\S]*exact limit[\s\S]*next byte[\s\S]*before request construction or payload allocation/i);
  assert.match(guide, /Dense dimension[\s\S]*KLU dimension[\s\S]*known CSC nonzero\/storage work[\s\S]*output-row[\s\S]*total result-value ceilings remain independent/i);
  assert.match(guide, /request-declared counts and graph allocation shape are checked before core decode[\s\S]*result cardinality is derived from the compiled graph[\s\S]*KLU nonzero and known-CSC byte accounting is checked only after DAE lowering[\s\S]*bound later native admission, not pre-lowering allocation/i);
  assert.match(guide, /reachable service KLU ceilings are 30,000 nonzeros and 720 KiB[\s\S]*independent exact-boundary and over-bound cases[\s\S]*below the native adapter maxima of 1,000,000 nonzeros and 64 MiB[\s\S]*compile-time comparisons/i);
  assert.match(guide, /checked arithmetic[\s\S]*Sum block is limited to 4,096 inputs[\s\S]*100,000 aggregate input slots before core decode[\s\S]*bounded graph is only then decoded and lowered[\s\S]*service-admission fix[\s\S]*`rust-core\/` was not changed/i);
  assert.match(guide, /Before decoding either floating-point block[\s\S]*count by eight bytes[\s\S]*4 \* ceil\(\(count \* 8\) \/ 3\)[\s\S]*exactly that length[\s\S]*declared count of one[\s\S]*near-frame-limit string[\s\S]*fail before that reservation[\s\S]*`admit_request_frame` boundary[\s\S]*older Phase 1 codec helper alone[\s\S]*no standalone resource-safety claim/i);
  assert.match(guide, /consistent-initial evaluation as pre-native work[\s\S]*algebraic iterations at 100 before DAE lowering[\s\S]*If any algebraic loop exists,[\s\S]*total number of algebraic variables is capped at 256[\s\S]*dense Newton Jacobian[\s\S]*implicit-iteration setting at 100 as fixed policy[\s\S]*does not run the core backward-Euler solver[\s\S]*not part of the cyclic consistent-initial root cause[\s\S]*acyclic KLU dimension ceiling remains 10,000/i);
  assert.match(guide, /do not bound input-dependent KLU symbolic or numeric factor fill,[\s\S]*total process memory,[\s\S]*CPU time[\s\S]*resident lifetime/i);
  assert.match(guide, /refuses caller attempts to supply wall-time,[\s\S]*CPU,[\s\S]*memory[\s\S]*does not create a process,[\s\S]*invoke a native backend,[\s\S]*materialize an output\/result payload/i);
  assert.match(guide, /789bfc8f560d4e090466f98a29c27d9e20ba3b31[\s\S]*35 test names[\s\S]*case-sensitive word-boundary filter[\s\S]*produces 17 matches/i);
  assert.match(guide, /d2746feb185d4b9819ea94c9314bb0a6e6d0138ef63930d2c128b37a4ca6dc9f[\s\S]*59d29f9629e3c8a14331206411f177b94970f01e3c33f0a625f7a493e1fbcbf0/i);
  assert.match(guide, /framing and admission targets contain 18 cases[\s\S]*18 \/ 17 = 1\.06[\s\S]*not a two-times claim[\s\S]*46 cases[\s\S]*9 \+ 9 \+ 9 \+ 9 \+ 10[\s\S]*46 \/ 17 = 2\.71[\s\S]*only after all five targets exist and pass/i);
  assert.match(guide, /remaining 28 planned cases[\s\S]*service process[\s\S]*request-to-solver mapping[\s\S]*native solve[\s\S]*not implemented by Phases 1 or 2/i);
  assert.match(completeGuide, /does not provide index reduction[\s\S]*qualify general implicit DAEs[\s\S]*expose a native service or desktop integration[\s\S]*WebAssembly ABI/i);
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
