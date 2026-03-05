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
let _appState = 'ready'; // 'ready' | 'recording' | 'paused' | 'visualised'

const _metrics = {
  elevationRequests:  0,
  elevationLocations: 0,
};

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
  map.tabIndex = 0;
  map.focus();

  recorder   = new UGORecorder(map, 50);
  visualizer = new UGOVisualizer(map);

  document.getElementById('search-bar').addEventListener('submit', _onSearch);

  // Live camera readout — update on every camera change event
  ['gmp-centerchange', 'gmp-rangechange', 'gmp-tiltchange', 'gmp-headingchange']
    .forEach(evt => map.addEventListener(evt, _updateCameraReadout));

  // Button wiring
  document.getElementById('btn-record').addEventListener('click', _onRecordButton);
  document.getElementById('btn-stop').addEventListener('click',   _stopRecording);
  document.getElementById('btn-clear').addEventListener('click',  _clearRecording);
  document.getElementById('btn-fill').addEventListener('click',   _toggleFill);

  // Prevent buttons from stealing keyboard focus from the map —
  // mousedown is where focus transfer happens, preventDefault stops it
  // while still allowing the click event to fire normally
  document.querySelectorAll('#hud-controls button').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => map.focus());
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
// `       — toggle dev metrics panel
function _onKeyDown(e) {
  if (e.target.tagName === 'INPUT') return;
  if (document.activeElement !== map) map.focus();

  if (e.key === '`') {
    document.getElementById('dev-hud').classList.toggle('hidden');
    return;
  }

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

function _onRecordButton() {
  if (_appState === 'ready' || _appState === 'visualised') {
    // Fresh start — clear any previous visualisation
    currentRecording = null;
    visualizer.clear();
    document.getElementById('btn-fill').classList.remove('active');

    recorder.onFrame = (frameCount, elapsedMs) => {
      _show('stat-frames',   `${frameCount} frames`);
      _show('stat-duration', _formatDuration(elapsedMs));
    };

    recorder.start();
    _enterState('recording');

  } else if (_appState === 'recording') {
    recorder.pause();
    _enterState('paused');

  } else if (_appState === 'paused') {
    recorder.resume();
    _enterState('recording');
  }
}

async function _stopRecording() {
  currentRecording = recorder.stop();
  _enterState('ready'); // temporarily reset while rendering

  if (!currentRecording || currentRecording.metadata.frameCount < 2) {
    _setText('stat-status', 'No path captured');
    _hide('stat-frames');
    _hide('stat-duration');
    return;
  }

  _setText('stat-status', 'Rendering path…');
  try {
    await visualizer.renderRecording(currentRecording, ({ requests, locations, error }) => {
      _metrics.elevationRequests  += requests;
      _metrics.elevationLocations += locations;
      if (error) _metrics.elevationError = error;
      _updateDevHud();
    });
  } catch (err) {
    console.error('UGO: renderRecording failed', err);
  }

  const { frameCount, totalDurationMs } = currentRecording.metadata;
  _setText('stat-status', `${frameCount} frames · ${_formatDuration(totalDurationMs)}`);
  _enterState('visualised');
}

function _clearRecording() {
  visualizer.clear();
  currentRecording = null;

  document.getElementById('btn-fill').classList.remove('active');
  _enterState('ready');
}

function _enterState(state) {
  _appState = state;
  const recBtn = document.getElementById('btn-record');
  recBtn.classList.remove('recording', 'paused');

  switch (state) {
    case 'ready':
      recBtn.textContent = '● REC';
      _setButtons({ record: true, stop: false, clear: false, fill: false });
      _setText('stat-status', 'Ready to record');
      _hide('stat-frames');
      _hide('stat-duration');
      break;
    case 'recording':
      recBtn.textContent = '⏸ PAUSE';
      recBtn.classList.add('recording');
      _setButtons({ record: true, stop: true, clear: false, fill: false });
      _setText('stat-status', '● Recording…');
      break;
    case 'paused':
      recBtn.textContent = '● REC';
      recBtn.classList.add('paused');
      _setButtons({ record: true, stop: true, clear: false, fill: false });
      _setText('stat-status', '⏸ Paused');
      break;
    case 'visualised':
      recBtn.textContent = '● REC';
      _setButtons({ record: true, stop: false, clear: true, fill: true });
      break;
  }
}

// ── Camera readout ────────────────────────────────────────────────────────────

function _updateCameraReadout() {
  if (!map.center) return;
  const f = (n, d) => (n != null ? n.toFixed(d) : '—');
  document.getElementById('c-lat').textContent   = f(map.center.lat, 6);
  document.getElementById('c-lng').textContent   = f(map.center.lng, 6);
  const tiltRad = (map.tilt || 0) * Math.PI / 180;
  const eyeAlt  = (map.center.altitude || 0) + (map.range || 0) * Math.cos(tiltRad);
  document.getElementById('c-alt').textContent   = f(eyeAlt, 0) + ' m';
  document.getElementById('c-range').textContent = f(map.range, 0) + ' m';
  document.getElementById('c-tilt').textContent  = f(map.tilt, 1) + '°';
  document.getElementById('c-hdg').textContent   = f(map.heading, 1) + '°';
}

// ── Search ────────────────────────────────────────────────────────────────────

async function _onSearch(e) {
  e.preventDefault();
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const data = await res.json();
  if (!data.length) return;

  map.flyCameraTo({
    endCamera: {
      center:  { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), altitude: 0 },
      range:   15000,
      tilt:    45,
      heading: 0,
    },
    durationMillis: 24000,
  });

  document.getElementById('search-input').blur();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _toggleFill() {
  const btn     = document.getElementById('btn-fill');
  const isOn    = btn.classList.toggle('active');
  visualizer.setFillVisible(isOn);
  map.focus();
}

function _setButtons({ record, stop, clear, fill }) {
  document.getElementById('btn-record').disabled = !record;
  document.getElementById('btn-stop').disabled   = !stop;
  document.getElementById('btn-clear').disabled  = !clear;
  if (fill !== undefined) {
    document.getElementById('btn-fill').disabled = !fill;
  }
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

function _updateDevHud() {
  document.getElementById('dev-elev-requests').textContent  = _metrics.elevationRequests;
  document.getElementById('dev-elev-locations').textContent = _metrics.elevationLocations;
  const errEl = document.getElementById('dev-elev-error');
  errEl.textContent = _metrics.elevationError || '';
}

function _formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
