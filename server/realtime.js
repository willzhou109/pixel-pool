/* Real-time layer for Pixel Pool Online (Socket.IO).
 *
 * Handles authenticated connections and matchmaking:
 *   - Every socket must present a valid session token in its handshake, or it
 *     is rejected before `connection` fires (see auth.js / verifyToken).
 *   - `find-match` puts a player in a one-slot queue; the next player to search
 *     is paired with them into a private Socket.IO room and both get
 *     `match-found`. `cancel-match` / `leave-match` / disconnect unwind cleanly.
 *
 * Socket.IO shares the http.Server that serves the game + REST API. Shot sync
 * (streaming ball state within a room) is the next step to build on top.
 */
'use strict';

const { Server } = require('socket.io');
const { verifyToken } = require('./auth');

function initRealtime(httpServer) {
  const io = new Server(httpServer);

  // Gate every connection on a valid session token (sent as handshake auth).
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const username = verifyToken(token);
    if (!username) return next(new Error('unauthorized'));
    socket.data.username = username;
    next();
  });

  // The single player currently waiting for an opponent (socket id), or null.
  let waitingId = null;

  io.on('connection', socket => {
    const { username } = socket.data;
    console.log(`[rt] ${username} connected (${socket.id})`);
    socket.emit('welcome', { username });

    socket.on('find-match', () => {
      if (socket.data.room) return;                    // already in a match
      const other = waitingId && waitingId !== socket.id
        ? io.sockets.sockets.get(waitingId)
        : null;
      if (other) {
        waitingId = null;
        startMatch(io, socket, other);
      } else {
        waitingId = socket.id;
        socket.emit('waiting');
      }
    });

    socket.on('cancel-match', () => {
      if (waitingId === socket.id) waitingId = null;
    });

    socket.on('leave-match', () => leaveMatch(io, socket));

    // Client-authoritative gameplay: relay any in-match message straight to the
    // opponent. The server never inspects or validates it — the two clients
    // agree on game state between themselves (see js/online.js).
    socket.on('game', msg => {
      if (socket.data.room) socket.to(socket.data.room).emit('game', msg);
    });

    socket.on('disconnect', () => {
      if (waitingId === socket.id) waitingId = null;
      leaveMatch(io, socket);
      console.log(`[rt] ${username} disconnected`);
    });
  });

  return io;
}

/* -------------------------------- helpers -------------------------------- */

function startMatch(io, a, b) {
  const room = `m_${a.id}_${b.id}`;
  for (const s of [a, b]) s.join(room);
  a.data.room = b.data.room = room;
  a.data.opponent = b.id;
  b.data.opponent = a.id;

  // Randomly decide who breaks, and share one rack seed so both clients
  // generate the identical starting layout.
  const aBreaks = Math.random() < 0.5;
  const seed = (Math.random() * 0x7fffffff) | 0;
  a.emit('match-found', { room, opponent: b.data.username, youBreak: aBreaks, seed });
  b.emit('match-found', { room, opponent: a.data.username, youBreak: !aBreaks, seed });
  console.log(`[rt] match: ${a.data.username} vs ${b.data.username} (${room})`);
}

// Remove `socket` from its match (if any) and reset both players so they can
// re-queue. The opponent is told the match ended. Safe to call repeatedly.
function leaveMatch(io, socket) {
  const room = socket.data.room;
  if (!room) return;

  // Notify the opponent while both are still in the room.
  socket.to(room).emit('opponent-left', { username: socket.data.username });

  const oppId = socket.data.opponent;
  socket.leave(room);
  socket.data.room = null;
  socket.data.opponent = null;

  const opp = oppId && io.sockets.sockets.get(oppId);
  if (opp) {
    opp.leave(room);
    opp.data.room = null;
    opp.data.opponent = null;
  }
  console.log(`[rt] ${socket.data.username} left ${room}`);
}

module.exports = { initRealtime };
