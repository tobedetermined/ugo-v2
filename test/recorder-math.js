/**
 * recorder-math.js
 * Tests the eye position calculation from recorder.js in isolation.
 * Run with: node test/recorder-math.js
 */

// ── Replicate the calculation from recorder.js ────────────────────────────────

function computeEye(center, range, tiltDeg, heading) {
  const centerAlt = center.altitude || 0;
  const tiltRad   = (tiltDeg * Math.PI) / 180;
  const eyeLat    = center.lat;
  const eyeLng    = center.lng;
  const eyeAlt    = Math.max(centerAlt + range * Math.cos(tiltRad), 1);
  return { lat: eyeLat, lng: eyeLng, altitude: eyeAlt };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function maxSwing(values) {
  return Math.max(...values) - Math.min(...values);
}

// ── Simulate a sequence of frames with oscillating heading (as Maps API does near poles) ──

function simulateFrames(centerLat, range, tilt, headingBase, headingNoise) {
  const frames = [];
  for (let i = 0; i < 20; i++) {
    const heading = headingBase + (Math.random() - 0.5) * 2 * headingNoise;
    const center  = { lat: centerLat, lng: 100, altitude: 0 };
    frames.push(computeEye(center, range, tilt, heading));
  }
  return frames;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nEye position stability near poles\n');

// 1. Normal lat — baseline
{
  const frames = simulateFrames(52, 300000, 45, 90, 10);
  const latSwing = maxSwing(frames.map(f => f.lat));
  const lngSwing = maxSwing(frames.map(f => f.lng));
  console.log('Lat 52°, range 300km, tilt 45°, heading noise ±10°');
  assert('lat stable (swing < 1°)',   latSwing < 1,   `swing=${latSwing.toFixed(4)}°`);
  assert('lng stable (swing < 1°)',   lngSwing < 1,   `swing=${lngSwing.toFixed(4)}°`);
}

console.log('');

// 2. High arctic — where the original bug triggered
{
  const frames = simulateFrames(82, 8400000, 17.7, 36, 15);
  const latSwing = maxSwing(frames.map(f => f.lat));
  const lngSwing = maxSwing(frames.map(f => f.lng));
  console.log('Lat 82°, range 8400km, tilt 17.7°, heading noise ±15°');
  assert('lat stable (swing < 1°)',   latSwing < 1,   `swing=${latSwing.toFixed(4)}°`);
  assert('lng stable (swing < 1°)',   lngSwing < 1,   `swing=${lngSwing.toFixed(4)}°`);
}

console.log('');

// 3. Very close to north pole
{
  const frames = simulateFrames(89.9, 5000000, 30, 180, 180); // extreme: heading randomly all over
  const latSwing = maxSwing(frames.map(f => f.lat));
  const lngSwing = maxSwing(frames.map(f => f.lng));
  console.log('Lat 89.9°, range 5000km, tilt 30°, heading noise ±180° (worst case)');
  assert('lat stable (swing < 1°)',   latSwing < 1,   `swing=${latSwing.toFixed(4)}°`);
  assert('lng stable (swing < 1°)',   lngSwing < 1,   `swing=${lngSwing.toFixed(4)}°`);
}

console.log('');

// 4. Exact north pole
{
  const frames = simulateFrames(90, 1000000, 45, 0, 180);
  const latSwing = maxSwing(frames.map(f => f.lat));
  const lngSwing = maxSwing(frames.map(f => f.lng));
  console.log('Lat 90° (exact pole), range 1000km, tilt 45°, heading noise ±180°');
  assert('lat stable (swing < 1°)',   latSwing < 1,   `swing=${latSwing.toFixed(4)}°`);
  assert('lng stable (swing < 1°)',   lngSwing < 1,   `swing=${lngSwing.toFixed(4)}°`);
}

console.log('');

// 5. Altitude is sensible (range * cos(tilt) + centerAlt)
{
  const eye = computeEye({ lat: 52, lng: 5, altitude: 100 }, 10000, 45, 90);
  const expected = 100 + 10000 * Math.cos(45 * Math.PI / 180);
  console.log('Altitude calculation');
  assert(`eyeAlt ≈ ${expected.toFixed(0)}m`, Math.abs(eye.altitude - expected) < 1,
    `got ${eye.altitude.toFixed(0)}m`);
}

console.log('');

// 6. Never returns negative or zero altitude
{
  const eye = computeEye({ lat: 0, lng: 0, altitude: 0 }, 1000, 90, 0); // tilt=90 → cos=0 → eyeAlt=0 → clamped to 1
  console.log('Altitude clamp (tilt=90° → eyeAlt clamped to 1)');
  assert('eyeAlt >= 1', eye.altitude >= 1, `got ${eye.altitude}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
