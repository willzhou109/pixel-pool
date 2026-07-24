/* Online-presence registry for Pixel Pool Online.
 *
 * Tracks which signed-in users currently have at least one live socket, so the
 * social layer can show friends as online/offline and push real-time events
 * (friend requests, chat DMs) straight to a user's sockets — from either a
 * socket handler (social.js) or a REST handler (friends.js / chat.js), which is
 * why the io reference lives here rather than being threaded through everywhere.
 *
 * A user can be connected from several tabs at once, so each username maps to a
 * Set of socket ids; the user is "online" while that set is non-empty.
 * Usernames are keyed case-insensitively to match the DB's NOCASE collation.
 */
'use strict';

let io = null;
const online = new Map(); // usernameLower -> Set<socketId>

const key = u => String(u).toLowerCase();

/** Called once from realtime.js so REST handlers can emit without an io param. */
function setIo(server) { io = server; }

/** Register a socket for a user. Returns true if this is their FIRST socket. */
function add(username, socketId) {
  const k = key(username);
  let set = online.get(k);
  const first = !set;
  if (!set) online.set(k, (set = new Set()));
  set.add(socketId);
  return first;
}

/** Drop a socket for a user. Returns true if they are now fully offline. */
function remove(username, socketId) {
  const k = key(username);
  const set = online.get(k);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) { online.delete(k); return true; }
  return false;
}

function isOnline(username) { return online.has(key(username)); }

function socketsFor(username) { return [...(online.get(key(username)) || [])]; }

/** Emit an event to every live socket of `username` (no-op if offline). */
function emitToUser(username, event, data) {
  if (!io) return;
  for (const id of socketsFor(username)) io.to(id).emit(event, data);
}

module.exports = { setIo, add, remove, isOnline, socketsFor, emitToUser };
