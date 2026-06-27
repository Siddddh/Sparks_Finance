/**
 * Sparks Finance — Pre-Market Notification Engine (Cloud Functions, gen 2)
 *
 * `premarketNotifications` runs every trading-day morning at 08:00 America/New_York
 * (one hour before the 09:30 open). It:
 *   1. Pulls today's market calendar from Finnhub (earnings + economic events + US
 *      market-holiday status).
 *   2. Reads every user that has registered an FCM token (users/{uid}.fcmTokens),
 *      plus that user's portfolio holdings and watchlist tickers.
 *   3. Builds a PERSONALISED digest: earnings for the user's own tickers today, plus
 *      market-wide macro events (FOMC / CPI / jobs …) and holiday status for everyone.
 *   4. Writes the digest to notifications/{uid}/list/{autoId} (the web app reads this
 *      live) and sends an FCM push to that user's device tokens.
 *   5. Prunes any token that FCM reports as unregistered/invalid.
 *
 * `runPremarketNow` is an HTTP companion that runs the exact same logic on demand so
 * the scheduled path can be verified without waiting for 08:00. It is guarded by a
 * shared token (reuses the Finnhub secret) — REMOVE or lock down before long-term prod.
 *
 * Data source note: the original spec named "Google Finance", which has no public API.
 * Finnhub (https://finnhub.io) is the actual source. Set the key once with:
 *     firebase functions:secrets:set FINNHUB_API_KEY
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const FINNHUB_API_KEY = defineSecret('FINNHUB_API_KEY');
const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const crypto = require('crypto');

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// Macro events we consider "market-moving" enough to broadcast (case-insensitive substr match).
const MACRO_KEYWORDS = [
  'fomc', 'interest rate', 'rate decision', 'fed ', 'federal funds',
  'cpi', 'inflation', 'ppi', 'pce',
  'non-farm', 'nonfarm', 'nfp', 'unemployment', 'jobless', 'payroll', 'jobs',
  'gdp', 'retail sales', 'fed chair', 'powell'
];

// ── Date helpers (always in US Eastern, the market's timezone) ──────────────────

function todayInET() {
  // en-CA formats as YYYY-MM-DD, which is exactly what the Finnhub from/to params want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function timeToET(raw) {
  // Finnhub economic-calendar `time` is a UTC datetime like "2026-06-07 12:30:00".
  if (!raw) return '';
  try {
    const d = new Date(raw.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return raw;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
    }).format(d) + ' ET';
  } catch (e) {
    return raw;
  }
}

// ── Finnhub fetchers (each defensive: returns a safe default on any failure) ────

async function finnhubGet(path, params, key) {
  const qs = new URLSearchParams({ ...params, token: key }).toString();
  const res = await fetch(`${FINNHUB_BASE}${path}?${qs}`);
  if (!res.ok) {
    throw new Error(`Finnhub ${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

async function getEarningsToday(date, key) {
  try {
    const data = await finnhubGet('/calendar/earnings', { from: date, to: date }, key);
    const rows = (data && data.earningsCalendar) || [];
    return rows.map(r => ({
      ticker: (r.symbol || '').toUpperCase(),
      hour: r.hour || '',            // "bmo" | "amc" | "dmh" | ""
      epsEstimate: r.epsEstimate ?? null
    })).filter(r => r.ticker);
  } catch (e) {
    logger.warn('Earnings calendar fetch failed', { error: String(e) });
    return [];
  }
}

async function getMacroToday(date, key) {
  try {
    const data = await finnhubGet('/calendar/economic', { from: date, to: date }, key);
    const rows = (data && data.economicCalendar) || [];
    return rows
      .filter(r => {
        const country = (r.country || '').toUpperCase();
        if (country && country !== 'US') return false;
        const ev = (r.event || '').toLowerCase();
        const highImpact = ['high', '3'].includes(String(r.impact || '').toLowerCase());
        const keyworded = MACRO_KEYWORDS.some(k => ev.includes(k));
        return highImpact || keyworded;
      })
      .map(r => ({
        event: r.event || 'Economic release',
        time: timeToET(r.time),
        impact: r.impact || '',
        estimate: r.estimate ?? null,
        prev: r.prev ?? null
      }));
  } catch (e) {
    // Economic calendar may be premium-only on some Finnhub plans — degrade gracefully.
    logger.warn('Economic calendar fetch failed (continuing without macro)', { error: String(e) });
    return [];
  }
}

async function getHolidayToday(date, key) {
  try {
    const data = await finnhubGet('/stock/market-holiday', { exchange: 'US' }, key);
    const rows = (data && data.data) || [];
    const match = rows.find(h => h.atDate === date);
    if (!match) return null;
    // tradingHour empty string => fully closed; otherwise a shortened session.
    const closed = !match.tradingHour;
    return { name: match.eventName || 'Market holiday', status: closed ? 'CLOSED' : `Shortened (${match.tradingHour})`, closed };
  } catch (e) {
    logger.warn('Market-holiday fetch failed', { error: String(e) });
    return null;
  }
}

// ── Per-user ticker gathering ───────────────────────────────────────────────

async function getUserTickers(db, uid) {
  const tickers = new Set();

  // Holdings live under holdings/{uid}/{portfolioId}/{holdingId}; iterate every
  // portfolio subcollection of the user's holdings doc.
  try {
    const portfolioCols = await db.collection('holdings').doc(uid).listCollections();
    for (const col of portfolioCols) {
      const snap = await col.get();
      snap.forEach(doc => {
        const t = (doc.get('ticker') || '').toUpperCase();
        if (t) tickers.add(t);
      });
    }
  } catch (e) {
    logger.warn('Holdings read failed', { uid, error: String(e) });
  }

  // Watchlists: watchlists/{uid}/list/{id} each carry a tickers[] array.
  try {
    const wl = await db.collection('watchlists').doc(uid).collection('list').get();
    wl.forEach(doc => {
      (doc.get('tickers') || []).forEach(t => {
        if (t) tickers.add(String(t).toUpperCase());
      });
    });
  } catch (e) {
    logger.warn('Watchlist read failed', { uid, error: String(e) });
  }

  return tickers;
}

// ── Digest composition ────────────────────────────────────────────────────────

const HOUR_LABEL = { bmo: 'before open', amc: 'after close', dmh: 'during market hours', dmt: 'during market hours' };

// Trim a long, detailed body down to a single-line teaser for the OS push banner.
// The full detailed body is still stored on the notification doc for the in-app view.
function pushBody(s) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > 180 ? one.slice(0, 177) + '…' : one;
}

function composeDigest({ date, userEarnings, macro, holiday }) {
  if (holiday && holiday.closed) {
    return {
      title: `Markets closed today — ${holiday.name}`,
      body: `US markets are closed today for ${holiday.name}, so there's no trading and no pre-market action needed. Use the day to review your holdings, check your stop-loss levels, and line up entries on your watchlist for the next session.`
    };
  }

  const lines = [];
  let title;

  if (userEarnings.length) {
    const list = userEarnings.map(e => `${e.ticker}${e.hour ? ' (' + (HOUR_LABEL[e.hour] || e.hour) + ')' : ''}`).join(', ');
    title = `${userEarnings.length} of your holding${userEarnings.length > 1 ? 's report' : ' reports'} earnings today`;
    lines.push(`📊 Earnings in your portfolio today: ${list}. Earnings reports frequently cause large overnight price gaps in either direction. Decide in advance whether to hold through the report (higher risk and reward), trim your position to reduce exposure, or set a protective stop — and avoid opening a brand-new full position right before the announcement.`);
  } else {
    title = 'Your pre-market market brief';
  }

  if (macro.length) {
    const macroList = macro.slice(0, 4).map(m => `${m.event}${m.time ? ' at ' + m.time : ''}`).join('; ');
    lines.push(`🏛️ Major economic events today: ${macroList}. Releases like Fed rate decisions, inflation (CPI) and the jobs report move the whole market at once. Expect a spike in volatility around the release time, and be cautious about opening new positions in the minutes just before it.`);
  }

  if (holiday && !holiday.closed) {
    lines.push(`🕑 Shortened trading session today (${holiday.name}) — the market closes early, so volume and liquidity thin out in the afternoon. Place orders earlier in the day if you can.`);
  }

  if (!lines.length) {
    lines.push('No earnings for your holdings and no major economic releases are scheduled today. A quiet calendar is a good time to review each position against its original thesis, confirm your stop levels, and watch your watchlist for fresh setups.');
  }

  return { title, body: lines.join('\n\n') };
}

// ── Core run (shared by the scheduled fn and the test endpoint) ────────────────

async function runPremarket(key) {
  const db = admin.firestore();
  const messaging = admin.messaging();
  const date = todayInET();

  const [earnings, macro, holiday] = await Promise.all([
    getEarningsToday(date, key),
    getMacroToday(date, key),
    getHolidayToday(date, key)
  ]);

  const earningsByTicker = new Map(earnings.map(e => [e.ticker, e]));
  logger.info('Calendar pulled', { date, earnings: earnings.length, macro: macro.length, holiday: holiday && holiday.name });

  // Recipients = users with at least one registered FCM token.
  const usersSnap = await db.collection('users').get();
  const recipients = [];
  usersSnap.forEach(doc => {
    const tokens = doc.get('fcmTokens');
    if (Array.isArray(tokens) && tokens.length) recipients.push({ uid: doc.id, tokens });
  });

  const summary = { date, users: recipients.length, sent: 0, failed: 0, skipped: 0, prunedTokens: 0 };

  for (const { uid, tokens } of recipients) {
    // Match today's earnings to this user's own tickers (skip the matching on a
    // closed-market day — the digest is just the holiday notice).
    let userEarnings = [];
    if (!(holiday && holiday.closed)) {
      const userTickers = await getUserTickers(db, uid);
      userEarnings = [...userTickers]
        .filter(t => earningsByTicker.has(t))
        .map(t => earningsByTicker.get(t));
    }

    // Always send a daily morning brief — even on a quiet day the digest gives a
    // "no earnings / no major events" summary with a review nudge.
    const { title, body } = composeDigest({ date, userEarnings, macro, holiday });

    // 1. Persist the digest (the web app's Pre-Market tab reads this live).
    await db.collection('notifications').doc(uid).collection('list').add({
      date,
      type: 'premarket_digest',
      title,
      body,
      earnings: userEarnings.map(e => ({
        ticker: e.ticker,
        hour: e.hour || '',
        hourLabel: HOUR_LABEL[e.hour] || '',
        epsEstimate: e.epsEstimate
      })),
      macro,
      holiday: holiday || null,
      read: false,
      status: 'sent',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2. Push to the user's devices.
    try {
      const resp = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body: pushBody(body) },
        data: { type: 'premarket_digest', date },
        webpush: { fcmOptions: { link: '/' } }
      });
      summary.sent += resp.successCount;
      summary.failed += resp.failureCount;

      // 3. Prune dead tokens.
      const dead = [];
      resp.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/invalid-argument') {
            dead.push(tokens[i]);
          }
        }
      });
      if (dead.length) {
        await db.collection('users').doc(uid).set(
          { fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) },
          { merge: true }
        );
        summary.prunedTokens += dead.length;
      }
    } catch (e) {
      logger.error('FCM send failed', { uid, error: String(e) });
      summary.failed += tokens.length;
    }
  }

  logger.info('Pre-market run complete', summary);
  return summary;
}

// ── Exported functions ─────────────────────────────────────────────────────────

// Scheduled: 08:00 ET, Monday–Friday.
exports.premarketNotifications = onSchedule(
  {
    schedule: '0 8 * * 1-5',
    timeZone: 'America/New_York',
    secrets: [FINNHUB_API_KEY],
    region: 'us-central1'
  },
  async () => {
    await runPremarket(FINNHUB_API_KEY.value());
  }
);

// On-demand test endpoint. Guarded by ?token=<FINNHUB_API_KEY>. REMOVE before prod
// or replace the guard with proper auth.
exports.runPremarketNow = onRequest(
  { secrets: [FINNHUB_API_KEY], region: 'us-central1' },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    if (req.query.token !== key) {
      res.status(403).send('Forbidden: pass ?token=<FINNHUB_API_KEY> to run the test.');
      return;
    }
    try {
      const summary = await runPremarket(key);
      res.status(200).json({ ok: true, summary });
    } catch (e) {
      logger.error('runPremarketNow failed', { error: String(e) });
      res.status(500).json({ ok: false, error: String(e) });
    }
  }
);

// ── Live quote proxy ────────────────────────────────────────────────────────
// The browser can't call Yahoo Finance directly (no CORS headers). This function
// fetches it server-side (no CORS restriction) and returns clean JSON with CORS
// enabled, so the web app can read it without flaky public proxies.
// GET /getQuote?symbols=NVDA,AAPL  ->  { quotes: { NVDA:{price,prev}, ... } }
exports.getQuote = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    const symbols = String(req.query.symbols || '')
      .split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
    const quotes = {};
    await Promise.all(symbols.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return;
        const d = await r.json();
        const meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
        if (meta && meta.regularMarketPrice != null) {
          quotes[sym] = {
            price: meta.regularMarketPrice,
            prev: meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice
          };
        }
      } catch (e) { /* skip this symbol */ }
    }));
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ quotes });
  }
);

// ── Symbol search proxy ──────────────────────────────────────────────────────
// Server-side Yahoo symbol/name search (CORS-enabled) so the app's top search box
// can find ANY instrument — even ones not in the bundled symbols.js catalog —
// without hitting the browser CORS wall or flaky public proxies.
// GET /searchSymbols?q=nvidia  ->  { quotes: [ { symbol, shortname, ... }, ... ] }
exports.searchSymbols = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 64);
    if (!q) { res.json({ quotes: [] }); return; }
    try {
      const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { res.json({ quotes: [] }); return; }
      const d = await r.json();
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ quotes: (d && d.quotes) || [] });
    } catch (e) {
      res.json({ quotes: [] });
    }
  }
);

// ── Portfolio + influencer news proxy ────────────────────────────────────────
// Powers the Home dashboard. Returns three buckets of news:
//   portfolio  — company news for each of the user's holdings
//   influencer — market news mentioning a market-moving figure/institution OR a held stock
//   market     — top general market headlines
// GET /getNews?symbols=NVDA,AAPL  ->  { portfolio:[], influencer:[], market:[] }
const INFLUENCER_KEYWORDS = [
  // policy / politicians
  'trump', 'biden', 'white house', 'jerome powell', 'powell', 'federal reserve', 'the fed', 'fed ',
  'rate cut', 'rate hike', 'interest rate', 'tariff', 'treasury', 'yellen', 'sec ',
  // CEOs / founders
  'elon musk', 'musk', 'jensen huang', 'tim cook', 'sundar pichai', 'satya nadella',
  'mark zuckerberg', 'sam altman', 'warren buffett',
  // institutions / ratings
  'berkshire', 'blackrock', 'jpmorgan', 'goldman sachs', 'morgan stanley', 'moody', 'fitch',
  's&p global', 'downgrade', 'upgrade', 'analyst',
  // geopolitics / macro shocks — market-moving even with no named figure
  'iran', 'israel', 'gaza', 'ukraine', 'russia', 'china', 'middle east', 'opec',
  'sanction', 'embargo', 'ceasefire', 'geopolit', 'nuclear', 'military', 'trade war',
  'crude', 'oil price', 'recession', 'inflation', 'jobs report', 'gdp', 'shutdown'
];

function mapNewsRows(rows, max) {
  const out = [], seen = {};
  for (const a of (rows || [])) {
    const title = a.headline || '';
    if (!title || seen[title]) continue;
    seen[title] = 1;
    out.push({
      title,
      summary: (a.summary || '').slice(0, 300),
      source: a.source || '',
      url: a.url || '',
      datetime: a.datetime || 0,
      image: a.image || '',
      tickers: a.related ? String(a.related).split(',').filter(Boolean).slice(0, 3) : []
    });
    if (out.length >= max) break;
  }
  return out;
}

// Google News RSS (free, no key) — broadens news with many outlets, like Google Finance. Regex-parsed
// (no XML dep); returns Finnhub-shaped rows ({headline,source,url,datetime,related}) so mapNewsRows can merge them.
async function googleNewsRss(query, ticker) {
  try {
    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-US&gl=US&ceid=US:en';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const xml = await r.text();
    const dec = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();
    return xml.split('<item>').slice(1, 26).map(block => {
      const grab = re => { const m = block.match(re); return m ? dec(m[1]) : ''; };
      let title = grab(/<title>([\s\S]*?)<\/title>/);
      const link = grab(/<link>([\s\S]*?)<\/link>/);
      const pub = grab(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const source = grab(/<source[^>]*>([\s\S]*?)<\/source>/);
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));   // Google titles end with " - Outlet"
      const dt = pub ? Math.floor(Date.parse(pub) / 1000) : 0;
      return { headline: title, source: source || 'Google News', url: link, datetime: dt || 0, related: ticker || '' };
    }).filter(x => x.headline && x.url);
  } catch (e) { return []; }
}
exports.getNews = onRequest(
  { region: 'us-central1', cors: true, secrets: [FINNHUB_API_KEY] },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    const symbols = String(req.query.symbols || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 25);
    const today = todayInET();
    const fromDate = (function () { const d = new Date(today.replace(/-/g, '/')); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10); })();
    try {
      // General market news FIRST — fetched before the per-holding loop so it is never starved by
      // rate limits when many holdings are requested ("All portfolios"). This feeds the always-on
      // "Markets & Influencers" panel, which must not depend on how many holdings the user has.
      let generalRaw = [];
      try { generalRaw = (await finnhubGet('/news', { category: 'general' }, key)) || []; } catch (e) {}
      // Broaden the market feed with Google News RSS (many outlets) — merged + deduped by mapNewsRows.
      try { generalRaw = generalRaw.concat(await googleNewsRss('stock market OR S&P 500 OR Nasdaq OR Dow Jones')); } catch (e) {}
      generalRaw.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));

      // Per-holding company news — Finnhub company-news + Google News RSS per symbol (cap 8, parallel).
      const portfolioRaw = [];
      for (const sym of symbols) {
        try {
          const rows = await finnhubGet('/company-news', { symbol: sym, from: fromDate, to: today }, key);
          (rows || []).slice(0, 8).forEach(a => portfolioRaw.push(a));
        } catch (e) { /* skip symbol */ }
      }
      try {
        const rss = await Promise.all(symbols.slice(0, 8).map(s => googleNewsRss('"' + s + '" stock', s)));
        rss.forEach(arr => arr.forEach(a => portfolioRaw.push(a)));
      } catch (e) {}
      portfolioRaw.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));

      // Influencer feed: general items mentioning an influencer keyword OR a held ticker
      const symLower = symbols.map(s => s.toLowerCase());
      const influencerRaw = generalRaw.filter(a => {
        const t = ((a.headline || '') + ' ' + (a.summary || '') + ' ' + (a.related || '')).toLowerCase();
        return INFLUENCER_KEYWORDS.some(k => t.includes(k)) || symLower.some(s => t.includes(s));
      });

      res.set('Cache-Control', 'public, max-age=600');
      res.json({
        portfolio: mapNewsRows(portfolioRaw, 35),
        influencer: mapNewsRows(influencerRaw, 25),
        market: mapNewsRows(generalRaw, 25)
      });
    } catch (e) {
      res.status(200).json({ portfolio: [], influencer: [], market: [], error: String(e) });
    }
  }
);

// ── Earnings calendar (Finnhub) — powers the Google-Finance-style Earnings tab ──
// GET /getEarnings?from=YYYY-MM-DD&to=YYYY-MM-DD (default today..+7d) ->
//   { from, to, earnings:[{ symbol, date, hour, epsEstimate, epsActual, revenueEstimate }] }
exports.getEarnings = onRequest(
  { region: 'us-central1', cors: true, secrets: [FINNHUB_API_KEY] },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    const today = todayInET();
    const plus = n => { const d = new Date(today.replace(/-/g, '/')); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const from = String(req.query.from || today).slice(0, 10);
    const to = String(req.query.to || plus(7)).slice(0, 10);
    try {
      const data = await finnhubGet('/calendar/earnings', { from, to }, key);
      const earnings = ((data && data.earningsCalendar) || []).map(r => ({
        symbol: (r.symbol || '').toUpperCase(),
        date: r.date || '',
        hour: r.hour || '',
        epsEstimate: r.epsEstimate != null ? r.epsEstimate : null,
        epsActual: r.epsActual != null ? r.epsActual : null,
        revenueEstimate: r.revenueEstimate != null ? r.revenueEstimate : null
      })).filter(r => r.symbol);
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ from, to, earnings });
    } catch (e) {
      res.status(200).json({ from, to, earnings: [], error: String(e) });
    }
  }
);

// ── 52-week range proxy (FULL coverage — any ticker, via Finnhub metrics) ─────
// GET /getRange?symbols=NVDA,AAPL  ->  { ranges: { NVDA:{high52,low52}, ... } }
exports.getRange = onRequest(
  { region: 'us-central1', cors: true, secrets: [FINNHUB_API_KEY] },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    const symbols = String(req.query.symbols || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
    const ranges = {};
    for (const sym of symbols) {
      try {
        const d = await finnhubGet('/stock/metric', { symbol: sym, metric: 'all' }, key);
        const m = (d && d.metric) || {};
        const hi = m['52WeekHigh'], lo = m['52WeekLow'];
        if (hi != null && lo != null) ranges[sym] = { high52: hi, low52: lo };
      } catch (e) { /* skip symbol */ }
    }
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ranges });
  }
);

// ── Company profiles / logos (cached forever in Firestore — logos are static) ──
// GET /getProfiles?symbols=NVDA,AAPL  ->  { profiles: { NVDA:{logo,name,marketCap,industry}, ... } }
exports.getProfiles = onRequest(
  { region: 'us-central1', cors: true, secrets: [FINNHUB_API_KEY] },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    const db = admin.firestore();
    const symbols = String(req.query.symbols || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 40);
    const out = {};
    for (const sym of symbols) {
      const ref = db.collection('logos').doc(sym);
      try { const snap = await ref.get(); if (snap.exists) { out[sym] = snap.data(); continue; } } catch (e) {}
      try {
        const p = await finnhubGet('/stock/profile2', { symbol: sym }, key);
        const rec = {
          logo: (p && p.logo) || '',
          name: (p && p.name) || '',
          marketCap: (p && p.marketCapitalization != null) ? p.marketCapitalization : null,
          industry: (p && p.finnhubIndustry) || '',
          exchange: (p && p.exchange) || ''
        };
        out[sym] = rec;
        try { await ref.set(rec); } catch (e) {}   // cache the successful lookup (even if no logo) so we don't refetch
      } catch (e) { out[sym] = { logo: '', name: '', marketCap: null, industry: '' }; }  // transient fail — not cached, retried next time
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ profiles: out });
  }
);

// ── Price time-series for the Charts tab (Yahoo chart proxy; the browser can't call Yahoo directly due to CORS) ──
function seriesRangeInterval(range) {
  switch (range) {
    case '1mo': return { range: '1mo', interval: '1d' };
    case '3mo': return { range: '3mo', interval: '1d' };
    case '6mo': return { range: '6mo', interval: '1d' };
    case '5y': return { range: '5y', interval: '1wk' };
    case '1y':
    default: return { range: '1y', interval: '1d' };
  }
}
exports.getSeries = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    const sym = String(req.query.symbol || '').trim().toUpperCase();
    if (!sym) { res.status(400).json({ error: 'symbol required' }); return; }
    const { range, interval } = seriesRangeInterval(String(req.query.range || '1y'));
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { res.status(502).json({ error: 'upstream ' + r.status }); return; }
      const d = await r.json();
      const result = d && d.chart && d.chart.result && d.chart.result[0];
      if (!result || !result.timestamp) { res.status(404).json({ error: 'no data' }); return; }
      const ts = result.timestamp;
      const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
      const meta = result.meta || {};
      const t = [], o = [], h = [], l = [], c = [], v = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.close && q.close[i] != null) {
          t.push(ts[i]);
          o.push(q.open ? q.open[i] : null);
          h.push(q.high ? q.high[i] : null);
          l.push(q.low ? q.low[i] : null);
          c.push(+(+q.close[i]).toFixed(4));
          v.push(q.volume ? q.volume[i] : null);
        }
      }
      res.set('Cache-Control', 'public, max-age=600');
      res.json({
        symbol: sym, range, interval, currency: meta.currency || 'USD',
        t, o, h, l, c, v,
        meta: {
          price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose || meta.previousClose,
          high52: meta.fiftyTwoWeekHigh, low52: meta.fiftyTwoWeekLow,
          exchange: meta.exchangeName, name: meta.longName || meta.shortName || sym
        }
      });
    } catch (e) {
      logger.error('getSeries failed', { sym, error: String(e) });
      res.status(500).json({ error: 'series unavailable' });
    }
  }
);

// ── YTD return + dividends (Yahoo chart proxy; quota-free, no Finnhub) ────────
// GET /getYtd?symbols=NVDA,AAPL ->
//   { ytd: { NVDA:{ ytdStartPrice, currentPrice, ytdReturnPct, divs:[{date,amount}] }, ... } }
// Powers the portfolio's YTD Return ($/%) and YTD Dividend Income ($) columns.
exports.getYtd = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    const symbols = String(req.query.symbols || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
    const ytd = {};
    const yearStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
    const fetchChart = async (ysym, range) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?range=${range}&interval=1d&events=div`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.chart && d.chart.result && d.chart.result[0]) || null;
    };
    await Promise.all(symbols.map(async (sym) => {
      const ysym = sym.replace(/\./g, '-');
      try {
        // range=ytd is the happy path; some symbols reject it, so fall back to 1y sliced to Jan 1.
        let result = await fetchChart(ysym, 'ytd');
        if (!result || !result.timestamp) result = await fetchChart(ysym, '1y');
        if (!result || !result.timestamp) return;
        const ts = result.timestamp;
        const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
        let startPrice = null, endPrice = null;
        for (let i = 0; i < ts.length; i++) {
          if (ts[i] >= yearStart && closes[i] != null) { if (startPrice == null) startPrice = closes[i]; endPrice = closes[i]; }
        }
        const divsMap = (result.events && result.events.dividends) || {};
        const divs = Object.values(divsMap)
          .filter(dv => dv && dv.date >= yearStart && dv.amount != null)
          .map(dv => ({ date: new Date(dv.date * 1000).toISOString().slice(0, 10), amount: +dv.amount }))
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        if (startPrice != null && endPrice != null) {
          ytd[sym] = {
            ytdStartPrice: +(+startPrice).toFixed(4),
            currentPrice: +(+endPrice).toFixed(4),
            ytdReturnPct: +(((endPrice / startPrice) - 1) * 100).toFixed(2),
            divs
          };
        }
      } catch (e) { /* skip this symbol */ }
    }));
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ytd });
  }
);

// ── Analyst recommendations + price targets (powers the Recommendation tab) ────
// Wall-Street consensus distribution from Finnhub /stock/recommendation (free key),
// plus mean/high/low price target + analyst count from Yahoo quoteSummary
// (financialData). Yahoo's quoteSummary needs a cookie+crumb, fetched once and cached
// per instance. Every source is independent + defensive: a partial result is returned
// if either upstream fails (the front-end degrades to the consensus rating it already
// has baked into the scan).
// GET /getRecommend?symbol=NVDA ->
//   { symbol, consensus:{period,strongBuy,buy,hold,sell,strongSell,total}|null,
//     target:{mean,high,low,current,numAnalysts,recommendationMean,recommendationKey}|null, asOf }
let _yCrumb = null, _yCookie = null, _yCrumbAt = 0;
// fetch with a hard timeout so a hung/slow upstream can never block the whole function past its budget.
async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 5000);
  try { return await fetch(url, { ...(opts || {}), signal: ac.signal }); }
  finally { clearTimeout(t); }
}
function _yInvalidate() { _yCrumb = null; _yCookie = null; _yCrumbAt = 0; }
async function yahooCrumb() {
  // Cache on the crumb alone: a valid crumb sometimes comes back with an empty cookie string, and
  // gating the cache read on a truthy cookie would re-mint (two extra fetches) on every call.
  if (_yCrumb && (Date.now() - _yCrumbAt) < 30 * 60 * 1000) return { crumb: _yCrumb, cookie: _yCookie };
  try {
    // 1) hit a Yahoo host to collect the consent cookies, 2) exchange them for a crumb.
    const r1 = await fetchT('https://fc.yahoo.com', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
    const list = r1.headers.getSetCookie ? r1.headers.getSetCookie() : (r1.headers.get('set-cookie') ? [r1.headers.get('set-cookie')] : []);
    const cookie = list.map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
    const r2 = await fetchT('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie } }, 5000);
    const crumb = (await r2.text()).trim();
    if (crumb && crumb.length < 64 && !/[<{>]/.test(crumb)) { _yCrumb = crumb; _yCookie = cookie; _yCrumbAt = Date.now(); }
  } catch (e) { /* self-contained: leave any prior cache; caller handles a null crumb */ }
  return { crumb: _yCrumb, cookie: _yCookie };
}
async function yahooTargets(sym, _retried) {
  try {
    const { crumb, cookie } = await yahooCrumb();
    if (!crumb) return null;
    const ysym = sym.replace(/\./g, '-');
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ysym)}?modules=financialData,recommendationTrend&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetchT(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie } }, 5000);
    if (!r.ok) {
      // 401/403 (and often 404) mean the cached crumb/cookie went stale — drop it and retry once
      // with a fresh crumb instead of returning null for the rest of the 30-min TTL.
      if (!_retried && (r.status === 401 || r.status === 403 || r.status === 404)) { _yInvalidate(); return yahooTargets(sym, true); }
      return null;
    }
    const d = await r.json();
    const qs = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
    const fd = qs && qs.financialData;
    if (!fd) return null;
    const raw = x => (x && x.raw != null) ? x.raw : null;
    const mean = raw(fd.targetMeanPrice);
    if (mean == null && raw(fd.targetHighPrice) == null) return null;   // no usable target
    return {
      mean, high: raw(fd.targetHighPrice), low: raw(fd.targetLowPrice),
      current: raw(fd.currentPrice), numAnalysts: raw(fd.numberOfAnalystOpinions),
      recommendationMean: raw(fd.recommendationMean),
      recommendationKey: fd.recommendationKey || null
    };
  } catch (e) { return null; }
}
exports.getRecommend = onRequest(
  { region: 'us-central1', cors: true, secrets: [FINNHUB_API_KEY], timeoutSeconds: 30 },
  async (req, res) => {
    const sym = String(req.query.symbol || '').trim().toUpperCase();
    if (!sym) { res.status(400).json({ error: 'symbol required' }); return; }
    const key = FINNHUB_API_KEY.value();
    // Both sources run in parallel and are independently fault-tolerant; a hung upstream is bounded
    // by fetchT (Yahoo) and a Promise.race timeout (Finnhub), so the response always lands well
    // within timeoutSeconds with whatever succeeded (the front-end degrades on a null).
    const [consensus, target] = await Promise.all([
      (async () => {
        try {
          const arr = await Promise.race([
            finnhubGet('/stock/recommendation', { symbol: sym }, key),
            new Promise((_, rej) => setTimeout(() => rej(new Error('finnhub timeout')), 6000))
          ]);
          const l = Array.isArray(arr) && arr.length ? arr[0] : null;
          if (l) {
            const sb = +l.strongBuy || 0, b = +l.buy || 0, h = +l.hold || 0, s = +l.sell || 0, ss = +l.strongSell || 0;
            const total = sb + b + h + s + ss;
            if (total > 0) return { period: l.period || '', strongBuy: sb, buy: b, hold: h, sell: s, strongSell: ss, total };
          }
        } catch (e) { /* consensus stays null */ }
        return null;
      })(),
      (async () => { try { return await yahooTargets(sym); } catch (e) { return null; } })()
    ]);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ symbol: sym, consensus, target, asOf: Date.now() });
  }
);

// ── Intraday alert monitor (price moves, market moves, earnings) ──────────────
// Runs hourly during market hours. Fires (deduped per user/day):
//   • market_move   — S&P (SPY) moves ±1% on the day
//   • price_move    — a holding moves ±5% on the day
//   • earnings_alert— a holding reports earnings today
const MARKET_MOVE_PCT = 1.0;
const STOCK_MOVE_PCT = 5.0;

async function getHoldingTickers(db, uid) {
  const tickers = new Set();
  try {
    const cols = await db.collection('holdings').doc(uid).listCollections();
    for (const col of cols) {
      const snap = await col.get();
      snap.forEach(d => { const t = (d.get('ticker') || '').toUpperCase(); if (t) tickers.add(t); });
    }
  } catch (e) { logger.warn('Holdings read failed (intraday)', { uid, error: String(e) }); }
  return tickers;
}

async function runIntraday(key) {
  const db = admin.firestore();
  const messaging = admin.messaging();
  const date = todayInET();

  const usersSnap = await db.collection('users').get();
  const recipients = [];
  usersSnap.forEach(doc => { const tokens = doc.get('fcmTokens'); if (Array.isArray(tokens) && tokens.length) recipients.push({ uid: doc.id, tokens }); });

  // Unique tickers across everyone's holdings + SPY (market proxy).
  const allTickers = new Set(['SPY']);
  const userTickers = {};
  for (const { uid } of recipients) { const t = await getHoldingTickers(db, uid); userTickers[uid] = t; t.forEach(x => allTickers.add(x)); }

  let earningsSet = new Set();
  try { earningsSet = new Set((await getEarningsToday(date, key)).map(e => e.ticker)); } catch (e) {}

  // Finnhub /quote: c=current, pc=prev close, dp=percent change.
  const quotes = {};
  for (const sym of allTickers) {
    try { const q = await finnhubGet('/quote', { symbol: sym }, key); if (q && q.c) quotes[sym] = { price: q.c, prev: q.pc, dp: q.dp || 0 }; } catch (e) {}
  }
  const spy = quotes['SPY'];
  const summary = { date, users: recipients.length, alerts: 0, sent: 0, skipped: 0 };

  for (const { uid, tokens } of recipients) {
    const stateRef = db.collection('alert_state').doc(uid);
    let state = {};
    try { const s = await stateRef.get(); state = s.exists ? s.data() : {}; } catch (e) {}
    if (state.date !== date) state = { date, keys: [] };
    const fired = new Set(state.keys || []);
    const alerts = [];

    if (spy && Math.abs(spy.dp) >= MARKET_MOVE_PCT) {
      const dir = spy.dp >= 0 ? 'up' : 'down';
      if (!fired.has('market:' + dir)) {
        fired.add('market:' + dir);
        const mv = Math.abs(spy.dp).toFixed(1);
        const body = dir === 'up'
          ? `The S&P 500 (SPY) is up ${mv}% today, around $${spy.price.toFixed(2)} — broad market strength that's lifting most stocks. Good time to review your winners and consider trimming anything that has run far above its trend, but avoid chasing sharp spikes at these levels.`
          : `The S&P 500 (SPY) is down ${mv}% today, around $${spy.price.toFixed(2)} — broad market weakness pressuring most stocks. Don't panic-sell quality holdings on a red day; make sure your stop-losses are set, and keep some cash ready in case the selloff opens up better entry prices.`;
        alerts.push({ type: 'market_move', ticker: 'SPY', pct: spy.dp, title: `S&P 500 ${dir} ${mv}% today`, body });
      }
    }

    for (const t of (userTickers[uid] || new Set())) {
      const q = quotes[t];
      if (q && Math.abs(q.dp) >= STOCK_MOVE_PCT) {
        const dir = q.dp >= 0 ? 'up' : 'down';
        if (!fired.has('move:' + t + ':' + dir)) {
          fired.add('move:' + t + ':' + dir);
          const mv = Math.abs(q.dp).toFixed(1);
          const earnNote = earningsSet.has(t) ? ' It also reports earnings today, so expect continued swings.' : '';
          const body = dir === 'up'
            ? `${t} is up ${mv}% today, trading around $${q.price.toFixed(2)} — a strong move higher. If it's a holding, consider taking partial profits or raising your stop to lock in the gain rather than chasing it while it's extended.${earnNote}`
            : `${t} is down ${mv}% today, trading around $${q.price.toFixed(2)} — a sharp drop. Check the news driving it: if your original thesis still holds this may just be noise, but if it breaks your planned stop level, follow your exit rule instead of hoping for a bounce.${earnNote}`;
          alerts.push({ type: 'price_move', ticker: t, pct: q.dp, title: `${t} ${dir} ${mv}% today`, body });
        }
      }
      if (earningsSet.has(t) && !fired.has('earn:' + t)) {
        fired.add('earn:' + t);
        alerts.push({ type: 'earnings_alert', ticker: t, pct: null,
          title: `${t} reports earnings today`,
          body: `${t} reports earnings today. Earnings can cause a large overnight gap up or down, so decide your plan in advance: hold through the report (higher risk and reward), trim your position to cut exposure, or set a protective stop. Avoid opening a fresh full position right before the announcement.` });
      }
    }

    if (!alerts.length) { summary.skipped++; continue; }

    for (const a of alerts) {
      await db.collection('notifications').doc(uid).collection('list').add({
        date, type: a.type, title: a.title, body: a.body,
        ticker: a.ticker || null, pct: (a.pct != null ? a.pct : null),
        read: false, status: 'sent', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      summary.alerts++;
      try {
        const resp = await messaging.sendEachForMulticast({ tokens, notification: { title: a.title, body: pushBody(a.body) }, data: { type: a.type, date }, webpush: { fcmOptions: { link: '/' } } });
        summary.sent += resp.successCount;
        const dead = [];
        resp.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') dead.push(tokens[i]); } });
        if (dead.length) await db.collection('users').doc(uid).set({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) }, { merge: true });
      } catch (e) { logger.error('intraday FCM send failed', { uid, error: String(e) }); }
    }

    try { await stateRef.set({ date, keys: [...fired] }); } catch (e) {}
  }

  logger.info('Intraday run complete', summary);
  return summary;
}

// Scheduled: hourly during US market hours (10:00–16:00 ET), Mon–Fri.
exports.intradayMonitor = onSchedule(
  { schedule: '0 10-16 * * 1-5', timeZone: 'America/New_York', secrets: [FINNHUB_API_KEY], region: 'us-central1' },
  async () => { await runIntraday(FINNHUB_API_KEY.value()); }
);

// On-demand test for the intraday monitor. Guarded by ?token=<FINNHUB_API_KEY>.
exports.runIntradayNow = onRequest(
  { secrets: [FINNHUB_API_KEY], region: 'us-central1' },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    if (req.query.token !== key) { res.status(403).send('Forbidden'); return; }
    try { res.status(200).json({ ok: true, summary: await runIntraday(key) }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  }
);

// ── User alerts (the Alerts tab) ──────────────────────────────────────────────
// Evaluates each user's custom alerts (alerts/{uid}/list) against live quotes and
// fires an in-app notification (+ FCM push) when a condition is met. Deduped per
// day via alert_state/ua_{uid} so a crossed threshold notifies once, not every run.
function _alertNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
}
function _alertTriggered(cond, value, q) {
  if (cond === 'news') return false;            // handled separately
  const v = _alertNum(value);
  if (v == null || q.price == null) return false;
  const dp = q.dp == null ? 0 : q.dp;
  switch (cond) {
    case 'price_above': return q.price >= v;
    case 'price_below': return q.price <= v;
    case 'pct_above':   return dp >= Math.abs(v);          // up by at least v%
    case 'pct_below':   return dp <= -Math.abs(v);         // down by at least v%
    case 'pct_change':  return Math.abs(dp) >= Math.abs(v); // legacy: moved either way
    default: return false;
  }
}
function _alertText(cond, v, ticker, q) {
  const px = q.price != null ? `$${q.price.toFixed(2)}` : 'n/a';
  const dp = (q.dp >= 0 ? '+' : '') + (q.dp != null ? q.dp.toFixed(2) : '0') + '%';
  switch (cond) {
    case 'price_above': return { title: `${ticker} crossed above $${v}`, body: `${ticker} is trading at ${px}, at or above your $${v} alert. Decide whether this is a take-profit level or a breakout to add into, and reset your stop to protect the move.` };
    case 'price_below': return { title: `${ticker} dropped below $${v}`, body: `${ticker} is trading at ${px}, at or below your $${v} alert. If this breaks your planned stop, follow your exit rule rather than hoping for a bounce; if your thesis is intact it may be an add level.` };
    case 'pct_above':   return { title: `${ticker} up ${dp} today`, body: `${ticker} is up ${dp} today (${px}), past your +${v}% alert. Strong momentum — consider trimming or raising your stop rather than chasing an extended move.` };
    case 'pct_below':   return { title: `${ticker} down ${dp} today`, body: `${ticker} is down ${dp} today (${px}), past your -${v}% alert. Check the news behind the drop and stick to your exit plan if it breaks your stop.` };
    case 'pct_change':  return { title: `${ticker} moved ${dp} today`, body: `${ticker} has moved ${dp} today (${px}), past your ${v}% alert.` };
    default:            return { title: `${ticker} alert`, body: `${ticker} is at ${px} (${dp} today).` };
  }
}

async function runUserAlerts(key) {
  const db = admin.firestore();
  const messaging = admin.messaging();
  const date = todayInET();

  // Discover owners from the alerts collection itself, NOT the users collection: a user who
  // sets an alert may not have a users/{uid} doc yet (that's only created when push is enabled),
  // and their in-app alerts must still fire. listDocuments() returns a ref for every uid that
  // has an alerts/{uid}/list subcollection, even if the parent doc has no fields.
  const alertOwners = await db.collection('alerts').listDocuments();
  const summary = { date, usersWithAlerts: 0, checked: 0, fired: 0, sent: 0 };

  const quoteCache = {};
  async function getQuote(sym) {
    if (sym in quoteCache) return quoteCache[sym];
    let q = null;
    try { const r = await finnhubGet('/quote', { symbol: sym }, key); if (r && r.c) q = { price: r.c, prev: r.pc, dp: r.dp || 0 }; } catch (e) {}
    quoteCache[sym] = q; return q;
  }

  for (const ownerRef of alertOwners) {
    const uid = ownerRef.id;
    let alertsSnap;
    try { alertsSnap = await ownerRef.collection('list').get(); } catch (e) { continue; }
    if (alertsSnap.empty) continue;
    summary.usersWithAlerts++;

    let tokens = [];
    try { const udoc = await db.collection('users').doc(uid).get(); tokens = Array.isArray(udoc.get('fcmTokens')) ? udoc.get('fcmTokens') : []; } catch (e) {}
    const stateRef = db.collection('alert_state').doc('ua_' + uid);
    let state = {};
    try { const s = await stateRef.get(); state = s.exists ? s.data() : {}; } catch (e) {}
    if (state.date !== date) state = { date, keys: [] };
    const fired = new Set(state.keys || []);
    const toNotify = [];

    for (const adoc of alertsSnap.docs) {
      const a = adoc.data(); summary.checked++;
      const ticker = (a.ticker || '').toUpperCase().trim();
      const cond = a.condition || a.type;
      if (!ticker || !cond) continue;

      if (cond === 'news') {
        let rows = [];
        try { rows = (await finnhubGet('/company-news', { symbol: ticker, from: date, to: date }, key)) || []; } catch (e) {}
        rows.sort((x, y) => (y.datetime || 0) - (x.datetime || 0));
        const top = rows[0];
        if (top && top.id != null) {
          const k = 'uanews:' + adoc.id + ':' + top.id;
          if (!fired.has(k)) {
            fired.add(k);
            toNotify.push({ ticker, pct: null, url: top.url || '',
              title: `News: ${ticker} — ${String(top.headline || 'new headline').slice(0, 80)}`,
              body: `${String(top.summary || top.headline || '').slice(0, 220)} (${top.source || 'news'})` + (a.note ? ' — Note: ' + a.note : '') });
          }
        }
        continue;
      }

      const k = 'ua:' + adoc.id;          // one notification per price/percent alert per day
      if (fired.has(k)) continue;
      const q = await getQuote(ticker);
      if (!q) continue;
      if (_alertTriggered(cond, a.value, q)) {
        fired.add(k);
        const t = _alertText(cond, _alertNum(a.value), ticker, q);
        toNotify.push({ ticker, pct: q.dp != null ? q.dp : null, url: '', title: t.title, body: a.note ? t.body + ' — Note: ' + a.note : t.body });
      }
    }

    for (const n of toNotify) {
      try {
        await db.collection('notifications').doc(uid).collection('list').add({
          date, type: 'user_alert', title: n.title, body: n.body, ticker: n.ticker || null,
          pct: n.pct, url: n.url || null, read: false, status: 'sent',
          data: { type: 'user_alert', url: n.url || '' },
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        summary.fired++;
      } catch (e) { logger.error('user-alert notif write failed', { uid, error: String(e) }); }
      if (tokens.length) {
        try {
          const resp = await messaging.sendEachForMulticast({ tokens, notification: { title: n.title, body: pushBody(n.body) }, data: { type: 'user_alert', url: String(n.url || '') }, webpush: { fcmOptions: { link: '/' } } });
          summary.sent += resp.successCount;
          const dead = [];
          resp.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') dead.push(tokens[i]); } });
          if (dead.length) await db.collection('users').doc(uid).set({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) }, { merge: true });
        } catch (e) { logger.error('user-alert FCM failed', { uid, error: String(e) }); }
      }
    }

    try { await stateRef.set({ date, keys: [...fired] }); } catch (e) {}
  }

  logger.info('User-alerts run complete', summary);
  return summary;
}

// Scheduled: every 15 min during US market hours, Mon–Fri.
exports.userAlertsMonitor = onSchedule(
  { schedule: '*/15 9-16 * * 1-5', timeZone: 'America/New_York', secrets: [FINNHUB_API_KEY], region: 'us-central1' },
  async () => { await runUserAlerts(FINNHUB_API_KEY.value()); }
);

// On-demand test for the user-alerts monitor. Guarded by ?token=<FINNHUB_API_KEY>.
exports.runUserAlertsNow = onRequest(
  { secrets: [FINNHUB_API_KEY], region: 'us-central1' },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    if (req.query.token !== key) { res.status(403).send('Forbidden'); return; }
    try { res.status(200).json({ ok: true, summary: await runUserAlerts(key) }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  }
);

// ── Breaking-news monitor (geopolitical / macro market-movers) ────────────────
// Scans general market news for high-impact headlines (war, ceasefire, sanctions,
// Fed/rate, tariffs, oil/OPEC, crash/selloff…) and pushes a `breaking_news` alert
// to all users. Globally deduped by article id so each headline is sent once.
const HIGH_IMPACT_KEYWORDS = [
  'ceasefire', 'war', 'invasion', 'airstrike', 'missile', 'sanction', 'embargo',
  'tariff', 'trade war', 'rate cut', 'rate hike', 'jerome powell', 'federal reserve',
  'iran', 'israel', 'gaza', 'ukraine', 'russia', 'opec', 'crude oil', 'oil price',
  'recession', 'selloff', 'plunge', 'market crash', 'default', 'credit downgrade',
  'government shutdown', 'nuclear', 'emergency'
];

async function runBreaking(key) {
  const db = admin.firestore();
  const messaging = admin.messaging();
  const date = todayInET();

  const usersSnap = await db.collection('users').get();
  const recipients = [];
  usersSnap.forEach(doc => { const tokens = doc.get('fcmTokens'); if (Array.isArray(tokens) && tokens.length) recipients.push({ uid: doc.id, tokens }); });
  const summary = { recipients: recipients.length, candidates: 0, pushed: 0 };
  if (!recipients.length) return summary;

  let rows = [];
  try { rows = (await finnhubGet('/news', { category: 'general' }, key)) || []; } catch (e) {}
  const nowSec = Math.floor(Date.now() / 1000);
  const fresh = rows
    .filter(a => {
      if (!a || a.id == null) return false;
      if (nowSec - (a.datetime || 0) > 3600) return false;            // published within the last hour
      const t = ((a.headline || '') + ' ' + (a.summary || '')).toLowerCase();
      return HIGH_IMPACT_KEYWORDS.some(k => t.includes(k));
    })
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  summary.candidates = fresh.length;

  // Global dedup by article id.
  const stateRef = db.collection('alert_state').doc('_breaking');
  let seen = [];
  try { const s = await stateRef.get(); seen = (s.exists && s.data().ids) || []; } catch (e) {}
  const seenSet = new Set(seen);
  const toSend = fresh.filter(a => !seenSet.has(a.id)).slice(0, 3);    // cap 3 per run to avoid spam

  for (const a of toSend) {
    const headline = (a.headline || '').slice(0, 120);
    const body = `${(a.summary || '').slice(0, 240) || headline} — Market-moving news like this can swing the broad market and your holdings. Review your exposure and make sure your stops are set.`;
    for (const { uid, tokens } of recipients) {
      try {
        await db.collection('notifications').doc(uid).collection('list').add({
          date, type: 'breaking_news', title: headline, body,
          url: a.url || null, source: a.source || null,
          read: false, status: 'sent', createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        const resp = await messaging.sendEachForMulticast({
          tokens, notification: { title: pushBody(headline), body: pushBody(body) },
          data: { type: 'breaking_news', url: a.url || '' }, webpush: { fcmOptions: { link: '/' } }
        });
        const dead = [];
        resp.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') dead.push(tokens[i]); } });
        if (dead.length) await db.collection('users').doc(uid).set({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) }, { merge: true });
      } catch (e) { logger.error('breaking send failed', { uid, error: String(e) }); }
    }
    seenSet.add(a.id);
    summary.pushed++;
  }

  try { await stateRef.set({ ids: [...seenSet].slice(-200), updated: date }); } catch (e) {}
  logger.info('Breaking news run complete', summary);
  return summary;
}

// Scheduled: every 30 min, 6 AM–9 PM ET, every day (news breaks outside market hours too).
exports.breakingNewsMonitor = onSchedule(
  { schedule: '*/30 6-21 * * *', timeZone: 'America/New_York', secrets: [FINNHUB_API_KEY], region: 'us-central1' },
  async () => { await runBreaking(FINNHUB_API_KEY.value()); }
);

// On-demand test. Guarded by ?token=<FINNHUB_API_KEY>.
exports.runBreakingNow = onRequest(
  { secrets: [FINNHUB_API_KEY], region: 'us-central1' },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    if (req.query.token !== key) { res.status(403).send('Forbidden'); return; }
    try { res.status(200).json({ ok: true, summary: await runBreaking(key) }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  }
);

// ════════════════════════════════════════════════════════════════════════════
//  AI Finance Assistant — OpenRouter, tool-calling agent
//  A Google-Finance-style chat assistant. The model fetches live data on demand
//  via tools (quotes, fundamentals, news, portfolio, comparisons, market). Free
//  model by default — swap OPENROUTER_MODEL for a paid one for max reliability.
// ════════════════════════════════════════════════════════════════════════════
// Free models tried IN ORDER — if one is retired/unavailable/over its free limit, the
// assistant falls through to the next. (Prepend a paid slug like 'anthropic/claude-sonnet-latest'
// only if you ever want guaranteed reliability + tool support.)
const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',   // fast, reliable, supports tools
  'google/gemma-4-31b-it:free',
  'nex-agi/nex-n2-pro:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free'    // huge/slow → last resort
];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SECTOR_ETF = {
  technology: 'XLK', tech: 'XLK', financials: 'XLF', financial: 'XLF', energy: 'XLE',
  healthcare: 'XLV', health: 'XLV', 'consumer discretionary': 'XLY', 'consumer cyclical': 'XLY',
  'consumer staples': 'XLP', 'consumer defensive': 'XLP', industrials: 'XLI', materials: 'XLB',
  utilities: 'XLU', 'real estate': 'XLRE', communication: 'XLC', 'communication services': 'XLC'
};

function normPeriod(p) {
  const s = String(p || '').toLowerCase().replace(/[\s-]/g, '');
  if (/ytd|yeartodate/.test(s)) return 'ytd';
  if (/5y|5year/.test(s)) return '5y';
  if (/6m|6mo|6month|halfyear/.test(s)) return '6mo';
  if (/3m|3mo|3month|quarter/.test(s)) return '3mo';
  if (/(^|[^0-9])(1mo|1month|month)/.test(s)) return '1mo';
  if (/5d|week/.test(s)) return '5d';
  if (/1d|today|day/.test(s)) return '1d';
  return '1y';   // default & "1y/year"
}

async function yahooQuote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const d = await r.json();
  const meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  if (!meta || meta.regularMarketPrice == null) return null;
  const price = meta.regularMarketPrice, prev = meta.chartPreviousClose || meta.previousClose || price;
  return { price, prevClose: prev, changePct: prev ? (price / prev - 1) * 100 : 0 };
}

async function yahooReturn(sym, period) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${period}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const d = await r.json();
  const res = d && d.chart && d.chart.result && d.chart.result[0];
  const closes = res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
  if (!closes || !closes.length) return null;
  const valid = closes.filter(c => c != null);
  if (valid.length < 2) return null;
  const first = valid[0], last = valid[valid.length - 1];
  return { startPrice: +first.toFixed(2), endPrice: +last.toFixed(2), returnPct: +((last / first - 1) * 100).toFixed(2) };
}

// ── Tool implementations (server-side; reuse finnhubGet / Yahoo / Firestore) ──
async function toolQuote(symbols, key) {
  const out = {};
  for (const s of (symbols || []).slice(0, 12)) {
    const sym = String(s).toUpperCase();
    try { const q = await finnhubGet('/quote', { symbol: sym }, key); if (q && q.c) out[sym] = { price: q.c, prevClose: q.pc, changePct: q.dp, dayHigh: q.h, dayLow: q.l, open: q.o }; }
    catch (e) { out[sym] = { error: 'quote unavailable' }; }
  }
  return out;
}
async function toolFundamentals(symbol, key) {
  const sym = String(symbol || '').toUpperCase();
  const d = await finnhubGet('/stock/metric', { symbol: sym, metric: 'all' }, key);
  const m = (d && d.metric) || {};
  return {
    symbol: sym, peTTM: m.peTTM, forwardPE: m.peExclExtraTTM, priceToSales: m.psTTM,
    priceToBook: m.pbAnnual || m.pbQuarterly, peg: m.pegTTM,
    revenueGrowthYoYPct: m.revenueGrowthTTMYoy, epsGrowthYoYPct: m.epsGrowthTTMYoy,
    netProfitMarginPct: m.netProfitMarginTTM, grossMarginPct: m.grossMarginTTM,
    operatingMarginPct: m.operatingMarginTTM, roePct: m.roeTTM, beta: m.beta,
    marketCapMillions: m.marketCapitalization, week52High: m['52WeekHigh'], week52Low: m['52WeekLow'],
    dividendYieldPct: m.dividendYieldIndicatedAnnual
  };
}
async function toolProfile(symbol, key) {
  const sym = String(symbol || '').toUpperCase();
  const p = await finnhubGet('/stock/profile2', { symbol: sym }, key) || {};
  return { symbol: sym, name: p.name, industry: p.finnhubIndustry, exchange: p.exchange, country: p.country, marketCapMillions: p.marketCapitalization, sharesOutstandingM: p.shareOutstanding, ipo: p.ipo, website: p.weburl };
}
async function toolNews(symbols, key) {
  const today = todayInET();
  const from = (function () { const d = new Date(today.replace(/-/g, '/')); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10); })();
  const raw = [];
  for (const s of (symbols || []).slice(0, 6)) {
    try { const rows = await finnhubGet('/company-news', { symbol: String(s).toUpperCase(), from, to: today }, key); (rows || []).slice(0, 4).forEach(a => raw.push(a)); } catch (e) {}
  }
  if (!raw.length) { try { const g = (await finnhubGet('/news', { category: 'general' }, key)) || []; g.slice(0, 8).forEach(a => raw.push(a)); } catch (e) {} }
  raw.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  return mapNewsRows(raw, 10).map(n => ({ title: n.title, summary: n.summary, source: n.source, tickers: n.tickers, url: n.url }));
}
async function toolRange(symbols, key) {
  const out = {};
  for (const s of (symbols || []).slice(0, 12)) {
    const sym = String(s).toUpperCase();
    try { const d = await finnhubGet('/stock/metric', { symbol: sym, metric: 'all' }, key); const m = (d && d.metric) || {}; if (m['52WeekHigh'] != null) out[sym] = { week52High: m['52WeekHigh'], week52Low: m['52WeekLow'] }; } catch (e) {}
  }
  return out;
}
async function toolEarnings(symbol, key) {
  const sym = String(symbol || '').toUpperCase();
  let history = [];
  try { const e = (await finnhubGet('/stock/earnings', { symbol: sym, limit: 4 }, key)) || []; history = e.slice(0, 4).map(x => ({ period: x.period, actualEps: x.actual, estimateEps: x.estimate, surprisePct: x.surprisePercent })); } catch (e) {}
  let next = null;
  try { const today = todayInET(); const to = (function () { const d = new Date(today.replace(/-/g, '/')); d.setDate(d.getDate() + 90); return d.toISOString().slice(0, 10); })(); const cal = await finnhubGet('/calendar/earnings', { symbol: sym, from: today, to }, key); const arr = (cal && cal.earningsCalendar) || []; if (arr.length) next = arr[0].date; } catch (e) {}
  return { symbol: sym, recentEarnings: history, nextEarningsDate: next };
}
async function toolCompare(symbols, period, key) {
  const per = normPeriod(period);
  const out = { period: per, results: {} };
  for (const raw of (symbols || []).slice(0, 8)) {
    const k = String(raw).toLowerCase().trim();
    const sym = (SECTOR_ETF[k] || String(raw)).toUpperCase();
    const label = SECTOR_ETF[k] ? `${raw} (${sym})` : sym;
    try { const r = await yahooReturn(sym, per); out.results[label] = r || { error: 'no data' }; } catch (e) { out.results[label] = { error: 'no data' }; }
  }
  return out;
}
async function toolMarket() {
  const idx = { 'S&P 500': '^GSPC', 'Nasdaq': '^IXIC', 'Dow Jones': '^DJI', 'VIX (volatility)': '^VIX' };
  const out = {};
  for (const [name, sym] of Object.entries(idx)) {
    try { const q = await yahooQuote(sym); if (q) out[name] = { price: +q.price.toFixed(2), changePct: +q.changePct.toFixed(2) }; } catch (e) {}
  }
  return out;
}
async function toolSearch(query) {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { matches: [] };
    const d = await r.json();
    return { matches: ((d && d.quotes) || []).map(q => ({ symbol: q.symbol, name: q.shortname || q.longname, type: q.quoteType, exchange: q.exchange })).filter(m => m.symbol).slice(0, 8) };
  } catch (e) { return { matches: [] }; }
}
async function toolPortfolio(uid, key) {
  if (!uid) return { error: 'User is not signed in, so their portfolio is unavailable. Ask them to sign in.' };
  const db = admin.firestore();
  const holdings = [];
  try {
    const cols = await db.collection('holdings').doc(uid).listCollections();
    for (const col of cols) {
      const snap = await col.get();
      snap.forEach(doc => {
        const h = doc.data() || {};
        const t = (h.ticker || '').toUpperCase();
        if (t) holdings.push({ ticker: t, qty: +h.qty || 0, buyPrice: +h.buy_price || 0, buyDate: h.buy_date || null });
      });
    }
  } catch (e) { return { error: 'Could not read portfolio.' }; }
  if (!holdings.length) return { holdings: [], note: 'The user has no holdings yet.' };
  // Merge duplicate tickers (same stock held across multiple portfolios) into one position.
  const byT = {};
  for (const h of holdings) { if (!byT[h.ticker]) byT[h.ticker] = { ticker: h.ticker, qty: 0, cost: 0 }; byT[h.ticker].qty += h.qty; byT[h.ticker].cost += h.buyPrice * h.qty; }
  const merged = Object.values(byT);
  let totalValue = 0, totalCost = 0, todayPnl = 0;
  for (const h of merged) {
    let price = h.qty > 0 ? h.cost / h.qty : 0, prev = null;
    try { const q = await finnhubGet('/quote', { symbol: h.ticker }, key); if (q && q.c) { price = q.c; prev = q.pc; } } catch (e) {}
    h.avgCost = h.qty > 0 ? +(h.cost / h.qty).toFixed(2) : 0;
    h.price = +(+price).toFixed(2);
    h.value = +(price * h.qty).toFixed(2);
    h.cost = +h.cost.toFixed(2);
    h.gain = +(h.value - h.cost).toFixed(2);
    h.gainPct = h.cost > 0 ? +((h.gain / h.cost) * 100).toFixed(2) : 0;
    if (prev != null) { h.todayChange = +(h.qty * (price - prev)).toFixed(2); todayPnl += h.qty * (price - prev); }
    totalValue += h.value; totalCost += h.cost;
  }
  return {
    asOf: new Date().toISOString(),
    holdingsCount: merged.length,
    totalValue: +totalValue.toFixed(2),
    totalCost: +totalCost.toFixed(2),
    totalGain: +(totalValue - totalCost).toFixed(2),
    totalGainPct: totalCost > 0 ? +(((totalValue - totalCost) / totalCost) * 100).toFixed(2) : 0,
    todayPnl: +todayPnl.toFixed(2),
    holdings: merged
  };
}

async function runTool(name, args, ctx) {
  const key = ctx.key;
  try {
    switch (name) {
      case 'get_portfolio': return ctx.portfolio ? ctx.portfolio : await toolPortfolio(ctx.uid, key);
      case 'get_quote': return await toolQuote(args.symbols, key);
      case 'get_fundamentals': return await toolFundamentals(args.symbol, key);
      case 'get_company_profile': return await toolProfile(args.symbol, key);
      case 'get_news': return await toolNews(args.symbols, key);
      case 'get_range_52w': return await toolRange(args.symbols, key);
      case 'get_earnings': return await toolEarnings(args.symbol, key);
      case 'compare_performance': return await toolCompare(args.symbols, args.period, key);
      case 'get_market_overview': return await toolMarket();
      case 'search_symbol': return await toolSearch(args.query);
      default: return { error: 'unknown tool' };
    }
  } catch (e) { return { error: String(e) }; }
}

const ASSISTANT_TOOLS = [
  { type: 'function', function: { name: 'get_portfolio', description: "Get the signed-in user's portfolio holdings with live prices, current value, cost basis and gain/loss. Use for any question about 'my portfolio/holdings/positions/how am I doing'.", parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_quote', description: 'Get current price, today\'s % change, day high/low for one or more stock/ETF/index symbols.', parameters: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Ticker symbols, e.g. ["NVDA","AAPL"]' } }, required: ['symbols'] } } },
  { type: 'function', function: { name: 'get_fundamentals', description: 'Get fundamental metrics for a company: P/E, P/S, P/B, PEG, revenue growth %, EPS growth %, profit/gross/operating margins, ROE, beta, market cap, 52-week high/low, dividend yield.', parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } } },
  { type: 'function', function: { name: 'get_company_profile', description: 'Get a company overview: name, industry, exchange, country, market cap, shares outstanding, IPO date, website.', parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } } },
  { type: 'function', function: { name: 'get_news', description: 'Get recent news headlines + summaries for given tickers (or general market news if none given).', parameters: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } } } } },
  { type: 'function', function: { name: 'get_range_52w', description: 'Get 52-week high and low for one or more symbols.', parameters: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] } } },
  { type: 'function', function: { name: 'get_earnings', description: 'Get recent quarterly earnings (actual vs estimate, surprise %) and the next earnings date for a company.', parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } } },
  { type: 'function', function: { name: 'compare_performance', description: 'Compare total % return of stocks and/or sectors over a period. Sectors accepted by name (Technology, Financials, Energy, Healthcare, etc.). Period one of: 1d,5d,1mo,3mo,6mo,ytd,1y,5y.', parameters: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers and/or sector names' }, period: { type: 'string' } }, required: ['symbols'] } } },
  { type: 'function', function: { name: 'get_market_overview', description: "Get today's level and % change for the major US indices (S&P 500, Nasdaq, Dow) and the VIX volatility index.", parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_symbol', description: 'Resolve a company or fund name to its ticker symbol(s).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }
];

async function orChat(messages, key, model, tools) {
  const body = { model, messages, temperature: 0.3, max_tokens: 1300 };
  if (tools) body.tools = tools;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);   // 40s cap → slow free model fails fast, we rotate
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://claude-apps-a6fe1.web.app',
        'X-Title': 'Sparks Finance'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); const err = new Error('OpenRouter ' + r.status); err.status = r.status; err.detail = t.slice(0, 300); throw err; }
    return await r.json();
  } finally { clearTimeout(timer); }
}

const ASSISTANT_SYSTEM = `You are "Sparks AI", an expert financial analyst assistant inside the Sparks Finance app.
You help the user discover, compare and analyze stocks, ETFs, indices, currencies, sectors and market trends, review THEIR OWN portfolio and its performance, run financial analysis (P/E, revenue growth, margins, etc.), monitor markets, and understand companies they care about.

Rules:
- ALWAYS use the provided tools to get live data before answering anything factual (prices, fundamentals, news, portfolio, comparisons). Never invent numbers — if a tool fails or data is missing, say so plainly.
- For "my portfolio / my holdings / how am I doing", use the AUTHORITATIVE PORTFOLIO DATA given to you in context (or call get_portfolio). Those are the exact figures the user sees in the app — quote them verbatim (total value, total/today gain or loss, per-holding). NEVER recompute, re-estimate, round differently, or invent portfolio figures. If a requested number isn't in that data, say you don't have it rather than guessing.
- Be concrete and detailed: cite the actual metrics, % changes and price levels you retrieved, and briefly explain what they mean for the user.
- Format answers in short paragraphs and bullet points. Use **bold** for key figures. Keep it focused.
- You may resolve company names to tickers with search_symbol when unsure.
- End every answer with: "_Educational information, not financial advice._"`;

exports.assistant = onRequest(
  { region: 'us-central1', cors: true, secrets: [OPENROUTER_API_KEY, FINNHUB_API_KEY], timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    const orKey = OPENROUTER_API_KEY.value();
    const fhKey = FINNHUB_API_KEY.value();

    // Optional auth — verify Firebase ID token to unlock the user's private portfolio.
    let uid = null;
    const authz = req.get('Authorization') || '';
    const m = /^Bearer (.+)$/.exec(authz);
    if (m) { try { uid = (await admin.auth().verifyIdToken(m[1])).uid; } catch (e) { uid = null; } }

    // Sanitize incoming history to plain user/assistant text turns.
    const incoming = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const history = incoming
      .filter(x => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string')
      .slice(-16)
      .map(x => ({ role: x.role, content: x.content.slice(0, 4000) }));
    if (!history.length) { res.status(400).json({ error: 'No message provided.' }); return; }

    const messages = [{ role: 'system', content: ASSISTANT_SYSTEM }];
    // Authoritative portfolio: prefer the snapshot the CLIENT sends (the exact figures shown in the
    // user's dashboard); fall back to a server-side read only if the client didn't provide one.
    let clientPf = null;
    if (uid && req.body && req.body.portfolio && typeof req.body.portfolio === 'object') {
      try { clientPf = JSON.parse(JSON.stringify(req.body.portfolio)); } catch (e) { clientPf = null; }
    }
    if (uid) {
      let pf = clientPf;
      if (!pf) { try { pf = await toolPortfolio(uid, fhKey); } catch (e) {} }
      if (pf) messages.push({ role: 'system', content: 'AUTHORITATIVE PORTFOLIO DATA (the exact figures shown in the user\'s Sparks dashboard right now — quote these verbatim for any portfolio/P&L/holdings question; never recompute or invent). JSON: ' + JSON.stringify(pf).slice(0, 4000) });
    } else {
      messages.push({ role: 'system', content: 'The user is NOT signed in, so portfolio tools are unavailable. Answer general market/company questions and, if they ask about their portfolio, tell them to sign in.' });
    }
    messages.push(...history);

    const toolsUsed = [];
    let modelIdx = 0, withTools = true, usedModel = OPENROUTER_MODELS[0];
    try {
      for (let iter = 0; iter < 8; iter++) {
        usedModel = OPENROUTER_MODELS[modelIdx];
        let data;
        try {
          data = await orChat(messages, orKey, usedModel, withTools ? ASSISTANT_TOOLS : null);
        } catch (err) {
          const det = String(err.detail || '').toLowerCase();
          // Model doesn't support function calling → retry the SAME model without tools.
          if (withTools && det.includes('tool')) { withTools = false; logger.warn('assistant: model lacks tool support, retrying plain', { model: usedModel }); continue; }
          // Model retired / unavailable / over free limit / slow (timeout/terminated) / 5xx →
          // try the NEXT free model.
          const networkish = !err.status;   // AbortError, "terminated", DNS, etc.
          if ((networkish || [400, 404, 408, 429, 500, 502, 503].includes(err.status)) && modelIdx < OPENROUTER_MODELS.length - 1) {
            modelIdx++; withTools = true; logger.warn('assistant: model failed, trying next', { model: usedModel, status: err.status || 'network', detail: det || String(err) }); continue;
          }
          throw err;
        }
        const msg = data && data.choices && data.choices[0] && data.choices[0].message;
        if (!msg) { res.status(200).json({ reply: "I couldn't generate a response just now. Please try again.", toolsUsed }); return; }
        messages.push(msg);
        if (withTools && msg.tool_calls && msg.tool_calls.length) {
          for (const tc of msg.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
            const result = await runTool(tc.function.name, args, { uid, key: fhKey, portfolio: clientPf });
            toolsUsed.push(tc.function.name);
            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result).slice(0, 5000) });
          }
          continue;   // let the model read the tool results
        }
        res.status(200).json({ reply: msg.content || '(no answer)', model: usedModel, toolsUsed });
        return;
      }
      res.status(200).json({ reply: 'That took too many steps — please ask a more specific question.', toolsUsed });
    } catch (e) {
      logger.error('assistant failed', { status: e.status, error: String(e), detail: e.detail });
      const msg = e.status === 429
        ? "The free AI model is rate-limited right now — please wait a minute and try again."
        : "The assistant is temporarily unavailable. Please try again shortly.";
      res.status(200).json({ reply: msg, error: String(e), toolsUsed });
    }
  }
);

// ── 6-digit OTP password reset (sendOtp / verifyOtp) ─────────────────────────
// sendOtp generates a code, stores a salted SHA-256 hash + expiry in Firestore (otp/{id},
// Admin-only) and emails it via Resend. verifyOtp checks the code and, on success, resets
// the password via the Admin SDK. Requires the RESEND_API_KEY secret and a sender address
// (onboarding@resend.dev works for testing; use no-reply@sparksfinance.ai after verifying
// the domain in Resend).
const OTP_FROM = 'Sparks Finance <onboarding@resend.dev>';
const OTP_TTL_MS = 10 * 60 * 1000;   // codes valid 10 minutes
const OTP_RESEND_MS = 60 * 1000;     // min 60s between sends
const OTP_MAX_ATTEMPTS = 5;
function otpKey(email) { return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'); }
function otpHash(code, email) { return crypto.createHash('sha256').update(code + '|' + email.toLowerCase() + '|sparks-otp-v1').digest('hex'); }
async function sendEmailResend(to, subject, html, key) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: OTP_FROM, to: [to], subject, html })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('resend ' + r.status + ': ' + t.slice(0, 180)); }
  return true;
}
function otpEmailHtml(code) {
  return '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#202124">' +
    '<div style="font-size:20px;font-weight:700;color:#1a73e8;margin-bottom:6px">Sparks Finance</div>' +
    '<p style="font-size:15px">Your password reset code is:</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f1f3f4;border-radius:10px;padding:16px;text-align:center;margin:14px 0">' + code + '</div>' +
    '<p style="font-size:13px;color:#5f6368">This code expires in 10 minutes. If you didn’t request it, you can safely ignore this email.</p></div>';
}
exports.sendOtp = onRequest(
  { region: 'us-central1', cors: true, secrets: [RESEND_API_KEY] },
  async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'invalid_email' }); return; }
      const key = RESEND_API_KEY.value();
      if (!key) { res.status(500).json({ error: 'email_not_configured' }); return; }
      const db = admin.firestore();
      let exists = true;
      try { await admin.auth().getUserByEmail(email); } catch (e) { exists = false; }
      const ref = db.collection('otp').doc(otpKey(email));
      const snap = await ref.get();
      if (snap.exists) { const d = snap.data(); if (d.sentAt && (Date.now() - d.sentAt) < OTP_RESEND_MS) { res.json({ ok: true, throttled: true }); return; } }
      if (exists) {
        const code = '' + crypto.randomInt(100000, 1000000);
        await ref.set({ hash: otpHash(code, email), expires: Date.now() + OTP_TTL_MS, attempts: 0, sentAt: Date.now(), purpose: 'reset' });
        await sendEmailResend(email, 'Your Sparks Finance reset code', otpEmailHtml(code), key);
      }
      res.json({ ok: true });   // same response whether or not the email is registered (no enumeration)
    } catch (e) {
      logger.error('sendOtp failed', { error: String(e) });
      res.status(500).json({ error: 'send_failed', detail: String(e).slice(0, 180) });
    }
  }
);
exports.verifyOtp = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      const code = String((req.body && req.body.code) || '').trim();
      const newPassword = String((req.body && req.body.newPassword) || '');
      if (!email || !/^\d{6}$/.test(code)) { res.status(400).json({ error: 'bad_request' }); return; }
      if (newPassword.length < 6) { res.status(400).json({ error: 'weak_password' }); return; }
      const db = admin.firestore();
      const ref = db.collection('otp').doc(otpKey(email));
      const snap = await ref.get();
      if (!snap.exists) { res.status(400).json({ error: 'no_code' }); return; }
      const d = snap.data();
      if (Date.now() > d.expires) { await ref.delete().catch(() => {}); res.status(400).json({ error: 'expired' }); return; }
      if ((d.attempts || 0) >= OTP_MAX_ATTEMPTS) { await ref.delete().catch(() => {}); res.status(429).json({ error: 'too_many_attempts' }); return; }
      if (d.hash !== otpHash(code, email)) { await ref.update({ attempts: (d.attempts || 0) + 1 }).catch(() => {}); res.status(400).json({ error: 'invalid_code' }); return; }
      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().updateUser(user.uid, { password: newPassword, emailVerified: true });
      await ref.delete().catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      logger.error('verifyOtp failed', { error: String(e) });
      res.status(500).json({ error: 'verify_failed' });
    }
  }
);
