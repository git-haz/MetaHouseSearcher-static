const { getBrowser } = require('../browser');

async function scrape(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 8000));

    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 2000));

    const listings = await page.evaluate(() => {
      const results = [];
      const els = document.querySelectorAll('[class*="e-loop-item"][class*="type-property"]');

      for (const el of els) {
        const cls = el.className;

        // Skip sold/STC
        if (cls.includes('availability-sold') || cls.includes('availability-sold-stc')) continue;

        const text = el.textContent.trim();

        // Price
        const priceMatch = text.match(/£([\d,]+)/);
        if (!priceMatch) continue;
        const price = parseInt(priceMatch[1].replace(/,/g, ''));

        // Address — first substantial text line
        let address = '';
        const textLines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 3);
        for (const line of textLines) {
          if (line.match(/^[A-Z]/) && !line.match(/^(Price|Guide|Asking|Offers|Sold|bed|bath|chair|\.elementor)/i) && line.length < 100) {
            address = line;
            break;
          }
        }

        // Beds, baths, receptions
        const bedsMatch = text.match(/bed(\d+)/);
        const bathsMatch = text.match(/bathtub(\d+)/);

        // Description
        let description = '';
        const descMatch = text.match(/(?:A |This |An |Set |Built |Situated |Charming |Beautiful |Spacious |Offered |Formerly |Plot )[\s\S]{20,250}/i);
        if (descMatch) description = descMatch[0].trim().replace(/\s+/g, ' ');

        // Image
        const img = el.querySelector('img');
        const imgSrc = img?.src || '';
        const images = imgSrc ? [imgSrc.replace(/-\d+x\d+\./, '-768x512.')] : [];

        // Detail URL — find the property link within this card
        const propertyLink = el.querySelector('a[href*="/property/"]');
        let detailUrl = propertyLink ? propertyLink.href : '';
        if (!detailUrl && address) {
          const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          detailUrl = `https://durrants.com/property/${slug}/`;
        }

        const beds = bedsMatch ? parseInt(bedsMatch[1]) : null;
        const baths = bathsMatch ? parseInt(bathsMatch[1]) : null;

        let title = '';
        if (beds) title += `${beds} bed `;
        title += 'property for sale';

        results.push({
          title,
          price,
          address: address || 'Address not available',
          bedrooms: beds,
          bathrooms: baths,
          sqft: null,
          type: 'Property',
          description,
          postedDate: null,
          agent: 'Durrants',
          agentPhone: null,
          images: images.length > 0 ? images : ['https://placehold.co/400x300/e0e0e0/999?text=No+Image'],
          sources: [{ portal: 'Durrants', url: detailUrl || url }],
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
