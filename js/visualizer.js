/**
 * UGOVisualizer
 * Renders a recorded flight path into the 3D scene as a curtain.
 *
 * The "curtain" is the signature UGO visual: a semi-transparent red surface
 * that drops from the camera flight path straight down to the ground, with
 * vertical struts at regular intervals — exactly as in UGO v1 (2007).
 *
 * Construction:
 *   The curtain polygon is built by concatenating:
 *     1. Forward path  — each frame's (lat, lng) at eyeAltitude
 *     2. Ground return — the same points in reverse at altitude 0
 *   This creates a closed polygon that traces the curtain shape without
 *   needing the `extruded` property (which extrudes like a building, not a wall).
 *
 *   Vertical struts are added as separate Polyline3DElements to reproduce
 *   the evenly-spaced "fence posts" visible in the original UGO images.
 */
class UGOVisualizer {
  constructor(map3d) {
    this.map = map3d;
    this._overlays = [];
    this._fillPolys = [];
    this._struts = [];
    this._fillVisible = true;
  }

  // onMetrics: optional callback({ requests, locations }) fired after each elevation batch
  async renderRecording(recording, onMetrics) {
    if (!recording || !recording.segments || recording.segments.length === 0) return;

    const { Polyline3DElement, Polygon3DElement, AltitudeMode } =
      await google.maps.importLibrary('maps3d');

    // Fetch real terrain elevations at every eye position so strut tops
    // align exactly with the flight path line regardless of terrain variation.
    const allFrames  = recording.segments.flat();
    const elevations = await this._fetchEyeElevations(allFrames, onMetrics);

    let offset = 0;
    for (const frames of recording.segments) {
      if (frames.length < 2) { offset += frames.length; continue; }
      const segElevations = elevations.slice(offset, offset + frames.length);
      this._renderSegment(frames, segElevations, Polyline3DElement, Polygon3DElement, AltitudeMode);
      offset += frames.length;
    }
  }

  // Fetches terrain elevation at the eye lat/lng for every frame, in batches of 512.
  // Falls back to center.altitude if the Elevation API is unavailable or errors.
  async _fetchEyeElevations(frames, onMetrics) {
    try {
      const elevator   = new google.maps.ElevationService();
      const BATCH      = 512;
      const elevations = [];

      for (let i = 0; i < frames.length; i += BATCH) {
        const batch  = frames.slice(i, i + BATCH);
        const result = await elevator.getElevationForLocations({
          locations: batch.map(f => ({ lat: f.eye.lat, lng: f.eye.lng })),
        });
        elevations.push(...result.results.map(r => r.elevation));
        if (onMetrics) onMetrics({ requests: 1, locations: batch.length });
      }

      return elevations;
    } catch (err) {
      console.warn('UGO: Elevation API unavailable, falling back to center.altitude.', err);
      if (onMetrics) onMetrics({ requests: 0, locations: 0, error: err.message });
      return frames.map(f => f.center.altitude || 0);
    }
  }

  // Renders one continuous segment as its own curtain — no connection to other segments.
  // elevations[i] is the terrain elevation (m above sea level) at frames[i]'s eye position.
  _renderSegment(frames, elevations, Polyline3DElement, Polygon3DElement, AltitudeMode) {
    // ── 1. Top edge — the flight path line ─────────────────────────────
    // Split into runs of above/below sea level so each can be coloured
    // independently (a single Polyline3DElement can only have one colour).
    let runStart = 0;
    while (runStart < frames.length) {
      const belowSea = frames[runStart].eye.altitude < 0;
      let runEnd = runStart + 1;
      while (runEnd < frames.length && (frames[runEnd].eye.altitude < 0) === belowSea) runEnd++;
      // Include the neighbouring frame as a bridge point so runs connect cleanly
      const slice = frames.slice(runStart, runEnd + (runEnd < frames.length ? 1 : 0));
      const topLine = new Polyline3DElement({
        strokeColor:           belowSea ? 'rgba(160, 160, 180, 0.7)' : 'rgba(255, 50, 50, 0.9)',
        strokeWidth:           2,
        altitudeMode:          AltitudeMode.ABSOLUTE,
        drawsOccludedSegments: belowSea,
      });
      topLine.coordinates = slice.map(f => ({
        lat:      f.eye.lat,
        lng:      f.eye.lng,
        altitude: f.eye.altitude,
      }));
      this.map.appendChild(topLine);
      this._overlays.push(topLine);
      runStart = runEnd;
    }

    // ── 2. Filled curtain — one quad per adjacent frame pair ───────────
    // A single Polygon3DElement for the full path would tessellate as a flat
    // disc. Instead, each tiny quad between two consecutive frames is nearly
    // vertical, so tessellation stays correct and they tile into a wall.
    for (let i = 0; i < frames.length - 1; i++) {
      const a    = frames[i];
      const b    = frames[i + 1];
      const aFloor = Math.max(0, elevations[i]);
      const bFloor = Math.max(0, elevations[i + 1]);
      const belowSea = a.eye.altitude < 0 || b.eye.altitude < 0;
      const quad = new Polygon3DElement({
        fillColor:             belowSea ? 'rgba(160, 160, 180, 0.22)' : 'rgba(255, 30, 30, 0.22)',
        strokeColor:           'rgba(0, 0, 0, 0)',
        altitudeMode:          AltitudeMode.ABSOLUTE,
        drawsOccludedSegments: false,
      });
      quad.outerCoordinates = [
        { lat: a.eye.lat, lng: a.eye.lng, altitude: a.eye.altitude },
        { lat: b.eye.lat, lng: b.eye.lng, altitude: b.eye.altitude },
        { lat: b.eye.lat, lng: b.eye.lng, altitude: bFloor },
        { lat: a.eye.lat, lng: a.eye.lng, altitude: aFloor },
      ];
      if (this._fillVisible) this.map.appendChild(quad);
      this._overlays.push(quad);
      this._fillPolys.push(quad);
    }

    // ── 3. Vertical struts ─────────────────────────────────────────────
    for (let i = 0; i < frames.length; i++) {
      const f       = frames[i];
      const floorEl = Math.max(0, elevations[i]);

      if (f.eye.altitude >= 0) {
        // Normal above-sea-level strut (RELATIVE_TO_GROUND)
        const strut = new Polyline3DElement({
          strokeColor:           'rgba(255, 30, 30, 0.55)',
          strokeWidth:           1,
          altitudeMode:          AltitudeMode.RELATIVE_TO_GROUND,
          drawsOccludedSegments: false,
        });
        strut.coordinates = [
          { lat: f.eye.lat, lng: f.eye.lng, altitude: f.eye.altitude - floorEl },
          { lat: f.eye.lat, lng: f.eye.lng, altitude: 0 },
        ];
        if (this._fillVisible) this.map.appendChild(strut);
        this._overlays.push(strut);
        this._struts.push(strut);
      } else {
        // Below-sea-level strut — ABSOLUTE so altitude can go negative
        const strut = new Polyline3DElement({
          strokeColor:           'rgba(200, 140, 60, 0.65)',
          strokeWidth:           1,
          altitudeMode:          AltitudeMode.ABSOLUTE,
          drawsOccludedSegments: true,
        });
        strut.coordinates = [
          { lat: f.eye.lat, lng: f.eye.lng, altitude: 0 },
          { lat: f.eye.lat, lng: f.eye.lng, altitude: f.eye.altitude },
        ];
        if (this._fillVisible) this.map.appendChild(strut);
        this._overlays.push(strut);
        this._struts.push(strut);
      }
    }
  }

  setFillVisible(visible) {
    this._fillVisible = visible;
    for (const el of [...this._fillPolys, ...this._struts]) {
      if (visible && !el.parentNode) {
        this.map.appendChild(el);
      } else if (!visible && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }
  }

  clear() {
    for (const overlay of this._overlays) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    this._overlays     = [];
    this._fillPolys    = [];
    this._struts       = [];
    this._fillVisible  = true;
  }
}
