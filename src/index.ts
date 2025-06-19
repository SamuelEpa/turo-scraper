import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import type { Request as PWRequest } from 'playwright';

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


  const filteredReqPromise = page.waitForRequest((req: PWRequest) =>
    req.url().includes('/api/v2/search') &&
    req.method() === 'POST' &&
    (req.postData() || '').includes('"filters"')
  );


  const searchUrl =
    'https://turo.com/us/en/search?age=25&country=US&defaultZoomLevel=11&deliveryLocationType=airport&endDate=06%2F30%2F2025&endTime=10%3A00&fromYear=2024&fuelTypes=ELECTRIC&isMapSearch=false&itemsPerPage=200&latitude=28.43116&location=MCO%20-%20Orlando%20International%20Airport&locationType=AIRPORT&longitude=-81.30808&makes=Tesla&models=Cybertruck&models=Model%203&models=Model%20S&models=Model%20X&models=Model%20Y&models=Roadster&pickupType=ALL&placeId=ChIJ85K0xidj54gRbeERlDa5Sq0&region=FL&sortType=RELEVANCE&startDate=06%2F27%2F2025&startTime=10%3A00&toYear=2026&useDefaultMaximumDistance=true';
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const filteredReq = await filteredReqPromise;

  const filteredRes = await page.waitForResponse(
    res =>
      res.url().includes('/api/v2/search') &&
      res.status() === 200,
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


  const startDateTime = '2025-06-27T10:00';
  const endDateTime = '2025-06-30T10:00';
  const region = searchJson.searchLocation.region; 
  const apiEstimatedQuoteLocationDtoMap: Record<string, { isDelivery: boolean; locationId: number | null }> =
    vehicles.reduce((acc, v) => {
      acc[v.id.toString()] = {
        isDelivery: v.location.isDelivery,
        locationId: v.location.locationId,
      };
      return acc;
    }, {} as any);

  const bulkQuotePayload = {
    age: 25,
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
  }, bulkQuotePayload) as { estimatedQuotes: Record<string, Quote> };


  const days = Math.round(
    (new Date(endDateTime).getTime() -
      new Date(startDateTime).getTime()) /
    (1000 * 60 * 60 * 24)
  );
  const result = vehicles.map(v => {
    const q = quoteJson.estimatedQuotes[v.id.toString()];
    return {
      id: v.id,
      title: `${v.year} ${v.make} ${v.model}`,
      dailyAvg: v.avgDailyPrice.amount,
      dailyQuoted: q?.vehicleDailyPrice.amount ?? null,
      days,
      totalQuoted: Math.round(q?.totalTripPrice.amount ?? null),
      image: v.images[0]?.originalImageUrl ?? null,
    };
  });


  const random = Math.random()
  const outPath = path.resolve(__dirname, `../vehiclesJSON/vehicles-${random}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`✅ Guardado ${result.length} vehículos en ${outPath}`);


  await browser.close();
})();
