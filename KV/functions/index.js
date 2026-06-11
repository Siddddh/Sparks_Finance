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
          (rows || []).slice(0, 8).forEach(a => portfolioRaw.push(a));
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
        portfolio: mapNewsRows(portfolioRaw, 35),
        influencer: mapNewsRows(influencerRaw, 25),
        market: mapNewsRows(generalRaw, 25)
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
  let totalValue = 0, totalCost = 0;
  for (const h of holdings) {
    try { const q = await finnhubGet('/quote', { symbol: h.ticker }, key); if (q && q.c) { h.price = q.c; h.changePctToday = q.dp; } } catch (e) {}
    const px = h.price || h.buyPrice;
    h.value = +(px * h.qty).toFixed(2);
    h.cost = +(h.buyPrice * h.qty).toFixed(2);
    h.gainPct = h.buyPrice > 0 ? +((px / h.buyPrice - 1) * 100).toFixed(2) : 0;
    totalValue += h.value; totalCost += h.cost;
  }
  return {
    holdingsCount: holdings.length,
    totalValue: +totalValue.toFixed(2),
    totalCost: +totalCost.toFixed(2),
    totalGain: +(totalValue - totalCost).toFixed(2),
    totalGainPct: totalCost > 0 ? +(((totalValue - totalCost) / totalCost) * 100).toFixed(2) : 0,
    holdings
  };
}

async function runTool(name, args, ctx) {
  const key = ctx.key;
  try {
    switch (name) {
      case 'get_portfolio': return await toolPortfolio(ctx.uid, key);
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
- For "my portfolio / my holdings / how am I doing", call get_portfolio.
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
    // Pre-fetch a compact portfolio snapshot so portfolio questions work even if the
    // model doesn't call tools (helps weaker free models).
    if (uid) {
      try {
        const p = await toolPortfolio(uid, fhKey);
        if (p && p.holdings) messages.push({ role: 'system', content: 'Signed-in user portfolio snapshot (use get_portfolio for the freshest detail): ' + JSON.stringify(p).slice(0, 3000) });
      } catch (e) {}
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
            const result = await runTool(tc.function.name, args, { uid, key: fhKey });
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
