const https = require('https');
const http = require('http');
const sharp = require('sharp');

let tf, cocoSsd, model;

async function loadModel() {
  if (model) return model;
  console.log('  Loading TensorFlow.js and COCO-SSD model...');
  tf = await import('@tensorflow/tfjs');
  cocoSsd = await import('@tensorflow-models/coco-ssd');
  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  console.log('  COCO-SSD model loaded');
  return model;
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'PropertySearchApp/1.0' }, timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const OUTDOOR_OBJECTS = new Set([
  'car', 'truck', 'bicycle', 'motorcycle', 'bus',
  'traffic light', 'stop sign', 'parking meter', 'fire hydrant',
  'bench', 'bird', 'dog', 'cat', 'horse', 'sheep', 'cow',
  'potted plant', 'boat', 'airplane', 'kite', 'umbrella',
]);

function isLikelyExterior(predictions) {
  return predictions.some(p => OUTDOOR_OBJECTS.has(p.class) && p.score >= 0.3);
}

async function analyzeImageForStructures(imgBuffer) {
  const { data, info } = await sharp(imgBuffer)
    .resize(320, 240, { fit: 'cover' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height;

  // Sobel edge detection
  const edges = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -data[(y - 1) * w + (x - 1)] + data[(y - 1) * w + (x + 1)]
        - 2 * data[y * w + (x - 1)] + 2 * data[y * w + (x + 1)]
        - data[(y + 1) * w + (x - 1)] + data[(y + 1) * w + (x + 1)];
      const gy =
        -data[(y - 1) * w + (x - 1)] - 2 * data[(y - 1) * w + x] - data[(y - 1) * w + (x + 1)]
        + data[(y + 1) * w + (x - 1)] + 2 * data[(y + 1) * w + x] + data[(y + 1) * w + (x + 1)];
      edges[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  // Threshold edges
  const threshold = 60;
  const binary = new Uint8Array(w * h);
  for (let i = 0; i < edges.length; i++) binary[i] = edges[i] > threshold ? 1 : 0;

  // Divide image into vertical thirds and count edge density
  const thirdW = Math.floor(w / 3);
  const edgeCounts = [0, 0, 0];
  const midY = Math.floor(h * 0.2);
  const botY = Math.floor(h * 0.85);

  for (let y = midY; y < botY; y++) {
    for (let x = 0; x < w; x++) {
      if (binary[y * w + x]) {
        const third = Math.min(Math.floor(x / thirdW), 2);
        edgeCounts[third]++;
      }
    }
  }

  // Count horizontal and vertical line segments (building indicators)
  let hLines = 0, vLines = 0;
  for (let y = midY; y < botY; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (binary[y * w + x]) { run++; } else { if (run > 30) hLines++; run = 0; }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = midY; y < botY; y++) {
      if (binary[y * w + x]) { run++; } else { if (run > 20) vLines++; run = 0; }
    }
  }

  return { edgeCounts, hLines, vLines };
}

async function analyzeProperty(property) {
  const images = property.images || [];
  if (!images.length || (images.length === 1 && images[0].includes('placehold'))) {
    return { neighbourDetected: false, confidence: 0 };
  }

  try {
    await loadModel();
  } catch (err) {
    console.error('  Failed to load COCO-SSD:', err.message);
    return { neighbourDetected: false, confidence: 0 };
  }

  let maxConfidence = 0;
  let detected = false;

  for (const imgUrl of images) {
    if (imgUrl.includes('placehold')) continue;

    try {
      const buf = await downloadImage(imgUrl);

      // Resize for COCO-SSD (expects 3-channel image)
      const { data, info } = await sharp(buf)
        .resize(300, 300, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Create tensor [1, 300, 300, 3]
      const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
      const predictions = await model.detect(tensor);
      tensor.dispose();

      const isExterior = isLikelyExterior(predictions);

      // Also check if image is aerial/exterior by color analysis
      const colorStats = await sharp(buf).resize(100, 100, { fit: 'cover' }).stats();
      const blueChannel = colorStats.channels[2];
      const greenChannel = colorStats.channels[1];
      const isAerial = blueChannel.mean > 140 && greenChannel.mean > 100;
      const hasGreenery = greenChannel.mean > 110 && greenChannel.mean > colorStats.channels[0].mean;

      if (!isExterior && !isAerial && !hasGreenery) continue;

      // Analyze for building structures
      const structures = await analyzeImageForStructures(buf);

      // Score: multiple building-like structures in different image regions
      const activeRegions = structures.edgeCounts.filter(c => c > 500).length;
      const hasLines = structures.hLines > 5 && structures.vLines > 3;

      // Confidence scoring
      let confidence = 0;

      // Multiple active edge regions suggest multiple structures
      if (activeRegions >= 2 && hasLines) {
        confidence = Math.min(0.7 + (activeRegions - 2) * 0.1 + (structures.hLines > 10 ? 0.1 : 0) + (structures.vLines > 5 ? 0.1 : 0), 0.99);
      }

      // COCO-SSD: multiple cars/objects in different regions suggest neighbouring properties
      const outdoorDetections = predictions.filter(p => OUTDOOR_OBJECTS.has(p.class) && p.score >= 0.5);
      if (outdoorDetections.length >= 3) {
        confidence = Math.max(confidence, 0.75);
      }

      // Strong edge activity on both sides of the image = buildings flanking
      const leftEdges = structures.edgeCounts[0];
      const rightEdges = structures.edgeCounts[2];
      if (leftEdges > 800 && rightEdges > 800 && hasLines) {
        confidence = Math.max(confidence, 0.92);
      }

      if (confidence > maxConfidence) maxConfidence = confidence;
      if (maxConfidence >= 0.9) { detected = true; break; }

    } catch {
      continue;
    }
  }

  if (maxConfidence >= 0.9) detected = true;

  return { neighbourDetected: detected, confidence: maxConfidence };
}

const SKIP_PATTERNS = [
  /\bsemi[-\s]?detached\b/i,
  /\blink[-\s]?detached\b/i,
  /\bend[-\s]?(?:of[-\s]?)?terrace\b/i,
  /\bterraced\b/i,
  /\bterrace\s+house\b/i,
  /\bflat\b/i,
  /\bapartment\b/i,
  /\bmaisonette\b/i,
];

function shouldAnalyze(property) {
  const text = `${property.title || ''} ${property.type || ''}`;
  if (SKIP_PATTERNS.some(re => re.test(text))) return false;
  return true;
}

async function analyzeProperties(results, confidenceThreshold = 0.95) {
  const candidates = results.filter(shouldAnalyze);
  const skipped = results.length - candidates.length;
  console.log(`  Analyzing ${candidates.length} detached/bungalow properties (skipping ${skipped} non-detached, threshold: ${(confidenceThreshold * 100).toFixed(0)}%)...`);
  let flagged = 0;

  for (let i = 0; i < results.length; i++) {
    if (!shouldAnalyze(results[i])) {
      results[i].neighbourDetected = false;
      results[i].neighbourConfidence = 0;
      results[i].neighbourSkipped = true;
      continue;
    }
    try {
      const analysis = await analyzeProperty(results[i]);
      results[i].neighbourConfidence = analysis.confidence;
      results[i].neighbourDetected = analysis.confidence >= confidenceThreshold;
      results[i].neighbourSkipped = false;
      if (results[i].neighbourDetected) flagged++;
      if ((i + 1) % 5 === 0) console.log(`    Analyzed ${i + 1}/${results.length}...`);
    } catch {
      results[i].neighbourDetected = false;
      results[i].neighbourConfidence = 0;
    }
  }

  console.log(`  Image analysis complete: ${flagged}/${candidates.length} candidates flagged`);
}

module.exports = { analyzeProperties };
