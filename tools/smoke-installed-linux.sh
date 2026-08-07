#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 path/to/package.deb path/to/package.AppImage" >&2
  exit 2
fi

deb_path=$1
appimage_path=$2
[[ -s "$deb_path" ]] || { echo "missing .deb: $deb_path" >&2; exit 1; }
[[ -s "$appimage_path" ]] || { echo "missing AppImage: $appimage_path" >&2; exit 1; }
deb_path=$(realpath -- "$deb_path")
appimage_path=$(realpath -- "$appimage_path")

# Do not let a build-machine success hide an uninstallable customer package.
# The CI image already carries WebKitGTK development libraries, so launching
# here cannot prove that dpkg will install the required runtime on a clean
# machine; the package metadata must declare those dependencies explicitly.
deb_dependencies=$(dpkg-deb -f "$deb_path" Depends)
grep -q 'libwebkit2gtk-4.1' <<<"$deb_dependencies" \
  || { echo ".deb does not declare the WebKitGTK 4.1 runtime dependency" >&2; exit 1; }
grep -q 'libgtk-3' <<<"$deb_dependencies" \
  || { echo ".deb does not declare the GTK 3 runtime dependency" >&2; exit 1; }

sudo apt-get install -y "$deb_path"
deb_package=$(dpkg-deb -f "$deb_path" Package)
deb_binary=$(dpkg -L "$deb_package" | awk '/^\/usr\/bin\/[^/]+$/ { print; exit }')
[[ -x "$deb_binary" ]] || { echo "installed package has no executable in /usr/bin" >&2; exit 1; }
chmod +x "$appimage_path"

smoke_launch() {
  local label=$1
  shift
  local log_file
  log_file=$(mktemp "/tmp/battery-design-${label}.XXXXXX.log")
  local launcher_pid=''
  local runner_pid=''

  cleanup_launch() {
    if [[ -n "$launcher_pid" ]]; then
      # The app, WebKit helper, Xvfb and Node sidecar share this dedicated
      # session. Stop the complete installed launch without touching any
      # unrelated process on the runner.
      kill -- "-$launcher_pid" 2>/dev/null || true
      wait "$launcher_pid" 2>/dev/null || true
    fi
    if [[ -n "$runner_pid" ]]; then
      kill "$runner_pid" 2>/dev/null || true
    fi
  }

  setsid xvfb-run -a "$@" >"$log_file" 2>&1 &
  launcher_pid=$!

  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if ! kill -0 "$launcher_pid" 2>/dev/null; then
      echo "$label exited before its runner became healthy" >&2
      sed -n '1,200p' "$log_file" >&2
      cleanup_launch
      return 1
    fi

    while read -r candidate; do
      [[ -r "/proc/$candidate/cmdline" ]] || continue
      local -a command_line=()
      mapfile -d '' command_line <"/proc/$candidate/cmdline" || true
      local port=''
      local token=''
      local saw_serve=false
      local index
      for ((index = 0; index < ${#command_line[@]}; index += 1)); do
        [[ "${command_line[$index]}" == 'serve' ]] && saw_serve=true
        if [[ "${command_line[$index]}" == '--port' ]]; then port=${command_line[$((index + 1))]:-}; fi
        if [[ "${command_line[$index]}" == '--token' ]]; then token=${command_line[$((index + 1))]:-}; fi
      done
      if [[ "$saw_serve" == true && -n "$port" && -n "$token" ]]; then
        runner_pid=$candidate
        local capabilities=''
        if capabilities=$(curl --fail --silent --show-error \
          --header "X-Battery-Design-Token: $token" \
          "http://127.0.0.1:${port}/api/capabilities") \
          && grep -q '"runner":"battery-design desktop"' <<<"$capabilities"; then
          echo "$label smoke passed: installed UI and authenticated runner started"
          cleanup_launch
          return 0
        fi
      fi
    done < <(pgrep -u "$(id -u)" -f 'bd-runner.*bd\.mjs.*serve' || true)

    sleep 0.25
  done

  echo "$label did not expose a healthy authenticated runner within 45 seconds" >&2
  sed -n '1,200p' "$log_file" >&2
  cleanup_launch
  return 1
}

smoke_launch deb "$deb_binary"
smoke_launch appimage env APPIMAGE_EXTRACT_AND_RUN=1 "$appimage_path"
