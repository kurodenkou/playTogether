/**
 * app.js — Application coordinator (SPA state machine)
 *
 * Views
 * ──────
 *   #view-lobby  — create / join a room
 *   #view-room   — waiting room + game canvas + chat
 *
 * The WebSocket connection is created once and kept alive for the entire
 * session, so there is no reconnect headache when switching views.
 *
 * Game types
 * ──────────
 *   pong  — built-in 2-player Pong demo (DemoGame)
 *   nes   — JSNES-backed NES emulator (NESAdapter), ROM loaded from URL
 */

// ── Globals ───────────────────────────────────────────────────────────────────

const net = new NetworkClient();

/** @type {{ roomId, playerId, hostId, players: Array }} */
let roomState = null;

/** @type {RollbackEngine|null} */
let engine = null;

/** @type {DemoGame|NESAdapter|null} */
let game = null;

/** @type {InputManager|null} */
let inputMgr = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await net.connect();
    console.log('[app] WebSocket connected');
  } catch {
    showStatus('lobby', 'Could not connect to server.', true);
    return;
  }

  bindLobbyUI();
  bindNetworkEvents();
  showView('lobby');

  const savedName = localStorage.getItem('playerName');
  if (savedName) el('playerName').value = savedName;
});

// ── View management ───────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('hidden', v.id !== `view-${name}`)
  );
}

// ── Lobby UI ──────────────────────────────────────────────────────────────────

function bindLobbyUI() {
  el('createRoomBtn').addEventListener('click', () => {
    const name = getPlayerName();
    if (!name) return;
    net.send({ type: 'create-room', playerName: name });
    el('createRoomBtn').disabled = true;
  });

  el('joinRoomBtn').addEventListener('click', doJoinRoom);
  el('roomCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoinRoom(); });
}

function doJoinRoom() {
  const code = el('roomCodeInput').value.trim().toUpperCase();
  if (!code) { showStatus('lobby', 'Enter a room code.', true); return; }
  const name = getPlayerName();
  if (!name) return;
  net.send({ type: 'join-room', roomId: code, playerName: name });
  el('joinRoomBtn').disabled = true;
}

function getPlayerName() {
  const name = el('playerName').value.trim().slice(0, 24);
  if (!name) { showStatus('lobby', 'Enter your name first.', true); return null; }
  localStorage.setItem('playerName', name);
  return name;
}

// ── Network events ────────────────────────────────────────────────────────────

function bindNetworkEvents() {
  net
    .on('room-created',  onRoomCreated)
    .on('room-joined',   onRoomJoined)
    .on('player-joined', onPlayerJoined)
    .on('player-left',   onPlayerLeft)
    .on('host-changed',  onHostChanged)
    .on('game-started',  onGameStarted)
    .on('rematch',       onRematch)
    .on('input',         onRemoteInput)
    .on('chat',          onChat)
    .on('error', msg => {
      showStatus('lobby', msg.message, true);
      el('createRoomBtn').disabled = false;
      el('joinRoomBtn').disabled = false;
    })
    .on('disconnect', () => {
      addChatLine('system', 'Disconnected from server.');
    });
}

function onRoomCreated(msg) {
  roomState = { roomId: msg.roomId, playerId: msg.playerId, hostId: msg.hostId, players: msg.players };
  enterRoom();
}

function onRoomJoined(msg) {
  roomState = { roomId: msg.roomId, playerId: msg.playerId, hostId: msg.hostId, players: msg.players };
  enterRoom();
}

function onPlayerJoined(msg) {
  roomState.players = msg.players;
  updatePlayerList();
  addChatLine('system', `${msg.playerName} joined the room.`);
}

function onPlayerLeft(msg) {
  roomState.players = msg.players;
  updatePlayerList();
  const gone = msg.players.find(p => p.id === msg.playerId);
  addChatLine('system', `${gone?.name ?? 'A player'} left the room.`);
}

function onHostChanged(msg) {
  roomState.hostId = msg.hostId;
  updateHostControls();
  updatePlayerList();
  addChatLine('system', 'Host transferred.');
}

async function onGameStarted(msg) {
  // msg: { playerOrder, seed, gameType: 'pong'|'nes', romUrl?: string }
  el('preGamePanel').classList.add('hidden');
  el('gamePanel').classList.remove('hidden');
  el('loadingOverlay').classList.remove('hidden');
  el('loadingOverlay').textContent = 'Loading…';

  try {
    if (msg.gameType === 'nes') {
      await startNESGame(msg.playerOrder, msg.seed, msg.romUrl);
    } else {
      startPongGame(msg.playerOrder, msg.seed);
    }
    el('loadingOverlay').classList.add('hidden');
  } catch (err) {
    el('loadingOverlay').textContent = `Error: ${err.message}`;
    el('loadingOverlay').classList.add('error');
    console.error('[game-start]', err);
  }
}

function onRematch() {
  stopGame();
  el('preGamePanel').classList.remove('hidden');
  el('gamePanel').classList.add('hidden');
  el('loadingOverlay').classList.add('hidden');
  el('loadingOverlay').classList.remove('error');
  updateHostControls();
  addChatLine('system', 'Host started a rematch — waiting for players.');
}

function onRemoteInput(msg) {
  engine?.receiveRemoteInput(msg.frame, msg.playerId, msg.input);
}

function onChat(msg) {
  const isSelf = msg.playerId === roomState?.playerId;
  addChatLine(isSelf ? 'self' : 'other', msg.message, msg.playerName);
}

// ── Room view ─────────────────────────────────────────────────────────────────

function enterRoom() {
  showView('room');
  updateRoomInfo();
  updatePlayerList();
  updateHostControls();
  syncGameTypeUI();

  if (!enterRoom._bound) {
    enterRoom._bound = true;

    // Game-type selector — only the host's choice matters (sent with start-game)
    el('gameTypeSelect').addEventListener('change', syncGameTypeUI);

    el('startGameBtn').addEventListener('click', () => {
      const gameType = el('gameTypeSelect').value;
      const romUrl   = el('romUrlInput').value.trim();
      if (gameType === 'nes' && !romUrl) {
        addChatLine('system', 'Enter a ROM URL before starting.');
        return;
      }
      net.send({ type: 'start-game', gameType, romUrl: romUrl || null });
    });

    el('rematchBtn').addEventListener('click', () => {
      net.send({ type: 'rematch' });
    });

    el('leaveRoomBtn').addEventListener('click', () => {
      net.disconnect();
      location.reload();
    });

    el('chatInput').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const msg = el('chatInput').value.trim();
      if (!msg) return;
      net.send({ type: 'chat', message: msg });
      el('chatInput').value = '';
    });

    el('sendChatBtn').addEventListener('click', () => {
      el('chatInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
  }
}

function syncGameTypeUI() {
  const isNES    = el('gameTypeSelect').value === 'nes';
  const isHost   = roomState?.hostId === roomState?.playerId;
  el('romUrlRow').classList.toggle('hidden', !isNES);
  el('gameTypeSelect').disabled = !isHost;
  el('romUrlInput').disabled    = !isHost;
}

function updateRoomInfo() {
  el('roomIdDisplay').textContent = roomState.roomId;
}

function updatePlayerList() {
  const list = el('playerList');
  list.innerHTML = '';
  for (const p of roomState.players) {
    const li = document.createElement('li');
    li.className = 'player-item' + (p.id === roomState.playerId ? ' self' : '');

    const badge  = p.id === roomState.hostId ? '<span class="badge host">HOST</span>' : '';
    const youTag = p.id === roomState.playerId ? ' <span class="badge you">YOU</span>' : '';

    li.innerHTML = `<span class="player-name">${escHtml(p.name)}${youTag}</span>${badge}`;
    list.appendChild(li);
  }
}

function updateHostControls() {
  const isHost       = roomState.hostId === roomState.playerId;
  const gameVisible  = !el('gamePanel').classList.contains('hidden');
  el('startGameBtn').classList.toggle('hidden', !isHost || gameVisible);
  el('rematchBtn').classList.toggle('hidden',   !isHost || !gameVisible);
  el('gameTypeSelect').disabled = !isHost;
  el('romUrlInput').disabled    = !isHost;
}

// ── Game lifecycle ────────────────────────────────────────────────────────────

/**
 * Start the built-in Pong demo game.
 */
function startPongGame(playerOrder, seed) {
  stopGame();
  const canvas = el('gameCanvas');

  // Reset canvas to Pong's 800×500 logical size
  canvas.width  = DemoGame.W;
  canvas.height = DemoGame.H;
  canvas.style.removeProperty('width');
  canvas.style.removeProperty('height');

  game    = new DemoGame(canvas, playerOrder, seed);
  inputMgr = new InputManager();

  _startEngine(playerOrder);

  const idx = playerOrder.indexOf(roomState.playerId);
  el('playerSlotLabel').textContent = idx >= 0 ? `You are Player ${idx + 1}` : 'Spectating';
  addChatLine('system', `Pong started! Player ${idx + 1}. ↑↓ or W·S to move.`);
}

/**
 * Start the NES emulator with the given ROM URL.
 * Async — awaits ROM download before starting the engine.
 */
async function startNESGame(playerOrder, seed, romUrl) {
  stopGame();

  if (!romUrl) throw new Error('No ROM URL provided.');

  const canvas = el('gameCanvas');

  // NES native resolution; scale up via CSS (pixelated rendering)
  canvas.width  = NESAdapter.NES_W;
  canvas.height = NESAdapter.NES_H;
  canvas.style.width  = `${NESAdapter.NES_W * 3}px`;
  canvas.style.height = `${NESAdapter.NES_H * 3}px`;

  el('loadingOverlay').textContent = 'Fetching ROM…';
  game = new NESAdapter(canvas, playerOrder);
  await game.loadROM(romUrl);

  el('loadingOverlay').textContent = 'Starting…';
  inputMgr = new InputManager();

  _startEngine(playerOrder);

  const idx = playerOrder.indexOf(roomState.playerId);
  el('playerSlotLabel').textContent = idx >= 0 ? `You are Player ${idx + 1}` : 'Spectating';
  addChatLine('system', `NES game started! You are Player ${idx + 1}. Arrow keys / W·A·S·D · Z=A · X=B · Enter=Start · Shift=Select`);
}

/** Shared engine wiring used by both game types. */
function _startEngine(playerOrder) {
  engine = new RollbackEngine({
    emulator:      game,
    localPlayerId: roomState.playerId,
    playerIds:     playerOrder,
    readInput:     () => inputMgr.getInput(),
    onStats:       updateStatsHUD,
  });

  engine._sendInput = (frame, input) => {
    net.send({ type: 'input', frame, input });
  };

  engine.start();

  updateHostControls();
  el('rematchBtn').classList.toggle('hidden', roomState.hostId !== roomState.playerId);
}

function stopGame() {
  engine?.stop();
  engine = null;
  game   = null;
  inputMgr?.destroy();
  inputMgr = null;
  clearStatsHUD();
}

// ── HUD ───────────────────────────────────────────────────────────────────────

function updateStatsHUD(stats) {
  el('hudFrame').textContent     = stats.frame;
  el('hudConfirmed').textContent = stats.confirmedFrame;
  el('hudRollbacks').textContent = stats.rollbacks;
  el('hudMaxDepth').textContent  = stats.maxRollbackDepth;
}

function clearStatsHUD() {
  ['hudFrame', 'hudConfirmed', 'hudRollbacks', 'hudMaxDepth'].forEach(id => {
    el(id).textContent = '—';
  });
}

// ── Chat ──────────────────────────────────────────────────────────────────────

function addChatLine(kind, text, sender) {
  const box = el('chatLog');
  const div = document.createElement('div');
  div.className = `chat-line chat-${kind}`;

  if (kind === 'system') {
    div.textContent = `⚙ ${text}`;
  } else {
    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-sender';
    nameSpan.textContent = sender + ': ';
    div.appendChild(nameSpan);
    div.appendChild(document.createTextNode(text));
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showStatus(view, msg, isError = false) {
  const el_ = document.getElementById(`status-${view}`);
  if (!el_) return;
  el_.textContent = msg;
  el_.className = `status ${isError ? 'error' : 'info'}`;
  el_.classList.remove('hidden');
}
