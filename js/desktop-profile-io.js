// desktop-profile-io.js — profile import/export for the Tauri desktop app.
//
// The desktop app wraps this same web page in a Tauri window, which means
// the page can call native filesystem operations through Tauri's IPC. But
// Tauri is configured with withGlobalTauri: false and loads the page from
// an external localhost URL, so the __TAURI__ globals may or may not exist.
//
// Everything here fails soft. On the public site or any browser without
// Tauri, these functions return null/false immediately — no errors, no
// console noise, nothing breaks. The caller decides whether to show a
// fallback or simply hide the feature.
//
// Since tauri-plugin-dialog is not available, the caller must supply the
// file path. For export, a sensible default is derived from the profile id
// if no path is given. For import, the path is required (return null if
// missing). The actual file dialogs live in the UI layer, not here.

/**
 * Attempt to invoke a Tauri command. Returns null if Tauri IPC is unavailable.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown> | null}
 */
function tauriInvoke(cmd, args) {
  const invoke =
    globalThis.__TAURI_INTERNALS__?.invoke ?? globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return null;
  return invoke(cmd, args);
}

/**
 * Check whether Tauri IPC is available in this environment.
 * @returns {boolean}
 */
export function hasTauriIpc() {
  return (
    typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function' ||
    typeof globalThis.__TAURI__?.core?.invoke === 'function'
  );
}

/**
 * Export a profile to a JSON file via Tauri.
 *
 * @param {object} profile - The profile object to export.
 * @param {string} [path] - Destination file path. If omitted, derives from profile.id.
 * @returns {Promise<boolean>} True on success, false if Tauri unavailable or write failed.
 */
export async function exportProfile(profile, path) {
  if (!profile || typeof profile !== 'object') return false;

  const filePath = path || defaultProfilePath(profile.id || 'profile');
  if (!filePath) return false;

  const json = JSON.stringify(profile);
  const result = tauriInvoke('export_profile', { path: filePath, json });
  if (result === null) return false;

  try {
    await result;
    return true;
  } catch {
    return false;
  }
}

/**
 * Import a profile from a JSON file via Tauri.
 *
 * @param {string} path - Source file path. Required.
 * @returns {Promise<object | null>} The parsed profile object, or null on failure.
 */
export async function importProfile(path) {
  if (!path || typeof path !== 'string') return null;

  const result = tauriInvoke('import_profile', { path });
  if (result === null) return null;

  try {
    const json = await result;
    if (typeof json !== 'string') return null;
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Derive a default filename from a profile id.
 * @param {string} id
 * @returns {string}
 */
function defaultProfilePath(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '_') || 'profile';
  return `${safe}.json`;
}
