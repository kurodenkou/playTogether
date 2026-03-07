/**
 * rom-store.js — PouchDB-backed ROM storage and cross-client sync
 *
 * Flow (host):
 *   1. User picks a ROM file via <input type="file">
 *   2. romStore.storeROM(file) → computes SHA-256 → stores in local IndexedDB
 *      PouchDB with the bytes as an attachment → replicates to server PouchDB
 *   3. Host sends start-game with { romId, romFilename } instead of romUrl
 *
 * Flow (guest):
 *   1. Receives game-started with { romId, romFilename }
 *   2. romStore.loadROM(romId) → checks local PouchDB → if missing, replicates
 *      from server PouchDB → returns ArrayBuffer + filename
 *   3. Adapter receives bytes directly via loadROMBytes() — no URL needed
 *
 * The server-side PouchDB endpoint lives at /api/romdb (express-pouchdb).
 * All ROM documents are stored in the 'roms' database.
 *
 * Document schema:
 *   _id:      'rom:<sha256hex>'
 *   filename: original file name (e.g. 'mario.nes')
 *   _attachments:
 *     data: { content_type: 'application/octet-stream', data: <binary> }
 */

class ROMStore {
  constructor() {
    // Local IndexedDB-backed PouchDB (persists across page reloads)
    this._local  = new PouchDB('play-together-roms');
    // Server-side CouchDB-compatible PouchDB endpoint
    this._remote = new PouchDB('/api/romdb/roms');
  }

  /**
   * Read a File from disk, store its bytes in local PouchDB, and upload
   * directly to the server so guests can download it.
   *
   * @param {File} file  The ROM file selected by the user
   * @param {function} [onProgress]  optional (message: string) => void callback
   * @returns {Promise<{romId: string, filename: string}>}
   */
  async storeROM(file, onProgress) {
    onProgress?.('Hashing ROM…');
    const bytes = await file.arrayBuffer();
    const romId = await _sha256hex(bytes);
    const docId = `rom:${romId}`;

    // Cache locally in PouchDB (skip if already stored)
    const alreadyLocal = await this._tryLoadLocal(docId);
    if (!alreadyLocal) {
      onProgress?.('Caching ROM locally…');
      await this._local.put({ _id: docId, filename: file.name });
      const doc = await this._local.get(docId);
      await this._local.putAttachment(
        docId, 'data', doc._rev,
        new Blob([bytes], { type: 'application/octet-stream' }),
        'application/octet-stream',
      );
    }

    // Upload directly to server via HTTP (reliable, no PouchDB replication quirks)
    onProgress?.('Uploading ROM to server…');
    await this._uploadDirect(romId, file.name, bytes);

    return { romId, filename: file.name };
  }

  /**
   * Load a ROM's bytes, trying local cache first then downloading from server.
   * Retries with back-off in case the host's upload is still in-flight.
   *
   * @param {string} romId       SHA-256 hex of the ROM content
   * @param {string} [filename]  fallback filename hint
   * @param {function} [onProgress]  optional (message: string) => void callback
   * @returns {Promise<{bytes: ArrayBuffer, filename: string}>}
   */
  async loadROM(romId, filename = 'rom', onProgress) {
    const docId = `rom:${romId}`;

    // Try local PouchDB cache first (host already has it; guests get it after first download)
    const local = await this._tryLoadLocal(docId);
    if (local) return local;

    // Download directly from server with retries
    const MAX_ATTEMPTS = 8;
    const RETRY_DELAY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const label = attempt === 1
        ? 'Downloading ROM from server…'
        : `Downloading ROM… (retry ${attempt - 1}/${MAX_ATTEMPTS - 1})`;
      onProgress?.(label);

      const result = await this._downloadDirect(romId);
      if (result) {
        // Cache locally so future games/rematches skip the download
        await this._cacheLocal(docId, result.filename, result.bytes);
        return result;
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    throw new Error('ROM not found on server — use the Sync button to re-upload it.');
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  async _uploadDirect(romId, filename, bytes) {
    const resp = await fetch('/api/rom', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/octet-stream',
        'x-rom-id':        romId,
        'x-rom-filename':  filename,
      },
      body: bytes,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.status);
      throw new Error(`ROM upload failed: ${text}`);
    }
  }

  async _downloadDirect(romId) {
    const resp = await fetch(`/api/rom/${encodeURIComponent(romId)}`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`ROM download failed: ${resp.status}`);
    const bytes    = await resp.arrayBuffer();
    const filename = resp.headers.get('x-rom-filename') ?? 'rom';
    return { bytes, filename };
  }

  async _cacheLocal(docId, filename, bytes) {
    try {
      await this._local.put({ _id: docId, filename });
      const doc = await this._local.get(docId);
      await this._local.putAttachment(
        docId, 'data', doc._rev,
        new Blob([bytes], { type: 'application/octet-stream' }),
        'application/octet-stream',
      );
    } catch (e) {
      // Already cached (conflict) — ignore
      if (e.status !== 409) console.warn('[rom-store] cache write failed', e);
    }
  }

  async _tryLoadLocal(docId) {
    try {
      const doc  = await this._local.get(docId);
      const blob = await this._local.getAttachment(docId, 'data');
      return { bytes: await blob.arrayBuffer(), filename: doc.filename ?? 'rom' };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
}

/**
 * Compute SHA-256 of an ArrayBuffer and return as a lowercase hex string.
 * Uses the Web Crypto API (available in all modern browsers).
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function _sha256hex(buffer) {
  const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Singleton used by app.js
const romStore = new ROMStore();
