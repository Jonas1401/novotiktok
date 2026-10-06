# Live Tower Battle

Interactive stream game where viewers affect a real-time **Red vs Blue tower battle** through TikTok Live events.

## What This Project Does

- Runs a live match with two teams (`red` and `blue`) and tower HP.
- Converts TikTok interactions into game actions:
  - gifts -> damage/support events
  - likes -> power bar progress and temporary boost mode
  - chat (`1`, `2`, `red`, `blue`) -> team pick and soldier spawn
  - joins/view events -> welcome and audience effects
- Streams all gameplay updates to connected browsers with `Socket.IO`.
- Stores daily damage leaderboard data in `data/leaderboard.json`.

## Features

- Real-time game state broadcasting with `Socket.IO`
- Team damage, combo chains, crits, and sudden-death mode
- Power mode triggered by engagement
- Daily leaderboard and per-match team contribution panels
- Streamer/admin panel with manual controls and offline test events

## Tech Stack

- Node.js (>= 20, `22.x` recommended)
- Express
- Socket.IO
- [tiktok-live-connector](https://www.npmjs.com/package/tiktok-live-connector) 2.x (loaded through its `legacy` entry point)
- Vanilla HTML/CSS/JavaScript frontend

## Project Structure

```
server.js              backend game engine, TikTok integration, API routes, Socket.IO server
public/index.html      main game page
public/game.js         client renderer, animations, socket listeners
public/style.css       game and HUD styling
public/admin.html      streamer control interface
Dockerfile             container image for WebSocket-capable hosts
render.yaml            one-click Render deploy config
data/leaderboard.json  daily leaderboard storage (created at runtime, git-ignored)
```

## Local Setup

```bash
npm install
npm start
```

Open in browser:

- Game: `http://localhost:3000`
- Admin: `http://localhost:3000/admin`
- Health: `http://localhost:3000/health`

Copy `.env.example` to `.env` (or export the variables) to configure it.

## Environment Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + Socket.IO port |
| `HOST` | `0.0.0.0` | Keep `0.0.0.0` in containers/previews |
| `TIKTOK_USERNAME` | _(empty)_ | Account name without `@`. Empty = no TikTok connection |
| `TIKTOK_ROOM_ID` | _(empty)_ | Optional: pin an exact room id |
| `ADMIN_TOKEN` | `admindev` | **Set this before going live** |
| `LEADERBOARD_FILE` | `./data/leaderboard.json` | Must be writable |

The server prints a warning at startup when `ADMIN_TOKEN` is still the public default.

## Deploying

### Vercel will not host this app

Vercel builds and runs request-scoped functions that scale horizontally. This game keeps the
entire match in a single process's memory (`gameState`, combo counters, power bar), pushes
updates to every viewer over a persistent `Socket.IO` connection, runs background timers
(the match clock, sudden-death check, spiker messages) and writes `data/leaderboard.json`
to disk. None of that survives on Vercel: there is no long-lived process, no shared memory
between invocations, no background timers and no writable filesystem.

A Vercel deploy of this repo therefore publishes a **static page only** — no game server
behind it. Two things are worth knowing about the failed build you may see:

- The build itself succeeds ("Build Completed in /vercel/output"). The failure happens
  afterwards, in the separate "Deploying outputs..." upload step, and the log often shows no
  error line at all.
- That stage fails for project/account reasons rather than code reasons. The most common
  documented cause is a **Hobby** project with more than one Function Region selected
  (Hobby allows exactly one): Dashboard -> Settings -> Functions -> Function Region, keep a
  single region, save, then redeploy. A transient Vercel incident has the same signature.

If you specifically want the overlay served from a CDN, you can host `public/` statically and
point it at a game server running elsewhere: set `window.GAME_SERVER_URL` in
`public/index.html` to that server's origin before `game.js` loads. The game server already
allows cross-origin Socket.IO clients.

### Use a host that keeps a process alive

Render, Railway, Fly.io, a VPS — anything that runs a long-lived Node process and supports
WebSockets. Two configs are included:

**Render** — point Render at this repo; it reads `render.yaml`, generates an `ADMIN_TOKEN`
and exposes the app with a `/health` check.

**Docker** (Fly.io, Railway, any container host):

```bash
docker build -t live-tower-battle .
docker run -p 3000:3000 \
  -e TIKTOK_USERNAME=your_account \
  -e ADMIN_TOKEN=replace_me \
  -v "$PWD/data:/app/data" \
  live-tower-battle
```

Mount a volume on `/app/data` or mount a disk, otherwise the leaderboard resets on every
deploy. The server keeps playing if the filesystem is read-only — it just logs a warning and
stops persisting scores.

## Verifying It Works Without a Live Stream

The TikTok connector only receives events while the target account is live. To exercise the
whole pipeline offline, open `/admin` and use the **Offline test events** buttons, or call the
API directly:

```bash
curl -X POST http://localhost:3000/admin/api \
  -H "Content-Type: application/json" -H "Authorization: Bearer your_token" \
  -d '{"action":"simulateGift","nickname":"Dave","diamonds":1500}'
```

These inject events through the exact same code path the connector uses, so the overlay,
leaderboard and match-end flow all behave as they would live.

## HTTP Endpoints

- `GET /` -> game UI
- `GET /admin` -> admin panel UI
- `GET /health` -> liveness/readiness probe
- `GET /api/leaderboard` -> top daily damage entries
- `POST /admin/api` -> admin actions (requires token)

## Admin API

Authentication:

- `Authorization: Bearer <ADMIN_TOKEN>` header, or
- JSON field `token`

Actions (`POST /admin/api`):

| Action | Payload | Effect |
| --- | --- | --- |
| `extendMatch` | `ms` | Add time to the current match |
| `spawnBot` | `team`, `name` | Spawn a bot soldier |
| `powerMode` | `ms` | Force power mode on |
| `suddenDeath` | – | Enter the high-impact final round |
| `resetMatch` | – | Immediately reset the match |
| `simulateGift` | `nickname`, `diamonds`, `uniqueId` | Inject a gift event |
| `simulateChat` | `nickname`, `comment`, `uniqueId` | Inject a chat event |
| `simulateJoin` | `nickname`, `uniqueId`, `followers` | Inject a viewer join |
| `simulateLikes` | `count` | Inject likes |

Example:

```bash
curl -X POST http://localhost:3000/admin/api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_token" \
  -d '{"action":"extendMatch","ms":60000}'
```

## Socket Events

Server emits (selected):

- `init`, `state`, `gameReset`, `gameOver`
- `giftStrike`, `likeBurst`, `powerMode`
- `viewerJoin`, `viewerJoinEffect`, `viewerCount`
- `spiker`, `bonusPoolWin`, `suddenDeath`, `soldier`, `tiktokStatus`

## Public Release Checklist

- Set a strong `ADMIN_TOKEN` in environment variables.
- Set a valid `TIKTOK_USERNAME` or `TIKTOK_ROOM_ID`.
- Keep the leaderboard path writable (mount a volume in production).
- Do not commit private credentials or `.env` files.
- Deploy to a host that supports long-lived processes and WebSockets (not Vercel).

## Screenshot

![Live Tower Battle Screenshot](public/app-screenshot.png)

## License

No license file is included yet. Add a `LICENSE` file before public distribution if needed.
