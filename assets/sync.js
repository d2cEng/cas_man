// Google Drive sync against the caller's own appDataFolder.
//
// There is no backend: the browser talks to Drive directly with a token from
// Google Identity Services, and the whole ledger lives in one JSON file inside
// the hidden per-app folder. That keeps the app deployable as plain static
// files on any host, and keeps the data in the user's own account.

import { allRaw, mergeRecords, putMany, loadSettings, saveSettings } from './store.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'cas_man.v1.json';
const FILES_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

let gisPromise = null;
let tokenClient = null;
let tokenClientId = '';
let accessToken = '';
let tokenExpiresAt = 0;
let cachedFileId = '';
let inFlight = null;

export class SyncError extends Error {
  constructor(message, { needsConsent = false } = {}) {
    super(message);
    this.name = 'SyncError';
    this.needsConsent = needsConsent;
  }
}

export function isConfigured() {
  return Boolean(loadSettings().clientId.trim());
}

export function isConnected() {
  return Boolean(accessToken) && Date.now() < tokenExpiresAt;
}

/** Drop the in-memory token; the Drive file itself is left untouched. */
export function disconnect() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = '';
  tokenExpiresAt = 0;
  cachedFileId = '';
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisPromise = null;
      reject(new SyncError('구글 로그인 스크립트를 불러오지 못했습니다. 네트워크를 확인하세요.'));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

/**
 * Get a usable access token.
 * `interactive` decides whether we may show Google's consent popup — popups are
 * blocked unless they originate from a user gesture, so background syncs pass
 * false and simply fail over to "needs consent".
 */
async function getToken({ interactive }) {
  if (isConnected()) return accessToken;

  const clientId = loadSettings().clientId.trim();
  if (!clientId) throw new SyncError('OAuth 클라이언트 ID가 설정되지 않았습니다.');

  await loadGis();

  if (!tokenClient || tokenClientId !== clientId) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {}, // replaced per request below
    });
    tokenClientId = clientId;
  }

  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(
          new SyncError(
            response.error === 'access_denied'
              ? '구글 계정 접근이 거부되었습니다.'
              : `인증에 실패했습니다 (${response.error}).`,
            { needsConsent: true },
          ),
        );
        return;
      }
      accessToken = response.access_token;
      // Renew a minute early so a long sync can't run past the expiry.
      tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60_000;
      resolve(accessToken);
    };
    tokenClient.error_callback = (error) => {
      reject(new SyncError(`인증 창을 열지 못했습니다 (${error?.type || 'unknown'}).`, {
        needsConsent: true,
      }));
    };
    try {
      // '' asks for a silent grant when the user has already consented.
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (error) {
      reject(new SyncError(String(error?.message || error), { needsConsent: true }));
    }
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
  if (response.status === 401 || response.status === 403) {
    accessToken = '';
    tokenExpiresAt = 0;
    throw new SyncError('구글 인증이 만료되었습니다. 다시 연결해 주세요.', { needsConsent: true });
  }
  if (!response.ok) {
    throw new SyncError(`드라이브 요청 실패 (${response.status})`);
  }
  return response;
}

async function findFileId() {
  if (cachedFileId) return cachedFileId;
  const query = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${FILE_NAME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: '1',
  });
  const response = await api(`${FILES_API}?${query}`);
  const { files = [] } = await response.json();
  cachedFileId = files[0]?.id || '';
  return cachedFileId;
}

async function downloadRemote() {
  const fileId = await findFileId();
  if (!fileId) return [];
  const response = await api(`${FILES_API}/${fileId}?alt=media`);
  const payload = await response.json().catch(() => null);
  if (!payload || !Array.isArray(payload.records)) return [];
  return payload.records;
}

async function uploadRemote(records) {
  const body = JSON.stringify({
    app: 'cas_man',
    version: 1,
    updatedAt: Date.now(),
    records,
  });
  const fileId = await findFileId();

  if (fileId) {
    await api(`${UPLOAD_API}/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return;
  }

  const boundary = `cas_man_${Math.random().toString(36).slice(2)}`;
  const metadata = { name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' };
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${body}\r\n--${boundary}--`;

  const response = await api(`${UPLOAD_API}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  cachedFileId = (await response.json()).id || '';
}

/**
 * Pull, merge, push. Safe to call repeatedly: the merge is per-record and
 * last-write-wins, so two devices converge without a server arbitrating.
 */
export async function sync({ interactive = false } = {}) {
  if (!isConfigured()) throw new SyncError('OAuth 클라이언트 ID가 설정되지 않았습니다.');
  if (!navigator.onLine) throw new SyncError('오프라인 상태입니다.');
  if (inFlight) return inFlight;

  inFlight = (async () => {
    await getToken({ interactive });

    const remote = await downloadRemote();
    const local = await allRaw();
    const { records, changed } = mergeRecords(local, remote);

    if (changed) await putMany(records);

    // Push whenever the local side holds anything the remote copy lacks.
    const remoteIds = new Map(remote.map((r) => [r.id, Number(r.updatedAt) || 0]));
    const needsPush = records.some((r) => (remoteIds.get(r.id) ?? -1) < r.updatedAt);
    if (needsPush || !remote.length) await uploadRemote(records);

    saveSettings({ lastSyncAt: Date.now() });
    return { pulled: changed, pushed: needsPush, total: records.length };
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Explicit connect from the settings screen — always allowed to show consent. */
export async function connect() {
  await getToken({ interactive: true });
  return sync({ interactive: true });
}
