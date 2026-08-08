//! Test-only executable fixture compiled directly by the supervision campaign.

#![deny(warnings)]

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::Duration;

const RESPONSE_MAGIC: [u8; 4] = *b"BDR1";

#[repr(C)]
#[derive(Clone, Copy)]
struct RLimit {
    current: u64,
    maximum: u64,
}

extern "C" {
    fn getrlimit(resource: u32, limit: *mut RLimit) -> i32;
    fn prctl(option: i32, ...) -> i32;
    fn raise(signal: i32) -> i32;
    fn getpgrp() -> i32;
    fn getppid() -> i32;
    fn getpgid(pid: i32) -> i32;
    fn setpgid(pid: i32, pgid: i32) -> i32;
}

fn main() {
    if let Err(error) = run() {
        eprintln!("fixture error: {error}");
        process::exit(101);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os();
    let _executable = arguments.next();
    let mode = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or("missing fixture mode")?;
    let rest = arguments.collect::<Vec<_>>();

    match mode.as_str() {
        "echo" => {
            let marker = rest.first().ok_or("missing echo marker")?;
            let _request = read_request()?;
            append_marker(Path::new(marker))?;
            write_response(b"ok")?;
        }
        "environment" => {
            let _request = read_request()?;
            let mut values = env::vars().collect::<Vec<_>>();
            values.sort();
            let stdin_pipe = fs::read_link("/proc/self/fd/0")?
                .to_string_lossy()
                .starts_with("pipe:[");
            let stdout_pipe = fs::read_link("/proc/self/fd/1")?
                .to_string_lossy()
                .starts_with("pipe:[");
            let stderr_pipe = fs::read_link("/proc/self/fd/2")?
                .to_string_lossy()
                .starts_with("pipe:[");
            let payload = format!(
                "cwd={}\nstdin_pipe={stdin_pipe}\nstdout_pipe={stdout_pipe}\nstderr_pipe={stderr_pipe}\n{}\n",
                env::current_dir()?.display(),
                values
                    .into_iter()
                    .map(|(key, value)| format!("{key}={value}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            eprint!("environment-stderr");
            io::stderr().flush()?;
            write_response(payload.as_bytes())?;
        }
        "record" => {
            let path = rest.first().ok_or("missing record path")?;
            let request = read_request()?;
            fs::write(path, request)?;
            write_response(b"recorded-after-eof")?;
        }
        "stdout" => {
            let kind = rest
                .first()
                .and_then(|value| value.to_str())
                .ok_or("missing stdout kind")?;
            let _request = read_request()?;
            match kind {
                "valid" => write_response(b"ok")?,
                "truncated" => {
                    io::stdout().write_all(&[b'B', b'D', b'R', b'1', 4, 0, 0, 0, b'o', b'k'])?;
                }
                "trailing" => {
                    write_response(b"ok")?;
                    io::stdout().write_all(b"x")?;
                }
                "over" => {
                    let count = rest
                        .get(1)
                        .and_then(|value| value.to_str())
                        .ok_or("missing stdout count")?
                        .parse::<usize>()?;
                    write_repeated(&mut io::stdout(), b'x', count)?;
                }
                _ => return Err("unknown stdout kind".into()),
            }
            io::stdout().flush()?;
        }
        "stderr" => {
            let count = rest
                .first()
                .and_then(|value| value.to_str())
                .ok_or("missing stderr count")?
                .parse::<usize>()?;
            let _request = read_request()?;
            write_repeated(&mut io::stderr(), b'e', count)?;
            io::stderr().flush()?;
            write_response(b"stderr-stayed-separate")?;
        }
        "hang-read" => {
            let marker = rest.first().ok_or("missing hang marker")?;
            let _request = read_request()?;
            append_marker(Path::new(marker))?;
            hang();
        }
        "escape-group-hang" => {
            let identity_path = rest.first().ok_or("missing escaped identity path")?;
            let transition_path = rest.get(1).ok_or("missing group transition path")?;
            // SAFETY: these scalar process-group calls address this worker and
            // its direct parent in their shared Linux session.
            let original_group = unsafe { getpgrp() };
            let parent_pid = unsafe { getppid() };
            let parent_group = unsafe { getpgid(parent_pid) };
            if parent_group < 0 {
                return Err(io::Error::last_os_error().into());
            }
            // SAFETY: pid zero selects this process and parent_group names an
            // existing group in the same session.
            if unsafe { setpgid(0, parent_group) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
            // SAFETY: getpgrp takes no arguments and cannot alias memory.
            let escaped_group = unsafe { getpgrp() };
            if original_group == escaped_group || escaped_group != parent_group {
                return Err("fixture did not escape its original process group".into());
            }
            write_process_identity(Path::new(identity_path))?;
            fs::write(
                transition_path,
                format!("{original_group} {escaped_group}\n"),
            )?;
            hang();
        }
        "hang-with-descendant" => {
            let leader_path = rest.first().ok_or("missing leader pid path")?;
            let descendant_path = rest.get(1).ok_or("missing descendant pid path")?;
            let _descendant = Command::new(env::current_exe()?)
                .arg("hold-pipes")
                .arg(descendant_path)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()?;
            write_process_identity(Path::new(leader_path))?;
            wait_for_identity(Path::new(descendant_path))?;
            hang();
        }
        "exit-with-descendant" => {
            let descendant_path = rest.first().ok_or("missing descendant pid path")?;
            let _request = read_request()?;
            let _descendant = Command::new(env::current_exe()?)
                .arg("hold-pipes")
                .arg(descendant_path)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()?;
            wait_for_identity(Path::new(descendant_path))?;
            write_response(b"leader-exited")?;
        }
        "hold-pipes" => {
            if let Some(path) = rest.first() {
                write_process_identity(Path::new(path))?;
            }
            hang();
        }
        "exit" => {
            let code = rest
                .first()
                .and_then(|value| value.to_str())
                .ok_or("missing exit code")?
                .parse::<i32>()?;
            let _request = read_request()?;
            eprint!("exit-{code}");
            io::stderr().flush()?;
            process::exit(code);
        }
        "signal" => {
            let _request = read_request()?;
            eprint!("signal-15");
            io::stderr().flush()?;
            // SAFETY: SIGTERM is a valid signal for the current process.
            if unsafe { raise(15) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
            return Err("SIGTERM unexpectedly returned".into());
        }
        "limits" => {
            let _request = read_request()?;
            let address_space = read_limit(9)?;
            let cpu = read_limit(0)?;
            let core = read_limit(4)?;
            let files = read_limit(7)?;
            // SAFETY: PR_GET_NO_NEW_PRIVS takes zero scalar arguments.
            let no_new_privs = unsafe { prctl(39, 0_usize, 0_usize, 0_usize, 0_usize) };
            if no_new_privs < 0 {
                return Err(io::Error::last_os_error().into());
            }
            let payload = format!(
                "as={}:{};cpu={}:{};core={}:{};nofile={}:{};no_new_privs={no_new_privs}",
                address_space.current,
                address_space.maximum,
                cpu.current,
                cpu.maximum,
                core.current,
                core.maximum,
                files.current,
                files.maximum,
            );
            write_response(payload.as_bytes())?;
        }
        _ => return Err("unknown fixture mode".into()),
    }
    Ok(())
}

fn read_request() -> io::Result<Vec<u8>> {
    let mut request = Vec::new();
    io::stdin().read_to_end(&mut request)?;
    Ok(request)
}

fn write_response(payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "fixture payload too large"))?;
    let mut stdout = io::stdout();
    stdout.write_all(&RESPONSE_MAGIC)?;
    stdout.write_all(&length.to_le_bytes())?;
    stdout.write_all(payload)?;
    stdout.flush()
}

fn write_repeated(writer: &mut impl Write, byte: u8, count: usize) -> io::Result<()> {
    let chunk = [byte; 8 * 1024];
    let mut remaining = count;
    while remaining > 0 {
        let take = remaining.min(chunk.len());
        writer.write_all(&chunk[..take])?;
        remaining -= take;
    }
    Ok(())
}

fn append_marker(path: &Path) -> io::Result<()> {
    let mut marker = OpenOptions::new().create(true).append(true).open(path)?;
    marker.write_all(b"spawn\n")
}

fn write_process_identity(path: &Path) -> io::Result<()> {
    let stat = fs::read_to_string("/proc/self/stat")?;
    let (identity, fields) = stat
        .rsplit_once(") ")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed proc stat"))?;
    let pid = identity
        .split_once(' ')
        .map(|(pid, _)| pid)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing proc pid"))?;
    let fields = fields.split_whitespace().collect::<Vec<_>>();
    let start_time = fields
        .get(19)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing proc start time"))?;
    fs::write(path, format!("{pid} {start_time}\n"))
}

fn wait_for_identity(path: &Path) -> io::Result<()> {
    for _ in 0..200 {
        if let Ok(identity) = fs::read_to_string(path) {
            let mut fields = identity.split_whitespace();
            if fields
                .next()
                .and_then(|pid| pid.parse::<u32>().ok())
                .is_some()
                && fields
                    .next()
                    .and_then(|start| start.parse::<u64>().ok())
                    .is_some()
                && fields.next().is_none()
            {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "descendant did not publish its process identity",
    ))
}

fn hang() -> ! {
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn read_limit(resource: u32) -> io::Result<RLimit> {
    let mut limit = RLimit {
        current: 0,
        maximum: 0,
    };
    // SAFETY: limit is valid writable storage and resource is a Linux RLIMIT.
    if unsafe { getrlimit(resource, &mut limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(limit)
}
