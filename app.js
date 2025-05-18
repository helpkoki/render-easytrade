const express = require('express');
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const cors = require('cors');

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// API endpoint to get prices for a search term
app.get('/api/prices', async (req, res) => {
  const searchTerm = req.query.search;
  
  if (!searchTerm) {
    return res.status(400).json({ error: 'Search term is required' });
  }
  
  try {
    console.log(`Processing search for: ${searchTerm}`);
    const priceData = await getScreenshotAndExtractPrices(searchTerm);
    console.log(`Found ${priceData.results.totalPricesFound} prices for ${searchTerm}`);
    res.json(priceData);
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to process request', message: error.message });
  }
});

// Function to scroll and take screenshot
async function autoScroll(page) {
  console.log("Starting page scroll...");
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
      }, 300); // Increased scroll time interval for better loading
    });
  });
  console.log("Page scroll completed");
}

// Main function to get screenshot and extract prices
async function getScreenshotAndExtractPrices(searchTerm) {
  console.log("Launching browser...");
  const browser = await puppeteer.launch({ 
    headless: true,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1920,1080'
    ]
  });
  
  const page = await browser.newPage();
  
  try {
    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36');
    
    // Set viewport to a common desktop resolution
    await page.setViewport({
      width: 1920,
      height: 1080
    });
    
    // Navigate to search results page
    const encodedQuery = encodeURIComponent(searchTerm);
    const url = `https://www.takealot.com/all?qsearch=${encodedQuery}`;
    console.log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

    // Accept cookie if needed
    try {
      console.log("Looking for cookie banner...");
      await page.waitForSelector('button[class*="cookie"]', { timeout: 5000 });
      await page.click('button[class*="cookie"]');
      console.log("Cookie banner accepted");
    } catch (error) {
      console.log("No cookie banner found or couldn't interact with it");
    }

    // Wait for product grid to load
    console.log("Waiting for product content to load...");
    try {
      await page.waitForSelector('[data-ref="product-grid"]', { timeout: 10000 });
      console.log("Product grid found");
    } catch (error) {
      console.log("Product grid selector not found, continuing anyway");
    }

    // Scroll to load more products
    await autoScroll(page);
    
    // Wait a bit more after scrolling to ensure all content is loaded
    console.log("Waiting for lazy-loaded content...");
    await page.waitForTimeout(2000);

    // Attempt to extract prices using DOM first (more reliable than OCR)
    console.log("Attempting to extract prices from DOM...");
    const pricesFromDOM = await page.evaluate(() => {
      const priceElements = document.querySelectorAll('[data-ref="price"]');
      const prices = [];
      
      priceElements.forEach(element => {
        const priceText = element.textContent.trim();
        const match = priceText.match(/R\s?(\d{1,3}(,\d{3})*(\.\d{1,2})?)/);
        if (match) {
          // Remove commas and convert to float
          const price = parseFloat(match[1].replace(/,/g, ''));
          if (!isNaN(price) && price > 0) {
            prices.push(price);
          }
        }
      });
      
      return prices;
    });
    
    console.log(`Found ${pricesFromDOM.length} prices from DOM`);
    
    let prices = pricesFromDOM;
    
    // If DOM extraction failed, fall back to OCR
    if (prices.length === 0) {
      console.log("DOM extraction found no prices, falling back to OCR...");
      
      // Take screenshot as buffer (in memory) instead of saving to disk
      console.log("Taking screenshot...");
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      
      // Process the screenshot buffer directly with Tesseract
      console.log("Processing screenshot with OCR...");
      const result = await Tesseract.recognize(screenshotBuffer, 'eng');
      const rawText = result.data.text;

      // Parse R prices from text
      const priceMatches = [...rawText.matchAll(/R\s?(\d{1,3}(,\d{3})*(\.\d{1,2})?)/g)];
      
      // Clean up and convert to numbers
      prices = priceMatches.map(match => {
        // Remove commas and convert to float
        return parseFloat(match[1].replace(/,/g, ''));
      }).filter(price => !isNaN(price) && price > 0);
      
      console.log(`Found ${prices.length} prices from OCR`);
    }

    // For debugging, save the screenshot if no prices were found
    if (prices.length === 0) {
      console.log("WARNING: No prices found. Saving screenshot for debugging...");
      await page.screenshot({ path: 'debug-screenshot.png' });
      console.log("Debug screenshot saved to debug-screenshot.png");
    }

    // Calculate statistics
    const stats = calculatePriceStats(prices);

    return {
      searchTerm,
      timestamp: new Date().toISOString(),
      results: {
        totalPricesFound: prices.length,
        prices: prices,
        stats
      }
    };
  } catch (error) {
    console.error("Error in scraping process:", error);
    throw error;
  } finally {
    console.log("Closing browser");
    await browser.close();
  }
}

// Calculate price statistics
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
  
  let median;
  const mid = Math.floor(sortedPrices.length / 2);
  if (sortedPrices.length % 2 === 0) {
    median = (sortedPrices[mid - 1] + sortedPrices[mid]) / 2;
  } else {
    median = sortedPrices[mid];
  }

  return {
    average: parseFloat(average.toFixed(2)),
    median: parseFloat(median.toFixed(2)),
    min: sortedPrices[0],
    max: sortedPrices[sortedPrices.length - 1],
    count: prices.length
  };
}

// Add a debug endpoint to test connection and browser
app.get('/api/health', async (req, res) => {
  try {
    // Test if we can launch browser
    const browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    await browser.close();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        memory: process.memoryUsage()
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Takealot Price API is running on port ${PORT}`);
  console.log(`📊 Try it out: http://localhost:${PORT}/api/prices?search=phone`);
  console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;