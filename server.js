const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

async function scrapeRankings(tour) {
  const url = tour === 'ATP'
    ? 'https://www.tennisexplorer.com/ranking/atp-men/'
    : 'https://www.tennisexplorer.com/ranking/wta-women/';

  const res = await axios.get(url, { headers: HEADERS });
  const html = res.data;
  const $ = cheerio.load(html);

  const results = [];
  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;

    const rankText = $(cells[0]).text().trim().replace('.', '');
    const rank = parseInt(rankText);
    if (isNaN(rank)) return;

    const rawName = $(cells[2]).text().trim();
    // Format: "Sinner Jannik" → "Jannik Sinner"
    const parts = rawName.split(' ').filter(Boolean);
    const name = parts.length >= 2 ? [...parts.slice(1), parts[0]].join(' ') : rawName;

    const pointsText = $(cells[4]).text().trim().replace(/[.,\s]/g, '');
    const points = parseInt(pointsText) || 0;

    results.push({ rank, name, points, tour });
  });

  return results;
}

function cached(key, fn) {
  return async (req, res) => {
    try {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.timestamp < CACHE_DURATION) {
        return res.json({ success: true, data: hit.data, cached: true });
      }
      const data = await fn();
      cache.set(key, { data, timestamp: Date.now() });
      res.json({ success: true, data, cached: false, scrapedAt: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  };
}

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/rankings/atp', cached('atp', () => scrapeRankings('ATP')));
app.get('/api/rankings/wta', cached('wta', () => scrapeRankings('WTA')));

app.get('/api/player/:tour/:name', async (req, res) => {
  try {
    const { tour, name } = req.params;
    const rankings = await scrapeRankings(tour.toUpperCase());
    const search = decodeURIComponent(name).toLowerCase();
    const player = rankings.find(r => r.name.toLowerCase().includes(search));
    if (!player) return res.status(404).json({ success: false, error: `${name} not found` });
    res.json({ success: true, data: player });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tennis Ranking Proxy on port ${PORT}`));
