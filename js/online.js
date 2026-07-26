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
  const Chat = window.PixelPoolChat;
  if (!Net || !Game) { console.warn('Online: missing PixelPoolNet / PoolNetGame'); return; }

  let inMatch = false;
  let matchToken = 0; // bumped on every match-found/end so a stale avatar fetch can detect it's superseded

  // The server confirms our identity (from the token it verified for THIS
  // socket) via 'welcome' right after connecting — use that as the source of
  // truth rather than re-reading storage, which is shared across every tab of
  // the origin and could reflect a different, more-recently-logged-in tab.
  let myUsername = null;
  Net.on('welcome', data => { myUsername = data && data.username; });
  const myName = () => myUsername || 'You';

  // Same per-tab session key as js/auth.js.
  const getToken = () => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } };

  // Look up a player's saved avatar for the in-game HUD. Falls back to null
  // (no tile shown) for guests or on any fetch failure.
  async function fetchAvatar(username) {
    const token = getToken();
    if (!token) return null;
    try {
      const res = await fetch('/api/users/' + encodeURIComponent(username) + '/summary', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const data = await res.json();
      return (res.ok && data.avatar) ? data.avatar : null;
    } catch { return null; }
  }

  function toLobby(note) {
    inMatch = false;
    matchToken++;
    if (Chat) Chat.hide();
    Game.endOnline();
    if (window.PixelPoolLobby) window.PixelPoolLobby.backToIdle(note);
  }

  // Outbound game messages (game.js → socket) and the end-screen "exit" action.
  Game.setSink(msg => Net.sendGame(msg));
  Game.onExit(() => { Net.leaveMatch(); toLobby(); });

  // A match was made: seat 0 is always the breaker, so both clients agree on
  // seats and on the shared rack seed. Launch the game.
  Net.on('match-found', async data => {
    inMatch = true;
    const token = ++matchToken;
    const seat = data.youBreak ? 0 : 1;
    const names = seat === 0 ? [myName(), data.opponent] : [data.opponent, myName()];
    const [myAvatar, oppAvatar] = await Promise.all([
      window.PoolAvatar ? Promise.resolve(window.PoolAvatar.mine) : Promise.resolve(null),
      fetchAvatar(data.opponent),
    ]);
    // A newer match (or a return to lobby) may have superseded this one while
    // the avatar fetches were in flight — don't stomp its state.
    if (token !== matchToken) return;
    const avatars = seat === 0 ? [myAvatar, oppAvatar] : [oppAvatar, myAvatar];
    Game.startOnline({ mySeat: seat, names, avatars, seed: data.seed });
    if (Chat) Chat.show(data.opponent);
  });

  // In-match gameplay messages from the opponent. Chat rides the same channel
  // but isn't game state, so it's peeled off here and never reaches apply().
  Net.on('game', msg => {
    if (msg && msg.t === 'chat') { if (Chat) Chat.receive(msg.text); return; }
    Game.apply(msg);
  });

  // The server settled the match's Elo — pull out this player's swing and show
  // it on the end screen. Keyed by username; myUsername comes from 'welcome'.
  Net.on('rating', data => {
    if (!inMatch || !data || !data.ratings) return;
    const mine = data.ratings[myUsername];
    if (mine && typeof Game.showRating === 'function') Game.showRating(mine);
  });

  // Opponent bailed, or our own connection dropped mid-match → back to lobby.
  // But once the game is over, both players are sitting on the end screen; the
  // opponent quitting (or hitting rematch) shouldn't drag us out of our own
  // recap — only a mid-game departure ends the match for the player left behind.
  Net.on('opponent-left', () => {
    if (!inMatch) return;
    if (Game.isOver && Game.isOver()) return;
    toLobby('Opponent left the match.');
  });
  Net.on('status', kind => {
    if (inMatch && (kind === 'disconnected' || kind === 'error')) toLobby('Disconnected.');
  });
})();
