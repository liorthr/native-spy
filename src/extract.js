/**
 * Fonction exécutée DANS la page (via page.evaluate). Elle doit rester autonome :
 * aucune variable extérieure, aucun import.
 * Retourne une liste de pubs : { network, title, sponsor, image, click_url }
 */
export function extractAdsInPage() {
  const pageHost = location.hostname.replace(/^www\./, '');
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const imageOf = (root) => {
    if (!root) return null;
    const img = root.querySelector('img');
    if (img) {
      const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (src && !src.startsWith('data:')) return new URL(src, location.href).href;
    }
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const bg = (el.style && el.style.backgroundImage) || getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && !m[1].startsWith('data:')) return new URL(m[1], location.href).href;
    }
    return null;
  };

  const linkOf = (root) => {
    const a = root.matches && root.matches('a[href]') ? root : root.querySelector('a[href]');
    return a ? a.href : null;
  };

  // Définition de chaque réseau : conteneur d'un item + sélecteurs titre / sponsor.
  const NETWORKS = [
    {
      network: 'taboola',
      items: '[id^="taboola"] .videoCube, .trc_rbox_container .videoCube, .tbl-feed-card .videoCube',
      title: '.video-title, .video-label-box .video-title, [class*="title"]',
      sponsor: '.branding, .video-branding-flex-cta-item, [class*="branding"]',
    },
    {
      network: 'outbrain',
      // Outbrain s'appelle désormais Teads (widgets.teads-xo.com) mais garde le balisage .OUTBRAIN / .ob-*
      items: '.OUTBRAIN .ob-dynrec-link, .OUTBRAIN a.ob-rec-link, .ob-widget .ob-dynrec-link, .OUTBRAIN [class*="ob-rec-link"], .OUTBRAIN a[data-ob-mark]',
      title: '.ob-rec-text, [class*="rec-text"]',
      sponsor: '.ob-rec-source, [class*="rec-source"]',
    },
    {
      network: 'mgid',
      items: '[id^="ScriptRoot"] .mgline, .mgbox .mgline',
      title: '.mctitle, .mcdesc',
      sponsor: '.mcdomain, .mcriteo',
    },
    {
      network: 'revcontent',
      items: '.rc-item, [id^="rcjsload"] .rc-item',
      title: '.rc-headline, .rc-title',
      sponsor: '.rc-provider, .rc-brand',
    },
    {
      network: 'content.ad',
      items: '.ac_container .ac_item, [id^="contentad"] .ac_item',
      title: '.ac_title',
      sponsor: '.ac_brand, .ac_domain',
    },
  ];

  // Domaines de clic connus → permet de détecter les pubs même sans le balisage habituel.
  const TRACKERS = [
    [/(^|\.)taboola\.com$/, 'taboola'],
    [/(^|\.)outbrain\.com$|(^|\.)teads-xo\.com$|(^|\.)teads\.tv$/, 'outbrain'],
    [/(^|\.)(mgid|adskeeper)\.com$/, 'mgid'],
    [/(^|\.)revcontent\.com$/, 'revcontent'],
    [/(^|\.)content\.ad$/, 'content.ad'],
    [/(^|\.)(mediago\.io|popin\.cc)$/, 'mediago'],
    [/(^|\.)yahoo\.com$|(^|\.)gemini\.yahoo\.com$/, 'yahoo-gemini'],
  ];

  const results = [];
  const seenEls = new Set();

  const push = (network, el, title, sponsor) => {
    const click = linkOf(el);
    title = clean(title);
    if (!title || title.length < 8 || !click) return;
    let host = '';
    try { host = new URL(click).hostname.replace(/^www\./, ''); } catch { return; }
    // Recommandations éditoriales du site lui-même = pas une pub.
    if (host === pageHost || host.endsWith('.' + pageHost)) return;
    results.push({ network, title, sponsor: clean(sponsor) || null, image: imageOf(el), click_url: click });
  };

  for (const n of NETWORKS) {
    for (const el of document.querySelectorAll(n.items)) {
      seenEls.add(el);
      el.querySelectorAll('a').forEach((a) => seenEls.add(a));
      const t = el.querySelector(n.title);
      const s = el.querySelector(n.sponsor);
      push(n.network, el, t ? t.textContent : el.getAttribute('title') || el.textContent, s ? s.textContent : '');
    }
  }

  // Détection générique via les URLs de clic.
  for (const a of document.querySelectorAll('a[href]')) {
    if (seenEls.has(a)) continue;
    let host;
    try { host = new URL(a.href).hostname; } catch { continue; }
    const hit = TRACKERS.find(([re]) => re.test(host));
    if (!hit) continue;
    const card = a.closest('li, article, div') || a;
    push(hit[1], a.querySelector('img') ? a : card, a.textContent || a.getAttribute('title') || '', '');
  }

  // Dédoublonnage dans la page.
  const uniq = new Map();
  for (const r of results) uniq.set(`${r.network}|${r.title}`, r);
  return [...uniq.values()];
}

const TRACKER_HOST = /(^|\.)(taboola|outbrain|mgid|adskeeper|revcontent|mediago|popin|doubleclick|googlesyndication|teads-xo|teads)\.(com|io|cc|net|tv)$|(^|\.)content\.ad$/;

/**
 * Déduit l'URL / le domaine de l'annonceur SANS cliquer sur la pub
 * (on ne suit jamais les liens de tracking : cela facturerait un clic à l'annonceur).
 */
export function resolveLanding(clickUrl) {
  if (!clickUrl) return {};
  let u;
  try { u = new URL(clickUrl); } catch { return {}; }
  if (!TRACKER_HOST.test(u.hostname)) {
    return { landing_url: clickUrl, landing_domain: u.hostname.replace(/^www\./, '') };
  }
  // Certains redirecteurs contiennent la destination en paramètre.
  for (const key of ['url', 'u', 'dest', 'redir', 'redirect', 'target', 'lp', 'clickUrl']) {
    const v = u.searchParams.get(key);
    if (v && /^https?:\/\//i.test(v)) {
      try {
        const d = new URL(v);
        if (!TRACKER_HOST.test(d.hostname)) return { landing_url: v, landing_domain: d.hostname.replace(/^www\./, '') };
      } catch { /* ignore */ }
    }
  }
  return {};
}
