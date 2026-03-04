/**
 * UGORecorder
 * Captures the camera state from a Map3DElement at regular intervals.
 *
 * Key design: we record the camera EYE position altitude (not just the
 * look-at point), because that's what produces the dramatic curtain height
 * seen in the original UGO — flying across a continent at 1000km altitude
 * creates a curtain wall 1000km tall.
 *
 * Eye altitude is calculated from:
 *   eyeAlt = center.altitude + range * cos(tilt)
 */
class UGORecorder {
  constructor(map3d, intervalMs = 200) {
    this.map = map3d;
    this.intervalMs = intervalMs;
    this.frames = [];
    this.recording = false;
    this.timer = null;
    this.startTime = null;

    // Optional callback: fired after each captured frame
    // signature: (frameCount, elapsedMs) => void
    this.onFrame = null;
  }

  start() {
    this.frames = [];
    this.recording = true;
    this.startTime = performance.now();
    this.timer = setInterval(() => this._captureFrame(), this.intervalMs);
  }

  stop() {
    if (!this.recording) return null;
    this.recording = false;
    clearInterval(this.timer);
    this.timer = null;
    return this._buildRecording();
  }

  getFrameCount() {
    return this.frames.length;
  }

  getElapsedMs() {
    if (!this.startTime) return 0;
    return performance.now() - this.startTime;
  }

  // ── Private ──────────────────────────────────────

  _captureFrame() {
    const center = this.map.center;
    if (!center) return;

    const tiltDeg   = this.map.tilt    || 0;
    const heading   = this.map.heading || 0;
    const range     = this.map.range   || 1000;
    const centerAlt = center.altitude  || 0;

    // Calculate the actual camera eye position in 3D space.
    // The eye sits at `range` distance from the center, in the direction
    // opposite to heading (heading + 180°), tilted up by (90° - tilt).
    const EARTH_R   = 6371000; // metres
    const tiltRad   = (tiltDeg  * Math.PI) / 180;
    const bearingRad = ((heading + 180) % 360) * Math.PI / 180;
    const latRad    = center.lat * Math.PI / 180;

    const horizDist = range * Math.sin(tiltRad);
    const eyeLat    = center.lat + (horizDist * Math.cos(bearingRad)) / EARTH_R * (180 / Math.PI);
    const eyeLng    = center.lng + (horizDist * Math.sin(bearingRad)) / (EARTH_R * Math.cos(latRad)) * (180 / Math.PI);
    const eyeAlt    = Math.max(centerAlt + range * Math.cos(tiltRad), 1);

    const frame = {
      timestamp: performance.now() - this.startTime,
      center: {
        lat:      center.lat,
        lng:      center.lng,
        altitude: centerAlt,
      },
      eye: {
        lat:      eyeLat,
        lng:      eyeLng,
        altitude: eyeAlt,
      },
      range,
      tilt:    tiltDeg,
      heading,
    };

    // Skip duplicate frames (camera hasn't moved)
    if (this.frames.length > 0) {
      const prev = this.frames[this.frames.length - 1];
      if (this._isSamePosition(frame, prev)) return;
    }

    this.frames.push(frame);

    if (this.onFrame) {
      this.onFrame(this.frames.length, frame.timestamp);
    }
  }

  _isSamePosition(a, b) {
    return (
      Math.abs(a.eye.lat - b.eye.lat) < 0.000001 &&
      Math.abs(a.eye.lng - b.eye.lng) < 0.000001 &&
      Math.abs(a.eye.altitude - b.eye.altitude) < 1
    );
  }

  _buildRecording() {
    const frames = [...this.frames];
    if (frames.length === 0) return null;

    const lats = frames.map(f => f.center.lat);
    const lngs = frames.map(f => f.center.lng);
    const totalDurationMs = frames[frames.length - 1].timestamp;

    return {
      id:         crypto.randomUUID(),
      name:       `UGO ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      createdAt:  new Date().toISOString(),
      frames,
      sampleIntervalMs: this.intervalMs,
      metadata: {
        totalDurationMs,
        frameCount: frames.length,
        boundingBox: {
          north: Math.max(...lats),
          south: Math.min(...lats),
          east:  Math.max(...lngs),
          west:  Math.min(...lngs),
        },
      },
    };
  }
}
