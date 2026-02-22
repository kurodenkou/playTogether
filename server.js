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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

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

        room.broadcastAll({
          type: 'game-started',
          playerOrder: room.playerOrder,
          seed,
        });
        console.log(`[room] game started in ${room.id}, players: ${room.playerOrder}`);
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
