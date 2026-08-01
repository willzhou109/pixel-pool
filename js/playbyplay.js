/* Play-by-play "LAYOUT" tab of the GAME RECAP panel.
 *
 * js/stats.js keeps the per-stroke shot log (window.MatchStats.playByPlay());
 * this module owns the STATS / LAYOUT tab row inside #recapPanel and draws the
 * log as turn-by-turn pairs of mini table boards: the layout as the cue was
 * struck (with an arrow showing the shot direction) next to the settled result.
 * Consecutive shots by the same player are grouped under one turn heading.
 *
 * The recap always reopens on the STATS tab; the LAYOUT tab re-renders on
 * every switch so it also works for the online watcher, whose log arrives via
 * MatchStats.applyRemote().
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // Table geometry + ball palette, mirrored from game.js's CONFIG block —
  // keep in sync if the table ever changes shape.
  const PW = 1.27, PH = 0.635, R = 0.0286;
  const POCKETS = [
    [-PW, -PH], [PW, -PH], [-PW, PH], [PW, PH], [0, -PH], [0, PH],
  ];
  const BALL_COLORS = {
    1: '#f2b705', 2: '#1d5fbf', 3: '#d0342c', 4: '#6a2d9c',
    5: '#e8720c', 6: '#1a8a4f', 7: '#8a2033', 8: '#181820',
  };

  const FOUL_LABEL = {
    scratch: 'SCRATCH', noContact: 'FOUL: NO CONTACT', wrongBall: 'FOUL: WRONG BALL FIRST',
    noRail: 'FOUL: NO RAIL',   // 9-ball only
  };

  /* ------------------------------ board draw ------------------------------ */

  // Internal resolution of one mini board; CSS scales it to half the row.
  const BW = 380, BH = 210, PAD = 16;

  function drawBoard(cv, layout, dir) {
    const ctx = cv.getContext('2d');
    const s = (BW - 2 * PAD) / (2 * PW); // world units -> px (same for both axes)
    const px = x => PAD + (x + PW) * s;
    const py = z => PAD + (z + PH) * s;

    // rails + felt
    ctx.fillStyle = '#241a10';
    ctx.fillRect(0, 0, BW, BH);
    ctx.fillStyle = '#1b5c3d';
    ctx.fillRect(PAD - 4, PAD - 4, (BW - 2 * PAD) + 8, 2 * PH * s + 8);

    // pockets
    ctx.fillStyle = '#0a0c10';
    for (const [x, z] of POCKETS) {
      ctx.beginPath();
      ctx.arc(px(x), py(z), 9, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!layout) return;
    const r = Math.max(5, R * s);
    let cuePos = null;

    for (const [id, x, z, potted] of layout) {
      if (potted) continue;
      const cx = px(x), cy = py(z);
      if (id === 0) cuePos = [cx, cy];
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (id === 0) {
        ctx.fillStyle = '#f4f1e8';
        ctx.fill();
      } else if (id === 8) {
        ctx.fillStyle = BALL_COLORS[8];
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#cfd6e4';
        ctx.stroke();
      } else if (id < 8) {
        ctx.fillStyle = BALL_COLORS[id];
        ctx.fill();
      } else {
        // stripe: white ball with a colored band across the middle
        ctx.fillStyle = '#f4f1e8';
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.fillStyle = BALL_COLORS[id - 8];
        ctx.fillRect(cx - r, cy - r * 0.45, 2 * r, r * 0.9);
        ctx.restore();
      }
    }

    // shot-direction arrow out of the cue ball (the "before" board only)
    if (dir && cuePos) {
      const len = 34;
      const tx = cuePos[0] + dir.x * len, ty = cuePos[1] + dir.z * len;
      ctx.strokeStyle = '#ffd23e';
      ctx.fillStyle = '#ffd23e';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cuePos[0] + dir.x * (r + 2), cuePos[1] + dir.z * (r + 2));
      ctx.lineTo(tx, ty);
      ctx.stroke();
      const a = Math.atan2(dir.z, dir.x);
      ctx.beginPath();
      ctx.moveTo(tx + Math.cos(a) * 8, ty + Math.sin(a) * 8);
      ctx.lineTo(tx + Math.cos(a + 2.5) * 7, ty + Math.sin(a + 2.5) * 7);
      ctx.lineTo(tx + Math.cos(a - 2.5) * 7, ty + Math.sin(a - 2.5) * 7);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* ----------------------------- list render ------------------------------ */

  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  // Ball numbers newly potted on this stroke, diffed from the before/after
  // layouts (so it also covers opponent balls and needs no extra log data).
  // The cue ball is excluded — the SCRATCH foul label already covers it.
  function pottedIds(shot) {
    if (!shot.before || !shot.after) return null;
    const was = new Set(shot.before.filter(r => r[3]).map(r => r[0]));
    return shot.after.filter(r => r[3] && r[0] !== 0 && !was.has(r[0])).map(r => r[0]);
  }

  function caption(shot, n) {
    const ids = pottedIds(shot);
    let s = 'SHOT ' + n + ' — ' +
      (ids ? (ids.length ? 'POCKETED ' + ids.join(', ') : 'NO POT')
           : (shot.pots > 0 ? 'POCKETED ' + shot.pots : 'NO POT')); // no layouts logged — fall back to the count
    if (shot.foul) s += ' · ' + (FOUL_LABEL[shot.foul] || 'FOUL');
    return s;
  }

  // Draw a shot log into `wrap` as turn-by-turn before/after board pairs.
  // Also used by js/history.js for the LAYOUT tab of a stored match, where the
  // log comes from the server instead of the live MatchStats module.
  function renderLog(wrap, log, names) {
    wrap.innerHTML = '';
    if (!log.length) {
      wrap.appendChild(el('div', 'pbpCaption', 'NO SHOTS RECORDED.'));
      return;
    }
    let lastShooter = -1, n = 0;
    for (const shot of log) {
      n++;
      if (shot.shooter !== lastShooter) {
        lastShooter = shot.shooter;
        wrap.appendChild(el('div', 'pbpTurn',
          (names[shot.shooter] || 'Player ' + (shot.shooter + 1)) + "'s turn"));
      }
      wrap.appendChild(el('div', 'pbpCaption', caption(shot, n)));
      const row = el('div', 'pbpBoards');
      for (const [layout, dir] of [[shot.before, shot.dir], [shot.after, null]]) {
        const cv = document.createElement('canvas');
        cv.width = BW; cv.height = BH;
        drawBoard(cv, layout, dir);
        row.appendChild(cv);
      }
      wrap.appendChild(row);
    }
  }

  function render() {
    const wrap = $('recapLayout');
    if (!wrap || !window.MatchStats) return;
    const { log, names } = window.MatchStats.playByPlay();
    renderLog(wrap, log, names);
  }

  /* ------------------------------ tab wiring ------------------------------ */

  const tabStats = $('recapTabStats'), tabLayout = $('recapTabLayout');
  const statsView = $('recapTable'), layoutView = $('recapLayout');

  function showTab(layout) {
    // Lock the LAYOUT pane to the STATS table's height (measured while STATS
    // is still visible) so the panel doesn't resize when switching tabs.
    if (layout && statsView && layoutView && statsView.offsetHeight) {
      layoutView.style.height = statsView.offsetHeight + 'px';
    }
    if (tabStats) tabStats.classList.toggle('recapTabOn', !layout);
    if (tabLayout) tabLayout.classList.toggle('recapTabOn', layout);
    if (statsView) statsView.classList.toggle('hidden', layout);
    if (layoutView) layoutView.classList.toggle('hidden', !layout);
    if (layout) render();
  }

  if (tabStats && tabLayout) {
    tabStats.addEventListener('click', () => showTab(false));
    tabLayout.addEventListener('click', () => showTab(true));
    // Opening the recap always lands on STATS, even if LAYOUT was left showing.
    const recapBtn = $('recapBtn');
    if (recapBtn) recapBtn.addEventListener('click', () => showTab(false));
  }

  // Shared with js/history.js (see renderLog).
  window.PlayByPlay = { renderLog };
})();
