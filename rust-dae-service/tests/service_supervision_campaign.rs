#![cfg(target_os = "linux")]

use battery_design_core::equations::SolverSettings;
use battery_design_core::graph_transport::{GRAPH_TRANSPORT_MAGIC, GRAPH_TRANSPORT_VERSION};
use battery_design_dae_service::protocol::{
    encode_frame, encode_request_frame, F64BlockWire, FrameError, FrameKind, FrameSection,
    NativeDaeBackendWire, NativeDaeEventPolicyWire, NativeDaeRequestFormatWire,
    NativeDaeRequestWire, FRAME_HEADER_BYTES,
};
use battery_design_dae_service::supervision::{
    OneShotSupervisor, SupervisionError, SupervisorConfigError, SupervisorPolicy, WorkerExit,
    WorkerIoStage, WorkerProgram, WorkerPrograms, LINUX_WORKER_ADDRESS_SPACE_BYTES,
    LINUX_WORKER_CORE_BYTES, LINUX_WORKER_CPU_SECONDS, LINUX_WORKER_OPEN_FILES,
    MAX_WORKER_STDERR_BYTES, MAX_WORKER_STDOUT_BYTES, MAX_WORKER_WALL_TIME,
};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

static WORKER_EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();
static ARTIFACT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn graph_transport() -> Vec<f64> {
    let defaults = SolverSettings::default();
    vec![
        GRAPH_TRANSPORT_MAGIC as f64,
        GRAPH_TRANSPORT_VERSION as f64,
        1.0,
        0.0,
        0.0,
        defaults.start_s,
        1.0,
        defaults.initial_step_s,
        defaults.min_step_s,
        defaults.max_step_s,
        defaults.relative_tolerance,
        defaults.absolute_tolerance,
        defaults.max_steps as f64,
        defaults.algebraic_tolerance,
        defaults.algebraic_max_iterations as f64,
        defaults.implicit_tolerance,
        defaults.implicit_max_iterations as f64,
        0.0,
        0.0,
        1.0,
        0.0,
        0.0,
        0.0,
    ]
}

fn request_frame(backend: NativeDaeBackendWire) -> Vec<u8> {
    encode_request_frame(&NativeDaeRequestWire {
        format: NativeDaeRequestFormatWire::V1,
        backend,
        graph_transport: F64BlockWire::from_values(&graph_transport()).expect("graph block"),
        output_times: F64BlockWire::from_values(&[1.0]).expect("output block"),
        max_order: 5,
        suppress_algebraic_error: true,
        event_policy: NativeDaeEventPolicyWire::Reject,
    })
    .expect("canonical request frame")
}

fn padded_request_frame(payload_bytes: usize) -> Vec<u8> {
    let canonical = request_frame(NativeDaeBackendWire::Dense);
    let mut payload = canonical[FRAME_HEADER_BYTES..].to_vec();
    assert!(payload.len() < payload_bytes);
    payload.resize(payload_bytes, b' ');
    encode_frame(FrameKind::Request, &payload).expect("padded admitted request")
}

fn worker_executable() -> PathBuf {
    WORKER_EXECUTABLE
        .get_or_init(|| {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let root = option_env!("CARGO_TARGET_TMPDIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::temp_dir().join("battery-design-dae-service-tests"));
            fs::create_dir_all(&root).expect("create fixture build directory");
            let executable = root.join(format!("one-shot-worker-{}", std::process::id()));
            let rustc = std::env::var_os("RUSTC")
                .or_else(|| option_env!("RUSTC").map(OsString::from))
                .unwrap_or_else(|| OsString::from("rustc"));
            let source = manifest.join("tests/fixtures/one_shot_worker.rs");
            let output = Command::new(rustc)
                .arg("--edition=2021")
                .arg("-Dwarnings")
                .arg(&source)
                .arg("-o")
                .arg(&executable)
                .output()
                .expect("launch active rustc for test-only fixture");
            assert!(
                output.status.success(),
                "fixture compilation failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            executable
        })
        .clone()
}

fn artifact_path(label: &str) -> PathBuf {
    let sequence = ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = worker_executable()
        .parent()
        .expect("fixture directory")
        .join(format!("{label}-{}-{sequence}", std::process::id()));
    let _ = fs::remove_file(&path);
    path
}

fn program(mode: &str, arguments: impl IntoIterator<Item = OsString>) -> WorkerProgram {
    let mut all_arguments = vec![OsString::from(mode)];
    all_arguments.extend(arguments);
    let executable = worker_executable();
    let directory = executable
        .parent()
        .expect("fixture directory")
        .to_path_buf();
    WorkerProgram::new(executable, directory, all_arguments).expect("absolute trusted fixture")
}

fn echo_program(marker: &Path) -> WorkerProgram {
    program("echo", [marker.as_os_str().to_owned()])
}

fn make_supervisor(
    dense: WorkerProgram,
    klu: WorkerProgram,
    wall_time: Duration,
) -> OneShotSupervisor {
    OneShotSupervisor::new(
        WorkerPrograms::new(dense, klu),
        SupervisorPolicy::new(wall_time).expect("bounded wall time"),
    )
    .expect("Linux supervisor")
}

fn marker_count(path: &Path) -> usize {
    fs::read_to_string(path)
        .map(|contents| contents.lines().count())
        .unwrap_or(0)
}

fn wait_for_file(path: &Path, maximum: Duration) {
    let started = Instant::now();
    while !path.exists() && started.elapsed() < maximum {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(path.exists(), "fixture did not create {}", path.display());
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    start_time: u64,
}

fn read_process_identity(path: &Path) -> ProcessIdentity {
    let value = fs::read_to_string(path).expect("read fixture process identity");
    let mut fields = value.split_whitespace();
    let identity = ProcessIdentity {
        pid: fields
            .next()
            .expect("identity pid")
            .parse()
            .expect("parse identity pid"),
        start_time: fields
            .next()
            .expect("identity start time")
            .parse()
            .expect("parse identity start time"),
    };
    assert!(fields.next().is_none(), "identity has trailing fields");
    identity
}

fn read_group_transition(path: &Path) -> (i32, i32) {
    let value = fs::read_to_string(path).expect("read fixture group transition");
    let mut fields = value.split_whitespace();
    let original = fields
        .next()
        .expect("original group")
        .parse()
        .expect("parse original group");
    let escaped = fields
        .next()
        .expect("escaped group")
        .parse()
        .expect("parse escaped group");
    assert!(
        fields.next().is_none(),
        "group transition has trailing fields"
    );
    (original, escaped)
}

fn observe_process(identity: ProcessIdentity) -> Option<u8> {
    let Ok(stat) = fs::read_to_string(format!("/proc/{}/stat", identity.pid)) else {
        return None;
    };
    let Some(after_name) = stat.rsplit_once(") ").map(|(_, value)| value) else {
        return None;
    };
    let fields = after_name.split_whitespace().collect::<Vec<_>>();
    let start_time = fields.get(19)?.parse::<u64>().ok()?;
    if start_time != identity.start_time {
        return None;
    }
    fields.first()?.as_bytes().first().copied()
}

fn wait_until_reaped(identity: ProcessIdentity) {
    let started = Instant::now();
    while observe_process(identity).is_some() && started.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        observe_process(identity),
        None,
        "original process identity remained after direct-child wait: {identity:?}"
    );
}

fn wait_until_not_running(identity: ProcessIdentity) {
    let started = Instant::now();
    while observe_process(identity).is_some_and(|state| !matches!(state, b'Z' | b'X'))
        && started.elapsed() < Duration::from_secs(2)
    {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        !observe_process(identity).is_some_and(|state| !matches!(state, b'Z' | b'X')),
        "original process identity remained running: {identity:?}"
    );
}

#[test]
fn supervision_one_request_spawns_exactly_one_worker() {
    let dense_marker = artifact_path("dense-marker");
    let klu_marker = artifact_path("klu-marker");
    let supervisor = make_supervisor(
        echo_program(&dense_marker),
        echo_program(&klu_marker),
        Duration::from_secs(2),
    );
    let response = supervisor
        .supervise(&request_frame(NativeDaeBackendWire::Dense))
        .expect("one dense worker response");
    assert_eq!(response.backend(), NativeDaeBackendWire::Dense);
    assert_eq!(response.payload(), b"ok");
    assert_eq!(marker_count(&dense_marker), 1);
    assert_eq!(marker_count(&klu_marker), 0);

    assert!(matches!(
        supervisor.supervise(b"not a frame"),
        Err(SupervisionError::Admission(_))
    ));
    assert_eq!(marker_count(&dense_marker), 1);

    let fallback_marker = artifact_path("forbidden-fallback");
    let missing = worker_executable()
        .parent()
        .expect("fixture directory")
        .join("missing-dense-worker");
    let missing_dense = WorkerProgram::new(
        missing,
        worker_executable().parent().expect("fixture directory"),
        Vec::<OsString>::new(),
    )
    .expect("absolute missing path is trusted configuration");
    let no_fallback = make_supervisor(
        missing_dense,
        echo_program(&fallback_marker),
        Duration::from_secs(2),
    );
    assert!(matches!(
        no_fallback.supervise(&request_frame(NativeDaeBackendWire::Dense)),
        Err(SupervisionError::ProcessIo {
            backend: NativeDaeBackendWire::Dense,
            stage: WorkerIoStage::Spawn,
            ..
        })
    ));
    assert_eq!(marker_count(&fallback_marker), 0);
}

#[test]
fn supervision_busy_request_is_rejected_without_queue_or_spawn() {
    let marker = artifact_path("busy-marker");
    let dense = program("hang-read", [marker.as_os_str().to_owned()]);
    let unused_klu = echo_program(&artifact_path("busy-unused-klu"));
    let supervisor = Arc::new(make_supervisor(
        dense,
        unused_klu,
        Duration::from_millis(400),
    ));
    let first_supervisor = Arc::clone(&supervisor);
    let first = thread::spawn(move || {
        first_supervisor.supervise(&request_frame(NativeDaeBackendWire::Dense))
    });
    wait_for_file(&marker, Duration::from_secs(2));

    assert!(matches!(
        supervisor.supervise(b"busy calls do not enter admission"),
        Err(SupervisionError::Busy)
    ));
    assert_eq!(marker_count(&marker), 1);
    assert!(matches!(
        first.join().expect("first supervision thread"),
        Err(SupervisionError::TimedOut { .. })
    ));
    assert!(matches!(
        supervisor.supervise(b"lease was released"),
        Err(SupervisionError::Admission(_))
    ));
    assert_eq!(marker_count(&marker), 1);
}

#[test]
fn supervision_worker_environment_is_allowlisted_and_stdio_is_piped() {
    let environment = program("environment", Vec::<OsString>::new());
    let supervisor = make_supervisor(environment.clone(), environment, Duration::from_secs(2));
    let response = supervisor
        .supervise(&request_frame(NativeDaeBackendWire::Dense))
        .expect("environment worker");
    let expected_directory = worker_executable()
        .parent()
        .expect("fixture directory")
        .display()
        .to_string();
    let payload = String::from_utf8(response.payload().to_vec()).expect("UTF-8 fixture payload");
    assert_eq!(
        payload,
        format!(
            "cwd={expected_directory}\nstdin_pipe=true\nstdout_pipe=true\nstderr_pipe=true\nBATTERY_DESIGN_DAE_BACKEND=sundials-ida-dense\nBATTERY_DESIGN_DAE_WORKER_PROTOCOL=battery-design/native-dae-worker@1\nLANG=C\nLC_ALL=C\n"
        )
    );
    assert_eq!(response.diagnostics().stderr(), b"environment-stderr");
    assert!(!response.diagnostics().stderr_truncated());
}

#[test]
fn supervision_request_frame_is_written_once_before_stdin_closes() {
    let record = artifact_path("recorded-request");
    let recorder = program("record", [record.as_os_str().to_owned()]);
    let supervisor = make_supervisor(recorder.clone(), recorder, Duration::from_secs(2));
    let request = request_frame(NativeDaeBackendWire::Dense);
    let response = supervisor.supervise(&request).expect("record worker");
    assert_eq!(response.payload(), b"recorded-after-eof");
    assert_eq!(fs::read(record).expect("recorded request"), request);
}

#[test]
fn supervision_stdout_requires_one_complete_bounded_response_frame() {
    let request = request_frame(NativeDaeBackendWire::Dense);
    let valid = program("stdout", [OsString::from("valid")]);
    let valid_supervisor = make_supervisor(valid.clone(), valid, Duration::from_secs(3));
    assert_eq!(
        valid_supervisor
            .supervise(&request)
            .expect("one response frame")
            .payload(),
        b"ok"
    );

    let truncated = program("stdout", [OsString::from("truncated")]);
    let truncated_supervisor =
        make_supervisor(truncated.clone(), truncated, Duration::from_secs(3));
    assert!(matches!(
        truncated_supervisor.supervise(&request),
        Err(SupervisionError::InvalidResponse {
            source: FrameError::UnexpectedEof {
                section: FrameSection::Payload,
                expected: 4,
                actual: 2,
            },
            ..
        })
    ));

    let trailing = program("stdout", [OsString::from("trailing")]);
    let trailing_supervisor = make_supervisor(trailing.clone(), trailing, Duration::from_secs(3));
    assert!(matches!(
        trailing_supervisor.supervise(&request),
        Err(SupervisionError::InvalidResponse {
            source: FrameError::TrailingBytes { count: 1 },
            ..
        })
    ));

    let over = program(
        "stdout",
        [
            OsString::from("over"),
            OsString::from((MAX_WORKER_STDOUT_BYTES + 1).to_string()),
        ],
    );
    let over_supervisor = make_supervisor(over.clone(), over, Duration::from_secs(5));
    assert!(matches!(
        over_supervisor.supervise(&request),
        Err(SupervisionError::StdoutLimitExceeded {
            maximum: MAX_WORKER_STDOUT_BYTES,
            ..
        })
    ));
}

#[test]
fn supervision_stderr_is_separate_and_capped() {
    for (count, truncated) in [
        (17, false),
        (MAX_WORKER_STDERR_BYTES, false),
        (MAX_WORKER_STDERR_BYTES + 17, true),
    ] {
        let worker = program("stderr", [OsString::from(count.to_string())]);
        let supervisor = make_supervisor(worker.clone(), worker, Duration::from_secs(3));
        let response = supervisor
            .supervise(&request_frame(NativeDaeBackendWire::Dense))
            .expect("stderr worker response");
        assert_eq!(response.payload(), b"stderr-stayed-separate");
        assert_eq!(
            response.diagnostics().stderr().len(),
            count.min(MAX_WORKER_STDERR_BYTES)
        );
        assert!(response
            .diagnostics()
            .stderr()
            .iter()
            .all(|byte| *byte == b'e'));
        assert_eq!(response.diagnostics().stderr_truncated(), truncated);
    }
}

#[test]
fn supervision_wall_deadline_terminates_and_reaps_the_worker() {
    let boundary_policy =
        SupervisorPolicy::new(Duration::from_millis(750)).expect("boundary policy");
    assert!(boundary_policy.completion_observed_before_deadline(Duration::from_nanos(749_999_999)));
    assert!(!boundary_policy.completion_observed_before_deadline(Duration::from_millis(750)));
    assert!(!boundary_policy.completion_observed_before_deadline(Duration::from_millis(751)));

    let leader_identity = artifact_path("deadline-leader-identity");
    let descendant_identity = artifact_path("deadline-descendant-identity");
    let hanger = program(
        "hang-with-descendant",
        [
            leader_identity.as_os_str().to_owned(),
            descendant_identity.as_os_str().to_owned(),
        ],
    );
    let supervisor = make_supervisor(hanger.clone(), hanger, Duration::from_millis(750));
    let large_request = padded_request_frame(1024 * 1024);
    let started = Instant::now();
    match supervisor.supervise(&large_request) {
        Err(SupervisionError::TimedOut { maximum, .. }) => {
            assert_eq!(maximum, Duration::from_millis(750));
        }
        other => panic!("unexpected wall-deadline result: {other:?}"),
    }
    assert!(started.elapsed() < Duration::from_secs(2));
    let leader = read_process_identity(&leader_identity);
    let descendant = read_process_identity(&descendant_identity);
    wait_until_reaped(leader);
    wait_until_not_running(descendant);

    let escaped_leader_identity = artifact_path("escaped-leader-identity");
    let group_transition = artifact_path("escaped-leader-groups");
    let escaped_leader = program(
        "escape-group-hang",
        [
            escaped_leader_identity.as_os_str().to_owned(),
            group_transition.as_os_str().to_owned(),
        ],
    );
    let supervisor = make_supervisor(
        escaped_leader.clone(),
        escaped_leader,
        Duration::from_millis(400),
    );
    let started = Instant::now();
    assert!(matches!(
        supervisor.supervise(&request_frame(NativeDaeBackendWire::Dense)),
        Err(SupervisionError::TimedOut { maximum, .. })
            if maximum == Duration::from_millis(400)
    ));
    assert!(started.elapsed() < Duration::from_secs(2));
    let (original_group, escaped_group) = read_group_transition(&group_transition);
    assert_ne!(original_group, escaped_group);
    wait_until_reaped(read_process_identity(&escaped_leader_identity));

    let exit_descendant_identity = artifact_path("exit-descendant-identity");
    let exits = program(
        "exit-with-descendant",
        [exit_descendant_identity.as_os_str().to_owned()],
    );
    let supervisor = make_supervisor(exits.clone(), exits, Duration::from_secs(2));
    let started = Instant::now();
    assert_eq!(
        supervisor
            .supervise(&request_frame(NativeDaeBackendWire::Dense))
            .expect("leader exit closes descendant-held pipes")
            .payload(),
        b"leader-exited"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    wait_until_not_running(read_process_identity(&exit_descendant_identity));

    assert_eq!(
        SupervisorPolicy::new(Duration::ZERO).unwrap_err(),
        SupervisorConfigError::ZeroWallTime
    );
    assert!(matches!(
        SupervisorPolicy::new(MAX_WORKER_WALL_TIME + Duration::from_millis(1)),
        Err(SupervisorConfigError::WallTimeTooLong { .. })
    ));
}

#[test]
fn supervision_nonzero_exit_or_signal_returns_typed_failure() {
    let exit = program("exit", [OsString::from("7")]);
    let exit_supervisor = make_supervisor(exit.clone(), exit, Duration::from_secs(2));
    match exit_supervisor.supervise(&request_frame(NativeDaeBackendWire::Dense)) {
        Err(SupervisionError::WorkerExited {
            status: WorkerExit::Code(7),
            diagnostics,
            ..
        }) => assert_eq!(diagnostics.stderr(), b"exit-7"),
        other => panic!("unexpected exit result: {other:?}"),
    }

    let signal = program("signal", Vec::<OsString>::new());
    let signal_supervisor = make_supervisor(signal.clone(), signal, Duration::from_secs(2));
    match signal_supervisor.supervise(&request_frame(NativeDaeBackendWire::Dense)) {
        Err(SupervisionError::WorkerExited {
            status: WorkerExit::Signal(15),
            diagnostics,
            ..
        }) => assert_eq!(diagnostics.stderr(), b"signal-15"),
        other => panic!("unexpected signal result: {other:?}"),
    }
}

#[test]
fn supervision_linux_worker_policy_applies_fixed_resource_limits() {
    let limits = program("limits", Vec::<OsString>::new());
    let supervisor = make_supervisor(limits.clone(), limits, Duration::from_secs(2));
    let response = supervisor
        .supervise(&request_frame(NativeDaeBackendWire::Dense))
        .expect("limit-reporting worker");
    assert_eq!(
        String::from_utf8(response.payload().to_vec()).expect("ASCII limit report"),
        format!(
            "as={0}:{0};cpu={1}:{1};core={2}:{2};nofile={3}:{3};no_new_privs=1",
            LINUX_WORKER_ADDRESS_SPACE_BYTES,
            LINUX_WORKER_CPU_SECONDS,
            LINUX_WORKER_CORE_BYTES,
            LINUX_WORKER_OPEN_FILES,
        )
    );
}
