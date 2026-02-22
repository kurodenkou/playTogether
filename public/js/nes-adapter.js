/**
 * NESAdapter — JSNES wrapper implementing the RollbackEngine emulator contract
 *
 * Emulator contract:
 *   step(inputMap)   — advance one NES frame with given inputs
 *   saveState()      — snapshot mutable NES state
 *   loadState(snap)  — restore from snapshot
 *   render()         — blit current frame to canvas
 *
 * ROLLBACK-AWARE STATE DESIGN
 * ────────────────────────────
 * A naive nes.toJSON() snapshot includes romData (the full ROM string, potentially
 * hundreds of KB) and two 61 440-pixel frame buffers (buffer + bgbuffer).
 *
 * We exclude all three from every snapshot:
 *   • romData     — never changes; we nullify it before toJSON
 *   • buffer      — regenerated on each nes.frame(); we save it as a compact
 *                   Int32Array instead so loadState restores a valid last frame
 *   • bgbuffer    — background rendering scratch buffer; fully regenerated; skipped
 *   • pixrendered — scratch array; fully regenerated; skipped
 *
 * What remains is the CPU registers, MMAP/mapper registers, PPU state
 * (VRAM, sprite RAM, palette, nametables, pattern-tile pixel/opacity data),
 * and the APU (not serialised by jsnes at all, so audio may drift after rollback).
 *
 * DETERMINISM
 * ────────────
 * NES emulation is deterministic given identical ROM + input sequence.
 * All "random" behaviour in NES games derives from the CPU/PPU state machine.
 * No external entropy sources are used.
 */
class NESAdapter {
  static NES_W = 256;
  static NES_H = 240;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string[]} playerIds  ordered player IDs (index 0 → controller 1, 1 → controller 2)
   */
  constructor(canvas, playerIds) {
    this.canvas   = canvas;
    this.playerIds = playerIds;
    this.ctx      = canvas.getContext('2d');

    canvas.width  = NESAdapter.NES_W;
    canvas.height = NESAdapter.NES_H;

    // Off-screen pixel buffer for fast canvas writes
    this._imageData = this.ctx.createImageData(NESAdapter.NES_W, NESAdapter.NES_H);
    this._pixels    = new Uint32Array(this._imageData.data.buffer);

    this._frameBuffer = null;
    this._dirty       = false;

    // Cached "reduced" PPU JSON_PROPERTIES list (filled after loadROM)
    this._ppuPropsReduced = null;
    this._romLoaded       = false;

    // Button mapping: InputBits → jsnes.Controller constant
    this._btnMap = null; // set lazily after jsnes is available

    // Create NES instance
    this.nes = new jsnes.NES({
      onFrame: (buf) => {
        this._frameBuffer = buf;
        this._dirty = true;
      },
      onAudioSample: () => {
        // Audio intentionally left out for now.
        // During rollback re-simulation, audio samples would need to be
        // discarded and re-generated — implementing that cleanly requires
        // a separate audio worklet + timestamped sample queue.
      },
    });
  }

  // ── ROM loading ──────────────────────────────────────────────────────────

  /**
   * Fetch the ROM via the server-side proxy (avoids CORS) and load it.
   * @param {string} url  Public URL of the .nes ROM file
   */
  async loadROM(url) {
    const resp = await fetch(`/rom-proxy?url=${encodeURIComponent(url)}`);
    if (!resp.ok) {
      throw new Error(`ROM fetch error: HTTP ${resp.status} — ${resp.statusText}`);
    }
    const buf   = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // jsnes expects a binary string (char-per-byte) — not a Buffer or TypedArray
    let romStr = '';
    for (let i = 0; i < bytes.length; i++) {
      romStr += String.fromCharCode(bytes[i]);
    }

    this.nes.loadROM(romStr);
    this._romLoaded = true;

    // Pre-compute the PPU serialisation list without regenerable frame buffers.
    // This is read by saveState / loadState every rollback frame, so we cache it.
    const skip = new Set(['buffer', 'bgbuffer', 'pixrendered']);
    this._ppuPropsReduced = this.nes.ppu.JSON_PROPERTIES.filter(p => !skip.has(p));

    // Build the button map now that jsnes.Controller is confirmed available
    this._buildBtnMap();
  }

  _buildBtnMap() {
    const C = jsnes.Controller;
    this._btnMap = [
      [InputBits.UP,     C.BUTTON_UP],
      [InputBits.DOWN,   C.BUTTON_DOWN],
      [InputBits.LEFT,   C.BUTTON_LEFT],
      [InputBits.RIGHT,  C.BUTTON_RIGHT],
      [InputBits.A,      C.BUTTON_A],
      [InputBits.B,      C.BUTTON_B],
      [InputBits.START,  C.BUTTON_START],
      [InputBits.SELECT, C.BUTTON_SELECT],
    ];
  }

  // ── Emulator contract ─────────────────────────────────────────────────────

  /**
   * Apply inputs then advance one NES frame.
   * @param {{ [playerId]: number }} inputMap
   */
  step(inputMap) {
    if (!this._romLoaded) return;

    for (let i = 0; i < 2; i++) {
      const pid   = this.playerIds[i];
      if (!pid) continue;
      const input = inputMap[pid] ?? 0;
      const ctrl  = i + 1; // jsnes controllers are 1-indexed

      for (const [bit, btn] of this._btnMap) {
        if (input & bit) {
          this.nes.buttonDown(ctrl, btn);
        } else {
          this.nes.buttonUp(ctrl, btn);
        }
      }
    }

    this.nes.frame();
  }

  /**
   * Snapshot the mutable NES state for rollback storage.
   *
   * Excludes: romData (immutable), buffer/bgbuffer/pixrendered (regenerated each frame).
   * Includes: CPU, MMAP/mapper registers, PPU (VRAM, OAM, palette, nametables, ptTile),
   *           and a compact Int32Array copy of the current frame buffer.
   */
  saveState() {
    if (!this._romLoaded) return null;

    const ppu      = this.nes.ppu;
    const origRom  = this.nes.romData;
    const origProps = ppu.JSON_PROPERTIES;

    // Exclude regenerable fields to keep snapshot compact
    this.nes.romData      = null;
    ppu.JSON_PROPERTIES   = this._ppuPropsReduced;

    const state = structuredClone(this.nes.toJSON());

    // Restore patched fields immediately
    this.nes.romData    = origRom;
    ppu.JSON_PROPERTIES = origProps;

    // Snapshot the rendered frame buffer separately as a typed array
    // (much faster to copy than cloning via structuredClone).
    // This lets render() show the correct frame right after loadState().
    if (this._frameBuffer) {
      state._fb = Int32Array.from(this._frameBuffer);
    }

    return state;
  }

  /**
   * Restore NES state from a previously saved snapshot.
   * @param {object} snap  — value returned by saveState()
   */
  loadState(snap) {
    if (!snap || !this._romLoaded) return;

    const ppu      = this.nes.ppu;
    const origProps = ppu.JSON_PROPERTIES;

    // Use the same reduced list so fromJSON does NOT try to set
    // buffer/bgbuffer to undefined (they were not serialised).
    ppu.JSON_PROPERTIES = this._ppuPropsReduced;

    this.nes.fromJSON({ ...snap, romData: null });

    ppu.JSON_PROPERTIES = origProps;

    // Restore frame buffer so render() shows the right frame immediately
    if (snap._fb && ppu.buffer) {
      const fb = ppu.buffer;
      const src = snap._fb;
      for (let i = 0; i < src.length; i++) fb[i] = src[i];
      this._frameBuffer = fb;
    }
    this._dirty = true;
  }

  /**
   * Blit the latest NES frame to the canvas.
   * Converts the jsnes 0x00RRGGBB palette format → canvas RGBA.
   */
  render() {
    if (!this._dirty || !this._frameBuffer) return;

    const fb     = this._frameBuffer;
    const pixels = this._pixels;
    const len    = NESAdapter.NES_W * NESAdapter.NES_H;

    for (let i = 0; i < len; i++) {
      // jsnes palette: 0x00RRGGBB  →  canvas Uint32 LE: 0xAABBGGRR
      const p = fb[i];
      pixels[i] = 0xff000000     // A = 255
                | ((p & 0xff)         << 16)   // B
                | ((p & 0xff00))                // G (already in position)
                | ((p & 0xff0000) >>> 16);      // R
    }

    this.ctx.putImageData(this._imageData, 0, 0);
    this._dirty = false;
  }
}
