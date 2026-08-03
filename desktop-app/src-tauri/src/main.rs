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
// If the runner cannot start, the window still opens and the page falls back
// to browser-tier on its own: `desktop-link.js` already probes
// /api/capabilities and degrades when there is no answer. So a failure here
// costs the heavy compute, not the application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
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

/// Wait for the server to actually answer. A fixed sleep is the usual shortcut
/// and it breaks on exactly the machines this application is meant to support
/// — an old laptop takes longer to start Node than a fast one, and a window
/// pointed at a port that is not listening yet shows an error page the
/// customer has no way to interpret.
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpListener::bind(("127.0.0.1", port)).is_err() {
            // Binding FAILED, which means something else holds the port —
            // that something is our Node server.
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = free_port();
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
                    .map(|cmd| cmd.args([&script, "serve", "--port", &port.to_string()]))
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

            let url = if wait_for_server(port, Duration::from_secs(20)) {
                format!("http://127.0.0.1:{port}/index.html")
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
