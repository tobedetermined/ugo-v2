import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

// kml.js is a browser global script — execute it with a module/exports shim
// so its conditional exports block fires. DOMParser is provided by jsdom.
const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '../js/kml.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', src)(mod, mod.exports);
const { exportKML, importKML } = mod.exports;

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeRecording(overrides = {}) {
  const now = Date.now();
  return {
    name: 'Test UGO',
    sampleIntervalMs: 50,
    segments: [
      [
        { timestamp: now,        center: { lat: 52.1, lng: 4.3, altitude: 0 }, eye: { lat: 52.1, lng: 4.3, altitude: 300000 }, heading: 45,  tilt: 60, range: 300000 },
        { timestamp: now + 50,   center: { lat: 52.2, lng: 4.4, altitude: 0 }, eye: { lat: 52.2, lng: 4.4, altitude: 250000 }, heading: 90,  tilt: 55, range: 250000 },
        { timestamp: now + 100,  center: { lat: 52.3, lng: 4.5, altitude: 0 }, eye: { lat: 52.3, lng: 4.5, altitude: 200000 }, heading: 135, tilt: 50, range: 200000 },
      ],
    ],
    metadata: {
      frameCount:      3,
      totalDurationMs: 100,
      distance:        22.5,
      maxAltitude:     300000,
      boundingBox:     { north: 52.3, south: 52.1, east: 4.5, west: 4.3 },
    },
    ...overrides,
  };
}

// ── Round-trip ────────────────────────────────────────────────────────────────

describe('KML round-trip', () => {
  it('importKML(exportKML(rec)) is lossless', () => {
    const original = makeRecording();
    const kml      = exportKML(original);
    const restored = importKML(kml);

    expect(restored.name).toBe(original.name);
    expect(restored.sampleIntervalMs).toBe(original.sampleIntervalMs);
    expect(restored.segments).toHaveLength(original.segments.length);
    expect(restored.segments[0]).toHaveLength(original.segments[0].length);
    expect(restored.metadata.frameCount).toBe(original.metadata.frameCount);
    expect(restored.metadata.totalDurationMs).toBe(original.metadata.totalDurationMs);
    expect(restored.metadata.distance).toBeCloseTo(original.metadata.distance, 5);
    expect(restored.metadata.boundingBox).toEqual(original.metadata.boundingBox);
  });

  it('frame timestamps are preserved exactly', () => {
    const original = makeRecording();
    const restored = importKML(exportKML(original));
    original.segments[0].forEach((f, i) => {
      expect(restored.segments[0][i].timestamp).toBe(f.timestamp);
    });
  });

  it('frame coordinates are preserved', () => {
    const original = makeRecording();
    const restored = importKML(exportKML(original));
    original.segments[0].forEach((f, i) => {
      const r = restored.segments[0][i];
      expect(r.center.lat).toBeCloseTo(f.center.lat, 6);
      expect(r.center.lng).toBeCloseTo(f.center.lng, 6);
      expect(r.eye.lat).toBeCloseTo(f.eye.lat, 6);
      expect(r.eye.lng).toBeCloseTo(f.eye.lng, 6);
      expect(r.eye.altitude).toBeCloseTo(f.eye.altitude, 0);
    });
  });

  it('multiple segments survive round-trip', () => {
    const now = Date.now();
    const original = makeRecording({
      segments: [
        [
          { timestamp: now,      center: { lat: 1, lng: 1, altitude: 0 }, eye: { lat: 1, lng: 1, altitude: 100000 }, heading: 0,   tilt: 45, range: 100000 },
          { timestamp: now + 50, center: { lat: 2, lng: 2, altitude: 0 }, eye: { lat: 2, lng: 2, altitude: 100000 }, heading: 90,  tilt: 45, range: 100000 },
        ],
        [
          { timestamp: now + 200, center: { lat: 3, lng: 3, altitude: 0 }, eye: { lat: 3, lng: 3, altitude: 100000 }, heading: 180, tilt: 45, range: 100000 },
          { timestamp: now + 250, center: { lat: 4, lng: 4, altitude: 0 }, eye: { lat: 4, lng: 4, altitude: 100000 }, heading: 270, tilt: 45, range: 100000 },
        ],
      ],
    });
    const restored = importKML(exportKML(original));
    expect(restored.segments).toHaveLength(2);
    expect(restored.segments[0]).toHaveLength(2);
    expect(restored.segments[1]).toHaveLength(2);
    expect(restored.segments[1][0].center.lat).toBeCloseTo(3, 5);
  });
});

// ── Export output ─────────────────────────────────────────────────────────────

describe('exportKML output', () => {
  it('produces valid XML', () => {
    const kml = exportKML(makeRecording());
    const doc = new DOMParser().parseFromString(kml, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
  });

  it('contains embedded ugo-recording data', () => {
    const kml = exportKML(makeRecording());
    expect(kml).toContain('ugo-recording');
    expect(kml).toContain('<![CDATA[');
  });

  it('contains a gx:Tour', () => {
    const kml = exportKML(makeRecording());
    expect(kml).toContain('<gx:Tour>');
    expect(kml).toContain('<gx:FlyTo>');
  });

  it('escapes special characters in XML elements', () => {
    const rec = makeRecording({ name: '<Script & "injection">' });
    const kml = exportKML(rec);
    // XML elements must escape the name
    expect(kml).toContain('&lt;Script &amp; &quot;injection&quot;&gt;');
    // Raw name may appear inside CDATA (JSON payload) — that is correct
    const xmlPart = kml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    expect(xmlPart).not.toContain('<Script');
  });
});

// ── Import errors ─────────────────────────────────────────────────────────────

describe('importKML errors', () => {
  it('throws on invalid XML', () => {
    expect(() => importKML('not xml at all <<<')).toThrow('Invalid KML');
  });

  it('throws on KML without embedded UGO data', () => {
    const foreignKml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document></Document></kml>`;
    expect(() => importKML(foreignKml)).toThrow('not exported from UGO');
  });

  it('throws on corrupt embedded JSON', () => {
    const kml = exportKML(makeRecording()).replace(/"name"/, 'CORRUPT');
    expect(() => importKML(kml)).toThrow();
  });
});
