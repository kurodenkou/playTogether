/**
 * app.js — Application coordinator (SPA state machine)
 *
 * Views
 * ──────
 *   #view-lobby  — create / join a room
 *   #view-room   — waiting room + game canvas + chat
 *
 * The WebSocket connection is created once and kept alive for the
 * entire session, so there is no reconnect headache when switching views.
 */

// ── Globals ───────────────────────────────────────────────────────────────────

const net = new NetworkClient();

/** @type {{ roomId, playerId, hostId, players: Array }} */
let roomState = null;

/** @type {RollbackEngine|null} */
let engine = null;

/** @type {DemoGame|null} */
let game = null;

/** @type {InputManager|null} */
let inputMgr = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await net.connect();
    console.log('[app] WebSocket connected');
  } catch (err) {
    showStatus('lobby', 'Could not connect to server.', true);
    return;
  }

  bindLobbyUI();
  bindNetworkEvents();
  showView('lobby');

  // Restore player name from previous session
  const savedName = localStorage.getItem('playerName');
  if (savedName) el('playerName').value = savedName;
});

// ── View management ───────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${name}`));
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
    .on('room-created', onRoomCreated)
    .on('room-joined',  onRoomJoined)
    .on('player-joined', onPlayerJoined)
    .on('player-left',   onPlayerLeft)
    .on('host-changed',  onHostChanged)
    .on('game-started',  onGameStarted)
    .on('rematch',       onRematch)
    .on('input',         onRemoteInput)
    .on('chat',          onChat)
    .on('error',         msg => {
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

function onGameStarted(msg) {
  // msg: { playerOrder: string[], seed: number }
  el('preGamePanel').classList.add('hidden');
  el('gamePanel').classList.remove('hidden');
  startGame(msg.playerOrder, msg.seed);
}

function onRematch() {
  // Stop current game, return to waiting state
  stopGame();
  el('preGamePanel').classList.remove('hidden');
  el('gamePanel').classList.add('hidden');
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

  // Room-level UI bindings (idempotent via flag)
  if (!enterRoom._bound) {
    enterRoom._bound = true;

    el('startGameBtn').addEventListener('click', () => {
      net.send({ type: 'start-game' });
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

function updateRoomInfo() {
  el('roomIdDisplay').textContent = roomState.roomId;
}

function updatePlayerList() {
  const list = el('playerList');
  list.innerHTML = '';
  for (const p of roomState.players) {
    const li = document.createElement('li');
    li.className = 'player-item';
    if (p.id === roomState.playerId) li.classList.add('self');

    const badge = p.id === roomState.hostId
      ? '<span class="badge host">HOST</span>'
      : '';
    const youTag = p.id === roomState.playerId ? ' <span class="badge you">YOU</span>' : '';

    li.innerHTML = `<span class="player-name">${escHtml(p.name)}${youTag}</span>${badge}`;
    list.appendChild(li);
  }
}

function updateHostControls() {
  const isHost = roomState.hostId === roomState.playerId;
  el('startGameBtn').classList.toggle('hidden', !isHost || el('gamePanel').classList.contains('hidden') === false);
  el('rematchBtn').classList.toggle('hidden', !isHost || el('preGamePanel').classList.contains('hidden'));
}

// ── Game lifecycle ────────────────────────────────────────────────────────────

function startGame(playerOrder, seed) {
  stopGame(); // clean up any prior game

  const canvas = el('gameCanvas');
  game = new DemoGame(canvas, playerOrder, seed);
  inputMgr = new InputManager();

  engine = new RollbackEngine({
    emulator:      game,
    localPlayerId: roomState.playerId,
    playerIds:     playerOrder,
    readInput:     () => inputMgr.getInput(),
    onStats:       updateStatsHUD,
  });

  // Wire local-input send via the network client
  engine._sendInput = (frame, input) => {
    net.send({ type: 'input', frame, input });
  };

  engine.start();

  updateHostControls();
  el('rematchBtn').classList.toggle('hidden', roomState.hostId !== roomState.playerId);

  // Show which player slot you are
  const idx = playerOrder.indexOf(roomState.playerId);
  el('playerSlotLabel').textContent = idx >= 0 ? `You are Player ${idx + 1}` : 'Spectating';

  addChatLine('system', `Game started! You are Player ${idx + 1}. ${idx === 0 ? '↑↓ / W·S' : '↑↓ / W·S'} to move.`);
}

function stopGame() {
  engine?.stop();
  engine = null;
  game = null;
  inputMgr?.destroy();
  inputMgr = null;
  clearStatsHUD();
}

// ── HUD ───────────────────────────────────────────────────────────────────────

function updateStatsHUD(stats) {
  el('hudFrame').textContent      = stats.frame;
  el('hudConfirmed').textContent  = stats.confirmedFrame;
  el('hudRollbacks').textContent  = stats.rollbacks;
  el('hudMaxDepth').textContent   = stats.maxRollbackDepth;
}

function clearStatsHUD() {
  ['hudFrame','hudConfirmed','hudRollbacks','hudMaxDepth'].forEach(id => {
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showStatus(view, msg, isError = false) {
  const el_ = document.getElementById(`status-${view}`);
  if (!el_) return;
  el_.textContent = msg;
  el_.className = `status ${isError ? 'error' : 'info'}`;
  el_.classList.remove('hidden');
}
