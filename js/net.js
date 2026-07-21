/* Client-side network layer for Pixel Pool Online (Socket.IO).
 *
 * Thin wrapper around the socket connection so the rest of the front-end never
 * touches socket.io directly. Step 1: connect with the saved session token and
 * surface a simple status ('connecting' | 'connected' | 'disconnected' |
 * 'error'). Matchmaking and shot sync build on top of this later.
 *
 * Requires the Socket.IO browser client (served by our server at
 * /socket.io/socket.io.js), so it only works when the game is opened through
 * the server — the same requirement as online mode generally.
 */
(function () {
  'use strict';

  let socket = null;
  const listeners = Object.create(null);

  function on(event, fn) {
    (listeners[event] || (listeners[event] = [])).push(fn);
  }
  function fire(event, ...args) {
    (listeners[event] || []).forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });
  }

  function connect(token) {
    if (typeof io === 'undefined') {
      fire('status', 'error', 'Socket.IO client failed to load.');
      return;
    }
    if (socket && socket.connected) { fire('status', 'connected'); return; }

    fire('status', 'connecting');
    socket = io({ auth: { token }, reconnectionAttempts: 5 });

    socket.on('connect', () => fire('status', 'connected'));
    socket.on('welcome', data => fire('welcome', data));
    socket.on('disconnect', reason => fire('status', 'disconnected', reason));
    // Fired when the auth middleware rejects us (bad/expired token) or the
    // server is unreachable.
    socket.on('connect_error', err => fire('status', 'error', err.message));

    // Matchmaking events, forwarded straight through to listeners.
    socket.on('waiting', () => fire('waiting'));
    socket.on('match-found', data => fire('match-found', data));
    socket.on('opponent-left', data => fire('opponent-left', data));

    // In-match gameplay messages (aim / shoot / snapshots / state).
    socket.on('game', msg => fire('game', msg));
  }

  function disconnect() {
    if (socket) { socket.disconnect(); socket = null; }
  }

  // Matchmaking actions (no-ops if not connected yet).
  const send = event => { if (socket) socket.emit(event); };
  const findMatch = () => send('find-match');
  const cancelMatch = () => send('cancel-match');
  const leaveMatch = () => send('leave-match');

  // In-match gameplay message to the opponent (relayed by the server).
  const sendGame = msg => { if (socket) socket.emit('game', msg); };

  window.PixelPoolNet = {
    connect,
    disconnect,
    findMatch,
    cancelMatch,
    leaveMatch,
    sendGame,
    on,
    get socket() { return socket; },
    get connected() { return !!(socket && socket.connected); },
  };
})();
