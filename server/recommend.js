'use strict';

// ---- Rural/quiet keyword scoring ----
const RURAL_POSITIVE = [
  { w: 3, p: /\b(rural|countryside|remote|isolated|secluded|unspoilt|tranquil)\b/gi },
  { w: 3, p: /\bno (near|nearby|immediate) neighbours?\b/gi },
  { w: 2, p: /\b(quiet|peaceful|idyllic|private (position|setting|location))\b/gi },
  { w: 2, p: /\b(farmland|fields|meadow|woodland|open land|pasture|moorland|heathland|open countryside)\b/gi },
  { w: 2, p: /\b(country (lane|road|setting|location)|single[ -]track|no through (road|lane))\b/gi },
  { w: 1, p: /\b(village|hamlet|away from|far from).{0,25}(town|traffic|noise|road|neighbours?)\b/gi },
];
const RURAL_NEGATIVE = [
  { w: 4, p: /\b(A\d{1,4}|B\d{3,4}|dual carriageway|motorway|ring road|bypass)\b/g },
  { w: 3, p: /\b(busy (road|street)|main road|road noise|traffic noise)\b/gi },
  { w: 2, p: /\b(town centre|high street|shops (nearby|within)|amenities (nearby|within)|close to (town|shops|amenities))\b/gi },
  { w: 2, p: /\b(estate|residential area|cul-de-sac|shared (drive|access)|communal)\b/gi },
  { w: 1, p: /\b(suburban|urban|commuter)\b/gi },
];

// ---- Detached + large garden keyword scoring ----
const DETACHED_POSITIVE = [
  { w: 4, p: /\btruly detached\b/gi },
  { w: 3, p: /\bdetached (house|property|residence|home|farmhouse|cottage|barn|bungalow|villa|manor)\b/gi },
  { w: 3, p: /\b\d+(\.\d+)?\s*(acre|acres|ha|hectare)\b/gi },
  { w: 2, p: /\b(substantial|large|generous|extensive|mature|well[- ]stocked)\s+(garden|grounds|plot)\b/gi },
  { w: 2, p: /\b(paddock|orchard|grounds|formal garden|walled garden|kitchen garden|landscaped (garden|grounds))\b/gi },
  { w: 1, p: /\b(good[- ]sized|sizeable|spacious)\s+(garden|plot|grounds)\b/gi },
];
const DETACHED_NEGATIVE = [
  { w: 5, p: /\b(semi[- ]?detached|link[- ]?detached|end[- ]?of[- ]?terrace|terraced|terrace house)\b/gi },
  { w: 3, p: /\b(shared (drive|access|garden|boundary)|party wall|adjoining|attached (to|property))\b/gi },
  { w: 2, p: /\b(small garden|courtyard garden|patio garden|low[- ]maintenance garden|rear (yard|courtyard))\b/gi },
];

function keywordScore(text, positives, negatives) {
  let pos = 0, neg = 0, maxPos = 0, maxNeg = 0;
  for (const { w, p } of positives) {
    const hits = (text.match(p) || []).length;
    pos    += w * Math.min(hits, 2);
    maxPos += w * 2;
  }
  for (const { w, p } of negatives) {
    const hits = (text.match(p) || []).length;
    neg    += w * Math.min(hits, 2);
    maxNeg += w * 2;
  }
  if (maxPos === 0) return 0.5;
  const posScore   = pos / maxPos;
  const negPenalty = maxNeg > 0 ? neg / maxNeg : 0;
  return Math.max(0, Math.min(1, posScore - negPenalty));
}

// ---- ML (optional, @xenova/transformers) ----
let mlClassifier  = null;
let mlAvailable   = false;

// pipelineFn is the `pipeline` export from @xenova/transformers, passed in by build.js
// so that module resolution happens from build.js's node_modules, not from this file's location.
async function initML(pipelineFn) {
  try {
    if (!pipelineFn) {
      // Fallback: try to require directly (works when this file IS inside the right node_modules tree)
      const { pipeline, env } = require('@xenova/transformers');
      env.cacheDir = require('path').join(__dirname, '..', '.model-cache');
      pipelineFn = pipeline;
    }
    console.log('Loading ML model (Xenova/nli-deberta-v3-small)…');
    mlClassifier = await pipelineFn('zero-shot-classification', 'Xenova/nli-deberta-v3-small');
    mlAvailable  = true;
    console.log('ML model loaded.');
  } catch (err) {
    console.warn(`ML not available (${err.message.slice(0, 80)}), using keyword scoring`);
  }
}

const RURAL_LABEL_POS = 'quiet rural isolated location with fields or countryside and no nearby neighbours or major roads';
const RURAL_LABEL_NEG = 'urban or suburban location near busy roads or close to neighbours or town amenities';

async function scoreRural(text) {
  const snippet = text.slice(0, 512);
  if (mlAvailable && mlClassifier) {
    const result = await mlClassifier(snippet, [RURAL_LABEL_POS, RURAL_LABEL_NEG]);
    const idx    = result.labels.indexOf(RURAL_LABEL_POS);
    return result.scores[idx];
  }
  return keywordScore(text, RURAL_POSITIVE, RURAL_NEGATIVE);
}

function scoreDetached(property, text) {
  const typeStr      = (property.type || '').toLowerCase();
  const isRejectType = /semi|link|terrace/.test(typeStr);
  if (isRejectType) return 0.02;

  // Definitive detached types give a strong floor so the score never collapses
  // to zero just because the description doesn't mention garden keywords.
  const isDefinitelyDetached = /\b(detached|farmhouse|farm house|barn conversion|coach house|country house|manor|manor house)\b/.test(typeStr) && !/semi|link/.test(typeStr);
  const floor = isDefinitelyDetached ? 0.5 : 0;

  const kw = keywordScore(text, DETACHED_POSITIVE, DETACHED_NEGATIVE);
  return Math.min(1, Math.max(floor, kw + (isDefinitelyDetached ? 0.2 : 0)));
}

// ---- Haversine (inline to avoid circular dependency) ----
function hvDist(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- Main assessment ----
async function assessProperty(property, ukTowns, config) {
  const rec          = config.recommend || {};
  const minTown      = rec.minDistanceToTownMiles    ?? 15;
  const minAirport   = rec.minDistanceToAirportMiles ?? 15;
  const minHelipad   = rec.minDistanceToHelipadMiles ?? 15;
  const threshold    = rec.confidenceThreshold       ?? 0.9;

  const out = { recommended: false, recommendedDistanceOk: null, recommendedScore: null, nearestTownMiles: null };

  if (property.lat == null) return out;

  // Step 1 — distance gate (hard)
  let nearestTownDist = Infinity;
  for (const t of ukTowns) {
    const d = hvDist(property.lat, property.lon, t.lat, t.lon);
    if (d < nearestTownDist) nearestTownDist = d;
  }
  out.nearestTownMiles = Math.round(nearestTownDist * 10) / 10;

  const airportDist = property.nearestAirport?.distanceMiles  ?? Infinity;
  const helipadDist = property.nearestHeliport?.distanceMiles ?? Infinity;
  out.recommendedDistanceOk = nearestTownDist >= minTown && airportDist >= minAirport && helipadDist >= minHelipad;

  if (!out.recommendedDistanceOk) return out;

  // Step 2 — rural/quiet inference
  const text        = `${property.title || ''} ${property.fullDescription || property.description || ''}`;
  const ruralScore  = await scoreRural(text);

  // Step 3 — truly detached + large garden
  const detachedScore = scoreDetached(property, text);

  const combined = ruralScore * 0.6 + detachedScore * 0.4;

  // Step 4 — reject town-centre descriptions
  const TOWN_CENTRE_RE = [
    /\b(town cent(?:re|er)|city cent(?:re|er)|high street|market (?:square|place|town)|town square)\b/gi,
    /\bwalk(?:ing distance|able) to (?:town|shops|the shops|high street|amenities)\b/gi,
    /\b\d+ (?:minutes?|yards?) (?:from|to|walk(?: to)?) (?:town|the town|high street|the shops)\b/gi,
    /\bin (?:the )?(?:heart|centre|center) of (?:the )?(?:town|village|city)\b/gi,
    /\btowncentre\b|\btown-centre\b/gi,
  ];
  const townCentreMatch = TOWN_CENTRE_RE.some(re => re.test(text));

  out.recommendedScore = {
    rural:      Math.round(ruralScore    * 100),
    detached:   Math.round(detachedScore * 100),
    combined:   Math.round(combined      * 100),
    townCentre: townCentreMatch,
  };
  out.recommended = combined >= threshold && !townCentreMatch;
  return out;
}

module.exports = { initML, assessProperty };
