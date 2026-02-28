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

      // ── Capture WebAssembly.Memory and function table before module runs ─────
      // Emscripten always creates the wasm linear memory on the JS side and
      // passes it as an import.  Cores built without EXPORTED_RUNTIME_METHODS
      // that include HEAP views (HEAPU8, HEAP32, etc.) will have all those
      // properties undefined on the Module object.  We temporarily wrap the two
      // WebAssembly instantiation entry-points to observe the import object and
      // grab the Memory before it disappears into Emscripten's closure.
      //
      // We also capture the WebAssembly.Table from the instance exports so that
      // cores compiled without ALLOW_TABLE_GROWTH=1 / addFunction can still have
      // JS callbacks registered via the direct table-manipulation path in _addFn.
      let _capturedMem       = null;
      let _capturedTable     = null;
      let _capturedExports   = null;   // raw WASM instance exports (superset of Module._xxx)
      let _capturedWasm      = null;   // WASM binary ArrayBuffer (captured from fallback path)
      let _capturedModule    = null;   // WebAssembly.Module object (for custom-section inspection)
      const _origInst        = WebAssembly.instantiate;
      const _origInstS       = WebAssembly.instantiateStreaming;
      const _restoreWA       = () => {
        WebAssembly.instantiate          = _origInst;
        WebAssembly.instantiateStreaming = _origInstS;
      };
      const _captureMem = (imports) => {
        if (!_capturedMem && imports) {
          _capturedMem = imports.env?.memory
                      ?? imports['wasi_snapshot_preview1']?.memory;
        }
      };
      const _captureTable = (exports) => {
        if (!_capturedTable && exports) {
          _capturedTable = exports.__indirect_function_table
                        ?? exports.table
                        ?? null;
        }
        // Keep the full exports object so JS code can call WASM symbols that
        // were exported via wasm-ld --export-if-defined but that Emscripten's
        // JS glue did NOT wrap (i.e. absent from EXPORTED_FUNCTIONS).
        if (!_capturedExports && exports) _capturedExports = exports;
      };
      // Helper: capture the WASM binary bytes from either an ArrayBuffer or any
      // TypedArray view (Uint8Array etc.).  Single-file Emscripten builds embed
      // the WASM as a base64 data-URI and decode it to a Uint8Array before
      // calling WebAssembly.instantiate, so we must handle both forms.
      const _captureWasmBinary = (source) => {
        if (_capturedWasm) return;
        if (source instanceof ArrayBuffer) {
          _capturedWasm = source;
        } else if (ArrayBuffer.isView(source) && source.buffer instanceof ArrayBuffer) {
          _capturedWasm = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
        }
      };
      WebAssembly.instantiate = (source, imports) => {
        _captureMem(imports);
        _captureWasmBinary(source);
        return _origInst.call(WebAssembly, source, imports).then(result => {
          _captureTable(result?.instance?.exports);
          if (!_capturedModule) _capturedModule = result?.module;
          return result;
        });
      };
      WebAssembly.instantiateStreaming = (source, imports) => {
        _captureMem(imports);
        return _origInstS.call(WebAssembly, source, imports).then(result => {
          _captureTable(result?.instance?.exports);
          if (!_capturedModule) _capturedModule = result?.module;
          return result;
        });
      };

      // Pre-configure the Emscripten Module before the script runs.
      // Standard Emscripten glue checks for a pre-existing global named 'Module'
      // (or occasionally the build-configured name); we set both so either works.
      const modCfg = {
        noInitialRun: true,
        onRuntimeInitialized() {
          _restoreWA();
          clearTimeout(timeout);

          const live = this;

          // Synthesise any missing HEAP views from the captured WebAssembly.Memory.
          // The getter pattern keeps views valid after wasm linear-memory growth:
          // _capturedMem.buffer always returns the current (possibly regrown)
          // ArrayBuffer, and we re-wrap it in a new TypedArray only when the
          // buffer object identity changes.
          if (_capturedMem && !live.HEAPU8) {
            const cached = {};
            const getView = (Ctor, key) => {
              const buf = _capturedMem.buffer;
              if (!cached[key] || cached[key].buffer !== buf) cached[key] = new Ctor(buf);
              return cached[key];
            };
            Object.defineProperties(live, {
              HEAPU8:  { get: () => getView(Uint8Array,  'u8'),  configurable: true },
              HEAPU16: { get: () => getView(Uint16Array, 'u16'), configurable: true },
              HEAPU32: { get: () => getView(Uint32Array, 'u32'), configurable: true },
              HEAP8:   { get: () => getView(Int8Array,   'i8'),  configurable: true },
              HEAP16:  { get: () => getView(Int16Array,  'i16'), configurable: true },
              HEAP32:  { get: () => getView(Int32Array,  'i32'), configurable: true },
            });
          }

          // Attach the captured function table if the module doesn't expose one.
          // Cores compiled without ALLOW_TABLE_GROWTH=1 / addFunction won't set
          // Module.wasmTable or Module.__indirect_function_table themselves, but
          // the table is always present as a wasm export and we captured it above.
          if (_capturedTable && !live.wasmTable && !live.__indirect_function_table) {
            live.__indirect_function_table = _capturedTable;
          }

          // Expose the raw WASM module exports.  Symbols exported via wasm-ld
          // --export-if-defined (e.g. emscripten_GetProcAddress for n64wasm) are
          // available here even when Emscripten's JS glue didn't create Module._xxx
          // wrappers for them (that only happens for EXPORTED_FUNCTIONS entries).
          if (_capturedExports && !live._wasmExports) {
            live._wasmExports = _capturedExports;
          }
          if (_capturedWasm && !live._wasmBinary) {
            live._wasmBinary = _capturedWasm;
          }
          if (_capturedModule && !live._wasmModule) {
            live._wasmModule = _capturedModule;
          }

          // ── Debug: surface export availability for GL proc-address diagnosis ─
          {
            const _hasGlue   = typeof live._emscripten_GetProcAddress === 'function';
            const _hasRaw    = typeof _capturedExports?.emscripten_GetProcAddress === 'function';
            const _glKeys    = live.GL ? Object.keys(live.GL).filter(k => /proc|address/i.test(k)) : [];
            const _tableSlot = live.wasmTable ? 'wasmTable'
                             : live.__indirect_function_table ? '__indirect_function_table'
                             : 'NONE';
            console.log(
              '[LibretroAdapter] Core ready.' ,
              '| _emscripten_GetProcAddress (JS glue):', _hasGlue,
              '| (raw WASM export):', _hasRaw,
              '| GL proc methods:', _glKeys.join(', ') || '(none)',
              '| addFunction:', typeof live.addFunction === 'function',
              '| table:', _tableSlot,
            );
          }

          resolve(live);
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
          _restoreWA();
          clearTimeout(timeout);
          URL.revokeObjectURL(blobUrl);
          reject(new Error('Core script failed to execute — check browser console for details'));
        };
        script.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });
        script.src = blobUrl;
        document.head.appendChild(script);
      } catch (err) {
        _restoreWA();
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
    // 2D context obtained lazily in _resize() for software-rendered cores.
    // Hardware-rendered (GL) cores use a WebGL2 context instead; the two are
    // mutually exclusive on the same canvas element.
    this.ctx       = null;

    this._imageData   = null;
    this._frameBuffer = null;   // Uint32Array view into _imageData.data
    this._width       = 0;
    this._height      = 0;
    this._pixelFormat = LibretroAdapter.PIXEL_FORMAT.RGB1555;
    this._dirty       = false;

    // Hardware (GL) rendering state — populated by the SET_HW_RENDER handler.
    this._hwRender       = false;  // true when the core uses OpenGL rendering
    this._hwContextReset = 0;      // WASM table index of retro_hw_context_reset_t

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

  // ── Static WASM diagnostics ──────────────────────────────────────────────────

  /**
   * Parse the WASM 'name' custom section from a WebAssembly.Module and return
   * the name of the function at the given function index, or null if not found.
   * The 'name' section is emitted by emcc with -g / --profiling-funcs; if it's
   * absent the return value is null and the caller should fall back to the index.
   */
  static _wasmFunctionName(module, funcIdx) {
    if (!(module instanceof WebAssembly.Module)) return null;
    let sections;
    try { sections = WebAssembly.Module.customSections(module, 'name'); }
    catch (_) { return null; }
    if (!sections?.length) return null;
    const b = new Uint8Array(sections[0]);
    function uleb(p) {
      let r = 0, s = 0, x;
      do { x = b[p++]; r |= (x & 0x7F) << s; s += 7; } while (x & 0x80);
      return [r, p];
    }
    let p = 0;
    while (p < b.length) {
      const sub = b[p++];
      const [slen, p2] = uleb(p); p = p2;
      const end = p + slen;
      if (sub === 1) { // function names subsection
        const [count, p3] = uleb(p); p = p3;
        for (let i = 0; i < count && p < end; i++) {
          const [idx,  p4] = uleb(p);  p = p4;
          const [nlen, p5] = uleb(p);  p = p5;
          const name = new TextDecoder().decode(b.slice(p, p + nlen)); p += nlen;
          if (idx === funcIdx) return name;
        }
        return null; // not in section
      }
      p = end; // skip other subsections
    }
    return null;
  }

  /**
   * Minimal WASM binary parser: reads the call_indirect type at byte offset
   * `fileOff` (from file start) and returns a human-readable string like
   * "(i32, i32) → void".  Used in catch blocks after a signature-mismatch trap.
   */
  static _parseCallIndirectType(wasmBuf, fileOff) {
    const b = new Uint8Array(wasmBuf);
    // LEB128 unsigned decoder — returns [value, nextOffset]
    function uleb(p) {
      let r = 0, s = 0, x;
      do { x = b[p++]; r |= (x & 0x7F) << s; s += 7; } while (x & 0x80);
      return [r, p];
    }
    const wt = { 0x7F: 'i32', 0x7E: 'i64', 0x7D: 'f32', 0x7C: 'f64' };
    if (b[fileOff] !== 0x11) {
      return `byte 0x${b[fileOff]?.toString(16) ?? '??'} at 0x${fileOff.toString(16)} (expected 0x11=call_indirect)`;
    }
    const [typeIdx] = uleb(fileOff + 1);
    let p = 8; // skip magic + version
    while (p < b.length) {
      const sid = b[p++];
      const [slen, p2] = uleb(p);
      if (sid === 1) { // Type section
        let tp = p2;
        const [, tp2] = uleb(tp); tp = tp2; // skip type count
        for (let i = 0; i <= typeIdx; i++) {
          if (b[tp++] !== 0x60) return `type[${typeIdx}]: expected 0x60 marker at #${i}`;
          const [np, tp3] = uleb(tp); tp = tp3;
          const params = [...b.slice(tp, tp + np)].map(v => wt[v] ?? `0x${v.toString(16)}`); tp += np;
          const [nr, tp4] = uleb(tp); tp = tp4;
          const rets  = [...b.slice(tp, tp + nr)].map(v => wt[v] ?? `0x${v.toString(16)}`); tp += nr;
          if (i === typeIdx) {
            return `type[${typeIdx}]: (${params.join(', ')}) → ${rets.join(', ') || 'void'}`;
          }
        }
        return `typeIdx ${typeIdx} out of range`;
      }
      p = p2 + slen;
    }
    return 'Type section not found in binary';
  }

  /**
   * Log the WASM type of every registered callback by reading it back from the
   * function table.  WebAssembly.Function#type() is part of the Type Reflection
   * proposal (Chrome 95+, Firefox 91+) and returns { parameters, results }.
   */
  _logCallbackTypes(label = '') {
    const M = this.M;
    const tbl = M.wasmTable ?? M.__indirect_function_table;
    const entries = {
      env:         this._callbacks?.env,
      video:       this._callbacks?.video,
      audioSample: this._callbacks?.audioSample,
      audioBatch:  this._callbacks?.audioBatch,
      inputPoll:   this._callbacks?.inputPoll,
      inputState:  this._callbacks?.inputState,
      fboFn:       this._hwFboFn,
      procFn:      this._hwProcFn,
    };
    for (const [name, idx] of Object.entries(entries)) {
      if (typeof idx !== 'number') continue;
      try {
        const fn = tbl?.get(idx);
        let typeStr = '(type() N/A)';
        if (fn && typeof fn.type === 'function') {
          const t = fn.type();
          typeStr = `(${(t.parameters ?? []).join(', ')}) → ${(t.results ?? []).join(', ') || 'void'}`;
        }
        console.error(`  ${label}callback.${name} idx=${idx} type=${typeStr}`);
      } catch (e) {
        console.error(`  ${label}callback.${name} idx=${idx} type-check threw: ${e.message}`);
      }
    }
  }

  // ── Callback registration ────────────────────────────────────────────────────

  /**
   * Register a JavaScript function in the WASM function table and return its index.
   *
   * Tries Module.addFunction first (requires the core to be compiled with
   * ALLOW_TABLE_GROWTH=1 and EXPORTED_RUNTIME_METHODS=['addFunction']).
   *
   * Falls back to direct WebAssembly.Table manipulation, which works in all
   * modern browsers regardless of Emscripten build flags, because the reference
   * types proposal (funcref tables accepting JS callables) is universally
   * supported since Chrome 96 / Firefox 79 / Safari 15.
   *
   * @param {Function} jsFunc  JavaScript function to register
   * @param {string}   sig     Emscripten type signature (e.g. 'iii', 'viiii')
   * @returns {number}  function table index (== C function pointer)
   */
  _addFn(jsFunc, sig) {
    const M = this.M;

    // Path 1: standard Emscripten addFunction
    if (typeof M.addFunction === 'function') {
      return M.addFunction(jsFunc, sig);
    }

    // Path 2: direct WebAssembly.Table manipulation.
    // Emscripten exposes the function table as Module.wasmTable (older builds)
    // or Module.__indirect_function_table (Emscripten 2.x+).
    const table = M.wasmTable ?? M.__indirect_function_table;
    if (!(table instanceof WebAssembly.Table)) {
      throw new Error(
        'LibretroAdapter: cannot register callbacks — core must be compiled with ' +
        'ALLOW_TABLE_GROWTH=1 and EXPORTED_RUNTIME_METHODS=["addFunction"], or the ' +
        'WebAssembly.Table must be accessible via Module.wasmTable / ' +
        'Module.__indirect_function_table'
      );
    }

    // Wrap the JS function as a typed WebAssembly.Function so that
    // call_indirect's runtime type-check passes.  A plain JS function has no
    // wasm type annotation; placing it in the table without one causes a
    // "function signature mismatch" trap when the core calls it.
    // WebAssembly.Function (Type Reflections proposal) is available since
    // Chrome 95 / Firefox 91 / Safari 15 — the same baseline we already
    // require for WebAssembly.Table.grow().
    const emscSigToWasmType = (s) => {
      const v = { i: 'i32', j: 'i64', f: 'f32', d: 'f64', p: 'i32' };
      return {
        parameters: [...s.slice(1)].map(c => v[c] ?? 'i32'),
        results:    s[0] === 'v' ? [] : [v[s[0]] ?? 'i32'],
      };
    };
    const typedFn = typeof WebAssembly.Function === 'function'
      ? new WebAssembly.Function(emscSigToWasmType(sig), jsFunc)
      : jsFunc; // last-resort fallback for engines without type-reflection

    // Try to grow the table by one slot and claim it.
    // If the table was created with a fixed maximum (grow() throws RangeError),
    // scan from index 1 for a null slot left by a previous removeFunction() call.
    try {
      const idx = table.length;
      table.grow(1);
      table.set(idx, typedFn);
      return idx;
    } catch (_growErr) {
      for (let i = 1; i < table.length; i++) {
        try {
          if (table.get(i) === null) {
            table.set(i, typedFn);
            return i;
          }
        } catch (_) { /* some slots may not be readable; skip */ }
      }
      throw new Error('LibretroAdapter: WASM function table is full — no slots available for callbacks');
    }
  }

  /**
   * Register all required libretro callbacks with the core and call retro_init().
   * Must be called before loadROM().
   */
  _registerCallbacks() {
    // bool env(unsigned cmd, void *data)
    this._callbacks.env = this._addFn(
      (cmd, data) => this._onEnvironment(cmd, data) ? 1 : 0,
      'iii');

    // void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch)
    this._callbacks.video = this._addFn(
      (dataPtr, width, height, pitch) => this._onVideoRefresh(dataPtr, width, height, pitch),
      'viiii');

    // void audio_sample(int16_t left, int16_t right)
    this._callbacks.audioSample = this._addFn((left, right) => {
      if (this._audioMuted) return;
      this._singleSampleBuf[0] = left;
      this._singleSampleBuf[1] = right;
      this._flushSamples(this._singleSampleBuf, 1);
    }, 'vii');

    // size_t audio_sample_batch(const int16_t *data, size_t frames)
    this._callbacks.audioBatch = this._addFn(
      (dataPtr, frames) => this._onAudioBatch(dataPtr, frames),
      'iii');

    // void input_poll(void)  — input is already snapshotted before step(); no-op here
    this._callbacks.inputPoll = this._addFn(() => {}, 'v');

    // int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id)
    this._callbacks.inputState = this._addFn(
      (port, device, index, id) => this._onInputState(port, device, index, id),
      'iiiii');

    const M = this.M;
    M._retro_set_environment(this._callbacks.env);
    M._retro_set_video_refresh(this._callbacks.video);
    M._retro_set_audio_sample(this._callbacks.audioSample);
    M._retro_set_audio_sample_batch(this._callbacks.audioBatch);
    M._retro_set_input_poll(this._callbacks.inputPoll);
    M._retro_set_input_state(this._callbacks.inputState);

    console.log('[LibretroAdapter] callbacks registered:',
      'env='        + this._callbacks.env,
      'video='      + this._callbacks.video,
      'audioSample='+ this._callbacks.audioSample,
      'audioBatch=' + this._callbacks.audioBatch,
      'inputPoll='  + this._callbacks.inputPoll,
      'inputState=' + this._callbacks.inputState,
    );

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
        this._pixelFormat = M.HEAPU32[data >> 2];
        return true;

      case ENV.GET_CAN_DUPE:
        // Signal that we accept duplicate/null frame pointers (CAN_DUPE=true).
        // This lets the core skip sending identical frames and saves CPU.
        M.HEAPU8[data] = 1;
        return true;

      case ENV.GET_SYSTEM_DIRECTORY:
      case ENV.GET_SAVE_DIRECTORY:
        // Return NULL pointer — no persistent filesystem is available in the browser.
        M.HEAPU32[data >> 2] = 0;
        return true;

      case ENV.GET_VARIABLE:
        // The core is asking for a configuration variable value.
        // Return NULL to instruct the core to use its built-in default.
        M.HEAPU32[(data + 4) >> 2] = 0;
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
        // Core wants a logging callback.
        //
        // struct retro_log_callback { retro_log_printf_t log; }
        // retro_log_printf_t = void (*)(enum retro_log_level, const char *fmt, ...)
        //
        // Emscripten compiles C '...' varargs by passing an extra i32 pointer to
        // a stack-allocated va_list, making the WASM type:
        //   (i32 level, i32 fmt_ptr, i32 va_ptr) → void  →  addFunction sig 'viii'
        //
        // If we return false here the core leaves its log_printf pointer at NULL
        // (table index 0).  The first call_indirect[viii](0, …) then traps with
        // "function signature mismatch" because function 0 has type () → void.
        if (!this._logCallbackFn) {
          this._logCallbackFn = this._addFn((level, fmtPtr, _va) => {
            try {
              const msg = M.UTF8ToString(fmtPtr).trimEnd();
              if (!msg) return;
              // level: 0=DEBUG 1=INFO 2=WARN 3=ERROR
              const con = level >= 3 ? console.error
                        : level === 2 ? console.warn
                        : console.log;
              con('[core]', msg);
            } catch (_) {}
          }, 'viii');
        }
        M.HEAPU32[data >> 2] = this._logCallbackFn;
        return true;
      }

      // Silently acknowledge commands that need no action from our frontend.
      case ENV.SET_PERFORMANCE_LEVEL:
      case ENV.SET_VARIABLES:
      case ENV.GET_VARIABLE_UPDATE:
      case ENV.SET_SUPPORT_NO_GAME:
      case ENV.GET_USERNAME:
      case ENV.GET_LANGUAGE:
      case ENV.SET_CORE_OPTIONS:
      case ENV.SET_CORE_OPTIONS_V2:
      case ENV.SET_CORE_OPTIONS_V2_INTL:
        return true;

      case ENV.SET_HW_RENDER: {
        // retro_hw_render_callback layout (32-bit WASM, natural alignment):
        //   context_type            (enum/u32)  offset  0
        //   context_reset           (fn ptr)    offset  4
        //   get_current_framebuffer (fn ptr)    offset  8
        //   get_proc_address        (fn ptr)    offset 12
        //   depth / stencil / bottom_left_origin (3×bool) offset 16–18
        //   version_major / version_minor       (2×u32)   offset 20–24
        const ctxType  = M.HEAPU32[(data     ) >> 2];  // RETRO_HW_CONTEXT_* enum
        const ctxReset = M.HEAPU32[(data +  4) >> 2];  // fn ptr: called when GL ready

        // Vulkan (7) is not supported; everything else maps to WebGL2.
        if (ctxType === 7 /* RETRO_HW_CONTEXT_VULKAN */) return false;

        // Obtain a WebGL2 context on the game canvas.  This must happen before
        // retro_init returns; deferring is not possible.
        const gl = this.canvas.getContext('webgl2');
        if (!gl) {
          console.warn('[LibretroAdapter] WebGL2 unavailable; hardware-rendered core will not load.');
          return false;
        }

        // Register the WebGL2 context with Emscripten's GL module so that the
        // core's compiled-in glXxx() calls are routed to this canvas via the
        // standard Emscripten WebGL→OpenGL translation layer.
        if (typeof M.GL?.registerContext === 'function') {
          const handle = M.GL.registerContext(gl, { majorVersion: 2, minorVersion: 0 });
          M.GL.makeContextCurrent(handle);
        }

        // get_current_framebuffer: always return 0 (the default WebGL FBO).
        const fboFn = this._addFn(() => 0, 'i');
        M.HEAPU32[(data +  8) >> 2] = fboFn;

        // get_proc_address: GLideN64 calls rglgen_resolve_symbols() with this
        // callback to obtain WASM table indices for every GL entry point it uses.
        // Null (0) pointers cause a "function signature mismatch" WASM trap
        // on the first indirect call, so we must return real indices.
        //
        // Resolution priority:
        //  1. _emscripten_GetProcAddress (exported after rebuilding with the
        //     updated build-core.sh that adds --export-if-defined=…).
        //  2. Module.GL.getProcAddress / getWebGLProcAddress (Emscripten GL
        //     module internal — present in some Emscripten versions).
        //  3. Warn and return 0; retro_load_game will trap → rebuild is required.
        const glProcCache = Object.create(null);
        const GL = M.GL;

        // Debug: log what's available before choosing a resolution strategy.
        console.log(
          '[LibretroAdapter] SET_HW_RENDER ctxType=' + ctxType + ' ctxReset=' + ctxReset,
          '| _emscripten_GetProcAddress (glue):', typeof M._emscripten_GetProcAddress,
          '| _wasmExports.emscripten_GetProcAddress (raw):', typeof M._wasmExports?.emscripten_GetProcAddress,
          '| GL.getProcAddress:', typeof M.GL?.getProcAddress,
          '| GL.getWebGLProcAddress:', typeof M.GL?.getWebGLProcAddress,
          '| GL.procAddressLookup:', typeof M.GL?.procAddressLookup,
        );

        // Build a resolver function once, checking capabilities eagerly.
        // Resolution priority:
        //  1. Module._emscripten_GetProcAddress  — created by Emscripten's JS glue
        //     when the symbol is in EXPORTED_FUNCTIONS (fully correct path).
        //  2. M._wasmExports.emscripten_GetProcAddress  — the raw WebAssembly
        //     ExportedFunction; present when the symbol was exported via wasm-ld
        //     --export-if-defined but not listed in EXPORTED_FUNCTIONS.  Directly
        //     callable from JS with integer arguments; works after the n64wasm rebuild.
        //  3. Module.GL internal proc-address API (varies by Emscripten version).
        //  4. Return 0 with a clear rebuild hint.
        const _rawGetProcAddr =
          (typeof M._emscripten_GetProcAddress === 'function'
            ? M._emscripten_GetProcAddress
            : null)
          ?? (typeof M._wasmExports?.emscripten_GetProcAddress === 'function'
            ? M._wasmExports.emscripten_GetProcAddress
            : null);

        const _glProcResolve = (() => {
          if (_rawGetProcAddr) {
            const _path = typeof M._emscripten_GetProcAddress === 'function' ? 1 : 2;
            console.log('[LibretroAdapter] get_proc_address: using Path ' + _path +
              ' (' + (_path === 1 ? 'Module._emscripten_GetProcAddress' : '_wasmExports direct') + ')');
            let _callCount = 0;
            let _zeroCount = 0;
            // Paths 1 & 2: pass the C string pointer directly to the WASM function.
            return (namePtr) => {
              const result = _rawGetProcAddr(namePtr) | 0;
              if (_callCount < 20) {
                try {
                  console.log('[LibretroAdapter] get_proc_address[' + _callCount + ']',
                    M.UTF8ToString(namePtr), '→', result);
                } catch (_) {}
              } else if (_callCount === 20) {
                console.log('[LibretroAdapter] get_proc_address: (further calls suppressed)');
              }
              if (result === 0) {
                _zeroCount++;
                try {
                  console.warn('[LibretroAdapter] get_proc_address: ZERO index for',
                    M.UTF8ToString(namePtr), '— this GL fn is unresolved and will trap on call_indirect');
                } catch (_) {}
              }
              _callCount++;
              return result;
            };
          }
          // Path 3: Emscripten GL module internals (JS-string API, varies by version).
          const glLookup = GL?.getProcAddress?.bind(GL)
                        ?? GL?.getWebGLProcAddress?.bind(GL)
                        ?? GL?.procAddressLookup?.bind(GL);
          if (typeof glLookup === 'function') {
            console.log('[LibretroAdapter] get_proc_address: using Path 3 (GL internal API)');
            return (namePtr) => {
              const name = M.UTF8ToString(namePtr);
              if (name in glProcCache) return glProcCache[name];
              return (glProcCache[name] = glLookup(name) | 0);
            };
          }
          // Path 4: no resolver — warn once, return 0, retro_load_game will trap.
          console.error(
            '[LibretroAdapter] get_proc_address: Path 4 — no resolver found.',
            '_emscripten_GetProcAddress is missing from WASM exports.',
            'Every GL function pointer will be 0; retro_load_game WILL trap.',
            'Fix: rebuild the n64wasm core:  scripts/build-core.sh n64wasm',
          );
          return (namePtr) => 0;
        })();
        const procFn = this._addFn(_glProcResolve, 'ii');
        M.HEAPU32[(data + 12) >> 2] = procFn;
        console.log('[LibretroAdapter] procFn registered at table index', procFn,
          '| fboFn at', fboFn);

        // Sanity-probe: call _glProcResolve directly from JS with a well-known GL
        // symbol to verify it returns a non-zero table index before retro_load_game
        // runs.  A zero result means emscripten_GetProcAddress can't find the symbol
        // (it's absent from the -lGL build) and every call_indirect through it will
        // produce "function signature mismatch".
        try {
          const _probe = (name) => {
            const enc  = new TextEncoder().encode(name + '\0');
            const ptr  = M._malloc(enc.length);
            if (!ptr) return null;
            M.HEAPU8.set(enc, ptr);
            const idx  = _glProcResolve(ptr);
            M._free(ptr);
            return idx;
          };
          const probes = ['glActiveTexture', 'glBindTexture', 'glDrawElements', 'glGetError'];
          for (const name of probes) {
            const idx = _probe(name);
            console.log('[LibretroAdapter] probe', name, '→', idx,
              idx === 0 ? '⚠ ZERO — missing from -lGL build' : '✓');
          }
        } catch (probeErr) {
          console.warn('[LibretroAdapter] proc address probe threw:', probeErr);
        }

        this._hwRender       = true;
        this._hwContextReset = ctxReset;
        this._hwFboFn        = fboFn;
        this._hwProcFn       = procFn;
        return true;
      }

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
    if (this._hwRender) {
      // Core rendered directly to the WebGL framebuffer (RETRO_HW_FRAME_BUFFER_VALID).
      // Emscripten's GL→WebGL layer has already updated the canvas; nothing to blit.
      if (width !== this._width || height !== this._height) this._resize(width, height);
      this._dirty = true;
      return;
    }

    if (!dataPtr) return;  // null = duplicate frame (CAN_DUPE); nothing to do

    if (width !== this._width || height !== this._height) this._resize(width, height);

    const buf = this._frameBuffer;
    if (!buf) return;  // resize failed or ROM not yet loaded
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
    if (width <= 0 || height <= 0) return;
    this.canvas.width  = width;
    this.canvas.height = height;
    this._width  = width;
    this._height = height;
    // Hardware-rendered cores draw directly to the WebGL canvas; no ImageData needed.
    if (this._hwRender) return;
    // Lazily obtain the 2D context for software-rendered cores (canvas must not
    // have a WebGL context already, which is guaranteed by the hwRender guard above).
    if (!this.ctx) this.ctx = this.canvas.getContext('2d');
    // Create ImageData; if it throws (invalid dimensions) leave existing state
    // intact so subsequent calls with valid dimensions can still succeed.
    const imageData = this.ctx.createImageData(width, height);
    this._imageData   = imageData;
    this._frameBuffer = new Uint32Array(imageData.data.buffer);
  }

  // ── Audio callbacks ──────────────────────────────────────────────────────────

  _onAudioBatch(dataPtr, frames) {
    if (!this._audioMuted && this._workletNode && frames > 0) {
      // HEAPU16 is the unsigned 16-bit view; _flushSamples sign-extends each
      // sample via (raw << 16) >> 16 so negative values are handled correctly.
      this._flushSamples(this.M.HEAPU16, frames, dataPtr >> 1);
    }
    return frames;
  }

  /**
   * Convert int16 interleaved stereo samples to Float32 and post to the worklet.
   * @param {Uint16Array|Int16Array} src    source buffer (HEAPU16 or _singleSampleBuf)
   * @param {number}                 frames number of stereo sample pairs to convert
   * @param {number}                 [offset=0]  index offset into src
   */
  _flushSamples(src, frames, offset = 0) {
    if (!this._workletNode) return;
    const f32 = new Float32Array(frames * 2);
    // (raw << 16) >> 16 reinterprets a Uint16 bit-pattern as signed int16;
    // it is a no-op for Int16Array values already in [-32768, 32767].
    for (let i = 0; i < frames * 2; i++) f32[i] = ((src[offset + i] << 16) >> 16) / 32768.0;
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
    // AudioWorklet is only available in secure contexts (HTTPS / localhost).
    // Detect this early so we don't create an AudioContext we immediately discard.
    if (!window.isSecureContext) {
      console.warn('[LibretroAdapter] AudioWorklet requires HTTPS; audio disabled.');
      return;
    }
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
      // Close any partially-initialised AudioContext to avoid a resource leak.
      if (this._audioCtx) { this._audioCtx.close().catch(() => {}); }
      console.warn('[LibretroAdapter] AudioWorklet setup failed, audio disabled:', err);
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
    const rawBuf = await resp.arrayBuffer();
    const buf    = LibretroAdapter._normalizeN64Rom(rawBuf);

    await this._initAudio();

    const M = this.M;

    // Query retro_system_info before loading.
    // retro_system_info layout (32-bit WASM):
    //   library_name (char*)    offset  0
    //   library_version (char*) offset  4
    //   valid_extensions (char*)offset  8
    //   need_fullpath (bool)    offset 12
    //   block_extract (bool)    offset 13
    // Allocate 20 bytes for safety alignment.
    const sysInfoPtr = M._malloc(20);
    M._retro_get_system_info(sysInfoPtr);
    const needFullPath = M.HEAPU8[sysInfoPtr + 12] !== 0;
    M._free(sysInfoPtr);

    // Extract the filename (e.g. "mario.sfc") for path/extension sniffing.
    const filename = new URL(url, location.href).pathname.split('/').filter(Boolean).pop() ?? 'rom';

    let ok = false;

    if (needFullPath) {
      // ── Virtual-FS path ────────────────────────────────────────────────────
      // The core calls fopen() itself; it cannot use an in-memory data pointer.
      // Write the ROM bytes into Emscripten's in-memory virtual filesystem so
      // the core can open them via a normal C path.
      // M.FS may not be exported; fall back to the global FS injected by the
      // Emscripten glue.
      const FS = M.FS ?? globalThis.FS;
      if (!FS) {
        throw new Error(
          'This core requires a filesystem path (need_fullpath=true) but the ' +
          'Emscripten FS module is not accessible.  Recompile the core with ' +
          'EXPORTED_RUNTIME_METHODS=[\'FS\'] or ensure it is otherwise exported.'
        );
      }

      const virtPath = `/tmp/${filename}`;
      try { FS.mkdir('/tmp'); } catch (_) { /* already exists */ }
      FS.writeFile(virtPath, new Uint8Array(buf));

      // Write the virtual path as a C string on the wasm heap.
      const pathBytes = new TextEncoder().encode(virtPath + '\0');
      const pathPtr   = M._malloc(pathBytes.length);
      if (pathPtr) M.HEAPU8.set(pathBytes, pathPtr);

      // Build retro_game_info: path set, data/size cleared.
      const infoPtr = M._malloc(16);
      if (!infoPtr) {
        if (pathPtr) M._free(pathPtr);
        try { FS.unlink(virtPath); } catch (_) {}
        throw new Error('WASM heap exhausted allocating retro_game_info struct');
      }
      M.HEAPU32[(infoPtr     ) >> 2] = pathPtr || 0;
      M.HEAPU32[(infoPtr +  4) >> 2] = 0;              // data = NULL
      M.HEAPU32[(infoPtr +  8) >> 2] = 0;              // size = 0
      M.HEAPU32[(infoPtr + 12) >> 2] = 0;              // meta = NULL

      try {
        ok = M._retro_load_game(infoPtr);
      } catch (wasmErr) {
        console.error('[LibretroAdapter] retro_load_game() trapped in WASM (FS path).');
        console.error('  error message :', wasmErr.message);
        console.error('  stack         :', wasmErr.stack ?? '(no stack)');
        console.error('  hwRender      :', this._hwRender);
        console.error('  hwContextReset:', this._hwContextReset);
        // Identify the failing call_indirect and the function that contains it.
        {
          const fnName = LibretroAdapter._wasmFunctionName(M._wasmModule, 3375);
          console.error('  wasm-function[3375] name:', fnName ?? '(name section absent — build with -g or --profiling-funcs)');
        }
        if (M._wasmBinary) {
          try {
            console.error('  call_indirect[0x17f489]:',
              LibretroAdapter._parseCallIndirectType(M._wasmBinary, 0x17f489));
          } catch (pe) { console.error('  WASM parse error:', pe.message); }
        } else {
          console.error('  _wasmBinary: not captured (single-file build? try providing a separate wasmUrl)');
        }
        this._logCallbackTypes('FS ');
        M._free(infoPtr);
        if (pathPtr) M._free(pathPtr);
        try { FS.unlink(virtPath); } catch (_) {}
        throw new Error(
          'retro_load_game() trapped in WASM (' + wasmErr.message + '). ' +
          'See call_indirect / callback type info above for root cause.'
        );
      }
      M._free(infoPtr);
      if (pathPtr) M._free(pathPtr);
      // The core has already opened (and typically fully read) the file.
      // Unlink it now; Emscripten MEMFS keeps the data alive until the last
      // file descriptor is closed, matching POSIX unlink-while-open semantics.
      try { FS.unlink(virtPath); } catch (_) {}

    } else {
      // ── In-memory path ─────────────────────────────────────────────────────
      // Copy ROM bytes onto the WASM heap so we can pass a pointer to the core.
      const romPtr = M._malloc(buf.byteLength);
      if (!romPtr) throw new Error('WASM heap exhausted allocating ROM buffer');
      M.HEAPU8.set(new Uint8Array(buf), romPtr);

      // Write the filename as a null-terminated C string for extension sniffing.
      const pathBytes = new TextEncoder().encode(filename + '\0');
      const pathPtr   = M._malloc(pathBytes.length);
      if (pathPtr) M.HEAPU8.set(pathBytes, pathPtr);

      // Build retro_game_info on the heap.
      // struct { const char *path; const void *data; size_t size; const char *meta; }
      // 4 × 4 bytes = 16 bytes on 32-bit WASM.
      const infoPtr = M._malloc(16);
      if (!infoPtr) {
        if (pathPtr) M._free(pathPtr);
        M._free(romPtr);
        throw new Error('WASM heap exhausted allocating retro_game_info struct');
      }
      M.HEAPU32[(infoPtr     ) >> 2] = pathPtr || 0;
      M.HEAPU32[(infoPtr +  4) >> 2] = romPtr;
      M.HEAPU32[(infoPtr +  8) >> 2] = buf.byteLength;
      M.HEAPU32[(infoPtr + 12) >> 2] = 0;              // meta = NULL

      try {
        ok = M._retro_load_game(infoPtr);
      } catch (wasmErr) {
        console.error('[LibretroAdapter] retro_load_game() trapped in WASM.');
        console.error('  error message :', wasmErr.message);
        console.error('  stack         :', wasmErr.stack ?? '(no stack)');
        console.error('  hwRender      :', this._hwRender);
        console.error('  hwContextReset:', this._hwContextReset);
        // Identify the failing call_indirect and the function that contains it.
        {
          const fnName = LibretroAdapter._wasmFunctionName(M._wasmModule, 3375);
          console.error('  wasm-function[3375] name:', fnName ?? '(name section absent — build with -g or --profiling-funcs)');
        }
        if (M._wasmBinary) {
          try {
            console.error('  call_indirect[0x17f489]:',
              LibretroAdapter._parseCallIndirectType(M._wasmBinary, 0x17f489));
          } catch (pe) { console.error('  WASM parse error:', pe.message); }
        } else {
          console.error('  _wasmBinary: not captured (single-file build? try providing a separate wasmUrl)');
        }
        this._logCallbackTypes();
        M._free(infoPtr);
        if (pathPtr) M._free(pathPtr);
        M._free(romPtr);
        throw new Error(
          'retro_load_game() trapped in WASM (' + wasmErr.message + '). ' +
          'See call_indirect / callback type info above for root cause.'
        );
      }
      M._free(infoPtr);
      if (pathPtr) M._free(pathPtr);
      M._free(romPtr);
    }

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

    // For hardware-rendered cores, call the context_reset hook now that the
    // canvas has the correct dimensions and the GL context is active.
    // The core uses this to compile shaders, upload geometry/textures, and
    // bind the default framebuffer — the equivalent of "GL context is ready".
    if (this._hwRender && this._hwContextReset) {
      const table = M.wasmTable ?? M.__indirect_function_table;
      if (table) {
        try { table.get(this._hwContextReset)(); }
        catch (e) { console.error('[LibretroAdapter] context_reset threw:', e); }
      }
    }

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
    if (!this._dirty) return;
    this._dirty = false;
    if (this._hwRender) return;  // GL canvas already up to date; nothing to blit
    if (!this._imageData) return;
    this.ctx.putImageData(this._imageData, 0, 0);
  }

  /**
   * N64 ROMs are distributed in three byte-order variants.
   * mupen64plus-next (n64wasm) requires big-endian / .z64 layout — first word
   * must be 0x80371240.  Silently normalise .v64 and .n64 images so the core
   * never sees a mis-ordered ROM.  Buffers whose first word does not match any
   * N64 magic are returned unchanged (no-op for every other system).
   *
   * Format detection:
   *   .z64  big-endian (native)  80 37 12 40  — no conversion needed
   *   .v64  word-swapped         37 80 40 12  — swap each adjacent byte pair
   *   .n64  little-endian        40 12 37 80  — reverse each 4-byte group
   *
   * @param {ArrayBuffer} buf
   * @returns {ArrayBuffer}
   */
  static _normalizeN64Rom(buf) {
    if (buf.byteLength < 4) return buf;
    const magic = new DataView(buf).getUint32(0, false /* big-endian */);

    // Already .z64 — nothing to do.
    if (magic === 0x80371240) return buf;

    const out = new Uint8Array(buf.slice(0));

    if (magic === 0x37804012) {
      // .v64: swap every adjacent byte pair  (37 80 → 80 37, 40 12 → 12 40)
      for (let i = 0; i + 1 < out.length; i += 2) {
        const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t;
      }
      return out.buffer;
    }

    if (magic === 0x40123780) {
      // .n64: reverse each 4-byte group  (40 12 37 80 → 80 37 12 40)
      for (let i = 0; i + 3 < out.length; i += 4) {
        let t;
        t = out[i];     out[i]     = out[i + 3]; out[i + 3] = t;
        t = out[i + 1]; out[i + 1] = out[i + 2]; out[i + 2] = t;
      }
      return out.buffer;
    }

    return buf; // unrecognised magic — pass through unchanged
  }
}
