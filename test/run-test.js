// Test hors-ligne : sert une page factice contenant des widgets et vérifie l'extraction + la recherche.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { extractAdsInPage, resolveLanding } from '../src/extract.js';
import { openDb, saveAd, searchAds, advertisers } from '../src/db.js';

const html = readFileSync(new URL('./fixture.html', import.meta.url));
const srv = createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/article`;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
await page.route('https://cdn.example/**', (r) => r.fulfill({ status: 200, body: '' }));
await page.goto(url);
const ads = await page.evaluate(extractAdsInPage);
await browser.close(); srv.close();

console.log(ads);
assert.equal(ads.length, 4, '4 pubs attendues (la reco interne est exclue)');
assert.deepEqual(ads.map((a) => a.network).sort(), ['mgid', 'outbrain', 'revcontent', 'taboola']);
const tb = ads.find((a) => a.network === 'taboola');
assert.equal(tb.sponsor, 'Minceur Express');
assert.equal(tb.image, 'https://cdn.example/img1.jpg');
assert.equal(resolveLanding(tb.click_url).landing_domain, 'minceur-express.fr');
assert.equal(resolveLanding(ads.find((a) => a.network === 'mgid').click_url).landing_domain, 'crypto-gains.io');
assert.deepEqual(resolveLanding(ads.find((a) => a.network === 'outbrain').click_url), {});

const db = openDb(':memory:');
for (const a of ads) saveAd(db, { ...a, ...resolveLanding(a.click_url) }, { publisher: 'test.fr', country: 'FR', seenAt: '2026-11-01T10:00:00Z' });
for (const a of ads) saveAd(db, { ...a, ...resolveLanding(a.click_url) }, { publisher: 'autre.fr', country: 'FR', seenAt: '2026-11-15T10:00:00Z' });

assert.equal(searchAds(db, { q: 'minceur' }).total, 1);
assert.equal(searchAds(db, { q: 'assurance auto' }).total, 1);
assert.equal(searchAds(db, { q: 'crypto' }).rows[0].days_running, 15);
assert.equal(searchAds(db, { q: '-crypto' }).total, 3);
assert.equal(searchAds(db, { network: 'outbrain' }).total, 1);
assert.equal(searchAds(db, { q: 'minceur' }).rows[0].publishers, 2);
const adv = advertisers(db, { q: 'assur' });
assert.equal(adv[0].advertiser, 'AssurMoinsCher');
console.log('\n✅ Tous les tests passent');
