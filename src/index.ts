import 'dotenv/config';
import { Page } from "playwright";
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import type { Request as PWRequest } from 'playwright';
import { Firestore } from '@google-cloud/firestore';

chromium.use(stealth());


interface Vehicle {
  id: number;
  make: string;
  model: string;
  year: number;
  avgDailyPrice: { amount: number; currency: string };
  images: { originalImageUrl: string }[];
  location: {
    city: string;
    country: string;
    isDelivery: boolean;
    locationId: number | null;
  };
}

interface Quote {
  totalTripPrice: { amount: number; currencyCode: string };
  vehicleDailyPrice: { amount: number; currencyCode: string };
  discountSavingsText: string | null;
}

const dirPath = path.resolve(__dirname, '../vehiclesJSON');
if (!fs.existsSync(dirPath)) {
  fs.mkdirSync(dirPath, { recursive: true });
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!);
const firestore = new Firestore({
  projectId: process.env.FIREBASE_PROJECT_ID,
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key.replace(/\\n/g, '\n')
  }
});

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function scrapeSearchUrl(page: Page, url: string) {
  const searchRequestPromise = page.waitForRequest(req =>
    req.url().includes('/api/v2/search') && req.method() === 'POST'
  );

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const searchReq = await searchRequestPromise;
  const searchPayload = JSON.parse(searchReq.postData()!);
  const { filters: nestedFilters } = searchPayload;
  const { start: startDateTime, end: endDateTime } = nestedFilters.dates;
  const age = nestedFilters.age;

  const filteredRes = await page.waitForResponse(
    res => res.url().includes('/api/v2/search') && res.status() === 200,
    { timeout: 60000 }
  );
  const searchJson = await filteredRes.json() as any;
  const vehicles = (searchJson.vehicles ?? []) as Vehicle[];
  let region = searchJson.searchLocation?.region as string | undefined;

  if (!region) {
    console.warn('⚠️  Falta searchLocation.region; extrayendo de la URL');
    const urlObj = new URL(url);
    region = urlObj.searchParams.get('region') ?? '';
  }


  const allQuotes: Record<string, Quote> = {};

  const vehicleChunks = chunkArray(vehicles, 20);
  for (const chunk of vehicleChunks) {
    const apiEstimatedQuoteLocationDtoMap = chunk.reduce((acc:any, v:any) => {
      acc[v.id.toString()] = {
        isDelivery: v.location.isDelivery,
        locationId: v.location.locationId,
      };
      return acc;
    }, {} as Record<string, { isDelivery: boolean; locationId: number | null }>);

    const payload = {
      age,
      apiEstimatedQuoteLocationDtoMap,
      startDateTime,
      endDateTime,
      region,
      searchRegion: region,
    };

    const quoteJson = await page.evaluate(async body => {
      const resp = await fetch('/api/bulk-quotes/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return resp.json();
    }, payload) as { estimatedQuotes: Record<string, Quote> };

    Object.assign(allQuotes, quoteJson.estimatedQuotes);
  }

  const days = Math.round(
    (new Date(endDateTime).getTime() - new Date(startDateTime).getTime())
    / (1000 * 60 * 60 * 24)
  );

  return vehicles.map(v => {
    const q = allQuotes[v.id.toString()];
    return {
      id: v.id,
      title: `${v.year} ${v.make} ${v.model}`,
      image: v.images[0]?.originalImageUrl ?? null,
      totalQuoted: q?.totalTripPrice.amount != null
        ? Math.round(q.totalTripPrice.amount)
        : null,
      position: vehicles.findIndex(x => x.id === v.id) + 1,
    };
  });
}


(async () => {
  const USER_AGENTS = [
    // Chrome en Windows 10
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.170 Safari/537.36",

    // Safari en macOS Catalina
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15",

    // Firefox en Ubuntu Linux
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:102.0) Gecko/20100101 Firefox/102.0",

    // Chrome en Android
    "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.199 Mobile Safari/537.36",

    // Safari en iPhone
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1",
  ];

  function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const urls = [
    'https://turo.com/us/en/search?age=25&country=US&defaultZoomLevel=13&endDate=06%2F28%2F2025&endTime=09%3A00&fuelTypes=ELECTRIC&isMapSearch=false&itemsPerPage=200&latitude=25.79587&location=MIA%20-%20Miami%20International%20Airport&locationType=AIRPORT&longitude=-80.28705&pickupType=ALL&placeId=ChIJwUq5Tk232YgR4fiiy-Dan5g&region=FL&sortType=RELEVANCE&startDate=06%2F25%2F2025&startTime=10%3A00&useDefaultMaximumDistance=true',// URL 1
    'https://turo.com/us/en/search?age=25&country=US&defaultZoomLevel=11&endDate=06%2F29%2F2025&endTime=10%3A00&fromYear=2024&fuelTypes=ELECTRIC&isMapSearch=false&itemsPerPage=200&latitude=25.79587&location=MIA%20-%20Miami%20International%20Airport&locationType=AIRPORT&longitude=-80.28705&makes=Tesla&pickupType=ALL&placeId=ChIJwUq5Tk232YgR4fiiy-Dan5g&region=FL&sortType=RELEVANCE&startDate=06%2F26%2F2025&startTime=10%3A00&toYear=2026&useDefaultMaximumDistance=true', // URL 2
    'https://turo.com/us/en/search?age=25&country=US&defaultZoomLevel=13&endDate=06%2F28%2F2025&endTime=09%3A00&isMapSearch=false&itemsPerPage=200&latitude=25.79587&location=MIA%20-%20Miami%20International%20Airport&locationType=AIRPORT&longitude=-80.28705&pickupType=ALL&placeId=ChIJwUq5Tk232YgR4fiiy-Dan5g&region=FL&sortType=RELEVANCE&startDate=06%2F25%2F2025&startTime=10%3A00&useDefaultMaximumDistance=true', // URL 3
  ];

  for (let i = 0; i < urls.length; i++) {

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: pickRandom(USER_AGENTS),
    });

    const page = await context.newPage();

    try {
      const result = await scrapeSearchUrl(page, urls[i]);

      // const outPath = path.resolve(__dirname, `../vehiclesJSON/vehicles-${i + 1}-${Date.now()}.json`);
      // fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
      // console.log(`✅ URL ${i + 1}: guardado ${result.length} vehículos en ${outPath}`);


      const colName = `vehicles-url-${i + 1}`;
      const executionRef = firestore.collection(colName).doc();

      await executionRef.set({
        scrapedAt: new Date(),
        executionData: result  
      });

      console.log(`✅ Volcados ${result.length} vehículos a Firestore (${colName})`);

      await page.mouse.move(100, 100);
      await page.waitForTimeout(500 + Math.random() * 500);
      await page.mouse.move(200, 200);

    } catch (err) {

      console.error(`❌ Error scraping URL ${i + 1}:`, err);
    } finally {

      const delay = 2000 + Math.random() * 2000;
      console.log(`⏱ Esperando ${Math.round(delay)} ms antes de la siguiente URL…`);
      await page.waitForTimeout(delay);

      await page.close();
      await context.close();
    }
  }

  await browser.close();
})();
