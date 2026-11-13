import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

const [firstEndpoint, secondEndpoint] = process.argv.slice(2);
if (!firstEndpoint || !secondEndpoint) {
  console.error('Usage: npm run stress:200 -- <instance-a-url> <instance-b-url>');
  process.exit(2);
}

const endpoints = [new URL(firstEndpoint).origin, new URL(secondEndpoint).origin];
if (endpoints[0] === endpoints[1]) throw new Error('Pass two different public SyncBoard endpoints.');
const boardId = 'stress-demo';
const clientCount = 200;
const clients = [];
const sendTimes = new Map();
const latencies = [];
const expectedIds = new Set();

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function activeCount(board) {
  const objects = board.snapshot?.objects || {};
  return Object.values(objects).filter((item) => !item._deleted && item.id !== 'board-meta').length;
}

function finalLoadZero(board) {
  const object = structuredClone(board.snapshot?.objects?.['load-0'] || {});
  const clocks = object._clocks || {};
  for (const operation of board.operations || []) {
    if (operation.entityId !== 'load-0') continue;
    const stamp = [Number(operation.lamport || 0), String(operation.actor || '')];
    for (const [field, value] of Object.entries(operation.fields || {})) {
      const old = clocks[field] || [0, ''];
      if (stamp[0] > Number(old[0]) || (stamp[0] === Number(old[0]) && stamp[1].localeCompare(String(old[1])) >= 0)) {
        object[field] = value; clocks[field] = stamp;
      }
    }
  }
  return { x: object.x, y: object.y, clocks: { x: clocks.x, y: clocks.y } };
}

function openClient(endpoint, index) {
  const clientId = `stress-client-${String(index).padStart(4, '0')}`;
  const socketUrl = new URL('/collab', endpoint);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.searchParams.set('board', boardId);
  const socket = new WebSocket(socketUrl);
  const client = { socket, clientId, seen: new Set(), instance: null };
  clients.push(client);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Client ${index + 1} did not join within 30 seconds.`)), 30_000);
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'join', boardId, clientId, name: `Demo ${index + 1}`, color: '#7891e8', cursor: '0-0'
    })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'welcome') {
        client.instance = message.server?.instance;
        client.heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
            type: 'presence', cursor: { x: index * 2, y: index * 2 }, activeObject: 'load-0'
          }));
        }, 2500);
        clearTimeout(timeout); resolve(client);
      } else if (message.type === 'operation' && expectedIds.has(message.id)) {
        client.seen.add(message.id);
        const started = sendTimes.get(message.id);
        if (started !== undefined && message.actor !== client.clientId) latencies.push(performance.now() - started);
      } else if (message.type === 'error' && message.code === 'storage_unavailable') {
        reject(new Error('The shared Redis store became unavailable during the run.'));
      }
    });
  });
}

async function main() {
  const health = await Promise.all(endpoints.map((endpoint) => getJson(`${endpoint}/api/health`)));
  if (health.some((item) => !item.ok || item.store !== 'redis')) throw new Error('Both endpoints must be healthy and Redis-backed.');

  let createResponse = await fetch(`${endpoints[0]}/api/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boardId, count: 5000 })
  });
  if (!createResponse.ok && createResponse.status !== 409) throw new Error(`Stress board generation returned HTTP ${createResponse.status}.`);
  const loadStarted = performance.now();
  const initialBoard = await getJson(`${endpoints[0]}/api/boards/${boardId}`);
  const apiBoardLoadMs = performance.now() - loadStarted;
  if (activeCount(initialBoard) !== 5000) throw new Error(`Expected 5,000 shapes; found ${activeCount(initialBoard)}.`);

  const joinBatchSize = 20;
  for (let start = 0; start < clientCount; start += joinBatchSize) {
    const batch = Array.from({ length: Math.min(joinBatchSize, clientCount - start) }, (_, offset) => start + offset);
    await Promise.all(batch.map((index) => openClient(endpoints[index % 2], index)));
    if (start + joinBatchSize < clientCount) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const instanceIds = [...new Set(clients.map((client) => client.instance))];
  if (instanceIds.length < 2) throw new Error('Connections did not reach two distinct app instances.');

  for (let index = 0; index < clients.length; index += 1) {
    const client = clients[index];
    const operationId = `stress-op-${String(index).padStart(4, '0')}-${randomUUID().replaceAll('-', '')}`;
    expectedIds.add(operationId);
    sendTimes.set(operationId, performance.now());
    client.socket.send(JSON.stringify({
      type: 'op', operation: {
        id: operationId, actor: client.clientId, lamport: 1,
        entityId: 'load-0', action: 'update', fields: { x: 700 + index, y: 900 + index }, createdAt: Date.now()
      }
    }));
  }

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !clients.every((client) => client.seen.size === clientCount)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const missingClients = clients.filter((client) => client.seen.size !== clientCount).length;
  if (missingClients) throw new Error(`${missingClients} clients did not receive every one of the 200 concurrent edits.`);

  const [boardA, boardB] = await Promise.all(endpoints.map((endpoint) => getJson(`${endpoint}/api/boards/${boardId}`)));
  const finalA = finalLoadZero(boardA); const finalB = finalLoadZero(boardB);
  const converged = boardA.latestId === boardB.latestId && JSON.stringify(finalA) === JSON.stringify(finalB);
  if (!converged) throw new Error('The two endpoints returned different final board states.');
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;

  console.log(JSON.stringify({
    boardId, connectedUsers: clients.length, activeObjects: activeCount(initialBoard),
    appInstanceIds: instanceIds, editsSent: expectedIds.size, editsSeenByEveryClient: true,
    stateConvergedAcrossEndpoints: converged, finalLoad0: finalA,
    sameProcessPeerReceiveP95Ms: Math.round(p95), apiBoardLoadMs: Math.round(apiBoardLoadMs)
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  for (const client of clients) { clearInterval(client.heartbeat); client.socket.terminate(); }
}
