let issCache = null;
let issCacheTime = 0;

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

    // List all UGO gists
    if (url.pathname === '/gists') {
      const res   = await fetch('https://api.github.com/gists?per_page=100', {
        headers: { 'Authorization': 'Bearer ' + env.usergeneratedorbitbot, 'User-Agent': 'ugo-bot' },
      });
      const gists = await res.json();
      const ugoGists = gists
        .filter(g => Object.keys(g.files).some(f => f.startsWith('ugo-') && f.endsWith('.kml')))
        .map(g => {
          const filename = Object.keys(g.files).find(f => f.startsWith('ugo-') && f.endsWith('.kml'));
          return { id: g.id, filename, rawUrl: g.files[filename].raw_url, description: g.description, createdAt: g.created_at };
        });
      return new Response(JSON.stringify(ugoGists), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Find Gist by UGO ID (filename search)
    if (url.pathname === '/gist-by-ugo') {
      const ugoId = url.searchParams.get('id');
      if (!ugoId) return new Response('Missing id', { status: 400, headers: corsHeaders });

      let page = 1;
      while (true) {
        const res  = await fetch(`https://api.github.com/gists?per_page=100&page=${page}`, {
          headers: { 'Authorization': 'Bearer ' + env.usergeneratedorbitbot, 'User-Agent': 'ugo-bot' },
        });
        const gists = await res.json();
        if (!gists.length) break;

        const match = gists.find(g => Object.keys(g.files).some(f => f.includes(ugoId)));
        if (match) {
          const file   = Object.values(match.files)[0];
          const raw    = await fetch(file.raw_url);
          const kml    = await raw.text();
          return new Response(kml, { headers: { ...corsHeaders, 'Content-Type': 'text/xml' } });
        }
        if (gists.length < 100) break;
        page++;
      }
      return new Response('UGO not found', { status: 404, headers: corsHeaders });
    }

    // Reverse geocode with KV cache
    if (url.pathname === '/geocode') {
      const gistId   = url.searchParams.get('gistId');
      const startLat = url.searchParams.get('startLat');
      const startLng = url.searchParams.get('startLng');
      const endLat   = url.searchParams.get('endLat');
      const endLng   = url.searchParams.get('endLng');
      if (!gistId || !startLat || !startLng) return new Response('Missing params', { status: 400, headers: corsHeaders });

      const cached = await env.GEO_CACHE.get(gistId);
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

      await env.GEO_CACHE.put(gistId, label);
      return new Response(label, { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } });
    }

    // Gist description update (toggle [hidden] tag)
    if (request.method === 'PATCH' && url.pathname === '/gist') {
      if (request.headers.get('X-Edit-Key') !== env.UGO_EDIT_KEY) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }
      const { id, description } = await request.json();
      if (!id) return new Response('Missing id', { status: 400, headers: corsHeaders });
      const resp = await fetch(`https://api.github.com/gists/${id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + env.usergeneratedorbitbot,
          'Content-Type': 'application/json',
          'User-Agent': 'ugo-bot',
        },
        body: JSON.stringify({ description }),
      });
      return new Response(resp.body, { status: resp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Gist save
    const { filename, content, description } = await request.json();

    const resp = await fetch('https://api.github.com/gists', {
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

    return new Response(resp.body, {
      status: resp.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};
