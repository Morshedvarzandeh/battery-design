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
const PHASE_3_SUPERVISION_CASES = Object.freeze([
  'supervision_one_request_spawns_exactly_one_worker',
  'supervision_busy_request_is_rejected_without_queue_or_spawn',
  'supervision_worker_environment_is_allowlisted_and_stdio_is_piped',
  'supervision_request_frame_is_written_once_before_stdin_closes',
  'supervision_stdout_requires_one_complete_bounded_response_frame',
  'supervision_stderr_is_separate_and_capped',
  'supervision_wall_deadline_terminates_and_reaps_the_worker',
  'supervision_nonzero_exit_or_signal_returns_typed_failure',
  'supervision_linux_worker_policy_applies_fixed_resource_limits',
]);
const PHASE_3_SUPERVISION_CASES_SOURCE_ORDER_SHA256 = '4b76cd45a452ebbcb76a72ea755d23328a7cd85128dcc7b6201b69cbd374fa59';
const PHASE_3_SUPERVISION_CASES_SHA256 = '1e593f6eafcdfb477acb6899e5af1a465af3f186ef2579d90be20afe804bbfc5';
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

test('Phase 2 owns the revised nine-case admission roster', () => {
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

});

test('Phase 3 owns the exact nine-case supervision roster and cumulative evidence remains partial', () => {
  const manifest = read('rust-dae-service/Cargo.toml');
  const supervisionNames = rustTestNames(
    read('rust-dae-service/tests/service_supervision_campaign.rs'),
  );

  assert.match(
    manifest,
    /\[\[test\]\]\s*name = "service_supervision_campaign"\s*path = "tests\/service_supervision_campaign\.rs"/u,
  );
  assert.equal(supervisionNames.length, 9);
  assert.equal(new Set(supervisionNames).size, 9);
  assert.deepEqual(supervisionNames, PHASE_3_SUPERVISION_CASES);
  assert.equal(
    namesSha256(supervisionNames),
    PHASE_3_SUPERVISION_CASES_SOURCE_ORDER_SHA256,
  );
  assert.equal(
    namesSha256([...supervisionNames].sort()),
    PHASE_3_SUPERVISION_CASES_SHA256,
  );

  const currentCampaignCases = PHASE_1_FRAMING_CASES.length
    + PHASE_2_ADMISSION_CASES.length
    + supervisionNames.length;
  assert.equal(currentCampaignCases, 27);
  assert.equal((currentCampaignCases / SERVICE_PROTOCOL_MATCHES.length).toFixed(2), '1.59');
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

test('Phase 3 source owns one bounded Linux worker lifecycle without claiming a sandbox', () => {
  const supervision = read('rust-dae-service/src/supervision.rs');
  const campaign = read('rust-dae-service/tests/service_supervision_campaign.rs');
  const fixture = read('rust-dae-service/tests/fixtures/one_shot_worker.rs');
  const identityStart = fixture.indexOf('fn write_process_identity');
  const identityEnd = fixture.indexOf('\nfn wait_for_identity', identityStart);
  assert.ok(identityStart >= 0 && identityEnd > identityStart, 'fixture identity publisher is bounded');
  const identityPublisher = fixture.slice(identityStart, identityEnd);
  const policyStart = supervision.indexOf('fn apply_linux_worker_policy');
  const policyEnd = supervision.indexOf('\n#[cfg(target_os = "linux")]\nfn kill_process_group', policyStart);
  assert.ok(policyStart >= 0 && policyEnd > policyStart, 'post-fork policy helpers are bounded');
  const policyHelpers = supervision.slice(policyStart, policyEnd);

  assert.match(supervision, /same-group bounds[\s\S]*descendants that remain in its original process group[\s\S]*descendant moved[\s\S]*or created outside that group can survive group cleanup and retain a pipe[\s\S]*owned direct worker[\s\S]*`Child::kill` and reaped[\s\S]*DrainDeadlineExceeded[\s\S]*still-blocked I\/O thread[\s\S]*repeated descendant escapes can accumulate[\s\S]*not a sandbox or an aggregate[\s\S]*process-lifetime guarantee/i);
  assert.match(supervision, /pub const MAX_WORKER_WALL_TIME: Duration = Duration::from_secs\(25\);/u);
  assert.match(supervision, /pub const WORKER_DRAIN_DEADLINE: Duration = Duration::from_secs\(2\);/u);
  assert.match(supervision, /pub const MAX_WORKER_STDOUT_BYTES: usize = FRAME_HEADER_BYTES \+ MAX_FRAME_PAYLOAD_BYTES;/u);
  assert.match(supervision, /pub const MAX_WORKER_STDERR_BYTES: usize = 64 \* 1024;/u);
  assert.match(supervision, /pub const LINUX_WORKER_ADDRESS_SPACE_BYTES: u64 = 768 \* 1024 \* 1024;/u);
  assert.match(supervision, /pub const LINUX_WORKER_CPU_SECONDS: u64 = 20;/u);
  assert.match(supervision, /pub const LINUX_WORKER_CORE_BYTES: u64 = 0;/u);
  assert.match(supervision, /pub const LINUX_WORKER_OPEN_FILES: u64 = 16;/u);
  assert.match(supervision, /const _: \(\) = \{[\s\S]*LINUX_WORKER_ADDRESS_SPACE_BYTES <= libc::rlim_t::MAX as u64[\s\S]*LINUX_WORKER_CPU_SECONDS <= libc::rlim_t::MAX as u64[\s\S]*LINUX_WORKER_CORE_BYTES <= libc::rlim_t::MAX as u64[\s\S]*LINUX_WORKER_OPEN_FILES <= libc::rlim_t::MAX as u64/u);
  assert.match(supervision, /pub fn completion_observed_before_deadline[\s\S]*elapsed < self\.wall_time/u);

  assert.match(supervision, /pub fn new[\s\S]*executable\.is_absolute\(\)[\s\S]*working_directory\.is_absolute\(\)/u);
  assert.match(supervision, /pub fn supervise[\s\S]*ActiveLease::acquire[\s\S]*SupervisionError::Busy[\s\S]*admit_request_frame\(request_frame\)[\s\S]*native_settings\(\)[\s\S]*supervise_linux/u);
  assert.match(supervision, /let mut input = Vec::new\(\);[\s\S]*try_reserve_exact\(request_frame\.len\(\)\)[\s\S]*RequestAllocationFailed[\s\S]*input\.extend_from_slice\(request_frame\)[\s\S]*Command::new/u);
  assert.match(supervision, /Command::new\(program\.executable\(\)\)[\s\S]*\.env_clear\(\)[\s\S]*WORKER_PROTOCOL_ENV[\s\S]*WORKER_BACKEND_ENV[\s\S]*\.env\("LANG", "C"\)[\s\S]*\.env\("LC_ALL", "C"\)[\s\S]*\.stdin\(Stdio::piped\(\)\)[\s\S]*\.stdout\(Stdio::piped\(\)\)[\s\S]*\.stderr\(Stdio::piped\(\)\)[\s\S]*\.process_group\(0\)[\s\S]*pre_exec\(apply_linux_worker_policy\)/u);
  assert.match(supervision, /try_reserve_exact\(request_frame\.len\(\)\)[\s\S]*input\.extend_from_slice\(request_frame\)[\s\S]*Command::new[\s\S]*pre_exec\(apply_linux_worker_policy\)[\s\S]*let started = Instant::now\(\);[\s\S]*command\s*\.spawn\(\)[\s\S]*child\.stdin\.take\(\)[\s\S]*spawn_writer[\s\S]*let \(outcome, cleanup_error\) = loop/u);
  assert.match(supervision, /fn spawn_writer[\s\S]*write_all\(&input\)[\s\S]*stdin\.flush\(\)[\s\S]*drop\(stdin\)/u);
  assert.match(supervision, /fn spawn_reader[\s\S]*remaining = maximum\.saturating_sub\(kept\.len\(\)\)[\s\S]*truncated \|= keep < count/u);
  assert.match(supervision, /spawn_reader\([\s\S]*MAX_WORKER_STDOUT_BYTES[\s\S]*spawn_reader\([\s\S]*MAX_WORKER_STDERR_BYTES/u);
  assert.match(supervision, /FrameDecoder::new\(FrameKind::Response\)[\s\S]*\.push\(&stdout\.bytes\)[\s\S]*\.finish\(\)/u);

  assert.match(supervision, /let \(outcome, cleanup_error\) = loop[\s\S]*!self[\s\S]*completion_observed_before_deadline\(started\.elapsed\(\)\)[\s\S]*ProcessOutcome::TimedOut,[\s\S]*leader_exited_without_reaping\(process_group\)[\s\S]*Ok\(true\)[\s\S]*!self[\s\S]*completion_observed_before_deadline\(started\.elapsed\(\)\)[\s\S]*ProcessOutcome::TimedOut,[\s\S]*cleanup_running_child\(&mut child, process_group\)[\s\S]*kill_process_group\(process_group\)[\s\S]*child\.wait\(\)[\s\S]*ProcessOutcome::Exited\(status\)/u);
  assert.match(supervision, /let drain_deadline = Instant::now\(\) \+ WORKER_DRAIN_DEADLINE;[\s\S]*writer_received[\s\S]*receive_before\(writer,[\s\S]*drain_deadline\)[\s\S]*stdout_received = receive_before\([\s\S]*stdout_reader,[\s\S]*drain_deadline,[\s\S]*stderr_received = receive_before\([\s\S]*stderr_reader,[\s\S]*drain_deadline,[\s\S]*if let Some\(error\) = cleanup_error[\s\S]*stage: WorkerIoStage::Cleanup[\s\S]*writer_result = writer_received\?[\s\S]*stdout_result = stdout_received\?[\s\S]*stderr_result = stderr_received\?/u);
  assert.match(supervision, /fn receive_before[\s\S]*recv_timeout\(remaining\)[\s\S]*DrainDeadlineExceeded/u);
  assert.match(policyHelpers, /fn apply_linux_worker_policy[\s\S]*RLIMIT_AS,[\s\S]*LINUX_WORKER_ADDRESS_SPACE_BYTES as libc::rlim_t[\s\S]*RLIMIT_CPU[\s\S]*as libc::rlim_t[\s\S]*RLIMIT_CORE[\s\S]*as libc::rlim_t[\s\S]*RLIMIT_NOFILE[\s\S]*as libc::rlim_t[\s\S]*PR_SET_NO_NEW_PRIVS[\s\S]*fn set_linux_limit[\s\S]*libc::setrlimit[\s\S]*fn linux_errno_error[\s\S]*libc::__errno_location\(\)[\s\S]*io::Error::from_raw_os_error\(errno\)/u);
  assert.doesNotMatch(policyHelpers, /io::Error::new|last_os_error|format!|\.to_string\(/u);
  assert.match(supervision, /fn kill_process_group[\s\S]*libc::kill\(-process_group, libc::SIGKILL\)/u);
  assert.match(supervision, /fn leader_exited_without_reaping[\s\S]*libc::waitid\([\s\S]*libc::P_PID,[\s\S]*libc::WEXITED \| libc::WNOHANG \| libc::WNOWAIT[\s\S]*observed_pid == expected_pid/u);
  assert.match(supervision, /fn cleanup_running_child[\s\S]*kill_process_group\(process_group\)[\s\S]*child\.kill\(\)[\s\S]*child\.wait\(\)/u);

  assert.doesNotMatch(supervision, /IdaDenseBackend|IdaKluBackend|SUNLinSol_|\bTcpListener\b|\bUdpSocket\b/u);
  assert.doesNotMatch(supervision, /\.try_wait\(\)/u);

  assert.match(campaign, /supervision_one_request_spawns_exactly_one_worker[\s\S]*marker_count\(&dense_marker\), 1[\s\S]*marker_count\(&klu_marker\), 0[\s\S]*forbidden-fallback[\s\S]*WorkerIoStage::Spawn[\s\S]*marker_count\(&fallback_marker\), 0/u);
  assert.match(campaign, /supervision_busy_request_is_rejected_without_queue_or_spawn[\s\S]*Arc::new\(make_supervisor[\s\S]*busy calls do not enter admission[\s\S]*SupervisionError::Busy[\s\S]*marker_count\(&marker\), 1[\s\S]*lease was released/u);
  assert.match(campaign, /supervision_worker_environment_is_allowlisted_and_stdio_is_piped[\s\S]*stdin_pipe=true[\s\S]*stdout_pipe=true[\s\S]*stderr_pipe=true[\s\S]*BATTERY_DESIGN_DAE_BACKEND=sundials-ida-dense[\s\S]*BATTERY_DESIGN_DAE_WORKER_PROTOCOL=battery-design\/native-dae-worker@1[\s\S]*LANG=C[\s\S]*LC_ALL=C/u);
  assert.match(campaign, /supervision_request_frame_is_written_once_before_stdin_closes[\s\S]*recorded-after-eof[\s\S]*fs::read\(record\)[\s\S]*request/u);
  assert.match(campaign, /supervision_stdout_requires_one_complete_bounded_response_frame[\s\S]*UnexpectedEof[\s\S]*TrailingBytes \{ count: 1 \}[\s\S]*MAX_WORKER_STDOUT_BYTES \+ 1[\s\S]*StdoutLimitExceeded/u);
  assert.match(campaign, /supervision_stderr_is_separate_and_capped[\s\S]*MAX_WORKER_STDERR_BYTES, false[\s\S]*MAX_WORKER_STDERR_BYTES \+ 17, true[\s\S]*stderr-stayed-separate[\s\S]*stderr_truncated/u);
  assert.match(campaign, /struct ProcessIdentity[\s\S]*pid: u32,[\s\S]*start_time: u64[\s\S]*fn read_process_identity[\s\S]*\/proc\/\{\}\/stat[\s\S]*fields\.get\(19\)[\s\S]*start_time != identity\.start_time[\s\S]*fn wait_until_reaped[\s\S]*fn wait_until_not_running/u);
  assert.match(campaign, /supervision_wall_deadline_terminates_and_reaps_the_worker[\s\S]*hang-with-descendant[\s\S]*Duration::from_millis\(750\)[\s\S]*padded_request_frame\(1024 \* 1024\)[\s\S]*started\.elapsed\(\) < Duration::from_secs\(2\)[\s\S]*read_process_identity\(&leader_identity\)[\s\S]*read_process_identity\(&descendant_identity\)[\s\S]*wait_until_reaped\(leader\)[\s\S]*wait_until_not_running\(descendant\)[\s\S]*exit-with-descendant[\s\S]*leader-exited[\s\S]*wait_until_not_running\(\s*read_process_identity\(\s*&exit_descendant_identity,?\s*\)\s*\)/u);
  assert.match(campaign, /supervision_wall_deadline_terminates_and_reaps_the_worker[\s\S]*escape-group-hang[\s\S]*escaped_leader_identity[\s\S]*group_transition[\s\S]*Duration::from_millis\(400\)[\s\S]*SupervisionError::TimedOut[\s\S]*started\.elapsed\(\) < Duration::from_secs\(2\)[\s\S]*read_group_transition\(&group_transition\)[\s\S]*assert_ne!\(original_group, escaped_group\)[\s\S]*wait_until_reaped\(read_process_identity\(&escaped_leader_identity\)\)/u);
  assert.match(campaign, /boundary_policy\.completion_observed_before_deadline\(Duration::from_nanos\(749_999_999\)\)[\s\S]*!boundary_policy\.completion_observed_before_deadline\(Duration::from_millis\(750\)\)[\s\S]*!boundary_policy\.completion_observed_before_deadline\(Duration::from_millis\(751\)\)/u);
  assert.match(campaign, /supervision_nonzero_exit_or_signal_returns_typed_failure[\s\S]*WorkerExit::Code\(7\)[\s\S]*exit-7[\s\S]*WorkerExit::Signal\(15\)[\s\S]*signal-15/u);
  assert.match(campaign, /supervision_linux_worker_policy_applies_fixed_resource_limits[\s\S]*as=\{0\}:\{0\};cpu=\{1\}:\{1\};core=\{2\}:\{2\};nofile=\{3\}:\{3\};no_new_privs=1/u);
  assert.match(fixture, /hang-with-descendant[\s\S]*Command::new\(env::current_exe\(\)\?\)[\s\S]*\.arg\("hold-pipes"\)[\s\S]*\.arg\(descendant_path\)[\s\S]*\.stdout\(Stdio::inherit\(\)\)[\s\S]*\.stderr\(Stdio::inherit\(\)\)[\s\S]*write_process_identity\(Path::new\(leader_path\)\)[\s\S]*wait_for_identity\(Path::new\(descendant_path\)\)[\s\S]*exit-with-descendant[\s\S]*hold-pipes[\s\S]*write_process_identity\(Path::new\(path\)\)[\s\S]*fn write_process_identity[\s\S]*\/proc\/self\/stat[\s\S]*\.get\(19\)[\s\S]*format!\("\{pid\} \{start_time\}\\n"\)[\s\S]*fn wait_for_identity/u);
  assert.match(fixture, /extern "C" \{[\s\S]*fn getpgrp\(\)[\s\S]*fn getppid\(\)[\s\S]*fn getpgid\(pid: i32\)[\s\S]*fn setpgid\(pid: i32, pgid: i32\)[\s\S]*escape-group-hang[\s\S]*original_group = unsafe \{ getpgrp\(\) \}[\s\S]*parent_group = unsafe \{ getpgid\(parent_pid\) \}[\s\S]*setpgid\(0, parent_group\)[\s\S]*escaped_group = unsafe \{ getpgrp\(\) \}[\s\S]*original_group == escaped_group/u);
  assert.doesNotMatch(fixture, /unsafe extern/u);
  assert.match(campaign, /let rustc = std::env::var_os\("RUSTC"\)[\s\S]*Command::new\(rustc\)[\s\S]*\.arg\("--edition=2021"\)[\s\S]*\.arg\("-Dwarnings"\)[\s\S]*\.arg\(&source\)[\s\S]*\.arg\("-o"\)[\s\S]*launch active rustc for test-only fixture/u);
  assert.match(identityPublisher, /\/proc\/self\/stat[\s\S]*split_once\('\s'\)[\s\S]*\.get\(19\)[\s\S]*\{pid\} \{start_time\}/u);
  assert.doesNotMatch(identityPublisher, /process::id|Child::id/u);
});

test('isolated Rust 1.77.2 CI executes exactly twenty-seven cases in three blocks per profile', () => {
  const workflow = read('.github/workflows/ci.yml');
  const start = workflow.indexOf('\n  # Isolated source-only framing, admission and one-shot supervision gate.');
  const jobStart = workflow.indexOf('\n  dae-service-protocol:', start);
  const end = workflow.indexOf('\n  sundials-native-build:', start);
  assert.ok(start >= 0 && jobStart > start && end > jobStart, 'the isolated service-protocol job is present');
  const job = workflow.slice(start, end);

  assert.match(job, /toolchain: 1\.77\.2/u);
  assert.match(job, /RUSTFLAGS: -Dwarnings/u);
  assert.match(job, /CARGO_TARGET_DIR=\$RUNNER_TEMP\/battery-design-dae-service-target/u);
  assert.equal(
    (job.match(/cargo test --locked(?: --release)? --manifest-path rust-dae-service\/Cargo\.toml \\\n\s*--test service_framing_campaign \\\n\s*--test service_admission_campaign \\\n\s*--test service_supervision_campaign/gu) ?? []).length,
    2,
  );
  assert.equal(
    (job.match(/Exercise exactly 27 service framing, admission and supervision cases in (?:debug|release)/gu) ?? []).length,
    2,
  );
  assert.equal(
    (job.match(/test result: ok\\\. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;/gu) ?? []).length,
    2,
  );
  assert.equal((job.match(/filtered out;' "\$log"\)" -eq 3/gu) ?? []).length, 2);
  assert.equal((job.match(/grep -Ec '\^test result:' "\$log"\)" -eq 3/gu) ?? []).length, 2);
  assert.equal((job.match(/END \{ print total \+ 0 \}' "\$log"\)" -eq 27/gu) ?? []).length, 2);
  assert.match(job, /Isolated source-only framing, admission and one-shot supervision gate[\s\S]*only a test fixture[\s\S]*do not call a native[\s\S]*worker executable[\s\S]*product artifact/iu);
});

test('guide reports Phases 1–3 without claiming a native worker or process sandbox', () => {
  const source = read('docs/EQUATION_SOLVER.md');
  const start = source.indexOf('### Iteration 4 native service Phases 1–3:');
  const end = source.indexOf('\n### ', start + 4);
  assert.ok(start >= 0 && end > start, 'the Phase 1–3 service section is bounded');
  const guide = source.slice(start, end).replace(/\s+/gu, ' ');
  const completeGuide = source.replace(/\s+/gu, ' ');

  assert.match(guide, /native service Phases 1–3: framing, admission and supervision[\s\S]*source-only `rust-dae-service\/`[\s\S]*Phase 1 owns the codec boundary[\s\S]*Phase 2 preflights caller-controlled allocation shape[\s\S]*Phase 3 admits that request before spawn[\s\S]*one trusted worker program/i);
  assert.match(guide, /does create a child process,[\s\S]*only a test fixture,[\s\S]*not a native worker executable[\s\S]*do not open a listener,[\s\S]*call the dense or KLU backend,[\s\S]*native solve result[\s\S]*release artifact/i);
  assert.match(guide, /27 tests per profile:[\s\S]*27 in debug[\s\S]*same 27 in release[\s\S]*does not turn the campaign numerator into 54 unique cases/i);
  assert.match(guide, /fixture is not a Cargo binary or product artifact[\s\S]*active `rustc`, edition 2021[\s\S]*warnings denied[\s\S]*initial newer `unsafe extern` syntax[\s\S]*before hosted execution[\s\S]*pinned Rust 1\.77[\s\S]*plain `extern "C"`[\s\S]*not a claim that a hosted CI run failed/i);
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
  assert.match(guide, /refuses caller attempts to supply wall-time,[\s\S]*CPU,[\s\S]*memory[\s\S]*Phase 2 admission alone[\s\S]*does not create a process,[\s\S]*invoke a native backend,[\s\S]*materialize an output\/result payload/i);
  assert.match(guide, /absolute executable and working directory paths[\s\S]*admitted backend selects exactly one[\s\S]*Each `OneShotSupervisor` instance[\s\S]*one active call,[\s\S]*`Busy`[\s\S]*without queuing or spawning[\s\S]*Separate instances are not a global concurrency gate[\s\S]*clears the child environment[\s\S]*protocol\/backend identity,[\s\S]*`LANG=C`[\s\S]*`LC_ALL=C`[\s\S]*standard input, output and error are all pipes/i);
  assert.match(guide, /does not prove that arbitrary inherited file descriptors are closed[\s\S]*worker cannot use sockets/i);
  assert.match(guide, /fallibly reserved copy of the admitted frame before wall-time custody and spawn[\s\S]*dedicated writer[\s\S]*writes that frame once,[\s\S]*closes standard input[\s\S]*monitors time concurrently[\s\S]*synchronous large write[\s\S]*never reads standard input[\s\S]*fill the pipe before the deadline loop begins[\s\S]*1 MiB admitted frame[\s\S]*750 ms policy[\s\S]*bounded timeout cleanup[\s\S]*drained concurrently[\s\S]*eight-byte frame header[\s\S]*4 MiB payload[\s\S]*exactly one complete response frame[\s\S]*first 64 KiB[\s\S]*truncation flag[\s\S]*nonzero exit code or signal[\s\S]*typed worker failure/i);
  assert.match(guide, /configured worker wall interval is capped at 25 seconds[\s\S]*Trusted supervisor construction[\s\S]*shorter nonzero interval[\s\S]*request controls neither[\s\S]*one shared fixed two-second receive deadline[\s\S]*across the three I\/O channels[\s\S]*fallible request copy deliberately precedes wall custody[\s\S]*timer starts immediately before `Command::spawn`[\s\S]*spawn and all subsequent pipe and thread setup count toward the interval[\s\S]*initiates cleanup[\s\S]*not an absolute OS-level call-return guarantee[\s\S]*synchronous `Command::spawn`[\s\S]*`Child::wait`[\s\S]*750 ms owned-group timeout path[\s\S]*under two seconds/i);
  assert.match(guide, /distinct process group[\s\S]*leader-exit cleanup signal that group[\s\S]*reap the direct child[\s\S]*same-process-group fixture[\s\S]*descendant holding the output pipes open[\s\S]*unbounded wait[\s\S]*timeout path explicitly observes bounded return,[\s\S]*direct-leader reaping[\s\S]*normal leader-exit path[\s\S]*source binding confirms[\s\S]*group signal precedes `Child::wait`/i);
  assert.match(guide, /original process-group signal is not sufficient direct-child control[\s\S]*leader can use `setpgid` to join another existing group in the same session[\s\S]*group-only signal can miss[\s\S]*blocking wait can hang[\s\S]*`escape-group-hang`[\s\S]*joins its parent's group[\s\S]*proves the group changed[\s\S]*400 ms policy[\s\S]*typed timeout in under two seconds[\s\S]*PID-plus-start-time identity is reaped[\s\S]*retains the `Child` handle[\s\S]*`Child::kill`[\s\S]*`Child::wait`[\s\S]*retaining the first cleanup error/i);
  assert.match(guide, /unconditionally attempts the writer,[\s\S]*standard output and standard error receives[\s\S]*one shared absolute deadline[\s\S]*before returning a retained cleanup error[\s\S]*earlier channel error[\s\S]*does not skip the later receive attempts[\s\S]*not universal descendant containment[\s\S]*descendant moved or created outside the original group[\s\S]*survive[\s\S]*retain pipe ends[\s\S]*receive deadline[\s\S]*bounds only the supervisor's collective channel waiting[\s\S]*detached Rust reader or writer thread[\s\S]*remain blocked[\s\S]*repeated calls can accumulate escaped processes and threads[\s\S]*does not establish aggregate lifecycle-resource containment/i);
  assert.match(guide, /Normal leader exit is observed with Linux `waitid\(WNOWAIT\)` before reaping[\s\S]*checks elapsed time both before that observation and immediately after an exited result[\s\S]*preemption can cross the boundary[\s\S]*timeout wins at equality before normal-exit cleanup[\s\S]*process-group ID begins as its leader PID[\s\S]*reaping first would release that number for reuse[\s\S]*negative-PGID cleanup signal[\s\S]*unrelated concurrently spawned group[\s\S]*signals the still-owned group,[\s\S]*only then calls `Child::wait`[\s\S]*PID\/PGID reuse cleanup race[\s\S]*PID plus Linux process start time[\s\S]*self-publishes that pair from `\/proc\/self\/stat`[\s\S]*does not assume[\s\S]*`process::id` or `Child::id`[\s\S]*same numeric PID namespace[\s\S]*start time separately detects later reuse/i);
  assert.match(guide, /does not implement caller cancellation or a latest-request-wins policy/i);
  assert.match(guide, /`RLIMIT_AS` at 768 MiB[\s\S]*`RLIMIT_CPU` at 20 seconds[\s\S]*`RLIMIT_CORE` at zero[\s\S]*`RLIMIT_NOFILE` at 16[\s\S]*`PR_SET_NO_NEW_PRIVS`[\s\S]*post-fork `pre_exec` path[\s\S]*compile-time `rlim_t::MAX` fit assertions[\s\S]*direct scalar casts[\s\S]*`setrlimit` and `prctl`[\s\S]*reads errno directly[\s\S]*`io::Error::from_raw_os_error`[\s\S]*allocation\/boxing-capable `io::Error::new`[\s\S]*without reproducing a deadlock[\s\S]*excludes `io::Error::new`, formatting and `last_os_error`[\s\S]*not a general claim that arbitrary Rust code is safe between fork and exec[\s\S]*not a process sandbox[\s\S]*not an aggregate process-group CPU or memory proof,[\s\S]*filesystem or network namespace,[\s\S]*system-call filter,[\s\S]*arbitrary descriptor closure,[\s\S]*KLU factor-fill evidence,[\s\S]*native numerical-solve result/i);
  assert.match(guide, /789bfc8f560d4e090466f98a29c27d9e20ba3b31[\s\S]*35 test names[\s\S]*case-sensitive word-boundary filter[\s\S]*produces 17 matches/i);
  assert.match(guide, /d2746feb185d4b9819ea94c9314bb0a6e6d0138ef63930d2c128b37a4ca6dc9f[\s\S]*59d29f9629e3c8a14331206411f177b94970f01e3c33f0a625f7a493e1fbcbf0/i);
  assert.match(guide, /framing, admission and supervision targets contain 27 cases[\s\S]*27 \/ 17 = 1\.59[\s\S]*not a two-times claim[\s\S]*46 cases[\s\S]*9 \+ 9 \+ 9 \+ 9 \+ 10[\s\S]*46 \/ 17 = 2\.71[\s\S]*only after all five targets exist and pass/i);
  assert.match(guide, /remaining 19 planned cases,[\s\S]*request-to-native-solver mapping,[\s\S]*native solve,[\s\S]*caller cancellation,[\s\S]*broader teardown[\s\S]*not implemented by Phases 1–3/i);
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
