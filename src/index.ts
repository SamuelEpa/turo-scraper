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

const SLOT_OFFSETS: Record<number, number> = {
  1: 1,   // Option 1 => nextHour + 1h
  2: 25,  // Option 2 => nextHour + 25h (start1 + 24h)
  3: 3,   // Option 3 => nextHour + 3h (start1 + 2h)
};
const SLOT_DURATION_HOURS = 72; // duración estándar (end = start + 72h)

function cleanUrlRemoveDateParams(rawUrl: string) {
  try {
    const u = new URL(rawUrl);
    // quitar parámetros que pueden venir pegados
    ['startDate', 'startTime', 'endDate', 'endTime', 'monthlyStartDate', 'monthlyEndDate'].forEach(p => u.searchParams.delete(p));
    // también limpia parámetros vacíos como startTime=
    for (const [k, v] of Array.from(u.searchParams.entries())) {
      if (v === '') u.searchParams.delete(k);
    }
    return u.toString();
  } catch (e) {
    console.warn('URL inválida en cleanUrlRemoveDateParams:', rawUrl);
    return rawUrl;
  }
}

function addDateParamsToUrl(baseUrl: string, start: Date, end: Date) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('startDate', formatDate(start));
    u.searchParams.set('startTime', formatTime(start));
    u.searchParams.set('endDate', formatDate(end));
    u.searchParams.set('endTime', formatTime(end));
    return u.toString();
  } catch (e) {
    console.warn('Error construyendo fecha para URL base:', baseUrl, e);
    return baseUrl;
  }
}


async function getActiveTemplates() {
  const snap = await firestore.collection('scrape-templates').where('active', '==', true).get();
  const templates: { id: string; label?: string; url: string; slot?: number }[] = [];
  snap.forEach(d => {
    const data = d.data() as any;
    templates.push({
      id: d.id,
      label: data.label,
      url: data.url,
      slot: data.slot ?? 1
    });
  });
  return templates;
}


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
    return arr[Math.floor(Math.random() * Math.random() * arr.length) % arr.length];
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });


  const now = new Date();
  const nextHour = new Date(now);
  if (nextHour.getMinutes() > 0 || nextHour.getSeconds() > 0) {
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
  }

  const templates = await getActiveTemplates();
  if (templates.length === 0) {
    console.log('No hay plantillas activas en firestore. Saliendo sin scrapear.');
    await browser.close();
    process.exit(0);
  }

  const templateUrls: { slot: number; docId: string; url: string; label?: string }[] = [];

  for (const t of templates) {
    const base = cleanUrlRemoveDateParams(t.url);
    const offset = SLOT_OFFSETS[t.slot ?? 1] ?? 1;
    const start = addHours(nextHour, offset);
    const end = addHours(start, SLOT_DURATION_HOURS);
    const finalUrl = addDateParamsToUrl(base, start, end);
    templateUrls.push({ slot: t.slot ?? 1, docId: t.id, url: finalUrl, label: t.label });
  }

  // Iterar por cada template en lugar de por 4 urls hardcodeadas
  for (let i = 0; i < templateUrls.length; i++) {

    const templateItem = templateUrls[i];

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: pickRandom(USER_AGENTS),
    });

    const page = await context.newPage();

    try {
      console.log(`➡️ Scraping template ${templateItem.docId} (${templateItem.label || 'no-label'}) -> ${templateItem.url}`);
      const result = await scrapeSearchUrl(page, templateItem.url);

      if (result.length === 0) {
        console.log(`ℹ️  Template ${templateItem.docId} devolvió 0 vehículos; omitiendo escritura`);
      } else {

        const colName = `vehicles-template-${templateItem.docId}`;
        await firestore.collection(colName).doc().set({
          scrapedAt: new Date(),
          executionData: result,
          templateId: templateItem.docId,
          slot: templateItem.slot,
          templateLabel: templateItem.label ?? null
        });
        console.log(`✅ Volcados ${result.length} vehículos a Firestore (${colName})`);

        // const outPath = path.resolve(__dirname, `../vehiclesJSON/vehicles-${i + 1}-${Date.now()}.json`);
        // fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
        // console.log(`✅ URL ${i + 1}: guardado ${result.length} vehículos en ${outPath}`);
      }
    } catch (err) {
      console.error(`❌ Error scraping template ${templateItem.docId}:`, err);
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
