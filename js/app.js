/**
 * app.js — UGO main entry point
 * Initialises the Map3DElement, wires up the recorder and visualizer,
 * and manages the UI state machine.
 *
 * UI states:
 *   ready      → REC enabled, STOP disabled, CLEAR disabled
 *   recording  → REC disabled, STOP enabled,  CLEAR disabled
 *   visualised → REC enabled, STOP disabled,  CLEAR enabled
 * RESET (home) button is always enabled — not part of the state machine.
 */

const INITIAL_CAMERA = {
  center:  { lat: 37.790850, lng: -122.190771, altitude: 0 },
  range:   159193,
  tilt:    65.6,
  heading: 77.2,
};

// Starting camera for the welcome sequence — eye position matches start of the reference UGO path
// (eye at ~lng -125.77, lat 37.09, alt 34km looking toward SF Bay)
const WELCOME_CAMERA = {
  center:  { lat: 37.790850, lng: -122.190771, altitude: 0 },
  range:   220000,
  tilt:    82,
  heading: 76,
};

let map;
let recorder;
let visualizer;
let currentRecording = null;
let _sharedUgoId = null;          // set when loaded via ?ugo= URL param
let _preloadedRecording = null;   // KML pre-fetched during initMap to avoid a second fetch
let _appState = 'ready'; // 'ready' | 'recording' | 'paused' | 'visualised'
let _durationTimer = null;
let issTracker;
let tiangongTracker;
let _satTimer = null;

const isTouch = window.matchMedia('(pointer: coarse)').matches
             || navigator.maxTouchPoints > 0
             || ('ontouchstart' in window);

const _metrics = {
  elevationRequests:  0,
  elevationLocations: 0,
  maxAltitude:        null,
  minAltitude:        null,
  distance:           0,
  _lastEyeLat:        null,
  _lastEyeLng:        null,
  _lastEyeAlt:        null,
};

// Called by the Maps JS API once it has loaded (callback=initMap in script tag)
async function initMap() {
  const { Map3DElement, MapMode } = await google.maps.importLibrary('maps3d');

  const params = new URLSearchParams(location.search);
  const returning = params.has('ugo') ? true : !!sessionStorage.getItem('ugo-returning');
  let _returnState = null;
  if (returning && !params.has('ugo')) {
    try { _returnState = JSON.parse(sessionStorage.getItem('ugo-return-state')); } catch (e) {}
  }
  let startCamera = (!params.has('ugo') && !returning) ? WELCOME_CAMERA : INITIAL_CAMERA;
  if (_returnState?.camera) startCamera = _returnState.camera;
  if (params.has('ugo')) {
    try {
      const ugoId = params.get('ugo');
      const workerBase = window.UGO_WORKER_URL || 'https://usergeneratedorbitbot.navarenko.workers.dev';

      // Fetch the UGO to get its location, then open from a globe-level view above it.
      // Store the parsed recording so _loadFromGist can reuse it without a second fetch.
      const kmlText = await fetch(`${workerBase}/gist-by-ugo?id=${encodeURIComponent(ugoId)}`).then(r => r.text());
      _preloadedRecording = importKML(kmlText);
      const rec = _preloadedRecording;
      const bb  = rec.metadata.boundingBox;
      const ugoLat = (bb.north + bb.south) / 2;
      const ugoLng = (bb.east  + bb.west)  / 2;
      // Start from ~22,000 km above the UGO — Earth visible as a globe, then fly in
      startCamera = { center: { lat: ugoLat, lng: ugoLng, altitude: 0 }, range: 22000000, tilt: 0, heading: 0 };
    } catch (e) {}
  }

  map = new Map3DElement({
    ...startCamera,
    mode: MapMode.SATELLITE,
  });

  document.getElementById('map-container').appendChild(map);
  map.tabIndex = 0;
  map.focus();

  recorder    = new UGORecorder(map, 50);
  visualizer  = new UGOVisualizer(map);
  issTracker      = new SatTracker(map, 25544, 'rgba(255, 220, 50, 0.95)');
  // tiangongTracker = new SatTracker(map, 48274, 'rgba(50, 180, 255, 0.95)', 'n2yo');
  // ISS off by default — user can enable via the ISS button
  document.getElementById('btn-iss').disabled = true;

  document.getElementById('search-bar').addEventListener('submit', _onSearch);

  // Live camera readout — update on every camera change event
  ['gmp-centerchange', 'gmp-rangechange', 'gmp-tiltchange', 'gmp-headingchange']
    .forEach(evt => map.addEventListener(evt, _updateCameraReadout));

  // Button wiring
  document.getElementById('btn-record').addEventListener('click', _onRecordButton);
  document.getElementById('btn-stop').addEventListener('click',   _stopRecording);
  document.getElementById('btn-clear').addEventListener('click',  _clearRecording);
  document.getElementById('btn-fill').addEventListener('click',   _toggleFill);
  document.getElementById('btn-play').addEventListener('click',   _onPlayButton);
  document.getElementById('btn-save').addEventListener('click',   _saveRecording);
  document.getElementById('btn-load').addEventListener('click',   () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', _onFileSelected);
  document.getElementById('btn-home').addEventListener('click',   _resetCamera);
  document.getElementById('btn-iss-toggle').addEventListener('click',      _toggleISS);
  // document.getElementById('btn-tiangong-toggle').addEventListener('click', _toggleTiangong);
  document.getElementById('btn-iss').addEventListener('click', _flyToISS);
  // document.getElementById('btn-css').addEventListener('click', _flyToCSS);

  // Prevent buttons from stealing keyboard focus from the map —
  // mousedown is where focus transfer happens, preventDefault stops it
  // while still allowing the click event to fire normally
  document.querySelectorAll('#hud-controls button, #btn-controls-help').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
  });
  document.querySelectorAll('#hud-controls button').forEach(btn => {
    btn.addEventListener('click', () => map.focus());
  });

  // Controls help overlay
  document.getElementById('btn-controls-help').addEventListener('click', _showControlsHelp);
  document.getElementById('btn-controls-close').addEventListener('click', _hideControlsHelp);
  document.getElementById('controls-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('controls-overlay')) _hideControlsHelp();
  });

  // Keyboard shortcuts — capture phase so we intercept before the map handles them
  document.addEventListener('keydown', _onKeyDown, true);

  _initDrag();

  // Touch devices: swap hint text and hide desktop-only controls
  if (isTouch) {
    document.querySelector('.hint-kb').style.display    = 'none';
    document.querySelector('.hint-touch').style.display = 'inline';
    document.getElementById('btn-controls-help').style.display = 'none';
  }

  // Touch devices: tap the map to toggle UI visibility.
  // Listening directly on `map` (not document) because gmp-map-3d's shadow DOM
  // may swallow touch events before they bubble to document on some browsers.
  // UI overlay elements sit above the map, so taps on them never reach map.
  if (isTouch) {
    let _tapStart = null;
    map.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      _tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    }, { passive: true });
    map.addEventListener('pointerup', (e) => {
      if (!_tapStart || e.pointerType !== 'touch') return;
      const dx = Math.abs(e.clientX - _tapStart.x);
      const dy = Math.abs(e.clientY - _tapStart.y);
      const dt = Date.now() - _tapStart.t;
      _tapStart = null;
      if (dx < 20 && dy < 20 && dt < 400) _toggleMobileUI();
    }, { passive: true });
  }

  // Snapshot full app state when navigating away so we can restore on return
  document.querySelectorAll('#site-nav a').forEach(a => {
    a.addEventListener('click', () => {
      sessionStorage.setItem('ugo-returning', '1');
      try {
        const state = {
          camera: { center: { lat: map.center.lat, lng: map.center.lng, altitude: map.center.altitude }, range: map.range, tilt: map.tilt, heading: map.heading },
        };
        // Don't restore a shared UGO on return — navigating away from ?ugo= goes to a clean state
        if (!_sharedUgoId && currentRecording) {
          state.session = exportKML(currentRecording);
        }
        sessionStorage.setItem('ugo-return-state', JSON.stringify(state));
      } catch (e) {}
    });
  });

  // Load a UGO from a UGO ID passed as ?ugo=ID in the URL
  const gistId = params.get('ugo');
  if (gistId) {
    _loadFromGist(gistId);
  } else {
    sessionStorage.removeItem('ugo-returning');
    sessionStorage.removeItem('ugo-return-state');
    if (_returnState?.gistId) {
      history.replaceState(null, '', `/?ugo=${encodeURIComponent(_returnState.gistId)}`);
      _loadFromGist(_returnState.gistId, { skipCameraFly: true });
    } else if (_returnState?.session) {
      _restoreSession(_returnState.session);
    } else if (!returning) {
      new WelcomeMessage(map, INITIAL_CAMERA).show();
    }
  }

  // Tour mode — disabled for now
  // if (params.has('tour')) _startTour();
}

// R       — reset tilt + heading (Google Earth style)
// F       — toggle fullscreen
// `       — toggle dev metrics panel
function _showControlsHelp() {
  document.getElementById('controls-overlay').classList.remove('hidden');
}

function _hideControlsHelp() {
  document.getElementById('controls-overlay').classList.add('hidden');
  map.focus();
}

function _onKeyDown(e) {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('controls-overlay');
    if (!overlay.classList.contains('hidden')) { _hideControlsHelp(); return; }
  }

  if (e.target.tagName === 'INPUT') return;
  if (document.activeElement !== map) map.focus();

  if (e.key === 'Tab') {
    e.preventDefault();
    const els = ['transport', 'search-bar'].map(id => document.getElementById(id));
    const hide = !els[0].classList.contains('ui-hidden');
    els.forEach(el => el.classList.toggle('ui-hidden', hide));
    document.getElementById('site-nav').classList.toggle('nav-autohidden', hide);
    return;
  }

  if (e.key === '`') {
    const hide = !document.getElementById('dev-hud').classList.contains('hidden');
    document.getElementById('dev-hud').classList.toggle('hidden', hide);
    document.getElementById('camera-hud').classList.toggle('hidden', hide);
    return;
  }

  if (e.key === 'd' || e.key === 'D') {
    document.getElementById('debug-hud').classList.toggle('hidden');
    return;
  }

  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
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

// ── Mobile UI toggle (touch devices) ─────────────────────────────────────────

function _toggleMobileUI() {
  const transport = document.getElementById('transport');
  const hide = !transport.classList.contains('ui-hidden');
  transport.classList.toggle('ui-hidden', hide);
  document.getElementById('search-bar').classList.toggle('ui-hidden', hide);
  document.getElementById('site-nav').classList.toggle('nav-autohidden', hide);
}

function _hideMobileUI() {
  document.getElementById('transport').classList.add('ui-hidden');
  document.getElementById('search-bar').classList.add('ui-hidden');
  document.getElementById('site-nav').classList.add('nav-autohidden');
}


// ── Drag to reposition panel ──────────────────────────────────────────────────

function _initDrag() {
  const panel  = document.getElementById('transport');
  const handle = document.getElementById('transport-handle');

  let dragging = false;
  let originX, originY, panelLeft, panelTop;

  handle.addEventListener('pointerdown', e => {
    const rect = panel.getBoundingClientRect();
    // Switch from CSS right/transform to explicit left/top on first drag
    panel.style.right     = 'auto';
    panel.style.bottom    = 'auto';
    panel.style.transform = 'none';
    panel.style.left      = rect.left + 'px';
    panel.style.top       = rect.top  + 'px';

    dragging  = true;
    originX   = e.clientX;
    originY   = e.clientY;
    panelLeft = rect.left;
    panelTop  = rect.top;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    panel.style.left = (panelLeft + e.clientX - originX) + 'px';
    panel.style.top  = (panelTop  + e.clientY - originY) + 'px';
  });

  handle.addEventListener('pointerup',     () => { dragging = false; });
  handle.addEventListener('pointercancel', () => { dragging = false; });
}

// ── Recording flow ────────────────────────────────────────────────────────────

function _onRecordButton() {
  if (_appState === 'ready' || _appState === 'visualised') {
    // Fresh start — clear any previous visualisation
    _stopPlayback();
    currentRecording = null;
    visualizer.clear();
    document.getElementById('btn-fill').classList.remove('active');
    _metrics.maxAltitude = null;
    _metrics.minAltitude = null;
    _metrics.distance    = 0;
    _metrics._lastEyeLat = null;
    _metrics._lastEyeLng = null;
    _metrics._lastEyeAlt = null;

    recorder.onFrame = (frameCount) => {
      _metrics.frameCount = frameCount;
    };

    recorder.start();
    clearInterval(_durationTimer);
    _durationTimer = setInterval(() => {
      _metrics.elapsedMs = recorder.getElapsedMs();
      _updateDevHud();
    }, 1000);
    _enterState('recording');

  } else if (_appState === 'recording') {
    clearInterval(_durationTimer);
    _durationTimer = null;
    recorder.pause();
    _enterState('paused');

  } else if (_appState === 'paused') {
    recorder.resume();
    _durationTimer = setInterval(() => {
      _metrics.elapsedMs = recorder.getElapsedMs();
      _updateDevHud();
    }, 1000);
    _enterState('recording');
  }
}

async function _stopRecording() {
  clearInterval(_durationTimer);
  _durationTimer = null;
  currentRecording = recorder.stop();
  _enterState('ready'); // temporarily reset while rendering

  if (!currentRecording || currentRecording.metadata.frameCount < 2) {
    _setText('stat-status', 'No path captured');
    return;
  }

  currentRecording.metadata.maxAltitude = _metrics.maxAltitude;
  currentRecording.metadata.distance    = _metrics.distance;

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

  _enterState('visualised');

  // Auto-save to Gist archive
  const kml = exportKML(currentRecording);
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isDev   = !isLocal && new URLSearchParams(location.search).has('dev');
  const env     = isLocal ? ' [local]' : isDev ? ' [dev]' : '';
  createGist(
    `ugo-${currentRecording.id}.kml`,
    kml,
    `UGO recording — ${currentRecording.name}${env} [hidden]`
  );
}

function _saveRecording() {
  if (!currentRecording) return;
  downloadKML(currentRecording);
}

async function _onFileSelected(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  _setText('stat-status', 'Loading…');

  let recording;
  try {
    const text = await file.text();
    recording  = importKML(text);
  } catch (err) {
    _setText('stat-status', err.message);
    return;
  }

  if (_appState === 'recording' || _appState === 'paused') {
    recorder.stop();
  }
  visualizer.clear();
  currentRecording = recording;
  document.getElementById('btn-fill').classList.remove('active');
  _metrics.maxAltitude = recording.metadata.maxAltitude ?? null;
  _metrics.distance    = recording.metadata.distance    ?? 0;
  _metrics.elapsedMs   = recording.metadata.totalDurationMs ?? null;
  _updateDevHud();

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

  _enterState('visualised');
}

function _overviewCamera(recording) {
  const segments = recording.segments;
  const bb       = recording.metadata.boundingBox;
  if (!segments || !segments.length || !bb) return null;

  const centerLat = (bb.north + bb.south) / 2;
  const centerLng = (bb.east  + bb.west)  / 2;

  const allFrames = segments.flat();
  let Cxx = 0, Cyy = 0, Cxy = 0;
  for (const f of allFrames) {
    const dx = f.center.lng - centerLng;
    const dy = f.center.lat - centerLat;
    Cxx += dx * dx; Cyy += dy * dy; Cxy += dx * dy;
  }

  let pdx, pdy;
  if (Math.abs(Cxy) < 1e-12) {
    pdx = Cxx >= Cyy ? 1 : 0;
    pdy = Cxx >= Cyy ? 0 : 1;
  } else {
    const lambda = ((Cxx + Cyy) + Math.sqrt((Cxx - Cyy) ** 2 + 4 * Cxy ** 2)) / 2;
    pdx = Cxy; pdy = lambda - Cxx;
  }

  const principalBearing = Math.atan2(pdx, pdy) * 180 / Math.PI;
  const heading = (principalBearing + 90 + 360) % 360;
  const diagKm  = _haversineKm(bb.south, bb.west, bb.north, bb.east);
  const rangeM  = Math.max(diagKm * 1000 * 1.8, 5000);

  return { center: { lat: centerLat, lng: centerLng, altitude: 0 }, range: rangeM, tilt: 55, heading };
}

// ── Playback ──────────────────────────────────────────────────────────────────

let _playbackRaf      = null;
let _playbackWall     = 0; // performance.now() at (re)start, adjusted for paused offset
let _playbackRec      = 0; // recording timestamp at play start
let _playbackPausedAt = 0; // ms elapsed into recording when paused (0 = not paused)
let _playbackFrames   = [];

function _onPlayButton() {
  if (_playbackRaf) {
    _pausePlayback();
  } else {
    _startPlayback();
  }
}

function _startPlayback() {
  if (!currentRecording) return;

  _playbackFrames = currentRecording.segments.flat();
  if (_playbackFrames.length < 2) return;

  // Resume from paused position, or start from the beginning
  _playbackWall = performance.now() - _playbackPausedAt;
  _playbackRec  = _playbackFrames[0].timestamp;

  const btn = document.getElementById('btn-play');
  btn.textContent = '⏸ PAUSE';
  btn.classList.add('recording'); // reuse red style
  _setText('stat-status', '▶ Playing…');

  function tick() {
    const elapsed = performance.now() - _playbackWall;
    const recTime = _playbackRec + elapsed;
    const frames  = _playbackFrames;
    const last    = frames[frames.length - 1];

    if (recTime >= last.timestamp) {
      _stopPlayback();
      return;
    }

    // Binary search for the frame pair surrounding recTime
    let lo = 0, hi = frames.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].timestamp <= recTime) lo = mid; else hi = mid - 1;
    }

    const f0 = frames[lo];
    const f1 = frames[lo + 1];
    const t  = (recTime - f0.timestamp) / (f1.timestamp - f0.timestamp);

    // Interpolate and apply camera directly (no animation queuing)
    map.center  = {
      lat:      f0.center.lat      + (f1.center.lat      - f0.center.lat)      * t,
      lng:      f0.center.lng      + (f1.center.lng      - f0.center.lng)      * t,
      altitude: f0.center.altitude + (f1.center.altitude - f0.center.altitude) * t,
    };
    map.range   = f0.range + (f1.range - f0.range) * t;
    map.tilt    = f0.tilt  + (f1.tilt  - f0.tilt)  * t;

    // Heading: interpolate along the shortest arc
    const dh    = ((f1.heading - f0.heading) % 360 + 540) % 360 - 180;
    map.heading = f0.heading + dh * t;

    _playbackRaf = requestAnimationFrame(tick);
  }

  _playbackRaf = requestAnimationFrame(tick);
}

function _pausePlayback() {
  if (_playbackRaf) {
    _playbackPausedAt = performance.now() - _playbackWall;
    cancelAnimationFrame(_playbackRaf);
    _playbackRaf = null;
  }
  const btn = document.getElementById('btn-play');
  if (btn) {
    btn.textContent = '▶ PLAY';
    btn.classList.remove('recording');
  }
  _setText('stat-status', '⏸ Paused');
}

function _stopPlayback() {
  if (_playbackRaf) {
    cancelAnimationFrame(_playbackRaf);
    _playbackRaf = null;
  }
  _playbackPausedAt = 0;
  const btn = document.getElementById('btn-play');
  if (btn) {
    btn.textContent = '▶ PLAY';
    btn.classList.remove('recording');
  }
  if (_appState === 'visualised') _setText('stat-status', 'UGO rendered');
}

async function _startTour() {
  const workerBase = window.UGO_WORKER_URL || 'https://usergeneratedorbitbot.navarenko.workers.dev';
  _setText('stat-status', 'Loading tour…');

  let gistList;
  try {
    const res = await fetch(`${workerBase}/gists`);
    gistList  = await res.json();
  } catch (e) {
    _setText('stat-status', 'Could not load tour');
    return;
  }

  if (!gistList.length) {
    _setText('stat-status', 'No UGOs found');
    return;
  }

  // Load all recordings
  const recordings = [];
  for (const g of gistList) {
    try {
      const res  = await fetch(g.rawUrl);
      const text = await res.text();
      recordings.push(importKML(text));
    } catch (e) { /* skip bad entries */ }
  }

  if (!recordings.length) {
    _setText('stat-status', 'No valid UGOs');
    return;
  }

  // Render all at once
  _setText('stat-status', 'Rendering…');
  for (const rec of recordings) {
    try {
      await visualizer.renderRecording(rec, () => {});
    } catch (e) {}
  }

  _setText('stat-status', `${recordings.length} UGOs loaded`);
  _enterState('visualised');

  // Fly tour — 3s fly + 4s linger per UGO
  const FLY_MS    = 3000;
  const LINGER_MS = 4000;

  for (const rec of recordings) {
    const cam = _overviewCamera(rec);
    if (!cam) continue;
    map.flyCameraTo({ endCamera: cam, durationMillis: FLY_MS });
    await new Promise(r => setTimeout(r, FLY_MS + LINGER_MS));
  }

  _setText('stat-status', 'Tour complete');
}

async function _loadFromGist(gistId, { skipCameraFly = false } = {}) {
  _sharedUgoId = new URLSearchParams(location.search).has('ugo') ? gistId : null;
  _stopPlayback();

  let recording;

  // Reuse the recording pre-fetched during initMap if available, skipping a second network call
  if (_preloadedRecording) {
    recording = _preloadedRecording;
    _preloadedRecording = null;
  } else {
    _setText('stat-status', 'Loading UGO…');
    const workerBase = window.UGO_WORKER_URL || 'https://usergeneratedorbitbot.navarenko.workers.dev';
    let kmlText;
    try {
      const res = await fetch(`${workerBase}/gist-by-ugo?id=${encodeURIComponent(gistId)}`);
      if (!res.ok) throw new Error(`UGO not found (${res.status})`);
      kmlText = await res.text();
    } catch (err) {
      _showLoadError();
      return;
    }
    try {
      recording = importKML(kmlText);
    } catch (err) {
      _showLoadError();
      return;
    }
  }

  visualizer.clear();
  currentRecording = recording;
  document.getElementById('btn-fill').classList.remove('active');
  _metrics.maxAltitude = recording.metadata.maxAltitude ?? null;
  _metrics.distance    = recording.metadata.distance    ?? 0;
  _metrics.elapsedMs   = recording.metadata.totalDurationMs ?? null;
  _updateDevHud();

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

  _enterState('visualised');

  // On a shared UGO URL, hide controls and search, disable record and load.
  if (new URLSearchParams(location.search).has('ugo')) {
    document.getElementById('transport').classList.add('ui-hidden');
    document.getElementById('search-bar').classList.add('ui-hidden');
    document.getElementById('btn-record').disabled = true;
    document.getElementById('btn-load').disabled   = true;
    if (!isTouch) {
      document.getElementById('dev-hud').classList.remove('hidden');
      document.getElementById('camera-hud').classList.remove('hidden');
    }
  }

  // Fly to PCA-based overview — ease-out cubic, cancels immediately on user interaction.
  const cam = _overviewCamera(recording);
  if (cam && !skipCameraFly) {
    const DURATION = 7500;
    const start = {
      lat:     map.center?.lat      ?? cam.center.lat,
      lng:     map.center?.lng      ?? cam.center.lng,
      alt:     map.center?.altitude ?? 0,
      range:   map.range   ?? cam.range,
      tilt:    map.tilt    ?? cam.tilt,
      heading: map.heading ?? cam.heading,
    };
    const startTime = performance.now();
    let flyRaf = null;
    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
    function cancelFly() { if (flyRaf) { cancelAnimationFrame(flyRaf); flyRaf = null; } }
    function flyTick() {
      const t = Math.min((performance.now() - startTime) / DURATION, 1);
      const e = easeOut(t);
      const dh = ((cam.heading - start.heading) % 360 + 540) % 360 - 180;
      map.center  = { lat: start.lat + (cam.center.lat - start.lat) * e, lng: start.lng + (cam.center.lng - start.lng) * e, altitude: start.alt + (cam.center.altitude - start.alt) * e };
      map.range   = start.range   + (cam.range   - start.range)   * e;
      map.tilt    = start.tilt    + (cam.tilt    - start.tilt)    * e;
      map.heading = start.heading + dh * e;
      if (t < 1) flyRaf = requestAnimationFrame(flyTick);
    }
    map.addEventListener('pointerdown', cancelFly, { once: true });
    flyRaf = requestAnimationFrame(flyTick);
  }
}

async function _restoreSession(kml) {
  let recording;
  try { recording = importKML(kml); } catch (e) { return; }
  currentRecording = recording;
  _metrics.maxAltitude = recording.metadata.maxAltitude ?? null;
  _metrics.distance    = recording.metadata.distance    ?? 0;
  _metrics.elapsedMs   = recording.metadata.totalDurationMs ?? null;
  _updateDevHud();
  _setText('stat-status', 'Restoring…');
  try {
    await visualizer.renderRecording(currentRecording, ({ requests, locations, error }) => {
      _metrics.elevationRequests  += requests;
      _metrics.elevationLocations += locations;
      if (error) _metrics.elevationError = error;
      _updateDevHud();
    });
  } catch (e) {}
  _enterState('visualised');
  _setText('stat-status', 'UGO restored');
}

function _clearRecording() {
  _stopPlayback();
  visualizer.clear();
  currentRecording = null;
  _sharedUgoId = null;
  try { sessionStorage.removeItem('ugo-return-state'); } catch (e) {}
  if (location.search) history.replaceState(null, '', '/');
  document.getElementById('btn-fill').classList.remove('active');
  document.getElementById('btn-record').disabled = false;
  document.getElementById('btn-load').disabled   = false;
  _metrics.maxAltitude = null;
  _metrics.distance    = 0;
  _metrics._lastEyeLat = null;
  _metrics._lastEyeLng = null;
  _metrics.frameCount  = null;
  _metrics.elapsedMs   = null;
  _metrics.elevationRequests  = 0;
  _metrics.elevationLocations = 0;
  _metrics.elevationError     = '';
  _updateDevHud();
  _enterState('ready');
}

function _toggleISS() {
  const btn = document.getElementById('btn-iss-toggle');
  if (issTracker._visible) {
    issTracker.hide();
    btn.classList.remove('active');
    const arrowBtn = document.getElementById('btn-iss');
    arrowBtn.classList.remove('blink');
    arrowBtn.disabled = true;
    clearInterval(_satTimer);
    _satTimer = null;
  } else {
    issTracker.show();
    btn.classList.add('active');
    // Keep arrow disabled and blinking until first position is rendered.
    const arrowBtn = document.getElementById('btn-iss');
    arrowBtn.classList.add('blink');
    issTracker.onceReady(() => {
      arrowBtn.classList.remove('blink');
      arrowBtn.disabled = false;
    });
    _startSatTimer();
  }
}

function _startSatTimer() {
  clearInterval(_satTimer);
  const trackers = [issTracker/*, tiangongTracker*/];
  let i = 0;
  _satTimer = setInterval(() => {
    const t = trackers[i % trackers.length];
    if (t._visible) t._fetch();
    i++;
  }, 2000);
}

function _toggleTiangong() {
  const btn = document.getElementById('btn-tiangong-toggle');
  if (tiangongTracker._visible) {
    tiangongTracker.hide();
    btn.classList.remove('active');
    document.getElementById('btn-css').disabled = true;
  } else {
    tiangongTracker.show();
    btn.classList.add('active');
    document.getElementById('btn-css').disabled = false;
  }
}

async function _flyToCSS() {
  const pos = tiangongTracker.lastPos;
  if (!pos) return;
  map.flyCameraTo({
    endCamera: {
      center:  { lat: pos.lat, lng: pos.lng, altitude: pos.altitudeM },
      tilt:    70,
      heading: 0,
      range:   1000000,
    },
    durationMillis: 3000,
  });
}

async function _flyToISS() {
  let pos = issTracker.lastPos;
  if (!pos) {
    const btn = document.getElementById('btn-iss');
    const orig = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
    pos = await issTracker.fetchPosition();
    btn.textContent = orig;
    btn.disabled = false;
    if (!pos) return;
  }
  map.flyCameraTo({
    endCamera: {
      center:  { lat: pos.lat, lng: pos.lng, altitude: pos.altitudeM },
      tilt:    70,
      heading: 0,
      range:   500000,
    },
    durationMillis: 3000,
  });
}

function _resetCamera() {
  _stopPlayback();
  clearInterval(_durationTimer);
  _durationTimer = null;
  if (_appState === 'recording' || _appState === 'paused') {
    recorder.stop();
  }

  visualizer.clear();
  currentRecording = null;
  _sharedUgoId = null;
  try { sessionStorage.removeItem('ugo-return-state'); } catch (e) {}
  if (location.search) history.replaceState(null, '', '/');
  document.getElementById('btn-fill').classList.remove('active');
  document.getElementById('btn-record').disabled = false;
  document.getElementById('btn-load').disabled   = false;
  _metrics.maxAltitude = null;
  _metrics.distance    = 0;
  _metrics._lastEyeLat = null;
  _metrics._lastEyeLng = null;
  _metrics.frameCount  = null;
  _metrics.elapsedMs   = null;
  _metrics.elevationRequests  = 0;
  _metrics.elevationLocations = 0;
  _metrics.elevationError     = '';
  _updateDevHud();
  _enterState('ready');
  map.flyCameraTo({
    endCamera:      INITIAL_CAMERA,
    durationMillis: 2000,
  });
}

function _enterState(state) {
  _appState = state;
  const recBtn = document.getElementById('btn-record');
  recBtn.classList.remove('recording', 'paused');

  switch (state) {
    case 'ready':
      recBtn.textContent = '● REC';
      _setButtons({ record: true, stop: false, clear: false, fill: false, save: false, load: true, play: false });
      _setText('stat-status', 'Ready to record');
      break;
    case 'recording':
      recBtn.textContent = '⏸ PAUSE';
      recBtn.classList.add('recording');
      _setButtons({ record: true, stop: true, clear: false, fill: false, save: false, load: false, play: false });
      document.getElementById('stat-status').innerHTML = '<span class="dot-blink">●</span> Recording…';
      if (isTouch) setTimeout(_hideMobileUI, 800);
      break;
    case 'paused':
      recBtn.textContent = '● REC';
      recBtn.classList.add('paused');
      _setButtons({ record: true, stop: true, clear: false, fill: false, save: false, load: false, play: false });
      _setText('stat-status', '⏸ Paused');
      break;
    case 'visualised':
      recBtn.textContent = '● REC';
      _setButtons({ record: true, stop: false, clear: true, fill: true, save: true, load: true, play: true });
      _setText('stat-status', 'UGO rendered');
      document.getElementById('btn-fill').classList.add('active');
      break;
  }
}

// ── Camera readout ────────────────────────────────────────────────────────────

function _updateCameraReadout() {
  if (!map.center) return;
  const f = (n, d) => (n != null ? n.toFixed(d) : '—');

  // Use cameraPosition (beta) for accurate eye position; fall back to computed
  const camPos = map.cameraPosition;
  const tiltRad = (map.tilt || 0) * Math.PI / 180;
  const eyeLat  = camPos?.lat      ?? map.center.lat;
  const eyeLng  = camPos?.lng      ?? map.center.lng;
  const eyeAlt  = camPos?.altitude ?? ((map.center.altitude || 0) + (map.range || 0) * Math.cos(tiltRad));

  document.getElementById('c-lat').textContent   = f(eyeLat, 6);
  document.getElementById('c-lng').textContent   = f(eyeLng, 6);
  document.getElementById('c-alt').textContent   = f(eyeAlt, 0) + ' m';
  document.getElementById('c-range').textContent = f(map.range, 0) + ' m';
  document.getElementById('c-tilt').textContent  = f(map.tilt, 1) + '°';
  document.getElementById('c-hdg').textContent   = f(map.heading, 1) + '°';

  if (_appState === 'recording') {
    let hudDirty = false;
    if (_metrics.maxAltitude == null || eyeAlt > _metrics.maxAltitude) {
      _metrics.maxAltitude = eyeAlt;
      hudDirty = true;
    }
    if (_metrics.minAltitude == null || eyeAlt < _metrics.minAltitude) {
      _metrics.minAltitude = eyeAlt;
      hudDirty = true;
    }
    if (_metrics._lastEyeLat != null) {
      const horizKm = _haversineKm(_metrics._lastEyeLat, _metrics._lastEyeLng, eyeLat, eyeLng);
      const vertKm  = Math.abs(eyeAlt - _metrics._lastEyeAlt) / 1000;
      _metrics.distance += Math.sqrt(horizKm * horizKm + vertKm * vertKm);
      hudDirty = true;
    }
    _metrics._lastEyeLat = eyeLat;
    _metrics._lastEyeLng = eyeLng;
    _metrics._lastEyeAlt = eyeAlt;
    if (hudDirty) _updateDevHud();
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function _onSearch(e) {
  e.preventDefault();
  const query = document.getElementById('search-input').value.trim();

  if (!query) return;

  let result;
  try {
    const { Geocoder } = await google.maps.importLibrary('geocoding');
    const geocoder = new Geocoder();
    const { results } = await geocoder.geocode({ address: query });
    if (!results.length) return;
    result = results[0];
  } catch (err) {
    console.error('UGO: geocode failed', err);
    return;
  }

  const loc    = result.geometry.location;
  const vp     = result.geometry.viewport;
  const diagKm = _haversineKm(vp.getSouthWest().lat(), vp.getSouthWest().lng(), vp.getNorthEast().lat(), vp.getNorthEast().lng());
  const range  = Math.max(diagKm * 1000 * 0.2, 300);

  const FLY_MS = 24000;
  const cam = {
    center:  { lat: loc.lat(), lng: loc.lng(), altitude: 0 },
    range,
    tilt:    45,
    heading: 0,
  };
  map.flyCameraTo({ endCamera: cam, durationMillis: FLY_MS });

  if (_appState === 'recording') {
    recorder.markSearchFlight(FLY_MS);
    setTimeout(() => {
      if (_appState === 'recording') {
        _setText('stat-status', 'Search complete');
        setTimeout(() => {
          if (_appState === 'recording') {
            document.getElementById('stat-status').innerHTML = '<span class="dot-blink">●</span> Recording…';
          }
        }, 3000);
      }
    }, FLY_MS);
  }

  document.getElementById('search-input').blur();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _showLoadError() {
  const el = document.createElement('div');
  el.id = 'load-error';
  el.innerHTML = `
    <div>UGO not found</div>
    <div>This link may be broken or the recording no longer exists.</div>
    <a href="/gallery">← back to gallery</a>
  `;
  document.body.appendChild(el);
}

function _toggleFill() {
  const btn     = document.getElementById('btn-fill');
  const isOn    = btn.classList.toggle('active');
  visualizer.setFillVisible(isOn);
  map.focus();
}

function _setButtons({ record, stop, clear, fill, save, load, play }) {
  document.getElementById('btn-record').disabled = !record;
  document.getElementById('btn-stop').disabled   = !stop;
  document.getElementById('btn-clear').disabled  = !clear;
  if (fill !== undefined) document.getElementById('btn-fill').disabled = !fill;
  if (save !== undefined) document.getElementById('btn-save').disabled = !save;
  if (load !== undefined) document.getElementById('btn-load').disabled = !load;
  if (play !== undefined) document.getElementById('btn-play').disabled = !play;
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
  document.getElementById('dev-frames').textContent        = _metrics.frameCount  ?? 0;
  document.getElementById('dev-duration').textContent      = _metrics.elapsedMs != null ? _formatDuration(_metrics.elapsedMs) : '—';
  document.getElementById('dev-distance').textContent      = _metrics.distance > 0 ? _metrics.distance.toFixed(1) + ' km' : '—';
  document.getElementById('dev-max-altitude').textContent  = _metrics.maxAltitude != null ? (_metrics.maxAltitude / 1000).toFixed(1) + ' km' : '—';
  document.getElementById('dev-min-altitude').textContent  = _metrics.minAltitude != null ? (_metrics.minAltitude / 1000).toFixed(1) + ' km' : '—';
  document.getElementById('dev-elev-requests').textContent  = _metrics.elevationRequests;
  document.getElementById('dev-elev-locations').textContent = _metrics.elevationLocations;
  const errEl = document.getElementById('dev-elev-error');
  errEl.textContent = _metrics.elevationError || '';

  const infoEl = document.getElementById('dev-ugo-info');
  if (_sharedUgoId && currentRecording) {
    const d = new Date(currentRecording.createdAt);
    document.getElementById('dev-ugo-name').textContent = currentRecording.name;
    document.getElementById('dev-ugo-date').textContent = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    document.getElementById('dev-ugo-time').textContent = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
    infoEl.style.display = '';
  } else {
    infoEl.style.display = 'none';
  }
}

function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
