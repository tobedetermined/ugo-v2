/**
 * SatTracker — shows a satellite as a coloured dot on the 3D globe.
 *
 * Uses the wheretheiss.at API (supports any NORAD ID) to get real-time
 * TLE-propagated position. Renders a filled Polygon3DElement circle.
 */
class SatTracker {
  constructor(map3d, noradId, color, apiType = 'wheretheiss') {
    this.map      = map3d;
    this.noradId  = noradId;
    this.color    = color;
    this.apiType  = apiType;
    this._dot      = null;
    this._timer    = null;
    this._visible  = false;
    this.lastPos   = null;
  }

  show() {
    if (this._visible) return;
    this._visible = true;
    this._fetch();
  }

  hide() {
    this._visible = false;
    if (this._dot && this._dot.parentNode) this._dot.parentNode.removeChild(this._dot);
    this._dot = null;
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

    const { Polygon3DElement, AltitudeMode } =
      await google.maps.importLibrary('maps3d');

    const coords = this._circle(lat, lng, altitudeM, 5000, 32);

    if (!this._dot) {
      this._dot = new Polygon3DElement({
        fillColor:             this.color,
        strokeColor:           this.color,
        strokeWidth:           2,
        altitudeMode:          AltitudeMode.ABSOLUTE,
        drawsOccludedSegments: false,
      });
      this.map.appendChild(this._dot);
    }

    this._dot.path = coords;
  }

  _circle(lat, lng, altitudeM, radiusM, n) {
    const EARTH_R = 6371000;
    const latR    = lat * Math.PI / 180;
    const lngR    = lng * Math.PI / 180;
    const angDist = radiusM / EARTH_R;
    const pts     = [];

    for (let i = 0; i <= n; i++) {
      const bearing = (i / n) * 2 * Math.PI;
      const pLatR   = Math.asin(
        Math.sin(latR) * Math.cos(angDist) +
        Math.cos(latR) * Math.sin(angDist) * Math.cos(bearing)
      );
      const pLngR   = lngR + Math.atan2(
        Math.sin(bearing) * Math.sin(angDist) * Math.cos(latR),
        Math.cos(angDist) - Math.sin(latR) * Math.sin(pLatR)
      );
      pts.push({ lat: pLatR * 180 / Math.PI, lng: pLngR * 180 / Math.PI, altitude: altitudeM });
    }

    return pts;
  }

}
