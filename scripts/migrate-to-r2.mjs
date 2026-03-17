/**
 * migrate-to-r2.mjs
 * Migrates all existing UGO recordings from GitHub Gists to R2.
 * For each gist: uploads <ugo-id>.kml and <ugo-id>.path.json
 * UGO ID = UUID from filename with hyphens stripped.
 *
 * Skips entries already present in R2 (idempotent).
 * Fetches all pages from GitHub directly (no 100-gist cap).
 *
 * Usage: node scripts/migrate-to-r2.mjs
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const WORKER            = 'https://usergeneratedorbitbot.navarenko.workers.dev';
const BUCKET_RECORDINGS = 'ugo-recordings';
const BUCKET_PATHS      = 'ugo-paths';

// ── Fetch all UGO gists from worker (paginated) ───────────────────────────────
console.log('Fetching gist list…');
const res      = await fetch(`${WORKER}/gists`);
const allGists = await res.json();
console.log(`Found ${allGists.length} UGO gists\n`);

// ── Build set of already-uploaded IDs ─────────────────────────────────────────
console.log('Checking existing R2 entries…');
let existingIds = new Set();
try {
  const out = execSync(`wrangler r2 object list --remote ${BUCKET_RECORDINGS} 2>/dev/null`, { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const m = line.match(/([0-9a-f]{32})\.kml/);
    if (m) existingIds.add(m[1]);
  }
} catch (_) { /* list may not be available in all wrangler versions — skip */ }
console.log(`${existingIds.size} already in R2, skipping those\n`);

// ── Process each gist ─────────────────────────────────────────────────────────
let ok = 0, skipped = 0, failed = 0;

for (const gist of allGists) {
  const match = gist.filename.match(/ugo-([0-9a-f-]{36})\.kml/i);
  if (!match) { console.warn(`  SKIP  ${gist.filename} — no UUID found`); skipped++; continue; }

  const ugoId = match[1].replace(/-/g, '');
  const kmlKey  = `${ugoId}.kml`;
  const pathKey = `${ugoId}.path.json`;

  if (existingIds.has(ugoId)) {
    console.log(`  ${ugoId}  already uploaded, skipping`);
    skipped++;
    continue;
  }

  process.stdout.write(`  ${ugoId}  `);

  try {
    const kmlRes  = await fetch(gist.rawUrl);
    const kmlText = await kmlRes.text();

    const m = kmlText.match(/<value><!\[CDATA\[([\s\S]*?)\]\]><\/value>/);
    if (!m) { console.log('SKIP — no CDATA'); skipped++; continue; }
    const rec       = JSON.parse(m[1].trim());
    const allFrames = rec.segments.flat();

    const path = rec.segments.map(seg => {
      const step = Math.max(1, Math.floor(seg.length / 100));
      const pts  = [];
      for (let i = 0; i < seg.length; i += step) {
        pts.push({ lat: +seg[i].eye.lat.toFixed(5), lng: +seg[i].eye.lng.toFixed(5) });
      }
      const last = seg[seg.length - 1];
      if (pts[pts.length - 1].lat !== +last.eye.lat.toFixed(5)) {
        pts.push({ lat: +last.eye.lat.toFixed(5), lng: +last.eye.lng.toFixed(5) });
      }
      return pts;
    });

    const pathData = {
      path,
      metadata: {
        boundingBox:     rec.metadata.boundingBox,
        totalDurationMs: rec.metadata.totalDurationMs,
        distance:        rec.metadata.distance   || null,
        motionType:      rec.metadata.motionType || 'manual',
      },
      firstFrame: { lat: allFrames[0].eye.lat,                    lng: allFrames[0].eye.lng },
      lastFrame:  { lat: allFrames[allFrames.length - 1].eye.lat, lng: allFrames[allFrames.length - 1].eye.lng },
      gistId:     gist.id,
      filename:   gist.filename,
      description: gist.description,
      createdAt:  gist.createdAt,
    };

    const tmpKml  = join(tmpdir(), kmlKey);
    const tmpPath = join(tmpdir(), pathKey);

    writeFileSync(tmpKml,  kmlText);
    writeFileSync(tmpPath, JSON.stringify(pathData));

    const r2put = (cmd) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try { execSync(cmd, { stdio: 'pipe' }); return; } catch (e) {
          if (attempt === 5) throw e;
          process.stdout.write(`(retry ${attempt}) `);
        }
      }
    };
    r2put(`wrangler r2 object put --remote ${BUCKET_RECORDINGS}/${kmlKey}  --file="${tmpKml}"  --content-type="application/vnd.google-earth.kml+xml"`);
    r2put(`wrangler r2 object put --remote ${BUCKET_PATHS}/${pathKey} --file="${tmpPath}" --content-type="application/json"`);

    unlinkSync(tmpKml);
    unlinkSync(tmpPath);

    console.log('OK');
    ok++;
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    failed++;
  }
}

console.log(`\nDone. ${ok} uploaded, ${skipped} skipped, ${failed} failed.`);
