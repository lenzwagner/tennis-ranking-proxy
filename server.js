const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_DURATION_OFFICIAL = 6 * 60 * 60 * 1000;  // 6h for official rankings
const CACHE_DURATION_LIVE     = 60 * 60 * 1000;       // 1h for live rankings

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

// ── Official Rankings (tennisexplorer.com) ────────────────────────────────────

async function scrapeOfficialRankings(tour) {
  const url = tour === 'ATP'
    ? 'https://www.tennisexplorer.com/ranking/atp-men/'
    : 'https://www.tennisexplorer.com/ranking/wta-women/';

  const res = await axios.get(url, { headers: HEADERS });
  const $ = cheerio.load(res.data);
  const results = [];

  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;
    const rank = parseInt($(cells[0]).text().trim().replace('.', ''));
    if (isNaN(rank)) return;
    const rawName = $(cells[2]).text().trim();
    const parts = rawName.split(' ').filter(Boolean);
    const name = parts.length >= 2 ? [...parts.slice(1), parts[0]].join(' ') : rawName;
    const points = parseInt($(cells[4]).text().trim().replace(/[.,\s]/g, '')) || 0;
    results.push({ rank, name, points, tour, type: 'official' });
  });

  return results;
}

// ── ELO Ratings (tennisabstract.com) ─────────────────────────────────────────

async function scrapeElo(tour) {
  const url = tour === 'ATP'
    ? 'https://tennisabstract.com/reports/atp_elo_ratings.html'
    : 'https://tennisabstract.com/reports/wta_elo_ratings.html';

  const res = await axios.get(url, { headers: HEADERS });
  const $ = cheerio.load(res.data);
  const results = [];

  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 11) return;
    const c = (i) => $(cells[i]).text().trim().replace(/ /g, '').trim();
    const rank = parseInt(c(0));
    if (isNaN(rank)) return;
    const name  = c(1).replace(/ /g, ' ').trim();
    const elo   = parseFloat(c(3)) || null;
    // hElo=col6, cElo=col8, gElo=col10
    const hElo  = parseFloat(c(6)) || null;
    const cElo  = parseFloat(c(8)) || null;
    const gElo  = parseFloat(c(10)) || null;
    results.push({ rank, name, elo, hElo, cElo, gElo, tour });
  });

  return results;
}

// ── Live Rankings (live-tennis.eu) ────────────────────────────────────────────

async function scrapeLiveRankings(tour) {
  const url = tour === 'ATP'
    ? 'https://live-tennis.eu/de/atp-weltrangliste-live'
    : 'https://live-tennis.eu/de/wta-weltrangliste-live';

  let html;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    html = res.data;
  } catch (e) {
    console.log(`live-tennis.eu blocked (${e.response?.status}), falling back to official`);
    return scrapeOfficialRankings(tour);
  }
  const $ = cheerio.load(html);
  const results = [];

  // live-tennis.eu table structure
  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const rank = parseInt($(cells[0]).text().trim());
    if (isNaN(rank)) return;
    const name = $(cells[1]).text().trim();
    const points = parseInt($(cells[2]).text().trim().replace(/[.,\s]/g, '')) || 0;
    if (name.length > 1) results.push({ rank, name, points, tour, type: 'live' });
  });

  // If live-tennis.eu was blocked (Cloudflare), fall back to official
  if (results.length === 0) {
    console.log(`live-tennis.eu blocked for ${tour}, falling back to official rankings`);
    return scrapeOfficialRankings(tour);
  }

  return results;
}

// ── Cache helper ──────────────────────────────────────────────────────────────

function cached(key, ttl, fn) {
  return async (req, res) => {
    try {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.timestamp < ttl) {
        return res.json({ success: true, data: hit.data, cached: true, cachedAt: new Date(hit.timestamp).toISOString() });
      }
      const data = await fn();
      cache.set(key, { data, timestamp: Date.now() });
      res.json({ success: true, data, cached: false, scrapedAt: new Date().toISOString() });
    } catch (e) {
      console.error(`Error for ${key}:`, e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

const CACHE_DURATION_ELO = 7 * 24 * 60 * 60 * 1000; // 1 week

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Official rankings
app.get('/api/rankings/atp',      cached('atp',      CACHE_DURATION_OFFICIAL, () => scrapeOfficialRankings('ATP')));
app.get('/api/rankings/wta',      cached('wta',      CACHE_DURATION_OFFICIAL, () => scrapeOfficialRankings('WTA')));

// Live rankings
app.get('/api/rankings/atp/live', cached('atp-live', CACHE_DURATION_LIVE,     () => scrapeLiveRankings('ATP')));
app.get('/api/rankings/wta/live', cached('wta-live', CACHE_DURATION_LIVE,     () => scrapeLiveRankings('WTA')));

// ELO ratings (weekly cache)
app.get('/api/elo/atp',           cached('elo-atp',  CACHE_DURATION_ELO,      () => scrapeElo('ATP')));
app.get('/api/elo/wta',           cached('elo-wta',  CACHE_DURATION_ELO,      () => scrapeElo('WTA')));

// Player lookup
app.get('/api/player/:tour/:name', async (req, res) => {
  try {
    const { tour, name } = req.params;
    const live = req.query.live === 'true';
    const rankings = live
      ? await scrapeLiveRankings(tour.toUpperCase())
      : await scrapeOfficialRankings(tour.toUpperCase());
    const search = decodeURIComponent(name).toLowerCase();
    const player = rankings.find(r => r.name.toLowerCase().includes(search));
    if (!player) return res.status(404).json({ success: false, error: `${name} not found` });
    res.json({ success: true, data: player });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Sync all: rankings + ELO in one call (for the "Jetzt synchronisieren" button)
app.get('/api/sync/all', async (req, res) => {
  try {
    const [atpOfficial, wtaOfficial, atpLive, wtaLive, atpElo, wtaElo] = await Promise.allSettled([
      scrapeOfficialRankings('ATP'),
      scrapeOfficialRankings('WTA'),
      scrapeLiveRankings('ATP'),
      scrapeLiveRankings('WTA'),
      scrapeElo('ATP'),
      scrapeElo('WTA'),
    ]);
    res.json({
      success: true,
      scrapedAt: new Date().toISOString(),
      atp:     atpOfficial.status === 'fulfilled' ? atpOfficial.value : [],
      wta:     wtaOfficial.status === 'fulfilled' ? wtaOfficial.value : [],
      atpLive: atpLive.status === 'fulfilled'     ? atpLive.value     : [],
      wtaLive: wtaLive.status === 'fulfilled'     ? wtaLive.value     : [],
      atpElo:  atpElo.status  === 'fulfilled'     ? atpElo.value      : [],
      wtaElo:  wtaElo.status  === 'fulfilled'     ? wtaElo.value      : [],
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tennis Ranking Proxy on port ${PORT}`);
  console.log('  GET /api/rankings/atp');
  console.log('  GET /api/rankings/wta');
  console.log('  GET /api/rankings/atp/live');
  console.log('  GET /api/rankings/wta/live');
  console.log('  GET /api/player/atp/Zverev');
  console.log('  GET /api/sync/all');
});
