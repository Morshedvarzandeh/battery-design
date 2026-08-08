//! Linux one-shot process supervision with explicit same-group bounds.
//!
//! This module never loads a native solver. It chooses one trusted worker
//! executable from the admitted backend, writes one request frame to the
//! worker's standard input, closes that pipe, and accepts exactly one bounded
//! response frame from standard output. It is source-only infrastructure: no
//! worker executable or product integration is supplied by this crate.
//!
//! The wall, process-group and drain policy governs the direct worker and
//! descendants that remain in its original process group. A descendant moved
//! or created outside that group can survive group cleanup and retain a pipe;
//! the owned direct worker is still addressed by `Child::kill` and reaped.
//! `DrainDeadlineExceeded` returns without joining a still-blocked I/O thread,
//! so repeated descendant escapes can accumulate process and thread resources.
//! This is not a sandbox or an aggregate process-lifetime guarantee.

use crate::admission::{admit_request_frame, AdmissionError, AdmittedNativeSettings};
use crate::protocol::{
    FrameDecoder, FrameError, FrameKind, NativeDaeBackendWire, FRAME_HEADER_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
};
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_WORKER_WALL_TIME: Duration = Duration::from_secs(25);
pub const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(5);
pub const WORKER_DRAIN_DEADLINE: Duration = Duration::from_secs(2);
pub const MAX_WORKER_STDOUT_BYTES: usize = FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES;
pub const MAX_WORKER_STDERR_BYTES: usize = 64 * 1024;

pub const LINUX_WORKER_ADDRESS_SPACE_BYTES: u64 = 768 * 1024 * 1024;
pub const LINUX_WORKER_CPU_SECONDS: u64 = 20;
pub const LINUX_WORKER_CORE_BYTES: u64 = 0;
pub const LINUX_WORKER_OPEN_FILES: u64 = 16;

#[cfg(target_os = "linux")]
const _: () = {
    assert!(LINUX_WORKER_ADDRESS_SPACE_BYTES <= libc::rlim_t::MAX as u64);
    assert!(LINUX_WORKER_CPU_SECONDS <= libc::rlim_t::MAX as u64);
    assert!(LINUX_WORKER_CORE_BYTES <= libc::rlim_t::MAX as u64);
    assert!(LINUX_WORKER_OPEN_FILES <= libc::rlim_t::MAX as u64);
};

pub const WORKER_PROTOCOL_ENV: &str = "BATTERY_DESIGN_DAE_WORKER_PROTOCOL";
pub const WORKER_BACKEND_ENV: &str = "BATTERY_DESIGN_DAE_BACKEND";
pub const WORKER_PROTOCOL_ID: &str = "battery-design/native-dae-worker@1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerProgram {
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
}

impl WorkerProgram {
    pub fn new(
        executable: impl Into<PathBuf>,
        working_directory: impl Into<PathBuf>,
        arguments: impl IntoIterator<Item = OsString>,
    ) -> Result<Self, SupervisorConfigError> {
        let executable = executable.into();
        if !executable.is_absolute() {
            return Err(SupervisorConfigError::ExecutableNotAbsolute);
        }
        let working_directory = working_directory.into();
        if !working_directory.is_absolute() {
            return Err(SupervisorConfigError::WorkingDirectoryNotAbsolute);
        }
        Ok(Self {
            executable,
            working_directory,
            arguments: arguments.into_iter().collect(),
        })
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn working_directory(&self) -> &Path {
        &self.working_directory
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerPrograms {
    dense: WorkerProgram,
    klu: WorkerProgram,
}

impl WorkerPrograms {
    pub fn new(dense: WorkerProgram, klu: WorkerProgram) -> Self {
        Self { dense, klu }
    }

    fn select(&self, backend: NativeDaeBackendWire) -> &WorkerProgram {
        match backend {
            NativeDaeBackendWire::Dense => &self.dense,
            NativeDaeBackendWire::Klu => &self.klu,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SupervisorPolicy {
    wall_time: Duration,
}

impl SupervisorPolicy {
    pub fn new(wall_time: Duration) -> Result<Self, SupervisorConfigError> {
        if wall_time.is_zero() {
            return Err(SupervisorConfigError::ZeroWallTime);
        }
        if wall_time > MAX_WORKER_WALL_TIME {
            return Err(SupervisorConfigError::WallTimeTooLong {
                actual: wall_time,
                maximum: MAX_WORKER_WALL_TIME,
            });
        }
        Ok(Self { wall_time })
    }

    pub fn wall_time(self) -> Duration {
        self.wall_time
    }

    /// Returns whether completion observed at `elapsed` is still timely.
    /// Observation exactly at the deadline is conservatively late.
    pub fn completion_observed_before_deadline(self, elapsed: Duration) -> bool {
        elapsed < self.wall_time
    }
}

impl Default for SupervisorPolicy {
    fn default() -> Self {
        Self {
            wall_time: MAX_WORKER_WALL_TIME,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupervisorConfigError {
    UnsupportedPlatform,
    ExecutableNotAbsolute,
    WorkingDirectoryNotAbsolute,
    ZeroWallTime,
    WallTimeTooLong { actual: Duration, maximum: Duration },
}

impl fmt::Display for SupervisorConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid native DAE supervisor configuration: {self:?}"
        )
    }
}

impl std::error::Error for SupervisorConfigError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerDiagnostics {
    stderr: Vec<u8>,
    stderr_truncated: bool,
}

impl WorkerDiagnostics {
    pub fn stderr(&self) -> &[u8] {
        &self.stderr
    }

    pub fn stderr_truncated(&self) -> bool {
        self.stderr_truncated
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerResponse {
    backend: NativeDaeBackendWire,
    payload: Vec<u8>,
    diagnostics: WorkerDiagnostics,
}

impl WorkerResponse {
    pub fn backend(&self) -> NativeDaeBackendWire {
        self.backend
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    pub fn diagnostics(&self) -> &WorkerDiagnostics {
        &self.diagnostics
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerExit {
    Code(i32),
    Signal(i32),
    TerminatedWithoutCode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerIoStage {
    Spawn,
    ThreadSpawn,
    RequestWrite,
    StdoutRead,
    StderrRead,
    Poll,
    Cleanup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerThreadRole {
    RequestWriter,
    StdoutReader,
    StderrReader,
}

#[derive(Debug)]
pub enum SupervisionError {
    Busy,
    Admission(AdmissionError),
    ProcessIo {
        backend: NativeDaeBackendWire,
        stage: WorkerIoStage,
        kind: io::ErrorKind,
        diagnostics: Option<WorkerDiagnostics>,
    },
    WorkerThreadClosed {
        role: WorkerThreadRole,
    },
    DrainDeadlineExceeded {
        role: WorkerThreadRole,
        maximum: Duration,
    },
    RequestAllocationFailed {
        requested: usize,
    },
    TimedOut {
        backend: NativeDaeBackendWire,
        maximum: Duration,
        diagnostics: WorkerDiagnostics,
    },
    WorkerExited {
        backend: NativeDaeBackendWire,
        status: WorkerExit,
        diagnostics: WorkerDiagnostics,
    },
    StdoutLimitExceeded {
        maximum: usize,
        diagnostics: WorkerDiagnostics,
    },
    InvalidResponse {
        source: FrameError,
        diagnostics: WorkerDiagnostics,
    },
    InternalPipeMissing {
        role: WorkerThreadRole,
    },
}

impl fmt::Display for SupervisionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "native DAE worker supervision failed: {self:?}")
    }
}

impl std::error::Error for SupervisionError {}

impl From<AdmissionError> for SupervisionError {
    fn from(error: AdmissionError) -> Self {
        Self::Admission(error)
    }
}

#[derive(Debug)]
pub struct OneShotSupervisor {
    programs: WorkerPrograms,
    policy: SupervisorPolicy,
    active: AtomicBool,
}

impl OneShotSupervisor {
    pub fn new(
        programs: WorkerPrograms,
        policy: SupervisorPolicy,
    ) -> Result<Self, SupervisorConfigError> {
        if !cfg!(target_os = "linux") {
            return Err(SupervisorConfigError::UnsupportedPlatform);
        }
        Ok(Self {
            programs,
            policy,
            active: AtomicBool::new(false),
        })
    }

    pub fn supervise(&self, request_frame: &[u8]) -> Result<WorkerResponse, SupervisionError> {
        let _lease = ActiveLease::acquire(&self.active).ok_or(SupervisionError::Busy)?;
        let admitted = admit_request_frame(request_frame)?;
        let backend = match admitted.native_settings() {
            AdmittedNativeSettings::Dense(_) => NativeDaeBackendWire::Dense,
            AdmittedNativeSettings::Klu(_) => NativeDaeBackendWire::Klu,
        };
        drop(admitted);

        #[cfg(target_os = "linux")]
        {
            self.supervise_linux(backend, request_frame)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (backend, request_frame);
            Err(SupervisionError::ProcessIo {
                backend,
                stage: WorkerIoStage::Spawn,
                kind: io::ErrorKind::Unsupported,
                diagnostics: None,
            })
        }
    }

    #[cfg(target_os = "linux")]
    fn supervise_linux(
        &self,
        backend: NativeDaeBackendWire,
        request_frame: &[u8],
    ) -> Result<WorkerResponse, SupervisionError> {
        use std::os::unix::process::CommandExt;

        let program = self.programs.select(backend);
        let mut input = Vec::new();
        input.try_reserve_exact(request_frame.len()).map_err(|_| {
            SupervisionError::RequestAllocationFailed {
                requested: request_frame.len(),
            }
        })?;
        input.extend_from_slice(request_frame);
        let mut command = Command::new(program.executable());
        command
            .args(program.arguments())
            .current_dir(program.working_directory())
            .env_clear()
            .env(WORKER_PROTOCOL_ENV, WORKER_PROTOCOL_ID)
            .env(WORKER_BACKEND_ENV, backend_id(backend))
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        // SAFETY: fixed policy constants are proven to fit rlim_t at compile
        // time. The post-fork closure performs only setrlimit/prctl libc calls
        // and constructs a non-formatting io::Error directly from errno.
        unsafe {
            command.pre_exec(apply_linux_worker_policy);
        }
        let started = Instant::now();
        let mut child = command
            .spawn()
            .map_err(|error| SupervisionError::ProcessIo {
                backend,
                stage: WorkerIoStage::Spawn,
                kind: error.kind(),
                diagnostics: None,
            })?;
        let process_group = child.id();

        let stdin = match child.stdin.take() {
            Some(pipe) => pipe,
            None => {
                let _ = cleanup_running_child(&mut child, process_group);
                return Err(SupervisionError::InternalPipeMissing {
                    role: WorkerThreadRole::RequestWriter,
                });
            }
        };
        let stdout = match child.stdout.take() {
            Some(pipe) => pipe,
            None => {
                let _ = cleanup_running_child(&mut child, process_group);
                return Err(SupervisionError::InternalPipeMissing {
                    role: WorkerThreadRole::StdoutReader,
                });
            }
        };
        let stderr = match child.stderr.take() {
            Some(pipe) => pipe,
            None => {
                let _ = cleanup_running_child(&mut child, process_group);
                return Err(SupervisionError::InternalPipeMissing {
                    role: WorkerThreadRole::StderrReader,
                });
            }
        };

        let writer = match spawn_writer(stdin, input) {
            Ok(receiver) => receiver,
            Err(error) => {
                cleanup_running_child(&mut child, process_group).map_err(|cleanup| {
                    SupervisionError::ProcessIo {
                        backend,
                        stage: WorkerIoStage::Cleanup,
                        kind: cleanup.kind(),
                        diagnostics: None,
                    }
                })?;
                return Err(SupervisionError::ProcessIo {
                    backend,
                    stage: WorkerIoStage::ThreadSpawn,
                    kind: error.kind(),
                    diagnostics: None,
                });
            }
        };
        let stdout_reader = match spawn_reader(stdout, MAX_WORKER_STDOUT_BYTES, "dae-worker-stdout")
        {
            Ok(receiver) => receiver,
            Err(error) => {
                cleanup_running_child(&mut child, process_group).map_err(|cleanup| {
                    SupervisionError::ProcessIo {
                        backend,
                        stage: WorkerIoStage::Cleanup,
                        kind: cleanup.kind(),
                        diagnostics: None,
                    }
                })?;
                return Err(SupervisionError::ProcessIo {
                    backend,
                    stage: WorkerIoStage::ThreadSpawn,
                    kind: error.kind(),
                    diagnostics: None,
                });
            }
        };
        let stderr_reader = match spawn_reader(stderr, MAX_WORKER_STDERR_BYTES, "dae-worker-stderr")
        {
            Ok(receiver) => receiver,
            Err(error) => {
                cleanup_running_child(&mut child, process_group).map_err(|cleanup| {
                    SupervisionError::ProcessIo {
                        backend,
                        stage: WorkerIoStage::Cleanup,
                        kind: cleanup.kind(),
                        diagnostics: None,
                    }
                })?;
                return Err(SupervisionError::ProcessIo {
                    backend,
                    stage: WorkerIoStage::ThreadSpawn,
                    kind: error.kind(),
                    diagnostics: None,
                });
            }
        };

        let (outcome, cleanup_error) = loop {
            if !self
                .policy
                .completion_observed_before_deadline(started.elapsed())
            {
                break (
                    ProcessOutcome::TimedOut,
                    cleanup_running_child(&mut child, process_group).err(),
                );
            }
            match leader_exited_without_reaping(process_group) {
                Ok(true) => {
                    if !self
                        .policy
                        .completion_observed_before_deadline(started.elapsed())
                    {
                        break (
                            ProcessOutcome::TimedOut,
                            cleanup_running_child(&mut child, process_group).err(),
                        );
                    }
                    // Keep the exited leader unreaped until after the group
                    // signal so its PID cannot be reused as an unrelated PGID.
                    let group_error = kill_process_group(process_group).err();
                    match child.wait() {
                        Ok(status) => break (ProcessOutcome::Exited(status), group_error),
                        Err(error) => {
                            break (
                                ProcessOutcome::PollFailed(error.kind()),
                                group_error.or(Some(error)),
                            )
                        }
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    break (
                        ProcessOutcome::PollFailed(error.kind()),
                        cleanup_running_child(&mut child, process_group).err(),
                    );
                }
            }
            let remaining = self.policy.wall_time().saturating_sub(started.elapsed());
            thread::sleep(WORKER_POLL_INTERVAL.min(remaining));
        };

        let drain_deadline = Instant::now() + WORKER_DRAIN_DEADLINE;
        // Attempt every receive under one absolute deadline even when cleanup
        // failed. This closes all completed channels deterministically and
        // preserves the cleanup failure as the primary result.
        let writer_received =
            receive_before(writer, WorkerThreadRole::RequestWriter, drain_deadline);
        let stdout_received = receive_before(
            stdout_reader,
            WorkerThreadRole::StdoutReader,
            drain_deadline,
        );
        let stderr_received = receive_before(
            stderr_reader,
            WorkerThreadRole::StderrReader,
            drain_deadline,
        );

        if let Some(error) = cleanup_error {
            let diagnostics = match stderr_received {
                Ok(Ok(stderr)) => Some(WorkerDiagnostics {
                    stderr: stderr.bytes,
                    stderr_truncated: stderr.truncated,
                }),
                _ => None,
            };
            return Err(SupervisionError::ProcessIo {
                backend,
                stage: WorkerIoStage::Cleanup,
                kind: error.kind(),
                diagnostics,
            });
        }

        let writer_result = writer_received?;
        let stdout_result = stdout_received?;
        let stderr_result = stderr_received?;

        let stderr = stderr_result.map_err(|kind| SupervisionError::ProcessIo {
            backend,
            stage: WorkerIoStage::StderrRead,
            kind,
            diagnostics: None,
        })?;
        let diagnostics = WorkerDiagnostics {
            stderr: stderr.bytes,
            stderr_truncated: stderr.truncated,
        };

        if matches!(&outcome, ProcessOutcome::TimedOut) {
            return Err(SupervisionError::TimedOut {
                backend,
                maximum: self.policy.wall_time(),
                diagnostics,
            });
        }
        if let ProcessOutcome::PollFailed(kind) = &outcome {
            return Err(SupervisionError::ProcessIo {
                backend,
                stage: WorkerIoStage::Poll,
                kind: *kind,
                diagnostics: Some(diagnostics),
            });
        }
        let ProcessOutcome::Exited(status) = outcome else {
            unreachable!("timeout and poll failures returned above")
        };
        if !status.success() {
            return Err(SupervisionError::WorkerExited {
                backend,
                status: worker_exit(status),
                diagnostics,
            });
        }
        writer_result.map_err(|kind| SupervisionError::ProcessIo {
            backend,
            stage: WorkerIoStage::RequestWrite,
            kind,
            diagnostics: Some(diagnostics.clone()),
        })?;
        let stdout = stdout_result.map_err(|kind| SupervisionError::ProcessIo {
            backend,
            stage: WorkerIoStage::StdoutRead,
            kind,
            diagnostics: Some(diagnostics.clone()),
        })?;
        if stdout.truncated {
            return Err(SupervisionError::StdoutLimitExceeded {
                maximum: MAX_WORKER_STDOUT_BYTES,
                diagnostics,
            });
        }
        let mut decoder = FrameDecoder::new(FrameKind::Response);
        decoder
            .push(&stdout.bytes)
            .map_err(|source| SupervisionError::InvalidResponse {
                source,
                diagnostics: diagnostics.clone(),
            })?;
        let payload = decoder
            .finish()
            .map_err(|source| SupervisionError::InvalidResponse {
                source,
                diagnostics: diagnostics.clone(),
            })?;
        Ok(WorkerResponse {
            backend,
            payload,
            diagnostics,
        })
    }
}

struct ActiveLease<'a> {
    active: &'a AtomicBool,
}

impl<'a> ActiveLease<'a> {
    fn acquire(active: &'a AtomicBool) -> Option<Self> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self { active })
    }
}

impl Drop for ActiveLease<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[derive(Debug)]
struct CapturedBytes {
    bytes: Vec<u8>,
    truncated: bool,
}

enum ProcessOutcome {
    Exited(ExitStatus),
    TimedOut,
    PollFailed(io::ErrorKind),
}

fn backend_id(backend: NativeDaeBackendWire) -> &'static str {
    match backend {
        NativeDaeBackendWire::Dense => "sundials-ida-dense",
        NativeDaeBackendWire::Klu => "sundials-ida-klu",
    }
}

fn spawn_writer(
    mut stdin: ChildStdin,
    input: Vec<u8>,
) -> io::Result<Receiver<Result<(), io::ErrorKind>>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("dae-worker-stdin".to_string())
        .spawn(move || {
            let result = stdin
                .write_all(&input)
                .and_then(|_| stdin.flush())
                .map_err(|error| error.kind());
            drop(stdin);
            let _ = sender.send(result);
        })?;
    Ok(receiver)
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    maximum: usize,
    name: &str,
) -> io::Result<Receiver<Result<CapturedBytes, io::ErrorKind>>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let mut kept = Vec::new();
            let mut truncated = false;
            let mut buffer = [0_u8; 8 * 1024];
            let result = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        break Ok(CapturedBytes {
                            bytes: kept,
                            truncated,
                        })
                    }
                    Ok(count) => {
                        let remaining = maximum.saturating_sub(kept.len());
                        let keep = remaining.min(count);
                        kept.extend_from_slice(&buffer[..keep]);
                        truncated |= keep < count;
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => break Err(error.kind()),
                }
            };
            let _ = sender.send(result);
        })?;
    Ok(receiver)
}

fn receive_before<T>(
    receiver: Receiver<T>,
    role: WorkerThreadRole,
    deadline: Instant,
) -> Result<T, SupervisionError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    match receiver.recv_timeout(remaining) {
        Ok(value) => Ok(value),
        Err(RecvTimeoutError::Timeout) => Err(SupervisionError::DrainDeadlineExceeded {
            role,
            maximum: WORKER_DRAIN_DEADLINE,
        }),
        Err(RecvTimeoutError::Disconnected) => Err(SupervisionError::WorkerThreadClosed { role }),
    }
}

#[cfg(target_os = "linux")]
fn apply_linux_worker_policy() -> io::Result<()> {
    set_linux_limit(
        libc::RLIMIT_AS,
        LINUX_WORKER_ADDRESS_SPACE_BYTES as libc::rlim_t,
    )?;
    set_linux_limit(libc::RLIMIT_CPU, LINUX_WORKER_CPU_SECONDS as libc::rlim_t)?;
    set_linux_limit(libc::RLIMIT_CORE, LINUX_WORKER_CORE_BYTES as libc::rlim_t)?;
    set_linux_limit(libc::RLIMIT_NOFILE, LINUX_WORKER_OPEN_FILES as libc::rlim_t)?;
    // SAFETY: prctl is called with the documented PR_SET_NO_NEW_PRIVS
    // integer arguments and no pointers.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(linux_errno_error());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_linux_limit(resource: libc::__rlimit_resource_t, value: libc::rlim_t) -> io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: limit points to a valid rlimit for the duration of the call.
    if unsafe { libc::setrlimit(resource, &limit) } != 0 {
        return Err(linux_errno_error());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_errno_error() -> io::Error {
    // SAFETY: libc exposes the calling thread's valid errno location.
    let errno = unsafe { *libc::__errno_location() };
    io::Error::from_raw_os_error(errno)
}

#[cfg(target_os = "linux")]
fn kill_process_group(process_group: u32) -> io::Result<()> {
    let process_group = i32::try_from(process_group)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "worker pid overflow"))?;
    // SAFETY: a negative pid addresses only the child-owned process group.
    if unsafe { libc::kill(-process_group, libc::SIGKILL) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(target_os = "linux")]
fn leader_exited_without_reaping(pid: u32) -> io::Result<bool> {
    let expected_pid = libc::pid_t::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "worker pid overflow"))?;
    let mut information = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: information points to writable siginfo_t storage. WNOWAIT
    // observes the exact child without reaping it, preserving PID/PGID
    // ownership until process-group cleanup has been attempted.
    if unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            information.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: waitid succeeded and therefore initialized the supplied
    // siginfo_t; the zeroed si_pid remains zero when WNOHANG finds no exit.
    let observed_pid = unsafe { information.assume_init().si_pid() };
    if observed_pid == 0 {
        Ok(false)
    } else if observed_pid == expected_pid {
        Ok(true)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "waitid returned a different child",
        ))
    }
}

#[cfg(target_os = "linux")]
fn cleanup_running_child(child: &mut Child, process_group: u32) -> io::Result<()> {
    let group_error = kill_process_group(process_group).err();
    let direct_error = match child.kill() {
        Ok(()) => None,
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => None,
        Err(error) => Some(error),
    };
    let wait_error = child.wait().err();
    group_error
        .or(direct_error)
        .or(wait_error)
        .map_or(Ok(()), Err)
}

fn worker_exit(status: ExitStatus) -> WorkerExit {
    if let Some(code) = status.code() {
        return WorkerExit::Code(code);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return WorkerExit::Signal(signal);
        }
    }
    WorkerExit::TerminatedWithoutCode
}
