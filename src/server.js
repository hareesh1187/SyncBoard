import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from 'redis';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const INSTANCE_ID = process.env.INSTANCE_ID || `local-${process.pid}`;
const REDIS_URL = process.env.REDIS_URL;
const PRESENCE_TTL = 5;
const RATE_LIMIT = 240;
const SNAPSHOT_INTERVAL = 800;
const DEFAULT_BOARD_TITLE = 'The next big thing';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};

const SEED_OBJECTS = [
  shape('seed-title', 'text', 140, 115, 650, 76, { text: 'The future of work, together.', fontSize: 54, color: '#192234', fontWeight: 700 }),
  shape('seed-subtitle', 'text', 145, 210, 600, 34, { text: 'A living canvas for ideas that move at the speed of thought.', fontSize: 19, color: '#778195' }),
  shape('seed-card-1', 'rect', 150, 355, 250, 178, { fill: '#e5edff', radius: 26, label: '01   DISCOVER', text: 'Make space\nfor the big idea', color: '#3655b4' }),
  shape('seed-card-2', 'rect', 438, 355, 250, 178, { fill: '#e9f8cd', radius: 26, label: '02   SHAPE', text: 'Turn sparks\ninto a direction', color: '#52731c' }),
  shape('seed-card-3', 'rect', 726, 355, 250, 178, { fill: '#f7e4d9', radius: 26, label: '03   SHARE', text: 'Build the next\nthing, together', color: '#a75a36' }),
  shape('seed-path', 'connector', 398, 444, 40, 0, { stroke: '#aab4c5', strokeWidth: 3 }),
  shape('seed-path-2', 'connector', 686, 444, 40, 0, { stroke: '#aab4c5', strokeWidth: 3 }),
  shape('seed-note', 'rect', 1050, 305, 210, 185, { fill: '#fff0b9', radius: 10, rotation: 4, text: 'A little chaos\nis where the\ngood stuff starts ✦', color: '#775b15', fontSize: 22 }),
  shape('seed-orb', 'ellipse', 1080, 580, 112, 112, { fill: '#d6c9ff', label: 'MAKE IT REAL', color: '#5b4297' }),
  shape('seed-caption', 'text', 145, 620, 580, 30, { text: 'WEDNESDAY WORKSHOP   /   09:41 AM', fontSize: 12, color: '#99a2b0', letterSpacing: 1.4 })
];

function shape(id, type, x, y, w, h, extra = {}) {
  const values = { id, type, x, y, w, h, rotation: 0, fill: '#d9def2', color: '#242b3d', stroke: '#7d88a0', strokeWidth: 2, fontSize: 20, radius: 16, ...extra };
  const clocks = Object.fromEntries(Object.keys(values).map((key) => [key, [0, 'seed']]));
  return { ...values, _clocks: clocks, _deleted: false };
}

function seedSnapshot() {
  const metadata = shape('board-meta', 'meta', 0, 0, 0, 0, { title: DEFAULT_BOARD_TITLE });
  return { version: 1, purpose: 'demo-seed', cursor: '0-0', objects: Object.fromEntries([metadata, ...SEED_OBJECTS].map((item) => [item.id, item])) };
}

function safeBoardId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
}

function boardTitle(snapshot, operations = []) {
  let title = snapshot?.objects?.['board-meta']?.title || DEFAULT_BOARD_TITLE;
  for (const operation of operations) {
    if (operation.entityId === 'board-meta' && typeof operation.fields?.title === 'string') title = operation.fields.title;
  }
  return title;
}

function stampCompare(a = [0, ''], b = [0, '']) {
  if (Number(a[0]) !== Number(b[0])) return Number(a[0]) - Number(b[0]);
  return String(a[1]).localeCompare(String(b[1]));
}

function streamCompare(a = '0-0', b = '0-0') {
  const [aTime = 0, aSeq = 0] = String(a).split('-').map(Number);
  const [bTime = 0, bSeq = 0] = String(b).split('-').map(Number);
  return aTime === bTime ? aSeq - bSeq : aTime - bTime;
}

function reduceOperation(objects, operation) {
  const id = operation.entityId;
  if (!id) return;
  const current = objects[id] || { id, _clocks: {}, _deleted: false };
  const next = { ...current, _clocks: { ...(current._clocks || {}) } };
  const stamp = [Number(operation.lamport || 1), String(operation.actor || '')];
  for (const [field, value] of Object.entries(operation.fields || {})) {
    if (field.startsWith('_') || field === 'id') continue;
    if (stampCompare(stamp, next._clocks[field]) >= 0) {
      next[field] = value;
      next._clocks[field] = stamp;
    }
  }
  if (operation.action === 'delete' && stampCompare(stamp, next._clocks._deleted) >= 0) {
    next._deleted = true;
    next._clocks._deleted = stamp;
  } else if (operation.action === 'restore' && stampCompare(stamp, next._clocks._deleted) >= 0) {
    next._deleted = false;
    next._clocks._deleted = stamp;
  }
  objects[id] = next;
}

class MemoryStore {
  constructor() {
    this.snapshots = new Map(); this.logs = new Map(); this.seen = new Set(); this.sequence = 0; this.clocks = new Map();
    this.presence = new Map(); this.listeners = new Set(); this.limits = new Map(); this.reconnections = 0; this.offlineMerges = 0;
    this.mode = 'memory';
  }
  async start() {}
  async persistOperation() {}
  async persistSnapshots() {}
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(message) { for (const listener of this.listeners) listener(message); }
  async board(boardId) {
    if (!this.snapshots.has(boardId)) this.snapshots.set(boardId, seedSnapshot());
    let snapshot = this.snapshots.get(boardId);
    const events = this.logs.get(boardId) || [];
    let operations = events.filter((event) => streamCompare(event.streamId, snapshot.cursor) > 0);
    if (operations.length >= SNAPSHOT_INTERVAL) {
      const objects = { ...snapshot.objects };
      for (const event of operations) reduceOperation(objects, event);
      snapshot = { version: 1, cursor: operations.at(-1).streamId, objects };
      this.snapshots.set(boardId, snapshot); await this.persistSnapshots();
      operations = events.filter((event) => streamCompare(event.streamId, snapshot.cursor) > 0);
    }
    return { snapshot, operations, latestId: events.at(-1)?.streamId || snapshot.cursor };
  }
  async operationsSince(boardId, cursor) { return (await this.board(boardId)).operations.filter((event) => streamCompare(event.streamId, cursor) > 0); }
  async append(boardId, operation) {
    const dedupKey = `${boardId}:${operation.id}`;
    if (this.seen.has(dedupKey)) return { duplicate: true };
    const rateKey = `${operation.actor}:${Math.floor(Date.now() / 1000)}`;
    const count = (this.limits.get(rateKey) || 0) + 1; this.limits.set(rateKey, count);
    if (count > RATE_LIMIT) return { error: 'rate_limited' };
    const streamId = `${Date.now()}-${++this.sequence}`;
    const lamport = Math.max(this.clocks.get(boardId) || 0, operation.lamport || 0) + 1;
    const event = { ...operation, boardId, lamport, streamId, serverAt: Date.now() };
    await this.persistOperation(event);
    this.clocks.set(boardId, lamport); this.seen.add(dedupKey);
    if (event.createdAt && event.serverAt - event.createdAt > 3000) this.offlineMerges += 1;
    const log = this.logs.get(boardId) || []; log.push(event); this.logs.set(boardId, log);
    this.emit({ type: 'operation', ...event });
    return { streamId };
  }
  async presenceSet(boardId, person) {
    const room = this.presence.get(boardId) || new Map();
    room.set(person.id, { ...person, expiresAt: Date.now() + PRESENCE_TTL * 1000 }); this.presence.set(boardId, room);
    this.emit({ type: 'presence', boardId, person });
  }
  async presenceDelete(boardId, id) {
    this.presence.get(boardId)?.delete(id); this.emit({ type: 'presence-left', boardId, id });
  }
  async presenceList(boardId) {
    const room = this.presence.get(boardId) || new Map();
    const now = Date.now();
    for (const [id, person] of room) if (person.expiresAt < now) room.delete(id);
    return [...room.values()].map(({ expiresAt, ...person }) => person);
  }
  async generateBoard(boardId, count) {
    const current = this.snapshots.get(boardId);
    const hasEdits = (this.logs.get(boardId) || []).length > 0;
    if (boardId !== 'stress-demo' || hasEdits || (current && current.purpose !== 'demo-seed')) return false;
    const objects = {};
    const palettes = ['#e4edff', '#edf8d7', '#f9e3d7', '#f2e6ff', '#fff0b6'];
    for (let i = 0; i < count; i += 1) {
      objects[`load-${i}`] = shape(`load-${i}`, i % 5 === 0 ? 'ellipse' : 'rect', (i % 100) * 180, Math.floor(i / 100) * 105, 70 + (i % 4) * 10, 42 + (i % 3) * 9, { rotation: (i % 5 - 2) * 2, fill: palettes[i % palettes.length], color: '#4b5670', stroke: '#aab5ca', strokeWidth: 1, text: '' });
    }
    objects['board-meta'] = shape('board-meta', 'meta', 0, 0, 0, 0, { title: '5,000 object stress board' });
    this.snapshots.set(boardId, { version: 1, purpose: 'stress-demo', cursor: '0-0', objects });
    this.logs.set(boardId, []);
    await this.persistSnapshots();
    return true;
  }
  async sync(boardId, cursor) {
    const data = await this.board(boardId);
    if (cursor && streamCompare(cursor, data.snapshot.cursor) >= 0) return { snapshot: null, operations: await this.operationsSince(boardId, cursor), latestId: data.latestId };
    return data;
  }
  async stats() {
    let users = 0; for (const room of this.presence.values()) users += (await this.presenceList([...this.presence].find(([, value]) => value === room)?.[0] || '')).length;
    let operations = 0; for (const log of this.logs.values()) operations += log.length;
    let snapshotBytes = 0; for (const snapshot of this.snapshots.values()) snapshotBytes += JSON.stringify(snapshot).length;
    return { users, operations, boards: this.snapshots.size, snapshotBytes, reconnections: this.reconnections, offlineMerges: this.offlineMerges };
  }
  async recordReconnect() { this.reconnections += 1; }
  async maintainSnapshots() {
    for (const boardId of this.logs.keys()) {
      const snapshot = this.snapshots.get(boardId) || seedSnapshot();
      const events = (this.logs.get(boardId) || []).filter((event) => streamCompare(event.streamId, snapshot.cursor) > 0);
      if (events.length < SNAPSHOT_INTERVAL) continue;
      const objects = { ...snapshot.objects }; for (const event of events) reduceOperation(objects, event);
      this.snapshots.set(boardId, { version: 1, cursor: events.at(-1).streamId, objects });
      await this.persistSnapshots();
    }
  }
}

class FileStore extends MemoryStore {
  constructor() {
    super(); this.mode = 'file'; this.dataDir = join(ROOT, 'data'); this.operationsPath = join(this.dataDir, 'operations.jsonl');
    this.snapshotsPath = join(this.dataDir, 'snapshots.json'); this.persistQueue = Promise.resolve();
  }
  async start() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const snapshots = JSON.parse(await readFile(this.snapshotsPath, 'utf8'));
      for (const [boardId, snapshot] of Object.entries(snapshots)) this.snapshots.set(boardId, snapshot);
    } catch (error) { if (error.code !== 'ENOENT') console.error('Could not load local snapshots', error.message); }
    try {
      const raw = await readFile(this.operationsPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const event = JSON.parse(line); if (!safeBoardId(event.boardId) || !event.id || !event.streamId) continue;
          const log = this.logs.get(event.boardId) || []; log.push(event); this.logs.set(event.boardId, log);
          this.seen.add(`${event.boardId}:${event.id}`);
          const [, sequence] = String(event.streamId).split('-').map(Number); this.sequence = Math.max(this.sequence, sequence || 0);
          this.clocks.set(event.boardId, Math.max(this.clocks.get(event.boardId) || 0, Number(event.lamport || 0)));
        } catch { /* Skip a partial final line and keep the remaining board history. */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') console.error('Could not load local edit history', error.message); }
  }
  async persistOperation(event) {
    const next = this.persistQueue.catch(() => {}).then(() => appendFile(this.operationsPath, `${JSON.stringify(event)}\n`, 'utf8'));
    this.persistQueue = next; return next;
  }
  async persistSnapshots() {
    const serialized = JSON.stringify(Object.fromEntries(this.snapshots));
    const next = this.persistQueue.catch(() => {}).then(() => writeFile(this.snapshotsPath, serialized, 'utf8'));
    this.persistQueue = next; return next;
  }
}

class RedisStore {
  constructor(url) { this.url = url; this.client = createClient({ url, disableOfflineQueue: true }); this.subscriber = this.client.duplicate(); this.listeners = new Set(); this.mode = 'redis'; }
  async start() {
    this.client.on('error', (error) => console.error(`[${INSTANCE_ID}] Redis`, error.message));
    this.subscriber.on('error', (error) => console.error(`[${INSTANCE_ID}] Redis subscriber`, error.message));
    await Promise.all([this.client.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe('syncboard:events', (raw) => {
      try { const message = JSON.parse(raw); for (const listener of this.listeners) listener(message); } catch (error) { console.error('Invalid Redis event', error.message); }
    });
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  key(boardId, suffix) { return `syncboard:${boardId}:${suffix}`; }
  assertReady() { if (!this.client.isReady) { const error = new Error('Redis is unavailable.'); error.code = 'storage_unavailable'; throw error; } }
  async ensureSnapshot(boardId) {
    this.assertReady();
    const key = this.key(boardId, 'snapshot');
    let raw = await this.client.get(key);
    if (!raw) {
      const candidate = JSON.stringify(seedSnapshot());
      await this.client.set(key, candidate, { NX: true });
      raw = await this.client.get(key);
    }
    return JSON.parse(raw);
  }
  async readEvents(boardId, cursor = '0-0') {
    const entries = await this.client.xRange(this.key(boardId, 'ops'), `(${cursor}`, '+', { COUNT: 50000 });
    return entries.map((entry) => ({ ...JSON.parse(entry.message.json), streamId: entry.id }));
  }
  async board(boardId) {
    const snapshot = await this.ensureSnapshot(boardId);
    const operations = await this.readEvents(boardId, snapshot.cursor || '0-0');
    if (operations.length >= SNAPSHOT_INTERVAL) {
      await this.compact(boardId, snapshot, operations);
      const freshSnapshot = await this.ensureSnapshot(boardId);
      const tail = await this.readEvents(boardId, freshSnapshot.cursor || '0-0');
      return { snapshot: freshSnapshot, operations: tail, latestId: tail.at(-1)?.streamId || freshSnapshot.cursor || '0-0' };
    }
    const latestId = operations.at(-1)?.streamId || snapshot.cursor || '0-0';
    return { snapshot, operations, latestId };
  }
  async compact(boardId, currentSnapshot, events) {
    const lock = this.key(boardId, 'compact-lock');
    const token = `${INSTANCE_ID}:${randomUUID()}`;
    const acquired = await this.client.set(lock, token, { NX: true, EX: 30 });
    if (!acquired) return;
    try {
      // Always refresh after acquiring the lock. Callers may have read an older
      // snapshot before another instance compacted and trimmed the stream.
      currentSnapshot = await this.ensureSnapshot(boardId);
      events = await this.readEvents(boardId, currentSnapshot.cursor || '0-0');
      const objects = { ...currentSnapshot.objects };
      for (const event of events) reduceOperation(objects, event);
      const last = events.at(-1);
      if (!last) return;
      const snapshot = { version: 1, cursor: last.streamId, objects };
      await this.client.set(this.key(boardId, 'snapshot'), JSON.stringify(snapshot));
      await this.client.xTrim(this.key(boardId, 'ops'), 'MINID', `${last.streamId.split('-')[0]}-${Number(last.streamId.split('-')[1]) + 1}`);
    } finally {
      await this.client.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", { keys: [lock], arguments: [token] }).catch(() => {});
    }
  }
  async sync(boardId, cursor) {
    const snapshot = await this.ensureSnapshot(boardId);
    if (cursor && streamCompare(cursor, snapshot.cursor || '0-0') >= 0) {
      const operations = await this.readEvents(boardId, cursor);
      return { snapshot: null, operations, latestId: operations.at(-1)?.streamId || cursor };
    }
    const operations = await this.readEvents(boardId, snapshot.cursor || '0-0');
    return { snapshot, operations, latestId: operations.at(-1)?.streamId || snapshot.cursor };
  }
  async append(boardId, operation) {
    this.assertReady();
    const stream = this.key(boardId, 'ops');
    const dedupPrefix = this.key(boardId, 'dedup:');
    const rateKey = this.key(boardId, `rate:${operation.actor}:${Math.floor(Date.now() / 1000)}`);
    const clockKey = this.key(boardId, 'clock');
    const script = `
      local old = redis.call('GET', KEYS[2] .. ARGV[1])
      if old then return { old, 'duplicate' } end
      local count = redis.call('INCR', KEYS[3])
      if count == 1 then redis.call('EXPIRE', KEYS[3], 2) end
      if count > tonumber(ARGV[3]) then return { 'rate_limited', 'limit' } end
      local event = cjson.decode(ARGV[2])
      local previous = tonumber(redis.call('GET', KEYS[5]) or '0')
      local suggested = tonumber(event.lamport or 0)
      local lamport = math.max(previous, suggested) + 1
      redis.call('SET', KEYS[5], tostring(lamport))
      event.lamport = lamport
      local id = redis.call('XADD', KEYS[1], '*', 'json', cjson.encode(event))
      event.type = 'operation'
      event.streamId = id
      event.serverAt = tonumber(ARGV[4])
      local packed = cjson.encode(event)
      redis.call('SET', KEYS[2] .. ARGV[1], id, 'EX', 604800)
      if tonumber(event.createdAt or 0) > 0 and tonumber(ARGV[4]) - tonumber(event.createdAt) > 3000 then redis.call('INCR', KEYS[6]) end
      redis.call('PUBLISH', KEYS[4], packed)
      return { id, 'ok' }
    `;
    const result = await this.client.eval(script, {
      keys: [stream, dedupPrefix, rateKey, 'syncboard:events', clockKey, 'syncboard:metrics:offline-merges'],
      arguments: [operation.id, JSON.stringify({ ...operation, boardId }), String(RATE_LIMIT), String(Date.now())]
    });
    if (result[1] === 'limit') return { error: 'rate_limited' };
    return { streamId: result[0], duplicate: result[1] === 'duplicate' };
  }
  async presenceSet(boardId, person) {
    this.assertReady();
    const key = this.key(boardId, `presence:${person.id}`);
    const index = this.key(boardId, 'presence-index');
    await this.client.multi()
      .set(key, JSON.stringify({ ...person, instanceId: INSTANCE_ID }), { EX: PRESENCE_TTL })
      .sAdd(index, person.id)
      .exec();
    await this.client.publish('syncboard:events', JSON.stringify({ type: 'presence', boardId, person: { ...person, instanceId: INSTANCE_ID } }));
  }
  async presenceDelete(boardId, id) {
    this.assertReady();
    await this.client.multi()
      .del(this.key(boardId, `presence:${id}`))
      .sRem(this.key(boardId, 'presence-index'), id)
      .exec();
    await this.client.publish('syncboard:events', JSON.stringify({ type: 'presence-left', boardId, id }));
  }
  async presenceList(boardId) {
    this.assertReady();
    const index = this.key(boardId, 'presence-index');
    const prefix = this.key(boardId, 'presence:');
    let ids = await this.client.sMembers(index);
    // Migrate live presence written by an older server before the index existed.
    if (!ids.length) {
      for await (const key of this.client.scanIterator({ MATCH: this.key(boardId, 'presence:*'), COUNT: 100 })) ids.push(key.slice(prefix.length));
      if (ids.length) await this.client.sAdd(index, ids);
    }
    if (!ids.length) return [];
    const keys = ids.map((id) => this.key(boardId, `presence:${id}`));
    const values = await this.client.mGet(keys);
    const present = []; const stale = [];
    for (let index = 0; index < values.length; index += 1) {
      if (values[index]) present.push(JSON.parse(values[index])); else stale.push(ids[index]);
    }
    if (stale.length) await this.client.sRem(index, stale);
    return present;
  }
  async generateBoard(boardId, count) {
    this.assertReady();
    if (boardId !== 'stress-demo') return false;
    const objects = {};
    const palettes = ['#e4edff', '#edf8d7', '#f9e3d7', '#f2e6ff', '#fff0b6'];
    for (let i = 0; i < count; i += 1) {
      const id = `load-${i}`;
      objects[id] = shape(id, i % 5 === 0 ? 'ellipse' : 'rect', (i % 100) * 180, Math.floor(i / 100) * 105, 70 + (i % 4) * 10, 42 + (i % 3) * 9, { rotation: (i % 5 - 2) * 2, fill: palettes[i % palettes.length], color: '#4b5670', stroke: '#aab5ca', strokeWidth: 1, text: '' });
    }
    objects['board-meta'] = shape('board-meta', 'meta', 0, 0, 0, 0, { title: '5,000 object stress board' });
    const result = await this.client.eval(`
      local raw = redis.call('GET', KEYS[1])
      if raw then
        local current = cjson.decode(raw)
        if current.purpose ~= 'demo-seed' or redis.call('XLEN', KEYS[2]) > 0 then return 0 end
      elseif redis.call('XLEN', KEYS[2]) > 0 then
        return 0
      end
      redis.call('SET', KEYS[1], ARGV[1])
      return 1
    `, {
      keys: [this.key(boardId, 'snapshot'), this.key(boardId, 'ops')],
      arguments: [JSON.stringify({ version: 1, purpose: 'stress-demo', cursor: '0-0', objects })]
    });
    return Number(result) === 1;
  }
  async stats() {
    this.assertReady();
    let users = 0; let operations = 0; let snapshotBytes = 0;
    const streams = []; const snapshots = [];
    for await (const key of this.client.scanIterator({ MATCH: 'syncboard:*:ops', COUNT: 100 })) streams.push(key);
    if (streams.length) { const lengths = await Promise.all(streams.map((key) => this.client.xLen(key))); operations = lengths.reduce((sum, value) => sum + value, 0); }
    for await (const key of this.client.scanIterator({ MATCH: 'syncboard:*:snapshot', COUNT: 100 })) snapshots.push(key);
    if (snapshots.length) { const sizes = await Promise.all(snapshots.map((key) => this.client.strLen(key))); snapshotBytes = sizes.reduce((sum, value) => sum + value, 0); }
    for await (const key of this.client.scanIterator({ MATCH: 'syncboard:*:presence:*', COUNT: 100 })) { if (await this.client.exists(key)) users += 1; }
    const [reconnections, offlineMerges] = await Promise.all([this.client.get('syncboard:metrics:reconnections'), this.client.get('syncboard:metrics:offline-merges')]);
    return { users, operations, boards: snapshots.length, snapshotBytes, reconnections: Number(reconnections || 0), offlineMerges: Number(offlineMerges || 0) };
  }
  async recordReconnect() { await this.client.incr('syncboard:metrics:reconnections'); }
  async maintainSnapshots() {
    const streams = [];
    for await (const key of this.client.scanIterator({ MATCH: 'syncboard:*:ops', COUNT: 100 })) {
      streams.push(key); if (streams.length >= 16) break;
    }
    for (const key of streams) {
      const match = key.match(/^syncboard:([a-zA-Z0-9_-]+):ops$/);
      if (!match) continue;
      const boardId = match[1]; const snapshot = await this.ensureSnapshot(boardId);
      const events = await this.readEvents(boardId, snapshot.cursor || '0-0');
      if (events.length >= SNAPSHOT_INTERVAL) await this.compact(boardId, snapshot, events);
    }
  }
}

const store = REDIS_URL ? new RedisStore(REDIS_URL) : new FileStore();
await store.start();
const metrics = { received: 0, relayLatencies: [], connected: 0 };
const metricsCache = { expiresAt: 0, value: null };
const simulateRequests = new Map();
const rooms = new Map();
const app = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') {
    const ok = store.mode !== 'redis' || (store.client.isReady && store.subscriber.isReady);
    return json(response, ok ? 200 : 503, { ok, instance: INSTANCE_ID, store: store.mode, at: Date.now() });
  }
  if (url.pathname === '/api/metrics') {
    try {
      if (!metricsCache.value || Date.now() >= metricsCache.expiresAt) {
        metricsCache.value = await store.stats();
        metricsCache.expiresAt = Date.now() + 10_000;
      }
      const sorted = [...metrics.relayLatencies].sort((a, b) => a - b);
      return json(response, 200, { ...metricsCache.value, instance: INSTANCE_ID, relayP95: sorted[Math.floor(sorted.length * 0.95)] || 0, opsPerSecond: metrics.received, store: store.mode });
    } catch (error) { return json(response, 503, { error: 'Metrics storage is unavailable.' }); }
  }
  const boardMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);
  if (boardMatch && request.method === 'GET') {
    const boardId = safeBoardId(boardMatch[1]);
    if (!boardId) return json(response, 400, { error: 'Invalid board id.' });
    try {
      const board = await store.board(boardId);
      return compressedJson(response, 200, { ...board, title: boardTitle(board.snapshot, board.operations) }, request);
    }
    catch (error) { console.error('Board read failed', error); return json(response, 503, { error: 'Board storage is unavailable.' }); }
  }
  if (url.pathname === '/api/simulate' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const boardId = safeBoardId(body.boardId);
      if (boardId !== 'stress-demo') return json(response, 400, { error: 'The shared 5,000 object canvas uses the stress-demo room.' });
      if (Number(body.count) !== 5000) return json(response, 400, { error: 'The stress board must contain exactly 5,000 objects.' });
      const requester = request.socket.remoteAddress || 'unknown';
      const lastRequest = simulateRequests.get(requester) || 0;
      if (Date.now() - lastRequest < 10_000) return json(response, 429, { error: 'Wait a few seconds before creating another stress board.' });
      simulateRequests.set(requester, Date.now());
      const createdAt = Date.now();
      const created = await store.generateBoard(boardId, 5000);
      if (!created) return json(response, 409, { error: 'The shared 5,000 object stress room already exists.' });
      return json(response, 200, { ok: true, count: 5000, elapsedMs: Date.now() - createdAt });
    } catch (error) { console.error('Simulator failed', error); return json(response, 500, { error: 'Could not generate the board.' }); }
  }
  return serveStatic(url.pathname, response, request);
});

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  response.end(JSON.stringify(value));
}

function compressedJson(response, status, value, request) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 4096 || !/\bgzip\b/i.test(request.headers['accept-encoding'] || '')) return json(response, status, value);
  const compressed = gzipSync(body, { level: 1 });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-encoding': 'gzip', 'content-length': compressed.length, vary: 'accept-encoding',
    'access-control-allow-origin': '*'
  });
  response.end(compressed);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = ''; request.on('data', (chunk) => { raw += chunk; if (raw.length > 2_000_000) reject(new Error('Request body too large')); });
    request.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (error) { reject(error); } });
    request.on('error', reject);
  });
}

async function serveStatic(pathname, response, request) {
  let path;
  try { path = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).replace(/^[/\\]+/, ''); }
  catch { response.writeHead(400); return response.end('Bad request'); }
  const root = resolve(PUBLIC); const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) { response.writeHead(403); return response.end('Forbidden'); }
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(absolute);
    const contentType = MIME[extname(absolute)] || 'application/octet-stream';
    if (body.length >= 4096 && /\bgzip\b/i.test(request.headers['accept-encoding'] || '')) {
      const compressed = gzipSync(body, { level: 1 });
      response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache', 'content-encoding': 'gzip', 'content-length': compressed.length, vary: 'accept-encoding' });
      response.end(compressed);
    } else {
      response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
      response.end(body);
    }
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found');
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
app.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/collab') { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request, url));
});

function send(client, payload) {
  if (client.websocket.readyState === WebSocket.OPEN) client.websocket.send(JSON.stringify(payload));
}

function roomAdd(boardId, client) {
  const room = rooms.get(boardId) || new Set(); room.add(client); rooms.set(boardId, room);
}

function roomRemove(boardId, client) {
  const room = rooms.get(boardId); if (!room) return;
  room.delete(client); if (room.size === 0) rooms.delete(boardId);
}

store.subscribe((message) => {
  if (message.type === 'operation') {
    metrics.received += 1;
    if (message.serverAt) {
      metrics.relayLatencies.push(Math.max(0, Date.now() - Number(message.serverAt)));
      if (metrics.relayLatencies.length > 500) metrics.relayLatencies.shift();
    }
  }
  const room = rooms.get(message.boardId);
  if (!room) return;
  for (const client of room) {
    if (message.type === 'operation' && client.replaying) { client.buffer.push(message); continue; }
    send(client, message);
  }
});

wss.on('connection', (websocket, request, url) => {
  const boardId = safeBoardId(url.searchParams.get('board') || 'studio');
  if (!boardId) { websocket.close(1008, 'Invalid board'); return; }
  const client = { websocket, boardId, joined: false, replaying: false, buffer: [], clientId: null, name: 'Explorer', color: '#89a5ff', lastPresence: 0 };
  metrics.connected += 1;
  websocket.on('message', async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { send(client, { type: 'error', message: 'Invalid message format.' }); return; }
    try {
      if (message.type === 'join' && !client.joined) {
        client.clientId = typeof message.clientId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(message.clientId) ? message.clientId : randomUUID();
        client.name = String(message.name || 'Explorer').slice(0, 24);
        client.color = /^#[0-9a-fA-F]{6}$/.test(message.color) ? message.color : '#89a5ff';
        client.joined = true; client.replaying = true; roomAdd(boardId, client);
        if (message.reconnect) await store.recordReconnect();
        const person = { id: client.clientId, name: client.name, color: client.color, boardId, instanceId: INSTANCE_ID, cursor: null, activeObject: null, lastSeen: Date.now() };
        await store.presenceSet(boardId, person);
        const [presence, sync] = await Promise.all([store.presenceList(boardId), store.sync(boardId, String(message.cursor || ''))]);
        client.lastPresence = Date.now();
        send(client, { type: 'welcome', me: person, presence, sync, title: boardTitle(sync.snapshot, sync.operations), server: { instance: INSTANCE_ID, store: store.mode } });
        client.replaying = false;
        const buffered = client.buffer.splice(0).sort((a, b) => String(a.streamId).localeCompare(String(b.streamId)));
        const seen = new Set((sync.operations || []).map((operation) => operation.id));
        for (const event of buffered) if (!seen.has(event.id)) send(client, event);
        return;
      }
      if (!client.joined) return;
      if (message.type === 'op') {
        const operation = validateOperation(message.operation, client.clientId);
        if (!operation) { send(client, { type: 'error', message: 'This edit could not be accepted.' }); return; }
        const result = await store.append(boardId, operation);
        if (result.error) send(client, { type: 'error', code: result.error, operationId: operation.id, message: 'You are editing very quickly. Wait a moment and try again.' });
        else if (result.duplicate) send(client, { type: 'ack', operationId: operation.id, streamId: result.streamId });
        return;
      }
      if (message.type === 'presence') {
        const now = Date.now();
        if (now - client.lastPresence < 90) return;
        client.lastPresence = now;
        const person = { id: client.clientId, name: client.name, color: client.color, boardId, instanceId: INSTANCE_ID, cursor: validPoint(message.cursor), activeObject: typeof message.activeObject === 'string' ? message.activeObject.slice(0, 100) : null, lastSeen: Date.now() };
        await store.presenceSet(boardId, person);
        return;
      }
      if (message.type === 'leave') await store.presenceDelete(boardId, client.clientId);
    } catch (error) {
      console.error('WebSocket message failed', error.message);
      const storageUnavailable = error.code === 'storage_unavailable' || (store.mode === 'redis' && !store.client.isReady);
      const operationId = message.type === 'op' ? message.operation?.id : undefined;
      send(client, {
        type: 'error', code: storageUnavailable ? 'storage_unavailable' : 'server_error', operationId,
        message: storageUnavailable ? 'The shared store is reconnecting. Your edits are still queued on this device.' : 'The board service is reconnecting.'
      });
      if (storageUnavailable && websocket.readyState === WebSocket.OPEN) websocket.close(1013, 'Shared store unavailable');
    }
  });
  websocket.on('close', () => {
    metrics.connected = Math.max(0, metrics.connected - 1);
    roomRemove(boardId, client);
    if (client.joined) store.presenceDelete(boardId, client.clientId).catch(() => {});
  });
  websocket.on('error', () => {});
});

function validPoint(point) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
  return { x: Math.max(-1e7, Math.min(1e7, Number(point.x))), y: Math.max(-1e7, Math.min(1e7, Number(point.y))) };
}

function validateOperation(value, actor) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id.length > 100 || !/^[a-zA-Z0-9:_-]+$/.test(value.id)) return null;
  if (typeof value.entityId !== 'string' || value.entityId.length > 100 || !/^[a-zA-Z0-9:_-]+$/.test(value.entityId)) return null;
  if (!['upsert', 'update', 'delete', 'restore'].includes(value.action)) return null;
  const allowed = new Set(['type', 'x', 'y', 'w', 'h', 'rotation', 'fill', 'color', 'stroke', 'strokeWidth', 'fontSize', 'fontWeight', 'fontFamily', 'text', 'title', 'radius', 'label', 'points', 'arrow', 'opacity']);
  const fields = {};
  for (const [key, fieldValue] of Object.entries(value.fields || {}).slice(0, 32)) {
    if (!allowed.has(key)) continue;
    if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) fields[key] = Math.max(-1e7, Math.min(1e7, fieldValue));
    else if (typeof fieldValue === 'string') fields[key] = fieldValue.slice(0, key === 'points' ? 24000 : 1000);
    else if (typeof fieldValue === 'boolean' || fieldValue === null) fields[key] = fieldValue;
  }
  if (value.action !== 'delete' && value.action !== 'restore' && !Object.keys(fields).length) return null;
  return { id: value.id, actor, lamport: Math.max(1, Math.min(1e12, Number(value.lamport || 1))), entityId: value.entityId, action: value.action, fields, createdAt: Number(value.createdAt) || Date.now() };
}

setInterval(() => { metrics.received = 0; }, 1000).unref();
setInterval(() => { store.maintainSnapshots?.().catch((error) => console.error('Snapshot maintenance failed', error.message)); }, 15000).unref();
app.listen(PORT, '0.0.0.0', () => console.log(`SyncBoard ${INSTANCE_ID} listening on :${PORT} (${store.mode})`));
