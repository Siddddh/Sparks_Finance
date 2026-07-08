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
const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');   // transactional + digest email (see mail helpers)
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

// ── Company-tier fan-out helpers ────────────────────────────────────────────
// Financial data now lives under organizations/{o}/companies/{c}/… while notifications,
// FCM tokens and alert-dedup state stay per-uid. These helpers walk every LIVE company
// (skipping soft-deleted / deactivated orgs+companies), map its members → recipients, and
// gather its tickers, so the scheduled jobs operate on the company tier and notify the
// right people. Company data is shared among its members, so a job reads the whole
// company's book and delivers to every member with access to the relevant module.

// All live (not soft-deleted / not deactivated) org→company pairs.
async function listLiveCompanies(db) {
  const out = [];
  let orgsSnap;
  try { orgsSnap = await db.collection('organizations').get(); }
  catch (e) { logger.warn('Organization list failed', { error: String(e) }); return out; }
  for (const orgDoc of orgsSnap.docs) {
    const org = orgDoc.data() || {};
    if (org.deleted === true || org.active === false) continue;
    let coSnap;
    try { coSnap = await orgDoc.ref.collection('companies').get(); } catch (e) { continue; }
    for (const coDoc of coSnap.docs) {
      const co = coDoc.data() || {};
      if (co.deleted === true || co.active === false) continue;
      out.push({ orgId: orgDoc.id, companyId: coDoc.id, coRef: coDoc.ref, name: co.name || 'Company', modules: co.modules || {} });
    }
  }
  return out;
}

// Member uids of a company allowed to receive notifications for `moduleKey` ('stocks'|'loans'):
// company admins see everything; members need a non-'none' perm on that module.
async function companyModuleUids(coRef, moduleKey) {
  const out = [];
  let memSnap;
  try { memSnap = await coRef.collection('members').get(); } catch (e) { return out; }
  memSnap.forEach(m => {
    const md = m.data() || {};
    const perm = md.perms && md.perms[moduleKey];
    if (md.role === 'admin' || (perm && perm !== 'none')) out.push(m.id);
  });
  return out;
}

// Index every member uid → the live companies they belong to (with role/perms), so
// per-user jobs (digest, intraday) can union a user's accessible tickers across companies.
async function buildMembershipIndex(db) {
  const byUid = {};   // uid -> [{ orgId, companyId, coRef, role, perms }]
  for (const c of await listLiveCompanies(db)) {
    let memSnap;
    try { memSnap = await c.coRef.collection('members').get(); } catch (e) { continue; }
    memSnap.forEach(m => {
      const md = m.data() || {};
      (byUid[m.id] = byUid[m.id] || []).push({ orgId: c.orgId, companyId: c.companyId, coRef: c.coRef, role: md.role, perms: md.perms || {} });
    });
  }
  return byUid;
}

// A user's companies where they hold the given module (admin OR non-'none' perm).
function companiesWithModule(memberships, moduleKey) {
  return (memberships || []).filter(m => m.role === 'admin' || (m.perms[moduleKey] && m.perms[moduleKey] !== 'none'));
}

// Union of tickers from the given companies' holdings (holdings/{pfId}/lots) and, when
// `includeWatchlists` is true, their watchlists. Intraday price-move alerts pass false
// (holdings only); the pre-market digest passes true (holdings + watched tickers).
async function tickersForCompanies(coRefs, includeWatchlists = true) {
  const tickers = new Set();
  for (const coRef of coRefs) {
    try {
      const pfRefs = await coRef.collection('holdings').listDocuments();
      for (const pfRef of pfRefs) {
        const lots = await pfRef.collection('lots').get();
        lots.forEach(d => { const t = (d.get('ticker') || '').toUpperCase(); if (t) tickers.add(t); });
      }
    } catch (e) { logger.warn('Company holdings read failed', { company: coRef.path, error: String(e) }); }
    if (includeWatchlists) {
      try {
        const wl = await coRef.collection('watchlists').get();
        wl.forEach(d => (d.get('tickers') || []).forEach(t => { if (t) tickers.add(String(t).toUpperCase()); }));
      } catch (e) { logger.warn('Company watchlist read failed', { company: coRef.path, error: String(e) }); }
    }
  }
  return tickers;
}

// Per-uid delivery sink. Caches FCM tokens + the day's alert-dedup state, accumulates
// notifications across every company a user belongs to, then flushes ONCE (single state
// write, no double-fire). statePrefix '' → alert_state/{uid}; 'ua_'/'loan_' → prefixed.
function makeSink(db, messaging, statePrefix, date, summary) {
  const users = {};   // uid -> { tokens, stateRef, fired:Set, queue:[{doc, push, data}] }
  async function load(uid) {
    if (users[uid]) return users[uid];
    let tokens = [];
    try { const u = await db.collection('users').doc(uid).get(); tokens = Array.isArray(u.get('fcmTokens')) ? u.get('fcmTokens') : []; } catch (e) {}
    const stateRef = db.collection('alert_state').doc((statePrefix || '') + uid);
    let fired = new Set();
    try { const s = await stateRef.get(); const st = s.exists ? s.data() : {}; if (st.date === date) fired = new Set(st.keys || []); } catch (e) {}
    return (users[uid] = { tokens, stateRef, fired, queue: [] });
  }
  return {
    async fired(uid) { return (await load(uid)).fired; },          // Set — test/add dedup keys
    async hasTokens(uid) { return (await load(uid)).tokens.length > 0; },
    async enqueue(uid, doc, push, data) { (await load(uid)).queue.push({ doc, push, data }); },
    async flush() {
      for (const uid of Object.keys(users)) {
        const u = users[uid];
        for (const item of u.queue) {
          try { await db.collection('notifications').doc(uid).collection('list').add(item.doc); if (summary && 'notified' in summary) summary.notified++; }
          catch (e) { logger.error('notif write failed', { uid, error: String(e) }); }
          if (u.tokens.length && item.push) {
            try {
              const resp = await messaging.sendEachForMulticast({ tokens: u.tokens, notification: item.push, data: item.data || {}, webpush: { fcmOptions: { link: '/' } } });
              if (summary && 'sent' in summary) summary.sent += resp.successCount;
              const dead = [];
              resp.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') dead.push(u.tokens[i]); } });
              if (dead.length) { await db.collection('users').doc(uid).set({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) }, { merge: true }); u.tokens = u.tokens.filter(t => !dead.includes(t)); }
            } catch (e) { logger.error('FCM send failed', { uid, error: String(e) }); }
          }
        }
        try { await u.stateRef.set({ date, keys: [...u.fired] }); } catch (e) {}
      }
    }
  };
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

async function runPremarket(key, sgKey) {
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

  // Recipients = users with a registered FCM token who belong to ≥1 company with the
  // Trading module. Tickers for the digest are the union of that user's accessible
  // companies' holdings + watchlists (company data is shared among its members).
  const membership = await buildMembershipIndex(db);
  const usersSnap = await db.collection('users').get();
  const recipients = [];
  usersSnap.forEach(doc => {
    const tokens = doc.get('fcmTokens');
    if (!(Array.isArray(tokens) && tokens.length)) return;
    const stockCos = companiesWithModule(membership[doc.id], 'stocks');
    if (stockCos.length) recipients.push({ uid: doc.id, tokens, coRefs: stockCos.map(c => c.coRef) });
  });

  const summary = { date, users: recipients.length, sent: 0, failed: 0, skipped: 0, prunedTokens: 0 };

  for (const { uid, tokens, coRefs } of recipients) {
    // Match today's earnings to this user's company tickers (skip the matching on a
    // closed-market day — the digest is just the holiday notice).
    let userEarnings = [];
    if (!(holiday && holiday.closed)) {
      const userTickers = await tickersForCompanies(coRefs);
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

    // 1b. Email the same brief (respects users/{uid}.emailPrefs.premarket; no-op if SendGrid unset).
    const _digestItems = [
      ...userEarnings.map(e => ({ title: e.ticker + ' reports earnings ' + (HOUR_LABEL[e.hour] || 'today'), body: (e.epsEstimate != null ? 'Consensus EPS ' + e.epsEstimate : '') })),
      ...(macro || []).map(m => ({ title: m.event || 'Macro event', body: [m.time, m.impact ? m.impact + ' impact' : ''].filter(Boolean).join(' · ') }))
    ];
    await mailUser(db, uid, 'premarket', mailDigest({ subject: title, title, intro: (holiday && holiday.closed) ? body : 'Your pre-market brief for ' + date + '.', items: _digestItems, tab: 'premarket' }), sgKey);

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
    secrets: [FINNHUB_API_KEY, SENDGRID_API_KEY],
    region: 'us-central1'
  },
  async () => {
    await runPremarket(FINNHUB_API_KEY.value(), SENDGRID_API_KEY.value());
  }
);

// On-demand test endpoint. Guarded by ?token=<FINNHUB_API_KEY>. REMOVE before prod
// or replace the guard with proper auth.
exports.runPremarketNow = onRequest(
  { secrets: [FINNHUB_API_KEY, SENDGRID_API_KEY], region: 'us-central1' },
  async (req, res) => {
    const key = FINNHUB_API_KEY.value();
    if (req.query.token !== key) {
      res.status(403).send('Forbidden: pass ?token=<FINNHUB_API_KEY> to run the test.');
      return;
    }
    try {
      const summary = await runPremarket(key, SENDGRID_API_KEY.value());
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

async function runIntraday(key) {
  const db = admin.firestore();
  const messaging = admin.messaging();
  const date = todayInET();

  // Recipients = users with a registered FCM token who belong to ≥1 company with the
  // Trading module; each user's watched tickers are the union of their companies' holdings.
  const membership = await buildMembershipIndex(db);
  const usersSnap = await db.collection('users').get();
  const recipients = [];
  usersSnap.forEach(doc => {
    const tokens = doc.get('fcmTokens');
    if (!(Array.isArray(tokens) && tokens.length)) return;
    const stockCos = companiesWithModule(membership[doc.id], 'stocks');
    if (stockCos.length) recipients.push({ uid: doc.id, tokens, coRefs: stockCos.map(c => c.coRef) });
  });

  // Unique tickers across every recipient's company holdings + SPY (market proxy).
  const allTickers = new Set(['SPY']);
  const userTickers = {}, userWatch = {};
  for (const { uid, coRefs } of recipients) { const t = await tickersForCompanies(coRefs, false); userTickers[uid] = t; t.forEach(x => allTickers.add(x)); }
  // Also each user's WATCHED (non-held) tickers, for watchlist-move pushes (higher threshold to limit noise).
  for (const { uid, coRefs } of recipients) {
    const held = userTickers[uid] || new Set();
    const w = new Set(); (await tickersForCompanies(coRefs, true)).forEach(x => { if (!held.has(x)) w.add(x); });
    userWatch[uid] = w; w.forEach(x => allTickers.add(x));
  }
  const WATCH_MOVE_PCT = 4.0;

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

    // Watched (non-held) tickers making a notable move — a lighter-touch heads-up than a holding move.
    for (const t of (userWatch[uid] || new Set())) {
      const q = quotes[t];
      if (q && Math.abs(q.dp) >= WATCH_MOVE_PCT) {
        const dir = q.dp >= 0 ? 'up' : 'down';
        if (!fired.has('wmove:' + t + ':' + dir)) {
          fired.add('wmove:' + t + ':' + dir);
          const mv = Math.abs(q.dp).toFixed(1);
          alerts.push({ type: 'watchlist_move', ticker: t, pct: q.dp, title: `${t} ${dir} ${mv}% today`, body: `${t} on your watchlist is ${dir} ${mv}% today, trading around $${q.price.toFixed(2)}. It's not a holding — review whether the move changes your thesis before acting.` });
        }
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
  const summary = { date, companies: 0, checked: 0, notified: 0, sent: 0 };

  const quoteCache = {};
  async function getQuote(sym) {
    if (sym in quoteCache) return quoteCache[sym];
    let q = null;
    try { const r = await finnhubGet('/quote', { symbol: sym }, key); if (r && r.c) q = { price: r.c, prev: r.pc, dp: r.dp || 0 }; } catch (e) {}
    quoteCache[sym] = q; return q;
  }

  // Alerts are now company data (organizations/{o}/companies/{c}/alerts) shared by the company's
  // members. Evaluate each alert once, then deliver to every member with Trading access. Dedup is
  // per-uid and company-scoped so a member in several companies isn't cross-fired, and the same
  // crossed threshold pings each recipient once per day.
  const sink = makeSink(db, messaging, 'ua_', date, summary);

  for (const co of await listLiveCompanies(db)) {
    let alertsSnap;
    try { alertsSnap = await co.coRef.collection('alerts').get(); } catch (e) { continue; }
    if (alertsSnap.empty) continue;
    const uids = await companyModuleUids(co.coRef, 'stocks');
    if (!uids.length) continue;
    summary.companies++;

    for (const adoc of alertsSnap.docs) {
      const a = adoc.data(); summary.checked++;
      const ticker = (a.ticker || '').toUpperCase().trim();
      const cond = a.condition || a.type;
      if (!ticker || !cond) continue;

      let payload = null;   // { dedupKey, title, body, url, pct }
      if (cond === 'news') {
        let rows = [];
        try { rows = (await finnhubGet('/company-news', { symbol: ticker, from: date, to: date }, key)) || []; } catch (e) {}
        rows.sort((x, y) => (y.datetime || 0) - (x.datetime || 0));
        const top = rows[0];
        if (top && top.id != null) {
          payload = {
            dedupKey: 'uanews:' + co.companyId + ':' + adoc.id + ':' + top.id,
            title: `News: ${ticker} — ${String(top.headline || 'new headline').slice(0, 80)}`,
            body: `${String(top.summary || top.headline || '').slice(0, 220)} (${top.source || 'news'})` + (a.note ? ' — Note: ' + a.note : ''),
            url: top.url || '', pct: null
          };
        }
      } else {
        const q = await getQuote(ticker);
        if (q && _alertTriggered(cond, a.value, q)) {
          const t = _alertText(cond, _alertNum(a.value), ticker, q);
          payload = {
            dedupKey: 'ua:' + co.companyId + ':' + adoc.id,   // one notification per alert per day
            title: t.title, body: a.note ? t.body + ' — Note: ' + a.note : t.body,
            url: '', pct: q.dp != null ? q.dp : null
          };
        }
      }
      if (!payload) continue;

      for (const uid of uids) {
        const fired = await sink.fired(uid);
        if (fired.has(payload.dedupKey)) continue;
        fired.add(payload.dedupKey);
        await sink.enqueue(uid,
          { date, type: 'user_alert', title: payload.title, body: payload.body, ticker, pct: payload.pct,
            url: payload.url || null, orgId: co.orgId, companyId: co.companyId, company: co.name,
            read: false, status: 'sent', data: { type: 'user_alert', url: payload.url || '' },
            createdAt: admin.firestore.FieldValue.serverTimestamp() },
          { title: payload.title, body: pushBody(payload.body) },
          { type: 'user_alert', url: String(payload.url || '') });
      }
    }
  }

  await sink.flush();
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

// ── Loan & note reminders (payment / maturity milestones) ─────────
// Daily scan of every user's loans/{uid}/list; writes a `loan_reminder` notification (+ FCM push)
// for payments due within 5 days or overdue, and maturities within 7 days.
// Deduped per user/day via alert_state/loan_{uid} so each milestone pings once/day.
// (The web app also derives these same reminders client-side; this delivers push when it's closed.)
const _FREQ_DAYS_FN = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, semiannual: 182, annually: 365 };
function _dUntil(dateStr, todayStr) {
  if (!dateStr) return null;
  const a = new Date(dateStr + 'T00:00:00Z'), b = new Date(todayStr + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((a - b) / 864e5);
}
function _loanNextPay(l, todayStr) {
  if (l.nextPaymentDate) return l.nextPaymentDate;
  const step = _FREQ_DAYS_FN[l.paymentFreq]; if (!step || !l.startDate) return null;
  const start = Date.parse(l.startDate + 'T00:00:00Z'); if (isNaN(start)) return null;
  const now = Date.parse(todayStr + 'T00:00:00Z');
  // O(1): jump straight to the first scheduled date on/after today (no loop guard to exhaust).
  const steps = Math.max(0, Math.ceil((now - start) / (step * 864e5)));
  return new Date(start + steps * step * 864e5).toISOString().slice(0, 10);
}
function _loanActive(l) { return !l.status || l.status === 'active' || l.status === 'defaulted'; }
function _loanTitleFn(l) { return l.name || ((l.type === 'lent' ? 'Loan to ' : 'Loan from ') + (l.type === 'lent' ? (l.borrower || 'borrower') : (l.lender || 'lender'))); }

async function runLoanReminders(sgKey) {
  const db = admin.firestore();
  const messaging = admin.messaging();
  const date = todayInET();
  const summary = { date, companies: 0, notified: 0, sent: 0 };
  const emailItems = {};   // uid -> [{title, body}] for one consolidated email per user

  // Loans are company data (organizations/{o}/companies/{c}/loans) shared by the company's members.
  // Each payment / maturity milestone is delivered to every member with Loans & Notes access, deduped
  // per-uid + company + milestone so each recipient is pinged once per day.
  const sink = makeSink(db, messaging, 'loan_', date, summary);

  for (const co of await listLiveCompanies(db)) {
    let snap;
    try { snap = await co.coRef.collection('loans').get(); } catch (e) { continue; }
    if (snap.empty) continue;
    const uids = await companyModuleUids(co.coRef, 'loans');
    if (!uids.length) continue;
    summary.companies++;

    for (const d of snap.docs) {
      const l = d.data(); if (!_loanActive(l)) continue;
      const title0 = _loanTitleFn(l);
      const events = [];   // { dedupSuffix, rkey, title, body }
      const np = _loanNextPay(l, date), dp = _dUntil(np, date);
      if (dp != null && dp <= 5 && dp >= -14) {   // stop pushing after ~2 weeks overdue (still shown in-app)
        const overdue = dp < 0;
        // Title matches the client-derived reminder so the feed collapses the two into one.
        events.push({ dedupSuffix: 'pay:' + d.id + ':' + np, rkey: 'loan:' + d.id + ':pay:' + np,
          title: (overdue ? 'OVERDUE payment — ' : 'Payment due soon — ') + title0,
          body: (overdue ? 'A payment on this note was due ' + Math.abs(dp) + ' day(s) ago' : (dp === 0 ? 'A payment on this note is due today' : 'A payment on this note is due in ' + dp + ' day(s)')) + '.' });
      }
      const dm = _dUntil(l.maturityDate, date);
      if (dm != null && dm >= 0 && dm <= 7) {
        events.push({ dedupSuffix: 'mat:' + d.id + ':' + l.maturityDate, rkey: 'loan:' + d.id + ':mat:' + l.maturityDate,
          title: 'Maturity in ' + dm + 'd — ' + title0, body: 'This note matures on ' + l.maturityDate + '.' });
      }
      if (!events.length) continue;

      for (const uid of uids) {
        const fired = await sink.fired(uid);
        for (const ev of events) {
          const key = co.companyId + ':' + ev.dedupSuffix;
          if (fired.has(key)) continue;
          fired.add(key);
          (emailItems[uid] = emailItems[uid] || []).push({ title: ev.title, body: ev.body });
          await sink.enqueue(uid,
            { date, type: 'loan_reminder', title: ev.title, body: ev.body, ticker: null, url: null,
              rkey: ev.rkey, loanId: d.id, orgId: co.orgId, companyId: co.companyId, company: co.name,
              read: false, status: 'sent', data: { type: 'loan_reminder' },
              createdAt: admin.firestore.FieldValue.serverTimestamp() },
            { title: ev.title, body: pushBody(ev.body) },
            { type: 'loan_reminder' });
        }
      }
    }
  }

  await sink.flush();
  // One consolidated loan email per user (respects users/{uid}.emailPrefs.loans; no-op if SendGrid unset).
  for (const uid of Object.keys(emailItems)) {
    await mailUser(db, uid, 'loans', mailDigest({ subject: 'Loan & note reminders — ' + date, title: 'Loan & note reminders', intro: 'Upcoming payments and maturities that need your attention.', items: emailItems[uid], tab: 'loansdash' }), sgKey);
  }
  logger.info('Loan-reminders run complete', summary);
  return summary;
}

// Scheduled: once daily at 9 AM ET.
exports.loanReminderNotifications = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/New_York', secrets: [SENDGRID_API_KEY], region: 'us-central1' },
  async () => { await runLoanReminders(SENDGRID_API_KEY.value()); }
);
// On-demand test. Guarded by ?token=<FINNHUB_API_KEY> (reused purely as a shared secret).
exports.runLoanRemindersNow = onRequest(
  { secrets: [FINNHUB_API_KEY, SENDGRID_API_KEY], region: 'us-central1' },
  async (req, res) => {
    if (req.query.token !== FINNHUB_API_KEY.value()) { res.status(403).send('Forbidden'); return; }
    try { res.status(200).json({ ok: true, summary: await runLoanReminders(SENDGRID_API_KEY.value()) }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  }
);

// ── Daily email digests: consolidated Market News + Top Picks (email-only) ────
// Recipients = users with an email who haven't opted out of the category. ONE shared digest each
// (one Finnhub call for news, zero external calls for picks) — cost-conscious. The in-app News /
// Recommendation tabs remain the live source of truth; these are just the email companion.
async function _digestRecipients(db) {
  const out = [];
  try { const snap = await db.collection('users').get(); snap.forEach(d => { const email = d.get('email'); if (email) out.push({ email, prefs: d.get('emailPrefs') || {} }); }); } catch (e) {}
  return out;
}
async function runNewsDigest(finnhubKey, sgKey) {
  const db = admin.firestore();
  let rows = [];
  try { rows = (await finnhubGet('/news', { category: 'general' }, finnhubKey)) || []; } catch (e) {}
  const items = rows.filter(a => a && a.headline).slice(0, 6)
    .map(a => ({ title: String(a.headline).slice(0, 120), body: String(a.summary || a.source || '').slice(0, 180), url: a.url || '' }));
  if (!items.length) return { sent: 0, skipped: 'no_news' };
  const built = mailDigest({ subject: 'Today’s market news — Sparks Finance', title: 'Today’s market news', intro: 'A quick roundup of the headlines moving markets.', items, tab: 'news' });
  let sent = 0;
  for (const r of await _digestRecipients(db)) { if (r.prefs.news === false) continue; if (await mailTo(r.email, built, sgKey)) sent++; }
  logger.info('News digest sent', { sent }); return { sent };
}
async function runTopPicksDigest(sgKey) {
  const db = admin.firestore();
  let picks = [];
  try {
    const snap = await db.collection('recommendations').limit(200).get();
    picks = snap.docs.map(d => { const x = d.data() || {}; return {
      ticker: x.ticker || x.symbol || d.id, name: x.name || x.company || '',
      reason: x.reason || x.thesis || x.summary || (x.rating ? ('Rating: ' + x.rating) : ''),
      score: (typeof x.score === 'number' ? x.score : (typeof x.rank === 'number' ? -x.rank : 0)) }; })
      .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 8);
  } catch (e) {}
  if (!picks.length) return { sent: 0, skipped: 'no_picks' };
  const items = picks.map(p => ({ title: p.ticker + (p.name ? ' — ' + p.name : ''), body: p.reason || '' }));
  const built = mailDigest({ subject: 'Your Top Picks — Sparks Finance', title: 'Top Picks', intro: 'Standout names from the latest Sparks screen.', items, tab: 'recommend' });
  let sent = 0;
  for (const r of await _digestRecipients(db)) { if (r.prefs.topPicks === false) continue; if (await mailTo(r.email, built, sgKey)) sent++; }
  logger.info('Top-picks digest sent', { sent }); return { sent };
}
exports.newsDigestEmail = onSchedule(
  { schedule: '30 7 * * 1-5', timeZone: 'America/New_York', secrets: [FINNHUB_API_KEY, SENDGRID_API_KEY], region: 'us-central1' },
  async () => { await runNewsDigest(FINNHUB_API_KEY.value(), SENDGRID_API_KEY.value()); }
);
exports.topPicksDigestEmail = onSchedule(
  { schedule: '45 7 * * 1-5', timeZone: 'America/New_York', secrets: [SENDGRID_API_KEY], region: 'us-central1' },
  async () => { await runTopPicksDigest(SENDGRID_API_KEY.value()); }
);
// On-demand test for both digests. Guarded by ?token=<FINNHUB_API_KEY>. ?which=news|picks
exports.runDigestsNow = onRequest(
  { secrets: [FINNHUB_API_KEY, SENDGRID_API_KEY], region: 'us-central1' },
  async (req, res) => {
    if (req.query.token !== FINNHUB_API_KEY.value()) { res.status(403).send('Forbidden'); return; }
    try {
      const which = String(req.query.which || 'news');
      const out = which === 'picks' ? await runTopPicksDigest(SENDGRID_API_KEY.value()) : await runNewsDigest(FINNHUB_API_KEY.value(), SENDGRID_API_KEY.value());
      res.json({ ok: true, which, out });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
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

// ══════════════ Email system (SendGrid) ══════════════════════════════════════
// Transactional + digest email. Sender must be a SendGrid domain-authenticated address.
// OTP/password-reset stays on Resend (above); everything else goes through SendGrid here.
const MAIL_FROM_EMAIL = 'no-reply@sparksfinance.ai';
const MAIL_FROM_NAME = 'Sparks Finance';
const APP_URL = 'https://sparksfinance.ai';
const MODULE_KEYS = [{ id: 'stocks', label: 'Trading' }, { id: 'loans', label: 'Loans & Notes' }];   // for module-access emails

async function sendEmailSendGrid(to, subject, html, key) {
  if (!key) { logger.warn('SendGrid key missing; skipping email', { to }); return false; }
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: MAIL_FROM_EMAIL, name: MAIL_FROM_NAME },
      subject: String(subject || 'Sparks Finance'),
      // text/plain MUST precede text/html (SendGrid orders by increasing preference). Both parts present
      // → clients render the HTML but don't clip/collapse the message behind a "…".
      content: [{ type: 'text/plain', value: _htmlToText(html) || String(subject || 'Sparks Finance') }, { type: 'text/html', value: html }]
    })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('sendgrid ' + r.status + ': ' + t.slice(0, 200)); }
  return true;
}

function _mailEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// Plain-text alternative from the HTML — sending BOTH parts prevents Gmail from clipping/collapsing
// the message (HTML-only transactional mail is more likely to be trimmed behind a "…").
function _htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/(p|div|tr|table|h[1-6]|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function _permLevelLabel(v) { return { none: 'No access', read: 'View only', update: 'View & edit', delete: 'Full access' }[v] || 'No access'; }

// One themed, responsive, table-based, inline-CSS email card. Matches the app: Inter, #1a73e8 accent.
function emailShell({ title, preheader, bodyHtml, ctaText, ctaUrl, footerNote }) {
  const cta = (ctaText && ctaUrl)
    ? '<a href="' + ctaUrl + '" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:24px">' + _mailEsc(ctaText) + '</a>'
    : '';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>' +
    '<body style="margin:0;padding:0;background:#f1f3f4;">' +
    '<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden">' + _mailEsc(preheader || title || '') +
    '&#8203;&#847;&nbsp;&#847;&#8203;'.repeat(20) + '</span>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f4;padding:24px 12px;font-family:Inter,-apple-system,Segoe UI,Roboto,Arial,sans-serif"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e8eb;border-radius:16px;overflow:hidden">' +
    '<tr><td style="padding:22px 28px;border-bottom:1px solid #eef0f2"><span style="font-size:19px;font-weight:800;color:#1a73e8;letter-spacing:-.3px">⚡ Sparks Finance</span></td></tr>' +
    '<tr><td style="padding:26px 28px 8px;color:#202124">' +
    '<div style="font-size:20px;font-weight:700;margin:0 0 12px">' + _mailEsc(title || '') + '</div>' +
    '<div style="font-size:15px;line-height:1.6;color:#3c4043">' + (bodyHtml || '') + '</div></td></tr>' +
    (cta ? '<tr><td style="padding:8px 28px 22px">' + cta + '</td></tr>' : '<tr><td style="height:10px"></td></tr>') +
    '<tr><td style="padding:16px 28px;border-top:1px solid #eef0f2;color:#80868b;font-size:12px;line-height:1.5">' +
    (footerNote ? _mailEsc(footerNote) + '<br><br>' : '') +
    'You’re receiving this because you have a Sparks Finance account. Manage email preferences in the app under Notifications.</td></tr>' +
    '</table>' +
    '<div style="max-width:560px;color:#9aa0a6;font-size:11px;padding:14px 8px">Sparks Finance · <a href="' + APP_URL + '" style="color:#9aa0a6">' + APP_URL.replace('https://', '') + '</a></div>' +
    '</td></tr></table></body></html>';
}

// Bulleted item list for digests. items: [{title, body?, url?}]
function _mailList(items) {
  if (!items || !items.length) return '<div style="color:#80868b">Nothing to report right now.</div>';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0">' +
    items.map(it => '<tr><td style="padding:10px 0;border-bottom:1px solid #f1f3f4">' +
      '<div style="font-weight:600;color:#202124;font-size:15px">' + _mailEsc(it.title) + '</div>' +
      (it.body ? '<div style="color:#5f6368;font-size:13px;line-height:1.5;margin-top:2px">' + _mailEsc(it.body) + '</div>' : '') +
      (it.url ? '<a href="' + it.url + '" style="color:#1a73e8;font-size:13px;text-decoration:none">Read more →</a>' : '') +
      '</td></tr>').join('') + '</table>';
}

// ── Typed builders — each returns { subject, html } ──
function mailInvite({ orgName, companyName, role, inviterEmail }) {
  const where = companyName ? (_mailEsc(companyName) + ' · ' + _mailEsc(orgName)) : _mailEsc(orgName || 'Sparks Finance');
  return { subject: 'You’ve been invited to ' + (companyName || orgName || 'Sparks Finance'),
    html: emailShell({ title: 'You’ve been invited', preheader: 'Join ' + (companyName || orgName) + ' on Sparks Finance',
      bodyHtml: (inviterEmail ? _mailEsc(inviterEmail) + ' invited you' : 'You’ve been invited') + ' to join <b>' + where + '</b> as <b>' + _mailEsc(role || 'member') + '</b>. Sign in and open your Workspace Hub to accept.',
      ctaText: 'Accept invitation', ctaUrl: APP_URL }) };
}
// changes: [{ module, level }] — one row per module whose access level actually changed.
function mailModuleAccess({ workspace, changes }) {
  const list = changes || [];
  const rows = list.map(c => '<tr><td style="padding:6px 16px 6px 0;color:#202124;font-weight:600">' + _mailEsc(c.module) + '</td>' +
    '<td style="padding:6px 0;color:#3c4043">' + _mailEsc(c.level) + '</td></tr>').join('');
  const summary = list.map(c => c.module + ' → ' + c.level).join(', ');
  return { subject: 'Your access in ' + (workspace || 'Sparks Finance') + ' was updated' + (summary ? ' (' + summary + ')' : ''),
    html: emailShell({ title: 'Your access was updated', preheader: summary || ('Module access changed in ' + workspace),
      bodyHtml: 'An administrator updated your module access in <b>' + _mailEsc(workspace) + '</b>:' +
        (rows ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px;border-collapse:collapse;font-size:14px">' + rows + '</table>' : ' your access was reviewed.'),
      ctaText: 'Open Sparks Finance', ctaUrl: APP_URL }) };
}
function mailRoleChange({ workspace, role }) {
  return { subject: 'Your role changed — ' + (workspace || 'Sparks Finance'),
    html: emailShell({ title: 'Your role was updated', preheader: 'You are now ' + role + ' in ' + workspace,
      bodyHtml: 'You are now <b>' + _mailEsc(role) + '</b> in <b>' + _mailEsc(workspace) + '</b>.', ctaText: 'Open Sparks Finance', ctaUrl: APP_URL }) };
}
function mailMemberRemoved({ workspace }) {
  return { subject: 'You were removed from ' + (workspace || 'a workspace'),
    html: emailShell({ title: 'Access removed', preheader: 'You were removed from ' + workspace,
      bodyHtml: 'Your access to <b>' + _mailEsc(workspace) + '</b> has been removed. If you think this was a mistake, contact your administrator.' }) };
}
function mailWorkspaceRemoved({ workspace }) {
  return { subject: 'Your workspace was removed — ' + (workspace || 'Personal'),
    html: emailShell({ title: 'Workspace removed', preheader: 'Your personal workspace was removed',
      bodyHtml: 'Your workspace <b>' + _mailEsc(workspace) + '</b> has been removed by a platform administrator. Your data is retained but is no longer accessible. Contact your administrator with any questions.' }) };
}
function mailOrgCompanyStatus({ name, status }) {
  return { subject: (name || 'A workspace') + ' was ' + status,
    html: emailShell({ title: (name || 'A workspace') + ' was ' + status, preheader: name + ' status changed',
      bodyHtml: '<b>' + _mailEsc(name) + '</b> has been <b>' + _mailEsc(status) + '</b>. Members lose access while it is inactive.' }) };
}
function mailAccountAction({ title, message }) {
  return { subject: title, html: emailShell({ title, preheader: title, bodyHtml: _mailEsc(message), ctaText: 'Open Sparks Finance', ctaUrl: APP_URL }) };
}
function mailDigest({ subject, title, intro, items, ctaText, tab }) {
  return { subject, html: emailShell({ title, preheader: intro || title,
    bodyHtml: (intro ? '<div style="margin-bottom:8px">' + _mailEsc(intro) + '</div>' : '') + _mailList(items),
    ctaText: ctaText || 'Open in Sparks Finance', ctaUrl: APP_URL + (tab ? '/#' + tab : '') }) };
}

// Resolve a uid's email + email-pref, then send. NEVER throws (email must not break the op).
// category 'account' (admin/security) always sends; digest categories honor users/{uid}.emailPrefs.
async function mailUser(db, uid, category, built, key) {
  try {
    if (!key || !built || !uid) return false;
    let email = null, prefs = {};
    try { const u = await db.collection('users').doc(uid).get(); if (u.exists) { email = u.get('email') || null; prefs = u.get('emailPrefs') || {}; } } catch (e) {}
    if (!email) { try { email = (await admin.auth().getUser(uid)).email || null; } catch (e) {} }
    if (!email) return false;
    if (category !== 'account' && prefs[category] === false) return false;
    await sendEmailSendGrid(email, built.subject, built.html, key);
    return true;
  } catch (e) { logger.error('mailUser failed', { uid, category, error: String(e) }); return false; }
}
// Email a raw address (invitees may not have a users doc yet). NEVER throws.
async function mailTo(email, built, key) {
  try { if (!key || !built || !email) return false; await sendEmailSendGrid(email, built.subject, built.html, key); return true; }
  catch (e) { logger.error('mailTo failed', { email, error: String(e) }); return false; }
}
// All member uids across an org's companies (+ orgAdmins) — for org-wide status-change emails.
async function _orgMemberUids(db, orgId) {
  const uids = new Set();
  try { const cos = await db.collection('organizations').doc(orgId).collection('companies').get();
    for (const c of cos.docs) { try { (await c.ref.collection('members').get()).forEach(m => uids.add(m.id)); } catch (e) {} } } catch (e) {}
  try { (await db.collection('organizations').doc(orgId).collection('orgAdmins').get()).forEach(a => uids.add(a.id)); } catch (e) {}
  return [...uids];
}
async function _companyMemberUids(db, orgId, companyId) {
  const uids = [];
  try { (await db.doc('organizations/' + orgId + '/companies/' + companyId).collection('members').get()).forEach(m => uids.push(m.id)); } catch (e) {}
  return uids;
}
// Fire the same built email to many uids (category-aware, best-effort). NEVER throws.
async function mailUsers(db, uids, category, built, key) {
  for (const uid of (uids || [])) { await mailUser(db, uid, category, built, key); }
}

// On-demand: verify SendGrid config + eyeball a template in a real inbox. Guarded by ?token=<FINNHUB_API_KEY>.
// Usage: /sendTestEmailNow?token=…&to=you@x.com&template=invite|module|digest|account
exports.sendTestEmailNow = onRequest(
  { region: 'us-central1', secrets: [FINNHUB_API_KEY, SENDGRID_API_KEY] },
  async (req, res) => {
    if (req.query.token !== FINNHUB_API_KEY.value()) { res.status(403).send('Forbidden'); return; }
    const to = String(req.query.to || '');
    if (!to) { res.status(400).json({ error: 'to_required — pass &to=you@example.com' }); return; }
    const samples = {
      invite: mailInvite({ orgName: 'Sparks Group', companyName: 'TX Sparks Construction', role: 'member', inviterEmail: 'sean@txsparks.com' }),
      module: mailModuleAccess({ workspace: 'Personal', changes: [{ module: 'Trading', level: 'Full access' }, { module: 'Loans & Notes', level: 'View only' }] }),
      account: mailAccountAction({ title: 'Your account was updated', message: 'An administrator updated your Sparks Finance account settings.' }),
      digest: mailDigest({ subject: 'Your pre-market brief', title: 'Pre-market brief', intro: 'Here’s what matters before the open.', items: [{ title: 'AAPL reports earnings today', body: 'After close · consensus EPS $2.10', url: APP_URL }, { title: 'CPI data at 8:30 AM ET', body: 'High-impact macro print.' }], tab: 'premarket' })
    };
    const which = samples[String(req.query.template || 'digest')] ? String(req.query.template || 'digest') : 'digest';
    try { await sendEmailSendGrid(to, samples[which].subject, samples[which].html, SENDGRID_API_KEY.value()); res.json({ ok: true, sent: which, to }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  }
);

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
  { region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] },
  async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      const code = String((req.body && req.body.code) || '').trim();
      const newPassword = String((req.body && req.body.newPassword) || '');
      if (!email || !/^\d{6}$/.test(code)) { res.status(400).json({ error: 'bad_request' }); return; }
      if (newPassword.length < 6) { res.status(400).json({ error: 'weak_password' }); return; }
      // Owner (super-admin) accounts can't be reset via self-service OTP — reset them out-of-band.
      if (typeof isOwnerEmail === 'function' && isOwnerEmail(email)) { res.status(403).json({ error: 'owner_reset_disabled' }); return; }
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
      await mailUser(admin.firestore(), user.uid, 'account', mailAccountAction({ title: 'Your password was changed', message: 'Your Sparks Finance password was just reset. If this wasn’t you, contact an administrator immediately.' }), SENDGRID_API_KEY.value());
      res.json({ ok: true });
    } catch (e) {
      logger.error('verifyOtp failed', { error: String(e) });
      res.status(500).json({ error: 'verify_failed' });
    }
  }
);

// ── User Management & RBAC (admin-guarded) ────────────────────────────────────
// Real enforcement lives in Firestore/Storage rules via custom claims; these endpoints are the
// ONLY way to create/delete accounts and set role/permissions. Every call verifies the caller's
// Firebase ID token and requires admin (an owner email, or a role:admin custom claim).
const OWNER_EMAILS = ['sean@txsparks.com', 'ravi@txsparks.com'];   // permanent super-admins (keep in sync with firestore.rules + client)
const RBAC_MODULES = ['stocks', 'loans'];                          // keep in sync with the client MODULES registry
const PERM_LEVELS = ['none', 'read', 'update', 'delete'];
function isOwnerEmail(email) { return OWNER_EMAILS.includes((email || '').toLowerCase()); }
// Platform super-admin: an owner email whose address is VERIFIED. Requiring email_verified prevents an
// attacker from self-registering an owner email via public signup (unverified) and seizing platform admin.
function isPlatformOwner(tok) { return !!tok && tok.email_verified === true && isOwnerEmail(tok.email); }
function cleanPerms(p) {
  const out = {};
  RBAC_MODULES.forEach(m => { const v = p && p[m]; out[m] = PERM_LEVELS.includes(v) ? v : 'none'; });
  return out;
}
// Verify the caller's ID token; return the decoded token IFF they're an admin, else null.
async function verifyAdmin(req) {
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) return null;
  // checkRevoked=true so a demoted/disabled admin's token stops working immediately (we revoke on change).
  let tok; try { tok = await admin.auth().verifyIdToken(m[1], true); } catch (e) { return null; }
  const email = (tok.email || '').toLowerCase();
  if (!((tok.email_verified === true && isOwnerEmail(email)) || tok.role === 'admin')) return null;
  try { const u = await admin.auth().getUser(tok.uid); if (u.disabled) return null; } catch (e) { return null; }
  return tok;
}
function _callerIsOwner(caller) { return isOwnerEmail(((caller && caller.email) || '').toLowerCase()); }
// Set a user's role+perms as custom claims (what the rules read) AND mirror to users/{uid} for the console/UI.
async function applyRole(uid, email, role, perms, extra) {
  const claims = { role: role === 'admin' ? 'admin' : 'user', perms: cleanPerms(perms) };
  await admin.auth().setCustomUserClaims(uid, claims);
  await admin.firestore().collection('users').doc(uid).set(Object.assign(
    { email: (email || '').toLowerCase(), role: claims.role, perms: claims.perms, updated: Date.now() },
    extra || {}), { merge: true });
}

exports.adminListUsers = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    if (!(await verifyAdmin(req))) { res.status(403).json({ error: 'forbidden' }); return; }
    try {
      const db = admin.firestore();
      const docs = {};
      (await db.collection('users').get()).forEach(d => { docs[d.id] = d.data(); });
      const list = await admin.auth().listUsers(1000);
      const users = list.users.map(u => {
        const doc = docs[u.uid] || {}, claims = u.customClaims || {}, owner = isOwnerEmail(u.email);
        return {
          uid: u.uid, email: u.email || '', owner, disabled: !!u.disabled,
          role: owner ? 'admin' : (claims.role || doc.role || 'user'),
          perms: owner ? cleanPerms({ stocks: 'delete', loans: 'delete' }) : cleanPerms(claims.perms || doc.perms),
          created: (u.metadata && u.metadata.creationTime) || null,
          lastSignIn: (u.metadata && u.metadata.lastSignInTime) || null
        };
      });
      res.json({ ok: true, users });
    } catch (e) { logger.error('adminListUsers failed', { error: String(e) }); res.status(500).json({ error: 'list_failed' }); }
  }
);

exports.adminCreateUser = onRequest(
  { region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] },
  async (req, res) => {
    const caller = await verifyAdmin(req);
    if (!caller) { res.status(403).json({ error: 'forbidden' }); return; }
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      const password = String((req.body && req.body.password) || '');
      const role = (req.body && req.body.role) === 'admin' ? 'admin' : 'user';
      const perms = (req.body && req.body.perms) || {};
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'invalid_email' }); return; }
      if (password.length < 6) { res.status(400).json({ error: 'weak_password' }); return; }
      // Owner emails are reserved — only an owner may create/bootstrap another owner account.
      if (isOwnerEmail(email) && !_callerIsOwner(caller)) { res.status(403).json({ error: 'owner_reserved' }); return; }
      // Only owners may grant the admin role (admins can manage users, not mint other admins).
      if (role === 'admin' && !_callerIsOwner(caller)) { res.status(403).json({ error: 'admin_grant_requires_owner' }); return; }
      const user = await admin.auth().createUser({ email, password, emailVerified: false });
      await applyRole(user.uid, email, role, perms, { created: Date.now(), createdBy: caller.email || caller.uid });
      await mailUser(admin.firestore(), user.uid, 'account', mailAccountAction({ title: 'Your Sparks Finance account is ready', message: 'An administrator created a Sparks Finance account for ' + email + '. Sign in at ' + APP_URL + ' with the password you were given, then change it after signing in.' }), SENDGRID_API_KEY.value());
      res.json({ ok: true, uid: user.uid });
    } catch (e) {
      if ((e && e.code) === 'auth/email-already-exists') { res.status(409).json({ error: 'email_exists' }); return; }
      logger.error('adminCreateUser failed', { error: String(e) });
      res.status(500).json({ error: 'create_failed' });
    }
  }
);

exports.adminUpdateUser = onRequest(
  { region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] },
  async (req, res) => {
    const caller = await verifyAdmin(req);
    if (!caller) { res.status(403).json({ error: 'forbidden' }); return; }
    try {
      const uid = String((req.body && req.body.uid) || '');
      if (!uid) { res.status(400).json({ error: 'uid_required' }); return; }
      const target = await admin.auth().getUser(uid);
      if (isOwnerEmail(target.email)) { res.status(403).json({ error: 'owner_protected' }); return; }   // owners can't be demoted/disabled
      const role = (req.body && req.body.role) === 'admin' ? 'admin' : 'user';
      const targetIsAdmin = !!(target.customClaims && target.customClaims.role === 'admin');
      // Only owners may grant admin OR modify an existing admin (prevents admin-tier lateral escalation/lockout).
      if ((role === 'admin' || targetIsAdmin) && !_callerIsOwner(caller)) { res.status(403).json({ error: 'admin_grant_requires_owner' }); return; }
      const perms = (req.body && req.body.perms) || {};
      const hasDisabled = req.body && typeof req.body.disabled === 'boolean';
      if (hasDisabled) await admin.auth().updateUser(uid, { disabled: req.body.disabled });
      await applyRole(uid, target.email, role, perms, hasDisabled ? { disabled: req.body.disabled } : {});
      try { await admin.auth().revokeRefreshTokens(uid); } catch (e) {}   // invalidate the target's existing tokens so role/perm/disable changes apply immediately
      // Notify the target (before responding). Disable/enable → status note; else role + module summary.
      const cp = cleanPerms(perms);
      const built = hasDisabled
        ? mailAccountAction({ title: req.body.disabled ? 'Your account was disabled' : 'Your account was re-enabled', message: req.body.disabled ? 'Your Sparks Finance account has been disabled by an administrator. Contact your administrator with any questions.' : 'Your Sparks Finance account has been re-enabled — you can sign in again at ' + APP_URL + '.' })
        : mailAccountAction({ title: 'Your account was updated', message: 'An administrator updated your Sparks Finance account. Role: ' + role + ' · Trading: ' + _permLevelLabel(cp.stocks) + ' · Loans & Notes: ' + _permLevelLabel(cp.loans) + '.' });
      await mailUser(admin.firestore(), uid, 'account', built, SENDGRID_API_KEY.value());
      res.json({ ok: true });
    } catch (e) { logger.error('adminUpdateUser failed', { error: String(e) }); res.status(500).json({ error: 'update_failed' }); }
  }
);

exports.adminDeleteUser = onRequest(
  { region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] },
  async (req, res) => {
    const caller = await verifyAdmin(req);
    if (!caller) { res.status(403).json({ error: 'forbidden' }); return; }
    try {
      const uid = String((req.body && req.body.uid) || '');
      if (!uid) { res.status(400).json({ error: 'uid_required' }); return; }
      if (uid === caller.uid) { res.status(400).json({ error: 'cannot_delete_self' }); return; }
      const target = await admin.auth().getUser(uid);
      if (isOwnerEmail(target.email)) { res.status(403).json({ error: 'owner_protected' }); return; }
      const targetIsAdmin = !!(target.customClaims && target.customClaims.role === 'admin');
      if (targetIsAdmin && !_callerIsOwner(caller)) { res.status(403).json({ error: 'admin_delete_requires_owner' }); return; }
      const delEmail = target.email || null;   // capture before deletion (users doc/email is gone after)
      await admin.auth().deleteUser(uid);
      await admin.firestore().collection('users').doc(uid).delete().catch(() => {});
      if (delEmail) await mailTo(delEmail, mailAccountAction({ title: 'Your Sparks Finance account was removed', message: 'Your Sparks Finance account has been deleted by an administrator. Contact your administrator with any questions.' }), SENDGRID_API_KEY.value());
      res.json({ ok: true });
    } catch (e) { logger.error('adminDeleteUser failed', { error: String(e) }); try { res.status(500).json({ error: 'delete_failed' }); } catch (_) {} }
  }
);

// Read-only, audit-logged admin view of ANOTHER user's portfolios (holdings + transactions). This is
// the ONLY cross-user data path — Firestore rules keep clients strictly per-uid; access is mediated
// here (admin-guarded) and every view is logged to admin_audit.
exports.adminGetUserPortfolio = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    const caller = await verifyAdmin(req);
    if (!caller) { res.status(403).json({ error: 'forbidden' }); return; }
    try {
      const uid = String((req.body && req.body.uid) || '');
      if (!uid) { res.status(400).json({ error: 'uid_required' }); return; }
      const db = admin.firestore();
      const pfSnap = await db.collection('portfolios').doc(uid).collection('list').get();
      const portfolios = [];
      for (const pd of pfSnap.docs) {
        const pf = pd.data() || {};
        let holdings = [], transactions = [];
        try { holdings = (await db.collection('holdings').doc(uid).collection(pd.id).get()).docs.map(d => ({ id: d.id, ...d.data() })); } catch (e) {}
        try { transactions = (await db.collection('transactions').doc(uid).collection(pd.id).get()).docs.map(d => ({ id: d.id, ...d.data() })); } catch (e) {}
        portfolios.push({ id: pd.id, name: pf.name || pd.id, description: pf.description || '', notes: pf.notes || {}, holdings, transactions });
      }
      let targetEmail = '';
      try { targetEmail = (await admin.auth().getUser(uid)).email || ''; } catch (e) {}
      // Audit is a hard precondition: if the log write fails, do NOT serve the cross-user data.
      await db.collection('admin_audit').add({ adminUid: caller.uid, adminEmail: caller.email || '', targetUid: uid, targetEmail, action: 'view_portfolio', at: admin.firestore.FieldValue.serverTimestamp() });
      res.json({ ok: true, uid, email: targetEmail, portfolios });
    } catch (e) { logger.error('adminGetUserPortfolio failed', { error: String(e) }); res.status(500).json({ error: 'read_failed' }); }
  }
);

// ══════════════ Organizations / multi-tenant SaaS ══════════════
// Membership docs (organizations/{orgId}/members/{uid}) are the permission source of truth — the
// Firestore rules read them via get(). These CFs (Admin SDK) are the ONLY writer of memberships, so a
// member can never self-escalate. Owner emails (isOwnerEmail) are PLATFORM super-admins above every org.
const ORG_ROLES = ['member', 'admin', 'owner'];
function roleRank(r) { const i = ORG_ROLES.indexOf(r); return i < 0 ? 0 : i; }
// Verify the caller's ID token; return the decoded token for ANY enabled signed-in user, else null.
async function verifyAuthed(req) {
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) return null;
  let tok; try { tok = await admin.auth().verifyIdToken(m[1], true); } catch (e) { return null; }
  try { const u = await admin.auth().getUser(tok.uid); if (u.disabled) return null; } catch (e) { return null; }
  return tok;
}
// Returns { tok, member, isPlatform } iff the caller is a member of orgId with role >= minRole
// (platform admins always pass), else null.
async function verifyOrgRole(req, orgId, minRole) {
  const tok = await verifyAuthed(req);
  if (!tok || !orgId) return null;
  const isPlatform = isPlatformOwner(tok);
  let member = null;
  try { const d = await admin.firestore().doc('organizations/' + orgId + '/members/' + tok.uid).get(); if (d.exists) member = d.data(); } catch (e) {}
  if (isPlatform) return { tok, member, isPlatform: true };
  if (!member) return null;
  if (roleRank(member.role) < roleRank(minRole || 'member')) return null;
  return { tok, member, isPlatform: false };
}
function _callerOwnsOrg(auth) { return !!(auth && (auth.isPlatform || (auth.member && auth.member.role === 'owner'))); }
// Write/merge a membership doc AND maintain the user's org index (users/{uid}.orgs map for the switcher).
async function setMembership(orgId, uid, email, role, perms, orgName, extra) {
  const db = admin.firestore();
  const r = ORG_ROLES.includes(role) ? role : 'member';
  await db.doc('organizations/' + orgId + '/members/' + uid).set(Object.assign(
    { email: (email || '').toLowerCase(), role: r, perms: cleanPerms(perms), updatedAt: Date.now() }, extra || {}), { merge: true });
  await db.collection('users').doc(uid).set({ email: (email || '').toLowerCase(), orgs: { [orgId]: { name: orgName || '', role: r } } }, { merge: true });
}
async function _orgName(orgId) { try { const d = await admin.firestore().collection('organizations').doc(orgId).get(); return (d.exists && d.data().name) || ''; } catch (e) { return ''; } }

// Legacy org create — now Super-Admin-only (top-down governance). Team orgs are created via
// createOrganization; solo users get a Personal workspace via ensurePersonalOrg.
exports.createOrg = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!isPlatformOwner(tok)) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    if (!name) { res.status(400).json({ error: 'name_required' }); return; }
    const industry = String((req.body && req.body.industry) || '').trim().slice(0, 40);
    const db = admin.firestore();
    const ref = db.collection('organizations').doc();
    // `personal` is set ONLY by ensurePersonalOrg (kept idempotent); a normal createOrg is never personal.
    await ref.set({ name, industry, personal: false, createdBy: tok.uid, createdByEmail: (tok.email || '').toLowerCase(), createdAt: Date.now(), plan: 'free' });
    await setMembership(ref.id, tok.uid, tok.email, 'owner', { stocks: 'delete', loans: 'delete' }, name, { joinedAt: Date.now(), invitedBy: tok.uid });
    res.json({ ok: true, orgId: ref.id, name });
  } catch (e) { logger.error('createOrg failed', { error: String(e) }); res.status(500).json({ error: 'create_failed' }); }
});

// Solo "Personal workspace": idempotently return (or create) the caller's own personal org so the hub's
// "Continue solo" never spawns duplicates. A personal org is a normal one-member org flagged personal:true.
exports.ensurePersonalOrg = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!tok) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const db = admin.firestore();
    const udoc = await db.collection('users').doc(tok.uid).get();
    const orgs = (udoc.exists && udoc.data() && udoc.data().orgs) || {};
    for (const oid of Object.keys(orgs)) {
      try { const od = await db.collection('organizations').doc(oid).get(); if (od.exists && od.data().personal === true && od.data().createdBy === tok.uid) { res.json({ ok: true, orgId: oid, companyId: od.data().defaultCompany || null, name: od.data().name || 'Personal' }); return; } } catch (e) {}
    }
    // New personal org with a single default company that holds the data (company is the data tier).
    const ref = db.collection('organizations').doc();
    const coRef = ref.collection('companies').doc();
    await ref.set({ name: 'Personal', industry: '', personal: true, active: true, defaultCompany: coRef.id, createdBy: tok.uid, createdByEmail: (tok.email || '').toLowerCase(), createdAt: Date.now(), plan: 'free' });
    await coRef.set({ name: 'Personal', active: true, modules: { stocks: true, loans: true }, createdBy: tok.uid, createdAt: Date.now() });
    await setCompanyMembership(ref.id, coRef.id, tok.uid, tok.email, 'admin', { stocks: 'delete', loans: 'delete' }, 'Personal', 'Personal', { joinedAt: Date.now() });
    // Denormalize personal:true onto the user's org index so the hub can render it as a single
    // "Personal workspace" entry (a member can't read the org doc directly to learn this).
    await db.collection('users').doc(tok.uid).set({ orgs: { [ref.id]: { personal: true } } }, { merge: true });
    res.json({ ok: true, orgId: ref.id, companyId: coRef.id, name: 'Personal' });
  } catch (e) { logger.error('ensurePersonalOrg failed', { error: String(e) }); res.status(500).json({ error: 'create_failed' }); }
});

// Owner/admin invites a person by email. Invites live in a top-level `invites` collection (only
// single-field auto-indexes needed). Granting owner/admin requires the caller to be an owner.
exports.orgInvite = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || '');
  const auth = await verifyOrgRole(req, orgId, 'admin');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'invalid_email' }); return; }
    // Platform super-admins (owner emails) already have full access to every org/company; they must NOT
    // be added as ordinary members. Their only membership is their own self-served Personal workspace.
    if (isOwnerEmail(email)) { res.status(400).json({ error: 'owner_is_platform_admin' }); return; }
    const role = ORG_ROLES.includes(req.body && req.body.role) ? req.body.role : 'member';
    if ((role === 'owner' || role === 'admin') && !_callerOwnsOrg(auth)) { res.status(403).json({ error: 'grant_requires_owner' }); return; }
    const db = admin.firestore();
    const already = await db.collection('organizations').doc(orgId).collection('members').where('email', '==', email).limit(1).get();
    if (!already.empty) { res.status(409).json({ error: 'already_member' }); return; }
    const orgName = await _orgName(orgId);
    const inv = { orgId, emailLower: email, role, perms: cleanPerms((req.body && req.body.perms) || {}), status: 'pending', invitedBy: auth.tok.uid, invitedByEmail: (auth.tok.email || '').toLowerCase(), orgName, createdAt: Date.now(), expiresAt: Date.now() + 30 * 864e5 };
    const existing = await db.collection('invites').where('emailLower', '==', email).get();
    const dupe = existing.docs.find(d => { const v = d.data(); return v.orgId === orgId && v.status === 'pending'; });
    let inviteId;
    if (dupe) { await dupe.ref.set(inv, { merge: true }); inviteId = dupe.id; }
    else { const ref = await db.collection('invites').add(inv); inviteId = ref.id; }
    // Send BEFORE responding — gen-2/Cloud Run throttles CPU after res flushes, orphaning a post-response await.
    await mailTo(email, mailInvite({ orgName, role, inviterEmail: inv.invitedByEmail }), SENDGRID_API_KEY.value());
    res.json({ ok: true, inviteId, updated: !!dupe });
  } catch (e) { logger.error('orgInvite failed', { error: String(e) }); res.status(500).json({ error: 'invite_failed' }); }
});

// The signed-in user's own pending invites (matched by their verified email).
exports.listMyInvites = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!tok) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    // Only a VERIFIED email is trusted as identity — otherwise an attacker who registered someone else's
    // (unverified) invited address could enumerate/claim their invites.
    if (tok.email_verified !== true) { res.json({ ok: true, invites: [] }); return; }
    const email = (tok.email || '').toLowerCase();
    if (!email) { res.json({ ok: true, invites: [] }); return; }
    const snap = await admin.firestore().collection('invites').where('emailLower', '==', email).get();
    const now = Date.now();
    const invites = snap.docs.map(d => ({ inviteId: d.id, ...d.data() }))
      .filter(v => v.status === 'pending' && !(v.expiresAt && v.expiresAt < now))
      .map(v => ({ inviteId: v.inviteId, orgId: v.orgId, companyId: v.companyId || null, orgName: v.orgName || '', companyName: v.companyName || '', role: v.role, invitedByEmail: v.invitedByEmail || '' }));
    res.json({ ok: true, invites });
  } catch (e) { logger.error('listMyInvites failed', { error: String(e) }); res.status(500).json({ error: 'list_failed' }); }
});

// The invited user accepts — creates their membership with EXACTLY the invited role/perms.
exports.acceptInvite = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!tok) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    // Require a verified email: acceptance is authorized by email match, so an unverified account that
    // registered the invitee's address must NOT be able to claim the invite.
    if (tok.email_verified !== true) { res.status(403).json({ error: 'email_not_verified' }); return; }
    const inviteId = String((req.body && req.body.inviteId) || '');
    if (!inviteId) { res.status(400).json({ error: 'bad_request' }); return; }
    const email = (tok.email || '').toLowerCase();
    // Defense in depth: a platform super-admin never becomes an org/company member (they already have full access).
    if (isOwnerEmail(email)) { res.status(403).json({ error: 'owner_is_platform_admin' }); return; }
    const db = admin.firestore();
    const invRef = db.collection('invites').doc(inviteId);
    const inv = await invRef.get();
    if (!inv.exists) { res.status(404).json({ error: 'invite_not_found' }); return; }
    const iv = inv.data();
    if (iv.status !== 'pending') { res.status(409).json({ error: 'invite_used' }); return; }
    if ((iv.emailLower || '') !== email) { res.status(403).json({ error: 'email_mismatch' }); return; }
    if (iv.expiresAt && iv.expiresAt < Date.now()) { res.status(410).json({ error: 'invite_expired' }); return; }
    // Company invite → create a company membership (role admin|member) and return the company context.
    if (iv.companyId) {
      const orgNm = (await _orgName(iv.orgId)) || iv.orgName || '';
      const coNm = (await _companyName(iv.orgId, iv.companyId)) || iv.companyName || '';
      let coRole = iv.role === 'admin' ? 'admin' : 'member';
      // Authority freshness (mirrors the org branch): only confer company-admin if the inviter is STILL a
      // platform owner, an org admin, or a company admin of this company — else a since-demoted/removed
      // inviter could pre-provision surviving admin access. Downgrade to member otherwise.
      if (coRole === 'admin') {
        let inviterOk = OWNER_EMAILS.includes((iv.invitedByEmail || '').toLowerCase());
        if (!inviterOk && iv.invitedBy) { try { const oa = await db.doc('organizations/' + iv.orgId + '/orgAdmins/' + iv.invitedBy).get(); inviterOk = oa.exists; } catch (e) {} }
        if (!inviterOk && iv.invitedBy) { try { const cm = await db.doc('organizations/' + iv.orgId + '/companies/' + iv.companyId + '/members/' + iv.invitedBy).get(); inviterOk = cm.exists && cm.data().role === 'admin'; } catch (e) {} }
        if (!inviterOk) coRole = 'member';
      }
      await setCompanyMembership(iv.orgId, iv.companyId, tok.uid, email, coRole, iv.perms, orgNm, coNm, { joinedAt: Date.now(), invitedBy: iv.invitedBy || null });
      await invRef.set({ status: 'accepted', acceptedAt: Date.now(), acceptedUid: tok.uid, grantedRole: coRole }, { merge: true });
      await mailTo(email, mailAccountAction({ title: 'You joined ' + (coNm || orgNm || 'a workspace'), message: 'You now have access to ' + (coNm || orgNm) + ' on Sparks Finance as ' + coRole + '.' }), SENDGRID_API_KEY.value());
      res.json({ ok: true, orgId: iv.orgId, companyId: iv.companyId, name: orgNm });
      return;
    }
    // Authority freshness: only confer owner/admin if the inviter is STILL an owner (or platform owner).
    // Otherwise downgrade to member — a since-demoted/removed inviter can't pre-provision privilege.
    let grantRole = iv.role || 'member';
    if (grantRole === 'owner' || grantRole === 'admin') {
      let inviterOk = OWNER_EMAILS.includes((iv.invitedByEmail || '').toLowerCase());
      if (!inviterOk && iv.invitedBy) { try { const im = await db.doc('organizations/' + iv.orgId + '/members/' + iv.invitedBy).get(); inviterOk = im.exists && im.data().role === 'owner'; } catch (e) {} }
      if (!inviterOk) grantRole = 'member';
    }
    const orgName = (await _orgName(iv.orgId)) || iv.orgName || '';
    await setMembership(iv.orgId, tok.uid, email, grantRole, iv.perms, orgName, { joinedAt: Date.now(), invitedBy: iv.invitedBy || null });
    await invRef.set({ status: 'accepted', acceptedAt: Date.now(), acceptedUid: tok.uid, grantedRole: grantRole }, { merge: true });
    await mailTo(email, mailAccountAction({ title: 'You joined ' + (orgName || 'a workspace'), message: 'You now have access to ' + orgName + ' on Sparks Finance as ' + grantRole + '.' }), SENDGRID_API_KEY.value());
    res.json({ ok: true, orgId: iv.orgId, name: orgName });
  } catch (e) { logger.error('acceptInvite failed', { error: String(e) }); res.status(500).json({ error: 'accept_failed' }); }
});

// Roster for an org (any member); pending invites + manage flag only for owner/admin.
exports.orgListMembers = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || (req.query && req.query.orgId) || '');
  const auth = await verifyOrgRole(req, orgId, 'member');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const db = admin.firestore();
    const members = (await db.collection('organizations').doc(orgId).collection('members').get()).docs.map(d => ({ uid: d.id, ...d.data() }));
    const canManage = _callerOwnsOrg(auth) || (auth.member && auth.member.role === 'admin');
    let invites = [];
    if (canManage) {
      const snap = await db.collection('invites').where('orgId', '==', orgId).get();
      invites = snap.docs.map(d => ({ inviteId: d.id, ...d.data() })).filter(v => v.status === 'pending');
    }
    res.json({ ok: true, members, invites, canManage: !!canManage, callerRole: auth.isPlatform ? 'platform' : (auth.member && auth.member.role) });
  } catch (e) { logger.error('orgListMembers failed', { error: String(e) }); res.status(500).json({ error: 'list_failed' }); }
});

// Change a member's role/perms. Owner/admin only; touching an owner/admin (or granting one) needs owner;
// the last owner cannot be demoted.
exports.orgUpdateMember = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || '');
  const auth = await verifyOrgRole(req, orgId, 'admin');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) { res.status(400).json({ error: 'uid_required' }); return; }
    const db = admin.firestore();
    const memRef = db.collection('organizations').doc(orgId).collection('members').doc(uid);
    const ownersQ = db.collection('organizations').doc(orgId).collection('members').where('role', '==', 'owner');
    // Transaction: read the member doc + owner set and write the new role atomically, so a concurrent
    // demotion of another owner cannot leave the org with zero owners (TOCTOU).
    let newRoleOut, oldRole, oldPerms = {}, newPerms = {};
    await db.runTransaction(async (t) => {
      const memDoc = await t.get(memRef);
      if (!memDoc.exists) throw { code: 'not_member' };
      const cur = memDoc.data();
      oldRole = cur.role; oldPerms = cur.perms || {};
      const newRole = ORG_ROLES.includes(req.body && req.body.role) ? req.body.role : cur.role;
      if ((cur.role === 'owner' || cur.role === 'admin' || newRole === 'owner' || newRole === 'admin') && !_callerOwnsOrg(auth)) throw { code: 'requires_owner' };
      if (cur.role === 'owner' && newRole !== 'owner') { const owners = await t.get(ownersQ); if (owners.size <= 1) throw { code: 'last_owner' }; }
      newPerms = cleanPerms((req.body && req.body.perms) || cur.perms || {});
      t.set(memRef, { email: cur.email, role: newRole, perms: newPerms, updatedAt: Date.now() }, { merge: true });
      newRoleOut = newRole;
    });
    const orgName = await _orgName(orgId);
    await db.collection('users').doc(uid).set({ orgs: { [orgId]: { name: orgName, role: newRoleOut } } }, { merge: true });
    // Email the member about any module-level change, else a role change (before responding — gen-2 CPU throttle).
    const changes = MODULE_KEYS.filter(m => (newPerms[m.id] || 'none') !== (oldPerms[m.id] || 'none')).map(m => ({ module: m.label, level: _permLevelLabel(newPerms[m.id] || 'none') }));
    const key = SENDGRID_API_KEY.value();
    if (changes.length) await mailUser(db, uid, 'account', mailModuleAccess({ workspace: orgName, changes }), key);
    else if (newRoleOut !== oldRole) await mailUser(db, uid, 'account', mailRoleChange({ workspace: orgName, role: newRoleOut }), key);
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code) { res.status(e.code === 'last_owner' ? 409 : (e.code === 'not_member' ? 404 : 403)).json({ error: e.code }); return; }
    logger.error('orgUpdateMember failed', { error: String(e) }); try { res.status(500).json({ error: 'update_failed' }); } catch (_) {}
  }
});

// Remove a member (admin removes others; anyone may remove themselves = leave). Removing an owner/admin
// needs owner; the last owner cannot leave/be removed.
exports.orgRemoveMember = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || '');
  const auth = await verifyOrgRole(req, orgId, 'member');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) { res.status(400).json({ error: 'uid_required' }); return; }
    const db = admin.firestore();
    const memRef = db.collection('organizations').doc(orgId).collection('members').doc(uid);
    const ownersQ = db.collection('organizations').doc(orgId).collection('members').where('role', '==', 'owner');
    const isSelf = uid === auth.tok.uid;
    const callerManages = _callerOwnsOrg(auth) || (auth.member && auth.member.role === 'admin');
    // Transaction: check the last-owner invariant against the owner set and delete atomically.
    let removed = false;
    await db.runTransaction(async (t) => {
      const memDoc = await t.get(memRef);
      if (!memDoc.exists) return;
      const cur = memDoc.data();
      if (!isSelf && !callerManages) throw { code: 'forbidden' };
      if (!isSelf && (cur.role === 'owner' || cur.role === 'admin') && !_callerOwnsOrg(auth)) throw { code: 'requires_owner' };
      if (cur.role === 'owner') { const owners = await t.get(ownersQ); if (owners.size <= 1) throw { code: 'last_owner' }; }
      t.delete(memRef); removed = true;
    });
    if (removed) await db.collection('users').doc(uid).set({ orgs: { [orgId]: admin.firestore.FieldValue.delete() } }, { merge: true });
    // Notify (before responding) only when an admin removed SOMEONE ELSE (not a self-leave).
    if (removed && !isSelf) await mailUser(db, uid, 'account', mailMemberRemoved({ workspace: await _orgName(orgId) }), SENDGRID_API_KEY.value());
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code) { res.status(e.code === 'last_owner' ? 409 : 403).json({ error: e.code }); return; }
    logger.error('orgRemoveMember failed', { error: String(e) }); try { res.status(500).json({ error: 'remove_failed' }); } catch (_) {}
  }
});

// Rename an org (owner only).
exports.orgUpdateSettings = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || '');
  const auth = await verifyOrgRole(req, orgId, 'owner');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    if (!name) { res.status(400).json({ error: 'name_required' }); return; }
    const db = admin.firestore();
    await db.collection('organizations').doc(orgId).set({ name }, { merge: true });
    // refresh the denormalized name in every member's users/{uid}.orgs index
    const members = await db.collection('organizations').doc(orgId).collection('members').get();
    const batch = db.batch();
    members.forEach(d => batch.set(db.collection('users').doc(d.id), { orgs: { [orgId]: { name } } }, { merge: true }));
    await batch.commit();
    res.json({ ok: true });
  } catch (e) { logger.error('orgUpdateSettings failed', { error: String(e) }); res.status(500).json({ error: 'update_failed' }); }
});

// ── Platform super-admin (owner emails): cross-org console, audited ──
exports.platformListOrgs = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!isPlatformOwner(tok)) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const snap = await admin.firestore().collection('organizations').get();
    const orgs = [];
    for (const d of snap.docs) {
      const o = d.data() || {};
      // People live at the COMPANY tier; the org-tier `members` subcollection is usually empty.
      // So the true member count = distinct UIDs across org-tier members + every company's members,
      // and we also surface how many companies the org has.
      let companyCount = 0; const uids = new Set();
      try {
        const cosSnap = await d.ref.collection('companies').get();
        companyCount = cosSnap.size;
        try { (await d.ref.collection('members').get()).forEach(m => uids.add(m.id)); } catch (e) {}
        const memberSnaps = await Promise.all(cosSnap.docs.map(c => c.ref.collection('members').get().catch(() => null)));
        memberSnaps.forEach(ms => { if (ms) ms.forEach(m => uids.add(m.id)); });
      } catch (e) {}
      orgs.push({ orgId: d.id, name: o.name || '', createdByEmail: o.createdByEmail || '', createdAt: o.createdAt || null, plan: o.plan || 'free', memberCount: uids.size, companyCount, personal: o.personal === true, industry: o.industry || '', defaultCompany: o.defaultCompany || null });
    }
    res.json({ ok: true, orgs });
  } catch (e) { logger.error('platformListOrgs failed', { error: String(e) }); res.status(500).json({ error: 'list_failed' }); }
});
exports.platformGetOrg = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!isPlatformOwner(tok)) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const orgId = String((req.body && req.body.orgId) || '');
    if (!orgId) { res.status(400).json({ error: 'orgId_required' }); return; }
    const db = admin.firestore();
    const orgDoc = await db.collection('organizations').doc(orgId).get();
    if (!orgDoc.exists) { res.status(404).json({ error: 'not_found' }); return; }
    const members = (await db.collection('organizations').doc(orgId).collection('members').get()).docs.map(d => ({ uid: d.id, ...d.data() }));
    await db.collection('platform_audit').add({ adminUid: tok.uid, adminEmail: (tok.email || '').toLowerCase(), targetOrg: orgId, action: 'view_org', at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true, org: Object.assign({ orgId }, orgDoc.data()), members });
  } catch (e) { logger.error('platformGetOrg failed', { error: String(e) }); res.status(500).json({ error: 'read_failed' }); }
});

// ══════════════ Company tier (Super Admin → Org → Company → Admin → Member) ══════════════
// Financial data lives under organizations/{o}/companies/{c}/… Company members are the permission source
// of truth (rules read them via get()); org admins (organizations/{o}/orgAdmins/{uid}) see ALL companies
// in their org; platform owners (Super Admins) see everything. Orgs/companies/org-admins are provisioned
// TOP-DOWN — createOrganization/assignOrgAdmin require a Super Admin.
async function _uidByEmail(email) { try { const u = await admin.auth().getUserByEmail((email || '').toLowerCase()); return u ? u.uid : null; } catch (e) { return null; } }
async function _companyName(orgId, cid) { try { const d = await admin.firestore().doc('organizations/' + orgId + '/companies/' + cid).get(); return (d.exists && d.data().name) || ''; } catch (e) { return ''; } }
// Org-admin (or platform) gate.
async function verifyOrgAdmin(req, orgId) {
  const tok = await verifyAuthed(req); if (!tok || !orgId) return null;
  if (isPlatformOwner(tok)) return { tok, isPlatform: true, orgAdmin: true };
  try { const d = await admin.firestore().doc('organizations/' + orgId + '/orgAdmins/' + tok.uid).get(); if (d.exists) return { tok, isPlatform: false, orgAdmin: true }; } catch (e) {}
  return null;
}
// Company-role gate: platform + org-admin get full access; else the caller's company member role must be >= minRole.
async function verifyCompanyRole(req, orgId, companyId, minRole) {
  const tok = await verifyAuthed(req); if (!tok || !orgId || !companyId) return null;
  if (isPlatformOwner(tok)) return { tok, isPlatform: true, orgAdmin: true, member: null };
  try { const oa = await admin.firestore().doc('organizations/' + orgId + '/orgAdmins/' + tok.uid).get(); if (oa.exists) return { tok, isPlatform: false, orgAdmin: true, member: null }; } catch (e) {}
  let member = null;
  try { const d = await admin.firestore().doc('organizations/' + orgId + '/companies/' + companyId + '/members/' + tok.uid).get(); if (d.exists) member = d.data(); } catch (e) {}
  if (!member) return null;
  if ((minRole === 'admin') && member.role !== 'admin') return null;
  return { tok, isPlatform: false, orgAdmin: false, member };
}
function _coCanManage(auth) { return !!(auth && (auth.isPlatform || auth.orgAdmin || (auth.member && auth.member.role === 'admin'))); }
// Write a company membership + maintain users/{uid}.orgs[orgId].companies[cid] (deep-merge, non-clobbering).
async function setCompanyMembership(orgId, companyId, uid, email, role, perms, orgName, companyName, extra) {
  const db = admin.firestore();
  const r = (role === 'admin') ? 'admin' : 'member';
  await db.doc('organizations/' + orgId + '/companies/' + companyId + '/members/' + uid).set(Object.assign(
    { email: (email || '').toLowerCase(), role: r, perms: cleanPerms(perms), updatedAt: Date.now() }, extra || {}), { merge: true });
  await db.collection('users').doc(uid).set({ email: (email || '').toLowerCase(), orgs: { [orgId]: { name: orgName || '', companies: { [companyId]: { name: companyName || '', role: r } } } } }, { merge: true });
}

// ── Super Admin: organizations ──
exports.createOrganization = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!isPlatformOwner(tok)) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    if (!name) { res.status(400).json({ error: 'name_required' }); return; }
    const industry = String((req.body && req.body.industry) || '').trim().slice(0, 40);
    const db = admin.firestore();
    const ref = db.collection('organizations').doc();
    await ref.set({ name, industry, active: true, personal: false, createdBy: tok.uid, createdByEmail: (tok.email || '').toLowerCase(), createdAt: Date.now(), plan: 'free' });
    res.json({ ok: true, orgId: ref.id, name });
  } catch (e) { logger.error('createOrganization failed', { error: String(e) }); res.status(500).json({ error: 'create_failed' }); }
});
exports.updateOrganization = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!isPlatformOwner(tok)) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const orgId = String((req.body && req.body.orgId) || '');
    if (!orgId) { res.status(400).json({ error: 'orgId_required' }); return; }
    const db = admin.firestore();
    let org = {}; try { const od = await db.collection('organizations').doc(orgId).get(); org = od.exists ? od.data() : {}; } catch (e) {}
    const patch = {};
    if (req.body && typeof req.body.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 80);
    if (req.body && typeof req.body.industry === 'string') patch.industry = req.body.industry.trim().slice(0, 40);
    if (req.body && typeof req.body.active === 'boolean') patch.active = req.body.active;   // deactivate/reactivate
    if (req.body && req.body.delete === true) { patch.active = false; patch.deleted = true; patch.deletedAt = Date.now(); }
    if (!Object.keys(patch).length) { res.status(400).json({ error: 'nothing_to_update' }); return; }
    await db.collection('organizations').doc(orgId).set(patch, { merge: true });
    // Notify affected users of a status change BEFORE responding (post-response awaits get orphaned on gen-2).
    const status = patch.deleted ? 'removed' : (patch.active === false ? 'deactivated' : (patch.active === true ? 'reactivated' : null));
    if (status) {
      const key = SENDGRID_API_KEY.value(), name = patch.name || org.name || 'Your workspace';
      if (org.personal === true) {
        const ownerUid = org.createdBy || org.isolatedFor || null;
        if (ownerUid) await mailUser(db, ownerUid, 'account', patch.deleted ? mailWorkspaceRemoved({ workspace: name }) : mailOrgCompanyStatus({ name, status }), key);
      } else {
        await mailUsers(db, await _orgMemberUids(db, orgId), 'account', mailOrgCompanyStatus({ name, status }), key);
      }
    }
    res.json({ ok: true });
  } catch (e) { logger.error('updateOrganization failed', { error: String(e) }); res.status(500).json({ error: 'update_failed' }); }
});
// Assign / remove an Org Administrator (Super Admin only). User must already have an account.
exports.assignOrgAdmin = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!isPlatformOwner(tok)) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const orgId = String((req.body && req.body.orgId) || '');
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!orgId || !email) { res.status(400).json({ error: 'bad_request' }); return; }
    const uid = await _uidByEmail(email);
    if (!uid) { res.status(404).json({ error: 'user_not_found' }); return; }
    const db = admin.firestore();
    const orgName = await _orgName(orgId);
    await db.doc('organizations/' + orgId + '/orgAdmins/' + uid).set({ email, role: 'org_admin', addedBy: tok.uid, addedAt: Date.now() }, { merge: true });
    await db.collection('users').doc(uid).set({ email, orgs: { [orgId]: { name: orgName, orgAdmin: true } } }, { merge: true });
    await mailUser(db, uid, 'account', mailAccountAction({ title: 'You’re now an Organization Administrator', message: 'You have been granted Organization Administrator access for ' + orgName + ' on Sparks Finance. You can now manage every company in this organization.' }), SENDGRID_API_KEY.value());
    res.json({ ok: true, uid });
  } catch (e) { logger.error('assignOrgAdmin failed', { error: String(e) }); res.status(500).json({ error: 'assign_failed' }); }
});
exports.removeOrgAdmin = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const tok = await verifyAuthed(req);
  if (!isPlatformOwner(tok)) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const orgId = String((req.body && req.body.orgId) || ''), uid = String((req.body && req.body.uid) || '');
    if (!orgId || !uid) { res.status(400).json({ error: 'bad_request' }); return; }
    const db = admin.firestore();
    const orgName = await _orgName(orgId);
    await db.doc('organizations/' + orgId + '/orgAdmins/' + uid).delete();
    await db.collection('users').doc(uid).set({ orgs: { [orgId]: { orgAdmin: false } } }, { merge: true });
    await mailUser(db, uid, 'account', mailAccountAction({ title: 'Your Organization Administrator access was removed', message: 'Your Organization Administrator access for ' + orgName + ' has been removed.' }), SENDGRID_API_KEY.value());
    res.json({ ok: true });
  } catch (e) { logger.error('removeOrgAdmin failed', { error: String(e) }); res.status(500).json({ error: 'remove_failed' }); }
});

// ── Org Admin + Super Admin: companies ──
exports.createCompany = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || '');
  const auth = await verifyOrgAdmin(req, orgId);
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    if (!name) { res.status(400).json({ error: 'name_required' }); return; }
    const ref = admin.firestore().collection('organizations').doc(orgId).collection('companies').doc();
    await ref.set({ name, active: true, modules: { stocks: true, loans: true }, createdBy: auth.tok.uid, createdAt: Date.now() });
    res.json({ ok: true, companyId: ref.id, name });
  } catch (e) { logger.error('createCompany failed', { error: String(e) }); res.status(500).json({ error: 'create_failed' }); }
});
exports.updateCompany = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || '');
  const auth = await verifyOrgAdmin(req, orgId);
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const companyId = String((req.body && req.body.companyId) || '');
    if (!companyId) { res.status(400).json({ error: 'companyId_required' }); return; }
    const db = admin.firestore();
    let coName = ''; try { coName = (await db.doc('organizations/' + orgId + '/companies/' + companyId).get()).get('name') || ''; } catch (e) {}
    const patch = {};
    if (req.body && typeof req.body.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 80);
    if (req.body && typeof req.body.active === 'boolean') patch.active = req.body.active;
    if (req.body && req.body.modules && typeof req.body.modules === 'object') patch.modules = { stocks: !!req.body.modules.stocks, loans: !!req.body.modules.loans };
    if (req.body && req.body.delete === true) { patch.active = false; patch.deleted = true; patch.deletedAt = Date.now(); }
    if (!Object.keys(patch).length) { res.status(400).json({ error: 'nothing_to_update' }); return; }
    await db.doc('organizations/' + orgId + '/companies/' + companyId).set(patch, { merge: true });
    const status = patch.deleted ? 'removed' : (patch.active === false ? 'deactivated' : (patch.active === true ? 'reactivated' : null));
    if (status) await mailUsers(db, await _companyMemberUids(db, orgId, companyId), 'account', mailOrgCompanyStatus({ name: patch.name || coName || 'Your company', status }), SENDGRID_API_KEY.value());
    res.json({ ok: true });
  } catch (e) { logger.error('updateCompany failed', { error: String(e) }); res.status(500).json({ error: 'update_failed' }); }
});
// List all companies in an org (org-admin/super-admin) with member counts — powers the org console + dashboard.
exports.orgListCompanies = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || (req.query && req.query.orgId) || '');
  const auth = await verifyOrgAdmin(req, orgId);
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const db = admin.firestore();
    const snap = await db.collection('organizations').doc(orgId).collection('companies').get();
    const companies = [];
    for (const d of snap.docs) {
      const c = d.data() || {};
      let memberCount = 0; try { memberCount = (await d.ref.collection('members').get()).size; } catch (e) {}
      companies.push({ companyId: d.id, name: c.name || '', active: c.active !== false, modules: c.modules || { stocks: true, loans: true }, memberCount, createdAt: c.createdAt || null });
    }
    const orgAdmins = (await db.collection('organizations').doc(orgId).collection('orgAdmins').get()).docs.map(d => ({ uid: d.id, ...d.data() }));
    res.json({ ok: true, companies, orgAdmins });
  } catch (e) { logger.error('orgListCompanies failed', { error: String(e) }); res.status(500).json({ error: 'list_failed' }); }
});

// ── Company Admin: members ──
exports.companyListMembers = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || (req.query && req.query.orgId) || '');
  const companyId = String((req.body && req.body.companyId) || (req.query && req.query.companyId) || '');
  const auth = await verifyCompanyRole(req, orgId, companyId, 'member');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const db = admin.firestore();
    const members = (await db.doc('organizations/' + orgId + '/companies/' + companyId).collection('members').get()).docs.map(d => ({ uid: d.id, ...d.data() }));
    const canManage = _coCanManage(auth);
    let orgSnap = null; try { orgSnap = await db.doc('organizations/' + orgId).get(); } catch (e) {}
    const personal = !!(orgSnap && orgSnap.exists && orgSnap.data().personal === true);
    let invites = [];
    if (canManage) { const snap = await db.collection('invites').where('orgId', '==', orgId).get(); invites = snap.docs.map(d => ({ inviteId: d.id, ...d.data() })).filter(v => v.status === 'pending' && v.companyId === companyId); }
    res.json({ ok: true, members, invites, canManage, personal, callerRole: auth.isPlatform ? 'platform' : (auth.orgAdmin ? 'org_admin' : (auth.member && auth.member.role)) });
  } catch (e) { logger.error('companyListMembers failed', { error: String(e) }); res.status(500).json({ error: 'list_failed' }); }
});
// Invite someone to a company (company admin / org-admin / super-admin). Reuses the top-level invites collection.
exports.companyInvite = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || '');
  const companyId = String((req.body && req.body.companyId) || '');
  const auth = await verifyCompanyRole(req, orgId, companyId, 'admin');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  // Personal workspaces (personal:true) are member-managed ONLY by platform super-admins — the workspace
  // owner (a company admin) and org-admins cannot add members. Everyone else invites as usual.
  try {
    const _org = await admin.firestore().doc('organizations/' + orgId).get();
    if (_org.exists && _org.data().personal === true && !auth.isPlatform) { res.status(403).json({ error: 'personal_locked' }); return; }
  } catch (e) {}
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'invalid_email' }); return; }
    // Platform super-admins (owner emails) already have full access to every org/company; never add them as members.
    if (isOwnerEmail(email)) { res.status(400).json({ error: 'owner_is_platform_admin' }); return; }
    const role = (req.body && req.body.role) === 'admin' ? 'admin' : 'member';
    const db = admin.firestore();
    const already = await db.doc('organizations/' + orgId + '/companies/' + companyId).collection('members').where('email', '==', email).limit(1).get();
    if (!already.empty) { res.status(409).json({ error: 'already_member' }); return; }
    const orgName = await _orgName(orgId), companyName = await _companyName(orgId, companyId);
    const inv = { orgId, companyId, emailLower: email, role, perms: cleanPerms((req.body && req.body.perms) || {}), status: 'pending', invitedBy: auth.tok.uid, invitedByEmail: (auth.tok.email || '').toLowerCase(), orgName, companyName, createdAt: Date.now(), expiresAt: Date.now() + 30 * 864e5 };
    const existing = await db.collection('invites').where('emailLower', '==', email).get();
    const dupe = existing.docs.find(d => { const v = d.data(); return v.orgId === orgId && v.companyId === companyId && v.status === 'pending'; });
    let inviteId;
    if (dupe) { await dupe.ref.set(inv, { merge: true }); inviteId = dupe.id; }
    else { const ref = await db.collection('invites').add(inv); inviteId = ref.id; }
    await mailTo(email, mailInvite({ orgName, companyName, role, inviterEmail: inv.invitedByEmail }), SENDGRID_API_KEY.value());
    res.json({ ok: true, inviteId, updated: !!dupe });
  } catch (e) { logger.error('companyInvite failed', { error: String(e) }); res.status(500).json({ error: 'invite_failed' }); }
});
exports.companyUpdateMember = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || ''), companyId = String((req.body && req.body.companyId) || '');
  const auth = await verifyCompanyRole(req, orgId, companyId, 'admin');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) { res.status(400).json({ error: 'uid_required' }); return; }
    const uidBody = uid;
    const db = admin.firestore();
    const memRef = db.doc('organizations/' + orgId + '/companies/' + companyId + '/members/' + uid);
    const adminsQ = db.doc('organizations/' + orgId + '/companies/' + companyId).collection('members').where('role', '==', 'admin');
    let outRole = 'member', oldRole = 'member', oldPerms = {}, newPerms = {};
    // Transaction: read member + admin set and write the new role atomically, so a concurrent demotion of
    // another admin can't leave the company with zero admins (TOCTOU).
    await db.runTransaction(async (t) => {
      const memDoc = await t.get(memRef);
      if (!memDoc.exists) throw { code: 'not_member' };
      const cur = memDoc.data();
      oldRole = cur.role; oldPerms = cur.perms || {};
      const newRole = (req.body && req.body.role) === 'admin' ? 'admin' : ((req.body && req.body.role) === 'member' ? 'member' : cur.role);
      if (cur.role === 'admin' && newRole !== 'admin') { const admins = await t.get(adminsQ); if (admins.size <= 1) throw { code: 'last_admin' }; }
      newPerms = cleanPerms((req.body && req.body.perms) || cur.perms || {});
      t.set(memRef, { email: cur.email, role: newRole, perms: newPerms, updatedAt: Date.now() }, { merge: true });
      outRole = newRole;
    });
    const companyName = await _companyName(orgId, companyId);
    await db.collection('users').doc(uidBody).set({ orgs: { [orgId]: { companies: { [companyId]: { name: companyName, role: outRole } } } } }, { merge: true });
    // Notify the member BEFORE responding. Detect ANY per-module LEVEL change (none↔read↔update↔delete),
    // not just access on/off — e.g. Full access → View only must still email the user.
    const changes = MODULE_KEYS
      .filter(m => (newPerms[m.id] || 'none') !== (oldPerms[m.id] || 'none'))
      .map(m => ({ module: m.label, level: _permLevelLabel(newPerms[m.id] || 'none') }));
    const key = SENDGRID_API_KEY.value();
    if (changes.length) await mailUser(db, uidBody, 'account', mailModuleAccess({ workspace: companyName, changes }), key);
    else if (outRole !== oldRole) await mailUser(db, uidBody, 'account', mailRoleChange({ workspace: companyName, role: outRole }), key);
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code) { res.status(e.code === 'last_admin' ? 409 : (e.code === 'not_member' ? 404 : 403)).json({ error: e.code }); return; }
    logger.error('companyUpdateMember failed', { error: String(e) }); try { res.status(500).json({ error: 'update_failed' }); } catch (_) {}
  }
});
exports.companyRemoveMember = onRequest({ region: 'us-central1', cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  const orgId = String((req.body && req.body.orgId) || ''), companyId = String((req.body && req.body.companyId) || '');
  const auth = await verifyCompanyRole(req, orgId, companyId, 'member');
  if (!auth) { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) { res.status(400).json({ error: 'uid_required' }); return; }
    const isSelf = uid === auth.tok.uid;
    if (!isSelf && !_coCanManage(auth)) { res.status(403).json({ error: 'forbidden' }); return; }
    const db = admin.firestore();
    const memRef = db.doc('organizations/' + orgId + '/companies/' + companyId + '/members/' + uid);
    const adminsQ = db.doc('organizations/' + orgId + '/companies/' + companyId).collection('members').where('role', '==', 'admin');
    let removed = false;
    // Transaction: last-admin check + delete atomically (mirrors orgRemoveMember).
    await db.runTransaction(async (t) => {
      const memDoc = await t.get(memRef);
      if (!memDoc.exists) return;
      if (memDoc.data().role === 'admin') { const admins = await t.get(adminsQ); if (admins.size <= 1) throw { code: 'last_admin' }; }
      t.delete(memRef); removed = true;
    });
    if (removed) await db.collection('users').doc(uid).set({ orgs: { [orgId]: { companies: { [companyId]: admin.firestore.FieldValue.delete() } } } }, { merge: true });
    // Notify (before responding) only when an admin removed someone else (not a self-leave).
    if (removed && !isSelf) await mailUser(db, uid, 'account', mailMemberRemoved({ workspace: await _companyName(orgId, companyId) }), SENDGRID_API_KEY.value());
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code) { res.status(e.code === 'last_admin' ? 409 : 403).json({ error: e.code }); return; }
    logger.error('companyRemoveMember failed', { error: String(e) }); try { res.status(500).json({ error: 'remove_failed' }); } catch (_) {}
  }
});
