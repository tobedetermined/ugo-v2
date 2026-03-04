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
  }

  async renderRecording(recording) {
    if (!recording || recording.frames.length < 2) return;

    const { Polyline3DElement, AltitudeMode } =
      await google.maps.importLibrary('maps3d');

    // ── 1. Build curtain coordinates ──────────────────────────────────────
    // Use the camera eye position (not the look-at center) so that rotating
    // in place produces a circle, zooming produces a vertical line, etc.
    const topEdge = frames.map(f => ({
      lat:      f.eye.lat,
      lng:      f.eye.lng,
      altitude: f.eye.altitude,
    }));

    // ── 2. Bottom edge — ground trace of the flight path ─────────────────
    const bottomLine = new Polyline3DElement({
      strokeColor:           'rgba(255, 30, 30, 0.5)',
      strokeWidth:           1.5,
      altitudeMode:          AltitudeMode.ABSOLUTE,
      drawsOccludedSegments: true,
    });
    bottomLine.coordinates = frames.map(f => ({
      lat: f.eye.lat, lng: f.eye.lng, altitude: 0,
    }));
    this.map.appendChild(bottomLine);
    this._overlays.push(bottomLine);

    // ── 3. Top edge — the flight path line ───────────────────────────────
    const topLine = new Polyline3DElement({
      strokeColor:          'rgba(255, 50, 50, 0.9)',
      strokeWidth:          2,
      altitudeMode:         AltitudeMode.ABSOLUTE,
      drawsOccludedSegments: true,
    });
    topLine.coordinates = topEdge;
    this.map.appendChild(topLine);
    this._overlays.push(topLine);

    // ── 4. Vertical struts — every frame to approximate a filled curtain ──
    const strutEvery = 1;

    for (let i = 0; i < frames.length; i += strutEvery) {
      const f = frames[i];
      const strut = new Polyline3DElement({
        strokeColor:          'rgba(255, 30, 30, 0.55)',
        strokeWidth:          1,
        altitudeMode:         AltitudeMode.ABSOLUTE,
        drawsOccludedSegments: true,
      });
      strut.coordinates = [
        { lat: f.eye.lat, lng: f.eye.lng, altitude: f.eye.altitude },
        { lat: f.eye.lat, lng: f.eye.lng, altitude: 0 },
      ];
      this.map.appendChild(strut);
      this._overlays.push(strut);
    }
  }

  clear() {
    for (const overlay of this._overlays) {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }
    this._overlays = [];
  }
}
