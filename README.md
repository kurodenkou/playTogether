# playTogether

Play retro games online with friends using rollback netcode. Supports NES, SNES, and any libretro-compatible core, plus a built-in Pong demo. Up to 4 players per room.

## Features

- **Rollback netcode** — GGPO-style frame synchronization handles network jitter without pausing
- **NES** — via [JSNES](https://github.com/bfirsh/jsnes), loaded from a ROM URL
- **SNES** — via snes9x (Emscripten/WASM build), loaded from a ROM URL
- **RetroArch / libretro** — any core compiled to WASM, loaded dynamically at runtime
- **Pong** — built-in deterministic demo, no ROM needed
- Room codes, spectating, in-game chat, and rematch support

## Getting Started

```bash
npm install
npm start          # http://localhost:3000
```

Set `PORT` to override the default port of 3000.

For development with auto-restart:

```bash
npm run dev
```

## How to Play

1. Open the app and enter a player name.
2. **Create** a room — you'll get a 6-character room code — or **Join** an existing one.
3. The host picks a game type and, for emulated games, pastes a ROM URL (and optionally a core URL for RetroArch).
4. Once all players are ready, the host clicks **Start Game**.
5. After a game ends, the host can click **Rematch** to play again.

### Controls

| Action | Keys |
|---|---|
| D-pad / move | Arrow keys or WASD |
| A | Z |
| B | X |
| X | C |
| Y | V |
| L / R | Q / E |
| Start | Enter |
| Select | Shift |

Gamepads (Xbox, PlayStation, Switch Pro) are also supported.

## Adding libretro Cores

Cores must be compiled to WebAssembly with Emscripten. Place the compiled `.js` (and optionally `.wasm`) files in `public/cores/`, then add a `core.json` manifest alongside them. The `scripts/build-core.sh` script automates building cores from source.

At runtime you can also load a core directly from a URL — paste the JS glue URL (and optional WASM URL) into the RetroArch fields before starting the game.

## Architecture

The server is intentionally thin: it handles room signaling and a ROM proxy, but runs no game simulation. All emulation, state management, and rollback logic live in the browser.

```
server.js                   Express + WebSocket signaling server
public/
  js/
    app.js                  Main SPA state machine
    rollback.js             GGPO-style rollback engine
    network.js              WebSocket wrapper
    input.js                Keyboard + gamepad input
    demo-game.js            Built-in Pong
    nes-adapter.js          JSNES wrapper
    snes-adapter.js         snes9x wrapper
    libretro-adapter.js     Generic libretro/WASM core wrapper
  cores/                    Compiled libretro cores (WASM)
scripts/
  build-core.sh             Compiles a libretro core to WASM
```

### Emulator contract

Every game adapter implements three methods used by the rollback engine:

```js
emulator.step(inputMap)      // advance one frame
emulator.saveState()         // return a serialisable snapshot
emulator.loadState(snapshot) // restore from snapshot
```

### Rollback engine

- Input delay: 2 frames (~33 ms) by default
- Max rollback depth: 8 frames
- Remote inputs are predicted when they haven't arrived yet; the engine rolls back and re-simulates when the real input comes in
- A live HUD shows frame count, confirmed frame, rollback count, and max rollback depth

### ROM proxy

The server proxies ROM and core fetches through `/rom-proxy` to avoid CORS issues. Responses are cached in a 64 MB LRU cache; individual files are capped at 16 MB.

## License

MIT
