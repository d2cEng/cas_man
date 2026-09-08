// Firebase sync against this app's own project (`cas-man-ca57a`), kept separate
// from the WEB-JA-Quiz project so neither app's OAuth verification state can
// affect the other.
//
// Records live at `users/{uid}/cashman/{recordId}`, one document each.
// Firestore is the transport only: the device's IndexedDB stays the source of
// truth, and the same per-record last-write-wins merge decides what survives.
//
// The apiKey below is safe in a public repo — Firestore security rules, not
// the key, control who can read and write.

import {
  allRaw,
  classifyMissing,
  DELETION_TTL_MS,
  dropLocal,
  forgetDeletions,
  knownDeletions,
  loadSettings,
  mergeDeletions,
  mergeRecords,
  putMany,
  saveSettings,
} from './store.js';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDl0G4uIiVqotZK0l63DfSDkmHv4g2fKYs',
  authDomain: 'cas-man-ca57a.firebaseapp.com',
  projectId: 'cas-man-ca57a',
  storageBucket: 'cas-man-ca57a.firebasestorage.app',
  messagingSenderId: '302219334005',
  appId: '1:302219334005:web:f19e5ec7dd503431d3833c',
};

const SDK_VERSION = '10.14.1';
const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
const COLLECTION = 'cashman';

/** The one rule this app needs, ready to paste into the Firebase console. */
export const REQUIRED_RULE = `match /users/{uid}/${COLLECTION}/{recordId} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}`;

export const RULES_CONSOLE_URL = `https://console.firebase.google.com/project/${FIREBASE_CONFIG.projectId}/firestore/rules`;

const BATCH_LIMIT = 450; // Firestore caps a batch at 500 writes.

let sdkPromise = null;
let app = null;
let currentUser = null;
let authReady = null;
let inFlight = null;

export class SyncError extends Error {
  constructor(message, { needsConsent = false } = {}) {
    super(message);
    this.name = 'SyncError';
    this.needsConsent = needsConsent;
  }
}

/** The Firebase project is baked in, so there is nothing left to configure. */
export function isConfigured() {
  return Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}

export function isConnected() {
  return Boolean(currentUser);
}

/** Display name for the signed-in account, for the settings screen. */
export function accountLabel() {
  if (!currentUser) return '';
  return currentUser.email || currentUser.displayName || currentUser.uid;
}

const SDK_TIMEOUT_MS = 15000;

function loadScript(file) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // A blocked or stalled CDN can leave onerror pending indefinitely, which
    // would hang the sign-in button with no feedback. Always settle.
    const timer = setTimeout(() => {
      script.remove();
      reject(new SyncError(`Firebase SDK 응답이 없습니다 (${file}). 네트워크를 확인하세요.`));
    }, SDK_TIMEOUT_MS);

    const settle = (fn, error) => {
      clearTimeout(timer);
      fn(error);
    };

    script.src = SDK_BASE + file;
    script.async = true;
    script.onload = () => settle(resolve);
    script.onerror = () => {
      script.remove();
      settle(reject, new SyncError(`Firebase SDK를 불러오지 못했습니다 (${file}).`));
    };
    document.head.appendChild(script);
  });
}

/**
 * Load the compat SDK and initialise the app once. Resolves after Firebase has
 * reported the restored sign-in state, so callers never race a returning user.
 */
function ensureSdk() {
  if (sdkPromise) return sdkPromise;

  sdkPromise = (async () => {
    if (!location.protocol.startsWith('http')) {
      throw new SyncError('동기화는 http(s)에서만 동작합니다.');
    }

    // app must be loaded before the auth and firestore bundles attach to it.
    await loadScript('firebase-app-compat.js');
    await Promise.all([
      loadScript('firebase-auth-compat.js'),
      loadScript('firebase-firestore-compat.js'),
    ]);

    app = window.firebase.apps.length
      ? window.firebase.app()
      : window.firebase.initializeApp(FIREBASE_CONFIG);

    authReady = new Promise((resolve) => {
      const stop = window.firebase.auth().onAuthStateChanged((user) => {
        currentUser = user || null;
        stop();
        resolve();
      });
    });
    await authReady;
    // Keep tracking sign-outs from other tabs after the first resolution.
    window.firebase.auth().onAuthStateChanged((user) => {
      currentUser = user || null;
    });

    return app;
  })().catch((error) => {
    sdkPromise = null; // let a later attempt retry a transient CDN failure
    throw error;
  });

  return sdkPromise;
}

/** Restore a previous session without showing any UI. */
export async function restore() {
  await ensureSdk();
  return isConnected();
}

export async function signIn() {
  await ensureSdk();
  const provider = new window.firebase.auth.GoogleAuthProvider();
  try {
    const result = await window.firebase.auth().signInWithPopup(provider);
    currentUser = result.user;
  } catch (error) {
    const code = error?.code || '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      throw new SyncError('로그인이 취소되었습니다.', { needsConsent: true });
    }
    if (code === 'auth/unauthorized-domain') {
      throw new SyncError('이 주소는 Firebase 승인된 도메인이 아닙니다.', { needsConsent: true });
    }
    throw new SyncError(`로그인에 실패했습니다 (${code || error.message}).`, { needsConsent: true });
  }
  return currentUser;
}

export async function disconnect() {
  if (!app) return;
  await window.firebase.auth().signOut();
  currentUser = null;
}

function recordsCollection() {
  return window.firebase
    .firestore()
    .collection('users')
    .doc(currentUser.uid)
    .collection(COLLECTION);
}

/**
 * A deleted row's document is replaced by this stub — the record's fields are
 * gone, leaving only when it was deleted. Keeping it in the same collection
 * means the security rule never has to change for it, and the 90-day purge
 * stops the stubs accumulating.
 */
function tombstone(at) {
  return { tombstone: true, deletedAt: at };
}

/** Deletion time if this remote doc is a stub, otherwise 0. */
function tombstoneAt(doc) {
  if (doc.tombstone) return Number(doc.deletedAt) || 0;
  // An older version marked deletions with `deleted` on the full record.
  if (doc.deleted) return Number(doc.updatedAt) || 0;
  return 0;
}

function describeFirestoreError(error) {
  if (error?.code === 'permission-denied') {
    const denied = new SyncError('Firestore 보안 규칙이 막고 있습니다. 설정에서 해결 방법을 확인하세요.');
    denied.needsRules = true;
    return denied;
  }
  if (error?.code === 'unavailable') {
    return new SyncError('네트워크에 연결할 수 없습니다.');
  }
  return new SyncError(`동기화에 실패했습니다 (${error?.code || error?.message || 'unknown'}).`);
}

/**
 * Pull, merge, push. Idempotent: the merge is per record and last-write-wins,
 * so devices converge without anything arbitrating between them.
 */
export async function sync({ interactive = false } = {}) {
  if (!navigator.onLine) throw new SyncError('오프라인 상태입니다.');
  if (inFlight) return inFlight;

  inFlight = (async () => {
    await ensureSdk();
    if (!isConnected()) {
      if (!interactive) throw new SyncError('로그인이 필요합니다.', { needsConsent: true });
      await signIn();
    }

    try {
      const snapshot = await recordsCollection().get();
      const docs = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));

      // ── deletions ─────────────────────────────────────────────────────
      // Stubs among the documents are the cloud's deletion log; the rest are
      // real records. Merge both sides' logs, newest deletion per id winning.
      const remoteDeletions = {};
      const remote = [];
      for (const doc of docs) {
        const at = tombstoneAt(doc);
        if (at) remoteDeletions[doc.id] = at;
        else remote.push(doc);
      }

      const deletions = { ...knownDeletions() };
      for (const [id, at] of Object.entries(remoteDeletions)) {
        deletions[id] = Math.max(deletions[id] || 0, at);
      }

      const local = await allRaw();

      // An edit made after the deletion brings the row back, and retires the
      // log entry so it stops competing. Otherwise the deletion stands.
      const resurrected = local
        .filter((r) => deletions[r.id] && r.updatedAt > deletions[r.id])
        .map((r) => r.id);
      for (const id of resurrected) delete deletions[id];

      // Backstop for deletions whose log entry has already expired: a row
      // missing from the cloud but last touched before our previous sync was
      // deleted elsewhere; one touched since then simply has not been pushed.
      const watermark = loadSettings().lastSyncAt || 0;
      const deletedElsewhere = classifyMissing(
        local,
        docs.map((r) => r.id),
        watermark,
      ).filter((id) => !resurrected.includes(id));

      const gone = new Set([...Object.keys(deletions), ...deletedElsewhere]);
      const surviving = local.filter((r) => !gone.has(r.id));
      const { records, changed } = mergeRecords(surviving, remote, [...gone]);

      // putMany only writes, so rows the merge dropped are removed explicitly.
      const kept = new Set(records.map((r) => r.id));
      const goneLocally = local.filter((r) => !kept.has(r.id)).map((r) => r.id);
      await dropLocal(goneLocally);
      if (changed || goneLocally.length) await putMany(records);

      // ── push ──────────────────────────────────────────────────────────
      const remoteVersions = new Map(remote.map((r) => [r.id, Number(r.updatedAt) || 0]));
      const outgoing = records.filter((r) => (remoteVersions.get(r.id) ?? -1) < r.updatedAt);

      const cutoff = Date.now() - DELETION_TTL_MS;
      const writes = [];

      for (const record of outgoing) {
        const { id, deleted, ...fields } = record;
        writes.push((batch) => batch.set(recordsCollection().doc(id), fields));
      }
      // The record document is replaced by its stub, not removed, so other
      // devices can still learn when it was deleted.
      for (const [id, at] of Object.entries(deletions)) {
        if (remoteDeletions[id] !== at) {
          writes.push((b) => b.set(recordsCollection().doc(id), tombstone(at)));
        }
      }
      // A resurrected row needs no delete: its record write above lands on the
      // same document and overwrites the stub.
      // Expired stubs have done their job; both sides forget them.
      const stale = Object.entries(remoteDeletions)
        .filter(([, at]) => at <= cutoff)
        .map(([id]) => id);
      for (const id of stale) writes.push((b) => b.delete(recordsCollection().doc(id)));

      for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
        const batch = window.firebase.firestore().batch();
        for (const write of writes.slice(i, i + BATCH_LIMIT)) write(batch);
        await batch.commit();
      }

      mergeDeletions(deletions);
      forgetDeletions([...resurrected, ...stale]);

      saveSettings({ lastSyncAt: Date.now() });
      return {
        pulled: changed,
        pushed: outgoing.length,
        removed: goneLocally.length,
        deleted: Object.keys(deletions).length,
        total: records.length,
      };
    } catch (error) {
      throw error instanceof SyncError ? error : describeFirestoreError(error);
    }
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Explicit connect from the settings screen — may show the sign-in popup. */
export async function connect() {
  await ensureSdk();
  if (!isConnected()) await signIn();
  return sync({ interactive: true });
}
