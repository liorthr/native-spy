import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.NATIVE_SPY_DB || resolve(ROOT, 'data', 'ads.db');

export function openDb(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ads (
      id            TEXT PRIMARY KEY,
      network       TEXT NOT NULL,
      title         TEXT NOT NULL,
      sponsor       TEXT,
      image         TEXT,
      click_url     TEXT,
      landing_url   TEXT,
      landing_domain TEXT,
      first_seen    TEXT NOT NULL,
      last_seen     TEXT NOT NULL,
      times_seen    INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sightings (
      ad_id     TEXT NOT NULL,
      publisher TEXT NOT NULL,
      page_url  TEXT,
      country   TEXT,
      seen_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sight_ad ON sightings(ad_id);
    CREATE INDEX IF NOT EXISTS idx_ads_last ON ads(last_seen);
    CREATE INDEX IF NOT EXISTS idx_ads_domain ON ads(landing_domain);
  `);
  return db;
}

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Identifiant stable : même réseau + même titre + même visuel = même pub. */
export function adId(ad) {
  const img = (ad.image || '').split('?')[0];
  return createHash('sha1').update(`${ad.network}|${norm(ad.title)}|${img}`).digest('hex').slice(0, 16);
}

export function saveAd(db, ad, ctx) {
  const now = ctx.seenAt || new Date().toISOString();
  const id = adId(ad);
  const existing = db.prepare('SELECT id FROM ads WHERE id = ?').get(id);
  if (existing) {
    db.prepare(`UPDATE ads SET last_seen = ?, times_seen = times_seen + 1,
                sponsor = COALESCE(sponsor, ?), landing_url = COALESCE(landing_url, ?),
                landing_domain = COALESCE(landing_domain, ?) WHERE id = ?`)
      .run(now, ad.sponsor || null, ad.landing_url || null, ad.landing_domain || null, id);
  } else {
    db.prepare(`INSERT INTO ads (id, network, title, sponsor, image, click_url, landing_url,
                landing_domain, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ad.network, ad.title, ad.sponsor || null, ad.image || null, ad.click_url || null,
           ad.landing_url || null, ad.landing_domain || null, now, now);
  }
  db.prepare('INSERT INTO sightings (ad_id, publisher, page_url, country, seen_at) VALUES (?,?,?,?,?)')
    .run(id, ctx.publisher, ctx.pageUrl || null, ctx.country || null, now);
  return { id, isNew: !existing };
}

/**
 * Recherche par mots-clés. Tous les mots doivent apparaître (ET) dans le titre,
 * le sponsor ou le domaine. Préfixez un mot par "-" pour l'exclure.
 */
export function searchAds(db, { q = '', network = '', country = '', days = 0, sort = 'last_seen', limit = 60, offset = 0 } = {}) {
  const where = [];
  const params = [];
  for (const raw of q.split(/\s+/).filter(Boolean)) {
    const neg = raw.startsWith('-') && raw.length > 1;
    const term = `%${(neg ? raw.slice(1) : raw).toLowerCase()}%`;
    const clause = `(lower(a.title) LIKE ? OR lower(COALESCE(a.sponsor,'')) LIKE ? OR lower(COALESCE(a.landing_domain,'')) LIKE ?)`;
    where.push(neg ? `NOT ${clause}` : clause);
    params.push(term, term, term);
  }
  if (network) { where.push('a.network = ?'); params.push(network); }
  if (country) { where.push('EXISTS (SELECT 1 FROM sightings s WHERE s.ad_id = a.id AND s.country = ?)'); params.push(country); }
  if (days > 0) { where.push('a.last_seen >= ?'); params.push(new Date(Date.now() - days * 864e5).toISOString()); }

  const order = {
    last_seen: 'a.last_seen DESC',
    first_seen: 'a.first_seen DESC',
    times_seen: 'a.times_seen DESC',
    // Une pub qui tourne depuis longtemps est probablement rentable.
    longevity: "(julianday(a.last_seen) - julianday(a.first_seen)) DESC, a.times_seen DESC",
  }[sort] || 'a.last_seen DESC';

  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ads a ${w}`).get(...params).n;
  const rows = db.prepare(`
    SELECT a.*,
      CAST(julianday(a.last_seen) - julianday(a.first_seen) AS INTEGER) + 1 AS days_running,
      (SELECT COUNT(DISTINCT publisher) FROM sightings s WHERE s.ad_id = a.id) AS publishers,
      (SELECT group_concat(DISTINCT country) FROM sightings s WHERE s.ad_id = a.id) AS countries
    FROM ads a ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, Number(limit), Number(offset));
  return { total, rows };
}

/** Regroupe les pubs correspondant aux mots-clés par annonceur = liste de concurrents. */
export function advertisers(db, opts = {}) {
  const { rows } = searchAds(db, { ...opts, limit: 100000, offset: 0 });
  const map = new Map();
  for (const r of rows) {
    const key = r.landing_domain || (r.sponsor ? `sponsor:${r.sponsor}` : null);
    if (!key) continue;
    const g = map.get(key) || {
      advertiser: r.landing_domain || r.sponsor, sponsors: new Set(), networks: new Set(),
      ads: 0, impressions: 0, first_seen: r.first_seen, last_seen: r.last_seen, sample_titles: [],
    };
    g.ads++; g.impressions += r.times_seen;
    if (r.sponsor) g.sponsors.add(r.sponsor);
    g.networks.add(r.network);
    if (r.first_seen < g.first_seen) g.first_seen = r.first_seen;
    if (r.last_seen > g.last_seen) g.last_seen = r.last_seen;
    if (g.sample_titles.length < 3) g.sample_titles.push(r.title);
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, sponsors: [...g.sponsors], networks: [...g.networks] }))
    .sort((a, b) => b.impressions - a.impressions);
}

export function stats(db) {
  return {
    ads: db.prepare('SELECT COUNT(*) n FROM ads').get().n,
    sightings: db.prepare('SELECT COUNT(*) n FROM sightings').get().n,
    networks: db.prepare('SELECT network, COUNT(*) n FROM ads GROUP BY network ORDER BY n DESC').all(),
    countries: db.prepare('SELECT country, COUNT(DISTINCT ad_id) n FROM sightings WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC').all(),
    last_crawl: db.prepare('SELECT MAX(seen_at) t FROM sightings').get().t,
  };
}
