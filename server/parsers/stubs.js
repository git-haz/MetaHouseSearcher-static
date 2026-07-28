const STREETS = [
  'High Street', 'Church Lane', 'Station Road', 'Mill Lane', 'Park Avenue',
  'Victoria Road', 'Queen Street', 'King Street', 'Manor Road', 'The Green',
  'Elm Close', 'Oak Drive', 'Willow Way', 'Cedar Crescent', 'Birch Terrace',
  'Meadow Lane', 'River View', 'Castle Hill', 'Bridge Street', 'Market Square'
];

const TYPES = [
  'Detached House', 'Semi-Detached House', 'Terraced House', 'Flat',
  'Bungalow', 'Cottage', 'Town House', 'End of Terrace', 'Penthouse', 'Maisonette'
];

const FEATURES = [
  'garden', 'garage', 'parking', 'conservatory', 'ensuite',
  'open plan', 'period features', 'newly refurbished', 'chain free', 'south facing'
];

const IMAGES = [
  'https://placehold.co/400x300/e8d5b7/333?text=Property+1',
  'https://placehold.co/400x300/b7d5e8/333?text=Property+2',
  'https://placehold.co/400x300/d5e8b7/333?text=Property+3',
  'https://placehold.co/400x300/e8b7d5/333?text=Property+4',
  'https://placehold.co/400x300/b7e8d5/333?text=Property+5'
];

const LOCATION_COORDS = {
  'london': { lat: 51.5074, lon: -0.1278 },
  'manchester': { lat: 53.4808, lon: -2.2426 },
  'birmingham': { lat: 52.4862, lon: -1.8904 },
  'leeds': { lat: 53.8008, lon: -1.5491 },
  'bristol': { lat: 51.4545, lon: -2.5879 },
  'sheffield': { lat: 53.3811, lon: -1.4701 },
  'liverpool': { lat: 53.4084, lon: -2.9916 },
  'nottingham': { lat: 52.9548, lon: -1.1581 },
  'edinburgh': { lat: 55.9533, lon: -3.1883 },
  'glasgow': { lat: 55.8642, lon: -4.2518 },
  'cardiff': { lat: 51.4816, lon: -3.1791 },
  'york': { lat: 53.9591, lon: -1.0815 },
  'bath': { lat: 51.3758, lon: -2.3599 },
  'oxford': { lat: 51.7520, lon: -1.2577 },
  'cambridge': { lat: 52.2053, lon: 0.1218 },
};

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function generate(portal, criteria) {
  const locations = (criteria.locations || 'London').split(',').map(l => l.trim()).filter(Boolean);
  const minPrice = criteria.minPrice || 100000;
  const maxPrice = criteria.maxPrice || 1000000;
  const minBed = criteria.minBed || 1;
  const maxBed = criteria.maxBed || 5;
  const minBath = criteria.minBath || 1;
  const maxBath = criteria.maxBath || 3;

  const listings = [];
  const seed = hashStr(portal.id + locations.join(','));
  const rand = seededRandom(seed);

  for (const location of locations) {
    const base = LOCATION_COORDS[location.toLowerCase()] || { lat: 51.5 + (rand() - 0.5), lon: -0.1 + (rand() - 0.5) };
    const count = 5 + Math.floor(rand() * 8);
    for (let i = 0; i < count; i++) {
      const street = STREETS[Math.floor(rand() * STREETS.length)];
      const houseNum = 1 + Math.floor(rand() * 120);
      const type = TYPES[Math.floor(rand() * TYPES.length)];
      const beds = minBed + Math.floor(rand() * (maxBed - minBed + 1));
      const baths = minBath + Math.floor(rand() * (maxBath - minBath + 1));
      const price = Math.round((minPrice + rand() * (maxPrice - minPrice)) / 5000) * 5000;
      const numFeatures = 2 + Math.floor(rand() * 4);
      const feats = [];
      for (let f = 0; f < numFeatures; f++) {
        const feat = FEATURES[Math.floor(rand() * FEATURES.length)];
        if (!feats.includes(feat)) feats.push(feat);
      }

      listings.push({
        title: `${beds} bedroom ${type.toLowerCase()} for sale`,
        price,
        address: `${houseNum} ${street}, ${location}`,
        bedrooms: beds,
        bathrooms: baths,
        type,
        description: `A lovely ${beds} bedroom ${type.toLowerCase()} with ${feats.join(', ')}. Located on ${street} in ${location}.`,
        image: IMAGES[Math.floor(rand() * IMAGES.length)],
        lat: base.lat + (rand() - 0.5) * 0.1,
        lon: base.lon + (rand() - 0.5) * 0.1,
        sources: [{
          portal: portal.name,
          url: `https://${portal.id}.example.com/property/${encodeURIComponent(location)}/${i}`
        }]
      });
    }
  }

  if (portal.id === 'zoopla' || portal.id === 'onthemarket') {
    const loc = locations[0];
    const base = LOCATION_COORDS[loc.toLowerCase()] || { lat: 51.5, lon: -0.1 };
    listings.push({
      title: '3 bedroom detached house for sale',
      price: 450000,
      address: `12 High Street, ${loc}`,
      bedrooms: 3,
      bathrooms: 2,
      type: 'Detached House',
      description: `A lovely 3 bedroom detached house with garden, parking. Located on High Street in ${loc}.`,
      image: IMAGES[0],
      lat: base.lat + 0.01,
      lon: base.lon + 0.01,
      sources: [{
        portal: portal.name,
        url: `https://${portal.id}.example.com/property/12-high-street-${loc.toLowerCase().replace(/\s/g, '-')}`
      }]
    });
  }

  return listings;
}

module.exports = { generate };
