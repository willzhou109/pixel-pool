# Pixel Pool

A browser-based 3D 8-ball pool game with real-time multiplayer and a genuinely
intelligent computer opponent — built from scratch in vanilla JS + Three.js,
with a zero-third-party-dependency Node backend.

**Play it live:** https://pixel-pool-production.up.railway.app/

## Features

- **Full 8-ball physics** — friction, cushion bounces, pocket capture, and
  equal-mass ball collisions, simulated frame-by-frame rather than faked.
- **A computer opponent that plans ahead.** Most pool AIs just aim at the
  easiest pot. This one replays the physics engine to predict where the cue
  ball will actually stop after each candidate shot, then scores shots by
  *both* pot difficulty and how good the resulting position is for the next
  shot — the same way a real player thinks two shots ahead. It also plays
  bank shots, kick shots, and safeties when nothing direct is on.
- **Real-time online multiplayer** (Socket.IO) with matchmaking, live
  spectating of your opponent's cue, and in-match chat.
- **Elo ratings**, per-player match history with full shot-by-shot replay,
  and lifetime career stats (pots, fouls, streaks, win rate).
- **Accounts** — sign up with a username/password or Google sign-in, both
  verified with nothing but Node's own `crypto` (scrypt password hashing,
  hand-verified Google ID tokens — no auth library).
- **Friends, DMs, and game invites** — add friends, message them, and invite
  them into a live match.
- **Vs-computer offline mode** with adjustable difficulty, alongside local
  hot-seat 2-player.
- Cosmetic depth: 7 table styles, 5 background scenes (including a full
  outer-space environment), and pickable avatars.

## Tech stack

- **Frontend:** vanilla JavaScript, Three.js for 3D rendering, no framework
  or build step — open `index.html` through the server and it just runs.
- **Backend:** Node.js built-ins only for the core server — `node:http` for
  serving the app and a JSON API, `node:sqlite` for storage, `node:crypto`
  for password hashing and session tokens. Socket.IO is the one real
  dependency, used for the real-time multiplayer layer.

## Running it locally

Requires **Node ≥22.5** (for `node:sqlite`).

```bash
npm install
npm start
```

Then open **http://localhost:3000**. Offline modes (hot-seat and vs-computer)
work immediately; online mode needs the server running since it talks to
`/api/...` on the same origin.

### Optional environment variables

| Variable          | Purpose                                                            |
|--------------------|---------------------------------------------------------------------|
| `PORT`             | Server port (default `3000`).                                       |
| `PP_SECRET`        | Signing secret for session tokens. Unset ⇒ random per run (dev-only; tokens reset on restart). |
| `GOOGLE_CLIENT_ID` | Enables the "Sign in with Google" button. Omit to disable it cleanly. |

See [`server/README.md`](server/README.md) for the full API reference.

## Project structure

```
index.html        entry point + all UI markup/styles
js/                frontend: rendering, physics, input, AI, UI panels
server/            backend: auth, matches, ratings, friends/chat, realtime
```

The AI opponent's shot planning lives in `js/bot.js` (shot selection and
scoring) and `js/position.js` (the physics roll-out simulation it plans
against).
