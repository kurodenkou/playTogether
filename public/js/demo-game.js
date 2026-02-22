/**
 * DemoGame — 2-player Pong
 *
 * Implements the emulator contract expected by RollbackEngine:
 *
 *   step(inputMap)   — advance one deterministic frame
 *   saveState()      — return a deep-clone of all mutable state
 *   loadState(snap)  — restore from that clone
 *   render()         — draw the current state to the canvas
 *
 * DETERMINISM REQUIREMENTS
 * ─────────────────────────
 * All mutable values are plain integers / fixed-point numbers.
 * No Math.random() — the only "random" source is the shared seed passed in
 * at game-start; it is advanced through a simple LCG during ball resets so
 * both clients produce identical sequences.
 */
class DemoGame {
  // ── Canvas dimensions (logical pixels) ──────────────────────────────────
  static W = 800;
  static H = 500;

  // ── Geometry constants ───────────────────────────────────────────────────
  static PADDLE_W = 12;
  static PADDLE_H = 90;
  static PADDLE_SPEED = 7;
  static PADDLE_LEFT_X = 40;
  static PADDLE_RIGHT_X = DemoGame.W - 40 - DemoGame.PADDLE_W;

  static BALL_R = 9;
  static BALL_INIT_VX = 5;
  static BALL_INIT_VY = 3;
  static BALL_MAX_SPEED = 15;
  static BALL_ACCEL = 0.4;       // speed increase on each paddle hit

  static WIN_SCORE = 7;

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string[]} playerIds  ordered player IDs (index 0 = left, 1 = right)
   * @param {number}   seed       shared PRNG seed from server
   */
  constructor(canvas, playerIds, seed) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.playerIds = playerIds;
    this.seed = seed >>> 0;

    canvas.width  = DemoGame.W;
    canvas.height = DemoGame.H;

    this.state = this._initialState();
  }

  // ── Emulator contract ─────────────────────────────────────────────────────

  step(inputMap) {
    const s = this.state;
    if (s.winner !== null) return; // game over — freeze

    s.frame++;
    if (s.hitFlash > 0) s.hitFlash--;

    // Move paddles ────────────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const pid = this.playerIds[i];
      if (!pid) continue;
      const input = inputMap[pid] ?? 0;
      const pad = s.paddles[i];
      if (input & InputBits.UP)   pad.y = Math.max(0, pad.y - DemoGame.PADDLE_SPEED);
      if (input & InputBits.DOWN) pad.y = Math.min(DemoGame.H - DemoGame.PADDLE_H, pad.y + DemoGame.PADDLE_SPEED);
    }

    // Move ball ───────────────────────────────────────────────────────────
    s.ball.x += s.ball.vx;
    s.ball.y += s.ball.vy;

    // Top / bottom wall bounce
    if (s.ball.y - DemoGame.BALL_R <= 0) {
      s.ball.y = DemoGame.BALL_R;
      s.ball.vy = Math.abs(s.ball.vy);
    } else if (s.ball.y + DemoGame.BALL_R >= DemoGame.H) {
      s.ball.y = DemoGame.H - DemoGame.BALL_R;
      s.ball.vy = -Math.abs(s.ball.vy);
    }

    // Paddle collisions ───────────────────────────────────────────────────
    const p0 = s.paddles[0];
    const p1 = s.paddles[1];

    // Left paddle
    if (s.ball.vx < 0
      && s.ball.x - DemoGame.BALL_R <= DemoGame.PADDLE_LEFT_X + DemoGame.PADDLE_W
      && s.ball.x + DemoGame.BALL_R >= DemoGame.PADDLE_LEFT_X
      && s.ball.y + DemoGame.BALL_R >= p0.y
      && s.ball.y - DemoGame.BALL_R <= p0.y + DemoGame.PADDLE_H)
    {
      const hitRel = (s.ball.y - (p0.y + DemoGame.PADDLE_H / 2)) / (DemoGame.PADDLE_H / 2);
      s.ball.vx = Math.min(Math.abs(s.ball.vx) + DemoGame.BALL_ACCEL, DemoGame.BALL_MAX_SPEED);
      s.ball.vy = hitRel * 7;
      s.ball.x  = DemoGame.PADDLE_LEFT_X + DemoGame.PADDLE_W + DemoGame.BALL_R + 1;
      s.hitFlash = 4;
    }

    // Right paddle
    if (s.ball.vx > 0
      && s.ball.x + DemoGame.BALL_R >= DemoGame.PADDLE_RIGHT_X
      && s.ball.x - DemoGame.BALL_R <= DemoGame.PADDLE_RIGHT_X + DemoGame.PADDLE_W
      && s.ball.y + DemoGame.BALL_R >= p1.y
      && s.ball.y - DemoGame.BALL_R <= p1.y + DemoGame.PADDLE_H)
    {
      const hitRel = (s.ball.y - (p1.y + DemoGame.PADDLE_H / 2)) / (DemoGame.PADDLE_H / 2);
      s.ball.vx = -Math.min(Math.abs(s.ball.vx) + DemoGame.BALL_ACCEL, DemoGame.BALL_MAX_SPEED);
      s.ball.vy = hitRel * 7;
      s.ball.x  = DemoGame.PADDLE_RIGHT_X - DemoGame.BALL_R - 1;
      s.hitFlash = 4;
    }

    // Scoring ─────────────────────────────────────────────────────────────
    if (s.ball.x + DemoGame.BALL_R < 0) {
      s.scores[1]++;
      this._resetBall(s, 1);
    } else if (s.ball.x - DemoGame.BALL_R > DemoGame.W) {
      s.scores[0]++;
      this._resetBall(s, 0);
    }

    // Win condition
    if (s.scores[0] >= DemoGame.WIN_SCORE) s.winner = 0;
    else if (s.scores[1] >= DemoGame.WIN_SCORE) s.winner = 1;
  }

  saveState() {
    const s = this.state;
    return {
      frame: s.frame,
      rngState: s.rngState,
      ball: { ...s.ball },
      paddles: s.paddles.map(p => ({ ...p })),
      scores: [...s.scores],
      winner: s.winner,
      hitFlash: s.hitFlash,
    };
  }

  loadState(snap) {
    this.state = {
      frame: snap.frame,
      rngState: snap.rngState,
      ball: { ...snap.ball },
      paddles: snap.paddles.map(p => ({ ...p })),
      scores: [...snap.scores],
      winner: snap.winner,
      hitFlash: snap.hitFlash,
    };
  }

  render() {
    const ctx = this.ctx;
    const s = this.state;
    const { W, H, PADDLE_W, PADDLE_H, PADDLE_LEFT_X, PADDLE_RIGHT_X, BALL_R } = DemoGame;

    // Background ─────────────────────────────────────────────────────────
    ctx.fillStyle = '#080810';
    ctx.fillRect(0, 0, W, H);

    // Hit flash ──────────────────────────────────────────────────────────
    if (s.hitFlash > 0) {
      ctx.fillStyle = `rgba(255,255,180,${s.hitFlash * 0.025})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Center dashed divider ──────────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = '#1c1c2e';
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 14]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.restore();

    // Scores ─────────────────────────────────────────────────────────────
    ctx.save();
    ctx.font = 'bold 54px "Courier New", monospace';
    ctx.textAlign = 'center';
    // P1 score
    ctx.fillStyle = s.winner === 0 ? '#4ade80'
                  : s.winner === 1 ? '#444'
                  : '#3b82f6';
    ctx.fillText(s.scores[0], W / 4, 68);
    // P2 score
    ctx.fillStyle = s.winner === 1 ? '#f87171'
                  : s.winner === 0 ? '#444'
                  : '#ef4444';
    ctx.fillText(s.scores[1], 3 * W / 4, 68);
    ctx.restore();

    // Player labels ──────────────────────────────────────────────────────
    ctx.save();
    ctx.font = '13px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#2a5090';
    ctx.fillText('P1', PADDLE_LEFT_X + PADDLE_W / 2, H - 8);
    ctx.fillStyle = '#902a2a';
    ctx.fillText('P2', PADDLE_RIGHT_X + PADDLE_W / 2, H - 8);
    ctx.restore();

    // Paddles ────────────────────────────────────────────────────────────
    this._drawPaddle(ctx, PADDLE_LEFT_X,  s.paddles[0].y, '#3b82f6');
    this._drawPaddle(ctx, PADDLE_RIGHT_X, s.paddles[1].y, '#ef4444');

    // Ball ───────────────────────────────────────────────────────────────
    const bx = s.ball.x, by = s.ball.y;
    const grd = ctx.createRadialGradient(bx - 2, by - 2, 0, bx, by, BALL_R);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(1, '#bbbbcc');
    ctx.fillStyle = grd;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(bx, by, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Winner overlay ─────────────────────────────────────────────────────
    if (s.winner !== null) {
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(0, 0, W, H);

      const winColor = s.winner === 0 ? '#3b82f6' : '#ef4444';
      ctx.save();
      ctx.fillStyle = winColor;
      ctx.font = 'bold 44px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.shadowColor = winColor;
      ctx.shadowBlur = 20;
      ctx.fillText(`PLAYER ${s.winner + 1} WINS!`, W / 2, H / 2 - 18);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#666688';
      ctx.font = '20px "Courier New", monospace';
      ctx.fillText('Host can start a rematch', W / 2, H / 2 + 28);
      ctx.restore();
    }

    // Debug HUD ──────────────────────────────────────────────────────────
    ctx.fillStyle = '#222234';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`f:${s.frame}`, 4, H - 4);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _initialState() {
    const rngState = this.seed;
    return {
      frame: 0,
      rngState,
      ball:    { x: DemoGame.W / 2, y: DemoGame.H / 2, vx: DemoGame.BALL_INIT_VX, vy: DemoGame.BALL_INIT_VY },
      paddles: [
        { y: DemoGame.H / 2 - DemoGame.PADDLE_H / 2 },
        { y: DemoGame.H / 2 - DemoGame.PADDLE_H / 2 },
      ],
      scores:   [0, 0],
      winner:   null,
      hitFlash: 0,
    };
  }

  /** Deterministic ball reset using an LCG seeded from shared game seed. */
  _resetBall(s, lastScorer) {
    // LCG: next = (a * x + c) mod m   (Numerical Recipes constants)
    s.rngState = ((Math.imul(1664525, s.rngState) + 1013904223) >>> 0);
    const vy = (((s.rngState >>> 16) % 5) - 2) * 1.2;          // -2.4 … 2.4
    const vx = DemoGame.BALL_INIT_VX * (lastScorer === 0 ? -1 : 1);
    s.ball = {
      x: DemoGame.W / 2,
      y: DemoGame.H / 2,
      vx,
      vy,
    };
  }

  _drawPaddle(ctx, x, y, color) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur  = 14;
    ctx.fillStyle   = color;
    ctx.fillRect(x, y, DemoGame.PADDLE_W, DemoGame.PADDLE_H);
    // Lighter highlight stripe
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x, y, 3, DemoGame.PADDLE_H);
    ctx.shadowBlur = 0;
    ctx.restore();
  }
}
