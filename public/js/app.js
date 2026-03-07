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

/** @type {Array|null} cached result from GET /api/cores (null = not yet fetched) */
let _coresCache = null;

/**
 * Maps slotPlayerId → actualClientId (who currently controls each controller slot).
 * Populated when a game starts; updated on controller-transferred events.
 * @type {Map<string, string>}
 */
let controllerMap = new Map();

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
    .on('room-created',          onRoomCreated)
    .on('room-joined',           onRoomJoined)
    .on('player-joined',         onPlayerJoined)
    .on('player-left',           onPlayerLeft)
    .on('host-changed',          onHostChanged)
    .on('game-started',          onGameStarted)
    .on('rematch',               onRematch)
    .on('input',                 onRemoteInput)
    .on('controller-transferred', onControllerTransferred)
    .on('chat',                  onChat)
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
  // msg: { playerOrder, seed, gameType, romUrl?, romId?, romFilename?, coreUrl?, coreWasmUrl? }
  el('preGamePanel').classList.add('hidden');
  el('gamePanel').classList.remove('hidden');
  el('loadingOverlay').classList.remove('hidden');
  el('loadingOverlay').textContent = 'Loading…';

  // Initialise controller map: each player controls their own slot
  controllerMap = new Map();
  for (const pid of msg.playerOrder) controllerMap.set(pid, pid);

  try {
    // Resolve ROM bytes when the host used a local file (romId path).
    // Guests fetch from the server PouchDB; the host already has it locally.
    let romBytes    = null;
    let romFilename = msg.romFilename ?? 'rom';
    if (msg.romId) {
      el('loadingOverlay').textContent = 'Fetching ROM from peers…';
      const result = await romStore.loadROM(msg.romId, romFilename);
      romBytes    = result.bytes;
      romFilename = result.filename;
    }

    if (msg.gameType === 'snes') {
      await startSNESGame(msg.playerOrder, msg.seed, msg.romUrl, romBytes);
    } else if (msg.gameType === 'nes') {
      await startNESGame(msg.playerOrder, msg.seed, msg.romUrl, romBytes);
    } else if (msg.gameType === 'retroarch') {
      await startLibretroGame(msg.playerOrder, msg.seed, msg.romUrl, msg.coreUrl, msg.coreWasmUrl, romBytes, romFilename);
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
  controllerMap = new Map();
  el('preGamePanel').classList.remove('hidden');
  el('gamePanel').classList.add('hidden');
  el('loadingOverlay').classList.add('hidden');
  el('loadingOverlay').classList.remove('error');
  updateHostControls();
  updatePlayerList();
  addChatLine('system', 'Host started a rematch — waiting for players.');
}

function onRemoteInput(msg) {
  engine?.receiveRemoteInput(msg.frame, msg.playerId, msg.input);
}

function onControllerTransferred(msg) {
  const { slotPlayerId, toPlayerId } = msg;
  const prevController = controllerMap.get(slotPlayerId);

  controllerMap.set(slotPlayerId, toPlayerId);

  if (engine) {
    const myId = roomState.playerId;

    // If I previously controlled this slot and am now giving it up
    if (prevController === myId && toPlayerId !== myId) {
      if (slotPlayerId === myId) {
        // Surrendering my own slot to another player
        engine.surrenderLocalSlot();
      } else {
        // I had adopted this slot; release it back to remote tracking
        engine._adoptedSlots.delete(slotPlayerId);
        engine.lastReceivedFrame.set(slotPlayerId, engine.frame + engine.INPUT_DELAY);
      }
    }

    // If I am the new controller of this slot
    if (toPlayerId === myId && slotPlayerId !== myId) {
      engine.adoptSlot(slotPlayerId);
    }
  }

  updatePlayerList();

  const slotName = _slotLabel(slotPlayerId);
  const toPlayer = roomState.players.find(p => p.id === toPlayerId);
  addChatLine('system', `${slotName} controller passed to ${escHtml(toPlayer?.name ?? 'Unknown')}.`);
}

/** Returns a human-readable slot label like "1P" for the given slot player ID. */
function _slotLabel(slotPlayerId) {
  const playerOrder = [...controllerMap.keys()];
  const idx = playerOrder.indexOf(slotPlayerId);
  return idx >= 0 ? `${idx + 1}P` : 'Slot';
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
    _wireCoreSelect();

    el('startGameBtn').addEventListener('click', async () => {
      const gameType    = el('gameTypeSelect').value;
      const romUrl      = el('romUrlInput').value.trim();
      const romFile     = el('romFileInput').files?.[0] ?? null;
      const coreUrl     = el('coreUrlInput').value.trim();
      const coreWasmUrl = el('coreWasmUrlInput').value.trim();
      const isRomGame   = gameType === 'nes' || gameType === 'snes' || gameType === 'retroarch';

      if (isRomGame && !romUrl && !romFile) {
        addChatLine('system', 'Enter a ROM URL or pick a ROM file before starting.');
        return;
      }
      if (gameType === 'retroarch') {
        if (!coreUrl) { addChatLine('system', 'Enter a Core JS URL before starting.'); return; }
      }

      // If the host picked a local file, store it in PouchDB and sync to server
      // before broadcasting the start-game message so guests can pull it.
      if (romFile) {
        el('romFileStatus').textContent = 'Syncing ROM to server…';
        el('startGameBtn').disabled = true;
        try {
          const { romId, filename } = await romStore.storeROM(romFile);
          el('romFileStatus').textContent = `Synced: ${filename}`;
          net.send({
            type: 'start-game',
            gameType,
            romId,
            romFilename: filename,
            coreUrl:     coreUrl     || null,
            coreWasmUrl: coreWasmUrl || null,
          });
        } catch (err) {
          el('romFileStatus').textContent = `Sync failed: ${err.message}`;
          console.error('[rom-store] storeROM error', err);
        } finally {
          el('startGameBtn').disabled = false;
        }
        return;
      }

      net.send({
        type: 'start-game',
        gameType,
        romUrl:      romUrl      || null,
        coreUrl:     coreUrl     || null,
        coreWasmUrl: coreWasmUrl || null,
      });
    });

    el('rematchBtn').addEventListener('click', () => {
      net.send({ type: 'rematch' });
    });

    el('romFileInput').addEventListener('change', () => {
      const file = el('romFileInput').files?.[0];
      if (file) {
        el('romFileStatus').textContent = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) — will sync on Start`;
        // Clear the URL field so only one source is used
        el('romUrlInput').value = '';
      } else {
        el('romFileStatus').textContent = 'Pick a file from your computer — synced to all players via PouchDB.';
      }
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

/**
 * Fetch the list of locally-built cores from GET /api/cores and populate
 * the #coreSelect dropdown.  Results are cached after the first fetch.
 * Shows #coreSelectRow only when at least one core is installed.
 */
async function _populateCoreSelect() {
  try {
    if (_coresCache === null) {
      const resp = await fetch('/api/cores');
      _coresCache = resp.ok ? await resp.json() : [];
    }

    const select = el('coreSelect');
    // Rebuild options (keep the placeholder at index 0)
    while (select.options.length > 1) select.remove(1);

    for (const core of _coresCache) {
      const opt = document.createElement('option');
      // Store both URLs in the value so auto-fill can read them without a second lookup
      opt.value       = JSON.stringify({ jsUrl: core.jsUrl, wasmUrl: core.wasmUrl ?? '' });
      opt.textContent = core.name;
      select.appendChild(opt);
    }

    el('coreSelectRow').classList.toggle('hidden', _coresCache.length === 0);
  } catch {
    el('coreSelectRow').classList.add('hidden');
  }
}

/**
 * Wire up the #coreSelect → URL-field auto-fill.
 * Called once inside enterRoom() after the DOM is bound.
 */
function _wireCoreSelect() {
  el('coreSelect').addEventListener('change', () => {
    const val = el('coreSelect').value;
    if (!val) return;
    const { jsUrl, wasmUrl } = JSON.parse(val);
    el('coreUrlInput').value     = jsUrl;
    el('coreWasmUrlInput').value = wasmUrl;
  });
}

function syncGameTypeUI() {
  const gameType      = el('gameTypeSelect').value;
  const isRetroarch   = gameType === 'retroarch';
  const isRomEmulator = gameType === 'nes' || gameType === 'snes' || isRetroarch;

  el('coreUrlRow').classList.toggle('hidden', !isRetroarch);
  el('coreWasmUrlRow').classList.toggle('hidden', !isRetroarch);
  el('romUrlRow').classList.toggle('hidden', !isRomEmulator);
  el('romFileRow').classList.toggle('hidden', !isRomEmulator);

  if (isRetroarch) {
    _populateCoreSelect(); // async; shows #coreSelectRow when cores are available
  } else {
    el('coreSelectRow').classList.add('hidden');
  }

  if (gameType === 'snes') {
    el('romUrlLabel').textContent  = 'ROM URL (.sfc / .smc)';
    el('romUrlInput').placeholder  = 'https://example.com/game.sfc';
  } else if (isRetroarch) {
    el('romUrlLabel').textContent  = 'ROM URL';
    el('romUrlInput').placeholder  = 'https://example.com/game.rom';
  } else {
    el('romUrlLabel').textContent  = 'ROM URL (.nes)';
    el('romUrlInput').placeholder  = 'https://example.com/game.nes';
  }

  // All players can configure and start a game — no host restriction on inputs
  el('gameTypeSelect').disabled   = false;
  el('romUrlInput').disabled      = false;
  el('coreUrlInput').disabled     = false;
  el('coreWasmUrlInput').disabled = false;
}

function updateRoomInfo() {
  el('roomIdDisplay').textContent = roomState.roomId;
}

function updatePlayerList() {
  const list = el('playerList');
  list.innerHTML = '';
  const gameActive = !el('gamePanel').classList.contains('hidden');

  // Build a reverse lookup: actual client ID → slot player ID they currently control
  const myControlledSlot = _findControlledSlot(roomState.playerId);

  for (const p of roomState.players) {
    const li = document.createElement('li');
    li.className = 'player-item' + (p.id === roomState.playerId ? ' self' : '');

    const hostBadge = p.id === roomState.hostId ? '<span class="badge host">HOST</span>' : '';
    const youTag    = p.id === roomState.playerId ? ' <span class="badge you">YOU</span>' : '';

    // Show which controller slot this player currently controls (if game is active)
    let slotBadge = '';
    if (gameActive && controllerMap.size > 0) {
      const controlledSlot = _findControlledSlot(p.id);
      if (controlledSlot !== null) {
        const slotIdx = [...controllerMap.keys()].indexOf(controlledSlot);
        slotBadge = `<span class="badge slot">${slotIdx + 1}P</span>`;
      }
    }

    // "Pass" button: shown on your own row during game when you control a slot,
    // so you can hand it off to another player.
    let passBtn = '';
    if (gameActive && p.id === roomState.playerId && myControlledSlot !== null) {
      passBtn = '<button class="pass-btn" title="Pass your controller to another player">Pass</button>';
    }

    li.innerHTML =
      `<span class="player-name">${escHtml(p.name)}${youTag}</span>` +
      `<span class="player-badges">${slotBadge}${hostBadge}</span>` +
      passBtn;

    // Wire up "Pass" button
    if (passBtn) {
      li.querySelector('.pass-btn').addEventListener('click', () => _openPassDialog(myControlledSlot));
    }

    list.appendChild(li);
  }
}

/**
 * Returns the slot player ID that `clientId` currently controls,
 * or null if they are spectating.
 * @param {string} clientId
 * @returns {string|null}
 */
function _findControlledSlot(clientId) {
  for (const [slotId, controllerId] of controllerMap) {
    if (controllerId === clientId) return slotId;
  }
  return null;
}

/**
 * Show the inline "pass controller" dialog so the player can pick a recipient.
 * @param {string} slotPlayerId  the slot being passed
 */
function _openPassDialog(slotPlayerId) {
  // Remove any existing dialog first
  const existing = el('passDialog');
  if (existing) existing.remove();

  const dialog = document.createElement('div');
  dialog.id = 'passDialog';
  dialog.className = 'pass-dialog';

  const label = document.createElement('span');
  label.textContent = 'Pass to:';

  const select = document.createElement('select');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— select player —';
  select.appendChild(placeholder);

  for (const p of roomState.players) {
    if (p.id === roomState.playerId) continue; // skip self
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = escHtml(p.name);
    select.appendChild(opt);
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Pass';
  confirmBtn.className = 'primary';
  confirmBtn.style.padding = '4px 10px';
  confirmBtn.addEventListener('click', () => {
    const toPlayerId = select.value;
    if (!toPlayerId) return;
    net.send({ type: 'transfer-controller', slotPlayerId, toPlayerId });
    dialog.remove();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕';
  cancelBtn.style.padding = '4px 8px';
  cancelBtn.addEventListener('click', () => dialog.remove());

  dialog.appendChild(label);
  dialog.appendChild(select);
  dialog.appendChild(confirmBtn);
  dialog.appendChild(cancelBtn);

  // Insert below the player list
  el('playerList').insertAdjacentElement('afterend', dialog);
}

function updateHostControls() {
  const isHost      = roomState.hostId === roomState.playerId;
  const gameVisible = !el('gamePanel').classList.contains('hidden');
  // Any player can start a game; only the host can call a rematch
  el('startGameBtn').classList.toggle('hidden', gameVisible);
  el('rematchBtn').classList.toggle('hidden', !isHost || !gameVisible);
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
 * Start the SNES emulator with the given ROM URL or pre-fetched bytes.
 * Async — awaits ROM download before starting the engine.
 * @param {string[]}     playerOrder
 * @param {number}       seed
 * @param {string|null}  romUrl    URL to fetch (used when romBytes is null)
 * @param {ArrayBuffer|null} romBytes  Pre-fetched bytes from PouchDB sync (takes priority)
 */
async function startSNESGame(playerOrder, seed, romUrl, romBytes = null) {
  stopGame();

  if (!romBytes && !romUrl) throw new Error('No ROM URL or file provided.');

  const canvas = el('gameCanvas');

  // SNES native resolution 256×224; scale up 3× via CSS (pixelated rendering)
  canvas.width  = SNESAdapter.SNES_W;
  canvas.height = SNESAdapter.SNES_H;
  canvas.style.width  = `${SNESAdapter.SNES_W * 3}px`;
  canvas.style.height = `${SNESAdapter.SNES_H * 3}px`;

  game = new SNESAdapter(canvas, playerOrder);
  if (romBytes) {
    el('loadingOverlay').textContent = 'Loading ROM…';
    await game.loadROMBytes(romBytes);
  } else {
    el('loadingOverlay').textContent = 'Fetching ROM…';
    await game.loadROM(romUrl);
  }

  el('loadingOverlay').textContent = 'Starting…';
  inputMgr = new InputManager();

  _startEngine(playerOrder);

  const idx = playerOrder.indexOf(roomState.playerId);
  el('playerSlotLabel').textContent = idx >= 0 ? `You are Player ${idx + 1}` : 'Spectating';
  addChatLine('system', `SNES game started! You are Player ${idx + 1}. Arrows/WASD · Z=A · X=B · C=X · V=Y · Q=L · E=R · Enter=Start`);
}

/**
 * Start the NES emulator with the given ROM URL or pre-fetched bytes.
 * Async — awaits ROM download before starting the engine.
 * @param {string[]}     playerOrder
 * @param {number}       seed
 * @param {string|null}  romUrl    URL to fetch (used when romBytes is null)
 * @param {ArrayBuffer|null} romBytes  Pre-fetched bytes from PouchDB sync (takes priority)
 */
async function startNESGame(playerOrder, seed, romUrl, romBytes = null) {
  stopGame();

  if (!romBytes && !romUrl) throw new Error('No ROM URL or file provided.');

  const canvas = el('gameCanvas');

  // NES native resolution; scale up via CSS (pixelated rendering)
  canvas.width  = NESAdapter.NES_W;
  canvas.height = NESAdapter.NES_H;
  canvas.style.width  = `${NESAdapter.NES_W * 3}px`;
  canvas.style.height = `${NESAdapter.NES_H * 3}px`;

  game = new NESAdapter(canvas, playerOrder);
  if (romBytes) {
    el('loadingOverlay').textContent = 'Loading ROM…';
    await game.loadROMBytes(romBytes);
  } else {
    el('loadingOverlay').textContent = 'Fetching ROM…';
    await game.loadROM(romUrl);
  }

  el('loadingOverlay').textContent = 'Starting…';
  inputMgr = new InputManager();

  _startEngine(playerOrder);

  const idx = playerOrder.indexOf(roomState.playerId);
  el('playerSlotLabel').textContent = idx >= 0 ? `You are Player ${idx + 1}` : 'Spectating';
  addChatLine('system', `NES game started! You are Player ${idx + 1}. Arrow keys / W·A·S·D · Z=A · X=B · Enter=Start · Shift=Select`);
}

/**
 * Start a RetroArch game using any libretro core compiled to WebAssembly.
 * Async — loads the core script, then fetches the ROM, then starts the engine.
 *
 * @param {string[]}     playerOrder  ordered player IDs
 * @param {number}       seed         shared PRNG seed (unused by libretro cores directly)
 * @param {string|null}  romUrl       URL of the game ROM (used when romBytes is null)
 * @param {string}       coreUrl      URL of the Emscripten JS glue for the libretro core
 * @param {string}       [coreWasmUrl] optional URL of the separate .wasm file (two-file builds)
 * @param {ArrayBuffer|null} romBytes  Pre-fetched bytes from PouchDB sync (takes priority)
 * @param {string}       [romFilename] Original filename hint for extension sniffing
 */
async function startLibretroGame(playerOrder, seed, romUrl, coreUrl, coreWasmUrl, romBytes = null, romFilename = 'rom') {
  stopGame();

  if (!coreUrl)              throw new Error('No Core JS URL provided.');
  if (!romBytes && !romUrl)  throw new Error('No ROM URL or file provided.');

  const canvas = el('gameCanvas');

  // Set an initial canvas size; LibretroAdapter._resize() will update it
  // once retro_get_system_av_info returns the actual base resolution.
  canvas.width  = 320;
  canvas.height = 240;
  canvas.style.removeProperty('width');
  canvas.style.removeProperty('height');

  el('loadingOverlay').textContent = 'Loading core…';
  const coreModule = await LibretroAdapter.loadCore(
    coreUrl,
    coreWasmUrl || null,
    canvas,
  );

  game = new LibretroAdapter(canvas, playerOrder, coreModule);
  if (romBytes) {
    el('loadingOverlay').textContent = 'Loading ROM…';
    await game.loadROMBytes(romBytes, romFilename);
  } else {
    el('loadingOverlay').textContent = 'Fetching ROM…';
    await game.loadROM(romUrl);
  }

  // Apply 3× CSS scaling based on the resolved native resolution.
  canvas.style.width  = `${canvas.width  * 3}px`;
  canvas.style.height = `${canvas.height * 3}px`;

  el('loadingOverlay').textContent = 'Starting…';
  inputMgr = new InputManager();

  _startEngine(playerOrder);

  const idx = playerOrder.indexOf(roomState.playerId);
  el('playerSlotLabel').textContent = idx >= 0 ? `You are Player ${idx + 1}` : 'Spectating';
  addChatLine('system', `RetroArch game started! You are Player ${idx + 1}. Arrows/WASD · Z=A · X=B · C=X · V=Y · Q=L · E=R · Enter=Start · Shift=Select`);
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

  engine._sendInput = (frame, slotPlayerId, input) => {
    net.send({ type: 'input', frame, playerId: slotPlayerId, input });
  };

  engine.start();

  updateHostControls();
  updatePlayerList();
  el('rematchBtn').classList.toggle('hidden', roomState.hostId !== roomState.playerId);
}

function stopGame() {
  engine?.stop();
  engine = null;
  game?.stopAudio?.();
  game   = null;
  inputMgr?.destroy();
  inputMgr = null;
  clearStatsHUD();
  // Clear libretro core globals so the next loadCore() starts from a clean slate.
  delete window.Module;
  delete window.LibretroCore;
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
