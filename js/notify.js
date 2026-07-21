/* Pocket notifications — small popups in the upper-right that announce every
   ball dropped ("<player> pocketed the <n> ball") next to a mini pool-ball
   chip. Each toast lives independently for 2s and the stack grows downward, so
   a multi-ball shot can show several at once. Kept standalone: game.js feeds it
   the shooter's name, the ball id, and that ball's colour. */
(function () {
  const LIFETIME = 2000; // ms each notification stays before fading out

  let feed = null;
  function container() {
    if (!feed) feed = document.getElementById('potFeed');
    return feed;
  }

  // Round ball chip, mirroring the HUD's solid/striped dot styling but rendered
  // as an actual ball with its number. id 0 = cue ball (no number, ivory).
  function ballChip(id, color) {
    const el = document.createElement('div');
    el.className = 'pball';
    if (id === 0) { el.classList.add('cue'); return el; }
    if (id > 8) el.classList.add('striped'); // stripe: white ball, colour band
    else el.style.background = color;         // solid (and the 8): full colour
    el.style.setProperty('--bc', color);
    const num = document.createElement('span');
    num.textContent = id;
    el.appendChild(num);
    return el;
  }

  // name: shooter's display name. id: ball id (0 = cue). color: css colour for
  // the chip (ignored for the cue ball).
  function pocket(name, id, color) {
    const host = container();
    if (!host) return;

    const card = document.createElement('div');
    card.className = 'potToast';
    card.appendChild(ballChip(id, color));

    const text = document.createElement('div');
    text.className = 'potText';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name;
    text.appendChild(who);
    text.append(` pocketed the ${id === 0 ? 'cue' : id} ball`);
    card.appendChild(text);

    host.appendChild(card);

    setTimeout(() => {
      card.classList.add('out');
      card.addEventListener('animationend', () => card.remove(), { once: true });
      setTimeout(() => card.remove(), 400); // fallback if the fade never fires
    }, LIFETIME);
  }

  window.PoolNotify = { pocket };
})();
