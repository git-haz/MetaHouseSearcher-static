const express = require('express');
const path = require('path');
const { search, addProgressListener } = require('./scraper');
const config = require('./config');
const seedData = require('./seedData');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// SSE progress endpoint
app.get('/api/search-progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  addProgressListener(res);
  req.on('close', () => {
    // Listener will be cleaned up on next emit
  });
});

app.post('/api/search', async (req, res) => {
  try {
    const results = await search(req.body);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/seed-stats', (req, res) => {
  res.json(seedData.getStats());
});

app.get('/api/seed-data', (req, res) => {
  res.json(seedData.getAll());
});

app.get('/api/portals', (req, res) => {
  res.json(config.getPortals());
});

app.post('/api/portals', (req, res) => {
  config.savePortals(req.body);
  res.json({ ok: true });
});

app.get('/api/rightmove-locations', (req, res) => {
  res.json(config.getRightmoveLocations());
});

app.post('/api/rightmove-locations', (req, res) => {
  config.saveRightmoveLocations(req.body);
  res.json({ ok: true });
});

app.get('/api/search-config', (req, res) => {
  res.json(config.getSearchConfig());
});

app.post('/api/search-config', (req, res) => {
  config.saveSearchConfig(req.body);
  res.json({ ok: true });
});

const { calculateFlyovers } = require('./flyovers');

app.post('/api/flyovers', async (req, res) => {
  try {
    const { lat, lon } = req.body;
    const result = await calculateFlyovers(lat, lon);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/flyovers/batch', async (req, res) => {
  try {
    const { locations } = req.body;
    const results = {};
    for (const loc of locations) {
      results[loc.name] = await calculateFlyovers(loc.lat, loc.lon);
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Property Search running at http://localhost:${PORT}`);

  // Run seed search on startup
  const searchConfig = config.getSearchConfig();
  const locations = (searchConfig.locations || []).map(l => l.name);
  if (locations.length > 0) {
    const seedStats = seedData.getStats();
    console.log(`Seed data: ${seedStats.total} properties (last updated: ${seedStats.lastUpdated || 'never'})`);
    console.log(`Starting seed search for: ${locations.join(', ')}...`);

    const criteria = {
      locations: locations.join(', '),
      keywords: [],
      propertyTypes: [],
    };

    search(criteria, true).then(result => {
      console.log(`Seed search complete: ${result.results.length} results, seed: ${result.seedStats.added} new, ${result.seedStats.updated} updated, ${result.seedStats.duplicates} dupes`);
    }).catch(err => {
      console.error('Seed search failed:', err.message);
    });
  }
});
