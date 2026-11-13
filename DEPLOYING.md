# Public SyncBoard deployment

This deploys one public SyncBoard service and a hosted Redis database. Anyone who opens the same board link joins the shared `studio` board, including from a phone. The Redis URL is a private service credential; never commit it.

## 1. Publish the source repository

Push this project to a GitHub repository that Render can access. To make the source itself open to everyone, set the repository visibility to **Public**. Keep `REDIS_URL`, tokens, and other credentials out of Git.

## 2. Create hosted Redis

Create a Redis database in Upstash, preferably in Singapore to stay close to the Render service. Copy its TLS connection URL (`rediss://...`). The Upstash free tier currently lists 256 MB and 500,000 commands per month, which is suitable for a small judging demo. Review the current limits before sharing the app broadly.

## 3. Deploy the Render Blueprint

In Render, create a Blueprint from the GitHub repository and select the included `render.yaml`. The Blueprint creates one Docker web service in Singapore and prompts for the secret `REDIS_URL`. Paste the Upstash TLS URL there. The service serves both the UI and WebSocket endpoint from the same HTTPS origin; `healthCheckPath` is `/api/health`.

Render's free web service sleeps after 15 minutes with no inbound HTTP or WebSocket messages. Its next request starts the service again and can take about a minute. This is fine for a demo, but the first judge to open a sleeping service may see a short cold start. A paid Render instance stays active.

## 4. Point the Desktop shortcut at the public service

After the first deploy, copy its HTTPS `onrender.com` URL into `data/public-url.txt` as a single line, for example:

```text
https://syncboard-public.onrender.com
```

The existing Desktop shortcut then opens that public server. Everyone visiting the URL shares the same Redis-backed board and live presence. The URL file is ignored by Git.
