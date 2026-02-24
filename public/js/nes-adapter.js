/**
 * NESAdapter — JSNES wrapper implementing the RollbackEngine emulator contract
 *
 * Emulator contract:
 *   step(inputMap)   — advance one NES frame with given inputs
 *   saveState()      — snapshot mutable NES state
 *   loadState(snap)  — restore from snapshot
 *   render()         — blit current frame to canvas
 *
 * FAST BINARY SERIALIZATION
 * ──────────────────────────
 * saveState/loadState bypass nes.toJSON()/fromJSON() entirely and instead use
 * TypedArray copies which are 5-10× faster than structuredClone on large plain
 * JS Arrays at 60 fps.
 *
 * What is saved:
 *   CPU  — mem (Uint8Array 65536) + scalar registers (Int32Array 21)
 *   PPU  — vramMem (Uint8Array 32768), spriteMem (Uint8Array 256),
 *           vramMirrorTable (Uint16Array 32768), scalar registers (Int32Array 41),
 *           palettes (Uint8Array 32), ntable1 (Uint8Array 4),
 *           attrib working buffer (Uint8Array 32)
 *   NameTables — 4 × tile[1024] + attrib[1024] packed into two Uint8Array(4096)
 *   ptTile     — skipped for CHR ROM games (immutable after loadROM);
 *                saved for CHR RAM games (Uint8Array 32768 pix + Uint8Array 4096 opaque)
 *   Frame buf  — Int32Array(61440) copy of ppu.buffer so render() is correct post-rollback
 *   Mapper     — mmap.toJSON() (tiny JS object)
 *
 * What is NOT saved:
 *   romData        — immutable; already in nes.rom
 *   ppu.buffer     — saved separately as _fb for display; not via JSON path
 *   ppu.bgbuffer   — background scratch; fully regenerated each frame
 *   ppu.pixrendered — priority scratch; fully regenerated each frame
 *   ppu.scantile   — rendering working buffer; repopulated each scanline
 *
 * PIXEL FORMAT
 * ─────────────
 * jsnes framebuffer[i] = 0x00RRGGBB.
 * Canvas Uint32 (little-endian) stores bytes as [R, G, B, A] at byte offsets 0-3,
 * so the 32-bit value seen by JS is 0xAABBGGRR.
 * The identity conversion 0xFF000000 | p maps 0x00RRGGBB → 0xFFRRGGBB
 * which as LE bytes is [R, G, B, 0xFF] = correct canvas RGBA.
 * No channel swapping is needed (confirmed by the official jsnes example).
 */
class NESAdapter {
  static NES_W = 256;
  static NES_H = 240;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string[]} playerIds  ordered player IDs (index 0 → controller 1, 1 → controller 2)
   */
  constructor(canvas, playerIds) {
    this.canvas    = canvas;
    this.playerIds = playerIds;
    this.ctx       = canvas.getContext('2d');

    canvas.width  = NESAdapter.NES_W;
    canvas.height = NESAdapter.NES_H;

    // Off-screen pixel buffer for fast canvas writes
    this._imageData = this.ctx.createImageData(NESAdapter.NES_W, NESAdapter.NES_H);
    this._pixels    = new Uint32Array(this._imageData.data.buffer);

    this._frameBuffer = null;
    this._dirty       = false;
    this._romLoaded   = false;
    this._skipPtTile  = false; // true for CHR ROM games (tiles immutable after loadROM)
    this._btnMap      = null;

    // ── Audio ─────────────────────────────────────────────────────────────────
    // Ring buffer (power-of-2 size for fast modulo via bitwise AND).
    // 4096 samples @ 44100 Hz ≈ 93 ms of buffer — enough headroom for rollbacks
    // up to 4 frames deep without audible glitches.
    this._AUDIO_COUNT = 4096;
    this._AUDIO_MASK  = this._AUDIO_COUNT - 1;
    this._audioL      = new Float32Array(this._AUDIO_COUNT);
    this._audioR      = new Float32Array(this._AUDIO_COUNT);
    this._audioWrite  = 0;
    this._audioRead   = 0;
    this._audioMuted  = false;

    // AudioContext — may auto-suspend until the user interacts (browser autoplay policy).
    // We lazily resume it on the first step() call after a key press.
    this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    this.nes = new jsnes.NES({
      onFrame: (buf) => {
        this._frameBuffer = buf;
        this._dirty = true;
      },
      // Buffer stereo samples into the ring buffer.
      // onAudioSample is called at the NES APU rate (≈ audioCtx.sampleRate).
      onAudioSample: (l, r) => {
        if (this._audioMuted) return;
        this._audioL[this._audioWrite] = l;
        this._audioR[this._audioWrite] = r;
        this._audioWrite = (this._audioWrite + 1) & this._AUDIO_MASK;
      },
      sampleRate: this._audioCtx.sampleRate,
    });

    this._setupScriptProcessor();
  }

  _setupScriptProcessor() {
    // ScriptProcessorNode with 512-sample buffers, 0 inputs, 2 output channels.
    // Runs on the main thread but is scheduled by the audio thread — keeps latency low.
    const sp = this._audioCtx.createScriptProcessor(512, 0, 2);

    sp.onaudioprocess = (event) => {
      const dstL = event.outputBuffer.getChannelData(0);
      const dstR = event.outputBuffer.getChannelData(1);
      const len  = dstL.length;

      const available = (this._audioWrite - this._audioRead) & this._AUDIO_MASK;
      const toRead    = Math.min(len, available);

      // Drain ring buffer
      for (let i = 0; i < toRead; i++) {
        const idx  = (this._audioRead + i) & this._AUDIO_MASK;
        dstL[i] = this._audioL[idx];
        dstR[i] = this._audioR[idx];
      }
      // Silence for any underrun (buffer was empty)
      for (let i = toRead; i < len; i++) {
        dstL[i] = 0;
        dstR[i] = 0;
      }

      this._audioRead = (this._audioRead + toRead) & this._AUDIO_MASK;
    };

    const gain = this._audioCtx.createGain();
    gain.gain.value = 0.5;
    sp.connect(gain);
    gain.connect(this._audioCtx.destination);
    this._scriptProcessor = sp;
  }

  /**
   * Called by RollbackEngine to suppress audio during re-simulation.
   * Muted samples are discarded so the player only hears the authoritative frames.
   * @param {boolean} muted
   */
  setAudioMuted(muted) {
    this._audioMuted = muted;
  }

  stopAudio() {
    if (this._scriptProcessor) {
      this._scriptProcessor.disconnect();
      this._scriptProcessor = null;
    }
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      this._audioCtx.close();
    }
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

    // jsnes expects a binary string (char-per-byte)
    let romStr = '';
    for (let i = 0; i < bytes.length; i++) {
      romStr += String.fromCharCode(bytes[i]);
    }

    this.nes.loadROM(romStr);
    this._romLoaded  = true;
    // CHR ROM games have immutable pattern tiles — no need to save/restore ptTile
    this._skipPtTile = this.nes.rom.vromCount > 0;
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

    // Lazily resume AudioContext — browser autoplay policy suspends it until
    // the user interacts. step() is called every frame; the first call after
    // a key/click event will succeed and audio starts within one frame.
    if (this._audioCtx.state === 'suspended') {
      this._audioCtx.resume();
    }

    for (let i = 0; i < 2; i++) {
      const pid   = this.playerIds[i];
      if (!pid) continue;
      const input = inputMap[pid] ?? 0;
      const ctrl  = i + 1; // jsnes controllers are 1-indexed

      for (const [bit, btn] of this._btnMap) {
        if (input & bit) this.nes.buttonDown(ctrl, btn);
        else             this.nes.buttonUp(ctrl, btn);
      }
    }

    this.nes.frame();
  }

  /**
   * Fast binary snapshot of the mutable NES state.
   * Bypasses nes.toJSON() to avoid expensive structuredClone of large plain JS Arrays.
   */
  saveState() {
    if (!this._romLoaded) return null;

    const cpu  = this.nes.cpu;
    const ppu  = this.nes.ppu;
    const mmap = this.nes.mmap;

    // ── CPU ──────────────────────────────────────────────────────────────────

    // Full 6502 address space: 65536 bytes (dominant serialisation cost)
    const cpuMem = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) cpuMem[i] = cpu.mem[i];

    // CPU scalar registers — 21 fields packed into one Int32Array
    const cpuRegs = new Int32Array([
      cpu.cyclesToHalt,
      cpu.irqRequested ? 1 : 0,
      cpu.irqType,
      cpu.REG_ACC, cpu.REG_X, cpu.REG_Y, cpu.REG_SP,
      cpu.REG_PC,  cpu.REG_PC_NEW, cpu.REG_STATUS,
      cpu.F_CARRY, cpu.F_DECIMAL, cpu.F_INTERRUPT, cpu.F_INTERRUPT_NEW,
      cpu.F_OVERFLOW, cpu.F_SIGN, cpu.F_ZERO,
      cpu.F_NOTUSED, cpu.F_NOTUSED_NEW, cpu.F_BRK, cpu.F_BRK_NEW,
    ]);

    // ── PPU ──────────────────────────────────────────────────────────────────

    // VRAM — 32768 bytes (byte values 0-255)
    const ppuVram = new Uint8Array(32768);
    for (let i = 0; i < 32768; i++) ppuVram[i] = ppu.vramMem[i];

    // Sprite RAM (OAM) — 256 bytes
    const ppuSpr = new Uint8Array(256);
    for (let i = 0; i < 256; i++) ppuSpr[i] = ppu.spriteMem[i];

    // vramMirrorTable — 32768 entries, values are VRAM addresses (0-16383 → Uint16)
    const ppuMirror = new Uint16Array(32768);
    for (let i = 0; i < 32768; i++) ppuMirror[i] = ppu.vramMirrorTable[i];

    // PPU scalar registers — 41 fields
    const ppuRegs = new Int32Array([
      ppu.cntFV, ppu.cntV, ppu.cntH, ppu.cntVT, ppu.cntHT,
      ppu.regFV, ppu.regV, ppu.regH, ppu.regVT, ppu.regHT, ppu.regFH, ppu.regS,
      ppu.vramAddress, ppu.vramTmpAddress,
      ppu.f_nmiOnVblank,    ppu.f_spriteSize,
      ppu.f_bgPatternTable, ppu.f_spPatternTable,
      ppu.f_addrInc,        ppu.f_nTblAddress,
      ppu.f_color,          ppu.f_spVisibility,
      ppu.f_bgVisibility,   ppu.f_spClipping,
      ppu.f_bgClipping,     ppu.f_dispType,
      ppu.vramBufferedReadValue,
      ppu.firstWrite ? 1 : 0,
      ppu.currentMirroring,
      ppu.sramAddress,
      ppu.hitSpr0 ? 1 : 0,
      ppu.curX, ppu.scanline, ppu.lastRenderedScanline, ppu.curNt,
      ppu.requestEndFrame        ? 1 : 0,
      ppu.nmiOk                  ? 1 : 0,
      ppu.dummyCycleToggle       ? 1 : 0,
      ppu.nmiCounter,
      ppu.validTileData          ? 1 : 0,
      ppu.scanlineAlreadyRendered ? 1 : 0,
    ]);

    // Palettes: imgPalette[0..15] || sprPalette[0..15]  (values 0-63, fit in Uint8)
    const ppuPal = new Uint8Array(32);
    for (let i = 0; i < 16; i++) {
      ppuPal[i]      = ppu.imgPalette[i];
      ppuPal[16 + i] = ppu.sprPalette[i];
    }

    // ntable1 (4 nametable slot → object indices)
    const ppuNtable1 = new Uint8Array(4);
    for (let i = 0; i < 4; i++) ppuNtable1[i] = ppu.ntable1[i];

    // attrib working buffer (32 entries used during scanline rendering)
    const ppuAttrib = new Uint8Array(32);
    for (let i = 0; i < 32; i++) ppuAttrib[i] = ppu.attrib[i];

    // ── NameTables ────────────────────────────────────────────────────────────
    // 4 tables, each: tile[1024] (byte indices) + attrib[1024] (values 0,4,8,12)
    const ntTile   = new Uint8Array(4 * 1024);
    const ntAttrib = new Uint8Array(4 * 1024);
    for (let t = 0; t < 4; t++) {
      const nt  = ppu.nameTable[t];
      const off = t * 1024;
      for (let i = 0; i < 1024; i++) {
        ntTile[off + i]   = nt.tile[i];
        ntAttrib[off + i] = nt.attrib[i];
      }
    }

    // ── Frame buffer ──────────────────────────────────────────────────────────
    // Saved so render() shows the correct frame immediately after loadState()
    const fb = this._frameBuffer ? new Int32Array(this._frameBuffer) : null;

    // ── ptTile (pattern tile cache) ───────────────────────────────────────────
    // Skipped for CHR ROM games — tiles are loaded from ROM on init and never change.
    // Saved for CHR RAM games (vromCount === 0) where the program writes tile data.
    let ptTilePix = null, ptTileOpaque = null;
    if (!this._skipPtTile) {
      ptTilePix   = new Uint8Array(512 * 64); // pixel color indices (0-3)
      ptTileOpaque = new Uint8Array(512 * 8); // per-row opacity flags (0 or 1)
      for (let t = 0; t < 512; t++) {
        const tile   = ppu.ptTile[t];
        const pixOff = t * 64;
        const opaOff = t * 8;
        for (let i = 0; i < 64; i++) ptTilePix[pixOff + i]   = tile.pix[i];
        for (let i = 0; i < 8;  i++) ptTileOpaque[opaOff + i] = tile.opaque[i] ? 1 : 0;
      }
    }

    // ── Mapper ────────────────────────────────────────────────────────────────
    const mmapState = mmap.toJSON(); // tiny object (joypad strobes etc.)

    return {
      cpuMem, cpuRegs,
      ppuVram, ppuSpr, ppuMirror, ppuRegs, ppuPal, ppuNtable1, ppuAttrib,
      ntTile, ntAttrib,
      fb,
      ptTilePix, ptTileOpaque,
      mmapState,
    };
  }

  /**
   * Restore NES state from a snapshot produced by saveState().
   * Directly sets jsnes internal fields — bypasses fromJSON() for speed.
   * @param {object} snap  — value returned by saveState()
   */
  loadState(snap) {
    if (!snap || !this._romLoaded) return;

    const cpu  = this.nes.cpu;
    const ppu  = this.nes.ppu;
    const mmap = this.nes.mmap;

    // ── CPU ──────────────────────────────────────────────────────────────────

    const { cpuMem } = snap;
    for (let i = 0; i < 65536; i++) cpu.mem[i] = cpuMem[i];

    const r = snap.cpuRegs;
    cpu.cyclesToHalt    = r[0];
    cpu.irqRequested    = r[1] !== 0;
    cpu.irqType         = r[2];
    cpu.REG_ACC         = r[3];
    cpu.REG_X           = r[4];
    cpu.REG_Y           = r[5];
    cpu.REG_SP          = r[6];
    cpu.REG_PC          = r[7];
    cpu.REG_PC_NEW      = r[8];
    cpu.REG_STATUS      = r[9];
    cpu.F_CARRY         = r[10];
    cpu.F_DECIMAL       = r[11];
    cpu.F_INTERRUPT     = r[12];
    cpu.F_INTERRUPT_NEW = r[13];
    cpu.F_OVERFLOW      = r[14];
    cpu.F_SIGN          = r[15];
    cpu.F_ZERO          = r[16];
    cpu.F_NOTUSED       = r[17];
    cpu.F_NOTUSED_NEW   = r[18];
    cpu.F_BRK           = r[19];
    cpu.F_BRK_NEW       = r[20];

    // ── PPU ──────────────────────────────────────────────────────────────────

    const { ppuVram, ppuSpr, ppuMirror, ppuPal, ppuNtable1, ppuAttrib } = snap;

    for (let i = 0; i < 32768; i++) ppu.vramMem[i]        = ppuVram[i];
    for (let i = 0; i < 256;   i++) ppu.spriteMem[i]      = ppuSpr[i];
    for (let i = 0; i < 32768; i++) ppu.vramMirrorTable[i] = ppuMirror[i];

    // PPU scalar registers
    const pr = snap.ppuRegs;
    let ri = 0;
    ppu.cntFV  = pr[ri++]; ppu.cntV   = pr[ri++]; ppu.cntH  = pr[ri++];
    ppu.cntVT  = pr[ri++]; ppu.cntHT  = pr[ri++];
    ppu.regFV  = pr[ri++]; ppu.regV   = pr[ri++]; ppu.regH  = pr[ri++];
    ppu.regVT  = pr[ri++]; ppu.regHT  = pr[ri++];
    ppu.regFH  = pr[ri++]; ppu.regS   = pr[ri++];
    ppu.vramAddress     = pr[ri++]; ppu.vramTmpAddress    = pr[ri++];
    ppu.f_nmiOnVblank   = pr[ri++]; ppu.f_spriteSize      = pr[ri++];
    ppu.f_bgPatternTable = pr[ri++]; ppu.f_spPatternTable = pr[ri++];
    ppu.f_addrInc       = pr[ri++]; ppu.f_nTblAddress     = pr[ri++];
    ppu.f_color         = pr[ri++]; ppu.f_spVisibility    = pr[ri++];
    ppu.f_bgVisibility  = pr[ri++]; ppu.f_spClipping      = pr[ri++];
    ppu.f_bgClipping    = pr[ri++]; ppu.f_dispType        = pr[ri++];
    ppu.vramBufferedReadValue = pr[ri++];
    ppu.firstWrite      = pr[ri++] !== 0;
    ppu.currentMirroring = pr[ri++];
    ppu.sramAddress     = pr[ri++];
    ppu.hitSpr0         = pr[ri++] !== 0;
    ppu.curX            = pr[ri++]; ppu.scanline              = pr[ri++];
    ppu.lastRenderedScanline = pr[ri++]; ppu.curNt            = pr[ri++];
    ppu.requestEndFrame       = pr[ri++] !== 0;
    ppu.nmiOk                 = pr[ri++] !== 0;
    ppu.dummyCycleToggle      = pr[ri++] !== 0;
    ppu.nmiCounter            = pr[ri++];
    ppu.validTileData         = pr[ri++] !== 0;
    ppu.scanlineAlreadyRendered = pr[ri++] !== 0;

    // Palettes
    for (let i = 0; i < 16; i++) {
      ppu.imgPalette[i] = ppuPal[i];
      ppu.sprPalette[i] = ppuPal[16 + i];
    }

    // ntable1 (slot → nametable index mapping) and attrib working buffer
    for (let i = 0; i < 4;  i++) ppu.ntable1[i] = ppuNtable1[i];
    for (let i = 0; i < 32; i++) ppu.attrib[i]  = ppuAttrib[i];

    // ── NameTables ────────────────────────────────────────────────────────────
    const { ntTile, ntAttrib } = snap;
    for (let t = 0; t < 4; t++) {
      const nt  = ppu.nameTable[t];
      const off = t * 1024;
      for (let i = 0; i < 1024; i++) {
        nt.tile[i]   = ntTile[off + i];
        nt.attrib[i] = ntAttrib[off + i];
      }
    }

    // ── Frame buffer ──────────────────────────────────────────────────────────
    if (snap.fb && ppu.buffer) {
      const src = snap.fb;
      const dst = ppu.buffer;
      for (let i = 0; i < src.length; i++) dst[i] = src[i];
      this._frameBuffer = ppu.buffer;
    }
    this._dirty = true;

    // ── ptTile ────────────────────────────────────────────────────────────────
    if (snap.ptTilePix) {
      const { ptTilePix, ptTileOpaque } = snap;
      for (let t = 0; t < 512; t++) {
        const tile   = ppu.ptTile[t];
        const pixOff = t * 64;
        const opaOff = t * 8;
        for (let i = 0; i < 64; i++) tile.pix[i]    = ptTilePix[pixOff + i];
        for (let i = 0; i < 8;  i++) tile.opaque[i]  = ptTileOpaque[opaOff + i] !== 0;
      }
    }

    // ── Mapper ────────────────────────────────────────────────────────────────
    mmap.fromJSON(snap.mmapState);
  }

  /**
   * Blit the latest NES frame to the canvas.
   *
   * jsnes palette value: 0x00RRGGBB
   * Canvas ImageData (little-endian Uint32): byte order [R, G, B, A]
   * As a 32-bit integer: 0xAABBGGRR
   * Conversion: 0xFF000000 | p  →  sets A=255 and maps RRGGBB correctly.
   * No channel swapping required (verified against the official jsnes example).
   */
  render() {
    if (!this._dirty || !this._frameBuffer) return;

    const fb     = this._frameBuffer;
    const pixels = this._pixels;
    const len    = NESAdapter.NES_W * NESAdapter.NES_H;

    for (let i = 0; i < len; i++) {
      pixels[i] = 0xFF000000 | fb[i];
    }

    this.ctx.putImageData(this._imageData, 0, 0);
    this._dirty = false;
  }
}
