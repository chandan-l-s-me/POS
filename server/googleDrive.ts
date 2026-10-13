import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/**
 * Backups to the owner's Google Drive.
 *
 * The owner connects once from Settings (OAuth, as themselves). The app asks
 * only for `drive.file`: it can create files and see or delete the files it
 * created, and nothing else in the Drive. Every backup — the daily automatic
 * one and Backup Now — is gzipped and uploaded into a "Vyapara Billing
 * Backups" folder, and automatic ones past BACKUP_KEEP_DAYS are deleted there
 * as they are locally.
 *
 * The Google refresh token lives in a file beside the database
 * (google-drive.json, 0600), not in the database itself, so a backup file
 * never carries the key to the Drive it is uploaded to.
 *
 * Plain fetch against Google's REST endpoints rather than the googleapis
 * package, which is tens of megabytes for four calls. The endpoints can be
 * pointed elsewhere (GOOGLE_OAUTH_BASE, GOOGLE_API_BASE) so the tests can run
 * against a stand-in.
 */

const OAUTH_BASE = () => process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com';
const AUTH_URL = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const API_BASE = () => process.env.GOOGLE_API_BASE || 'https://www.googleapis.com';

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
const FOLDER_NAME = 'Vyapara Billing Backups';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveState {
  refresh_token: string;
  email: string | null;
  connected_at: string;
  folder_id?: string | null;
  last_upload_at?: string | null;
  last_upload_file?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
}

export const createGoogleDrive = (options: { stateFile: string; publicUrl: string | null }) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
    || (options.publicUrl ? `${options.publicUrl.replace(/\/$/, '')}/api/backups/google/callback` : null);

  const configured = Boolean(clientId && clientSecret && redirectUri);

  // --- Stored connection ------------------------------------------------------

  const readState = (): DriveState | null => {
    try {
      const state = JSON.parse(fs.readFileSync(options.stateFile, 'utf8'));
      return state?.refresh_token ? state : null;
    } catch {
      return null;
    }
  };

  const writeState = (state: DriveState | null) => {
    if (!state) {
      fs.rmSync(options.stateFile, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(options.stateFile), { recursive: true });
    const temp = `${options.stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, options.stateFile);
  };

  const updateState = (changes: Partial<DriveState>) => {
    const state = readState();
    if (state) writeState({ ...state, ...changes });
  };

  // --- Connecting -------------------------------------------------------------

  // One-time `state` values for the sign-in round trip, so the callback only
  // accepts a sign-in an admin started here, within ten minutes.
  const pending = new Map<string, number>();
  const STATE_TTL_MS = 10 * 60 * 1000;

  const authorizationUrl = () => {
    if (!configured) throw new Error('Google Drive is not set up on the server (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL).');
    const now = Date.now();
    for (const [key, at] of pending) if (now - at > STATE_TTL_MS) pending.delete(key);
    const state = crypto.randomBytes(24).toString('base64url');
    pending.set(state, now);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri!,
      response_type: 'code',
      scope: SCOPES.join(' '),
      // offline + consent: Google returns a refresh token, so backups keep
      // working without anyone signing in again.
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH_URL()}?${params}`;
  };

  const takeState = (state: string) => {
    const at = pending.get(state);
    pending.delete(state);
    return at !== undefined && Date.now() - at <= STATE_TTL_MS;
  };

  const emailFromIdToken = (idToken: string | undefined) => {
    try {
      const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
      return typeof payload.email === 'string' ? payload.email : null;
    } catch {
      return null;
    }
  };

  /** Finish connecting: swap the code Google sent back for a refresh token. */
  const completeConnection = async (code: string, state: string) => {
    if (!takeState(state)) throw new Error('This Google sign-in link has expired. Start again from Settings.');
    const res = await fetch(`${OAUTH_BASE()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri!, grant_type: 'authorization_code',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.refresh_token) {
      throw new Error(body.error_description || body.error || 'Google did not grant access.');
    }
    writeState({
      refresh_token: body.refresh_token,
      email: emailFromIdToken(body.id_token),
      connected_at: new Date().toISOString(),
      folder_id: null,
    });
    cachedToken = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
    return readState()!;
  };

  const disconnect = async () => {
    const state = readState();
    writeState(null);
    cachedToken = null;
    if (state) {
      // Revoke at Google too; if that fails the token is gone from here anyway.
      await fetch(`${OAUTH_BASE()}/revoke?token=${encodeURIComponent(state.refresh_token)}`, { method: 'POST' }).catch(() => undefined);
    }
  };

  // --- Talking to Drive -------------------------------------------------------

  let cachedToken: { token: string; expiresAt: number } | null = null;

  const accessToken = async () => {
    if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;
    const state = readState();
    if (!state) throw new Error('Google Drive is not connected.');
    const res = await fetch(`${OAUTH_BASE()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: state.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant') {
        throw new Error('Google Drive access was withdrawn or has expired. Connect Google Drive again in Settings.');
      }
      throw new Error(body.error_description || body.error || `Google sign-in failed (${res.status})`);
    }
    cachedToken = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
    return cachedToken.token;
  };

  const drive = async (method: string, url: string, init: { body?: any; headers?: Record<string, string> } = {}) => {
    const res = await fetch(`${API_BASE()}${url}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...init.headers },
      body: init.body,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body?.error?.message || `Google Drive request failed (${res.status})`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    return res;
  };

  /** The backup folder, created on first use (and again if the owner deleted it). */
  const folderId = async () => {
    const state = readState();
    if (state?.folder_id) {
      try {
        const res = await drive('GET', `/drive/v3/files/${state.folder_id}?fields=id,trashed`);
        const folder = await res.json();
        if (!folder.trashed) return state.folder_id;
      } catch (err: any) {
        if (err.status !== 404) throw err;
      }
    }
    const res = await drive('POST', '/drive/v3/files?fields=id', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    const { id } = await res.json();
    updateState({ folder_id: id });
    return id as string;
  };

  /** Gzip a backup file and upload it to the backup folder. */
  const uploadBackup = async (filePath: string) => {
    try {
      const parent = await folderId();
      const name = `${path.basename(filePath)}.gz`;
      const data = zlib.gzipSync(fs.readFileSync(filePath), { level: 9 });
      // Resumable upload: one request for the metadata, one for the bytes.
      const start = await drive('POST', '/upload/drive/v3/files?uploadType=resumable&fields=id', {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/gzip',
          'X-Upload-Content-Length': String(data.length),
        },
        body: JSON.stringify({ name, parents: [parent], mimeType: 'application/gzip' }),
      });
      const location = start.headers.get('location');
      if (!location) throw new Error('Google Drive did not accept the upload.');
      const put = await fetch(location, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(data.length) },
        body: data,
      });
      if (!put.ok) throw new Error(`Google Drive upload failed (${put.status})`);
      updateState({ last_upload_at: new Date().toISOString(), last_upload_file: name, last_error: null, last_error_at: null });
      return { name, bytes: data.length };
    } catch (err: any) {
      updateState({ last_error: err.message || 'Upload failed', last_error_at: new Date().toISOString() });
      throw err;
    }
  };

  /** Delete automatic backups in the Drive folder older than `keepDays`. Manual ones stay. */
  const pruneBackups = async (keepDays: number, autoPrefix: string) => {
    const parent = await folderId();
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    const q = `'${parent}' in parents and trashed = false and name contains '${autoPrefix}' and createdTime < '${cutoff}'`;
    const res = await drive('GET', `/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100`);
    const { files = [] } = await res.json();
    for (const file of files) {
      if (!String(file.name).startsWith(autoPrefix)) continue;
      await drive('DELETE', `/drive/v3/files/${file.id}`).catch(() => undefined);
    }
    return files.length as number;
  };

  const status = () => {
    const state = readState();
    return {
      configured,
      connected: Boolean(state),
      email: state?.email ?? null,
      connected_at: state?.connected_at ?? null,
      folder_name: FOLDER_NAME,
      last_upload_at: state?.last_upload_at ?? null,
      last_upload_file: state?.last_upload_file ?? null,
      last_error: state?.last_error ?? null,
      last_error_at: state?.last_error_at ?? null,
      redirect_uri: redirectUri,
    };
  };

  return {
    configured,
    isConnected: () => Boolean(readState()),
    authorizationUrl,
    completeConnection,
    disconnect,
    uploadBackup,
    pruneBackups,
    status,
  };
};
