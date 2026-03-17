/**
 * migrate-geocodes.mjs
 * Copies geocode labels from GEO_CACHE KV (keyed by gist ID)
 * to UGO_GEOCODES KV (keyed by UGO ID = UUID with hyphens stripped).
 *
 * Usage: node scripts/migrate-geocodes.mjs
 */

import { execSync } from 'child_process';

const WORKER       = 'https://usergeneratedorbitbot.navarenko.workers.dev';
const KV_SRC       = 'acec3fb951ea461aa681057470f54120';  // GEO_CACHE
const KV_DST       = '26fac0f17d5f4006a4fd01aafbaf97be';  // UGO_GEOCODES

// ── Build gistId → ugoId map from worker ─────────────────────────────────────
console.log('Fetching gist list…');
const res   = await fetch(`${WORKER}/gists`);
const gists = await res.json();
const gistToUgo = Object.fromEntries(
  gists.map(g => {
    const m = g.filename.match(/ugo-([0-9a-f-]{36})\.kml/i);
    const ugoId = m ? m[1].replace(/-/g, '') : null;
    return [g.id, ugoId];
  }).filter(([, v]) => v)
);
console.log(`Mapped ${Object.keys(gistToUgo).length} gists\n`);

// ── List all keys in GEO_CACHE ────────────────────────────────────────────────
console.log('Listing GEO_CACHE keys…');
const listOut = execSync(`wrangler kv key list --remote --namespace-id ${KV_SRC}`, { encoding: 'utf8' });
const keys = JSON.parse(listOut).map(k => k.name);
console.log(`Found ${keys.length} keys\n`);

// ── Migrate geocode entries ───────────────────────────────────────────────────
let ok = 0, skipped = 0, failed = 0;

for (const key of keys) {
  // Only migrate keys that look like gist IDs (32 hex chars)
  if (!/^[0-9a-f]{32}$/.test(key)) {
    console.log(`  SKIP  ${key} — not a gist ID`);
    skipped++;
    continue;
  }

  const ugoId = gistToUgo[key];
  if (!ugoId) {
    console.log(`  SKIP  ${key} — no matching UGO`);
    skipped++;
    continue;
  }

  process.stdout.write(`  ${key} → ${ugoId}  `);

  try {
    const value = execSync(`wrangler kv key get --remote --namespace-id ${KV_SRC} "${key}"`, { encoding: 'utf8' }).trim();
    execSync(`wrangler kv key put --remote --namespace-id ${KV_DST} "${ugoId}" "${value}"`, { stdio: 'pipe' });
    console.log(`OK  (${value})`);
    ok++;
  } catch (e) {
    console.log(`FAILED — ${e.message.split('\n')[0]}`);
    failed++;
  }
}

console.log(`\nDone. ${ok} migrated, ${skipped} skipped, ${failed} failed.`);
