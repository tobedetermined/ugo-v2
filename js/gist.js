/**
 * gist.js — saves UGO data via the Cloudflare Worker proxy.
 * The Worker holds the GitHub token; it never appears in source.
 * For local dev, set window.UGO_WORKER_URL in telemetry-config.js
 * to point at your local wrangler dev URL.
 */

const WORKER_URL = window.UGO_WORKER_URL || 'https://usergeneratedorbitbot.navarenko.workers.dev';

async function createGist(filename, content, description) {
  try {
    await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content, description }),
    });
  } catch (e) {
    // Silently fail — never disrupt the user experience
  }
}
