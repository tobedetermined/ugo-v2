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
 *
 * Supports pause/resume: each continuous recording run is stored as a
 * separate segment. Segments are rendered independently so there is no
 * connecting line between a paused and resumed position.
 */
class UGORecorder {
  constructor(map3d, intervalMs = 200) {
    this.map = map3d;
    this.intervalMs = intervalMs;
    this.recording = false;
    this.paused = false;
    this.timer = null;
    this.segments = [];         // completed segments: { frames, durationMs }
    this.currentSegment = [];   // frames being captured right now
    this.segmentStartTime = null;

    // Optional callback: fired after each captured frame
    // signature: (frameCount, elapsedMs) => void
    this.onFrame = null;
  }

  start() {
    this.segments = [];
    this.currentSegment = [];
    this.recording = true;
    this.paused = false;
    this.segmentStartTime = performance.now();
    this.timer = setInterval(() => this._captureFrame(), this.intervalMs);
  }

  pause() {
    if (!this.recording || this.paused) return;
    clearInterval(this.timer);
    this.timer = null;
    this.paused = true;
    const durationMs = performance.now() - this.segmentStartTime;
    if (this.currentSegment.length > 0) {
      this.segments.push({ frames: this.currentSegment, durationMs });
    }
    this.currentSegment = [];
  }

  resume() {
    if (!this.recording || !this.paused) return;
    this.paused = false;
    this.segmentStartTime = performance.now();
    this.timer = setInterval(() => this._captureFrame(), this.intervalMs);
  }

  stop() {
    if (!this.recording) return null;
    if (!this.paused) {
      clearInterval(this.timer);
      this.timer = null;
      const durationMs = performance.now() - this.segmentStartTime;
      if (this.currentSegment.length > 0) {
        this.segments.push({ frames: this.currentSegment, durationMs });
      }
    }
    this.recording = false;
    this.paused = false;
    this.currentSegment = [];
    return this._buildRecording();
  }

  getFrameCount() {
    const done = this.segments.reduce((sum, s) => sum + s.frames.length, 0);
    return done + this.currentSegment.length;
  }

  getElapsedMs() {
    const done = this.segments.reduce((sum, s) => sum + s.durationMs, 0);
    if (this.paused || !this.segmentStartTime) return done;
    return done + (performance.now() - this.segmentStartTime);
  }

  // ── Private ──────────────────────────────────────

  _captureFrame() {
    const center = this.map.center;
    if (!center) return;

    const tiltDeg   = this.map.tilt    || 0;
    const heading   = this.map.heading || 0;
    const range     = this.map.range   || 1000;
    const centerAlt = center.altitude  || 0;

    // Compute the true camera eye position using the spherical direct formula.
    // This correctly captures rotation-in-place as a circle, zooming as a
    // vertical line, etc. The flat-Earth approximation was replaced because it
    // divides by cos(lat) which explodes near the poles and breaks at large ranges.
    const EARTH_R    = 6371000;
    const tiltRad    = (tiltDeg  * Math.PI) / 180;
    const bearingRad = ((heading + 180) % 360) * Math.PI / 180;
    const latRad     = center.lat * Math.PI / 180;
    const lngRad     = center.lng * Math.PI / 180;

    const horizDist  = range * Math.sin(tiltRad);
    const angDist    = horizDist / EARTH_R;

    const eyeLatRad  = Math.asin(
      Math.sin(latRad) * Math.cos(angDist) +
      Math.cos(latRad) * Math.sin(angDist) * Math.cos(bearingRad)
    );
    const eyeLngRad  = lngRad + Math.atan2(
      Math.sin(bearingRad) * Math.sin(angDist) * Math.cos(latRad),
      Math.cos(angDist) - Math.sin(latRad) * Math.sin(eyeLatRad)
    );

    const eyeLat = eyeLatRad * 180 / Math.PI;
    const eyeLng = eyeLngRad * 180 / Math.PI;
    const eyeAlt = Math.max(centerAlt + range * Math.cos(tiltRad), 1);

    const frame = {
      timestamp: performance.now() - this.segmentStartTime,
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
    if (this.currentSegment.length > 0) {
      const prev = this.currentSegment[this.currentSegment.length - 1];
      if (this._isSamePosition(frame, prev)) return;
    }

    this.currentSegment.push(frame);

    if (this.onFrame) {
      this.onFrame(this.getFrameCount(), this.getElapsedMs());
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
    if (this.segments.length === 0) return null;

    const allFrames = this.segments.flatMap(s => s.frames);
    if (allFrames.length < 2) return null;

    const lats = allFrames.map(f => f.center.lat);
    const lngs = allFrames.map(f => f.center.lng);
    const segmentDurations = this.segments.map(s => s.durationMs);
    const totalDurationMs  = segmentDurations.reduce((sum, d) => sum + d, 0);

    return {
      id:         crypto.randomUUID(),
      name:       `UGO ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      createdAt:  new Date().toISOString(),
      segments:   this.segments.map(s => s.frames),
      sampleIntervalMs: this.intervalMs,
      metadata: {
        totalDurationMs,
        segmentDurations,
        segmentCount:  this.segments.length,
        frameCount:    allFrames.length,
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
