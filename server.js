/**
 * playTogether - Server
 *
 * Express HTTP server + WebSocket signaling/relay server.
 * Handles room management and relays game inputs between players.
 * The server is intentionally "thin" - it does NOT simulate anything;
 * all game logic lives on the clients via the rollback engine.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Serve the jsnes browser bundle ────────────────────────────────────────────
app.get('/js/jsnes.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'jsnes', 'dist', 'jsnes.js'))
);

// ── Serve the snes9x browser bundle ───────────────────────────────────────────
// snes9x.js is a patched copy of lrusso/SuperNintendo (snes9x2005-wasm/Emscripten
// build) augmented with window.snineX low-level helpers for rollback-netcode control.
// Audio is managed by SNESAdapter via AudioWorklet (public/js/snes-audio-worklet.js),
// which is served automatically by express.static above.
app.get('/js/snes9x.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'js', 'snes9x.js'))
);

// ── Installed libretro cores ──────────────────────────────────────────────────
// Lists cores placed in public/cores/<id>/ by scripts/build-core.sh.
// Each core directory must contain core.js (and optionally core.wasm + core.json).
// The UI dropdown calls this endpoint to populate the "Installed core" selector.

app.get('/api/cores', (_req, res) => {
  const coresDir = path.join(__dirname, 'public', 'cores');
  if (!fs.existsSync(coresDir)) return res.json([]);

  let entries;
  try { entries = fs.readdirSync(coresDir); } catch { return res.json([]); }

  const cores = entries
    .filter(name => {
      const dir = path.join(coresDir, name);
      return fs.statSync(dir).isDirectory() &&
             fs.existsSync(path.join(dir, 'core.js'));
    })
    .map(name => {
      const dir = path.join(coresDir, name);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'core.json'), 'utf8')); } catch {}
      return {
        id:      name,
        name:    meta.name   ?? name,
        system:  meta.system ?? 'unknown',
        jsUrl:   `/cores/${name}/core.js`,
        wasmUrl: fs.existsSync(path.join(dir, 'core.wasm')) ? `/cores/${name}/core.wasm` : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json(cores);
});

// ── ROM proxy ──────────────────────────────────────────────────────────────────
// Fetches a .nes/.sfc ROM from an arbitrary URL and relays the bytes to the
// browser.  This avoids CORS issues when the ROM host doesn't set permissive
// headers.
//
// Security considerations:
//   • Only HTTP/HTTPS origins are accepted (no file://, data:, etc.)
//   • A 16 MB size limit prevents memory exhaustion.
//
// Performance:
//   • ROMs are cached in memory (up to ROM_CACHE_MAX_BYTES total) so that
//     subsequent requests — e.g. the second player joining the same room —
//     are served instantly without a second upstream fetch.
//   • Entries are evicted oldest-first when the cache would exceed the limit.

const ROM_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB total
/** @type {Map<string, {buf: Buffer, size: number, ts: number}>} */
const romCache = new Map();
let romCacheTotalBytes = 0;

function romCacheGet(url) {
  const entry = romCache.get(url);
  if (!entry) return null;
  entry.ts = Date.now(); // refresh for LRU ordering
  return entry.buf;
}

function romCacheSet(url, buf) {
  if (buf.length > ROM_CACHE_MAX_BYTES) return; // single entry too large to cache
  // Evict oldest entries until there is room
  while (romCacheTotalBytes + buf.length > ROM_CACHE_MAX_BYTES && romCache.size > 0) {
    let oldestKey, oldestTs = Infinity;
    for (const [k, v] of romCache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    const evicted = romCache.get(oldestKey);
    romCache.delete(oldestKey);
    romCacheTotalBytes -= evicted.size;
  }
  romCache.set(url, { buf, size: buf.length, ts: Date.now() });
  romCacheTotalBytes += buf.length;
}

app.get('/rom-proxy', async (req, res) => {
  const romUrl = req.query.url;
  if (!romUrl) return res.status(400).send('url parameter required');

  let parsed;
  try { parsed = new URL(romUrl); } catch {
    return res.status(400).send('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).send('Only HTTP and HTTPS URLs are supported');
  }

  // Serve from cache when available
  const cached = romCacheGet(romUrl);
  if (cached) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-ROM-Cache', 'HIT');
    return res.send(cached);
  }

  try {
    const upstream = await fetch(romUrl, {
      headers: { 'User-Agent': 'playTogether/1.0' },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream error: ${upstream.statusText}`);
    }

    const contentLength = Number(upstream.headers.get('content-length') ?? 0);
    if (contentLength > 16 * 1024 * 1024) {
      return res.status(413).send('ROM too large (max 16 MB)');
    }

    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > 16 * 1024 * 1024) {
      return res.status(413).send('ROM too large (max 16 MB)');
    }

    const buf = Buffer.from(buffer);
    romCacheSet(romUrl, buf);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-ROM-Cache', 'MISS');
    res.send(buf);
  } catch (err) {
    console.error('[rom-proxy]', err.message);
    res.status(500).send(`Failed to fetch ROM: ${err.message}`);
  }
});

// ─── Room Management ─────────────────────────────────────────────────────────

const rooms = new Map();       // roomId  -> Room
const wsToPlayer = new Map();  // ws      -> { playerId, roomId }

function genId(bytes) {
  return crypto.randomBytes(bytes).toString('hex').toUpperCase();
}

class Room {
  constructor(id, hostId) {
    this.id = id;
    this.hostId = hostId;
    /** @type {Map<string, {ws: WebSocket, name: string}>} */
    this.players = new Map();
    this.gameStarted = false;
    /** Ordered player IDs used for the current/last game */
    this.playerOrder = [];
  }

  addPlayer(playerId, name, ws) {
    this.players.set(playerId, { ws, name });
    wsToPlayer.set(ws, { playerId, roomId: this.id });
  }

  removePlayer(playerId) {
    const entry = this.players.get(playerId);
    if (entry) wsToPlayer.delete(entry.ws);
    this.players.delete(playerId);
    this.playerOrder = this.playerOrder.filter(id => id !== playerId);
  }

  send(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg, excludeId = null) {
    for (const [id, player] of this.players) {
      if (id !== excludeId) this.send(player.ws, msg);
    }
  }

  broadcastAll(msg) {
    this.broadcast(msg, null);
  }

  getPlayerList() {
    return [...this.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      isHost: id === this.hostId,
    }));
  }

  get isEmpty() {
    return this.players.size === 0;
  }
}

// ─── WebSocket Message Handling ───────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }

    const ctx = wsToPlayer.get(ws);
    const playerId = ctx?.playerId ?? null;
    const room = ctx?.roomId ? rooms.get(ctx.roomId) : null;

    switch (msg.type) {

      // ── Create a new room ───────────────────────────────────────────────
      case 'create-room': {
        const newPlayerId = genId(4);
        const newRoomId = genId(3);
        const newRoom = new Room(newRoomId, newPlayerId);
        const name = sanitizeName(msg.playerName);
        newRoom.addPlayer(newPlayerId, name, ws);
        rooms.set(newRoomId, newRoom);

        ws.send(JSON.stringify({
          type: 'room-created',
          roomId: newRoomId,
          playerId: newPlayerId,
          players: newRoom.getPlayerList(),
          hostId: newPlayerId,
        }));
        console.log(`[room] created ${newRoomId} by ${name}`);
        break;
      }

      // ── Join an existing room ───────────────────────────────────────────
      case 'join-room': {
        const targetRoom = rooms.get(msg.roomId?.toUpperCase?.());
        if (!targetRoom) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found.' }));
          return;
        }
        if (targetRoom.players.size >= 4) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 4 players).' }));
          return;
        }
        if (targetRoom.gameStarted) {
          ws.send(JSON.stringify({ type: 'error', message: 'A game is already in progress.' }));
          return;
        }

        const newPlayerId = genId(4);
        const name = sanitizeName(msg.playerName);
        targetRoom.addPlayer(newPlayerId, name, ws);

        ws.send(JSON.stringify({
          type: 'room-joined',
          roomId: targetRoom.id,
          playerId: newPlayerId,
          players: targetRoom.getPlayerList(),
          hostId: targetRoom.hostId,
        }));

        targetRoom.broadcast({
          type: 'player-joined',
          playerId: newPlayerId,
          playerName: name,
          players: targetRoom.getPlayerList(),
        }, newPlayerId);

        console.log(`[room] ${name} joined ${targetRoom.id}`);
        break;
      }

      // ── Host starts the game ────────────────────────────────────────────
      case 'start-game': {
        if (!room || room.hostId !== playerId) return;
        if (room.gameStarted) return;

        room.gameStarted = true;
        room.playerOrder = [...room.players.keys()];

        // Shared PRNG seed so all clients start with identical RNG state
        const seed = Date.now() & 0x7fffffff;

        // Validate gameType
        const VALID_GAME_TYPES = new Set(['pong', 'nes', 'snes', 'retroarch']);
        const gameType = VALID_GAME_TYPES.has(msg.gameType) ? msg.gameType : 'pong';

        // Only relay romUrl for emulator modes; strip for pong to avoid unexpected data
        const romUrl = (gameType === 'nes' || gameType === 'snes' || gameType === 'retroarch')
          ? (typeof msg.romUrl === 'string' ? msg.romUrl.slice(0, 2048) : null)
          : null;

        // Relay the libretro core JS URL for retroarch mode (two optional fields)
        const coreUrl = gameType === 'retroarch'
          ? (typeof msg.coreUrl === 'string' ? msg.coreUrl.slice(0, 2048) : null)
          : null;
        const coreWasmUrl = gameType === 'retroarch'
          ? (typeof msg.coreWasmUrl === 'string' ? msg.coreWasmUrl.slice(0, 2048) : null)
          : null;

        room.broadcastAll({
          type: 'game-started',
          playerOrder: room.playerOrder,
          seed,
          gameType,
          romUrl,
          coreUrl,
          coreWasmUrl,
        });
        console.log(`[room] game started in ${room.id} (${gameType}), players: ${room.playerOrder}`);
        break;
      }

      // ── Relay player input to all OTHER players in the room ─────────────
      case 'input': {
        if (!room || !playerId) return;
        room.broadcast({
          type: 'input',
          frame: msg.frame | 0,
          playerId,
          input: msg.input | 0,
        }, playerId);
        break;
      }

      // ── Relay chat message ──────────────────────────────────────────────
      case 'chat': {
        if (!room || !playerId) return;
        const player = room.players.get(playerId);
        room.broadcastAll({
          type: 'chat',
          playerId,
          playerName: player?.name ?? 'Unknown',
          message: String(msg.message ?? '').slice(0, 300),
        });
        break;
      }

      // ── Host requests a rematch ─────────────────────────────────────────
      case 'rematch': {
        if (!room || room.hostId !== playerId) return;
        room.gameStarted = false;
        room.playerOrder = [];
        room.broadcastAll({ type: 'rematch' });
        break;
      }
    }
  });

  ws.on('close', () => {
    const ctx = wsToPlayer.get(ws);
    if (!ctx) return;
    const { playerId: pId, roomId: rId } = ctx;
    const room = rooms.get(rId);
    if (!room) return;

    const playerName = room.players.get(pId)?.name ?? 'Unknown';
    room.removePlayer(pId);
    console.log(`[room] ${playerName} left ${rId}`);

    if (room.isEmpty) {
      rooms.delete(rId);
      console.log(`[room] ${rId} closed (empty)`);
      return;
    }

    // Transfer host if needed
    if (room.hostId === pId) {
      room.hostId = [...room.players.keys()][0];
      room.broadcastAll({ type: 'host-changed', hostId: room.hostId });
    }
    room.broadcastAll({
      type: 'player-left',
      playerId: pId,
      players: room.getPlayerList(),
    });
  });

  ws.on('error', (err) => console.error('[ws]', err.message));
});

function sanitizeName(raw) {
  return String(raw ?? 'Player').trim().slice(0, 24) || 'Player';
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`playTogether running → http://localhost:${PORT}`);
});
