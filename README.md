# SyncBoard

SyncBoard is a collaborative whiteboard prototype with a real-time canvas, local-first edit queue, cross-instance event delivery, presence, and a 5,000-object performance board.

## Run it locally

Requires Node.js 20 or newer.

```powershell
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without `REDIS_URL`, the app uses a local append-only edit log and snapshots in `data/`. This mode supports the full UI, websocket workflow, and restart recovery for one server process; it does not coordinate multiple processes.

## Windows desktop launch

Run `powershell -ExecutionPolicy Bypass -File .\tools\New-SyncBoardShortcut.ps1` once to create a branded **SyncBoard** icon on your Desktop. After public deployment, save the HTTPS service URL to `data/public-url.txt`; the shortcut opens the shared board in Microsoft Edge. Use `tools/Start-SyncBoard.ps1 -LocalDevelopment` only when you intentionally want to run the board on this computer.

## Public demo deployment

See [DEPLOYING.md](DEPLOYING.md) for the Render and Redis setup. The public app is phone-accessible; the Blueprint includes a second public endpoint wired to the same Redis store for cross-instance judging. That Blueprint addition must be approved before the second endpoint is available.

## Run the two-instance Redis setup

Requires Docker Compose.

```powershell
docker compose -f compose.yml up --build
```

Open [http://localhost:8080](http://localhost:8080). Nginx distributes HTTP and websocket connections across two stateless Node instances. Redis runs with AOF persistence and backs the operation streams, snapshots, idempotency keys, server clocks, and expiring presence records.

The **Try 5,000 objects** action creates a separate stress board and loads it into the canvas. The app uses a canvas renderer and viewport culling so off-screen shapes do not need to be painted.

For the public 200-client cross-instance run, use Node 20 and two different public endpoint URLs:

```powershell
npm run stress:200 -- https://syncboard-public-ebsk.onrender.com https://<second-render-service>.onrender.com
```

The script uses the isolated `stress-demo` board, sends concurrent edits to the same shape, verifies delivery to every connected client, compares the final board from both endpoints, and reports same-runner peer receive p95 and API read time.

## Collaboration model

- Each edit is a small operation with an operation ID, actor, entity, action, and changed fields. Edits never replace the entire board document.
- Redis Lua atomically deduplicates an operation, applies a per-user rate limit, assigns its board Lamport number, appends it to the board's Redis Stream, and publishes the ordered event. All app instances subscribe to the shared event channel and fan updates out to their local websocket clients.
- Each object field is a last-writer-wins register ordered by the server-assigned board Lamport number and actor ID. Different fields merge independently; simultaneous edits to the same field resolve deterministically, so every client reaches the same state.
- Undo and redo send compensating operations for the current user's own local history. Other users' operations are never removed from the shared log.
- The browser stores the board cache and outbound edit queue in IndexedDB. It can continue editing offline; reconnect replays queued operation IDs, while server-side idempotency makes retries safe.
- Presence is refreshed every 2.5 seconds and expires in Redis after 5 seconds. Cursor positions are broadcast separately from document operations.
- A snapshot compacts the materialized board after 800 operations. Older stream entries through the snapshot cursor are trimmed; reconnecting clients receive the snapshot plus any later stream tail.

## Main pieces

- `src/server.js` — HTTP API, websocket protocol, Redis and local stores, operation validation, rate limiting, presence, snapshots, and metrics.
- `public/app.js` — canvas renderer, tools, selection, multi-select, alignment guides, local-first edits, offline replay, presence, and inspector.
- `public/styles.css` — responsive interface, interaction states, reduced-motion support, and CSS motion system.
- `compose.yml` and `nginx.conf` — two app instances, Redis persistence, and websocket-aware load balancing.

The 200-user, 150 ms, two-minute offline, one-second render, and failure targets still need live judging-device runs. The live panel's p95 is Redis relay delay, not end-to-end browser latency. See [the readiness matrix](docs/hackathon-readiness.md), [architecture](docs/architecture.md), and [design decision](docs/decision-record.md) for the exact proof boundary.

