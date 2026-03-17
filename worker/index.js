let issCache = null;
let issCacheTime = 0;

// Parse downsampled path data from KML text
function parsePathFromKml(kmlText) {
  const m = kmlText.match(/<value><!\[CDATA\[([\s\S]*?)\]\]><\/value>/);
  if (!m) return null;
  const rec = JSON.parse(m[1].trim());
  const allFrames = rec.segments.flat();
  const path = rec.segments.map(seg => {
    const step = Math.max(1, Math.floor(seg.length / 100));
    const pts = [];
    for (let i = 0; i < seg.length; i += step) {
      pts.push({ lat: +seg[i].eye.lat.toFixed(5), lng: +seg[i].eye.lng.toFixed(5) });
    }
    const last = seg[seg.length - 1];
    if (pts[pts.length - 1].lat !== +last.eye.lat.toFixed(5)) {
      pts.push({ lat: +last.eye.lat.toFixed(5), lng: +last.eye.lng.toFixed(5) });
    }
    return pts;
  });
  return {
    path,
    metadata: {
      boundingBox:     rec.metadata.boundingBox,
      totalDurationMs: rec.metadata.totalDurationMs,
      distance:        rec.metadata.distance   || null,
      motionType:      rec.metadata.motionType || 'manual',
    },
    firstFrame: { lat: allFrames[0].eye.lat,                    lng: allFrames[0].eye.lng },
    lastFrame:  { lat: allFrames[allFrames.length - 1].eye.lat, lng: allFrames[allFrames.length - 1].eye.lng },
  };
}

// Build card list from ugo-paths R2 bucket
async function buildCards(env, includeHidden = false) {
  const visObj = await env.UGO_GALLERY.get('visibility.json');
  const visibility = visObj ? await visObj.json() : { hidden: [] };
  const hiddenSet = new Set(visibility.hidden);

  const listed = await env.UGO_PATHS.list();
  const cards = await Promise.all(
    listed.objects.map(async obj => {
      const ugoId = obj.key.replace('.path.json', '');
      if (!includeHidden && hiddenSet.has(ugoId)) return null;
      const pathObj = await env.UGO_PATHS.get(obj.key);
      if (!pathObj) return null;
      const data = await pathObj.json();
      return { ugoId, hidden: hiddenSet.has(ugoId), ...data };
    })
  );
  return cards
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ISS position — cached for 1 second
    if (url.pathname === '/iss') {
      const now = Date.now();
      if (!issCache || now - issCacheTime > 800) {
        const res = await fetch('https://api.wheretheiss.at/v1/satellites/25544');
        issCache = await res.text();
        issCacheTime = now;
      }
      return new Response(issCache, {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // List all UGO gists (paginated) — used by migration scripts
    if (url.pathname === '/gists') {
      const allGists = [];
      let page = 1;
      while (true) {
        const res   = await fetch(`https://api.github.com/gists?per_page=100&page=${page}`, {
          headers: { 'Authorization': 'Bearer ' + env.usergeneratedorbitbot, 'User-Agent': 'ugo-bot' },
        });
        const batch = await res.json();
        if (!Array.isArray(batch) || !batch.length) break;
        const ugoGists = batch
          .filter(g => Object.keys(g.files).some(f => f.startsWith('ugo-') && f.endsWith('.kml')))
          .map(g => {
            const filename = Object.keys(g.files).find(f => f.startsWith('ugo-') && f.endsWith('.kml'));
            return { id: g.id, filename, rawUrl: g.files[filename].raw_url, description: g.description, createdAt: g.created_at };
          });
        allGists.push(...ugoGists);
        if (batch.length < 100) break;
        page++;
      }
      return new Response(JSON.stringify(allGists), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Gallery card list — served from R2
    if (url.pathname === '/gists/cards') {
      const isAuth = request.headers.get('X-Edit-Key') === env.UGO_EDIT_KEY;
      const wantsRebuild = url.searchParams.get('rebuild') === '1';

      // Unauthenticated — serve card-list-gallery.json from R2; build on miss
      if (!isAuth) {
        const cached = await env.UGO_GALLERY.get('card-list-gallery.json');
        if (cached) {
          return new Response(cached.body, {
            headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' },
          });
        }
        const cards = await buildCards(env, false);
        const body = JSON.stringify(cards);
        await env.UGO_GALLERY.put('card-list-gallery.json', body, { httpMetadata: { contentType: 'application/json' } });
        return new Response(body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' },
        });
      }

      // Authenticated + rebuild — build public list, store to R2, return it
      if (wantsRebuild) {
        const cards = await buildCards(env, false);
        const body = JSON.stringify(cards);
        await env.UGO_GALLERY.put('card-list-gallery.json', body, { httpMetadata: { contentType: 'application/json' } });
        return new Response(body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }

      // Authenticated, no rebuild — return all cards including hidden
      const cards = await buildCards(env, true);
      return new Response(JSON.stringify(cards), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // Fetch KML by UGO ID — reads from R2, falls back to GitHub for legacy gist IDs
    if (url.pathname === '/gist-by-ugo') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('Missing id', { status: 400, headers: corsHeaders });

      // Try R2 first (fast path)
      const obj = await env.UGO_RECORDINGS.get(`${id}.kml`);
      if (obj) return new Response(obj.body, { headers: { ...corsHeaders, 'Content-Type': 'text/xml' } });

      // Fall back to GitHub gist search (legacy gist ID URLs)
      let page = 1;
      while (true) {
        const res   = await fetch(`https://api.github.com/gists?per_page=100&page=${page}`, {
          headers: { 'Authorization': 'Bearer ' + env.usergeneratedorbitbot, 'User-Agent': 'ugo-bot' },
        });
        const gists = await res.json();
        if (!gists.length) break;
        const match = gists.find(g => Object.keys(g.files).some(f => f.includes(id)));
        if (match) {
          const file = Object.values(match.files)[0];
          const raw  = await fetch(file.raw_url);
          const kml  = await raw.text();
          return new Response(kml, { headers: { ...corsHeaders, 'Content-Type': 'text/xml' } });
        }
        if (gists.length < 100) break;
        page++;
      }
      return new Response('UGO not found', { status: 404, headers: corsHeaders });
    }

    // Reverse geocode — cached in UGO_GEOCODES KV, keyed by ugoId
    if (url.pathname === '/geocode') {
      const ugoId   = url.searchParams.get('ugoId');
      const startLat = url.searchParams.get('startLat');
      const startLng = url.searchParams.get('startLng');
      const endLat   = url.searchParams.get('endLat');
      const endLng   = url.searchParams.get('endLng');
      if (!ugoId || !startLat || !startLng) return new Response('Missing params', { status: 400, headers: corsHeaders });

      const cached = await env.UGO_GEOCODES.get(ugoId);
      if (cached && cached !== '—' && !cached.includes('County')) return new Response(cached, { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } });

      async function geocodeName(lat, lng) {
        const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
          headers: { 'Accept-Language': 'en', 'User-Agent': 'usergeneratedorbit.com' },
        });
        const data = await res.json();
        const addr = data.address || {};
        const name = addr.city || addr.town || addr.village;
        const cc   = addr.country_code ? addr.country_code.toUpperCase() : '';
        if (!name && !cc) return null;
        return name ? (cc ? `${name}, ${cc}` : name) : `somewhere, ${cc}`;
      }

      const startName = await geocodeName(startLat, startLng);
      const endName   = endLat && endLng ? await geocodeName(endLat, endLng) : null;

      const start = startName || 'somewhere';
      const end   = endName   || 'somewhere';

      let label;
      if (!startName && !endName) {
        label = 'User Generated Orbit';
      } else if (start === end) {
        label = start;
      } else {
        label = `${start} → ${end}`;
      }

      await env.UGO_GEOCODES.put(ugoId, label);
      return new Response(label, { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } });
    }

    // Visibility toggle — updates visibility.json in ugo-gallery R2
    if (request.method === 'PATCH' && url.pathname === '/ugo') {
      if (request.headers.get('X-Edit-Key') !== env.UGO_EDIT_KEY) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }
      const { ugoId, hidden } = await request.json();
      if (!ugoId) return new Response('Missing ugoId', { status: 400, headers: corsHeaders });

      const visObj = await env.UGO_GALLERY.get('visibility.json');
      const visibility = visObj ? await visObj.json() : { hidden: [] };
      const hiddenSet = new Set(visibility.hidden);
      if (hidden) hiddenSet.add(ugoId);
      else hiddenSet.delete(ugoId);
      visibility.hidden = [...hiddenSet];

      await env.UGO_GALLERY.put('visibility.json', JSON.stringify(visibility), {
        httpMetadata: { contentType: 'application/json' },
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Save new recording — writes to R2 and GitHub gist
    const { filename, content, description } = await request.json();

    // Save to GitHub gist (backup)
    const gistResp = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.usergeneratedorbitbot,
        'Content-Type': 'application/json',
        'User-Agent': 'ugo-bot',
      },
      body: JSON.stringify({
        description: description || '',
        public: false,
        files: { [filename]: { content } },
      }),
    });
    const gist = await gistResp.json();

    // Write to R2
    const ugoMatch = filename.match(/ugo-([0-9a-f-]{36})\.kml/i);
    if (ugoMatch) {
      const ugoId = ugoMatch[1].replace(/-/g, '');
      const pathData = parsePathFromKml(content);
      if (pathData) {
        await env.UGO_RECORDINGS.put(`${ugoId}.kml`, content, {
          httpMetadata: { contentType: 'application/vnd.google-earth.kml+xml' },
        });
        await env.UGO_PATHS.put(`${ugoId}.path.json`, JSON.stringify({
          ...pathData,
          gistId:      gist.id || null,
          filename,
          description: description || '',
          createdAt:   new Date().toISOString(),
        }), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify(gist), {
      status: gistResp.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};
