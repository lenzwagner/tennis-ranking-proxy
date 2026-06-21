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

// ── HTML fetch with reader-proxy fallback ─────────────────────────────────────
// Some sources (e.g. tennisabstract.com) return 403 to datacenter IPs like
// Render's. When a direct request is blocked, retry through Jina's reader
// (r.jina.ai), which fetches the page from a non-blocked IP and—when asked with
// X-Return-Format: html—returns the raw HTML so cheerio parsing still works.
async function fetchHtml(url, { timeout = 20000 } = {}) {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout });
    return res.data;
  } catch (e) {
    const status = e.response?.status;
    if (status !== 403 && status !== 429 && e.code !== 'ECONNABORTED') throw e;
    console.log(`Direct fetch of ${url} blocked (${status || e.code}); retrying via reader proxy`);
    const readerRes = await axios.get(`https://r.jina.ai/${url}`, {
      headers: { ...HEADERS, 'X-Return-Format': 'html' },
      timeout: timeout + 15000,
    });
    return readerRes.data;
  }
}

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

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const results = [];

  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 11) return;
    const c = (i) => $(cells[i]).text().trim().replace(/ /g, '').trim();
    const rank = parseInt(c(0));
    if (isNaN(rank)) return;
    // Keep the name's spaces; the source separates first/last name with a
    // non-breaking space, and c() strips it (gluing "Jannik Sinner" into
    // "JannikSinner"). Pull the raw cell text and collapse whitespace instead.
    const name  = $(cells[1]).text().replace(/\s+/g, ' ').trim();
    // Round to integers: the app's EloPlayerDto expects Int, and Moshi rejects
    // decimals for an Int field.
    const num = (i) => { const v = parseFloat(c(i)); return Number.isFinite(v) ? Math.round(v) : null; };
    const elo   = num(3);
    // hElo=col6, cElo=col8, gElo=col10
    const eloHard  = num(6);
    const eloClay  = num(8);
    const eloGrass = num(10);
    // Field names match the app's EloPlayerDto (eloHard/eloClay/eloGrass).
    results.push({ rank, name, elo, eloHard, eloClay, eloGrass, tour });
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
    // fetchHtml retries through the reader proxy when live-tennis.eu blocks the
    // datacenter IP (Cloudflare 403). The full live ranking (~1000+ players) is
    // on a single page, so no pagination is needed.
    html = await fetchHtml(url, { timeout: 15000 });
  } catch (e) {
    console.log(`live-tennis.eu unreachable (${e.response?.status || e.message}), falling back to official`);
    return scrapeOfficialRankings(tour);
  }
  const results = [];
  const seen = new Set();

  // Parse row-by-row on the raw HTML rather than via cheerio's DOM: the reader
  // proxy returns the table with broken <tr> nesting, so cheerio collapses every
  // row into one giant <tr>. Splitting on <tr> keeps the rows intact.
  // Per row: rank=td.rk, name=td.pn, and points is the <td> right after the
  // country code (a td.sm holding 2-3 letters; the other td.sm is the age).
  const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const rowChunks = html.split(/<tr[\s>]/i);
  for (const chunk of rowChunks) {
    const rankM = chunk.match(/class="rk"[^>]*>\s*(\d+)/i);
    const nameM = chunk.match(/class="pn"[^>]*>([\s\S]*?)<\/td>/i);
    if (!rankM || !nameM) continue;
    const rank = parseInt(rankM[1]);
    const name = stripTags(nameM[1]);
    if (isNaN(rank) || name.length < 2) continue;
    if (seen.has(name)) continue; // the top row is repeated as a sticky header
    seen.add(name);
    const ptsM = chunk.match(/class="sm"[^>]*>\s*[A-Za-z]{2,3}\s*<\/td>\s*<td[^>]*>([\d.,\s]+)<\/td>/i);
    const points = ptsM ? parseInt(ptsM[1].replace(/[.,\s]/g, '')) || 0 : 0;
    // Career high column (class="chtd"). Subclasses:
    //   fch/nch/ich = numeric career best rank
    //   chigh = "HP" (current rank IS career best)
    //   nwch  = "NHP" (new career best, same meaning as HP)
    const chHighM = chunk.match(/class="chtd"[^>]*>\s*<b[^>]*>(\d+)<\/b>/i);
    const chHighHP = /class="chtd"[^>]*>\s*<b[^>]*>[NH]*HP[^<]*<\/b>/i.test(chunk);
    const careerHighRank = chHighM ? parseInt(chHighM[1]) : (chHighHP ? rank : null);
    results.push({ rank, name, points, tour, type: 'live', careerHighRank });
  }

  // If live-tennis.eu was blocked (Cloudflare), fall back to official
  if (results.length === 0) {
    console.log(`live-tennis.eu returned no rows for ${tour}, falling back to official rankings`);
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

// H2H lookup
// GET /api/h2h?p1=Taylor+Fritz&p2=Frances+Tiafoe&date=2026-06-20&tour=atp
const h2hCache = new Map();
const H2H_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24h

function lastNameOf(fullName) {
  // "Taylor Fritz" → "Fritz", "Stefanos Tsitsipas" → "Tsitsipas"
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

async function findMatchDetailId(p1LastName, p2LastName, dateStr, tourType) {
  // Try the given date and adjacent days (handles scheduled/upcoming matches)
  const type = tourType.toLowerCase() === 'wta' ? 'wta-women' : 'atp-men';
  const baseDate = new Date(dateStr + 'T12:00:00Z');

  for (const dayOffset of [0, -1, 1]) {
    const d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();

    for (const pageType of ['results', 'schedule']) {
      const url = `https://www.tennisexplorer.com/${pageType}/?type=${type}&year=${year}&month=${month}&day=${day}`;
      let html;
      try { html = await fetchHtml(url); } catch { continue; }
      const $ = cheerio.load(html);

      // Search main match table (finished/in-progress)
      for (const primaryRow of $('tr.fRow').toArray()) {
        const row1 = $(primaryRow);
        const rowId = row1.attr('id');
        const row2 = rowId ? $(`#${rowId}b`) : $();
        const name1 = row1.find('td.t-name a').first().text().trim().toLowerCase();
        const name2 = row2.find('td.t-name a').first().text().trim().toLowerCase();
        if ([name1, name2].some(n => n.startsWith(p1LastName)) &&
            [name1, name2].some(n => n.startsWith(p2LastName))) {
          const link = row1.find('a[href*="match-detail"]').attr('href')
            || row2.find('a[href*="match-detail"]').attr('href');
          const m = link?.match(/id=(\d+)/);
          if (m) return m[1];
        }
      }

      // Search "interesting matches" sidebar (includes scheduled matches)
      let sidebarId = null;
      $('td.game a[href*="match-detail"]').each((_, el) => {
        if (sidebarId) return;
        const text = $(el).text().toLowerCase();
        if (text.includes(p1LastName) && text.includes(p2LastName)) {
          const m = $(el).attr('href')?.match(/id=(\d+)/);
          if (m) sidebarId = m[1];
        }
      });
      if (sidebarId) return sidebarId;
    }
  }
  return null;
}

async function scrapeH2H(matchId) {
  const url = `https://www.tennisexplorer.com/match-detail/?id=${matchId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Overall H2H score from heading: "Head-to-head: 7 - 2"
  const headingText = $('h2.bg').filter((_, el) => $(el).text().includes('Head-to-head')).first().text();
  const overallMatch = headingText.match(/Head-to-head:\s*(\d+)\s*-\s*(\d+)/i);
  const overallP1 = overallMatch ? parseInt(overallMatch[1]) : 0;
  const overallP2 = overallMatch ? parseInt(overallMatch[2]) : 0;

  // Find the H2H table by its heading
  const h2hHeading = $('h2.bg').filter((_, el) => $(el).text().includes('Head-to-head')).first();
  const h2hTable = h2hHeading.next().find('table.result').first();

  let p1Name = null, p2Name = null;
  const matches = [];

  const tbodyRows = h2hTable.find('tbody tr').toArray();
  let i = 0;
  while (i < tbodyRows.length) {
    const row1 = $(tbodyRows[i]);
    const row2 = tbodyRows[i + 1] ? $(tbodyRows[i + 1]) : null;

    const year = row1.find('td.annual').text().trim() || '';
    const tournament = row1.find('td.tl a').text().trim() || '';
    const surface = row1.find('td.sColorLong span').attr('title') || '';
    const round = row1.find('td.round').text().trim() || '';

    const player1Name = row1.find('td.t-name').text().trim();
    const player1Sets = parseInt(row1.find('td.result').text().trim()) || 0;
    const p1Scores = row1.find('td.score').map((_, s) => $(s).text().trim().replace(/\D+/g, '') || null).toArray().filter(Boolean);

    const player2Name = row2 ? row2.find('td.t-name').text().trim() : '';
    const player2Sets = row2 ? parseInt(row2.find('td.result').text().trim()) || 0 : 0;
    const p2Scores = row2 ? row2.find('td.score').map((_, s) => $(s).text().trim().replace(/\D+/g, '') || null).toArray().filter(Boolean) : [];

    if (!p1Name && player1Name) p1Name = player1Name;
    if (!p2Name && player2Name) p2Name = player2Name;

    if (year || tournament) {
      matches.push({
        year: year || null,
        tournament,
        surface,
        round,
        winner: player1Sets > player2Sets ? 'p1' : 'p2',
        player1: { name: player1Name, sets: player1Sets, scores: p1Scores },
        player2: { name: player2Name, sets: player2Sets, scores: p2Scores },
      });
    }
    i += 2;
  }

  return {
    overall: { p1: overallP1, p2: overallP2 },
    player1: p1Name,
    player2: p2Name,
    matches,
  };
}

app.get('/api/h2h', async (req, res) => {
  try {
    const { p1, p2, date, tour } = req.query;
    if (!p1 || !p2 || !date) {
      return res.status(400).json({ success: false, error: 'p1, p2, date required' });
    }
    const cacheKey = `h2h:${p1}:${p2}:${date}`;
    const cached = h2hCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < H2H_CACHE_DURATION) {
      return res.json({ success: true, data: cached.data });
    }

    const p1Last = lastNameOf(p1);
    const p2Last = lastNameOf(p2);
    const matchId = await findMatchDetailId(p1Last, p2Last, date, tour || 'atp');
    if (!matchId) {
      return res.status(404).json({ success: false, error: `Match not found for ${p1} vs ${p2} on ${date}` });
    }

    const data = await scrapeH2H(matchId);
    h2hCache.set(cacheKey, { ts: Date.now(), data });
    res.json({ success: true, data });
  } catch (e) {
    console.error('H2H error:', e.message);
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
  console.log('  GET /api/h2h?p1=Taylor+Fritz&p2=Frances+Tiafoe&date=2026-06-20&tour=atp');
});
