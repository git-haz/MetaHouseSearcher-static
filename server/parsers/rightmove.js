const { getBrowser } = require('../browser');

async function scrape(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 12000));

    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 2000));

    const listings = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('.propertyCard-details');

      for (const card of cards) {
        const text = card.textContent.trim();

        // Price
        const priceMatch = text.match(/£([\d,]+)/);
        if (!priceMatch) continue;
        const price = parseInt(priceMatch[1].replace(/,/g, ''));

        // Link
        const link = card.querySelector('a[href*="/properties/"]');
        const href = link ? link.href : '';

        // Image
        const img = card.querySelector('img[src*="media.rightmove"]');
        const imgSrc = img?.src || '';
        const images = imgSrc ? [imgSrc] : [];

        // Parse text: after price comes qualifier, then address, type, beds, description
        const afterPrice = text.replace(/^[\s\S]*?£[\d,]+/, '');
        const qualMatch = afterPrice.match(/^(Offers Over|Guide Price|Asking Price|Offers in Excess of)/i);
        let remainder = qualMatch ? afterPrice.replace(qualMatch[0], '') : afterPrice;
        // Strip "With Land" etc
        remainder = remainder.replace(/^(With Land)\s*/i, '').trim();

        // Type
        const typeMatch = remainder.match(/\b(Detached Bungalow|Semi-Detached Bungalow|Detached|Semi-Detached|Terraced|Flat|Bungalow|Cottage|End of Terrace|Town House|Maisonette|Penthouse|Link-Detached)\b/i);
        const type = typeMatch ? typeMatch[1] : '';

        // Address: text before the type
        let address = '';
        if (typeMatch) {
          address = remainder.substring(0, typeMatch.index).trim();
        }

        // Beds: number right after type
        const bedsMatch = remainder.match(new RegExp((type ? type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'NOTYPE') + '\\s*(\\d+)', 'i'));
        const beds = bedsMatch ? parseInt(bedsMatch[1]) : null;

        // Agent and date
        const agentMatch = text.match(/Added on (\d{2}\/\d{2}\/\d{4}) by (.+?)(?:Added|$)/i);
        const postedDate = agentMatch ? agentMatch[1] : null;
        const agent = agentMatch ? agentMatch[2].trim() : null;

        // Description
        let description = '';
        if (typeMatch && beds != null) {
          const descStart = remainder.indexOf(String(beds), typeMatch.index) + String(beds).length;
          description = remainder.substring(descStart).replace(/Added on.*$/i, '').trim();
        }

        let title = '';
        if (beds) title += `${beds} bed `;
        title += (type || 'property').toLowerCase() + ' for sale';

        results.push({
          title,
          price,
          address: address || 'Address not available',
          bedrooms: beds,
          bathrooms: null,
          sqft: null,
          type: type || 'Property',
          description: description.substring(0, 300),
          postedDate,
          agent: agent || 'Rightmove',
          agentPhone: null,
          images: images.length > 0 ? images : ['https://placehold.co/400x300/e0e0e0/999?text=No+Image'],
          sources: [{ portal: 'Rightmove', url: href || url }],
          lat: null,
          lon: null,
        });
      }

      return results;
    });

    return listings;
  } finally {
    await page.close();
  }
}

module.exports = { scrape };
