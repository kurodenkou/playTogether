/**
 * LibretroAdapter — generic libretro-core-wasm wrapper implementing the
 * RollbackEngine emulator contract.
 *
 * Supports any libretro core compiled to WebAssembly via Emscripten, including
 * all single-file cores distributed by EmulatorJS (https://emulatorjs.org) and
 * custom Emscripten builds that export the standard libretro API.
 *
 * Emulator contract:
 *   step(inputMap)   — advance one frame with given inputs
 *   saveState()      — snapshot full state → Uint8Array (via retro_serialize)
 *   loadState(snap)  — restore from snapshot (via retro_unserialize)
 *   render()         — blit current framebuffer to canvas
 *
 * Core loading
 * ────────────
 * Use the static LibretroAdapter.loadCore() method before constructing the adapter.
 * Libretro cores compiled by Emscripten come as either:
 *   1. Single-file JS bundle — WASM is inlined (base64 or Uint8Array literal).
 *      Common in EmulatorJS distributions. Pass jsUrl only.
 *   2. Two-file (JS glue + .wasm) — Pass jsUrl plus wasmUrl; the adapter
 *      injects a locateFile() hook so Emscripten loads the WASM through
 *      the server-side proxy instead of from a relative path.
 * Both URLs are fetched through /rom-proxy to avoid CORS issues.
 * Note: /rom-proxy enforces a 16 MB per-file limit; cores larger than this
 * (e.g. MAME) must be self-hosted with permissive CORS headers instead.
 *
 * Expected Emscripten Module API (standard output with ALLOW_TABLE_GROWTH=1)
 * ──────────────────────────────────────────────────────────────────────────
 *   Module._malloc / _free
 *   Module.HEAPU8 / HEAP16 / HEAPU16 / HEAP32 / HEAPU32
 *   Module.addFunction(fn, sig)   register JS→WASM function pointer
 *   Module.UTF8ToString(ptr)      read C string from WASM heap
 *   Module._retro_init / _retro_deinit
 *   Module._retro_set_environment / _retro_set_video_refresh
 *   Module._retro_set_audio_sample / _retro_set_audio_sample_batch
 *   Module._retro_set_input_poll / _retro_set_input_state
 *   Module._retro_load_game / _retro_run
 *   Module._retro_serialize / _retro_unserialize / _retro_serialize_size
 *   Module._retro_get_system_av_info
 *
 * Audio
 * ─────
 * Reuses snes-audio-worklet.js (registered as 'snes-audio-processor').
 * The audio batch callback converts int16 stereo samples to Float32 and
 * posts them (zero-copy transfer) to the AudioWorklet thread each frame.
 *
 * Pixel formats
 * ─────────────
 * All three libretro pixel formats are supported:
 *   XRGB8888 — 4 B/px, 0x00RRGGBB (most modern cores)
 *   RGB565   — 2 B/px, 5-6-5 packing
 *   RGB1555  — 2 B/px, 1-5-5-5 packing (legacy default)
 * All are converted to canvas RGBA8888 (Uint32 LE = 0xAABBGGRR) in the
 * video refresh callback for a single putImageData() per render() call.
 *
 * Input mapping (InputBits → libretro RETRO_DEVICE_JOYPAD)
 * ─────────────────────────────────────────────────────────
 *   UP / DOWN / LEFT / RIGHT / START / SELECT / A / B / X / Y / L / R
 *   all map directly to their RETRO_DEVICE_ID_JOYPAD_* counterparts.
 */
class LibretroAdapter {
  // RETRO_DEVICE_ID_JOYPAD_* constants
  static JOYPAD = Object.freeze({
    B: 0, Y: 1, SELECT: 2, START: 3,
    UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
    A: 8, X: 9, L: 10, R: 11, L2: 12, R2: 13,
  });

  // RETRO_PIXEL_FORMAT_* constants
  static PIXEL_FORMAT = Object.freeze({ RGB1555: 0, XRGB8888: 1, RGB565: 2 });

  // RETRO_ENVIRONMENT_* command IDs handled in _onEnvironment()
  static ENV = Object.freeze({
    GET_CAN_DUPE:             3,
    SET_PERFORMANCE_LEVEL:    8,
    GET_SYSTEM_DIRECTORY:     9,
    SET_PIXEL_FORMAT:        10,
    SET_HW_RENDER:           14,
    GET_VARIABLE:            15,
    SET_VARIABLES:           16,
    GET_VARIABLE_UPDATE:     17,
    SET_SUPPORT_NO_GAME:     18,
    GET_LOG_INTERFACE:       27,
    GET_PERF_INTERFACE:      28,
    GET_SAVE_DIRECTORY:      31,
    SET_GEOMETRY:            37,
    GET_USERNAME:            38,
    GET_LANGUAGE:            39,
    SET_CORE_OPTIONS:        52,
    SET_CORE_OPTIONS_V2:     67,
    SET_CORE_OPTIONS_V2_INTL: 68,
  });

  // ── Static: core loading ─────────────────────────────────────────────────────

  /**
   * Load and initialize a libretro core compiled to WebAssembly via Emscripten.
   *
   * Fetches the core JS through /rom-proxy (avoids CORS), injects it as a
   * Blob-URL script, and waits for onRuntimeInitialized.
   *
   * @param {string} jsUrl         URL of the Emscripten JS glue / single-file bundle
   * @param {string} [wasmUrl]     URL of the separate .wasm file (two-file builds only)
   * @param {string} [globalName]  Window property name the module uses (default 'LibretroCore')
   * @returns {Promise<object>}    Resolved Emscripten Module, ready for use
   */
  static loadCore(jsUrl, wasmUrl = null, globalName = 'LibretroCore') {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Libretro core initialization timed out (30 s)')),
        30_000
      );

      // Pre-configure the Emscripten Module before the script runs.
      // Standard Emscripten glue checks for a pre-existing global named 'Module'
      // (or occasionally the build-configured name); we set both so either works.
      const modCfg = {
        noInitialRun: true,
        onRuntimeInitialized() {
          clearTimeout(timeout);
          resolve(modCfg);
        },
        print:    (msg) => console.log('[libretro]', msg),
        printErr: (msg) => console.warn('[libretro]', msg),
      };

      if (wasmUrl) {
        // Override Emscripten's WASM resolver so the binary is fetched through
        // our proxy regardless of the base URL Emscripten thinks the .js lives at.
        modCfg.locateFile = (path) =>
          path.endsWith('.wasm')
            ? `/rom-proxy?url=${encodeURIComponent(wasmUrl)}`
            : path;
      }

      window.Module = modCfg;
      if (globalName !== 'Module') window[globalName] = modCfg;

      try {
        const resp = await fetch(`/rom-proxy?url=${encodeURIComponent(jsUrl)}`);
        if (!resp.ok) throw new Error(`Core fetch failed: HTTP ${resp.status} — ${resp.statusText}`);
        const jsText = await resp.text();

        // Inject as a Blob URL; this lets the script execute without a separate
        // network request (and without any CORS requirement from the origin host).
        const blob    = new Blob([jsText], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const script  = document.createElement('script');
        script.onerror = () => {
          clearTimeout(timeout);
          URL.revokeObjectURL(blobUrl);
          reject(new Error('Core script failed to execute — check browser console for details'));
        };
        script.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });
        script.src = blobUrl;
        document.head.appendChild(script);
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  // ── Constructor ──────────────────────────────────────────────────────────────

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string[]}          playerIds   ordered player IDs (index 0 → port 1)
   * @param {object}            coreModule  Emscripten Module from LibretroAdapter.loadCore()
   */
  constructor(canvas, playerIds, coreModule) {
    this.canvas    = canvas;
    this.playerIds = playerIds;
    this.M         = coreModule;
    this.ctx       = canvas.getContext('2d');

    this._imageData   = null;
    this._frameBuffer = null;   // Uint32Array view into _imageData.data
    this._width       = 0;
    this._height      = 0;
    this._pixelFormat = LibretroAdapter.PIXEL_FORMAT.RGB1555;
    this._dirty       = false;

    this._romLoaded   = false;
    this._audioMuted  = false;
    this._audioCtx    = null;
    this._workletNode = null;

    // Per-port button state: port index → Uint8Array(16) where 1 = pressed
    this._inputState = [new Uint8Array(16), new Uint8Array(16)];

    // Reusable buffer for the single-sample audio callback path
    this._singleSampleBuf = new Int16Array(2);

    // Keep all registered function pointers alive (prevents GC of the JS closure)
    this._callbacks = {};

    this._registerCallbacks();
  }

  // ── Callback registration ────────────────────────────────────────────────────

  /**
   * Register all required libretro callbacks with the core and call retro_init().
   * Must be called before loadROM().
   */
  _registerCallbacks() {
    const M = this.M;

    // bool env(unsigned cmd, void *data)
    this._callbacks.env = M.addFunction(
      (cmd, data) => this._onEnvironment(cmd, data) ? 1 : 0,
      'iii');

    // void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch)
    this._callbacks.video = M.addFunction(
      (dataPtr, width, height, pitch) => this._onVideoRefresh(dataPtr, width, height, pitch),
      'viiii');

    // void audio_sample(int16_t left, int16_t right)
    this._callbacks.audioSample = M.addFunction((left, right) => {
      if (this._audioMuted) return;
      this._singleSampleBuf[0] = left;
      this._singleSampleBuf[1] = right;
      this._flushSamples(this._singleSampleBuf, 1);
    }, 'vii');

    // size_t audio_sample_batch(const int16_t *data, size_t frames)
    this._callbacks.audioBatch = M.addFunction(
      (dataPtr, frames) => this._onAudioBatch(dataPtr, frames),
      'iii');

    // void input_poll(void)  — input is already snapshotted before step(); no-op here
    this._callbacks.inputPoll = M.addFunction(() => {}, 'v');

    // int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id)
    this._callbacks.inputState = M.addFunction(
      (port, device, index, id) => this._onInputState(port, device, index, id),
      'iiiii');

    M._retro_set_environment(this._callbacks.env);
    M._retro_set_video_refresh(this._callbacks.video);
    M._retro_set_audio_sample(this._callbacks.audioSample);
    M._retro_set_audio_sample_batch(this._callbacks.audioBatch);
    M._retro_set_input_poll(this._callbacks.inputPoll);
    M._retro_set_input_state(this._callbacks.inputState);

    M._retro_init();
  }

  // ── Environment callback ─────────────────────────────────────────────────────

  /**
   * Handle RETRO_ENVIRONMENT_* commands issued by the core.
   * Returns true if the command was handled, false to signal unsupported.
   */
  _onEnvironment(cmd, data) {
    const M   = this.M;
    const ENV = LibretroAdapter.ENV;

    switch (cmd) {
      case ENV.SET_PIXEL_FORMAT:
        // Core declares its output pixel format before rendering begins.
        this._pixelFormat = M.HEAP32[data >> 2];
        return true;

      case ENV.GET_CAN_DUPE:
        // Signal that we accept duplicate/null frame pointers (CAN_DUPE=true).
        // This lets the core skip sending identical frames and saves CPU.
        M.HEAPU8[data] = 1;
        return true;

      case ENV.GET_SYSTEM_DIRECTORY:
      case ENV.GET_SAVE_DIRECTORY:
        // Return NULL pointer — no persistent filesystem is available in the browser.
        M.HEAP32[data >> 2] = 0;
        return true;

      case ENV.GET_VARIABLE:
        // The core is asking for a configuration variable value.
        // Return NULL to instruct the core to use its built-in default.
        M.HEAP32[(data + 4) >> 2] = 0;
        return false;

      case ENV.SET_GEOMETRY: {
        // Core wants to update display geometry (e.g. after a resolution mode change).
        // retro_game_geometry: base_width, base_height, max_width, max_height, aspect_ratio
        const w = M.HEAPU32[(data    ) >> 2];
        const h = M.HEAPU32[(data + 4) >> 2];
        if (w > 0 && h > 0) this._resize(w, h);
        return true;
      }

      case ENV.GET_LOG_INTERFACE: {
        // Provide a minimal logging function so cores that require it don't crash.
        // retro_log_callback holds a single function pointer.
        // We declare the signature as (int level, const char* fmt) — variadic args
        // beyond the format string are ignored, which is safe for debug logging.
        if (!this._callbacks.log) {
          this._callbacks.log = M.addFunction(
            (_level, fmtPtr) => console.log('[libretro core]', M.UTF8ToString(fmtPtr)),
            'vii');
        }
        M.HEAP32[data >> 2] = this._callbacks.log;
        return true;
      }

      // Silently acknowledge commands that need no action from our frontend.
      case ENV.SET_PERFORMANCE_LEVEL:
      case ENV.SET_VARIABLES:
      case ENV.GET_VARIABLE_UPDATE:
      case ENV.SET_SUPPORT_NO_GAME:
      case ENV.GET_PERF_INTERFACE:
      case ENV.GET_USERNAME:
      case ENV.GET_LANGUAGE:
      case ENV.SET_CORE_OPTIONS:
      case ENV.SET_CORE_OPTIONS_V2:
      case ENV.SET_CORE_OPTIONS_V2_INTL:
        return true;

      case ENV.SET_HW_RENDER:
        // Hardware (OpenGL/Vulkan) rendering is not supported in this browser frontend.
        return false;

      default:
        return false;
    }
  }

  // ── Video refresh callback ───────────────────────────────────────────────────

  /**
   * Called by the core after each simulated frame with a pointer to its framebuffer.
   * Converts the core's pixel format to canvas RGBA and marks the frame dirty.
   *
   * Canvas ImageData stores pixels as RGBA bytes; when viewed as Uint32 on a
   * little-endian system the layout is 0xAABBGGRR.  The conversion formulas
   * below produce this value from each source format.
   */
  _onVideoRefresh(dataPtr, width, height, pitch) {
    if (!dataPtr) return;  // null = duplicate frame (CAN_DUPE); nothing to do

    if (width !== this._width || height !== this._height) this._resize(width, height);

    const buf = this._frameBuffer;
    const M   = this.M;
    const PF  = LibretroAdapter.PIXEL_FORMAT;

    if (this._pixelFormat === PF.XRGB8888) {
      // Source: Uint32 per pixel, layout 0x00RRGGBB
      // Target: 0xFF000000 | (B<<16) | (G<<8) | R
      const src     = M.HEAPU32;
      const srcBase = dataPtr >> 2;
      const pitchPx = pitch >> 2;
      for (let y = 0; y < height; y++) {
        const srcRow = srcBase + y * pitchPx;
        const dstRow = y * width;
        for (let x = 0; x < width; x++) {
          const px = src[srcRow + x];  // 0x00RRGGBB
          buf[dstRow + x] = 0xFF000000
            | ((px & 0x000000FF) << 16)   // B → bits 23-16
            |  (px & 0x0000FF00)           // G → bits 15-8  (unchanged position)
            | ((px & 0x00FF0000) >>> 16);  // R → bits 7-0
        }
      }
    } else if (this._pixelFormat === PF.RGB565) {
      // Source: Uint16 per pixel, RRRRRGGGGGGBBBBB
      const src     = M.HEAPU16;
      const srcBase = dataPtr >> 1;
      const pitchPx = pitch >> 1;
      for (let y = 0; y < height; y++) {
        const srcRow = srcBase + y * pitchPx;
        const dstRow = y * width;
        for (let x = 0; x < width; x++) {
          const px = src[srcRow + x];
          const r  = ((px >> 11) & 0x1F) << 3;
          const g  = ((px >>  5) & 0x3F) << 2;
          const b  =  (px        & 0x1F) << 3;
          buf[dstRow + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
        }
      }
    } else {
      // RGB1555 (legacy default): Uint16, XRRRRRGGGGGBBBBB
      const src     = M.HEAPU16;
      const srcBase = dataPtr >> 1;
      const pitchPx = pitch >> 1;
      for (let y = 0; y < height; y++) {
        const srcRow = srcBase + y * pitchPx;
        const dstRow = y * width;
        for (let x = 0; x < width; x++) {
          const px = src[srcRow + x];
          const r  = ((px >> 10) & 0x1F) << 3;
          const g  = ((px >>  5) & 0x1F) << 3;
          const b  =  (px        & 0x1F) << 3;
          buf[dstRow + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
        }
      }
    }

    this._dirty = true;
  }

  /** Resize the canvas and reallocate the pixel buffers. */
  _resize(width, height) {
    this._width  = width;
    this._height = height;
    this.canvas.width  = width;
    this.canvas.height = height;
    this._imageData   = this.ctx.createImageData(width, height);
    this._frameBuffer = new Uint32Array(this._imageData.data.buffer);
  }

  // ── Audio callbacks ──────────────────────────────────────────────────────────

  _onAudioBatch(dataPtr, frames) {
    if (!this._audioMuted && this._workletNode && frames > 0) {
      // this.M.HEAP16 is the signed 16-bit view; dataPtr >> 1 converts byte
      // offset to HEAP16 index.
      this._flushSamples(this.M.HEAP16, frames, dataPtr >> 1);
    }
    return frames;
  }

  /**
   * Convert int16 interleaved stereo samples to Float32 and post to the worklet.
   * @param {Int16Array} src    source buffer (HEAP16 or _singleSampleBuf)
   * @param {number}     frames number of stereo sample pairs to convert
   * @param {number}     [offset=0]  index offset into src (for HEAP16 slice)
   */
  _flushSamples(src, frames, offset = 0) {
    if (!this._workletNode) return;
    const f32 = new Float32Array(frames * 2);
    for (let i = 0; i < frames * 2; i++) f32[i] = src[offset + i] / 32768.0;
    if (this._audioCtx?.state === 'suspended') this._audioCtx.resume();
    this._workletNode.port.postMessage({ samples: f32 }, [f32.buffer]);
  }

  // ── Input callback ───────────────────────────────────────────────────────────

  _onInputState(port, device, _index, id) {
    // Only handle RETRO_DEVICE_JOYPAD (device=1) for ports 0 and 1.
    if (port >= 2 || device !== 1 || id >= 16) return 0;
    return this._inputState[port][id];
  }

  // ── Audio setup ──────────────────────────────────────────────────────────────

  /**
   * Create an AudioContext and connect the SNESAudioProcessor worklet.
   * Reuses snes-audio-worklet.js — the worklet is generic Float32 stereo.
   */
  async _initAudio() {
    try {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await this._audioCtx.audioWorklet.addModule('/js/snes-audio-worklet.js');
      this._workletNode = new AudioWorkletNode(
        this._audioCtx,
        'snes-audio-processor',
        { numberOfOutputs: 1, outputChannelCount: [2] }
      );
      const gain = this._audioCtx.createGain();
      gain.gain.value = 0.5;
      this._workletNode.connect(gain);
      gain.connect(this._audioCtx.destination);
      // Pre-fill with silence to stabilize the DRC buffer before the first frame.
      const silence = new Float32Array(2048 * 2);
      this._workletNode.port.postMessage({ samples: silence }, [silence.buffer]);
      if (this._audioCtx.state === 'suspended') {
        await this._audioCtx.resume().catch(() => {});
      }
    } catch (err) {
      console.error('[LibretroAdapter] AudioWorklet setup failed, audio disabled:', err);
      this._audioCtx    = null;
      this._workletNode = null;
    }
  }

  /** Called by RollbackEngine to suppress audio during re-simulation. */
  setAudioMuted(muted) {
    this._audioMuted = muted;
    if (!muted && this._audioCtx?.state === 'suspended') this._audioCtx.resume();
  }

  stopAudio() {
    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      this._audioCtx.close();
      this._audioCtx = null;
    }
  }

  // ── ROM loading ──────────────────────────────────────────────────────────────

  /**
   * Fetch a ROM via the server-side proxy, load it into the core, and
   * read back the base resolution from retro_get_system_av_info.
   * @param {string} url  Public URL of the ROM file
   */
  async loadROM(url) {
    const resp = await fetch(`/rom-proxy?url=${encodeURIComponent(url)}`);
    if (!resp.ok) {
      throw new Error(`ROM fetch failed: HTTP ${resp.status} — ${resp.statusText}`);
    }
    const buf = await resp.arrayBuffer();

    await this._initAudio();

    const M = this.M;

    // Copy ROM bytes onto the WASM heap so we can pass a pointer to the core.
    const romPtr = M._malloc(buf.byteLength);
    if (!romPtr) throw new Error('WASM heap exhausted allocating ROM buffer');
    M.HEAPU8.set(new Uint8Array(buf), romPtr);

    // Build retro_game_info on the heap.
    // struct { const char *path; const void *data; size_t size; const char *meta; }
    // 4 × 4 bytes = 16 bytes on 32-bit WASM.
    const infoPtr = M._malloc(16);
    if (!infoPtr) {
      M._free(romPtr);
      throw new Error('WASM heap exhausted allocating retro_game_info struct');
    }
    M.HEAP32[(infoPtr     ) >> 2] = 0;             // path = NULL (use raw bytes)
    M.HEAP32[(infoPtr +  4) >> 2] = romPtr;         // data pointer
    M.HEAP32[(infoPtr +  8) >> 2] = buf.byteLength; // size
    M.HEAP32[(infoPtr + 12) >> 2] = 0;             // meta = NULL

    const ok = M._retro_load_game(infoPtr);
    M._free(infoPtr);
    M._free(romPtr);

    if (!ok) {
      throw new Error('retro_load_game() returned false — ROM rejected by core (wrong system or corrupt file)');
    }

    // Read the base display resolution.
    // retro_system_av_info layout (32-bit WASM):
    //   geometry: base_width(u32), base_height(u32), max_width(u32),
    //             max_height(u32), aspect_ratio(f32)   = 20 bytes
    //   timing:   fps(f64), sample_rate(f64)           = 16 bytes
    // Total 36 bytes; allocate 64 for alignment safety.
    const avPtr = M._malloc(64);
    M._retro_get_system_av_info(avPtr);
    const baseW = M.HEAPU32[(avPtr    ) >> 2];
    const baseH = M.HEAPU32[(avPtr + 4) >> 2];
    M._free(avPtr);

    this._resize(baseW || 320, baseH || 240);
    this._romLoaded = true;
  }

  // ── Emulator contract ────────────────────────────────────────────────────────

  /**
   * Map InputBits for all players into the libretro joypad state arrays,
   * then advance one frame via retro_run().
   * @param {{ [playerId]: number }} inputMap
   */
  step(inputMap) {
    if (!this._romLoaded) return;

    const JOYPAD = LibretroAdapter.JOYPAD;
    for (let port = 0; port < 2; port++) {
      const pid   = this.playerIds[port];
      const bits  = pid ? (inputMap[pid] ?? 0) : 0;
      const state = this._inputState[port];
      state.fill(0);

      if (bits & InputBits.UP)     state[JOYPAD.UP]     = 1;
      if (bits & InputBits.DOWN)   state[JOYPAD.DOWN]   = 1;
      if (bits & InputBits.LEFT)   state[JOYPAD.LEFT]   = 1;
      if (bits & InputBits.RIGHT)  state[JOYPAD.RIGHT]  = 1;
      if (bits & InputBits.A)      state[JOYPAD.A]      = 1;
      if (bits & InputBits.B)      state[JOYPAD.B]      = 1;
      if (bits & InputBits.START)  state[JOYPAD.START]  = 1;
      if (bits & InputBits.SELECT) state[JOYPAD.SELECT] = 1;
      if (bits & InputBits.X)      state[JOYPAD.X]      = 1;
      if (bits & InputBits.Y)      state[JOYPAD.Y]      = 1;
      if (bits & InputBits.L)      state[JOYPAD.L]      = 1;
      if (bits & InputBits.R)      state[JOYPAD.R]      = 1;
    }

    if (this._audioCtx?.state === 'suspended') this._audioCtx.resume();
    this.M._retro_run();
  }

  /**
   * Serialize the full core state into a Uint8Array snapshot for rollback.
   * @returns {Uint8Array|null}
   */
  saveState() {
    if (!this._romLoaded) return null;
    const M    = this.M;
    const size = M._retro_serialize_size();
    if (!size) return null;
    const ptr = M._malloc(size);
    if (!ptr) return null;
    const ok = M._retro_serialize(ptr, size);
    if (!ok) { M._free(ptr); return null; }
    // slice() creates an independent copy — safe to free the WASM buffer immediately.
    const snap = M.HEAPU8.slice(ptr, ptr + size);
    M._free(ptr);
    return snap;
  }

  /**
   * Restore core state from a snapshot produced by saveState().
   * @param {Uint8Array|null} snap
   */
  loadState(snap) {
    if (!snap || !this._romLoaded) return;
    const M   = this.M;
    const ptr = M._malloc(snap.byteLength);
    if (!ptr) return;
    M.HEAPU8.set(snap, ptr);
    M._retro_unserialize(ptr, snap.byteLength);
    M._free(ptr);
    this._dirty = true;
  }

  /** Blit the latest framebuffer to the canvas (one putImageData call). */
  render() {
    if (!this._dirty || !this._imageData) return;
    this.ctx.putImageData(this._imageData, 0, 0);
    this._dirty = false;
  }
}
