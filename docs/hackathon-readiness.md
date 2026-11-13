# Hackathon readiness and demo plan

## What judges can observe

| Requirement | Implementation | Evidence/status |
|---|---|---|
| Invite a team into one shared room | Invite URL carries the current board ID; board title is an operation shared through the board log. | Verify by opening the exact copied link on a phone and a second browser; both should show the same room ID and edits. |
| Concurrent edits converge | Redis assigns a board-wide Lamport clock; field-level reducers use Lamport + actor tie-break; operation IDs deduplicate retries. | `npm run stress:200 -- <endpoint-a> <endpoint-b>` sends 200 simultaneous writes to the same shape and checks every client receives every operation and both endpoints return the same state. Run this before claiming a measured result. |
| Offline edits survive a two-minute disconnect | Browser applies locally, writes to IndexedDB outbox, and replays on reconnect. Redis failure closes the socket without clearing the outbox. | Not yet run for two minutes on judge browsers. Browser storage must remain enabled and uncleared. |
| Presence clears after an abrupt close | Presence is per tab; normal disconnect deletes it, Redis expiry is five seconds, and other browsers prune stale presence after four seconds. | Close a browser window and time the people list. The UI behavior has not been load measured. |
| 5,000 objects stay responsive | Fixed stress room, canvas viewport culling, spatial grid for draw/hit-test, and cached board bounds for minimap. | The stress script times the API board read. It does not measure a real phone's render time or prove the under-one-second target. |
| Two app instances use one board | App processes share Redis Streams, snapshots, Lamport clock, presence, and Pub/Sub. | Blueprint adds a second free Render service on a distinct public URL. Its sync still needs approval; the current Render service is one free instance. These are two endpoints rather than one Render load-balanced service. |
| Stop an app instance | Local WebSocket clients detect closure and reconnect with capped backoff; edits remain in the local outbox. The other endpoint keeps the shared board. | Not yet failure tested. On the two-URL free topology, browsers on a stopped URL need that endpoint to return or need to open the other URL. |
| Interrupt Redis | Redis commands fail promptly; the browser stays editable and keeps pending operations for replay. | Not yet failure tested against the hosted Redis service. Do not interrupt the shared judging Redis without a planned demo window. |
| 150 ms p95 / 200 users | Stress tool records same-runner peer receive p95; app panel reports Redis relay p95 only. | Not measured yet. A same-runner result is not the p95 for phones on external networks. |
| Architecture and design defence | See [architecture](architecture.md) and [decision record](decision-record.md). | Included in this repository. |

## Judge walkthrough

1. Open the public endpoint A and B on separate browsers. Keep `?board=studio` on both. Use **Invite** and confirm the URL contains the current board ID; the dialog names that same room.
2. Draw on A, edit the same shape from B, and confirm both canvases converge. Undo in one browser and confirm it sends only that browser's compensating edits.
3. In browser A, enable DevTools network offline mode, edit several shapes for two minutes, restore the network, wait for “All changes saved,” and confirm those edits on B.
4. Close a browser abruptly and watch its avatar disappear within five seconds.
5. Open **Try 5,000 objects**. It uses the isolated `stress-demo` room and does not reset `studio`.
6. For 200 clients, run the stress command below from a machine with Node 20 and network access. It reports actual app instance IDs, operation fanout, convergence, same-runner peer receive p95, and API board-read time.
7. Restart an app endpoint from Render and repeat the edit/reconnect check. Redis interruption should be rehearsed separately against a disposable Redis instance; no public fault-injection control is exposed.

```powershell
npm run stress:200 -- https://syncboard-public-ebsk.onrender.com https://<second-render-service>.onrender.com
```

## Current proof boundary

The code paths and reproducible demo are prepared, but the live 200-client run, two-minute offline run, app-stop run, Redis-interruption run, 150 ms p95, and under-one-second browser render are not yet verified. The existing public deployment currently has one free Render service. Render's free compute plan supports one instance per service, so this Blueprint uses a second public endpoint for the cross-instance demonstration instead of silently converting the current service to a paid load-balanced plan.

