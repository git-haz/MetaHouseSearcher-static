const config = require('./config');
const { deduplicate } = require('./dedup');
const { findNearestByCategory } = require('./airports');
const { buildUrls } = require('./portals');
const { closeBrowser } = require('./browser');
const { geocodeResults } = require('./geocode');
const { analyzeProperties } = require('./imageAnalyzer');
const { attachFlyoverData } = require('./flyovers');
const seedData = require('./seedData');

const PORTAL_TIMEOUT_MS = 20000;

const parsers = {
  zoopla: require('./parsers/zoopla'),
  onthemarket: require('./parsers/onthemarket'),
  durrants: require('./parsers/durrants'),
  rightmove: require('./parsers/rightmove'),
  savills: require('./parsers/savills'),
  struttandparker: require('./parsers/struttandparker'),
  'jackson-stops': require('./parsers/jackson-stops'),
};

// Progress listeners (SSE clients)
let progressListeners = [];

function emitProgress(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  progressListeners = progressListeners.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

function addProgressListener(res) {
  progressListeners.push(res);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms / 1000}s: ${label}`)), ms)),
  ]);
}

async function search(criteria, isSeed = false) {
  const portals = config.getPortals().filter(p => p.enabled);
  const rightmoveLocations = config.getRightmoveLocations();
  const allListings = [];
  const portalLinks = [];

  const totalPortals = portals.filter(p => parsers[p.id]).length;
  let portalsDone = 0;

  for (const portal of portals) {
    const urls = buildUrls(portal, criteria, rightmoveLocations);
    portalLinks.push(...urls);

    if (parsers[portal.id]) {
      for (const link of urls) {
        emitProgress({
          stage: 'scraping',
          portal: portal.name,
          portalsDone,
          totalPortals,
          totalResults: allListings.length,
        });

        try {
          console.log(`Scraping ${portal.name}: ${link.url}`);
          const listings = await withTimeout(
            parsers[portal.id].scrape(link.url),
            PORTAL_TIMEOUT_MS,
            portal.name
          );
          console.log(`  Found ${listings.length} listings`);
          allListings.push(...listings);

          emitProgress({
            stage: 'scraping',
            portal: portal.name,
            portalsDone,
            totalPortals,
            portalResults: listings.length,
            totalResults: allListings.length,
            message: `${portal.name}: ${listings.length} results`,
          });
        } catch (err) {
          console.error(`  Error scraping ${portal.name}: ${err.message}`);
          emitProgress({
            stage: 'scraping',
            portal: portal.name,
            portalsDone,
            totalPortals,
            totalResults: allListings.length,
            message: `${portal.name}: ${err.message}`,
            error: true,
          });
        }
      }
      portalsDone++;
    }
  }

  await closeBrowser();

  emitProgress({ stage: 'deduplicating', totalResults: allListings.length });
  let results = deduplicate(allListings);

  const keywords = (criteria.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
  for (const r of results) {
    r.keywordsMatched = 0;
    if (keywords.length > 0) {
      const text = `${r.title} ${r.description} ${r.address}`.toLowerCase();
      r.keywordsMatched = keywords.filter(kw => text.includes(kw)).length;
    }
  }

  emitProgress({ stage: 'geocoding', count: results.length });
  const searchLocations = (criteria.locations || '').split(',').map(l => l.trim()).filter(Boolean);
  console.log('Geocoding properties...');
  await geocodeResults(results, searchLocations);

  for (const r of results) {
    const nearest = findNearestByCategory(r.lat, r.lon);
    r.nearestAirport = nearest.airport;
    r.nearestAirstrip = nearest.airstrip;
    r.nearestHeliport = nearest.heliport;
    const dists = [nearest.airport, nearest.airstrip, nearest.heliport]
      .filter(Boolean).map(a => a.distanceMiles);
    r.minAirportDistanceMiles = dists.length ? Math.min(...dists) : null;
  }

  attachFlyoverData(results, searchLocations);

  emitProgress({ stage: 'analyzing_images', count: results.length });
  const searchConfig = config.getSearchConfig();
  const confidenceThreshold = searchConfig.neighbourConfidenceThreshold || 0.95;
  console.log('Analyzing property images...');
  await analyzeProperties(results, confidenceThreshold);

  // Merge into seed data
  emitProgress({ stage: 'merging_seed', count: results.length });
  const mergeStats = seedData.mergeResults(results);
  console.log(`Seed merge: ${mergeStats.added} new, ${mergeStats.updated} updated, ${mergeStats.duplicates} dupes (${mergeStats.total} total)`);

  // Mark properties that exist in seed as potential duplicates
  for (const r of results) {
    const seedAll = seedData.getAll();
    const key = seedData.dedupKey(r);
    const seedMatch = seedAll.find(s => seedData.dedupKey(s) === key && s.potentialDuplicate);
    if (seedMatch) r.potentialDuplicate = true;
  }

  emitProgress({ stage: 'complete', count: results.length, seed: mergeStats });

  return { results, portalLinks, seedStats: mergeStats };
}

module.exports = { search, addProgressListener, emitProgress };
