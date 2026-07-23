'use strict';
/**
 * One-time setup: downloads GeoNames cities1000 dump, filters for UK towns
 * with population >= MIN_POP, and writes property-search/public/uk-towns.json.
 *
 * Run from MetaHouseSearcher-static/:
 *   node scripts/fetch-uk-towns.js
 *   node scripts/fetch-uk-towns.js --min-pop=5000
 */
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');

const MIN_POP_ARG = process.argv.find(a => a.startsWith('--min-pop='));
const MIN_POP  = MIN_POP_ARG ? parseInt(MIN_POP_ARG.split('=')[1]) : 10000;
const OUT_FILE = path.join(__dirname, '..', '..', 'property-search', 'public', 'uk-towns.json');
const TMP_DIR  = path.join(__dirname, '..', '..', 'property-search', '.tmp-geonames');
const TMP_ZIP  = path.join(TMP_DIR, 'cities1000.zip');
const TMP_TXT  = path.join(TMP_DIR, 'cities1000.txt');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req  = https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', chunk => {
        received += chunk.length;
        if (total) process.stdout.write(`\r  ${Math.round(received / total * 100)}%`);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
    });
    req.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  console.log('Downloading GeoNames cities1000.zip (~7 MB)…');
  await download('https://download.geonames.org/export/dump/cities1000.zip', TMP_ZIP);

  console.log('Extracting…');
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${TMP_ZIP}' -DestinationPath '${TMP_DIR}' -Force"`,
    { stdio: 'pipe' }
  );

  console.log(`Parsing — filtering GB, population >= ${MIN_POP.toLocaleString()}…`);
  const lines = fs.readFileSync(TMP_TXT, 'utf8').split('\n');
  const towns = [];
  for (const line of lines) {
    const f = line.split('\t');
    if (f.length < 15) continue;
    if (f[8] !== 'GB')  continue;         // country code
    if (f[6] !== 'P')   continue;         // feature class: populated place
    const pop = parseInt(f[14], 10);
    if (isNaN(pop) || pop < MIN_POP) continue;
    towns.push({ name: f[1], lat: parseFloat(f[4]), lon: parseFloat(f[5]), pop });
  }
  towns.sort((a, b) => b.pop - a.pop);

  fs.writeFileSync(OUT_FILE, JSON.stringify(towns, null, 2));
  console.log(`Saved ${towns.length} UK towns (pop >= ${MIN_POP.toLocaleString()}) → ${OUT_FILE}`);

  // Cleanup temp files
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch(err => { console.error(err.message); process.exit(1); });
