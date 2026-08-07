// main.rs — the window, and the Node runner behind it.
//
// This is deliberately the smallest program that could possibly work, because
// everything it shows already exists and works. The web app is the interface;
// `bd.mjs serve` already serves that interface AND the desktop API beside it.
// So the desktop application is not a third implementation of the designer —
// it is a window and a process manager, and that is the whole point.
//
// What it does, in order:
//
//   1. Find a free port, so two copies can run at once and nothing collides
//      with whatever else is listening on 8080.
//   2. Spawn the bundled Node runtime against the bundled `bd.mjs serve`.
//   3. Wait until the server actually answers, rather than guessing at a
//      sleep — a slow machine is exactly where a fixed delay breaks.
//   4. Point the window at it.
//
// If the authenticated runner cannot start, the window still opens the
// bundled page at browser tier. So a failure here costs the heavy compute, not
// the application, and an unrelated process can never be accepted as runner.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Ask the OS for a port nobody is using, then let go of it. There is a race
/// between releasing it and Node binding it, and it is the standard one every
/// tool of this shape accepts: the alternative is a hard-coded port that
/// collides with whatever the customer already has running.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8420)
}

/// Generate the bearer secret shared only by this window and its sidecar.
/// `getrandom` reads the operating system CSPRNG on every supported target;
/// failure is fatal rather than falling back to a guessable token.
fn launch_token() -> std::io::Result<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|e| std::io::Error::other(format!("could not generate runner token: {e}")))?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(token)
}

/// Verify the authenticated capabilities response, not merely that a process
/// happens to own the port. This closes the free-port race: an unrelated or
/// malicious listener cannot become the application window.
fn authenticated_probe(port: u16, token: &str) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "GET /api/capabilities HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         X-Battery-Design-Token: {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    let lower = response.to_ascii_lowercase();
    lower.starts_with("http/1.1 200")
        && lower.contains("x-battery-design-runner: battery-design-desktop-v1")
        && response.contains("\"runnerId\":\"battery-design-desktop-v1\"")
        && response.contains("\"runner\":\"battery-design desktop\"")
}

fn wait_for_server(port: u16, token: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if authenticated_probe(port, token) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

// ---------------------------------------------------------------------------
// Profile import/export commands for the frontend.
// The web page has no file-picker access, so it provides the path and we
// handle the read/write. Validation here is minimal: we confirm the file
// parses as a JSON object, which is enough to catch "that was a PNG" without
// imposing a schema the web side already enforces.
// ---------------------------------------------------------------------------

#[tauri::command]
fn export_profile(path: String, json: String) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("Profile is not valid JSON: {e}"))?;
    let pretty =
        serde_json::to_string_pretty(&value).map_err(|e| format!("Could not format JSON: {e}"))?;
    fs::write(&path, pretty).map_err(|e| format!("Could not write to {path}: {e}"))
}

#[tauri::command]
fn import_profile(path: String) -> Result<String, String> {
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("File is not valid JSON: {e}"))?;
    if !value.is_object() {
        return Err("File does not contain a JSON object (expected a profile).".to_string());
    }
    Ok(contents)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![export_profile, import_profile])
        .setup(|app| {
            let port = free_port();
            let token = launch_token()?;
            let handle = app.handle().clone();

            // The runner is bundled as a sidecar: the customer installs
            // nothing, and there is no "please install Node 18+" step that
            // half of them would stop at.
            //
            // The sidecar IS the Node runtime, so the script it should run is
            // the first argument. bd.mjs resolves its own root as the parent
            // of its directory, which is why the staged tree is shipped whole
            // rather than as loose files — it finds index.html, js/ and
            // vendor/ exactly where it expects them, with no path rewriting.
            let script = app
                .path()
                .resource_dir()
                .map(|d| d.join("runner").join("desktop").join("bd.mjs"))
                .map(|p| p.to_string_lossy().into_owned());

            let spawned = match script {
                Ok(script) => app
                    .shell()
                    .sidecar("bd-runner")
                    .map(|cmd| cmd.args([
                        &script,
                        "serve",
                        "--port",
                        &port.to_string(),
                        "--token",
                        &token,
                    ]))
                    .and_then(|cmd| cmd.spawn()),
                Err(e) => Err(tauri_plugin_shell::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("could not locate bundled resources: {e}"),
                ))),
            };

            match spawned {
                Ok((mut rx, child)) => {
                    // Keep the child alive for the life of the app, and kill
                    // it on exit rather than leaving an orphaned server
                    // listening after the window closes.
                    app.manage(RunnerGuard(std::sync::Mutex::new(Some(child))));
                    tauri::async_runtime::spawn(async move {
                        while let Some(event) = rx.recv().await {
                            if let CommandEvent::Stderr(line) = event {
                                eprintln!("[runner] {}", String::from_utf8_lossy(&line));
                            }
                        }
                    });
                }
                Err(e) => {
                    // Not fatal, and worth saying plainly rather than dying:
                    // the page degrades to browser-tier by itself.
                    eprintln!(
                        "Local compute runner did not start ({e}). \
                         The designer still works; the heavy studies will be unavailable."
                    );
                }
            }

            let url = if wait_for_server(port, &token, Duration::from_secs(20)) {
                format!("http://127.0.0.1:{port}/index.html?token={token}")
            } else {
                eprintln!("Runner did not answer in time — opening the bundled page directly.");
                "index.html".to_string()
            };

            let parsed = url
                .parse()
                .map(WebviewUrl::External)
                .unwrap_or_else(|_| WebviewUrl::App("index.html".into()));

            WebviewWindowBuilder::new(&handle, "main", parsed)
                .title("Battery pack designer")
                .inner_size(1440.0, 940.0)
                .min_inner_size(880.0, 600.0)
                .resizable(true)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start the battery designer");
}

/// Holds the runner process so it is killed when the application exits.
/// Without this the server outlives the window, and the next launch finds a
/// stale copy still holding a port.
struct RunnerGuard(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

impl Drop for RunnerGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}
