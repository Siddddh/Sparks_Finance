/*
 * ONE-TIME migration: single-tenant (per-uid) → multi-tenant (per-org).
 *
 * For every existing user that has business data (portfolios / watchlists / alerts / loans), creates a
 * default organization owned by that user and copies their data + Storage loan files into it, then writes
 * the membership doc and users/{uid}.orgs index. Idempotent (skips users who already have an org) and
 * supports a dry run.
 *
 * Usage (from KV/functions, with Admin credentials — e.g. GOOGLE_APPLICATION_CREDENTIALS to a service
 * account key, or run in a trusted environment):
 *     node migrate_to_orgs.js            # DRY RUN (prints what it WOULD do, writes nothing)
 *     node migrate_to_orgs.js --commit   # perform the migration
 *
 * Safe to re-run: a user whose users/{uid}.orgs already has entries is skipped.
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const COMMIT = process.argv.includes('--commit');
const OWNER_EMAILS = ['sean@txsparks.com', 'ravi@txsparks.com'];
const log = (...a) => console.log((COMMIT ? '[commit] ' : '[dry-run] '), ...a);

// Copy a subcollection of docs from an old path to a new collection ref (chunked batches).
async function copyDocs(srcCollRef, dstCollRef) {
  const snap = await srcCollRef.get();
  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const chunk = snap.docs.slice(i, i + 400);
    if (COMMIT) {
      const batch = db.batch();
      chunk.forEach(d => batch.set(dstCollRef.doc(d.id), d.data()));
      await batch.commit();
    }
    n += chunk.length;
  }
  return n;
}

// Copy a Storage object to a new path, preserving its Firebase download token, and return the new
// {path, url}. Best-effort — returns null on failure so the loan doc keeps its old reference.
async function copyStorageObject(oldPath, newPath) {
  try {
    const srcFile = bucket.file(oldPath);
    const [exists] = await srcFile.exists();
    if (!exists) return null;
    if (!COMMIT) return { path: newPath, url: '(rebuilt on commit)' };
    const [meta] = await srcFile.getMetadata();
    const token = (meta.metadata && meta.metadata.firebaseStorageDownloadTokens) || null;
    const dstFile = bucket.file(newPath);
    await srcFile.copy(dstFile);
    if (token) { try { await dstFile.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } }); } catch (e) {} }
    const url = 'https://firebasestorage.googleapis.com/v0/b/' + bucket.name + '/o/' +
      encodeURIComponent(newPath) + '?alt=media' + (token ? '&token=' + token : '');
    return { path: newPath, url };
  } catch (e) { log('  ! storage copy failed', oldPath, String(e)); return null; }
}

async function migrateUser(user) {
  const uid = user.uid, email = (user.email || '').toLowerCase();
  // Idempotency: skip if the user already belongs to any org.
  const uDoc = await db.collection('users').doc(uid).get();
  if (uDoc.exists && uDoc.data().orgs && Object.keys(uDoc.data().orgs).length) { return { skipped: 'already_has_org' }; }

  // Does this user have any business data worth migrating?
  const pfSnap = await db.collection('portfolios').doc(uid).collection('list').get();
  const wlSnap = await db.collection('watchlists').doc(uid).collection('list').get();
  const alSnap = await db.collection('alerts').doc(uid).collection('list').get();
  const lnSnap = await db.collection('loans').doc(uid).collection('list').get();
  const hasData = !pfSnap.empty || !wlSnap.empty || !alSnap.empty || !lnSnap.empty;
  if (!hasData && !OWNER_EMAILS.includes(email)) { return { skipped: 'no_data' }; }

  const orgId = db.collection('organizations').doc().id;
  const orgName = (email ? email.split('@')[0] : 'My') + "'s Organization";
  const orgRef = db.collection('organizations').doc(orgId);
  log('user', email || uid, '→ org', orgId, '(' + orgName + ')');

  if (COMMIT) {
    await orgRef.set({ name: orgName, createdBy: uid, createdByEmail: email, createdAt: Date.now(), plan: 'free', migratedFrom: uid });
    await orgRef.collection('members').doc(uid).set({ email, role: 'owner', perms: { stocks: 'delete', loans: 'delete' }, joinedAt: Date.now(), invitedBy: uid });
    await db.collection('users').doc(uid).set({ email, orgs: { [orgId]: { name: orgName, role: 'owner' } }, activeOrg: orgId }, { merge: true });
  }

  // Portfolios + their holdings/transactions (holdings/{uid}/{pfId}/* → org/holdings/{pfId}/lots/*).
  let pf = 0, hold = 0, txn = 0;
  for (const pd of pfSnap.docs) {
    if (COMMIT) await orgRef.collection('portfolios').doc(pd.id).set(pd.data());
    pf++;
    hold += await copyDocs(db.collection('holdings').doc(uid).collection(pd.id), orgRef.collection('holdings').doc(pd.id).collection('lots'));
    txn += await copyDocs(db.collection('transactions').doc(uid).collection(pd.id), orgRef.collection('transactions').doc(pd.id).collection('txns'));
  }
  const wl = await copyDocs(db.collection('watchlists').doc(uid).collection('list'), orgRef.collection('watchlists'));
  const al = await copyDocs(db.collection('alerts').doc(uid).collection('list'), orgRef.collection('alerts'));

  // Loans + their Storage documents (rewrite each doc's documents[].path/url to the org path).
  let ln = 0;
  for (const ld of lnSnap.docs) {
    const data = ld.data();
    const docs = Array.isArray(data.documents) ? data.documents : [];
    const newDocs = [];
    for (const doc of docs) {
      if (doc && doc.path && doc.path.indexOf('loans/' + uid + '/') === 0) {
        const newPath = 'orgs/' + orgId + '/loans/' + ld.id + '/' + doc.path.split('/').slice(3).join('/');
        const res = await copyStorageObject(doc.path, newPath);
        newDocs.push(res ? Object.assign({}, doc, res) : doc);
      } else { newDocs.push(doc); }
    }
    if (COMMIT) await orgRef.collection('loans').doc(ld.id).set(Object.assign({}, data, docs.length ? { documents: newDocs } : {}));
    ln++;
  }

  return { orgId, portfolios: pf, holdings: hold, transactions: txn, watchlists: wl, alerts: al, loans: ln };
}

(async () => {
  log('starting migration', COMMIT ? '(COMMIT)' : '(dry run — pass --commit to write)');
  let pageToken, total = 0, migrated = 0;
  do {
    const list = await admin.auth().listUsers(1000, pageToken);
    for (const u of list.users) {
      total++;
      try { const r = await migrateUser(u); if (r.orgId) { migrated++; log('  done', JSON.stringify(r)); } else { log('  skip', (u.email || u.uid), r.skipped); } }
      catch (e) { console.error('  ERROR migrating', u.email || u.uid, String(e)); }
    }
    pageToken = list.pageToken;
  } while (pageToken);
  log('finished — users scanned:', total, 'migrated:', migrated);
  process.exit(0);
})();
