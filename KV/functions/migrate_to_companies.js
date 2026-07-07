/*
 * ONE-TIME migration v2: move existing per-uid business data into the Company tier, under a single
 * org "Test_Org" → company "Test Company" (as requested). Copies portfolios/holdings/transactions/
 * watchlists/alerts/loans + Storage loan files into organizations/{TestOrg}/companies/{TestCompany}/…,
 * and makes each migrated user a member of Test Company. Idempotent + dry-run.
 *
 * Usage (from KV/functions, with Admin credentials):
 *     node migrate_to_companies.js                         # DRY RUN (writes nothing)
 *     node migrate_to_companies.js --commit                # perform the migration
 *     node migrate_to_companies.js --key="C:\path\sa.json" # explicit service-account key (else GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC)
 *
 * Isolation (give specific users their OWN workspace instead of the shared Test Company):
 *     --isolate=a@x.com,b@x.com   # these users each get their own org+company (isolated)
 *     --isolate-all               # every user gets their own isolated workspace
 *     --isolate-role=member|admin # role in the isolated workspace (default: member → super-admin controls their module access)
 *     --isolate-perms=data|none|full  # seed module access: data=only modules they had (default), none=super-admin grants later, full=both
 *     --provision-empty           # also give a workspace to users with NO legacy data (default: skip them)
 *   Isolated workspaces are flagged personal:true + createdBy:<uid>, so the user's later "Continue solo" reuses it.
 *   Personal-workspace membership is locked to platform super-admins (the companyInvite CF rejects others).
 *   For a test setup where every existing account gets a ready-to-use isolated workspace:
 *     node migrate_to_companies.js --key="…" --isolate-all --provision-empty --isolate-perms=full --commit
 *
 * Safe to re-run: shared Test_Org/Test Company found by marker tag; isolated orgs found by (migrationTag, isolatedFor);
 * users already a member of the destination company are skipped.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Storage bucket resolution: --bucket=<name> arg → FIREBASE_STORAGE_BUCKET / STORAGE_BUCKET env → project default.
// Running the Admin SDK outside Cloud Functions does not auto-populate the default bucket, so it must be supplied.
const _bucketArg = (process.argv.find(a => a.startsWith('--bucket=')) || '').split('=')[1];
const STORAGE_BUCKET = _bucketArg || process.env.FIREBASE_STORAGE_BUCKET || process.env.STORAGE_BUCKET || 'claude-apps-a6fe1.firebasestorage.app';
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'claude-apps-a6fe1';

// Credential resolution: --key=<path> arg → GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT env → gcloud ADC.
// A service-account key path that doesn't exist gets a clear, actionable message (not a raw stack trace).
function _credHelp(badPath) {
  console.error('\n[migrate] ✗ Service-account key not found at: ' + badPath);
  console.error('[migrate]   Provide real Admin credentials one of these ways:');
  console.error('[migrate]   1) Pass the key path explicitly:');
  console.error('[migrate]        node functions/migrate_to_companies.js --key="C:\\\\full\\\\path\\\\serviceAccount.json"');
  console.error('[migrate]   2) Or point the env var at a real file (PowerShell):');
  console.error('[migrate]        $env:GOOGLE_APPLICATION_CREDENTIALS="C:\\\\full\\\\path\\\\serviceAccount.json"');
  console.error('[migrate]   3) Or use gcloud ADC (no key file):');
  console.error('[migrate]        gcloud auth application-default login   # then clear GOOGLE_APPLICATION_CREDENTIALS');
  console.error('[migrate]   Download a key: Firebase Console → Project settings → Service accounts → Generate new private key.\n');
}
function resolveCredential() {
  const keyArg = (process.argv.find(a => a.startsWith('--key=')) || '').split('=').slice(1).join('=');
  const keyPath = keyArg || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath) {
    const abs = path.resolve(keyPath.replace(/^["']|["']$/g, ''));
    if (!fs.existsSync(abs)) { _credHelp(abs); process.exit(1); }
    // Clear the (possibly bad) env var so the SDK uses the cert we validated, not the env path.
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    return admin.credential.cert(require(abs));
  }
  return admin.credential.applicationDefault();   // gcloud ADC / metadata server
}
if (!admin.apps.length) admin.initializeApp({ credential: resolveCredential(), projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET });
const db = admin.firestore();
// Lazy bucket handle — only resolved when actually copying loan files, so a bucket misconfig
// never blocks the (much larger) Firestore portion of the migration.
let _bucket = null;
function getBucket() { if (!_bucket) _bucket = admin.storage().bucket(); return _bucket; }

const COMMIT = process.argv.includes('--commit');
const OWNER_EMAILS = ['sean@txsparks.com', 'ravi@txsparks.com'];
const ORG_TAG = 'test_org_v2';
const ISOLATE_TAG = 'isolated_v1';
const log = (...a) => console.log((COMMIT ? '[commit] ' : '[dry-run] '), ...a);

// ── Isolation options ──────────────────────────────────────────────────────
// By default every user is consolidated into the shared Test_Org/Test Company. Pass
// --isolate=<comma,emails> (or --isolate-all) to give specific users their OWN isolated
// org+company instead. Isolated users are added as MEMBERS (not admins), so only a
// super-admin/org-admin can grant or change their module access (they can't self-escalate).
//   --isolate-role=member|admin   (default member — super-admin controls module access)
//   --isolate-perms=data|none|full(default data — seed access for the modules they had data in)
function _argVal(flag) { const a = process.argv.find(x => x.startsWith(flag + '=')); return a ? a.split('=').slice(1).join('=') : null; }
const ISOLATE_ALL = process.argv.includes('--isolate-all');
const ISOLATE_EMAILS = new Set((_argVal('--isolate') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const ISOLATE_ROLE = (_argVal('--isolate-role') === 'admin') ? 'admin' : 'member';
const _ip = _argVal('--isolate-perms');
const ISOLATE_PERMS = (_ip === 'none' || _ip === 'full') ? _ip : 'data';
// Provision a workspace even for users with NO legacy data (default: skip them). Useful for test setups
// where every existing account should get its own ready-to-use workspace.
const PROVISION_EMPTY = process.argv.includes('--provision-empty');

async function copyDocs(srcCollRef, dstCollRef) {
  const snap = await srcCollRef.get();
  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const chunk = snap.docs.slice(i, i + 400);
    if (COMMIT) { const batch = db.batch(); chunk.forEach(d => batch.set(dstCollRef.doc(d.id), d.data())); await batch.commit(); }
    n += chunk.length;
  }
  return n;
}
// Consolidating multiple users into ONE shared company: namespace flat collections (watchlists/alerts)
// by uid so distinct users' docs can't silently overwrite each other on an id collision. Stamps ownerUid.
async function copyDocsNamespaced(srcCollRef, dstCollRef, uid) {
  const snap = await srcCollRef.get();
  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const chunk = snap.docs.slice(i, i + 400);
    if (COMMIT) { const batch = db.batch(); chunk.forEach(d => batch.set(dstCollRef.doc(uid + '__' + d.id), Object.assign({ ownerUid: uid }, d.data()))); await batch.commit(); }
    n += chunk.length;
  }
  return n;
}
async function copyStorageObject(oldPath, newPath) {
  try {
    const bucket = getBucket();
    const srcFile = bucket.file(oldPath);
    const [exists] = await srcFile.exists();
    if (!exists) return null;
    if (!COMMIT) return { path: newPath, url: '(rebuilt on commit)' };
    const [meta] = await srcFile.getMetadata();
    const token = (meta.metadata && meta.metadata.firebaseStorageDownloadTokens) || null;
    const dstFile = bucket.file(newPath);
    await srcFile.copy(dstFile);
    if (token) { try { await dstFile.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } }); } catch (e) {} }
    const url = 'https://firebasestorage.googleapis.com/v0/b/' + bucket.name + '/o/' + encodeURIComponent(newPath) + '?alt=media' + (token ? '&token=' + token : '');
    return { path: newPath, url };
  } catch (e) { log('  ! storage copy failed', oldPath, String(e)); return null; }
}

// Find-or-create the single Test_Org + Test Company (idempotent via the marker tag).
async function ensureTestOrgCompany() {
  const q = await db.collection('organizations').where('migrationTag', '==', ORG_TAG).limit(1).get();
  let orgRef;
  if (!q.empty) { orgRef = q.docs[0].ref; }
  else {
    orgRef = db.collection('organizations').doc();
    if (COMMIT) await orgRef.set({ name: 'Test_Org', industry: '', active: true, personal: false, migrationTag: ORG_TAG, createdByEmail: OWNER_EMAILS[0], createdAt: Date.now(), plan: 'free' });
  }
  let coSnap = await orgRef.collection('companies').where('migrationTag', '==', ORG_TAG).limit(1).get();
  let coRef;
  if (!coSnap.empty) { coRef = coSnap.docs[0].ref; }
  else {
    coRef = orgRef.collection('companies').doc();
    if (COMMIT) await coRef.set({ name: 'Test Company', active: true, modules: { stocks: true, loans: true }, migrationTag: ORG_TAG, createdAt: Date.now() });
  }
  log('Test_Org →', orgRef.id, '· Test Company →', coRef.id);
  return { orgId: orgRef.id, companyId: coRef.id, orgRef, coRef };
}

// Read a user's per-uid data snapshots once (used for both the has-data gate and the copy).
async function readUserData(uid) {
  const [pfSnap, wlSnap, alSnap, lnSnap] = await Promise.all([
    db.collection('portfolios').doc(uid).collection('list').get(),
    db.collection('watchlists').doc(uid).collection('list').get(),
    db.collection('alerts').doc(uid).collection('list').get(),
    db.collection('loans').doc(uid).collection('list').get(),
  ]);
  return {
    pfSnap, wlSnap, alSnap, lnSnap,
    hadStocks: !pfSnap.empty || !wlSnap.empty || !alSnap.empty,   // Trading module
    hadLoans: !lnSnap.empty,                                       // Loans & Notes module
  };
}

// Copy a user's per-uid business data into a destination company (portfolios/holdings/txns nested;
// watchlists/alerts namespaced by uid; loans + their Storage files re-pathed). Returns counts.
async function copyUserDataInto(uid, orgId, companyId, coRef, snaps) {
  const { pfSnap, lnSnap } = snaps;
  let pf = 0, hold = 0, txn = 0;
  for (const pd of pfSnap.docs) {
    if (COMMIT) await coRef.collection('portfolios').doc(pd.id).set(pd.data());
    pf++;
    hold += await copyDocs(db.collection('holdings').doc(uid).collection(pd.id), coRef.collection('holdings').doc(pd.id).collection('lots'));
    txn += await copyDocs(db.collection('transactions').doc(uid).collection(pd.id), coRef.collection('transactions').doc(pd.id).collection('txns'));
  }
  const wl = await copyDocsNamespaced(db.collection('watchlists').doc(uid).collection('list'), coRef.collection('watchlists'), uid);
  const al = await copyDocsNamespaced(db.collection('alerts').doc(uid).collection('list'), coRef.collection('alerts'), uid);

  let ln = 0;
  for (const ld of lnSnap.docs) {
    const data = ld.data();
    const docs = Array.isArray(data.documents) ? data.documents : [];
    const newDocs = [];
    for (const doc of docs) {
      if (doc && doc.path && doc.path.indexOf('loans/' + uid + '/') === 0) {
        const newPath = 'orgs/' + orgId + '/companies/' + companyId + '/loans/' + ld.id + '/' + doc.path.split('/').slice(3).join('/');
        const res = await copyStorageObject(doc.path, newPath);
        newDocs.push(res ? Object.assign({}, doc, res) : doc);
      } else { newDocs.push(doc); }
    }
    if (COMMIT) await coRef.collection('loans').doc(ld.id).set(Object.assign({}, data, docs.length ? { documents: newDocs } : {}));
    ln++;
  }
  return { portfolios: pf, holdings: hold, transactions: txn, watchlists: wl, alerts: al, loans: ln };
}

// Shared path: consolidate the user into Test_Org → Test Company as a company admin.
async function migrateUser(user, ctx) {
  const uid = user.uid, email = (user.email || '').toLowerCase();
  const { orgId, companyId, coRef } = ctx;
  const memDoc = await coRef.collection('members').doc(uid).get();       // idempotency
  if (memDoc.exists) return { skipped: 'already_member' };

  const snaps = await readUserData(uid);
  if (!snaps.hadStocks && !snaps.hadLoans && !OWNER_EMAILS.includes(email) && !PROVISION_EMPTY) return { skipped: 'no_data' };

  const role = 'admin';   // migrated data owners become company admins of the shared Test Company
  log('user', email || uid, '→ Test Company', companyId, 'as', role);
  if (COMMIT) {
    await coRef.collection('members').doc(uid).set({ email, role, perms: { stocks: 'delete', loans: 'delete' }, joinedAt: Date.now() });
    await db.collection('users').doc(uid).set({ email, orgs: { [orgId]: { name: 'Test_Org', personal: false, companies: { [companyId]: { name: 'Test Company', role } } } }, activeOrg: orgId, activeCompany: companyId }, { merge: true });
  }
  return await copyUserDataInto(uid, orgId, companyId, coRef, snaps);
}

// Find-or-create a per-user isolated workspace (own org + company). Flagged personal:true +
// createdBy:uid so the user's later "Continue solo" reuses THIS workspace (with their data),
// not an empty one. Idempotent via migrationTag + isolatedFor.
async function ensureIsolatedOrgCompany(uid, email) {
  const orgName = (email ? email.split('@')[0] : ('user-' + uid.slice(0, 6))) + ' (Personal)';
  let orgRef;
  const q = await db.collection('organizations').where('migrationTag', '==', ISOLATE_TAG).where('isolatedFor', '==', uid).limit(1).get();
  if (!q.empty) orgRef = q.docs[0].ref;
  else {
    orgRef = db.collection('organizations').doc();
    if (COMMIT) await orgRef.set({ name: orgName, industry: '', active: true, personal: true, isolatedFor: uid, migrationTag: ISOLATE_TAG, createdBy: uid, createdByEmail: email || '', createdAt: Date.now(), plan: 'free' });
  }
  let coSnap = await orgRef.collection('companies').where('migrationTag', '==', ISOLATE_TAG).limit(1).get();
  let coRef;
  if (!coSnap.empty) coRef = coSnap.docs[0].ref;
  else {
    coRef = orgRef.collection('companies').doc();
    if (COMMIT) await coRef.set({ name: 'Personal', active: true, modules: { stocks: true, loans: true }, migrationTag: ISOLATE_TAG, createdBy: uid, createdAt: Date.now() });
  }
  // CRITICAL: ensurePersonalOrg (the "open personal workspace" path) returns companyId = org.defaultCompany,
  // so the org MUST point at its company or the client gets a null companyId and can't open the workspace.
  if (COMMIT) await orgRef.set({ defaultCompany: coRef.id }, { merge: true });
  return { orgId: orgRef.id, companyId: coRef.id, orgRef, coRef, orgName };
}

// Isolated path: give the user their OWN org+company. They join as a MEMBER (super-admin controls
// their module access); perms are seeded per --isolate-perms and can be changed later in the console.
async function migrateUserIsolated(user) {
  const uid = user.uid, email = (user.email || '').toLowerCase();
  const snaps = await readUserData(uid);
  if (!snaps.hadStocks && !snaps.hadLoans && !OWNER_EMAILS.includes(email) && !PROVISION_EMPTY) return { skipped: 'no_data' };

  const { orgId, companyId, coRef, orgName } = await ensureIsolatedOrgCompany(uid, email);
  const memDoc = await coRef.collection('members').doc(uid).get();       // idempotency
  if (memDoc.exists) return { skipped: 'already_member' };

  const perms = ISOLATE_PERMS === 'full' ? { stocks: 'delete', loans: 'delete' }
    : ISOLATE_PERMS === 'none' ? { stocks: 'none', loans: 'none' }
    : { stocks: snaps.hadStocks ? 'delete' : 'none', loans: snaps.hadLoans ? 'delete' : 'none' };   // 'data'
  log('user', email || uid, '→ ISOLATED', orgName, '(' + companyId + ') as', ISOLATE_ROLE, '· perms', JSON.stringify(perms));
  if (COMMIT) {
    await coRef.collection('members').doc(uid).set({ email, role: ISOLATE_ROLE, perms, joinedAt: Date.now() });
    await db.collection('users').doc(uid).set({ email, orgs: { [orgId]: { name: orgName, personal: true, companies: { [companyId]: { name: 'Personal', role: ISOLATE_ROLE } } } }, activeOrg: orgId, activeCompany: companyId }, { merge: true });
  }
  return Object.assign({ isolated: true, orgId, role: ISOLATE_ROLE, perms }, await copyUserDataInto(uid, orgId, companyId, coRef, snaps));
}

(async () => {
  log('starting company-tier migration', COMMIT ? '(COMMIT)' : '(dry run — pass --commit to write)');
  if (ISOLATE_ALL) log('mode: ISOLATE-ALL — every user gets their own isolated workspace (role ' + ISOLATE_ROLE + ', perms ' + ISOLATE_PERMS + ')');
  else if (ISOLATE_EMAILS.size) log('mode: isolating ' + ISOLATE_EMAILS.size + ' user(s) [' + [...ISOLATE_EMAILS].join(', ') + '] (role ' + ISOLATE_ROLE + ', perms ' + ISOLATE_PERMS + ') — everyone else → shared Test Company');
  else log('mode: all users → shared Test Company (pass --isolate=<emails> or --isolate-all to isolate specific users)');

  // Only spin up the shared Test_Org/Test Company when at least one user actually needs it.
  let _shared = null;
  async function sharedCtx() { if (!_shared) _shared = await ensureTestOrgCompany(); return _shared; }

  let pageToken, total = 0, migrated = 0, isolated = 0;
  do {
    const list = await admin.auth().listUsers(1000, pageToken);
    for (const u of list.users) {
      total++;
      const email = (u.email || '').toLowerCase();
      const doIsolate = ISOLATE_ALL || ISOLATE_EMAILS.has(email);
      try {
        const r = doIsolate ? await migrateUserIsolated(u) : await migrateUser(u, await sharedCtx());
        if (!r.skipped) { migrated++; if (r.isolated) isolated++; log('  done', (u.email || u.uid), JSON.stringify(r)); }
        else { log('  skip', (u.email || u.uid), r.skipped); }
      } catch (e) { console.error('  ERROR migrating', u.email || u.uid, String(e)); }
    }
    pageToken = list.pageToken;
  } while (pageToken);
  log('finished — users scanned:', total, '· migrated:', migrated, '(isolated: ' + isolated + ', shared: ' + (migrated - isolated) + ')');
  process.exit(0);
})();
