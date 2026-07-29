/* Landing screen for Pixel Pool — the first thing the player sees.
 *
 * Offers LOG IN (hands off to the account flow in auth.js) or CONTINUE AS
 * GUEST (skips straight to the home screen in mode.js with no account),
 * with a rotating billiards tip underneath.
 */
(function () {
  'use strict';

  const overlay = document.getElementById('landingOverlay');
  const loginBtn = document.getElementById('landingLoginBtn');
  const guestBtn = document.getElementById('landingGuestBtn');
  const tipEl = document.getElementById('landingTip');
  if (!overlay || !loginBtn || !guestBtn) {
    console.warn('Landing: elements missing');
    return;
  }

  /* Loading-screen tips: real 8-ball advice, and a few that describe how this
     table actually behaves (see js/bot.js for the same geometry). Sentence
     case, unlike the rest of the UI — these are meant to read, not shout. */
  const TIPS = [
    'Aim at the ghost ball — the spot the cue must occupy at contact.',
    'Strike the cue ball dead centre for a roll you can predict.',
    'A cushion is not a mirror. Balls come off a bank a little flatter.',
    'Potting is only half the shot. Plan where the cue ball stops.',
    'Speed control beats power. Most misses are simply hit too hard.',
    'A straight pot is far more forgiving than a thin cut.',
    'Thin cuts send the cue ball a long way. Know where it is going.',
    'Scratch after a pot and your opponent gets ball in hand.',
    'The table stays open on the break — a later pot decides your group.',
    'Clear your whole group before you go anywhere near the 8.',
    'You must call a pocket on the 8. The wrong pocket is still a miss.',
    'No pot on? A safety is a shot. Leave your opponent nothing.',
    'Snookered? Kick off a rail. A legal hit beats handing over a foul.',
    'Look at the whole table first. The easiest pot is not always the best.',
    'Balls frozen on a rail are awkward. Break up clusters early.',
    'Drag the camera to walk around the table before you commit.',
    'Foul, and your opponent may put the cue ball wherever they like.',
    'Sink the 8 in the wrong pocket and you lose on the spot.',
    'Distance magnifies error. Take the shorter pot when you have one.',
    'Traffic turns easy pots into misses. Check the line is clear first.',
    'A ball tight to a rail needs a near-perfect cut. Take your time.',
    'Hit it too hard and the object ball rattles in the jaws.',
    'Blocked on the straight line? Bank the object ball off a cushion.',
    'Check the side pockets too. They are often the ones left open.',
    'Leave the cue ball near the centre and you keep your options open.',
    'Pull further back from the cue ball for a harder stroke.',
    'Practise against the computer before you take a match online.',
    'Swap the table and the backdrop from the settings panel any time.',
    'Online results move your rating, so every match counts.',
    'Your profile tracks lifetime pots, fouls and win rate.',
    'Add friends from the home screen and invite them to play right now.',
  ];

  let tipTimer = null;
  let tipIdx = Math.floor(Math.random() * TIPS.length);

  function drawTip() {
    if (!tipEl) return;
    tipEl.innerHTML = '<b>TIP</b> &mdash; ';
    tipEl.appendChild(document.createTextNode(TIPS[tipIdx % TIPS.length]));
  }
  // Cycle while the landing screen is up; stop once it is dismissed so the tip
  // is not still ticking behind the home screen.
  function startTips() {
    drawTip();
    if (tipTimer) clearInterval(tipTimer);
    tipTimer = setInterval(() => { tipIdx++; drawTip(); }, 14000);
  }
  function stopTips() {
    if (tipTimer) { clearInterval(tipTimer); tipTimer = null; }
  }

  function show() {
    [document.getElementById('modeOverlay'), document.getElementById('loginOverlay'),
     document.getElementById('signupOverlay')]
      .forEach(o => o && o.classList.add('hidden'));
    overlay.classList.remove('hidden');
    startTips();
  }

  loginBtn.addEventListener('click', () => {
    stopTips();
    if (window.PixelPoolAuth) window.PixelPoolAuth.showLogin();
  });

  guestBtn.addEventListener('click', () => {
    stopTips();
    overlay.classList.add('hidden');
    if (window.PixelPoolMode) window.PixelPoolMode.enter(null, true);
  });

  startTips();   // the landing screen is already up on first load

  window.PixelPoolLanding = { show };
})();
