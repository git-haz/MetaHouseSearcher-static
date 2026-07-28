const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULT_PORTALS = [
  { id: 'zoopla', name: 'Zoopla', enabled: true, builtin: true, params: ['location*', 'keywords', 'maxPrice', 'minBed', 'propertyTypes'] },
  { id: 'rightmove', name: 'Rightmove', enabled: true, builtin: true, params: ['location* (via ID mapping)', 'maxPrice', 'minBed'] },
  { id: 'onthemarket', name: 'OnTheMarket', enabled: true, builtin: true, params: ['location*', 'keywords', 'maxPrice', 'minBed', 'propertyTypes'] },
  { id: 'durrants', name: 'Durrants', enabled: true, builtin: true, params: ['location', 'radius', 'maxPrice', 'minBed'] },
  { id: 'winkworth', name: 'Winkworth', enabled: true, builtin: true, params: ['location', 'keywords', 'maxPrice', 'minBed', 'propertyTypes'], linkOnly: true },
  { id: 'davidburr', name: 'David Burr', enabled: false, builtin: true, params: ['location', 'keywords', 'maxPrice', 'minBed', 'propertyTypes'] },
  { id: 'clarkeandsimpson', name: 'Clarke & Simpson', enabled: false, builtin: true, params: ['location', 'keywords', 'maxPrice', 'minBed', 'propertyTypes'] },
  { id: 'harrisonedge', name: 'Harrison Edge', enabled: false, builtin: true, params: ['location', 'keywords', 'maxPrice', 'minBed', 'propertyTypes'] },
  { id: 'savills', name: 'Savills', enabled: true, builtin: true, params: ['location', 'maxPrice', 'minBed'] },
  { id: 'struttandparker', name: 'Strutt & Parker', enabled: true, builtin: true, params: ['location', 'maxPrice', 'minBed'] },
  { id: 'jackson-stops', name: 'Jackson-Stops', enabled: true, builtin: true, params: ['location', 'maxPrice', 'minBed'] },
  { id: 'bedfords', name: 'Bedfords', enabled: false, builtin: true, params: ['location'], linkOnly: true },
  { id: 'flickandson', name: 'Flick & Son', enabled: false, builtin: true, params: ['(broken URL)'] },
  { id: 'fineandcountry', name: 'Fine & Country', enabled: false, builtin: true, params: ['(SPA - no scraper)'] },
];

const DEFAULT_RIGHTMOVE_LOCATIONS = {
  'wenhaston': 'REGION^1264',
  'diss': 'REGION^425',
  'harleston': 'REGION^11918',
  'laxfield': 'REGION^14740',
};

const DEFAULT_SEARCH_CONFIG = {
  locations: [
    { name: 'Wenhaston', radius: 20 },
    { name: 'Diss', radius: 20 },
    { name: 'Harleston', radius: 20 },
    { name: 'Halesworth', radius: 20 },
    { name: 'Eye', radius: 20 },
  ],
  neighbourConfidenceThreshold: 0.95,
};

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  const existing = load();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...data }, null, 2));
}

function getPortals() {
  const data = load();
  return data.portals || DEFAULT_PORTALS;
}

function savePortals(portals) {
  save({ portals });
}

function getRightmoveLocations() {
  const data = load();
  return data.rightmoveLocations || DEFAULT_RIGHTMOVE_LOCATIONS;
}

function saveRightmoveLocations(locations) {
  save({ rightmoveLocations: locations });
}

function getSearchConfig() {
  const data = load();
  return data.searchConfig || DEFAULT_SEARCH_CONFIG;
}

function saveSearchConfig(config) {
  save({ searchConfig: config });
}

module.exports = { getPortals, savePortals, getRightmoveLocations, saveRightmoveLocations, getSearchConfig, saveSearchConfig };
