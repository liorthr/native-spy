// Crawler : visite des sites éditeurs, repère les widgets native ads et enregistre les pubs.
// Usage : npm run crawl -- [--sites sites.txt] [--articles 4] [--parallel 3] [--reloads 2] [--url https://…] [--proxy http://user:pass@host:port]
//                          [--country FR] [--headful] [--chrome] [--debug]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { openDb, saveAd } from './db.js';
import { extractAdsInPage, resolveLanding } from './extract.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
};

const SITES_FILE = opt('sites', 'sites.txt');
const ARTICLES = Number(opt('articles', 4));
const SINGLE_URL = opt('url', null);
const PROXY = opt('proxy', process.env.NATIVE_SPY_PROXY || null);
const COUNTRY_OVERRIDE = opt('country', null);
const HEADFUL = !!opt('headful', false);
const USE_CHROME = !!opt('chrome', false);
const DEBUG = !!opt('debug', false);
const PARALLEL = Math.max(1, Number(opt('parallel', 1)));  // nb de sites scannés en même temps
const RELOADS = Math.max(1, Number(opt('reloads', 1)));    // nb d'affichages par article (les pubs tournent)

function loadSites(file) {
  if (SINGLE_URL) return [{ url: SINGLE_URL, country: COUNTRY_OVERRIDE || 'FR' }];
  return readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [url, country] = l.split('|').map((s) => s.trim());
      return { url, country: COUNTRY_OVERRIDE || country || null };
    });
}

async function autoScroll(page) {
  // Les widgets native se chargent en bas de page, souvent en lazy-load.
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(2500);
}

// Boutons « Accepter » des bandeaux cookies les plus courants en France.
const CONSENT_SELECTORS = [
  '#didomi-notice-agree-button',                 // Didomi (Ouest-France, Le Télégramme, Le Parisien…)
  '#onetrust-accept-btn-handler',                // OneTrust
  '#axeptio_btn_acceptAll',                      // Axeptio
  '.qc-cmp2-summary-buttons button[mode="primary"]', // Quantcast
  'button.sp_choice_type_11',                    // Sourcepoint (Le Figaro, Prisma…)
  'button[title="Accepter"]', 'button[title="Tout accepter"]', 'button[title="Accepter et fermer"]',
  '#cmpbntyestxt', '.cmp-intro_acceptAll', '#footer_tc_privacy_button_2', '#popin_tc_privacy_button_2',
];
const CONSENT_TEXT = /^(tout accepter|accepter( et (fermer|continuer))?|j'accepte|accepter & fermer|ok, j'accepte|continuer sans refuser|accept( all)?|i agree)$/i;

async function acceptCookies(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const frame of page.frames()) {
      for (const sel of CONSENT_SELECTORS) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible()) { await el.click({ timeout: 2000 }); await page.waitForTimeout(800); return true; }
        } catch { /* suivant */ }
      }
      try {
        const btn = frame.getByRole('button', { name: CONSENT_TEXT }).first();
        if (await btn.isVisible()) { await btn.click({ timeout: 2000 }); await page.waitForTimeout(800); return true; }
      } catch { /* suivant */ }
    }
    await page.waitForTimeout(1500); // le bandeau peut apparaître avec un peu de retard
  }
  return false;
}

async function articleLinks(page, max) {
  return page.evaluate((max) => {
    const base = location.hostname.replace(/^www\./, '');
    const scored = [...document.querySelectorAll('a[href]')]
      .map((a) => a.href.split('#')[0].split('?')[0])
      .filter((h) => {
        try {
          const u = new URL(h);
          const sameSite = u.hostname === base || u.hostname.endsWith('.' + base);
          const p = u.pathname;
          return sameSite && p.length > 20 && /[a-z]-[a-z0-9]/i.test(p) &&
            !/\.(jpg|png|pdf)$|\/(tag|tags|auteur|author|abonnement|services|newsletter|login|compte|connexion)\//i.test(p);
        } catch { return false; }
      })
      // Les URLs d'articles sont longues et contiennent beaucoup de tirets.
      .map((h) => [h, (new URL(h).pathname.match(/-/g) || []).length]);
    const uniq = [...new Map(scored).entries()].sort((a, b) => b[1] - a[1]);
    return uniq.slice(0, max).map(([h]) => h);
  }, max);
}

let shot = 0;
async function scanPage(page, db, url, site) {
  const failed = new Set();
  const onFail = (r) => { try { failed.add(new URL(r.url()).hostname); } catch { /* ignore */ } };
  if (DEBUG) page.on('requestfailed', onFail);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`  ✗ ${url} : ${e.message.split('\n')[0].slice(0, 160)}`);
    return { count: 0, ok: false, broken: true };
  }
  await page.waitForTimeout(1500);
  const consent = await acceptCookies(page);
  await autoScroll(page);

  // Les widgets sont parfois dans des iframes : on scanne toutes les frames.
  let ads = [];
  for (const frame of page.frames()) {
    try { ads = ads.concat(await frame.evaluate(extractAdsInPage)); } catch { /* frame détachée */ }
  }

  let fresh = 0;
  const publisher = new URL(url).hostname.replace(/^www\./, '');
  for (const ad of ads) {
    const { isNew } = saveAd(db, { ...ad, ...resolveLanding(ad.click_url) }, { publisher, pageUrl: url, country: site.country });
    if (isNew) fresh++;
  }

  let extra = '';
  if (DEBUG) {
    const title = await page.title().catch(() => '');
    const widgets = await page.evaluate(() => ({
      taboola: !!document.querySelector('[id^="taboola"], .trc_rbox_container, script[src*="taboola"]'),
      outbrain: !!document.querySelector('.OUTBRAIN, script[src*="outbrain"]'),
      mgid: !!document.querySelector('[id^="ScriptRoot"], script[src*="mgid"]'),
    })).catch(() => ({}));
    mkdirSync('data/debug', { recursive: true });
    const file = `data/debug/${String(++shot).padStart(3, '0')}-${publisher}.png`;
    await page.screenshot({ path: file, fullPage: false }).catch(() => {});
    extra = `\n      titre="${title.slice(0, 70)}" cookies=${consent ? 'acceptés' : 'non trouvés'} widgets=${JSON.stringify(widgets)} capture=${file}`;
    if (failed.size) extra += `\n      domaines bloqués/échoués : ${[...failed].slice(0, 15).join(' ')}`;
    page.off('requestfailed', onFail);
  }
  console.log(`  ✓ [${publisher}] ${url.length > 110 ? url.slice(0, 110) + '…' : url} : ${ads.length} pubs (${fresh} nouvelles)${extra}`);
  return { count: ads.length, fresh, ok: true };
}

async function main() {
  const sites = loadSites(SITES_FILE);
  const db = openDb();
  const launch = {
    headless: !HEADFUL,
    // Mode headless « complet » (moins détecté que le headless-shell) ou vrai Google Chrome.
    channel: USE_CHROME ? 'chrome' : 'chromium',
    args: ['--disable-blink-features=AutomationControlled'],
    ...(PROXY ? { proxy: { server: PROXY } } : {}),
  };
  if (process.env.PW_CHROMIUM) { delete launch.channel; launch.executablePath = process.env.PW_CHROMIUM; }
  let browser;
  try { browser = await chromium.launch(launch); }
  catch (e) {
    if (USE_CHROME) throw new Error('Google Chrome introuvable : installez-le ou retirez l\'option --chrome.');
    delete launch.channel; browser = await chromium.launch(launch);
  }
  const context = await browser.newContext({
    ...(USE_CHROME ? {} : { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' }),
    viewport: { width: 1366, height: 900 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  let total = 0, fresh = 0;
  const queue = [...sites];
  console.log(`Crawl de ${sites.length} site(s), ${PARALLEL} en parallèle, ${RELOADS} affichage(s) par article${PROXY ? ', via proxy' : ''}${USE_CHROME ? ', avec Google Chrome' : ''}…`);

  // Chaque « worker » a son propre onglet et prend le site suivant dans la file.
  async function worker() {
    let page = await context.newPage();
    // Après une erreur, l'onglet peut rester bloqué sur une navigation en cours : on en ouvre un neuf.
    const scan = async (url, site) => {
      const r = await scanPage(page, db, url, site);
      if (r.broken) { await page.close().catch(() => {}); page = await context.newPage(); }
      total += r.count; fresh += r.fresh || 0;
      return r;
    };
    for (let site = queue.shift(); site; site = queue.shift()) {
      console.log(`\n▶ ${site.url}${site.country ? ` [${site.country}]` : ''}`);
      const home = await scan(site.url, site);
      if (!home.ok || SINGLE_URL) continue;
      let links = [];
      try { links = await articleLinks(page, ARTICLES); } catch { /* ignore */ }
      if (!links.length) console.log(`  ⚠ [${site.url}] aucun article trouvé (bandeau cookies ou protection anti-robot ?)`);
      for (const link of links) {
        for (let r = 0; r < RELOADS; r++) await scan(link, site);
      }
    }
    await page.close().catch(() => {});
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, sites.length) }, worker));
  await browser.close();
  console.log(`\nTerminé : ${total} pubs vues, dont ${fresh} nouvelles. Lancez « npm run serve » pour rechercher.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
