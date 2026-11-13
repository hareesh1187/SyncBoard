# Public SyncBoard deployment

This deploys public SyncBoard endpoints and a hosted Redis database. Anyone who opens the same board link joins the shared `studio` board, including from a phone. The Redis URL is a private service credential; never commit it.

## 1. Publish the source repository

Push this project to a GitHub repository that Render can access. To make the source itself open to everyone, set the repository visibility to **Public**. Keep `REDIS_URL`, tokens, and other credentials out of Git.

## 2. Create hosted Redis

Create a Redis database in Upstash, preferably in Singapore to stay close to the Render service. Copy its TLS connection URL (`rediss://...`). The Upstash free tier currently lists 256 MB and 500,000 commands per month, which is suitable for a small judging demo. Review the current limits before sharing the app broadly.

## 3. Deploy the Render Blueprint

The first Blueprint sync creates the Docker web service in Singapore and prompts for `REDIS_URL`. Enter the Upstash TLS URL privately in Render. The second service, `syncboard-instance-b`, copies that variable from the existing public service with Render's `fromService` reference; no secret is placed in this repository. Review and approve the Blueprint plan before Render creates the second endpoint. Both services serve the UI and WebSocket endpoint and use the same Redis streams, snapshots, and Pub/Sub channel.

Render's free compute plan allows one instance per service. This demo therefore exposes two public service URLs rather than two instances behind one load-balanced URL. Open both URLs with `?board=studio` for the cross-instance demonstration. If you later want one URL with Render load balancing, the web service needs a paid compute plan; the current Blueprint keeps both demo services on the free plan.

Render's free web service sleeps after 15 minutes with no inbound HTTP or WebSocket messages. Its next request starts the service again and can take about a minute. This is fine for a demo, but the first judge to open a sleeping service may see a short cold start. A paid Render instance stays active.

## 4. Point the Desktop shortcut at the public service

After the first deploy, copy the primary HTTPS `onrender.com` URL into `data/public-url.txt` as a single line, for example:

```text
https://syncboard-public.onrender.com
```

The existing Desktop shortcut then opens the primary public server. Everyone visiting either endpoint shares the same Redis-backed board and live presence. Each endpoint has its own host; an invite from either endpoint carries the current board ID so collaborators join the same room. The URL file is ignored by Git.

