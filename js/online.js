/* Online bridge for Pixel Pool — connects the network layer to the game.
 *
 * Thin relay only: it forwards matchmaking/gameplay events between
 * window.PixelPoolNet (socket) and window.PoolNetGame (the game's online API in
 * game.js), and returns the player to the lobby when a match ends or drops. All
 * actual game logic and state live in game.js; all socket logic in net.js.
 */
(function () {
  'use strict';

  const Net = window.PixelPoolNet;
  const Game = window.PoolNetGame;
  if (!Net || !Game) { console.warn('Online: missing PixelPoolNet / PoolNetGame'); return; }

  let inMatch = false;

  // The server confirms our identity (from the token it verified for THIS
  // socket) via 'welcome' right after connecting — use that as the source of
  // truth rather than re-reading storage, which is shared across every tab of
  // the origin and could reflect a different, more-recently-logged-in tab.
  let myUsername = null;
  Net.on('welcome', data => { myUsername = data && data.username; });
  const myName = () => myUsername || 'You';

  function toLobby(note) {
    inMatch = false;
    Game.endOnline();
    if (window.PixelPoolLobby) window.PixelPoolLobby.backToIdle(note);
  }

  // Outbound game messages (game.js → socket) and the end-screen "exit" action.
  Game.setSink(msg => Net.sendGame(msg));
  Game.onExit(() => { Net.leaveMatch(); toLobby(); });

  // A match was made: seat 0 is always the breaker, so both clients agree on
  // seats and on the shared rack seed. Launch the game.
  Net.on('match-found', data => {
    inMatch = true;
    const seat = data.youBreak ? 0 : 1;
    const names = seat === 0 ? [myName(), data.opponent] : [data.opponent, myName()];
    Game.startOnline({ mySeat: seat, names, seed: data.seed });
  });

  // In-match gameplay messages from the opponent.
  Net.on('game', msg => Game.apply(msg));

  // Opponent bailed, or our own connection dropped mid-match → back to lobby.
  Net.on('opponent-left', () => { if (inMatch) toLobby('Opponent left the match.'); });
  Net.on('status', kind => {
    if (inMatch && (kind === 'disconnected' || kind === 'error')) toLobby('Disconnected.');
  });
})();
