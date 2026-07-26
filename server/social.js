/* Social real-time layer for Pixel Pool Online.
 *
 * Presence + chat over the same Socket.IO connection realtime.js already
 * authenticates. realtime.js calls onConnect/onDisconnect around its own
 * matchmaking wiring; everything social lives here so matchmaking stays lean.
 *
 *   - Presence: on connect we send this socket a snapshot of which of its
 *     friends are online, and tell those friends we came online (only when this
 *     is the user's first socket). On the last socket closing, friends are told
 *     we went offline. (friend-request / friend-accepted pushes are emitted
 *     from the REST handlers in friends.js, not here.)
 *   - Chat: the 'dm' event persists a message (chat.js) and delivers it to both
 *     the recipient's and the sender's sockets, so every tab stays in sync and
 *     the client never has to guess an id or ordering.
 */
'use strict';

const presence = require('./presence');
const { areFriends, friendUsernames } = require('./friends');
const { saveMessage, markRead, MAX_BODY } = require('./chat');

function onConnect(io, socket) {
  const me = socket.data.username;
  const first = presence.add(me, socket.id);
  const friends = friendUsernames(me);

  // Snapshot: which of my friends are online right now.
  socket.emit('presence', { online: friends.filter(f => presence.isOnline(f)) });

  // If I just came online (first tab), let my online friends know.
  if (first) {
    for (const f of friends) {
      if (presence.isOnline(f)) presence.emitToUser(f, 'friend-online', { username: me });
    }
  }

  // Send a direct message to a friend. Persisted, then delivered to both sides.
  socket.on('dm', payload => {
    const to = String((payload && payload.to) || '').trim();
    const text = String((payload && payload.text) || '').trim().slice(0, MAX_BODY);
    if (!to || !text) return;
    if (!areFriends(me, to)) return; // DMs are friends-only
    const row = saveMessage(me, to, text);
    presence.emitToUser(to, 'dm', row);
    presence.emitToUser(me, 'dm', row); // echo to all my tabs, including this one
  });

  // The client marks a conversation read when it's opened/viewed. Opening it
  // over REST already clears unread; this covers messages seen live while the
  // conversation is on screen, so they don't resurface as unread on next login.
  socket.on('mark-read', payload => {
    const other = String((payload && payload.other) || '').trim();
    if (other) markRead(me, other);
  });
}

function onDisconnect(io, socket) {
  const me = socket.data.username;
  const nowOffline = presence.remove(me, socket.id);
  if (!nowOffline) return; // still connected from another tab
  for (const f of friendUsernames(me)) {
    if (presence.isOnline(f)) presence.emitToUser(f, 'friend-offline', { username: me });
  }
}

module.exports = { onConnect, onDisconnect };
