/**
 * SNESAudioProcessor — AudioWorklet processor for SNES audio playback.
 *
 * Runs on the dedicated AudioWorklet thread (separate from the main JS thread),
 * so it is immune to main-thread jitter that caused the ring-buffer overflows
 * seen with the old ScriptProcessorNode approach.
 *
 * Protocol (main thread → worklet):
 *   { samples: Float32Array }  — interleaved L0,R0,L1,R1,… for one SNES frame
 *
 * The worklet buffers incoming frames in an internal ring buffer and drains
 * them into the Web Audio output buffers at whatever quantum size the browser
 * chooses (typically 128 frames).
 *
 * Dynamic Rate Control (DRC)
 * ──────────────────────────
 * A proportional controller adjusts the playback rate each quantum to keep
 * the ring buffer near a target fill level.  When the buffer runs ahead of
 * target the rate rises slightly (consuming input faster); when it falls
 * behind the rate drops (consuming input slower).  Linear interpolation
 * produces smooth output at any fractional rate.  Rate is clamped to ±5 %
 * so pitch deviation remains below the threshold of audible perception.
 */
class SNESAudioProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return []; }

  constructor() {
    super();

    // Ring buffer: 8192 stereo sample-pairs ≈ 186 ms at 44 100 Hz.
    // Large enough to absorb scheduling jitter and rollback re-simulation
    // gaps without audible latency.
    this._size = 8192;
    this._mask = this._size - 1;
    this._bufL = new Float32Array(this._size);
    this._bufR = new Float32Array(this._size);
    this._wr   = 0;    // write head (integer)
    this._rd   = 0;    // read  head (integer)
    this._rdF  = 0.0;  // fractional part of read position [0, 1)

    // DRC target: keep the buffer 25 % full (≈ 46 ms at 44 100 Hz).
    // Proportional gain of 0.1 / size yields ≤ 1.25 % rate correction per
    // quantum at the maximum expected fill deviation, converging in ≈ 1 s.
    this._target = this._size >> 2; // 2048 sample-pairs

    this.port.onmessage = ({ data }) => {
      if (!data?.samples) return;
      const s = data.samples; // interleaved Float32: L0,R0,L1,R1,…
      const n = s.length >> 1; // stereo sample-pair count

      // Overflow guard: discard oldest samples rather than silently lapping
      // the read pointer, which would corrupt the avail calculation and cause
      // silence gaps.  We leave one slot empty so _wr==_rd always means "empty".
      const avail = (this._wr - this._rd) & this._mask;
      const space = this._size - 1 - avail;
      if (n > space) {
        this._rd  = (this._rd + (n - space)) & this._mask;
        this._rdF = 0;
      }

      for (let i = 0; i < n; i++) {
        this._bufL[this._wr] = s[i * 2];
        this._bufR[this._wr] = s[i * 2 + 1];
        this._wr = (this._wr + 1) & this._mask;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const chL = out[0];
    const chR = out[1]; // may be undefined if output is mono
    if (!chL) return true;

    const n     = chL.length;                            // typically 128
    const avail = (this._wr - this._rd) & this._mask;

    // ── DRC: proportional controller ────────────────────────────────────────
    // rate > 1 → consume input faster (buffer above target, draining it)
    // rate < 1 → consume input slower (buffer below target, letting it fill)
    // Clamped to ±5 % — pitch deviation is imperceptible at this range.
    const rate = Math.max(0.95, Math.min(1.05,
      1.0 + 0.1 * (avail - this._target) / this._size
    ));

    if (avail === 0) {
      // Buffer completely empty — output silence.
      chL.fill(0);
      if (chR) chR.fill(0);
      return true;
    }

    // ── Linear-interpolation resampling ─────────────────────────────────────
    // Read at `rate` input samples per output sample.  The fractional read
    // position (_rdF) is carried across process() calls so there are no
    // phase discontinuities at quantum boundaries.
    let pos = this._rdF; // fractional offset from _rd

    for (let i = 0; i < n; i++) {
      const fl   = pos | 0;                              // floor(pos)
      const frac = pos - fl;

      if (fl >= avail) {
        // Ran out of buffered data mid-quantum — pad remainder with silence.
        chL[i] = 0;
        if (chR) chR[i] = 0;
      } else {
        const i0 = (this._rd + fl)                          & this._mask;
        const i1 = (this._rd + Math.min(fl + 1, avail - 1)) & this._mask;
        const l  = this._bufL[i0] + frac * (this._bufL[i1] - this._bufL[i0]);
        const r  = this._bufR[i0] + frac * (this._bufR[i1] - this._bufR[i0]);
        chL[i]   = l;
        if (chR) chR[i] = r; else chL[i] = (l + r) * 0.5;
      }

      pos += rate;
    }

    // Advance the integer read head by the samples consumed; carry the
    // fractional remainder into the next quantum.
    const consumed = pos | 0;
    this._rdF = pos - consumed;
    this._rd  = (this._rd + Math.min(consumed, avail)) & this._mask;

    return true;
  }
}

registerProcessor('snes-audio-processor', SNESAudioProcessor);
