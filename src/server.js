// Interface web de recherche : http://localhost:3000
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, searchAds, advertisers, stats } from './db.js';

const PORT = Number(process.env.PORT || 3000);
const HTML = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
const db = openDb();

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function params(url) {
  const p = Object.fromEntries(url.searchParams);
  return { q: p.q || '', network: p.network || '', country: p.country || '', days: Number(p.days || 0),
           sort: p.sort || 'last_seen', limit: Math.min(Number(p.limit || 60), 500), offset: Number(p.offset || 0) };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (data) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(HTML));
    }
    if (url.pathname === '/api/ads') return json(searchAds(db, params(url)));
    if (url.pathname === '/api/advertisers') return json(advertisers(db, params(url)));
    if (url.pathname === '/api/stats') return json(stats(db));
    if (url.pathname === '/api/export.csv') {
      const { rows } = searchAds(db, { ...params(url), limit: 100000, offset: 0 });
      const cols = ['network', 'title', 'sponsor', 'landing_domain', 'landing_url', 'image', 'first_seen', 'last_seen', 'days_running', 'times_seen', 'publishers', 'countries'];
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="native-ads.csv"' });
      return res.end('﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(';'))].join('\n'));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    res.writeHead(500); res.end(String(e.message));
  }
});

server.listen(PORT, () => console.log(`Native Spy : http://localhost:${PORT}`));
