/**
 * SNESAdapter — snes9x2005-wasm wrapper implementing the RollbackEngine emulator contract.
 *
 * Emulator contract:
 *   step(inputMap)   — advance one SNES frame with given inputs
 *   saveState()      — snapshot mutable SNES state → Uint8Array
 *   loadState(snap)  — restore from snapshot
 *   render()         — blit current frame to canvas
 *
 * Audio is handled entirely by this adapter via AudioWorklet (snes-audio-worklet.js).
 * After each step(), window.snineX.getAudioSamples() returns an interleaved stereo
 * Float32Array for that frame; the adapter posts it (with buffer transfer) to the
 * AudioWorkletNode running on the dedicated audio thread.  This replaces the old
 * ScriptProcessorNode approach, which ran on the main thread and caused ring-buffer
 * overflows and choppy audio under load.
 *
 * SNES display canvas: 256 × 224 pixels (native SNES resolution).
 * WASM screen buffer:  512 × 448 RGBA (917 504 bytes) — game pixels occupy only the
 *   top-left 256 × 224 region; putImageData clips the rest.
 *
 * JOYPAD bit encoding (snes9x register format):
 *   B=0x8000  Y=0x4000  SELECT=0x2000  START=0x1000
 *   UP=0x0800 DOWN=0x0400 LEFT=0x0200 RIGHT=0x0100
 *   A=0x0080  X=0x0040  L=0x0020     R=0x0010
 *
 * Input mapping (InputBits → SNES joypad):
 *   UP / DOWN / LEFT / RIGHT / START / SELECT — same semantics as NES
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

    this._romLoaded   = false;
    this._audioMuted  = false;
    this._audioCtx    = null;
    this._workletNode = null;
  }

  // ── ROM loading ───────────────────────────────────────────────────────────

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

    // Set up the AudioWorklet before starting the emulator so the sample
    // rate is known and audio is ready to receive the first frame's samples.
    await this._initAudio();

    const sampleRate = this._audioCtx?.sampleRate ?? 44100;
    window.snineX.start(buf, sampleRate);

    this._romLoaded = true;
  }

  // ── Audio setup ───────────────────────────────────────────────────────────

  /**
   * Create an AudioContext and register the SNESAudioProcessor worklet.
   * Falls back gracefully (audio disabled) if AudioWorklet is unavailable.
   */
  async _initAudio() {
    try {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await this._audioCtx.audioWorklet.addModule('/js/snes-audio-worklet.js');
      // Explicitly request stereo output — without this, some browsers default
      // to mono (out[1] === undefined), which causes process() to crash silently.
      this._workletNode = new AudioWorkletNode(
        this._audioCtx,
        'snes-audio-processor',
        { numberOfOutputs: 1, outputChannelCount: [2] }
      );
      const gain = this._audioCtx.createGain();
      gain.gain.value = 0.5;
      this._workletNode.connect(gain);
      gain.connect(this._audioCtx.destination);
      // Pre-fill the ring buffer to the DRC target level (2048 stereo sample-pairs
      // ≈ 46 ms at 44 100 Hz) before the game loop starts.  Starting at target
      // prevents the proportional controller from applying a large initial
      // correction and ensures the first real audio frame arrives into a stable
      // buffer rather than an empty one.
      const silence = new Float32Array(2048 * 2); // interleaved stereo zeros
      this._workletNode.port.postMessage({ samples: silence }, [silence.buffer]);
      // Try to start the AudioContext now, while we're still within the async
      // chain that originated from the "Start Game" user gesture.  Chrome and
      // Firefox honour resume() when there has been a prior user interaction on
      // the page, so this should transition the context to 'running' before the
      // first frame is simulated.
      if (this._audioCtx.state === 'suspended') {
        await this._audioCtx.resume().catch(() => {});
      }
    } catch (err) {
      console.error('[SNESAdapter] AudioWorklet setup failed, audio disabled:', err);
      this._audioCtx    = null;
      this._workletNode = null;
    }
  }

  /**
   * Poll until window.snineX.isReady() or timeout.
   * snes9x.js initialises its WASM module asynchronously at script load time;
   * by the time loadROM is called the module is almost always ready, but we
   * poll briefly just in case.
   * Timeout is 10 seconds (200 × 50 ms) to cover slow devices.
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
    // Resume the AudioContext on unmute — browsers suspend it until a user gesture.
    if (!muted && this._audioCtx?.state === 'suspended') {
      this._audioCtx.resume();
    }
  }

  stopAudio() {
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      this._audioCtx.close();
      this._audioCtx = null;
    }
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

    // Feed audio to the worklet thread, skipping during rollback re-simulation.
    // Transfer the buffer (zero-copy) rather than cloning it.
    if (!this._audioMuted && this._workletNode) {
      if (this._audioCtx?.state === 'suspended') this._audioCtx.resume();
      const samples = window.snineX.getAudioSamples();
      if (samples) this._workletNode.port.postMessage({ samples }, [samples.buffer]);
    }
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
