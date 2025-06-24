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

(async () => {

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/115.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();


  const searchRequestPromise = page.waitForRequest((req: PWRequest) =>
    req.url().includes('/api/v2/search') &&
    req.method() === 'POST'
  );


  const searchUrl =
    'https://turo.com/us/en/search?age=25&country=US&defaultZoomLevel=13.110126811423536&endDate=06%2F22%2F2025&endTime=10%3A00&isMapSearch=false&itemsPerPage=200&latitude=25.79587&location=MIA%20-%20Miami%20International%20Airport&locationType=AIRPORT&longitude=-80.28705&pickupType=ALL&placeId=ChIJwUq5Tk232YgR4fiiy-Dan5g&region=FL&sortType=RELEVANCE&startDate=06%2F19%2F2025&startTime=19%3A30&useDefaultMaximumDistance=true';
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const searchReq = await searchRequestPromise;
  const searchPayload = JSON.parse(searchReq.postData()!);
  const nestedFilters = searchPayload.filters;
  const startDateTime = nestedFilters.dates.start;
  const endDateTime = nestedFilters.dates.end;
  const age = nestedFilters.age;   

  const filteredRes = await page.waitForResponse(
    res => res.url().includes('/api/v2/search') && res.status() === 200,
    { timeout: 60000 }
  );


  const searchJson = await filteredRes.json();
  const vehicles = (searchJson.vehicles ?? []) as Vehicle[];
  console.log(`Vehículos capturados: ${vehicles.length}`);
  if (!vehicles.length) {
    console.error('⚠️ No se encontraron vehículos.');
    await browser.close();
    return;
  }

  const region = searchJson.searchLocation.region; 

  const allQuotes: Record<string, Quote> = {};

  function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  const vehicleChunks = chunkArray(vehicles, 20);

  for (const chunk of vehicleChunks) {
    const apiEstimatedQuoteLocationDtoMap = chunk.reduce((acc, v) => {
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
    (new Date(endDateTime).getTime() -
      new Date(startDateTime).getTime()) /
    (1000 * 60 * 60 * 24)
  );

  const result = vehicles.map(v => {
    const q = allQuotes[v.id.toString()];
    return {
      id: v.id,
      title: `${v.year} ${v.make} ${v.model}`,
      // dailyAvg: v.avgDailyPrice.amount,
      // dailyQuoted: q?.vehicleDailyPrice.amount ?? null,
      // days,
      totalQuoted: q?.totalTripPrice.amount != null
        ? Math.round(q.totalTripPrice.amount)
        : null,
      image: v.images[0]?.originalImageUrl ?? null,
      position: vehicles.findIndex(x => x.id === v.id) + 1
    };
  });

  // const outPath = path.resolve(__dirname, `../vehiclesJSON/vehicles-${Date.now()}.json`);
  // fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
  // console.log(`✅ Guardado ${result.length} vehículos en ${outPath}`);

  const scrapedAt = new Date(); 

  const executionRef = firestore.collection('vehicles').doc();

  await executionRef.set({
    scrapedAt: scrapedAt,
    executionData: result  
  });

  console.log(`✅ Volcados ${result.length} vehículos a Firestore`);

  await browser.close();
})();
