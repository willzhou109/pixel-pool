# Pixel Pool Online — server

A tiny backend for account login/signup, built entirely on Node built-ins
(no `npm install` needed).

- **HTTP + static:** `node:http` serves the game (index.html, js/, lib/) *and*
  the auth API from one origin.
- **Storage:** `node:sqlite` → `data/pool.db` (gitignored). Only password
  **hashes** are stored.
- **Passwords:** hashed with `crypto.scrypt` (salted, memory-hard).
- **Sessions:** HMAC-signed tokens (JWT-style), no external library.

## Run

```bash
node server/server.js
# or:  cd server && npm start
```

Then open **http://localhost:3000** and click **ONLINE**.

> Serving the game through this server (not `file://`) is what lets the
> ONLINE screens reach `/api/...`. Offline mode works either way.

## API

| Method | Path          | Body                        | Returns                       |
|--------|---------------|-----------------------------|-------------------------------|
| POST   | `/api/signup` | `{ username, password }`    | `{ token, username }` (201)   |
| POST   | `/api/login`  | `{ username, password }`    | `{ token, username }` (200)   |
| GET    | `/api/me`     | `Authorization: Bearer <t>` | `{ username }` (200)          |

Rules: username 3–20 of `[A-Za-z0-9_]`, password 8–200 chars. Login errors are
deliberately generic ("Invalid username or password").

## Config

- `PORT` — default `3000`.
- `PP_SECRET` — token-signing secret. Unset ⇒ a random per-run secret (fine for
  dev; tokens reset when the server restarts). Set it for a stable secret:

  ```bash
  PP_SECRET="$(openssl rand -hex 32)" node server/server.js
  ```

## Notes / next steps

- This is dev-grade. For real deployment: run behind HTTPS, set a persistent
  `PP_SECRET`, and add stronger rate limiting.
- The session token is the intended hook for authenticating the future
  Socket.IO multiplayer connection.
