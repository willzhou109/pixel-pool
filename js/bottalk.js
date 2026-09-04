/* The computer's voice in vs-Computer mode.
 *
 * js/bot.js decides a shot and hands back a plain object ({ pocket, target,
 * via, safe, place, ... }); this module turns that into a line of table talk so
 * the player can see the computer's INTENT before it shoots — which ball, which
 * pocket, and by what route — and a short reaction once the balls stop.
 *
 * Kept apart from both bot.js (which must stay pure decision-making) and
 * game.js: personality is content, not logic, and this is the one file to edit
 * to re-voice the opponent. game.js pipes the lines into the existing in-match
 * chat box (js/chat.js) and waits BOT_READ_MS so there's time to read them.
 *
 * The character: a cocky but good-natured pool hall regular — narrates its own
 * shots, takes credit loudly, owns its misses, and respects a good escape.
 */
(function () {
  'use strict';

  /* ------------------------------- naming -------------------------------- */
  // Pocket labels use the table's home orientation (the view a match opens on):
  // the camera sits at -x looking down +x, so +x reads as "far", +z as "right".
  // POCKETS order is fixed by game.js: 0..3 corners, then the two side pockets.
  const POCKET_NAMES = [
    'near-left corner', 'far-left corner',
    'near-right corner', 'far-right corner',
    'left middle pocket', 'right middle pocket',
  ];
  const pocketName = i => POCKET_NAMES[i] || 'pocket';
  // Only the ball that ENDS the game gets its full name ("the 8-ball") — which
  // one that is depends on the rules being played, since 9-ball demotes the 8 to
  // an ordinary numbered ball. Defaults to 8-ball.
  const ballName = (id, gameBall) => (id === (gameBall || 8) ? 'the ' + id + '-ball' : 'the ' + id);

  /* ----------------------------- line picking ---------------------------- */
  // Remember the last line used per category so the same one never lands twice
  // in a row — repetition is what makes scripted banter feel canned.
  const lastUsed = {};
  function pick(key, lines) {
    if (lines.length === 1) return lines[0];
    let i = Math.floor(Math.random() * lines.length);
    if (lines[i] === lastUsed[key]) i = (i + 1) % lines.length;
    lastUsed[key] = lines[i];
    return lines[i];
  }
  // Ball and pocket names are lowercase ("the 5", "far-left corner"), but a slot
  // can sit at the start of a sentence — either the line's own opening or one
  // mid-template ("…thanks. {ball} into the {pocket}."). Capitalising after
  // substitution beats writing two variants of every template.
  const fill = (s, ball, pocket) => s
    .replace(/{ball}/g, ball).replace(/{pocket}/g, pocket)
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, lead, c) => lead + c.toUpperCase());

  /* -------------------------------- intent ------------------------------- */
  /* What the computer is about to attempt.
     d: the bot decision.
     opts: { game, breakShot, onEight, ballInHand, forcedCall }.
     game is '8ball' | '9ball', which decides both how balls are named and which
     shot is the one for the match.
     forcedCall is a pocket index it had to nominate on the 8 without actually
     shooting at it (snookered) — worth saying out loud, since the gold marker
     appears on a pocket the shot isn't heading for. 9-ball never calls. */
  function intent(d, opts) {
    const o = opts || {};
    const gameBall = o.game === '9ball' ? 9 : 8;
    const ball = d && d.target != null ? ballName(d.target, gameBall) : 'that one';
    const pocket = d && d.pocket != null ? pocketName(d.pocket) : 'a pocket';
    const forced = o.forcedCall != null && o.forcedCall >= 0
      ? ' Have to call one anyway, so — ' + pocketName(o.forcedCall) + '. Optimistic, I know.'
      : '';

    if (o.breakShot) {
      return pick('break', [
        'Rack looks tidy. Let me fix that.',
        'Breaking — hold onto something.',
        'Right, everybody scatter.',
        'Full power. Elegance is for later.',
      ]);
    }

    if (d && d.safe) {
      return pick('safe', [
        'Nothing on from here. Playing safe and leaving you the mess.',
        'No shot worth taking. I\'ll just tuck this away and wait.',
        'Defence it is. Your turn to be creative.',
        'I could try something heroic, or I could not lose. Not losing it is.',
      ]) + forced;
    }

    if (d && d.via === 'kick') {
      return fill(pick('kick', [
        'I\'m snookered. Kicking off the cushion to clip {ball} — a legal hit will do.',
        'No clean line to {ball} at all. Off the rail I go; a foul is worse than a miss.',
        'Can\'t even see {ball}. Rail first, contact second, dignity third.',
        'Well, this is awkward. Bouncing off the cushion to reach {ball}.',
      ]), ball, pocket) + forced;
    }

    if (d && d.via === 'bank') {
      return fill(pick('bank', [
        'No straight line, so I\'ll bank {ball} off the cushion into the {pocket}.',
        'Bank shot: {ball} off the rail and into the {pocket}. Trust the geometry.',
        'Cushion first, then {ball} drops in the {pocket}. Probably.',
        'Watch this — {ball} off the rail, {pocket}. I\'ve done the maths.',
      ]), ball, pocket);
    }

    // The shot for the match. In 9-ball that's the 9 — with no pocket to call,
    // and reached by clearing up to it rather than by clearing a suit.
    if (o.onEight || (d && d.target === gameBall)) {
      return fill(pick('gameball', gameBall === 9 ? [
        'This is for the match — {ball}, any pocket. {pocket} will do nicely.',
        'Last one. {ball} in the {pocket} and we\'re done here.',
        '{ball} to win it. Been a pleasure racking up against you.',
      ] : [
        'This is for the match — {ball} into the {pocket}.',
        '{ball}, {pocket}. It\'s been a pleasure.',
        'Calling {ball} in the {pocket}. Don\'t watch if you\'re squeamish.',
      ]), ball, pocket);
    }

    if (o.ballInHand) {
      return fill(pick('inhand', [
        'Ball in hand — very generous. Setting up {ball} for the {pocket}.',
        'Thanks for the free placement. {ball}, {pocket}, nice and straight.',
        'I\'ll take the cue ball right here, thanks. {ball} into the {pocket}.',
      ]), ball, pocket);
    }

    return fill(pick('pot', [
      'Right then — {ball} into the {pocket}. Watch this.',
      'Cutting {ball} into the {pocket}. Textbook.',
      '{ball}, {pocket}. Don\'t blink.',
      'Lining up {ball} for the {pocket}. This one\'s mine.',
      '{ball} is going in the {pocket}. I can feel it.',
    ]), ball, pocket);
  }

  /* ------------------------------- reaction ------------------------------ */
  /* A short line once the balls stop. `r` is { potted, foul, scratch, won,
     lost, spotNine }. Routine outcomes stay quiet most of the time — a running
     commentary that never shuts up stops being funny about four shots in. */
  function reaction(r) {
    if (!r) return null;
    if (r.won) {
      return pick('won', ['And that\'s the game. Good match!',
        'That\'ll do it. Well played — you made me work.',
        'Game. Rematch whenever you\'re ready.']);
    }
    if (r.lost) {
      return pick('lost', ['...that was the wrong ball, wasn\'t it. Well played.',
        'Oh, that\'s embarrassing. Your game.',
        'I had that. I genuinely had that. Congratulations.']);
    }
    // 9-ball: sank the money ball, but fouled doing it, so it goes straight back
    // up. Too good a moment to let the generic foul line cover it.
    if (r.spotNine) {
      return pick('spotnine', ['Won the game! ...on a foul. It\'s going back up, isn\'t it.',
        'The 9 drops and it doesn\'t count. I\'d like to lodge a complaint.',
        'Sank the 9 the illegal way. Spot it back and pretend you saw nothing.']);
    }
    if (r.scratch) {
      return pick('scratch', ['Straight in the pocket. The CUE ball. Marvellous.',
        'Scratched. Take the ball in hand, rub it in.',
        'That was not the ball I was aiming to sink.']);
    }
    if (r.foul) {
      return pick('foul', ['Foul. That one\'s on me.',
        'Didn\'t get there. All yours.',
        'Ugh. Free ball for you.']);
    }
    if (r.potted > 1) {
      return pick('multi', ['Two at once. I\'d like to say that was on purpose.',
        'Multi-ball! That WAS on purpose, obviously.']);
    }
    if (r.potted === 1) {
      return Math.random() < 0.45 ? pick('made', ['Told you.', 'Still got it.',
        'Like I said.', 'Too easy.', 'Next.']) : null;
    }
    return Math.random() < 0.35 ? pick('miss', ['Hm. We don\'t talk about that one.',
      'Rattled it. Rude.', 'I meant to do that. Tactically.',
      'Your table. Enjoy it while it lasts.']) : null;
  }

  window.PoolBotTalk = { intent, reaction, pocketName, ballName };
})();
