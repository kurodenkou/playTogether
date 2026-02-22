/**
 * InputManager — keyboard input capture
 *
 * Tracks which keys are currently held and maps them to the InputBits
 * bitmask used by the rollback engine and game adapters.
 *
 * Default mappings (both sets work regardless of player index;
 * the rollback engine associates your bitmask with your player ID):
 *
 *   Arrow Up / W      → InputBits.UP
 *   Arrow Down / S    → InputBits.DOWN
 *   Arrow Left / A    → InputBits.LEFT
 *   Arrow Right / D   → InputBits.RIGHT
 *   Z / J / Enter     → InputBits.A
 *   X / K / Backspace → InputBits.B
 *   Enter / P         → InputBits.START
 *   Shift / O         → InputBits.SELECT
 */
class InputManager {
  constructor() {
    this._held = new Set();

    this._onKeyDown = (e) => {
      // Prevent arrow keys / space from scrolling the page
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
        e.preventDefault();
      }
      this._held.add(e.code);
    };

    this._onKeyUp = (e) => {
      this._held.delete(e.code);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
  }

  /** Returns the current input bitmask for this frame. */
  getInput() {
    let bits = 0;
    const h = this._held;

    if (h.has('ArrowUp')    || h.has('KeyW')) bits |= InputBits.UP;
    if (h.has('ArrowDown')  || h.has('KeyS')) bits |= InputBits.DOWN;
    if (h.has('ArrowLeft')  || h.has('KeyA')) bits |= InputBits.LEFT;
    if (h.has('ArrowRight') || h.has('KeyD')) bits |= InputBits.RIGHT;
    if (h.has('KeyZ') || h.has('KeyJ') || h.has('Enter'))     bits |= InputBits.A;
    if (h.has('KeyX') || h.has('KeyK') || h.has('Backspace')) bits |= InputBits.B;
    if (h.has('KeyP') || h.has('Escape'))                     bits |= InputBits.START;
    if (h.has('ShiftLeft') || h.has('ShiftRight'))            bits |= InputBits.SELECT;

    return bits;
  }

  /** Clean up event listeners (call when leaving the game room). */
  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
  }
}
