/**
 * RollbackEngine — GGPO-style rollback netcode
 *
 * Algorithm overview
 * ──────────────────
 *  • Each frame the local player's input is captured and queued INPUT_DELAY
 *    frames ahead, then broadcast to peers immediately.
 *  • Remote inputs may arrive late (network jitter).  When a frame F still
 *    lacks a peer's input we *predict* it (repeat their last known input).
 *  • When the real input for frame F eventually arrives and differs from
 *    what we predicted, we:
 *      1. Reload the saved game-state snapshot for frame F.
 *      2. Re-simulate F … currentFrame-1 with the now-correct inputs.
 *  • States are saved once per frame in a ring buffer of MAX_ROLLBACK depth.
 *  • The "confirmed frame" advances as all players' inputs become known;
 *    history older than that is pruned.
 *
 * Emulator contract
 * ─────────────────
 *  emulator.step(inputMap)          advance one frame
 *  emulator.saveState()  → opaque   serialise full game state
 *  emulator.loadState(opaque)       restore from snapshot
 *  emulator.render()                draw current state to canvas
 *
 * inputMap : { [playerId]: number }  (bit-field, see InputBits)
 */
class RollbackEngine {
  /**
   * @param {object} opts
   * @param {object}   opts.emulator       - emulator implementing the contract above
   * @param {string}   opts.localPlayerId  - this client's player ID
   * @param {string[]} opts.playerIds      - ordered array of all player IDs
   * @param {function} opts.readInput      - () => number  returns local input bitmask
   * @param {function} [opts.onStats]      - (stats) => void  called each frame
   */
  constructor({ emulator, localPlayerId, playerIds, readInput, onStats }) {
    this.emulator = emulator;
    this.localPlayerId = localPlayerId;
    this.playerIds = playerIds;
    this.readInput = readInput ?? (() => 0);
    this.onStats = onStats ?? (() => {});

    // ── Tuning ────────────────────────────────────────────────────────────
    /** Frames of artificial local-input delay.
     *  Gives the peer's real input time to arrive before we need to
     *  predict, reducing rollback frequency.  2 frames ≈ 33 ms headroom. */
    this.INPUT_DELAY = 2;
    /** Maximum frames we are willing to roll back. */
    this.MAX_ROLLBACK = 8;
    this.TARGET_FPS = 60;
    this.FRAME_MS = 1000 / this.TARGET_FPS;

    // ── Frame counters ────────────────────────────────────────────────────
    /** Current simulation frame (next frame to be simulated). */
    this.frame = 0;
    /** Last frame where every player's input is confirmed (no prediction). */
    this.confirmedFrame = -1;

    // ── History buffers (keyed by frame number) ───────────────────────────
    /** confirmedInputs.get(f)?.get(pid) → number | undefined */
    this.confirmedInputs = new Map();
    /** usedInputs.get(f) → { [pid]: number }  what we actually simulated */
    this.usedInputs = new Map();
    /** stateHistory.get(f) → opaque snapshot taken BEFORE stepping frame f */
    this.stateHistory = new Map();

    // ── Per-peer tracking ─────────────────────────────────────────────────
    /** lastReceivedFrame.get(pid) → highest frame we've received from pid */
    this.lastReceivedFrame = new Map();
    for (const pid of playerIds) {
      if (pid !== localPlayerId) this.lastReceivedFrame.set(pid, -1);
    }

    // ── Rollback pending flag ─────────────────────────────────────────────
    /** Frame to roll back to next tick, or null. */
    this._rollbackTo = null;

    // ── Timing ───────────────────────────────────────────────────────────
    this._running = false;
    this._rafId = null;
    this._lastTime = 0;
    this._accumulator = 0;

    // ── Stats ─────────────────────────────────────────────────────────────
    this._stats = { rollbacks: 0, maxRollbackDepth: 0, frame: 0, confirmedFrame: -1 };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  start() {
    this._running = true;
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  stop() {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  /**
   * Called by the network layer when a remote input arrives.
   * May trigger a rollback on the next tick if the input contradicts
   * what we predicted.
   */
  receiveRemoteInput(frame, playerId, input) {
    if (playerId === this.localPlayerId) return;

    // Check for misprediction (only if we already simulated this frame)
    if (frame < this.frame) {
      const used = this.usedInputs.get(frame);
      if (used !== undefined && used[playerId] !== input) {
        // Misprediction detected — schedule rollback to the earliest bad frame
        if (frame > this.confirmedFrame) {
          if (this._rollbackTo === null || frame < this._rollbackTo) {
            this._rollbackTo = frame;
          }
        }
      }
    }

    this._storeInput(frame, playerId, input);

    // Update last-received watermark
    const last = this.lastReceivedFrame.get(playerId) ?? -1;
    if (frame > last) this.lastReceivedFrame.set(playerId, frame);

    this._updateConfirmedFrame();
  }

  // ── Internal loop ─────────────────────────────────────────────────────────

  _loop(timestamp) {
    if (!this._running) return;

    const delta = Math.min(timestamp - this._lastTime, 100); // cap spiral-of-death
    this._lastTime = timestamp;
    this._accumulator += delta;

    while (this._accumulator >= this.FRAME_MS) {
      this._tick();
      this._accumulator -= this.FRAME_MS;
    }

    this.emulator.render();
    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  _tick() {
    // ① Queue local input with delay and broadcast
    const localInput = this.readInput();
    const queueFrame = this.frame + this.INPUT_DELAY;
    this._storeInput(queueFrame, this.localPlayerId, localInput);
    this._sendInput(queueFrame, localInput);

    // ② Execute pending rollback
    if (this._rollbackTo !== null) {
      const rollTo = this._rollbackTo;
      this._rollbackTo = null;
      if (rollTo < this.frame && this.stateHistory.has(rollTo)) {
        this._performRollback(rollTo);
      }
    }

    // ③ Snapshot state BEFORE simulating this frame
    this.stateHistory.set(this.frame, this.emulator.saveState());

    // ④ Gather inputs (confirmed or predicted) and simulate
    const inputs = this._gatherInputs(this.frame);
    this.usedInputs.set(this.frame, inputs);
    this.emulator.step(inputs);

    // ⑤ Maintain bookkeeping
    this._updateConfirmedFrame();
    this._pruneHistory();

    this._stats.frame = this.frame;
    this._stats.confirmedFrame = this.confirmedFrame;
    this.onStats(this._stats);

    this.frame++;
  }

  // ── Input helpers ─────────────────────────────────────────────────────────

  _storeInput(frame, playerId, input) {
    if (!this.confirmedInputs.has(frame)) this.confirmedInputs.set(frame, new Map());
    this.confirmedInputs.get(frame).set(playerId, input);
  }

  _gatherInputs(frame) {
    const result = {};
    for (const pid of this.playerIds) {
      const frameMap = this.confirmedInputs.get(frame);
      result[pid] = (frameMap && frameMap.has(pid))
        ? frameMap.get(pid)
        : this._predict(pid, frame);
    }
    return result;
  }

  /** Predict a player's input as their last confirmed value (hold-last). */
  _predict(playerId, forFrame) {
    for (let f = forFrame - 1; f >= Math.max(0, forFrame - this.MAX_ROLLBACK * 2); f--) {
      const m = this.confirmedInputs.get(f);
      if (m && m.has(playerId)) return m.get(playerId);
    }
    return 0;
  }

  // ── Rollback ──────────────────────────────────────────────────────────────

  _performRollback(toFrame) {
    const depth = this.frame - toFrame;
    this.emulator.loadState(this.stateHistory.get(toFrame));

    for (let f = toFrame; f < this.frame; f++) {
      this.stateHistory.set(f, this.emulator.saveState());
      const inputs = this._gatherInputs(f);
      this.usedInputs.set(f, inputs);
      this.emulator.step(inputs);
    }

    this._stats.rollbacks++;
    this._stats.maxRollbackDepth = Math.max(this._stats.maxRollbackDepth, depth);
  }

  // ── Confirmed-frame bookkeeping ───────────────────────────────────────────

  _updateConfirmedFrame() {
    // The "safe" watermark is the min of:
    //   • local:  we know inputs up through frame + INPUT_DELAY
    //   • remote: last received frame for each peer
    let minFrame = this.frame + this.INPUT_DELAY;
    for (const [, lastFrame] of this.lastReceivedFrame) {
      minFrame = Math.min(minFrame, lastFrame);
    }
    if (minFrame > this.confirmedFrame) this.confirmedFrame = minFrame;
  }

  _pruneHistory() {
    const keepFrom = Math.max(0, this.confirmedFrame - 1);
    for (const [f] of this.stateHistory) {
      if (f < keepFrom) {
        this.stateHistory.delete(f);
        this.usedInputs.delete(f);
        this.confirmedInputs.delete(f);
      }
    }
  }

  // ── Network send hook (overridden by app.js) ──────────────────────────────

  /** @param {number} frame @param {number} input */
  _sendInput(frame, input) {
    // Overridden by the application layer to actually transmit the input.
    // Default no-op for single-player / offline use.
  }
}

// ── Input bit-field constants (shared by engine, game, and UI) ────────────────
const InputBits = Object.freeze({
  UP:     0b00000001,
  DOWN:   0b00000010,
  LEFT:   0b00000100,
  RIGHT:  0b00001000,
  A:      0b00010000,  // Primary action
  B:      0b00100000,  // Secondary action
  START:  0b01000000,
  SELECT: 0b10000000,
});
