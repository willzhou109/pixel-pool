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
const { recordMatch } = require('./history');
const { applyResult } = require('./ratings');
const { areFriends } = require('./friends');
const presence = require('./presence');
const social = require('./social');
const invites = require('./invites');
const commentary = require('./commentary');

// Live match bookkeeping for history recording, keyed by room:
// { names: [seat0Username, seat1Username], startMs, recorded }.
// Seat 0 is always the breaker (that's how the clients assign seats too).
const liveMatches = new Map();

function initRealtime(httpServer) {
  const io = new Server(httpServer);
  // Let presence-based REST handlers (friends.js / chat.js) push to sockets.
  presence.setIo(io);

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

    // Presence + chat (friends list, DMs) ride the same authenticated socket.
    social.onConnect(io, socket);

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

    /* ----------------------------- game invites ---------------------------- */
    // Invite a friend to play right now. Ephemeral (invites.js): pushed to the
    // friend's sockets so it shows in their friend list until accepted/declined
    // or a disconnect drops it.
    socket.on('send-invite', payload => {
      const to = String((payload && payload.to) || '').trim();
      if (!to || to.toLowerCase() === username.toLowerCase()) return;
      if (socket.data.room) return socket.emit('invite-error', { message: 'Finish your current game first.' });
      if (!areFriends(username, to)) return socket.emit('invite-error', { message: 'You can only invite friends.' });
      if (!presence.isOnline(to)) return socket.emit('invite-error', { message: `${to} is offline.` });
      invites.create(username, to, socket.id);
      presence.emitToUser(to, 'game-invite', { from: username });
      socket.emit('invite-sent', { to });
    });

    // Decline an invite: drop it and let the inviter know.
    socket.on('reject-invite', payload => {
      const from = String((payload && payload.from) || '').trim();
      if (from && invites.remove(from, username)) {
        presence.emitToUser(from, 'invite-declined', { by: username });
      }
    });

    // Accept an invite: pull both players into a match right now.
    socket.on('accept-invite', payload => {
      const from = String((payload && payload.from) || '').trim();
      if (!from || socket.data.room) return;
      const rec = invites.get(from, username);
      if (!rec) { socket.emit('invite-cancelled', { from }); return socket.emit('invite-error', { message: 'That invite is no longer available.' }); }
      // Prefer the exact socket the invite was sent from; fall back to any live,
      // not-in-a-game socket of the inviter (they may have reconnected).
      let inviter = io.sockets.sockets.get(rec.fromSocketId);
      if (!inviter || inviter.data.room) {
        inviter = presence.socketsFor(from).map(id => io.sockets.sockets.get(id)).find(s => s && !s.data.room) || null;
      }
      if (!inviter) {
        invites.remove(from, username);
        socket.emit('invite-cancelled', { from });
        return socket.emit('invite-error', { message: `${from} is no longer available.` });
      }
      // Clear any other invites either player has in flight (they're busy now),
      // then start the match. waitingId is cleared if either was mid-search.
      cancelInvitesFor(username);
      cancelInvitesFor(from);
      if (waitingId === socket.id || waitingId === inviter.id) waitingId = null;
      startMatch(io, inviter, socket);
    });

    // Client-authoritative gameplay: relay any in-match message straight to the
    // opponent. The server never validates gameplay — the two clients agree on
    // game state between themselves (see js/online.js). The one message it
    // peeks at is the authoritative end-of-game 'state' (phase 'end'), which
    // already carries winner/reason/stats — that's when the match is recorded.
    socket.on('game', msg => {
      const room = socket.data.room;
      if (!room) return;
      socket.to(room).emit('game', msg);
      if (msg && msg.t === 'state' && msg.phase === 'end') recordEnd(io, room, msg);
    });

    socket.on('disconnect', () => {
      if (waitingId === socket.id) waitingId = null;
      leaveMatch(io, socket);
      cancelInvitesFor(username); // drop this user's invites, tell the recipients
      social.onDisconnect(io, socket);
      console.log(`[rt] ${username} disconnected`);
    });
  });

  return io;
}

/* -------------------------------- helpers -------------------------------- */

// Drop every game invite `user` is part of and tell each invite's recipient to
// remove it from their friend list (their inviter went away or got busy).
function cancelInvitesFor(user) {
  for (const rec of invites.clearForUser(user)) {
    presence.emitToUser(rec.to, 'invite-cancelled', { from: rec.from });
  }
}

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
  liveMatches.set(room, {
    names: aBreaks ? [a.data.username, b.data.username] : [b.data.username, a.data.username],
    startMs: Date.now(),
    recorded: false,
  });
  a.emit('match-found', { room, opponent: b.data.username, youBreak: aBreaks, seed });
  b.emit('match-found', { room, opponent: a.data.username, youBreak: !aBreaks, seed });
  console.log(`[rt] match: ${a.data.username} vs ${b.data.username} (${room})`);
}

// A game in `room` reached its end state — persist it to match history and
// update both players' Elo ratings (once; rematches re-arm `recorded` if/when
// they exist, for now one end per room).
function recordEnd(io, room, msg) {
  const m = liveMatches.get(room);
  if (!m || m.recorded) return;
  if (msg.winner !== 0 && msg.winner !== 1) return; // only decisive games count
  m.recorded = true;
  try {
    const matchId = recordMatch(m.names, msg.winner, msg.reason,
      Math.round((Date.now() - m.startMs) / 1000), msg.stats);
    console.log(`[rt] recorded: ${m.names[0]} vs ${m.names[1]} — seat ${msg.winner} won`);
    // Queue the AI recap. Returns immediately — generation happens in the
    // background and lands in matches.commentary; the players' end screen is
    // never held up waiting on it.
    commentary.queueForMatch(matchId);
  } catch (e) {
    console.error('[rt] failed to record match:', e);
  }
  // Elo update, keyed by seat: msg.winner is the winning seat (0 or 1), and
  // m.names[seat] is that seat's username. Echo the change to both clients so
  // the end screen can show each player their own +/- rating swing.
  try {
    const { winner, loser } = applyResult(m.names[msg.winner], m.names[1 - msg.winner]);
    const ratings = {
      [winner.username]: { rating: winner.after, delta: winner.delta },
      [loser.username]: { rating: loser.after, delta: loser.delta },
    };
    io.to(room).emit('rating', { ratings });
    console.log(`[rt] elo: ${winner.username} ${winner.delta >= 0 ? '+' : ''}${winner.delta} ` +
      `(${winner.after}), ${loser.username} ${loser.delta} (${loser.after})`);
  } catch (e) {
    console.error('[rt] failed to update ratings:', e);
  }
}

// Remove `socket` from its match (if any) and reset both players so they can
// re-queue. The opponent is told the match ended. Safe to call repeatedly.
function leaveMatch(io, socket) {
  const room = socket.data.room;
  if (!room) return;
  liveMatches.delete(room); // recording (if any) already happened at game end

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
