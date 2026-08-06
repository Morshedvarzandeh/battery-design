// garage3d-host.js — the page's side of the 3D garage.
//
// The renderer is a Godot build in an iframe. This is the only thing that
// talks to it, and it deliberately knows almost nothing: it posts scenes in
// and reports picks out. Every number in a scene came from the design engine
// (see scene3d.js), so the renderer can be swapped, broken or absent without
// any of the tool's answers changing.
//
// Three things this file is responsible for, all of which are failure modes
// rather than features:
//
//   IT LOADS NOTHING UNTIL ASKED. The build is about 8 MB over the wire —
//   most of it the engine's own runtime. Nobody sizing an e-bike battery
//   should pay for that, so the iframe is created on first use and not
//   before.
//
//   IT SURVIVES THE RENDERER NOT BEING THERE. The build is produced by CI and
//   is not in the repository. A checkout, a fork, or a failed build must
//   degrade to a message, not a blank pane with a spinner.
//
//   IT NEVER LEAVES A STALE PACK ON SCREEN. A scene posted before the engine
//   is up is queued; a scene that fails to draw says so. A 3D view showing
//   the pack from two swaps ago is worse than one showing nothing.

import { MSG, SCENE_VERSION, isSceneMessage } from './scene3d.js';

const DEFAULT_SRC = 'garage3d/build/index.html';
// The engine has a lot of wasm to fetch and compile. This is the point at
// which we stop waiting and say so rather than leaving a spinner running.
const READY_TIMEOUT_MS = 45_000;

/**
 * Mount the 3D garage into a container.
 *
 * Nothing is fetched until `show()` is called for the first time.
 */
export function mount3D({ container, src = DEFAULT_SRC, onPick = null, onStatus = null } = {}) {
  if (!container) return null;

  let frame = null;
  let ready = false;
  let queued = null;
  let dead = null;                       // the reason, once it has failed
  let readyTimer = null;

  const say = (state, detail = '') => { if (onStatus) onStatus(state, detail); };

  function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow) return;    // not ours
    let m = e.data;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
    if (!isSceneMessage(m)) return;
    if (m.type === MSG.READY) {
      ready = true;
      clearTimeout(readyTimer);
      say('ready');
      if (queued) { post(queued); queued = null; }
    } else if (m.type === MSG.PICK) {
      if (onPick) onPick({ id: m.id, category: m.category, name: m.name });
    } else if (m.type === MSG.ERROR) {
      say('error', m.why || 'the renderer refused the scene');
    }
  }

  function post(scene) {
    frame?.contentWindow?.postMessage({ type: MSG.SCENE, v: SCENE_VERSION, scene }, '*');
  }

  function create() {
    frame = document.createElement('iframe');
    frame.className = 'garage3d-frame';
    frame.setAttribute('title', 'Battery pack, in three dimensions');
    // The renderer is trusted code from this package and needs same-origin
    // access to fetch its generated Wasm/PCK payload. The sandbox still
    // denies navigation, forms, popups and every permission except scripts;
    // same-origin is a loading requirement, not a separate trust boundary.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = src;
    frame.onerror = () => fail('the 3D renderer could not be loaded');
    window.addEventListener('message', onMessage);
    container.append(frame);
    readyTimer = setTimeout(() => {
      if (!ready) fail('the 3D renderer did not start within 45 seconds');
    }, READY_TIMEOUT_MS);
    say('loading');
  }

  function fail(why) {
    dead = why;
    clearTimeout(readyTimer);
    say('error', why);
  }

  return {
    /** Draw this scene. Creates the renderer on first call, queues until ready. */
    show(scene) {
      if (dead || !scene) return false;
      if (!frame) create();
      if (ready) post(scene); else queued = scene;
      return true;
    },
    get ready() { return ready; },
    get failed() { return dead; },
    destroy() {
      clearTimeout(readyTimer);
      window.removeEventListener('message', onMessage);
      frame?.remove();
      frame = null; ready = false; queued = null;
    },
  };
}

/**
 * Is the renderer present in this deployment?
 *
 * The build is produced by CI, so a plain checkout does not have one. Asking
 * first means the 3D tab can say "not in this build" instead of showing a
 * frame that will never load.
 */
export async function rendererAvailable(src = DEFAULT_SRC) {
  try {
    const r = await fetch(src, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}
