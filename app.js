const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Tesseract = require('tesseract.js');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

// Add stealth plugin to puppeteer (helps avoid detection)
puppeteer.use(StealthPlugin());

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Create logs directory if it doesn't exist
const ensureLogDir = async () => {
  try {
    await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });
  } catch (err) {
    console.error('Failed to create logs directory:', err);
  }
};

ensureLogDir();

// Simple logging function
const logToFile = async (message, type = 'info') => {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
  
  try {
    await fs.appendFile(
      path.join(__dirname, 'logs', `takealot-${new Date().toISOString().split('T')[0]}.log`),
      logEntry
    );
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
  
  // Also log to console
  console[type === 'error' ? 'error' : 'log'](message);
};

// API endpoint to get prices for a search term
app.get('/api/prices', async (req, res) => {
  const searchTerm = req.query.search;
  const debug = req.query.debug === 'true';
  
  if (!searchTerm) {
    return res.status(400).json({ error: 'Search term is required' });
  }
  
  try {
    await logToFile(`Processing search for: ${searchTerm}`);
    const priceData = await getScreenshotAndExtractPrices(searchTerm, debug);
    await logToFile(`Found ${priceData.results.totalPricesFound} prices for ${searchTerm}`);
    res.json(priceData);
  } catch (error) {
    await logToFile(`Error processing request: ${error.message}`, 'error');
    res.status(500).json({ error: 'Failed to process request', message: error.message });
  }
});

// Function to scroll and take screenshot
async function autoScroll(page) {
  await logToFile("Starting page scroll...");
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
  await logToFile("Page scroll completed");
}

// Main function to get screenshot and extract prices
async function getScreenshotAndExtractPrices(searchTerm, debug = false) {
  await logToFile("Launching browser...");
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
      '--window-size=1920,1080',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
    ],
    ignoreHTTPSErrors: true
  });
  
  const page = await browser.newPage();
  const debugId = Date.now();
  
  try {
    // Additional page configurations
    await page.setDefaultNavigationTimeout(90000);
    await page.setRequestInterception(true);
    
    // Skip unnecessary resources to speed up loading
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    // Set viewport to a common desktop resolution
    await page.setViewport({
      width: 1920,
      height: 1080
    });
    
    // Navigate to search results page
    const encodedQuery = encodeURIComponent(searchTerm);
    const url = `https://www.takealot.com/all?qsearch=${encodedQuery}`;
    await logToFile(`Navigating to ${url}`);
    
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    } catch (e) {
      await logToFile(`Navigation timed out: ${e.message}`, 'error');
      // Try to continue anyway
    }

    // Save page HTML for debugging if requested
    if (debug) {
      const html = await page.content();
      await fs.writeFile(`debug-page-${debugId}.html`, html);
      await logToFile(`Debug HTML saved to debug-page-${debugId}.html`);
    }

    // Accept cookie if needed
    try {
      await logToFile("Looking for cookie banner...");
      await page.waitForSelector('button[class*="cookie"]', { timeout: 5000 });
      await page.click('button[class*="cookie"]');
      await logToFile("Cookie banner accepted");
    } catch (error) {
      await logToFile("No cookie banner found or couldn't interact with it");
    }

    // Wait for product grid to load - try multiple selectors
    await logToFile("Waiting for product content to load...");
    const productSelectors = ['[data-ref="product-grid"]', '.product-grid', '.search-results', '.listings-container'];
    let productGridFound = false;
    
    for (const selector of productSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await logToFile(`Product grid found with selector: ${selector}`);
        productGridFound = true;
        break;
      } catch (error) {
        await logToFile(`Product grid selector ${selector} not found, trying next...`);
      }
    }
    
    if (!productGridFound) {
      await logToFile("No product grid selector matched, continuing anyway", 'warn');
    }

    // Scroll to load more products
    await autoScroll(page);
    
    // Wait a bit more after scrolling to ensure all content is loaded
    await logToFile("Waiting for lazy-loaded content...");
    await page.waitForTimeout(3000);

    // Attempt to extract prices using multiple DOM strategies
    await logToFile("Attempting to extract prices from DOM...");
    
    // Try different methods to find prices
    const pricesFromDOM = await page.evaluate(() => {
      const getPricesFromElements = (selectors) => {
        const prices = [];
        
        selectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          elements.forEach(element => {
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
        });
        
        return prices;
      };
      
      // Try multiple selectors that might contain prices
      const selectors = [
        '[data-ref="price"]', 
        '.product-price',
        '.price',
        '.listing-price',
        '.amount',
        '.currency-amount',
        'span:contains("R")',
        '.info-price'
      ];
      
      return getPricesFromElements(selectors);
    });
    
    await logToFile(`Found ${pricesFromDOM.length} prices from DOM`);
    
    let prices = pricesFromDOM;
    
    // If DOM extraction found few prices, try direct HTML search
    if (prices.length < 5) {
      await logToFile("Few prices found with DOM selectors, trying HTML regex...");
      
      const htmlContent = await page.content();
      const priceRegex = /R\s?(\d{1,3}(,\d{3})*(\.\d{1,2})?)/g;
      let match;
      const pricesFromHTML = [];
      
      while ((match = priceRegex.exec(htmlContent)) !== null) {
        const price = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(price) && price > 0) {
          pricesFromHTML.push(price);
        }
      }
      
      await logToFile(`Found ${pricesFromHTML.length} prices from HTML regex`);
      
      // If HTML regex found more prices, use those instead
      if (pricesFromHTML.length > prices.length) {
        prices = pricesFromHTML;
      }
    }
    
    // If both methods failed, fall back to OCR
    if (prices.length < 5) {
      await logToFile("DOM extraction found few prices, falling back to OCR...");
      
      // Take screenshot as buffer (in memory) instead of saving to disk
      await logToFile("Taking screenshot...");
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      
      // Save screenshot for debugging
      if (debug) {
        await fs.writeFile(`debug-screenshot-${debugId}.png`, screenshotBuffer);
        await logToFile(`Debug screenshot saved to debug-screenshot-${debugId}.png`);
      }
      
      // Process the screenshot buffer directly with Tesseract
      await logToFile("Processing screenshot with OCR...");
      const result = await Tesseract.recognize(screenshotBuffer, 'eng');
      const rawText = result.data.text;
      
      // Save OCR text for debugging
      if (debug) {
        await fs.writeFile(`debug-ocr-${debugId}.txt`, rawText);
        await logToFile(`Debug OCR text saved to debug-ocr-${debugId}.txt`);
      }

      // Parse R prices from text
      const priceMatches = [...rawText.matchAll(/R\s?(\d{1,3}(,\d{3})*(\.\d{1,2})?)/g)];
      
      // Clean up and convert to numbers
      const pricesFromOCR = priceMatches.map(match => {
        // Remove commas and convert to float
        return parseFloat(match[1].replace(/,/g, ''));
      }).filter(price => !isNaN(price) && price > 0);
      
      await logToFile(`Found ${pricesFromOCR.length} prices from OCR`);
      
      // If OCR found more prices, use those
      if (pricesFromOCR.length > prices.length) {
        prices = pricesFromOCR;
      }
    }

    // Calculate statistics
    const stats = calculatePriceStats(prices);

    return {
      searchTerm,
      timestamp: new Date().toISOString(),
      results: {
        totalPricesFound: prices.length,
        prices: prices,
        stats,
        debugId: debug ? debugId : undefined
      }
    };
  } catch (error) {
    await logToFile(`Error in scraping process: ${error.message}`, 'error');
    throw error;
  } finally {
    await logToFile("Closing browser");
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

// Debug endpoint to get logs
app.get('/api/logs', async (req, res) => {
  try {
    const logDir = path.join(__dirname, 'logs');
    const files = await fs.readdir(logDir);
    const latestLogFile = files
      .filter(file => file.startsWith('takealot-'))
      .sort()
      .pop();
      
    if (!latestLogFile) {
      return res.status(404).json({ error: 'No log files found' });
    }
    
    const logContent = await fs.readFile(path.join(logDir, latestLogFile), 'utf8');
    res.set('Content-Type', 'text/plain');
    res.send(logContent);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve logs', message: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  logToFile(`🚀 Takealot Price API is running on port ${PORT}`);
  logToFile(`📊 Try it out: http://localhost:${PORT}/api/prices?search=phone`);
  logToFile(`🔍 Health check: http://localhost:${PORT}/api/health`);
  logToFile(`📝 Logs: http://localhost:${PORT}/api/logs`);
});

module.exports = app;