# MetaHouseSearcher — Static Edition

A self-hosted, GitHub Pages–compatible property search aggregator. It scrapes multiple UK estate-agent portals for a configured set of rural locations, enriches each result with airport-distance data, flyover-rate estimates, and an ML-based "quiet rural" recommendation, then publishes everything as static JSON files browsable via a single-page app.

---

## Repository Layout

```
MetaHouseSearcher-static/
├── build.js                  # Main build script (Node.js, Puppeteer)
├── search-config.json        # All search parameters (locations, portals, filters)
├── docs/                     # GitHub Pages root — everything served as static files
│   ├── index.html            # Single-page app shell
│   ├── app.js                # All client-side logic
│   ├── style.css             # Styles
│   ├── airports.json         # UK airport/airstrip/helipad dataset (copied from property-search)
│   ├── flyover-reference.json# Estimated flights/day by area reference point
│   ├── military-zones.json   # Military danger areas, MATZs, LFAs for map overlay
│   ├── uk-towns.json         # UK towns with population ≥ threshold (for recommendation gate)
│   └── results/
│       ├── index.json        # Manifest: locations list, totals, build status (complete: true/false)
│       └── {slug}.json       # One file per search location (e.g. hawes.json, launceston.json)
├── scripts/
│   └── fetch-uk-towns.js     # One-time utility to regenerate uk-towns.json
└── package.json
```

The `docs/` folder is served directly by GitHub Pages. No server-side logic runs — everything is pre-built and stored as JSON.

---

## How the Build Works

`build.js` is the single entry point. It:

1. **Loads** `search-config.json` and the supporting data files (airports, flyover reference, UK towns)
2. **Establishes a baseline** (configured property in a known noisy area, e.g. Tottenham) to produce comparison metrics
3. **For each configured location**, in sequence:
   - Launches Puppeteer and scrapes each enabled portal (Zoopla, OnTheMarket, Savills, Strutt & Parker, Jackson-Stops, Durrants, …)
   - De-duplicates listings within the location
   - Geocodes each property (street address → lat/lon, falling back to postcode, then area centroid)
   - Calculates nearest airport/airstrip/helipad distances
   - Attaches flyover estimate from the nearest reference station
   - Runs the ML "quiet rural + detached" recommendation scorer
   - Writes `docs/results/{slug}.json` immediately after that location finishes
   - Updates `docs/results/index.json` with the location now listed as available
4. After all locations: marks `index.json` as `complete: true`

The app polls `index.json` during a live build and fetches new location files as they appear, so results show up without waiting for the full run.

---

## Running a Build

### Prerequisites

```bash
cd MetaHouseSearcher-static
npm install
```

You also need `property-search/` (the sibling scraper project) to be present — `build.js` imports server-side modules from it (`recommend.js`, `geocode.js`, etc.).

### Full build (all locations)

```bash
node build.js
```

Scrapes all locations in `search-config.json`. Takes ~60–90 minutes. Results appear in `docs/results/` progressively.

### Partial build — specific locations only

```bash
node build.js --locations=Hawes,Leyburn,Settle
```

Only scrapes the named locations. Existing results for all other locations are **preserved** — the script reads the current `index.json` first and merges slugs, so nothing is overwritten. Location names must match the `location` field in `search-config.json` (case-insensitive).

### Rescore only — re-run ML/distances without scraping

```bash
node build.js --rescore
```

Reads all existing seed data and re-runs the enrichment pipeline (geocoding, distances, ML recommendation) without hitting any portals. Useful after changing recommendation thresholds in `search-config.json`.

### Push-every flag

```bash
node build.js --push-every=5
```

After every N completed locations, automatically commits and pushes `docs/results/` to git. This means the GitHub Pages site updates mid-build (with ~60–90 s propagation delay per push).

---

## search-config.json Reference

```jsonc
{
  // Search locations — one scrape run per entry
  "searches": [
    {
      "location":     "Hawes",          // Display name and slug base
      "postcode":     "DL8 3NT",        // Used as the search centroid
      "county":       "North Yorkshire", // Fallback for portals that need county
      "radius":       20,               // Search radius in miles
      "rightmoveId":  "REGION^780"      // Rightmove region ID (used when rightmove enabled)
    }
  ],

  // Portals to scrape (all enabled by default unless listed in disabledPortals)
  "disabledPortals": ["rightmove"],

  // Hard filters applied at scrape time
  "maxPrice":  450000,
  "minBed":    2,
  "keywords":  ["garden"],              // All keywords must appear in the listing

  // Auto-reject by title/type pattern or price floor
  "autoReject": {
    "titlePatterns": ["semi-detached", "link-detached", "end-of-terrace", "terraced", "terrace house"],
    "minPrice":      300000
  },

  // Reasons shown in the reject modal (configurable list)
  "rejectionReasons": ["house type", "neighbour vicinity", "solar panels", "A road vicinity", "B road vicinity"],

  // How many portals to scrape in parallel per location
  "maxConcurrentPortals": 2,

  // Per-portal page load timeout in ms
  "queryTimeoutMs": 90000,

  // ML recommendation settings
  "recommend": {
    "enabled":                   true,
    "minTownPopulation":         15000,   // Only towns ≥ this count as "too close to town"
    "minDistanceToTownMiles":    10,      // Hard gate: must be ≥ this far from any qualifying town
    "minDistanceToAirportMiles": 15,      // Hard gate: nearest airport
    "minDistanceToHelipadMiles": 15,      // Hard gate: nearest helipad
    "confidenceThreshold":       0.4      // Combined ML score must exceed this (0–1)
  },

  // Baseline comparison property (used to contextualise airport/flight counts)
  "baseline": {
    "name":               "Tottenham",
    "postcode":           "N179RS",
    "airportRadiusMiles": 20,
    "airstripRadiusMiles": 5,
    "helipadRadiusMiles": 15
  },

  // Image-based neighbour detection sensitivity (0–1; 0.99 = very strict)
  "neighbourConfidenceThreshold": 0.99
}
```

---

## The ML Recommendation System

Each property that passes the hard distance gates is scored on two axes:

| Axis | Description | Weight |
|---|---|---|
| **Rural/quiet** | NLI zero-shot classification using `Xenova/nli-deberta-v3-small` (falls back to keyword scoring if model unavailable) | 60 % |
| **Detached + large garden** | Keyword patterns for detached types, acreage, plot size; penalty for terraced/semi | 40 % |

Combined score = `rural × 0.6 + detached × 0.4`. A property is recommended if:
- Combined score ≥ `confidenceThreshold` (default 0.4)
- **And** the description does not contain town-centre language (high street, walking distance to town, heart of the village, etc.)

Scores are stored in `recommendedScore: { rural, detached, combined, townCentre }` on each result and displayed in the app when you tap the ⭐ Recommended badge.

---

## Results File Format

### `docs/results/index.json`

```jsonc
{
  "generatedAt":        "2024-07-25T00:00:00.000Z",
  "complete":           true,             // false while build is still running
  "totalLocations":     45,
  "completedLocations": 45,
  "totalResults":       1234,
  "available":          ["hawes", "leyburn", ...],  // slugs with a ready JSON file
  "locations":          [...],            // full location list from search-config
  "searchConfig":       {...},            // copy of search-config metadata
  "baseline":           {...},            // baseline metrics
  "portalLinks":        [...]             // source URLs used per portal+location
}
```

### `docs/results/{slug}.json`

```jsonc
{
  "location":    "Hawes",
  "slug":        "hawes",
  "generatedAt": "...",
  "properties":  [
    {
      "title":        "...",
      "price":        350000,
      "address":      "...",
      "bedrooms":     3,
      "bathrooms":    2,
      "sqft":         null,
      "type":         "Detached",
      "description":  "...",
      "images":       ["https://..."],
      "sources":      [{ "portal": "Zoopla", "url": "https://..." }],
      "lat":          54.3,
      "lon":          -2.1,
      "geoAccuracy":  "address",          // "address" | "postcode" | "area"
      "nearestAirport":  { "name": "...", "icao": "...", "distanceMiles": 22.4, "usage": "commercial", "active": true },
      "nearestAirstrip": { ... },
      "nearestHeliport": { ... },
      "flyoverRef":   { "flightsPerDay": 3.2, "location": "Wensleydale", "seasonalFlag": "stable", "monthly": [...] },
      "recommended":  true,
      "recommendedScore": { "rural": 78, "detached": 65, "combined": 73, "townCentre": false },
      "nearestTownMiles": 14.2,
      "baselineComparison": { "airportsDiff": -3, "airstripsDiff": 0, "helipadsDiff": -2, "flightsDiffPct": -96 },
      "retrievedAt":  "...",
      "searchLocation": "Hawes"
    }
  ]
}
```

**`geoAccuracy`** values:
- `"address"` — geocoded to street level (~10 m accuracy); flyover and distance data are precise
- `"postcode"` — geocoded to postcode centroid (~100 m); data is reliable
- `"area"` — fell back to the search location centroid; flyover and distance figures are approximate and shown with a ⚠ warning in the app

---

## Using the App

The app is available at your GitHub Pages URL (e.g. `https://<username>.github.io/MetaHouseSearcher-static/`).

### Filtering

| Control | Description |
|---|---|
| **Keywords** | Type a word or phrase and press Enter. Each entry becomes a chip. **−** (default) = exclude results containing that term. **+** = only show results containing that term. Tap the mode button on a chip to toggle; tap × to remove. |
| **Tags** | Filter by status tags (Favorites, Rejected, Recommended, etc.). Toggle between **Hide** (hide tagged) and **Show only** (show only tagged). Collapsible — tap ▾ to collapse. On mobile, shown as a multi-select dropdown. |
| **Price / Beds / Baths / Garden** | Numeric range filters in the filter bar. |
| **Min airport dist** | Hide any property with a nearest airport closer than N miles (appears in the results bar after results load). |
| **Baseline comparison** | Show only properties with fewer airports/airstrips/helipads than the baseline, or a lower flights/day figure. |

### Views

- **List** — card grid with carousels, distance data, and action buttons
- **Map** — Leaflet map with markers for all filtered results; configurable airport, helipad, and airstrip radius circles; military zone overlays; town population circles

### Property actions

- **★ Fav / Seen / To View / Viewed / In Progress** — list membership, stored in `localStorage`
- **Reject** — opens a modal to record rejection reasons and a note
- **+ Note** — attach a free-text note to a property
- **⤡ Merge** — merge duplicate listings into one card

### Card information

- **⭐ Recommended ℹ** — tap to see the ML scores breakdown
- **✈ N flights/day ℹ** — tap to see reference station, seasonal pattern, and accuracy level; a ⚠ flag means the property location was approximate
- **📍 / 📮 / 🗺️** — geocoding accuracy: street / postcode / area estimate
- **vs Baseline** — expandable comparison row showing airport/airstrip/helipad/flight differences vs the baseline property

### Map layers (toggle in the map config panel above the map)

- **Airports / Helipads / Airstrips** — grouped by type (commercial, military, private) with optional inactive sites; configurable radius circles
- **Towns** — population circles for towns above a configurable threshold
- **Military zones** — danger areas (red polygons), MATZs (orange circles, 5 nm radius), LFAs (blue polygons); hover/tap for description popup

### Exclusion zones

Draw polygons on the map (pencil tool) to mark areas to exclude from results. Properties inside any exclusion zone are tagged and hidden by default.

### Data management

- **Export** — downloads a JSON file of all your lists, notes, rejection reasons, and keyword filters
- **Import** — restores from an exported file (merges, does not overwrite)

---

## Supporting Data Files

| File | Contents | Update frequency |
|---|---|---|
| `docs/airports.json` | All UK airports, airstrips, and helipads with coordinates, ICAO code, usage type, active status | Updated manually from OurAirports data |
| `docs/flyover-reference.json` | Estimated flights/day indexed by named area reference point (derived from OpenSky/NATS data) | Updated manually |
| `docs/military-zones.json` | Danger area polygons, MATZ centre points, LFA polygons | Updated manually from UK AIP/CAA charts |
| `docs/uk-towns.json` | UK towns with population ≥ configured threshold; used for the recommendation distance gate | Regenerated via `node scripts/fetch-uk-towns.js` |

---

## Adding New Locations

Add an entry to the `searches` array in `search-config.json`:

```json
{
  "location": "Alston",
  "postcode": "CA9 3RN",
  "county":   "Cumbria",
  "radius":   20
}
```

Then run:

```bash
node build.js --locations=Alston
```

This adds Alston's results to `docs/results/` without re-scraping everything else.

---

## Deployment

The `docs/` folder is the GitHub Pages root. After any build:

```bash
git add docs/results/
git commit -m "Build: add/update locations"
git push
```

GitHub Pages picks up the change within ~60–90 seconds. The app's polling mechanism will detect the new `index.json` and fetch any newly available location files automatically.
