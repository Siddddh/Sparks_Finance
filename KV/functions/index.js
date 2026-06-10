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

function composeDigest({ date, userEarnings, macro, holiday }) {
  if (holiday && holiday.closed) {
    return {
      title: `Markets closed today — ${holiday.name}`,
      body: 'US markets are closed. No pre-market action needed today.'
    };
  }

  const parts = [];
  let title;

  if (userEarnings.length) {
    const list = userEarnings.map(e => e.ticker).join(', ');
    title = `Pre-market: ${userEarnings.length} of your stock${userEarnings.length > 1 ? 's' : ''} report today`;
    parts.push(`${list} report${userEarnings.length > 1 ? '' : 's'} earnings today`);
  } else {
    title = 'Pre-market market brief';
  }

  if (macro.length) {
    const macroLine = macro.slice(0, 3).map(m => (m.time ? `${m.event} (${m.time})` : m.event)).join(' · ');
    parts.push(macroLine);
  }

  if (holiday && !holiday.closed) {
    parts.push(`Shortened session today (${holiday.name})`);
  }

  const body = parts.length
    ? parts.join(' — ')
    : 'No earnings for your stocks today and no major economic releases.';

  return { title, body };
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

    // Nothing relevant for this user today → don't add noise.
    const hasContent = userEarnings.length || macro.length || (holiday && holiday.closed);
    if (!hasContent) { summary.skipped++; continue; }

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
        notification: { title, body },
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
  's&p global', 'downgrade', 'upgrade', 'analyst'
];

function mapNewsRows(rows, max) {
  const out = [], seen = {};
  for (const a of (rows || [])) {
    const title = a.headline || '';
    if (!title || seen[title]) continue;
    seen[title] = 1;
    out.push({
      title,
      summary: (a.summary || '').slice(0, 220),
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

exports.getNews = onRequest(
  { region: 'us-central1', cors: true, secrets: [FINNHUB_API_KEY] },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    const symbols = String(req.query.symbols || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 25);
    const today = todayInET();
    const fromDate = (function () { const d = new Date(today.replace(/-/g, '/')); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10); })();
    try {
      // Per-holding company news
      const portfolioRaw = [];
      for (const sym of symbols) {
        try {
          const rows = await finnhubGet('/company-news', { symbol: sym, from: fromDate, to: today }, key);
          (rows || []).slice(0, 6).forEach(a => portfolioRaw.push(a));
        } catch (e) { /* skip symbol */ }
      }
      portfolioRaw.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));

      // General market news
      let generalRaw = [];
      try { generalRaw = (await finnhubGet('/news', { category: 'general' }, key)) || []; } catch (e) {}
      generalRaw.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));

      // Influencer feed: general items mentioning an influencer keyword OR a held ticker
      const symLower = symbols.map(s => s.toLowerCase());
      const influencerRaw = generalRaw.filter(a => {
        const t = ((a.headline || '') + ' ' + (a.summary || '') + ' ' + (a.related || '')).toLowerCase();
        return INFLUENCER_KEYWORDS.some(k => t.includes(k)) || symLower.some(s => t.includes(s));
      });

      res.set('Cache-Control', 'public, max-age=600');
      res.json({
        portfolio: mapNewsRows(portfolioRaw, 30),
        influencer: mapNewsRows(influencerRaw, 20),
        market: mapNewsRows(generalRaw, 20)
      });
    } catch (e) {
      res.status(200).json({ portfolio: [], influencer: [], market: [], error: String(e) });
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
