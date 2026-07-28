'use strict';

// ---- Keyword fallback patterns per tag ----

const KW = {
  rural: {
    pos: [
      { w: 3, p: /\b(rural|countryside|remote|isolated|secluded|unspoilt|tranquil)\b/gi },
      { w: 3, p: /\bno (near|nearby|immediate) neighbours?\b/gi },
      { w: 2, p: /\b(farmland|fields|meadow|woodland|open land|pasture|moorland|heathland|open countryside)\b/gi },
      { w: 2, p: /\b(country (lane|road|setting|location)|single[ -]track|no through (road|lane))\b/gi },
      { w: 1, p: /\b(village|hamlet|away from|far from).{0,25}(town|traffic|noise|road|neighbours?)\b/gi },
    ],
    neg: [
      { w: 4, p: /\b(A\d{1,4}|B\d{3,4}|dual carriageway|motorway|ring road|bypass)\b/g },
      { w: 3, p: /\b(busy (road|street)|main road|road noise|traffic noise)\b/gi },
      { w: 2, p: /\b(town centre|high street|shops (nearby|within)|amenities (nearby|within)|close to (town|shops|amenities))\b/gi },
      { w: 2, p: /\b(estate|residential area|cul-de-sac|shared (drive|access)|communal)\b/gi },
      { w: 1, p: /\b(suburban|urban|commuter)\b/gi },
    ],
  },
  quiet: {
    pos: [
      { w: 3, p: /\b(peaceful|tranquil|serene|silent|quiet (lane|road|location|setting|village))\b/gi },
      { w: 3, p: /\bno (through (road|traffic)|nearby neighbours?|immediate neighbours?)\b/gi },
      { w: 2, p: /\b(private (position|setting|lane|road|drive)|seclu(ded|sion))\b/gi },
      { w: 2, p: /\b(birdsong|wildlife|nature reserve|natural surroundings)\b/gi },
    ],
    neg: [
      { w: 4, p: /\b(road noise|traffic noise|busy (road|street|location))\b/gi },
      { w: 3, p: /\b(A\d{1,4}|B\d{3,4}|dual carriageway|motorway)\b/g },
      { w: 2, p: /\b(overlooked|overlooking neighbouring|shared access|communal area)\b/gi },
    ],
  },
  hillside: {
    pos: [
      { w: 4, p: /\b(hillside|hilltop|hill top|elevated (position|setting|location|plot)|raised (position|ground))\b/gi },
      { w: 3, p: /\b(commanding (views?|position)|perched (on|above)|set (high|above)|high (above|on))\b/gi },
      { w: 2, p: /\b(slopes?|gradient|above (the|a) (village|town|valley)|terraced (garden|grounds))\b/gi },
      { w: 2, p: /\b(valley (views?|below)|overlooking (the|a) valley|ridge(line)?|escarpment)\b/gi },
    ],
    neg: [],
  },
  'large-outdoors': {
    pos: [
      { w: 4, p: /\b\d+(\.\d+)?\s*(acre|acres|ha|hectare)\b/gi },
      { w: 3, p: /\b(substantial|large|generous|extensive|mature|well[- ]stocked)\s+(garden|grounds|plot)\b/gi },
      { w: 3, p: /\b(paddock|orchard|formal garden|walled garden|kitchen garden|landscaped (garden|grounds))\b/gi },
      { w: 2, p: /\b(good[- ]sized|sizeable|spacious)\s+(garden|plot|grounds)\b/gi },
      { w: 2, p: /\b(outbuildings?|barn|stable|workshop) (with|and|plus) (garden|land|grounds)\b/gi },
    ],
    neg: [
      { w: 4, p: /\b(small garden|courtyard garden|patio garden|low[- ]maintenance garden|rear (yard|courtyard))\b/gi },
      { w: 3, p: /\b(apartment|flat|studio|top floor flat|ground floor flat)\b/gi },
    ],
  },
  'great-views': {
    pos: [
      { w: 4, p: /\b(panoramic|far[- ]reaching|stunning|breathtaking|spectacular|exceptional)\s+(views?|outlook|scenery|vistas?)\b/gi },
      { w: 3, p: /\bviews?\s+(of|over|across|towards)\s+(the\s+)?(countryside|hills?|valley|moors?|coast|sea|lake|river|fields?|mountains?|fells?|dales?)\b/gi },
      { w: 3, p: /\b(open views?|long views?|countryside views?|rural views?|hill views?|moorland views?|dale views?)\b/gi },
      { w: 2, p: /\b(outstanding (natural beauty|views?)|area of outstanding)\b/gi },
    ],
    neg: [],
  },
  'far-from-roads': {
    pos: [
      { w: 4, p: /\b(quiet (country|rural|private) (lane|road|track)|no through (road|lane|traffic)|single[- ]track (road|lane))\b/gi },
      { w: 3, p: /\b(far from|away from|distance from|set back from)\s+(the\s+)?(main|busy|major) road/gi },
      { w: 2, p: /\b(private road|unadopted road|unclassified road|track access|farm track)\b/gi },
      { w: 2, p: /\b(no road noise|no traffic|away from traffic)\b/gi },
    ],
    neg: [
      { w: 5, p: /\b(A\d{1,4}|B\d{3,4})\b/g },
      { w: 4, p: /\b(dual carriageway|motorway|ring road|bypass)\b/gi },
      { w: 3, p: /\b(road noise|traffic noise|busy road|main road|road frontage|roadside)\b/gi },
    ],
  },
};

// ---- Tag definitions with NLI labels ----
const TAG_DEFS = [
  {
    tag: 'rural',
    posLabel: 'quiet rural location in open countryside with fields, farmland, or moorland far from towns',
    negLabel: 'urban or suburban location near town centre, shops, estates, or busy roads',
  },
  {
    tag: 'quiet',
    posLabel: 'peaceful quiet location with no traffic noise, no busy roads nearby, and no immediate neighbours',
    negLabel: 'noisy or busy location near main roads, traffic, or densely packed neighbours',
  },
  {
    tag: 'hillside',
    posLabel: 'property on a hillside or elevated position above a valley, with sloping terrain or elevated views',
    negLabel: 'flat level location on low ground with no elevation or hill features',
  },
  {
    tag: 'large-outdoors',
    posLabel: 'extensive outdoor space with large garden, grounds, paddock, orchard, or multiple acres of land',
    negLabel: 'small garden, courtyard, patio, or minimal outdoor space',
  },
  {
    tag: 'great-views',
    posLabel: 'property with panoramic or far-reaching views of countryside, hills, valleys, moorland, coast, or water',
    negLabel: 'no notable views, enclosed by buildings or trees, or standard residential outlook',
  },
  {
    tag: 'far-from-roads',
    posLabel: 'property accessed via quiet country lane or private road, far from A roads, B roads, and any main roads',
    negLabel: 'close to A road, B road, dual carriageway, motorway, or busy main road with traffic noise',
  },
];

// ---- Haversine ----
function hvDist(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- Keyword scoring fallback ----
function kwScore(text, pos, neg) {
  let p = 0, n = 0, mp = 0, mn = 0;
  for (const { w, p: re } of pos) { const h = (text.match(re) || []).length; p += w * Math.min(h, 2); mp += w * 2; }
  for (const { w, p: re } of neg) { const h = (text.match(re) || []).length; n += w * Math.min(h, 2); mn += w * 2; }
  if (mp === 0) return 0.35;
  return Math.max(0, Math.min(1, p / mp - (mn > 0 ? n / mn : 0)));
}

// ---- ML state ----
let mlClassifier = null;
let mlAvailable  = false;

async function initML(pipelineFn) {
  try {
    if (!pipelineFn) {
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

async function scoreTag(text, def) {
  const snippet = text.slice(0, 512);
  if (mlAvailable && mlClassifier) {
    const result = await mlClassifier(snippet, [def.posLabel, def.negLabel]);
    const idx = result.labels.indexOf(def.posLabel);
    return result.scores[idx];
  }
  const kw = KW[def.tag];
  return kwScore(text, kw.pos, kw.neg || []);
}

// ---- Distance gate ----
function passesDistanceGate(property, ukTowns, config) {
  const at  = config.autoTag || config.recommend || {};
  const minTown     = at.minDistanceToTownMiles    ?? 10;
  const minTownPop  = at.minTownPopulation         ?? 15000;
  const minAirport  = at.minDistanceToAirportMiles ?? 15;
  const minAirstrip = at.minDistanceToAirstripMiles ?? 5;
  const minHelipad  = at.minDistanceToHelipadMiles ?? 15;

  if (property.lat == null) return false;
  if ((property.nearestAirport?.distanceMiles  ?? Infinity) < minAirport)  return false;
  if ((property.nearestAirstrip?.distanceMiles ?? Infinity) < minAirstrip) return false;
  if ((property.nearestHeliport?.distanceMiles ?? Infinity) < minHelipad)  return false;

  for (const t of ukTowns) {
    if ((t.pop || t.population || 0) < minTownPop) continue;
    if (hvDist(property.lat, property.lon, t.lat, t.lon) < minTown) return false;
  }
  return true;
}

// ---- Tag a batch of properties with confidence cascade ----
// Applies threshold 80%→70%→60% until ≥10 properties in the batch have at least one tag.
async function autoTagLocation(properties, ukTowns, config) {
  const at = config.autoTag || config.recommend || {};
  const baseThreshold = at.confidenceThreshold ?? 0.8;
  const thresholds = [baseThreshold, 0.7, 0.6].filter((v, i, a) => v <= 1 && a.indexOf(v) === i);

  const eligible = properties.filter(p => passesDistanceGate(p, ukTowns, config));

  // Score all eligible properties once (ML scores are threshold-independent)
  const scored = [];
  for (const p of eligible) {
    const text = `${p.title || ''} ${p.fullDescription || p.description || ''}`;
    const tagScores = {};
    for (const def of TAG_DEFS) {
      tagScores[def.tag] = await scoreTag(text, def);
    }
    scored.push({ p, tagScores });
  }

  // Find the lowest threshold that yields ≥10 tagged properties
  let chosenThreshold = thresholds[thresholds.length - 1];
  for (const t of thresholds) {
    const tagged = scored.filter(({ tagScores }) => Object.values(tagScores).some(s => s >= t)).length;
    if (tagged >= 10) { chosenThreshold = t; break; }
  }

  // Apply chosen threshold: update each property in-place
  const eligibleSet = new Set(eligible);
  for (const p of properties) {
    // Remove old recommendation fields
    delete p.recommended;
    delete p.recommendedScore;
    delete p.recommendedDistanceOk;

    if (!eligibleSet.has(p)) {
      p.autoTags = [];
      p.autoTagScores = {};
      continue;
    }
    const { tagScores } = scored.find(s => s.p === p);
    p.autoTags       = TAG_DEFS.map(d => d.tag).filter(tag => tagScores[tag] >= chosenThreshold);
    p.autoTagScores  = Object.fromEntries(Object.entries(tagScores).map(([k, v]) => [k, Math.round(v * 100)]));
    p.autoTagThreshold = Math.round(chosenThreshold * 100);
  }

  const totalTagged = properties.filter(p => p.autoTags?.length > 0).length;
  return { chosenThreshold, totalTagged, eligibleCount: eligible.length };
}

module.exports = { initML, autoTagLocation, passesDistanceGate, TAG_DEFS };
