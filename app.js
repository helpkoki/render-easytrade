const express = require('express');
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

app.get('/api/prices', async (req, res) => {
  const searchTerm = req.query.search;

  if (!searchTerm) {
    return res.status(400).json({ error: 'Search term is required' });
  }

  try {
    const priceData = await getScreenshotAndExtractPrices(searchTerm);
    res.json(priceData);
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to process request', message: error.message });
  }
});

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

async function getScreenshotAndExtractPrices(searchTerm) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-infobars'
    ]
  });

  const page = await browser.newPage();

  try {
    const encodedQuery = encodeURIComponent(searchTerm);
    const url = `https://www.takealot.com/all?qsearch=${encodedQuery}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Accept cookie banner if present
    try {
      await page.waitForSelector('button[class*="cookie"]', { timeout: 3000 });
      await page.click('button[class*="cookie"]');
    } catch (error) {
      // Continue if no cookie banner
    }

    await autoScroll(page);

    // Wait for price elements to load
    await page.waitForSelector('[class*="price"]', { timeout: 10000 });

    // Optional: debug screenshot
    // await page.screenshot({ path: 'debug.png', fullPage: true });

    const screenshotBuffer = await page.screenshot({ fullPage: true });

    const result = await Tesseract.recognize(screenshotBuffer, 'eng');
    const rawText = result.data.text;

    const priceMatches = [...rawText.matchAll(/R\s?(\d{1,3}(,\d{3})*(\.\d{1,2})?)/g)];

    const prices = priceMatches.map(match => {
      return parseFloat(match[1].replace(/,/g, ''));
    }).filter(price => !isNaN(price) && price > 0);

    const stats = calculatePriceStats(prices);

    return {
      searchTerm,
      timestamp: new Date().toISOString(),
      results: {
        totalPricesFound: prices.length,
        prices,
        stats
      }
    };
  } catch (error) {
    throw error;
  } finally {
    await browser.close();
  }
}

function calculatePriceStats(prices) {
  if (prices.length === 0) {
    return {
      average: 0,
      median: 0,
      min: 0,
      max: 0,
      count: 0
    };
  }

  const sortedPrices = [...prices].sort((a, b) => a - b);
  const sum = prices.reduce((acc, price) => acc + price, 0);
  const average = sum / prices.length;
  const mid = Math.floor(sortedPrices.length / 2);
  const median = sortedPrices.length % 2 === 0
    ? (sortedPrices[mid - 1] + sortedPrices[mid]) / 2
    : sortedPrices[mid];

  return {
    average: parseFloat(average.toFixed(2)),
    median: parseFloat(median.toFixed(2)),
    min: sortedPrices[0],
    max: sortedPrices[sortedPrices.length - 1],
    count: prices.length
  };
}

app.listen(PORT, () => {
  console.log(`🚀 Takealot Price API is running on port ${PORT}`);
  console.log(`📊 Try it out: http://localhost:${PORT}/api/prices?search=phone`);
});

module.exports = app;
