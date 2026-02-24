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
 */
class SNESAudioProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return []; }

  constructor() {
    super();

    // Ring buffer: 4096 stereo frames ≈ 68 ms at 60 fps (735 samples/frame).
    // Large enough to absorb scheduling jitter without audible latency.
    this._size = 4096;
    this._mask = this._size - 1;
    this._bufL = new Float32Array(this._size);
    this._bufR = new Float32Array(this._size);
    this._wr   = 0; // write head (main-thread messages)
    this._rd   = 0; // read  head (process() drain)

    this.port.onmessage = ({ data }) => {
      if (!data || !data.samples) return;
      const s = data.samples; // interleaved Float32: L0,R0,L1,R1,...
      const n = s.length >> 1; // stereo frame count

      // Overflow guard: if there is not enough space, discard the oldest samples
      // to make room.  This keeps the write pointer from silently lapping the read
      // pointer, which would corrupt the avail calculation in process() and produce
      // silence gaps.  We leave one slot empty so _wr==_rd always means "empty".
      const avail = (this._wr - this._rd) & this._mask;
      const space = this._size - 1 - avail;
      if (n > space) {
        this._rd = (this._rd + (n - space)) & this._mask; // drop oldest
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

    const n     = chL.length;
    const avail = (this._wr - this._rd) & this._mask;
    const rd    = Math.min(n, avail);

    for (let i = 0; i < rd; i++) {
      const l = this._bufL[(this._rd + i) & this._mask];
      const r = this._bufR[(this._rd + i) & this._mask];
      chL[i] = l;
      if (chR) chR[i] = r; else chL[i] = (l + r) * 0.5; // mono mix
    }
    // Pad with silence if the buffer runs dry (startup / after rollback)
    for (let i = rd; i < n; i++) { chL[i] = 0; if (chR) chR[i] = 0; }
    this._rd = (this._rd + rd) & this._mask;

    return true; // keep processor alive for the lifetime of the AudioContext
  }
}

registerProcessor('snes-audio-processor', SNESAudioProcessor);
