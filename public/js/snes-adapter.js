/**
 * SNESAdapter — snes9x2005-wasm wrapper implementing the RollbackEngine emulator contract
 *
 * Emulator contract:
 *   step(inputMap)   — advance one SNES frame with given inputs
 *   saveState()      — snapshot mutable SNES state → Uint8Array
 *   loadState(snap)  — restore from snapshot
 *   render()         — blit current frame to canvas
 *
 * This adapter sits on top of window.snineX, a low-level helper object
 * injected into snes9x.js (a patched build of lrusso/SuperNintendo, which
 * itself is snes9x2005 compiled to WebAssembly via Emscripten).
 *
 * SNES display canvas: 256 × 224 pixels (native SNES resolution).
 * WASM screen buffer: 512 × 448 RGBA (917 504 bytes) — game pixels occupy
 * only the top-left 256 × 224 region; putImageData clips the rest.
 * JOYPAD bit encoding (snes9x register format):
 *   B=0x8000  Y=0x4000  SELECT=0x2000  START=0x1000
 *   UP=0x0800 DOWN=0x0400 LEFT=0x0200 RIGHT=0x0100
 *   A=0x0080  X=0x0040  L=0x0020     R=0x0010
 *
 * Input mapping (InputBits → SNES joypad):
 *   UP / DOWN / LEFT / RIGHT / START / SELECT  — same semantics as NES
 *   A   → SNES A  (primary)
 *   B   → SNES B  (secondary)
 *   X   → SNES X  (InputBits.X)
 *   Y   → SNES Y  (InputBits.Y)
 *   L   → SNES L  (InputBits.L)
 *   R   → SNES R  (InputBits.R)
 */
class SNESAdapter {
  // Display canvas dimensions: native SNES resolution (256×224).
  // The WASM screen buffer is allocated at 512×448 (SCREEN_BUF_W × SCREEN_BUF_H)
  // for hi-res / compatibility reasons, but actual game pixels occupy only the
  // top-left 256×224 region.  ctx.putImageData clips to canvas bounds, so
  // setting the canvas to 256×224 renders the correct game area automatically.
  static SNES_W = 256;
  static SNES_H = 224;
  // WASM screen-buffer dimensions — must match SCREEN_BYTES in snes9x.js.
  static SCREEN_BUF_W = 512;
  static SCREEN_BUF_H = 448;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string[]} playerIds  ordered player IDs (index 0 → controller 1, 1 → controller 2)
   */
  constructor(canvas, playerIds) {
    this.canvas    = canvas;
    this.playerIds = playerIds;
    this.ctx       = canvas.getContext('2d');

    canvas.width  = SNESAdapter.SNES_W;
    canvas.height = SNESAdapter.SNES_H;

    // ImageData must match the WASM screen buffer (512×448), not the display
    // canvas (256×224).  putImageData clips to the canvas, so only the
    // top-left 256×224 pixels — where the emulator places the game — are shown.
    this._imageData = this.ctx.createImageData(SNESAdapter.SCREEN_BUF_W, SNESAdapter.SCREEN_BUF_H);

    this._romLoaded = false;
    this._audioMuted = false;
  }

  // ── ROM loading ──────────────────────────────────────────────────────────

  /**
   * Fetch the SNES ROM via the server-side proxy and load it into snes9x.
   * @param {string} url  Public URL of the .sfc/.smc ROM file
   */
  async loadROM(url) {
    if (typeof window.snineX === 'undefined') {
      throw new Error('snes9x not loaded — make sure snes9x.js is included before snes-adapter.js');
    }

    const resp = await fetch(`/rom-proxy?url=${encodeURIComponent(url)}`);
    if (!resp.ok) {
      throw new Error(`ROM fetch error: HTTP ${resp.status} — ${resp.statusText}`);
    }

    const buf = await resp.arrayBuffer();

    // Wait for WASM to be ready (snes9x.js initialises asynchronously)
    await this._waitForWasm();

    window.snineX.initAudio();
    window.snineX.start(buf, this._audioCtxSampleRate());

    this._romLoaded = true;
  }

  /** Returns a sample rate hint for snes9x (falls back to 36 kHz). */
  _audioCtxSampleRate() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const sr  = ctx.sampleRate;
      ctx.close();
      return sr;
    } catch {
      return 36000;
    }
  }

  /**
   * Poll until window.snineX.isReady() or timeout.
   * snes9x.js initialises its WASM module asynchronously at script load time;
   * by the time loadROM is called the module is almost always ready, but we
   * poll briefly just in case.
   * Timeout is 10 seconds (200 × 50 ms) to cover slow devices; in practice
   * the module is ready within milliseconds of the WASM compile finishing.
   */
  _waitForWasm() {
    return new Promise((resolve, reject) => {
      if (window.snineX.isReady()) { resolve(); return; }
      let tries = 0;
      const id = setInterval(() => {
        if (window.snineX.isReady()) { clearInterval(id); resolve(); return; }
        if (++tries > 200) { clearInterval(id); reject(new Error('snes9x WASM init timed out')); }
      }, 50);
    });
  }

  // ── Audio mute control ────────────────────────────────────────────────────

  /** Called by RollbackEngine to suppress audio during re-simulation. */
  setAudioMuted(muted) {
    this._audioMuted = muted;
    window.snineX?.setAudioMuted(muted);
  }

  stopAudio() {
    window.snineX?.stopAudio();
  }

  // ── Emulator contract ─────────────────────────────────────────────────────

  /**
   * Apply inputs then advance one SNES frame.
   * @param {{ [playerId]: number }} inputMap  values are InputBits bitmasks
   */
  step(inputMap) {
    if (!this._romLoaded) return;

    const j1 = this._toJoypad(inputMap[this.playerIds[0]] ?? 0);
    const j2 = this._toJoypad(inputMap[this.playerIds[1]] ?? 0);

    window.snineX.step(j1, j2);
  }

  /**
   * Snapshot mutable SNES state via the WASM saveState export.
   * Returns a Uint8Array copy (~400 KB) or null if not ready.
   */
  saveState() {
    if (!this._romLoaded) return null;
    return window.snineX.saveState();
  }

  /**
   * Restore SNES state from a snapshot produced by saveState().
   * @param {Uint8Array|null} snap
   */
  loadState(snap) {
    if (!snap || !this._romLoaded) return;
    window.snineX.loadState(snap);
  }

  /**
   * Blit the latest SNES frame to the canvas.
   * snes9x stores the output as 512×448 RGBA bytes; we copy them straight
   * into a pre-allocated ImageData and putImageData once per render call.
   */
  render() {
    if (!this._romLoaded) return;
    window.snineX.render(this.ctx, this._imageData);
  }

  // ── Input conversion ──────────────────────────────────────────────────────

  /**
   * Convert an InputBits bitmask to the snes9x joypad register format.
   *
   * SNES joypad register bit layout:
   *   bit 15 = B     bit 14 = Y     bit 13 = SELECT  bit 12 = START
   *   bit 11 = UP    bit 10 = DOWN  bit  9 = LEFT    bit  8 = RIGHT
   *   bit  7 = A     bit  6 = X     bit  5 = L       bit  4 = R
   */
  _toJoypad(input) {
    let j = 0;
    if (input & InputBits.UP)     j |= 0x0800;
    if (input & InputBits.DOWN)   j |= 0x0400;
    if (input & InputBits.LEFT)   j |= 0x0200;
    if (input & InputBits.RIGHT)  j |= 0x0100;
    if (input & InputBits.A)      j |= 0x0080;
    if (input & InputBits.B)      j |= 0x8000;
    if (input & InputBits.START)  j |= 0x1000;
    if (input & InputBits.SELECT) j |= 0x2000;
    if (input & InputBits.X)      j |= 0x0040;
    if (input & InputBits.Y)      j |= 0x4000;
    if (input & InputBits.L)      j |= 0x0020;
    if (input & InputBits.R)      j |= 0x0010;
    return j;
  }
}
