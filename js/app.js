/**
 * app.js — UGO main entry point
 * Initialises the Map3DElement, wires up the recorder and visualizer,
 * and manages the UI state machine.
 *
 * UI states:
 *   ready      → REC enabled, STOP disabled, CLEAR disabled
 *   recording  → REC disabled, STOP enabled,  CLEAR disabled
 *   visualised → REC enabled, STOP disabled,  CLEAR enabled
 */

let map;
let recorder;
let visualizer;
let currentRecording = null;

// Called by the Maps JS API once it has loaded (callback=initMap in script tag)
async function initMap() {
  const { Map3DElement, MapMode } = await google.maps.importLibrary('maps3d');

  map = new Map3DElement({
    center:  { lat: 52.939588, lng: 5.053351, altitude: 4 },
    range:   296,
    tilt:    64.7,
    heading: 53.7,
    mode:    MapMode.SATELLITE,
  });

  document.getElementById('map-container').appendChild(map);

  recorder   = new UGORecorder(map, 200);
  visualizer = new UGOVisualizer(map);

  // Live camera readout — update on every camera change event
  ['gmp-centerchange', 'gmp-rangechange', 'gmp-tiltchange', 'gmp-headingchange']
    .forEach(evt => map.addEventListener(evt, _updateCameraReadout));

  // Button wiring
  document.getElementById('btn-record').addEventListener('click', _startRecording);
  document.getElementById('btn-stop').addEventListener('click',   _stopRecording);
  document.getElementById('btn-clear').addEventListener('click',  _clearRecording);

  // Prevent buttons from stealing keyboard focus from the map —
  // mousedown is where focus transfer happens, preventDefault stops it
  // while still allowing the click event to fire normally
  document.querySelectorAll('#hud-controls button').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
  });

  // Hide the Google Maps alpha warning banner whenever it appears
  const _bannerObserver = new MutationObserver(() => {
    document.querySelectorAll('[aria-label*="alpha channel"]').forEach(el => el.remove());
  });
  _bannerObserver.observe(document.body, { childList: true, subtree: true });

  // Keyboard shortcuts — capture phase so we intercept before the map handles them
  document.addEventListener('keydown', _onKeyDown, true);
}

// R       — reset tilt + heading (Google Earth style)
// Shift+↓ — tilt toward horizon (tilt increases)
// Shift+↑ — tilt toward top-down (tilt decreases)
function _onKeyDown(e) {
  if (e.key === 'r' || e.key === 'R') {
    map.flyCameraTo({
      endCamera: {
        center:  map.center,
        range:   map.range,
        tilt:    0,
        heading: 0,
      },
      durationMillis: 800,
    });
    return;
  }

  // Tilt inversion hack — commented out due to choppiness (flyCameraTo at 100ms feels laggy)
  // The Maps API doesn't expose a way to remap these natively, so this intercepts
  // Shift+↓/↑ in the capture phase and swaps their tilt direction.
  // Re-enable when a smoother approach is available.
  //
  // if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
  //   e.preventDefault();
  //   e.stopPropagation();
  //   const step    = 5;
  //   const current = map.tilt || 0;
  //   const newTilt = e.key === 'ArrowDown'
  //     ? Math.min(90, current + step)   // ↓ tilts toward horizon
  //     : Math.max(0,  current - step);  // ↑ tilts toward top-down
  //   map.flyCameraTo({
  //     endCamera: {
  //       center:  map.center,
  //       range:   map.range,
  //       tilt:    newTilt,
  //       heading: map.heading,
  //     },
  //     durationMillis: 100,
  //   });
  // }
}

// ── Recording flow ────────────────────────────────────────────────────────────

function _startRecording() {
  currentRecording = null;
  visualizer.clear();

  recorder.onFrame = (frameCount, elapsedMs) => {
    _show('stat-frames',   `${frameCount} frames`);
    _show('stat-duration', _formatDuration(elapsedMs));
  };

  recorder.start();

  _setButtons({ record: false, stop: true, clear: false });
  document.getElementById('btn-record').classList.add('recording');
  _setText('stat-status', '● Recording…');
}

async function _stopRecording() {
  currentRecording = recorder.stop();

  _setButtons({ record: true, stop: false, clear: false });
  document.getElementById('btn-record').classList.remove('recording');

  if (!currentRecording || currentRecording.frames.length < 2) {
    _setText('stat-status', 'No path captured');
    _hide('stat-frames');
    _hide('stat-duration');
    return;
  }

  _setText('stat-status', 'Rendering path…');
  await visualizer.renderRecording(currentRecording);

  const { frameCount, totalDurationMs } = currentRecording.metadata;
  _setText('stat-status', `${frameCount} frames · ${_formatDuration(totalDurationMs)}`);
  _setButtons({ record: true, stop: false, clear: true });
}

function _clearRecording() {
  visualizer.clear();
  currentRecording = null;

  _setButtons({ record: true, stop: false, clear: false });
  _setText('stat-status', 'Ready to record');
  _hide('stat-frames');
  _hide('stat-duration');
}

// ── Camera readout ────────────────────────────────────────────────────────────

function _updateCameraReadout() {
  if (!map.center) return;
  const f = (n, d) => (n != null ? n.toFixed(d) : '—');
  document.getElementById('c-lat').textContent   = f(map.center.lat, 6);
  document.getElementById('c-lng').textContent   = f(map.center.lng, 6);
  document.getElementById('c-alt').textContent   = f(map.center.altitude, 0) + ' m';
  document.getElementById('c-range').textContent = f(map.range, 0) + ' m';
  document.getElementById('c-tilt').textContent  = f(map.tilt, 1) + '°';
  document.getElementById('c-hdg').textContent   = f(map.heading, 1) + '°';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setButtons({ record, stop, clear }) {
  document.getElementById('btn-record').disabled = !record;
  document.getElementById('btn-stop').disabled   = !stop;
  document.getElementById('btn-clear').disabled  = !clear;
}

function _setText(id, text) {
  document.getElementById(id).textContent = text;
}

function _show(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.remove('hidden');
}

function _hide(id) {
  document.getElementById(id).classList.add('hidden');
}

function _formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
