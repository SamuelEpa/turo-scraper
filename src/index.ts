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


function pad2(n: number) { return n.toString().padStart(2, '0') }

function formatDate(d: Date) {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
}

function formatTime(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function addHours(d: Date, h: number) {
  const x = new Date(d);
  x.setHours(x.getHours() + h);
  return x;
}


const now = new Date();
// 1) redondeo a próxima hora
const nextHour = new Date(now);
if (nextHour.getMinutes() > 0 || nextHour.getSeconds() > 0) {
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
}
// 2) compensamos el “lead time” sumando 1 hora
const start1 = addHours(nextHour, 1);
// 3) para la URL 2 partimos de start1 + 24 h
const start2 = addHours(start1, 24);
// 4) para la URL 4 partimos de start1 + 2 h
const start3 = addHours(start1, 2);
// 5) fin siempre = start + 72 h
const end1 = addHours(start1, 72);
const end2 = addHours(start2, 72);
const end3 = addHours(start3, 72);


async function scrapeSearchUrl(
  page: Page,
  url: string,
  attempt = 1
): Promise<any[]> {
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

  const raw = await filteredRes.text();
  console.log(`🔍 [URL${attempt}] Raw response length for ${url}:`, raw.length);

  const searchJson = JSON.parse(raw) as any;
  const vehicles = (searchJson.vehicles ?? []) as Vehicle[];
  console.log(`🔍 [URL${attempt}] Parsed vehicles.length =`, vehicles.length);


  let region =
    searchJson.searchLocation?.region ||
    (searchPayload.searchRegion ?? searchPayload.region) ||
    new URL(url).searchParams.get('region') ||
    '';
  if (!region) {
    console.warn(`⚠️  No pude determinar region, usando cadena vacía para ${url}`);
  }

  if (vehicles.length === 0 && attempt < 3) {
    console.warn(`⚠️  vehicles.length=0, reintentando (intento ${attempt + 1})`);
    await page.waitForTimeout(3000 + Math.random() * 2000);
    return scrapeSearchUrl(page, url, attempt + 1);
  }


  const allQuotes: Record<string, Quote> = {};
  const vehicleChunks = chunkArray(vehicles, 20);
  for (const chunk of vehicleChunks) {
    const apiMap = chunk.reduce((acc: any, v: any) => {
      acc[v.id] = {
        isDelivery: v.location.isDelivery,
        locationId: v.location.locationId,
      };
      return acc;
    }, {});
    const payload = { age, apiEstimatedQuoteLocationDtoMap: apiMap, startDateTime, endDateTime, region, searchRegion: region };
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

  return vehicles.map(v => {
    const q = allQuotes[v.id];
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
    `https://turo.com/us/en/search?` +
    `age=25&country=US&defaultZoomLevel=13` +
    `&startDate=${encodeURIComponent(formatDate(start1))}` +
    `&startTime=${encodeURIComponent(formatTime(start1))}` +
    `&endDate=${encodeURIComponent(formatDate(end1))}` +
    `&endTime=${encodeURIComponent(formatTime(end1))}` +
    `&fuelTypes=ELECTRIC&isMapSearch=false&itemsPerPage=200` +
    `&latitude=25.79587&location=MIA%20-%20Miami%20International%20Airport` +
    `&locationType=AIRPORT&longitude=-80.28705&pickupType=ALL` +
    `&placeId=ChIJwUq5Tk232YgR4fiiy-Dan5g&region=FL` +
    `&sortType=RELEVANCE&useDefaultMaximumDistance=true`,// URL 1

    `https://turo.com/us/en/search?` +
    `age=25&country=US&defaultZoomLevel=11` +
    `&startDate=${encodeURIComponent(formatDate(start2))}` +
    `&startTime=${encodeURIComponent(formatTime(start2))}` +
    `&endDate=${encodeURIComponent(formatDate(end2))}` +
    `&endTime=${encodeURIComponent(formatTime(end2))}` +
    `&fuelTypes=ELECTRIC&fromYear=2024&toYear=2026&makes=Tesla` +
    `&isMapSearch=false&itemsPerPage=200` +
    `&latitude=25.79587&location=MIA%20-%20Miami%20International%20Airport` +
    `&locationType=AIRPORT&longitude=-80.28705&pickupType=ALL` +
    `&placeId=ChIJwUq5Tk232YgR4fiiy-Dan5g&region=FL` +
    `&sortType=RELEVANCE&useDefaultMaximumDistance=true`, // URL 2

    `https://turo.com/us/en/search?` +
    `age=25&country=US&defaultZoomLevel=13` +
    `&startDate=${encodeURIComponent(formatDate(start1))}` +
    `&startTime=${encodeURIComponent(formatTime(start1))}` +
    `&endDate=${encodeURIComponent(formatDate(end1))}` +
    `&endTime=${encodeURIComponent(formatTime(end1))}` +
    `&isMapSearch=false&itemsPerPage=200` +
    `&latitude=25.79587&location=MIA%20-%20Miami%20International%20Airport` +
    `&locationType=AIRPORT&longitude=-80.28705&pickupType=ALL` +
    `&placeId=ChIJwUq5Tk232YgR4fiiy-Dan5g&region=FL` +
    `&sortType=RELEVANCE&useDefaultMaximumDistance=true`, // URL 3

    `https://turo.com/us/en/search?` +
    `age=25&country=US&defaultZoomLevel=13` +
    `&startDate=${encodeURIComponent(formatDate(start3))}` +
    `&startTime=${encodeURIComponent(formatTime(start3))}` +
    `&endDate=${encodeURIComponent(formatDate(end3))}` +
    `&endTime=${encodeURIComponent(formatTime(end3))}` +
    `&fuelTypes=ELECTRIC&isMapSearch=false&itemsPerPage=200` +
    `&latitude=25.79587&location=MIA%20-%20Miami%20International%20Airport` +
    `&locationType=AIRPORT&longitude=-80.28705&pickupType=ALL` +
    `&placeId=ChIJwUq5Tk232YgR4fiiy-Dan5g&region=FL` +
    `&sortType=RELEVANCE&useDefaultMaximumDistance=true`,// URL 4
  ];

  for (let i = 0; i < urls.length; i++) {

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: pickRandom(USER_AGENTS),
    });

    const page = await context.newPage();

    try {
      const result = await scrapeSearchUrl(page, urls[i]);

      if (result.length === 0) {
        console.log(`ℹ️  URL ${i + 1} devolvió 0 vehículos; omitiendo escritura`);
      } else {
        const colName = `vehicles-url-${i + 1}`;
        await firestore.collection(colName).doc().set({
          scrapedAt: new Date(),
          executionData: result
        });
        console.log(`✅ Volcados ${result.length} vehículos a Firestore (${colName})`);

        // const outPath = path.resolve(__dirname, `../vehiclesJSON/vehicles-${i + 1}-${Date.now()}.json`);
        // fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
        // console.log(`✅ URL ${i + 1}: guardado ${result.length} vehículos en ${outPath}`);
      }
    } catch (err) {
      console.error(`❌ Error scraping URL ${i + 1}:`, err);
    } finally {
      const delay = 2000 + Math.random() * 2000;
      console.log(`⏱ Esperando ${Math.round(delay)} ms…`);
      await page.waitForTimeout(delay);
      await page.close();
      await context.close();
    }
  }

  await browser.close();
})();
