/**
 * SatTracker — shows a satellite as a 3-D wireframe model on the globe.
 *
 * Uses the wheretheiss.at API to get real-time position. For the ISS, renders
 * a simplified wireframe: main truss, 8 solar array wings, module stack, and
 * Zvezda mini-wings.
 *
 * ISS_SCALE multiplies real dimensions so the model is visible at orbital
 * distance. Real truss ≈ 109 m; at scale 50 that becomes ~5.4 km.
 */
const ISS_SCALE = 100;

class SatTracker {
  constructor(map3d, noradId, color, apiType = 'wheretheiss') {
    this.map      = map3d;
    this.noradId  = noradId;
    this.color    = color;
    this.apiType  = apiType;
    this._lines    = [];
    this._timer    = null;
    this._visible  = false;
    this.lastPos   = null;
    this._onReady  = null;
    this._hasDrawn = false;
  }

  // Register a one-shot callback fired after the first position is rendered.
  onceReady(cb) { this._onReady = cb; }

  show() {
    if (this._visible) return;
    this._visible = true;
    this._fetch();
  }

  hide() {
    this._visible  = false;
    this._hasDrawn = false;
    this._onReady  = null;
    this._clearLines();
  }

  async fetchPosition() {
    try {
      let lat, lng, altKm;

      if (this.apiType === 'n2yo') {
        const n2yoUrl = `https://api.n2yo.com/rest/v1/satellite/positions/${this.noradId}/0/0/0/1/&apiKey=${window.N2YO_API_KEY}`;
        const res  = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(n2yoUrl)}`);
        if (!res.ok) {
          console.warn(`UGO: N2YO HTTP ${res.status}`, await res.text().catch(() => ''));
          return null;
        }
        const data = await res.json();
        if (!data.positions?.[0]) {
          console.warn('UGO: N2YO no positions in response', data);
          return null;
        }
        const pos  = data.positions[0];
        if (!pos) return null;
        lat   = pos.satlatitude;
        lng   = pos.satlongitude;
        altKm = pos.sataltitude;
      } else {
        const res  = await fetch('https://api.wheretheiss.at/v1/satellites/25544');
        if (res.status === 429) return null;
        const data = await res.json();
        if (typeof data.latitude !== 'number') return null;
        const delta = data.timestamp - (this._lastTimestamp || data.timestamp);
        console.log('ISS ts:', data.timestamp, 'Δ:', delta, 's');
        if (data.timestamp === this._lastTimestamp) return null;
        this._lastTimestamp = data.timestamp;
        lat   = data.latitude;
        lng   = data.longitude;
        altKm = data.altitude;
      }

      this.lastPos = { lat, lng, altitudeM: altKm * 1000 };
      return this.lastPos;
    } catch (e) {
      console.warn(`UGO: satellite ${this.noradId} fetch failed`, e);
      return null;
    }
  }

  async _fetch() {
    const pos = await this.fetchPosition();
    if (pos) this._update(pos.lat, pos.lng, pos.altitudeM);
  }

  async _update(lat, lng, altitudeM) {
    if (!this._visible) return;

    const { Polyline3DElement, AltitudeMode } = await google.maps.importLibrary('maps3d');

    this._clearLines();

    const isFirst = !this._hasDrawn;
    this._hasDrawn = true;
    this._lines = this._buildISS(lat, lng, altitudeM).map(pts => {
      const line = new Polyline3DElement({
        strokeColor:           this.color,
        strokeWidth:           2,
        altitudeMode:          AltitudeMode.ABSOLUTE,
        drawsOccludedSegments: true,
      });
      line.path = pts;
      this.map.appendChild(line);
      return line;
    });

    if (isFirst && this._onReady) {
      const cb = this._onReady;
      this._onReady = null;
      cb();
    }
  }

  _clearLines() {
    this._lines.forEach(l => l.parentNode?.removeChild(l));
    this._lines = [];
  }

  // Convert local ISS-frame offsets (real metres × ISS_SCALE) to globe coords.
  // dx = east (+) / west (−), dy = north (+) / south (−), dz = up (+) / down (−)
  _pt(lat, lng, altM, dx, dy, dz) {
    const cosLat = Math.cos(lat * Math.PI / 180);
    return {
      lat:      lat  + (dy * ISS_SCALE) / 111320,
      lng:      lng  + (dx * ISS_SCALE) / (111320 * cosLat),
      altitude: altM + (dz * ISS_SCALE),
    };
  }

  _buildISS(lat, lng, altM) {
    const p = (dx, dy, dz) => this._pt(lat, lng, altM, dx, dy, dz);
    const s = [];

    // ── TRUSS (runs east–west, Z = +5 above module centreline) ──────────────
    s.push([p(-54,  0,  5), p(54,  0,  5)]);   // spine
    s.push([p(-54,  3,  5), p(54,  3,  5)]);   // front rail
    s.push([p(-54, -3,  5), p(54, -3,  5)]);   // rear rail
    // Cross-braces at SAW attachment joints and centre
    for (const x of [-41, -28, 0, 28, 41]) {
      s.push([p(x, -3, 5), p(x, 3, 5)]);
    }

    // ── MODULE STACK (runs north–south through the truss centre, Z = 0) ─────
    s.push([p(-2, -38, 0), p(-2,  13, 0)]);   // port wall
    s.push([p( 2, -38, 0), p( 2,  13, 0)]);   // starboard wall
    s.push([p(-2, -38, 0), p( 2, -38, 0)]);   // aft cap (Zvezda end)
    s.push([p(-2,  13, 0), p( 2,  13, 0)]);   // fore cap (Harmony end)
    s.push([p(  0,  0, 0), p(  0,  0,  5)]);  // vertical strut up to truss

    // ── SOLAR ARRAY WINGS (8 panels — 4 pairs at X = ±28 and ±41) ──────────
    // Real dimensions: 35 m tall, 12 m wide. Upper wing extends +Z, lower −Z.
    for (const x of [-41, -28, 28, 41]) {
      const x0 = x - 6, x1 = x + 6;
      // Upper wing rectangle + midline
      s.push([p(x0, 0, 5), p(x1, 0, 5), p(x1, 0, 40), p(x0, 0, 40), p(x0, 0, 5)]);
      s.push([p(x0, 0, 22), p(x1, 0, 22)]);
      // Lower wing rectangle + midline
      s.push([p(x0, 0, 5), p(x1, 0, 5), p(x1, 0, -30), p(x0, 0, -30), p(x0, 0, 5)]);
      s.push([p(x0, 0, -12), p(x1, 0, -12)]);
    }

    // ── ZVEZDA MINI-WINGS (small panels at aft end, extend east–west) ───────
    const sy = -32;
    s.push([p(-15, sy, 0), p(-5, sy, 0)]);
    s.push([p(  5, sy, 0), p(15, sy, 0)]);

    return s;
  }
}
