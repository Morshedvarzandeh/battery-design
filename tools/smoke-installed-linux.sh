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
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# Build the smoke request through the shipped canonical contract. The installed
# runner still performs its own checksum and closed-schema validation, so this
# fixture cannot make a missing packaged dependency or stale endpoint pass.
calibration_request_file=$(mktemp "/tmp/battery-design-calibration-request.XXXXXX.json")
trap 'rm -f -- "$calibration_request_file"' EXIT
node --input-type=module - "$script_dir/../js/calibration-dataset.js" "$calibration_request_file" <<'NODE'
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
const outputPath = process.argv[3];
const { materializeCalibrationDataset } = await import(pathToFileURL(modulePath));
const dataset = materializeCalibrationDataset({
  id: 'installed-runner-smoke', kind: 'synthetic', purpose: 'calibration',
  source: {
    tool: 'battery-design installed smoke', toolVersion: null, model: null,
    runId: null, generatedAt: null, mediaType: 'application/json',
    rawSha256: 'a'.repeat(64),
  },
  binding: {
    cellId: 'samsung-inr21700-50e', seriesCells: 1, parallelCells: 1,
    startSoC: 0.8, ambientC: 25, moduleCount: 1,
    initialState: 'rested-equilibrium-at-ambient',
  },
  normalization: {
    format: 'battery-design/calibration-normalization@1', adapter: 'canonical-json',
    adapterVersion: '1.0.0', mappingChecksum: 'b'.repeat(64),
    sourceUnits: { time: 's', current: 'A', voltage: 'V', temperature: null },
    sourceCurrentPositive: 'discharge', sourceCurrentScope: 'pack',
    sourceVoltageLocation: 'pack-terminal', sourceTemperatureLocation: null,
    sourceSampleAlignment: 'end-of-step', sourceFirstSampleTimeS: 0,
    sourceResetTimeS: -1, timeHandling: 'validated-uniform',
    originalSampleCount: 3,
  },
  samplePeriodS: 1,
  signals: { currentA: [0, 1, 0], voltageV: [3.75, 3.74, 3.75], temperatureC: null },
  segments: [{ id: 'all', startIndex: 0, endIndexExclusive: 3, mode: 'dynamic', include: true }],
  conventions: {
    timeBasis: 'uniform-sample-period', timeOrigin: 'trial-reset',
    firstSampleOffsetS: 1, sampleAlignment: 'end-of-step',
    currentHold: 'zero-order-hold', currentPositive: 'discharge', currentScope: 'pack',
    voltageLocation: 'pack-terminal', temperatureLocation: null,
  },
});
writeFileSync(outputPath, JSON.stringify({
  format: 'battery-design/calibration-request@1', datasets: dataset, params: null,
  fit: ['r0Ref'], maxIter: 1, weightTemp: 0, maxEvaluations: 2,
  maxModuleWeightedIntegrationSteps: 36, maxSamplesPerDataset: 8,
}));
NODE

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
# The package also installs /usr/bin/bd-runner. Package member order is not a
# launch contract: choosing the first /usr/bin entry can start the Node
# sidecar without arguments, which exits cleanly and never creates the UI.
deb_binary=/usr/bin/battery-design
dpkg -L "$deb_package" | grep -Fx "$deb_binary" >/dev/null \
  || { echo "installed package does not own its expected main executable: $deb_binary" >&2; exit 1; }
[[ -x "$deb_binary" ]] || { echo "installed package has no main executable at $deb_binary" >&2; exit 1; }
chmod +x "$appimage_path"

smoke_launch() {
  local label=$1
  shift
  local log_file
  log_file=$(mktemp "/tmp/battery-design-${label}.XXXXXX.log")
  local calibration_result_file=''
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
    rm -f -- "$log_file"
    if [[ -n "$calibration_result_file" ]]; then
      rm -f -- "$calibration_result_file"
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
          calibration_result_file=$(mktemp "/tmp/battery-design-${label}-calibration.XXXXXX.json")
          if ! curl --fail --silent --show-error --max-time 30 \
            --header "X-Battery-Design-Token: $token" \
            --header 'Content-Type: application/json' \
            --data-binary "@$calibration_request_file" \
            "http://127.0.0.1:${port}/api/calibrate" >"$calibration_result_file"; then
            echo "$label authenticated calibration request failed" >&2
            sed -n '1,200p' "$log_file" >&2
            cleanup_launch
            return 1
          fi
          if ! node --input-type=module - "$calibration_result_file" <<'NODE'
import { readFileSync } from 'node:fs';

const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const containsKey = (value, key) => value && typeof value === 'object'
  && (Object.prototype.hasOwnProperty.call(value, key)
    || Object.values(value).some((child) => containsKey(child, key)));
const containsTemperatureSeries = (value) => value && typeof value === 'object'
  && ((Array.isArray(value.temperatureC))
    || Object.values(value).some((child) => containsTemperatureSeries(child)));
if (result.format !== 'battery-design/calibration-result@1') throw new Error('unexpected calibration result format');
if (!Array.isArray(result.datasetChecksums) || result.datasetChecksums.length !== 1) throw new Error('missing canonical dataset checksum');
if (result.evaluationCount !== 2) throw new Error('calibration did not honor its evaluation limit');
if (result.moduleWeightedIntegrationStepCount !== 36) {
  throw new Error('calibration did not execute the exact budgeted module-weighted work plan');
}
if (containsKey(result, 'signals') || containsKey(result, 'currentA')
  || containsKey(result, 'voltageV') || containsTemperatureSeries(result)) {
  throw new Error('calibration response echoed source signal arrays');
}
NODE
          then
            echo "$label returned an invalid governed calibration result" >&2
            cleanup_launch
            return 1
          fi
          echo "$label smoke passed: installed UI, authenticated runner and governed calibration started"
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
