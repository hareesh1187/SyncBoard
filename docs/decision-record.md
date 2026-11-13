# Decision record: ordered operations over Redis Streams

**Date:** 2026-11-13  
**Status:** Implemented for the hackathon demo

## Decision

Represent each canvas change as an immutable operation. Redis Lua assigns an authoritative board Lamport value, appends the operation to a per-board Redis Stream, records its idempotency key, and publishes the event. Objects merge field by field with deterministic last-writer-wins registers. Snapshots compact old stream entries. Browsers persist an outbound operation queue in IndexedDB and replay it after reconnect.

## Why

The same ordered event is the source for live delivery, replay, and compaction. Redis serializes concurrent operations across app processes; operation IDs make retries safe. Field-level clocks preserve edits to unrelated properties, while the deterministic tie-break means clients that replay the same log reach the same board.

## Alternatives considered

- **Replace the whole board document on every edit:** simpler, but concurrent users overwrite each other's unrelated changes and every write transfers more data.
- **Operational transformation:** can preserve editing intent, but transforms and reorders concurrent operations and complicates stale offline edits.
- **CRDT for every field:** supports richer offline merging, but adds metadata and implementation complexity beyond this prototype's whiteboard objects.
- **Pub/Sub as the only event source:** low-latency, but a disconnected process cannot replay messages. The stream is durable history; Pub/Sub only wakes live clients.
- **PostgreSQL as an additional source of truth:** would add a dual-write and recovery problem. The demo uses Redis for both snapshots and edit history, so it avoids pretending two stores commit atomically.

## Trade-offs and limits

Same-field conflicts resolve by server acceptance order; they do not merge semantic intent. An offline edit stays on that browser until IndexedDB can replay it. A cleared/evicted browser store can still lose queued work. Redis durability depends on the provider configuration; a Redis data loss is not repaired from a second database. The current open-link app has no authentication or per-board access control. The 150 ms, 200-user, and one-second load targets require a live run and are not claimed as proven by this decision record.

