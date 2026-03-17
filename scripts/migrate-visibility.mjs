/**
 * migrate-visibility.mjs
 * Builds visibility.json in ugo-gallery R2 from gist descriptions.
 * Any UGO whose gist description contains [hidden] is marked hidden.
 *
 * Usage: node scripts/migrate-visibility.mjs
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const WORKER = 'https://usergeneratedorbitbot.navarenko.workers.dev';

console.log('Fetching gist list…');
const res   = await fetch(`${WORKER}/gists`);
const gists = await res.json();

const hidden = [];
for (const gist of gists) {
  if ((gist.description || '').includes('[hidden]')) {
    const m = gist.filename.match(/ugo-([0-9a-f-]{36})\.kml/i);
    if (m) hidden.push(m[1].replace(/-/g, ''));
  }
}

console.log(`Found ${hidden.length} hidden UGOs out of ${gists.length}`);

const visibility = { hidden };
const tmpFile = join(tmpdir(), 'visibility.json');
writeFileSync(tmpFile, JSON.stringify(visibility));

execSync(`wrangler r2 object put --remote ugo-gallery/visibility.json --file="${tmpFile}" --content-type="application/json"`, { stdio: 'inherit' });
unlinkSync(tmpFile);

console.log('Done. visibility.json written to ugo-gallery.');
