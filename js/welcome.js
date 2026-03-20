const ANCHOR_LAT = 37.790850;
const ANCHOR_LNG = -122.190771;
const ANCHOR_ALT = 8000;    // meters
const UNIT_M     = 1500;    // meters per grid unit
const RIGHT_BRG  = 167.2;   // degrees (perpendicular to camera heading 77.2°)
const DEPTH_BRG  = 77.2;    // degrees (along camera heading — extrusion direction)
const DEPTH_U    = 2;       // grid units of depth

const _cosLat = Math.cos(ANCHOR_LAT * Math.PI / 180);

function _gridToWorld(slot, xu, yu, du = 0) {
  const totalX  = (slot * 5 + xu - 42) * UNIT_M;
  const depthM  = du * UNIT_M;
  const rBrg    = RIGHT_BRG * Math.PI / 180;
  const dBrg    = DEPTH_BRG * Math.PI / 180;
  return {
    lat:      ANCHOR_LAT + (totalX * Math.cos(rBrg) + depthM * Math.cos(dBrg)) / 111320,
    lng:      ANCHOR_LNG + (totalX * Math.sin(rBrg) + depthM * Math.sin(dBrg)) / (111320 * _cosLat),
    altitude: ANCHOR_ALT + yu * UNIT_M,
  };
}

const LETTERS = {
  'W': [ [[0,7],[0.75,0],[2,3],[3.25,0],[4,7]] ],
  'E': [ [[4,7],[0,7],[0,0],[4,0]], [[0,3.5],[3,3.5]] ],
  'L': [ [[0,7],[0,0],[4,0]] ],
  'C': [ [[4,6],[2,7],[0,6],[0,1],[2,0],[4,1]] ],
  'O': [ [[2,7],[0,6],[0,1],[2,0],[4,1],[4,6],[2,7]] ],
  'M': [ [[0,0],[0,7],[2,3],[4,7],[4,0]] ],
  'A': [ [[0,0],[2,7],[4,0]], [[0.85,2.8],[3.15,2.8]] ],
  'R': [ [[0,0],[0,7],[3,7],[4,5.5],[3,3.5],[0,3.5]], [[2,3.5],[4,0]] ],
  'T': [ [[0,7],[4,7]], [[2,7],[2,0]] ],
  'H': [ [[0,0],[0,7]], [[4,0],[4,7]], [[0,3.5],[4,3.5]] ],
  'I': [ [[1,7],[3,7]], [[2,7],[2,0]], [[1,0],[3,0]] ],
  'N': [ [[0,0],[0,7],[4,0],[4,7]] ],
  'G': [ [[4,6],[2,7],[0,6],[0,1],[2,0],[4,1],[4,3.5],[2,3.5]] ],
  'U': [ [[0,7],[0,1],[2,0],[4,1],[4,7]] ],
};

class WelcomeMessage {
  constructor(map3d, targetCamera, { onDismiss } = {}) { this.map = map3d; this._target = targetCamera; this._overlays = []; this._timers = []; this._onDismiss = onDismiss; }

  async show() {
    const { Polyline3DElement, Polygon3DElement, AltitudeMode } = await google.maps.importLibrary('maps3d');
    const chars = [
      {ch:'W',slot:2},{ch:'E',slot:3},{ch:'L',slot:4},{ch:'C',slot:5},
      {ch:'O',slot:6},{ch:'M',slot:7},{ch:'E',slot:8},
      {ch:'T',slot:10},{ch:'O',slot:11},
      {ch:'U',slot:13},{ch:'G',slot:14},{ch:'O',slot:15},
    ];
    const FLY_MS     = 5000;
    const LETTERS_MS = 1000;   // letters start this long after fly begins
    const LTR_SPAN   = FLY_MS * 0.75 - LETTERS_MS;  // time window for all letters
    const STEP_MS    = LTR_SPAN / (chars.length - 1);

    this._timers.push(setTimeout(() => {
      if (this._dismissed) return;
      if (this._target) {
        this.map.flyCameraTo({ endCamera: this._target, durationMillis: FLY_MS });
      }
      chars.forEach(({ch, slot}, i) => {
        this._timers.push(setTimeout(() => {
          this._drawChar(ch, slot, Polyline3DElement, Polygon3DElement, AltitudeMode);
        }, LETTERS_MS + i * STEP_MS));
      });
      // Dismiss 5s after the last letter appears
      const lastLetterMs = LETTERS_MS + (chars.length - 1) * STEP_MS;
      this._timers.push(setTimeout(() => this.dismiss(), lastLetterMs + 4000));
    }, 800));
  }

  _makeLine(Polyline3DElement, AltitudeMode, pts) {
    const line = new Polyline3DElement({
      strokeColor: 'rgba(255, 50, 50, 0.9)',
      strokeWidth: 3,
      altitudeMode: AltitudeMode.ABSOLUTE,
      drawsOccludedSegments: false,
    });
    line.path = pts;
    line._pts = pts;
    this.map.appendChild(line);
    this._overlays.push(line);
  }

  _makeFlange(Polygon3DElement, AltitudeMode, a, b) {
    const poly = new Polygon3DElement({
      fillColor: 'rgba(255, 30, 30, 0.22)',
      strokeColor: 'rgba(0, 0, 0, 0)',
      strokeWidth: 0,
      altitudeMode: AltitudeMode.ABSOLUTE,
      extruded: false,
    });
    const coords = [
      _gridToWorld(...a, 0),
      _gridToWorld(...b, 0),
      _gridToWorld(...b, DEPTH_U),
      _gridToWorld(...a, DEPTH_U),
    ];
    poly.outerCoordinates = coords;
    poly._pts = coords;
    this.map.appendChild(poly);
    this._overlays.push(poly);
  }

  _drawChar(ch, slot, Polyline3DElement, Polygon3DElement, AltitudeMode) {
    for (const stroke of (LETTERS[ch] || [])) {
      // Front and back faces
      this._makeLine(Polyline3DElement, AltitudeMode,
        stroke.map(([x, y]) => _gridToWorld(slot, x, y, 0)));
      this._makeLine(Polyline3DElement, AltitudeMode,
        stroke.map(([x, y]) => _gridToWorld(slot, x, y, DEPTH_U)));

      // Side struts and filled flanges between consecutive vertices
      for (let i = 0; i < stroke.length - 1; i++) {
        const a = [slot, ...stroke[i]];
        const b = [slot, ...stroke[i + 1]];
        this._makeLine(Polyline3DElement, AltitudeMode, [
          _gridToWorld(...a, 0), _gridToWorld(...a, DEPTH_U),
        ]);
        this._makeFlange(Polygon3DElement, AltitudeMode, a, b);
      }
      // Closing strut at the last vertex
      const last = [slot, ...stroke[stroke.length - 1]];
      this._makeLine(Polyline3DElement, AltitudeMode, [
        _gridToWorld(...last, 0), _gridToWorld(...last, DEPTH_U),
      ]);
    }
  }

  dismiss() {
    if (this._dismissed) return;
    this._dismissed = true;
    this._timers.forEach(t => clearTimeout(t));
    this._onDismiss?.();
    this._fadeOut();
  }

  _fadeOut() {
    const overlays = this._overlays;
    this._overlays = [];
    const duration = 2000;
    const drop = 12000; // metres to fall
    const start = performance.now();

    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const ease = t * t;           // accelerate downward
      const alpha = 1 - t;

      overlays.forEach(el => {
        const shifted = el._pts.map(p => ({ ...p, altitude: p.altitude - ease * drop }));
        if (el.tagName === 'GMP-POLYLINE-3D') {
          el.path = shifted;
          el.strokeColor = `rgba(255, 50, 50, ${(alpha * 0.9).toFixed(3)})`;
        } else {
          el.outerCoordinates = shifted;
          el.fillColor = `rgba(255, 30, 30, ${(alpha * 0.22).toFixed(3)})`;
        }
      });

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        overlays.forEach(el => el.parentNode?.removeChild(el));
      }
    };

    requestAnimationFrame(tick);
  }
}
