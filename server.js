/**
 * Tennis Ranking Proxy Server
 * Scrapes live-tennis.eu rankings and provides JSON API
 * Deploy on: Vercel, Railway, Replit, or Heroku
 *
 * Usage:
 * GET /api/rankings/atp → ATP Rankings (top 100)
 * GET /api/rankings/wta → WTA Rankings (top 100)
 * GET /api/player/wta/Eva%20Lys → Specific player WTA ranking
 */

const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Cache results for 12 hours
const cache = new Map();
const CACHE_DURATION = 12 * 60 * 60 * 1000;

/**
 * Scrape complete rankings from live-tennis.eu
 */
async function scrapeRankings(tour) {
  console.log(`Scraping ${tour} rankings...`);

  try {
    // Try to reuse browser instance
    let browser;
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ];

    // Find Chrome executable — check common Render/Linux paths first
    const { execSync } = require('child_process');
    let executablePath;
    const candidates = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
    for (const c of candidates) {
      try { execSync(`test -f ${c}`); executablePath = c; break; } catch {}
    }

    try {
      const puppeteerExtra = require('puppeteer-extra');
      const StealthPlugin = require('puppeteer-extra-plugin-stealth');
      puppeteerExtra.use(StealthPlugin());
      browser = await puppeteerExtra.launch({ headless: 'new', args: launchArgs, ...(executablePath ? { executablePath } : {}) });
    } catch (e) {
      browser = await puppeteer.launch({ headless: 'new', args: launchArgs, ...(executablePath ? { executablePath } : {}) });
    }

    const page = await browser.newPage();

    // Set realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Set viewport and additional headers
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    const url = tour === 'ATP'
      ? 'https://live-tennis.eu/de/atp-weltrangliste-live'
      : 'https://live-tennis.eu/de/wta-weltrangliste-live';

    console.log(`Loading ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for table to load
    await page.waitForSelector('table tbody tr', { timeout: 10000 });

    // Extract rankings using JavaScript
    const rankings = await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll('table tbody tr');

      for (let i = 0; i < Math.min(rows.length, 150); i++) {
        const cells = rows[i].querySelectorAll('td');
        if (cells.length >= 3) {
          const rankText = cells[0].innerText.trim();
          const nameText = cells[1].innerText.trim();
          const pointsText = cells[2].innerText.trim();

          const rank = parseInt(rankText);
          const points = parseInt(pointsText.replace(/\./g, '').replace(/,/g, ''));

          if (!isNaN(rank) && !isNaN(points) && nameText.length > 2) {
            results.push({
              rank,
              name: nameText,
              points,
              playerKey: `player_${nameText.replace(/\s+/g, '_').toLowerCase()}`,
              tour: tour === 'ATP' ? 'ATP' : 'WTA'
            });
          }
        }
      }

      return results;
    });

    await browser.close();

    console.log(`✅ Scraped ${rankings.length} ${tour} rankings`);
    return rankings;

  } catch (error) {
    console.error(`❌ Error scraping ${tour}:`, error.message);
    throw error;
  }
}

/**
 * API Endpoints
 */

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get ATP rankings
app.get('/api/rankings/atp', async (req, res) => {
  try {
    const cacheKey = 'atp-rankings';
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('Returning cached ATP rankings');
      return res.json({
        success: true,
        data: cached.data,
        cached: true,
        cachedAt: new Date(cached.timestamp)
      });
    }

    const rankings = await scrapeRankings('ATP');
    cache.set(cacheKey, { data: rankings, timestamp: Date.now() });

    res.json({
      success: true,
      data: rankings,
      cached: false,
      scrapedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get WTA rankings
app.get('/api/rankings/wta', async (req, res) => {
  try {
    const cacheKey = 'wta-rankings';
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('Returning cached WTA rankings');
      return res.json({
        success: true,
        data: cached.data,
        cached: true,
        cachedAt: new Date(cached.timestamp)
      });
    }

    const rankings = await scrapeRankings('WTA');
    cache.set(cacheKey, { data: rankings, timestamp: Date.now() });

    res.json({
      success: true,
      data: rankings,
      cached: false,
      scrapedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get specific player ranking
app.get('/api/player/:tour/:name', async (req, res) => {
  try {
    const { tour, name } = req.params;
    const rankings = await scrapeRankings(tour.toUpperCase());

    const player = rankings.find(r =>
      r.name.toLowerCase().includes(decodeURIComponent(name).toLowerCase())
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: `Player ${name} not found in ${tour} rankings`
      });
    }

    res.json({
      success: true,
      data: player
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎾 Tennis Ranking Proxy running on port ${PORT}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  GET /health`);
  console.log(`  GET /api/rankings/atp`);
  console.log(`  GET /api/rankings/wta`);
  console.log(`  GET /api/player/wta/Eva%20Lys`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});