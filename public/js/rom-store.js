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
   * Read a File from disk, store its bytes in local PouchDB, and replicate
   * to the server so other clients in the room can fetch it.
   *
   * @param {File} file  The ROM file selected by the user
   * @returns {Promise<{romId: string, filename: string}>}
   */
  async storeROM(file) {
    const bytes  = await file.arrayBuffer();
    const romId  = await _sha256hex(bytes);
    const docId  = `rom:${romId}`;

    // Check whether we already have this exact ROM locally (fast path)
    let existingDoc = null;
    try {
      existingDoc = await this._local.get(docId, { attachments: false });
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    if (existingDoc) {
      // ROM is already in local PouchDB; just make sure the server has it too
      await this._replicateTo();
      return { romId, filename: file.name };
    }

    // Store metadata doc
    await this._local.put({ _id: docId, filename: file.name });
    const doc = await this._local.get(docId);

    // Store ROM bytes as an attachment
    await this._local.putAttachment(
      docId, 'data', doc._rev,
      new Blob([bytes], { type: 'application/octet-stream' }),
      'application/octet-stream',
    );

    // Replicate to server so guests can pull it
    await this._replicateTo();

    return { romId, filename: file.name };
  }

  /**
   * Load a ROM's bytes from local PouchDB, replicating from the server first
   * if the document is not present locally.
   *
   * @param {string} romId     SHA-256 hex of the ROM content
   * @param {string} [filename] fallback filename if not stored in PouchDB
   * @returns {Promise<{bytes: ArrayBuffer, filename: string}>}
   */
  async loadROM(romId, filename = 'rom') {
    const docId = `rom:${romId}`;

    // Try local first
    const local = await this._tryLoadLocal(docId);
    if (local) return local;

    // Not local — replicate the specific doc from the server
    await this._replicateFrom(docId);

    const result = await this._tryLoadLocal(docId);
    if (!result) {
      throw new Error(`ROM ${romId} not found in server PouchDB — the host may not have synced it yet.`);
    }
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

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

  async _replicateTo() {
    return new Promise((resolve, reject) => {
      this._local.replicate.to(this._remote, { live: false })
        .on('complete', resolve)
        .on('error',    reject);
    });
  }

  async _replicateFrom(docId) {
    return new Promise((resolve, reject) => {
      this._local.replicate.from(this._remote, { live: false, doc_ids: [docId] })
        .on('complete', resolve)
        .on('error',    reject);
    });
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
