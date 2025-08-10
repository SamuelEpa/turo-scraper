import 'dotenv/config';
import { Page } from "playwright";
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
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
if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

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
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
function pad2(n: number) { return n.toString().padStart(2, '0'); }
function formatDate(d: Date) { return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`; }
function formatTime(d: Date) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function addHours(d: Date, h: number) { const x = new Date(d); x.setHours(x.getHours() + h); return x; }

function addMinutes(d: Date, mins: number) {
  const r = new Date(d);
  r.setMinutes(r.getMinutes() + mins);
  return r;
}

function roundDownToSlot(d: Date, slotMinutes = 30) {
  const r = new Date(d);
  const mins = r.getMinutes();
  const floored = Math.floor(mins / slotMinutes) * slotMinutes;
  r.setMinutes(floored, 0, 0);
  return r;
}

const MIN_LEAD_MINUTES = 90;           
const SLOT_GRANULARITY_MINUTES = 30;  

const SLOT_OFFSETS: Record<number, number> = {};
const SLOT_DURATION_HOURS = 72;

function parseSlotsField(val: any): string[] | number[] | undefined {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    const arr = val.split(',').map(s => s.trim()).filter(s => s !== '');
    const areNumbers = arr.every(a => /^[0-9]+$/.test(a));
    if (areNumbers) return arr.map(a => parseInt(a, 10));
    return arr;
  }
  if (typeof val === 'number' && Number.isInteger(val)) return [val];
  return undefined;
}


async function getActiveSlotsById() {
  const snap = await firestore.collection('scrape-slots').get();
  const map = new Map<string, { label?: string; offsetHours?: number; durationHours?: number }>();
  snap.forEach(d => {
    const data = d.data() as any;
    map.set(d.id, {
      label: data.label,
      offsetHours: typeof data.offsetHours === 'number' ? data.offsetHours : 0,
      durationHours: typeof data.durationHours === 'number' ? data.durationHours : SLOT_DURATION_HOURS
    });
  });
  return map;
}


function cleanUrlRemoveDateParams(rawUrl: string) {
  try {
    const u = new URL(rawUrl);
    ['startDate', 'startTime', 'endDate', 'endTime', 'monthlyStartDate', 'monthlyEndDate'].forEach(p => u.searchParams.delete(p));
    for (const [k, v] of Array.from(u.searchParams.entries())) if (v === '') u.searchParams.delete(k);
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


async function scrapeSearchUrl(page: Page, url: string, attempt = 1): Promise<{ results: any[]; startUsedISO?: string | null; endUsedISO?: string | null }> {
  const searchRequestPromise = page.waitForRequest(req => req.url().includes('/api/v2/search') && req.method() === 'POST');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const searchReq = await searchRequestPromise;
  const searchPayload = JSON.parse(searchReq.postData()!);
  const { filters: nestedFilters } = searchPayload;
  const startDateTime = nestedFilters?.dates?.start ?? null;
  const endDateTime = nestedFilters?.dates?.end ?? null;
  const age = nestedFilters?.age;

  const filteredRes = await page.waitForResponse(res => res.url().includes('/api/v2/search') && res.status() === 200, { timeout: 60000 });
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
  if (!region) console.warn(`⚠️  No pude determinar region, usando cadena vacía para ${url}`);

  if (vehicles.length === 0 && attempt < 3) {
    console.warn(`⚠️  vehicles.length=0, reintentando (intento ${attempt + 1})`);
    await page.waitForTimeout(3000 + Math.random() * 2000);
    return scrapeSearchUrl(page, url, attempt + 1);
  }

  const allQuotes: Record<string, Quote> = {};
  const vehicleChunks = chunkArray(vehicles, 20);
  for (const chunk of vehicleChunks) {
    const apiMap = chunk.reduce((acc: any, v: any) => {
      acc[v.id] = { isDelivery: v.location.isDelivery, locationId: v.location.locationId };
      return acc;
    }, {});
    const payload = { age, apiEstimatedQuoteLocationDtoMap: apiMap, startDateTime, endDateTime, region, searchRegion: region };
    const quoteJson = await page.evaluate(async body => {
      const resp = await fetch('/api/bulk-quotes/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return resp.json();
    }, payload) as { estimatedQuotes: Record<string, Quote> };
    Object.assign(allQuotes, quoteJson.estimatedQuotes);
  }

  const results = vehicles.map(v => {
    const q = allQuotes[v.id];
    return {
      id: v.id,
      title: `${v.year} ${v.make} ${v.model}`,
      image: v.images[0]?.originalImageUrl ?? null,
      totalQuoted: q?.totalTripPrice.amount != null ? Math.round(q.totalTripPrice.amount) : null,
      position: vehicles.findIndex(x => x.id === v.id) + 1,
    };
  });

  return { results, startUsedISO: startDateTime ?? null, endUsedISO: endDateTime ?? null };
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
  const baseCandidate = addMinutes(now, MIN_LEAD_MINUTES);
  const baseAvailableSlot = roundDownToSlot(baseCandidate, SLOT_GRANULARITY_MINUTES);
  console.log(`now=${now.toISOString()}, baseCandidate=${baseCandidate.toISOString()}, baseAvailableSlot=${baseAvailableSlot.toISOString()}`);


  const templates = await (async () => {
    const snap = await firestore.collection('scrape-templates').where('active', '==', true).get();
    const arr: any[] = [];
    snap.forEach(d => {
      const data = d.data() as any;
      arr.push({
        id: d.id,
        label: data.label,
        url: data.url,
        slotId: data.slotId ?? null,
        slotsIds: parseSlotsField(data.slots) ?? undefined,
        slot: data.slot ?? undefined,
        offsetHours: typeof data.offsetHours === 'number' ? data.offsetHours : undefined,
        durationHours: typeof data.durationHours === 'number' ? data.durationHours : undefined
      });
    });
    return arr;
  })();

  if (templates.length === 0) {
    console.log('No hay plantillas activas en firestore. Saliendo sin scrapear.');
    await browser.close();
    process.exit(0);
  }

  const slotOptionsMap = await getActiveSlotsById();

  const templateUrls: {
    slotId?: string | null;
    slotLegacy?: number | null;
    docId: string;
    url: string;
    label?: string;
    offset?: number | null;
    duration?: number | null;
    raw?: boolean;
  }[] = [];

  for (const t of templates) {
    let slotsToCreateIds: string[] = [];
    let legacySlotNumbers: number[] = [];

    if (Array.isArray(t.slotsIds) && t.slotsIds.length > 0) {
      const strings = t.slotsIds.filter((x: any) => typeof x === 'string');
      const nums = t.slotsIds.filter((x: any) => typeof x === 'number');
      if (strings.length) slotsToCreateIds = strings;
      else if (nums.length) legacySlotNumbers = nums;
    }

    if (!slotsToCreateIds.length && t.slotId) {
      slotsToCreateIds = [t.slotId];
    }

    const hasAnySlot = slotsToCreateIds.length > 0 || legacySlotNumbers.length > 0 || (typeof t.slot === 'number');

    if (!hasAnySlot) {
      console.log(`> Template ${t.id} sin slot: usar URL raw tal cual.`);
      templateUrls.push({
        docId: t.id,
        url: t.url,
        label: t.label,
        offset: null,
        duration: null,
        raw: true
      });
      continue;
    }

    const base = cleanUrlRemoveDateParams(t.url);

    if (slotsToCreateIds.length) {
      for (const slotId of slotsToCreateIds) {
        const slotOption = slotOptionsMap.get(slotId);
        let offset = typeof t.offsetHours === 'number' ? t.offsetHours : (slotOption?.offsetHours ?? 0);
        if (offset < 0) offset = 0;
        let duration = typeof t.durationHours === 'number' ? t.durationHours : (slotOption?.durationHours ?? SLOT_DURATION_HOURS);
        if (duration < 1) duration = SLOT_DURATION_HOURS;

        const start = addMinutes(baseAvailableSlot, Math.round(offset * 60));
        const end = addMinutes(start, Math.round(duration * 60));
        const finalUrl = addDateParamsToUrl(base, start, end);

        console.log(`> Template ${t.id} slotId=${slotId} offset=${offset}h duration=${duration}h -> start=${start.toISOString()} end=${end.toISOString()}`);
        templateUrls.push({ slotId, docId: t.id, url: finalUrl, label: t.label, offset, duration });
      }
    }

    if (legacySlotNumbers.length) {
      for (const num of legacySlotNumbers) {
        let offset = typeof t.offsetHours === 'number' ? t.offsetHours : (SLOT_OFFSETS[num] ?? 0);
        if (offset < 0) offset = 0;
        let duration = typeof t.durationHours === 'number' ? t.durationHours : SLOT_DURATION_HOURS;
        if (duration < 1) duration = SLOT_DURATION_HOURS;

        const start = addMinutes(baseAvailableSlot, Math.round(offset * 60));
        const end = addMinutes(start, Math.round(duration * 60));
        const finalUrl = addDateParamsToUrl(base, start, end);

        console.log(`> Template ${t.id} legacySlot=${num} offset=${offset}h duration=${duration}h -> start=${start.toISOString()} end=${end.toISOString()}`);
        templateUrls.push({ slotLegacy: num, docId: t.id, url: finalUrl, label: t.label, offset, duration });
      }
    }
  }

  for (let i = 0; i < templateUrls.length; i++) {
    const templateItem = templateUrls[i];
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: pickRandom(USER_AGENTS)
    });
    const page = await context.newPage();
    try {
      console.log(`➡️ Scraping template ${templateItem.docId} (${templateItem.label || 'no-label'}) -> ${templateItem.url}`);
      const { results, startUsedISO, endUsedISO } = await scrapeSearchUrl(page, templateItem.url);

      if (results.length === 0) {
        console.log(`ℹ️  Template ${templateItem.docId} devolvió 0 vehículos; omitiendo escritura`);
      } else {
        const colName = `vehicles-template-${templateItem.docId}`;
        await firestore.collection(colName).doc().set({
          scrapedAt: new Date(),
          executionData: results,
          templateId: templateItem.docId,
          slotId: templateItem.slotId ?? null,
          slotLegacy: templateItem.slotLegacy ?? null,
          templateLabel: templateItem.label ?? null,
          offsetUsedHours: templateItem.offset ?? null,
          durationUsedHours: templateItem.duration ?? null,
          startUsedISO: startUsedISO ?? null,
          endUsedISO: endUsedISO ?? null
        });
        console.log(`✅ Volcados ${results.length} vehículos a Firestore (${colName})`);


        // const outPath = path.resolve(__dirname, `../vehiclesJSON/vehicles-${Date.now()}.json`);
        // fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
        // console.log(`✅ Guardado ${results.length} vehículos en ${outPath}`);
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
