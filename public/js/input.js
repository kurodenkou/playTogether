/**
 * InputManager — keyboard + gamepad input capture
 *
 * Tracks which keys are currently held and polls the Web Gamepad API,
 * then maps everything to the InputBits bitmask used by the rollback engine.
 *
 * Keyboard mappings:
 *   Arrow Up / W         → InputBits.UP
 *   Arrow Down / S       → InputBits.DOWN
 *   Arrow Left / A       → InputBits.LEFT
 *   Arrow Right / D      → InputBits.RIGHT
 *   Z / J                → InputBits.A
 *   X / K                → InputBits.B
 *   C                    → InputBits.X   (SNES X button)
 *   V                    → InputBits.Y   (SNES Y button)
 *   Q                    → InputBits.L   (SNES L shoulder)
 *   E                    → InputBits.R   (SNES R shoulder)
 *   Enter / P            → InputBits.START
 *   Shift / O            → InputBits.SELECT
 *
 * Gamepad mappings (standard layout — Xbox / PlayStation / Switch Pro):
 *   Left stick / D-pad   → UP / DOWN / LEFT / RIGHT
 *   Button 0 / A / Cross     → InputBits.A
 *   Button 1 / B / Circle    → InputBits.B
 *   Button 2 / X / Square    → InputBits.X   (SNES X)
 *   Button 3 / Y / Triangle  → InputBits.Y   (SNES Y)
 *   Button 4 / LB / L1       → InputBits.L   (SNES L)
 *   Button 5 / RB / R1       → InputBits.R   (SNES R)
 *   Start / Options          → InputBits.START
 *   Back / Share             → InputBits.SELECT
 *
 * All connected gamepads are ORed together, so either controller works.
 * Non-standard gamepads fall back to face buttons 0/1 + left stick axes.
 */
class InputManager {
  // Analog stick dead zone — ignore tilt below this threshold
  static DEAD_ZONE = 0.5;

  constructor() {
    this._held = new Set();

    this._onKeyDown = (e) => {
      // Prevent arrow keys / space from scrolling the page
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }
      this._held.add(e.code);
    };

    this._onKeyUp = (e) => {
      this._held.delete(e.code);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);

    // Track connected gamepads for the UI indicator
    this._connectedGamepads = new Set();

    this._onGamepadConnected = (e) => {
      this._connectedGamepads.add(e.gamepad.index);
      this._updateGamepadIndicator();
    };

    this._onGamepadDisconnected = (e) => {
      this._connectedGamepads.delete(e.gamepad.index);
      this._updateGamepadIndicator();
    };

    window.addEventListener('gamepadconnected',    this._onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }

  // ── Gamepad polling ────────────────────────────────────────────────────────

  /**
   * Read all currently connected gamepads and return the combined InputBits.
   * The Gamepad API is purely poll-based; state is only fresh inside a
   * requestAnimationFrame callback (which is where the rollback engine calls us).
   */
  _getGamepadBits() {
    if (!navigator.getGamepads) return 0;

    let bits = 0;
    const DEAD = InputManager.DEAD_ZONE;

    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;

      const btn = gp.buttons;
      const ax  = gp.axes;

      if (gp.mapping === 'standard') {
        // ── Standard layout (Xbox / PlayStation / Switch Pro) ──────────────
        // D-pad
        if (btn[12]?.pressed) bits |= InputBits.UP;
        if (btn[13]?.pressed) bits |= InputBits.DOWN;
        if (btn[14]?.pressed) bits |= InputBits.LEFT;
        if (btn[15]?.pressed) bits |= InputBits.RIGHT;
        // Face buttons (full SNES mapping)
        if (btn[0]?.pressed)  bits |= InputBits.A;   // A / Cross
        if (btn[1]?.pressed)  bits |= InputBits.B;   // B / Circle
        if (btn[2]?.pressed)  bits |= InputBits.X;   // X / Square  (SNES X)
        if (btn[3]?.pressed)  bits |= InputBits.Y;   // Y / Triangle (SNES Y)
        // Shoulder buttons
        if (btn[4]?.pressed)  bits |= InputBits.L;   // LB / L1 (SNES L)
        if (btn[5]?.pressed)  bits |= InputBits.R;   // RB / R1 (SNES R)
        // Menu buttons
        if (btn[9]?.pressed)  bits |= InputBits.START;
        if (btn[8]?.pressed)  bits |= InputBits.SELECT;
      } else {
        // ── Non-standard fallback — face buttons by common convention ──────
        if (btn[0]?.pressed)                    bits |= InputBits.A;
        if (btn[1]?.pressed)                    bits |= InputBits.B;
        if (btn[2]?.pressed)                    bits |= InputBits.X;
        if (btn[3]?.pressed)                    bits |= InputBits.Y;
        if (btn[4]?.pressed)                    bits |= InputBits.L;
        if (btn[5]?.pressed)                    bits |= InputBits.R;
        if (btn[8]?.pressed || btn[6]?.pressed) bits |= InputBits.SELECT;
        if (btn[9]?.pressed || btn[7]?.pressed) bits |= InputBits.START;
      }

      // Left analog stick — works for both standard and non-standard
      if (ax.length >= 2) {
        if (ax[0] < -DEAD) bits |= InputBits.LEFT;
        if (ax[0] >  DEAD) bits |= InputBits.RIGHT;
        if (ax[1] < -DEAD) bits |= InputBits.UP;
        if (ax[1] >  DEAD) bits |= InputBits.DOWN;
      }
    }

    return bits;
  }

  // ── UI indicator ───────────────────────────────────────────────────────────

  _updateGamepadIndicator() {
    const el = document.getElementById('gamepadIndicator');
    if (!el) return;
    const count = this._connectedGamepads.size;
    if (count === 0) {
      el.textContent = '';
      el.classList.add('hidden');
    } else {
      el.textContent = `Gamepad (${count})`;
      el.classList.remove('hidden');
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns the current input bitmask for this frame (keyboard OR gamepad). */
  getInput() {
    let bits = 0;
    const h = this._held;

    // Keyboard
    if (h.has('ArrowUp')    || h.has('KeyW')) bits |= InputBits.UP;
    if (h.has('ArrowDown')  || h.has('KeyS')) bits |= InputBits.DOWN;
    if (h.has('ArrowLeft')  || h.has('KeyA')) bits |= InputBits.LEFT;
    if (h.has('ArrowRight') || h.has('KeyD')) bits |= InputBits.RIGHT;
    if (h.has('KeyZ') || h.has('KeyJ'))       bits |= InputBits.A;
    if (h.has('KeyX') || h.has('KeyK'))       bits |= InputBits.B;
    if (h.has('KeyC'))                        bits |= InputBits.X;   // SNES X
    if (h.has('KeyV'))                        bits |= InputBits.Y;   // SNES Y
    if (h.has('KeyQ'))                        bits |= InputBits.L;   // SNES L
    if (h.has('KeyE'))                        bits |= InputBits.R;   // SNES R
    if (h.has('Enter') || h.has('KeyP'))      bits |= InputBits.START;
    if (h.has('ShiftLeft') || h.has('ShiftRight') || h.has('KeyO')) bits |= InputBits.SELECT;

    // Gamepad (ORed in — keyboard and gamepad work simultaneously)
    bits |= this._getGamepadBits();

    return bits;
  }

  /** Clean up event listeners (call when leaving the game room). */
  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    window.removeEventListener('gamepadconnected',    this._onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }
}
