const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const svgIcon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const palette = ['#e5edff', '#e8f5d5', '#f7e4d9', '#f0e7ff', '#fff0b9', '#d9f1ed'];
const actorColors = ['#91a7f7', '#f2a18c', '#d1a3ee', '#82bb9c', '#e5ae62', '#88b8d5'];

function safeRead(key, fallback = '') { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function safeWrite(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage can be disabled by the browser. */ } }
function makeId(prefix = 'op') { return `${prefix}-${crypto.randomUUID().replaceAll('-', '')}`; }
function compareStamp(a = [0, ''], b = [0, '']) { return Number(a[0]) === Number(b[0]) ? String(a[1]).localeCompare(String(b[1])) : Number(a[0]) - Number(b[0]); }
function compareStream(a = '0-0', b = '0-0') {
  const [at = 0, as = 0] = String(a).split('-').map(Number);
  const [bt = 0, bs = 0] = String(b).split('-').map(Number);
  return at === bt ? as - bs : at - bt;
}
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

const query = new URLSearchParams(location.search);
let boardId = query.get('board') || 'studio';
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(boardId)) boardId = 'studio';
const storedClientId = crypto.randomUUID();
const savedName = safeRead('syncboard:name', '').trim();
const nameWasCustomized = safeRead('syncboard:name-customized', '') === '1';
const needsUniqueName = !savedName || (!nameWasCustomized && ['Jamie', 'Explorer'].includes(savedName));
let displayName = (needsUniqueName ? `Guest ${crypto.randomUUID().slice(0, 5).toUpperCase()}` : savedName).slice(0, 24);
if (needsUniqueName) safeWrite('syncboard:name', displayName);
let actorColor = safeRead('syncboard:color', actorColors[Math.floor(Math.random() * actorColors.length)]);
if (!/^#[0-9a-fA-F]{6}$/.test(actorColor)) actorColor = actorColors[0];
safeWrite('syncboard:color', actorColor);

const state = {
  boardId, clientId: storedClientId, name: displayName, color: actorColor,
  objects: new Map(), selected: new Set(), users: new Map(), cursors: new Map(), cursorNodes: new Map(), effects: new Map(),
  tool: 'select', zoom: 1, panX: 0, panY: 0, spaceDown: false, shiftDown: false,
  drag: null, marquee: null, snapGuides: [], pending: new Map(), history: [], redo: [],
  lamport: 0, lastStreamId: safeRead(`syncboard:cursor:${boardId}`, '0-0'),
  socket: null, joined: false, everConnected: false, loading: true, canEdit: true, pointerWorld: null,
  lastPresenceAt: 0, drawQueued: false, resizeObserver: null, db: null, reconnectAttempt: 0, reconnectTimer: 0,
  liveObjectCount: 0, objectOrder: new Map(), nextObjectOrder: 0, worldBounds: null,
  activity: [], metrics: { p95: 28, ops: 0, users: 1 }, toastTimer: 0,
  title: boardId.startsWith('stress-') ? 'A lot of little ideas' : 'The next big thing'
};

const canvas = $('#boardCanvas');
const ctx = canvas.getContext('2d', { alpha: true });
const stage = $('#canvasStage');
const cursorLayer = $('#cursorLayer');
const syncPill = $('#syncPill');
const syncLabel = $('#syncLabel');
const canvasRect = () => canvas.getBoundingClientRect();

let spotlightFrame = 0;
stage.addEventListener('pointermove', (event) => {
  if (spotlightFrame) return;
  const clientX = event.clientX;
  const clientY = event.clientY;
  spotlightFrame = requestAnimationFrame(() => {
    spotlightFrame = 0;
    const bounds = stage.getBoundingClientRect();
    stage.style.setProperty('--pointer-x', `${((clientX - bounds.left) / bounds.width * 100).toFixed(1)}%`);
    stage.style.setProperty('--pointer-y', `${((clientY - bounds.top) / bounds.height * 100).toFixed(1)}%`);
  });
}, { passive: true });
stage.addEventListener('pointerleave', () => {
  stage.style.setProperty('--pointer-x', '50%');
  stage.style.setProperty('--pointer-y', '50%');
}, { passive: true });

$('#boardTitle').value = state.title;
$('.location-active').textContent = state.boardId.startsWith('stress-') ? '5,000 object stress board' : `Shared room · ${state.boardId}`;
document.title = `${state.title} — SyncBoard`;

function requestDraw() {
  if (state.drawQueued) return;
  state.drawQueued = true;
  requestAnimationFrame(() => { state.drawQueued = false; drawCanvas(); });
}

function resizeCanvas() {
  const rect = stage.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  requestDraw();
}

function activeObjects() { return [...state.objects.values()].filter((item) => !item._deleted && item.id !== 'board-meta'); }
function objectBounds(item) {
  const x1 = Math.min(Number(item.x || 0), Number(item.x || 0) + Number(item.w || 0));
  const y1 = Math.min(Number(item.y || 0), Number(item.y || 0) + Number(item.h || 0));
  const x2 = Math.max(Number(item.x || 0), Number(item.x || 0) + Number(item.w || 0));
  const y2 = Math.max(Number(item.y || 0), Number(item.y || 0) + Number(item.h || 0));
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

const SPATIAL_CELL_SIZE = 512;
const MAX_OBJECT_CELLS = 256;
const spatialGrid = new Map();
const objectCells = new Map();
const largeSpatialObjects = new Set();

function removeSpatialIndex(id) {
  if (!objectCells.has(id)) return;
  const keys = objectCells.get(id);
  if (keys === null) largeSpatialObjects.delete(id);
  else for (const key of keys) {
    const bucket = spatialGrid.get(key);
    bucket?.delete(id);
    if (bucket?.size === 0) spatialGrid.delete(key);
  }
  objectCells.delete(id);
}

function indexSpatialObject(item) {
  removeSpatialIndex(item.id);
  if (!item || item._deleted || item.id === 'board-meta') return;
  const bounds = objectBounds(item);
  const extent = state.worldBounds;
  state.worldBounds = extent ? {
    x: Math.min(extent.x, bounds.x), y: Math.min(extent.y, bounds.y),
    w: Math.max(extent.x + extent.w, bounds.x + bounds.w) - Math.min(extent.x, bounds.x),
    h: Math.max(extent.y + extent.h, bounds.y + bounds.h) - Math.min(extent.y, bounds.y)
  } : { ...bounds };
  const left = Math.floor(bounds.x / SPATIAL_CELL_SIZE); const top = Math.floor(bounds.y / SPATIAL_CELL_SIZE);
  const right = Math.floor((bounds.x + bounds.w) / SPATIAL_CELL_SIZE); const bottom = Math.floor((bounds.y + bounds.h) / SPATIAL_CELL_SIZE);
  const cellCount = (right - left + 1) * (bottom - top + 1);
  if (cellCount > MAX_OBJECT_CELLS) { largeSpatialObjects.add(item.id); objectCells.set(item.id, null); return; }
  const keys = [];
  for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) {
    const key = `${x},${y}`; keys.push(key);
    const bucket = spatialGrid.get(key) || new Set(); bucket.add(item.id); spatialGrid.set(key, bucket);
  }
  objectCells.set(item.id, keys);
}

function rebuildSpatialIndex() {
  spatialGrid.clear(); objectCells.clear(); largeSpatialObjects.clear(); state.objectOrder.clear();
  state.liveObjectCount = 0; state.nextObjectOrder = 0; state.worldBounds = null;
  for (const item of state.objects.values()) {
    state.objectOrder.set(item.id, state.nextObjectOrder++);
    if (!item._deleted && item.id !== 'board-meta') state.liveObjectCount += 1;
    indexSpatialObject(item);
  }
}

function querySpatialObjects(area) {
  const left = Math.floor(area.x / SPATIAL_CELL_SIZE); const top = Math.floor(area.y / SPATIAL_CELL_SIZE);
  const right = Math.floor((area.x + area.w) / SPATIAL_CELL_SIZE); const bottom = Math.floor((area.y + area.h) / SPATIAL_CELL_SIZE);
  if ((right - left + 1) * (bottom - top + 1) > 4096) {
    return activeObjects().filter((item) => {
      const bounds = objectBounds(item);
      return bounds.x + bounds.w >= area.x && bounds.y + bounds.h >= area.y && bounds.x <= area.x + area.w && bounds.y <= area.y + area.h;
    });
  }
  const ids = new Set(largeSpatialObjects);
  for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) {
    for (const id of spatialGrid.get(`${x},${y}`) || []) ids.add(id);
  }
  return [...ids].map((id) => state.objects.get(id)).filter((item) => {
    if (!item || item._deleted) return false;
    const bounds = objectBounds(item);
    return bounds.x + bounds.w >= area.x && bounds.y + bounds.h >= area.y && bounds.x <= area.x + area.w && bounds.y <= area.y + area.h;
  }).sort((a, b) => (state.objectOrder.get(a.id) || 0) - (state.objectOrder.get(b.id) || 0));
}

function drawCanvas() {
  if (!ctx) return;
  const width = canvas.width; const height = canvas.height; const ratio = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
  ctx.setTransform(ratio * state.zoom, 0, 0, ratio * state.zoom, ratio * state.panX, ratio * state.panY);
  const view = { x: -state.panX / state.zoom - 300, y: -state.panY / state.zoom - 300, w: width / ratio / state.zoom + 600, h: height / ratio / state.zoom + 600 };
  for (const item of querySpatialObjects(view)) drawObject(item);
  drawSelection();
  drawCreationPreview();
  drawMarquee();
  drawGuides();
  drawCreationEffects();
  const now = Date.now();
  for (const [id, startedAt] of state.effects) if (now - startedAt > 560 || !state.objects.has(id)) state.effects.delete(id);
  if (state.effects.size) requestDraw();
  updateMiniMap();
}

function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r); ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r); ctx.closePath();
}

function drawObject(item) {
  const x = Number(item.x || 0); const y = Number(item.y || 0);
  const width = Number(item.w || 0); const height = Number(item.h || 0);
  const rotation = Number(item.rotation || 0) * Math.PI / 180;
  if (item.type === 'connector') {
    ctx.save(); ctx.globalAlpha = clamp(Number(item.opacity ?? 1), .12, 1);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + width, y + height);
    ctx.strokeStyle = item.stroke || '#95a0b1'; ctx.lineWidth = Number(item.strokeWidth || 2); ctx.lineCap = 'round'; ctx.stroke();
    if (item.arrow) {
      const angle = Math.atan2(height, width); const size = 9;
      ctx.beginPath(); ctx.moveTo(x + width, y + height);
      ctx.lineTo(x + width - size * Math.cos(angle - Math.PI / 6), y + height - size * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x + width - size * Math.cos(angle + Math.PI / 6), y + height - size * Math.sin(angle + Math.PI / 6));
      ctx.closePath(); ctx.fillStyle = item.stroke || '#95a0b1'; ctx.fill();
    }
    ctx.restore(); return;
  }
  ctx.save(); ctx.translate(x + width / 2, y + height / 2); ctx.rotate(rotation); ctx.translate(-width / 2, -height / 2);
  let effectProgress = 1;
  const effectStartedAt = state.effects.get(item.id);
  if (effectStartedAt) {
    effectProgress = clamp((Date.now() - effectStartedAt) / 420, 0, 1);
    const eased = 1 - Math.pow(1 - effectProgress, 3);
    ctx.translate(width / 2, height / 2); ctx.scale(.76 + .24 * eased, .76 + .24 * eased); ctx.translate(-width / 2, -height / 2);
  }
  ctx.globalAlpha = clamp(Number(item.opacity ?? 1), .12, 1) * effectProgress;
  const selected = state.selected.has(item.id);
  if (selected) { ctx.shadowColor = 'rgba(56,77,129,.15)'; ctx.shadowBlur = 12 / state.zoom; ctx.shadowOffsetY = 3 / state.zoom; }
  const fill = typeof item.fill === 'string' ? item.fill : '#e4edff';
  const stroke = typeof item.stroke === 'string' ? item.stroke : '#aab5ca';
  const type = item.type || 'rect';

  if (type === 'connector') {
    ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2);
    ctx.strokeStyle = stroke; ctx.lineWidth = Number(item.strokeWidth || 2); ctx.lineCap = 'round'; ctx.stroke();
    ctx.shadowColor = 'transparent';
    if (item.arrow) { ctx.beginPath(); ctx.moveTo(width, height / 2); ctx.lineTo(width - 9, height / 2 - 5); ctx.lineTo(width - 9, height / 2 + 5); ctx.closePath(); ctx.fillStyle = stroke; ctx.fill(); }
  } else if (type === 'draw') {
    let points = [];
    try { points = Array.isArray(item.points) ? item.points : JSON.parse(item.points || '[]'); } catch { points = []; }
    if (points.length > 1) {
      ctx.beginPath(); ctx.moveTo(points[0].x - x, points[0].y - y);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x - x, points[i].y - y);
      ctx.strokeStyle = item.stroke || item.color || '#5367d8'; ctx.lineWidth = Number(item.strokeWidth || 3); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
    }
  } else {
    ctx.beginPath();
    if (type === 'ellipse') ctx.ellipse(width / 2, height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2);
    else roundedRect(0, 0, width, height, Number(item.radius ?? (type === 'sticky' ? 10 : 16)));
    ctx.fillStyle = fill; ctx.fill(); ctx.shadowColor = 'transparent';
    if (item.stroke && Number(item.strokeWidth) > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = Number(item.strokeWidth); ctx.stroke(); }
    if (item.label || item.text) drawObjectText(item, width, height);
  }
  ctx.restore();
}

function drawObjectText(item, width, height) {
  const color = item.color || '#3f4c60';
  if (item.label) {
    ctx.fillStyle = color; ctx.globalAlpha *= .72; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = `600 ${Math.max(9, Number(item.fontSize || 20) * .42)}px 'DM Mono', monospace`;
    ctx.fillText(String(item.label), 20, 21, Math.max(30, width - 40)); ctx.globalAlpha /= .72;
  }
  if (!item.text) return;
  const fontSize = Number(item.fontSize || 20); const lineHeight = fontSize * 1.28;
  ctx.fillStyle = color; ctx.textAlign = item.textAlign || 'left'; ctx.textBaseline = 'top';
  ctx.font = `${item.fontWeight || 600} ${fontSize}px ${item.fontFamily || 'Manrope, sans-serif'}`;
  const lines = String(item.text).split('\n');
  const left = item.label ? 20 : (item.type === 'text' ? 0 : 19);
  const top = item.label ? 54 : (item.type === 'text' ? Math.max(0, (height - lines.length * lineHeight) / 2) : 18);
  const maxWidth = Math.max(20, width - left - (item.type === 'text' ? 0 : 34));
  for (let i = 0; i < Math.min(lines.length, 12); i += 1) ctx.fillText(lines[i], left, top + i * lineHeight, maxWidth);
}

function drawCreationPreview() {
  const drag = state.drag;
  if (!drag || !['rect', 'ellipse', 'sticky', 'text', 'connector', 'draw'].includes(drag.type) || !drag.current) return;
  const preview = newShape(drag.type, drag.start, drag.current);
  drawObject({ id: 'preview', ...preview.fields, opacity: .72, stroke: '#778ad2', strokeWidth: 1.5 });
}

function drawSelection() {
  const selected = [...state.selected].map((id) => state.objects.get(id)).filter((item) => item && !item._deleted);
  if (!selected.length) return;
  const union = selected.map(objectBounds).reduce((box, item) => {
    const left = Math.min(box.x, item.x); const top = Math.min(box.y, item.y);
    const right = Math.max(box.x + box.w, item.x + item.w); const bottom = Math.max(box.y + box.h, item.y + item.h);
    return { x: left, y: top, w: right - left, h: bottom - top };
  });
  ctx.save(); ctx.shadowColor = 'transparent'; ctx.lineWidth = 1.25 / state.zoom; ctx.strokeStyle = '#6685ec'; ctx.setLineDash([4 / state.zoom, 3 / state.zoom]); ctx.strokeRect(union.x - 2, union.y - 2, union.w + 4, union.h + 4); ctx.setLineDash([]);
  if (selected.length === 1) {
    const size = 7 / state.zoom; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#6685ec'; ctx.lineWidth = 1.4 / state.zoom;
    for (const [x, y] of [[union.x, union.y], [union.x + union.w, union.y], [union.x, union.y + union.h], [union.x + union.w, union.y + union.h]]) { ctx.beginPath(); ctx.roundRect(x - size / 2, y - size / 2, size, size, 1.4 / state.zoom); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(union.x + union.w / 2, union.y - 2); ctx.lineTo(union.x + union.w / 2, union.y - 20 / state.zoom); ctx.stroke();
    ctx.beginPath(); ctx.arc(union.x + union.w / 2, union.y - 24 / state.zoom, 4 / state.zoom, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawMarquee() {
  if (!state.marquee) return;
  const { x, y, w, h } = state.marquee;
  ctx.save(); ctx.shadowColor = 'transparent'; ctx.fillStyle = 'rgba(102,133,236,.08)'; ctx.strokeStyle = '#6f8bed'; ctx.lineWidth = 1 / state.zoom; ctx.setLineDash([4 / state.zoom, 3 / state.zoom]); ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); ctx.restore();
}

function drawGuides() {
  if (!state.snapGuides.length) return;
  ctx.save(); ctx.shadowColor = 'transparent'; ctx.strokeStyle = 'rgba(126,155,225,.85)'; ctx.lineWidth = 1 / state.zoom; ctx.setLineDash([4 / state.zoom, 4 / state.zoom]);
  for (const guide of state.snapGuides) { ctx.beginPath(); if (guide.axis === 'x') { ctx.moveTo(guide.value, -100000); ctx.lineTo(guide.value, 100000); } else { ctx.moveTo(-100000, guide.value); ctx.lineTo(100000, guide.value); } ctx.stroke(); }
  ctx.restore();
}

function drawCreationEffects() {
  const now = Date.now();
  for (const [id, startedAt] of state.effects) {
    const item = state.objects.get(id); if (!item || item._deleted) continue;
    const progress = clamp((now - startedAt) / 460, 0, 1); const centerX = Number(item.x || 0) + Number(item.w || 0) / 2; const centerY = Number(item.y || 0) + Number(item.h || 0) / 2;
    ctx.save(); ctx.shadowColor = 'transparent'; ctx.globalAlpha = (1 - progress) * .55; ctx.strokeStyle = item.color || '#8eaa59'; ctx.lineWidth = 1.2 / state.zoom; ctx.lineCap = 'round';
    const inner = 15 + progress * 15; const outer = inner + (1 - progress) * 27;
    for (let ray = 0; ray < 8; ray += 1) {
      const angle = ray * Math.PI / 4 + progress * .2; ctx.beginPath(); ctx.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner); ctx.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer); ctx.stroke();
    }
    ctx.restore();
  }
}

function screenToWorld(clientX, clientY) {
  const rect = canvasRect();
  return { x: (clientX - rect.left - state.panX) / state.zoom, y: (clientY - rect.top - state.panY) / state.zoom };
}

function hitTest(point) {
  const list = querySpatialObjects({ x: point.x - 3, y: point.y - 3, w: 6, h: 6 });
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index]; const box = objectBounds(item);
    if (point.x >= box.x - 3 && point.x <= box.x + box.w + 3 && point.y >= box.y - 3 && point.y <= box.y + box.h + 3) return item;
  }
  return null;
}

function currentSelectionBounds() {
  const selected = [...state.selected].map((id) => state.objects.get(id)).filter((item) => item && !item._deleted);
  if (!selected.length) return null;
  return selected.map(objectBounds).reduce((box, item) => {
    const left = Math.min(box.x, item.x); const top = Math.min(box.y, item.y);
    const right = Math.max(box.x + box.w, item.x + item.w); const bottom = Math.max(box.y + box.h, item.y + item.h);
    return { x: left, y: top, w: right - left, h: bottom - top };
  });
}

function selectTool(tool) {
  state.tool = tool;
  $$('.tool-button[data-tool], .quick-tool[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  stage.classList.toggle('is-panning', tool === 'hand' || state.spaceDown);
  canvas.style.cursor = tool === 'hand' || state.spaceDown ? 'grab' : tool === 'text' || tool === 'sticky' || ['rect', 'ellipse', 'connector', 'draw'].includes(tool) ? 'crosshair' : 'default';
}

function updateBoardTitle(value) {
  const title = String(value || 'Untitled board').trim().slice(0, 60) || 'Untitled board';
  state.title = title;
  document.title = `${title} — SyncBoard`;
  const input = $('#boardTitle');
  if (input && document.activeElement !== input) input.value = title;
}

function applyOperation(operation, { local = false, redraw = true } = {}) {
  if (!operation?.entityId) return;
  state.lamport = Math.max(state.lamport, Number(operation.lamport || 0)) + (local ? 0 : 1);
  if (operation.streamId && compareStream(operation.streamId, state.lastStreamId) > 0) {
    state.lastStreamId = operation.streamId;
    safeWrite(`syncboard:cursor:${boardId}`, state.lastStreamId);
  }
  const previous = state.objects.get(operation.entityId);
  const current = previous || { id: operation.entityId, _clocks: {}, _deleted: false };
  const wasActive = Boolean(previous && !previous._deleted && previous.id !== 'board-meta');
  removeSpatialIndex(operation.entityId);
  const isNewObject = !state.objects.has(operation.entityId) && ['upsert', 'restore'].includes(operation.action);
  const next = { ...current, _clocks: { ...(current._clocks || {}) } };
  const stamp = [Number(operation.lamport || 1), String(operation.actor || '')];
  for (const [field, value] of Object.entries(operation.fields || {})) {
    if (field.startsWith('_') || field === 'id') continue;
    if (compareStamp(stamp, next._clocks[field]) >= 0) { next[field] = value; next._clocks[field] = stamp; }
  }
  if (operation.action === 'delete' && compareStamp(stamp, next._clocks._deleted) >= 0) { next._deleted = true; next._clocks._deleted = stamp; }
  if (operation.action === 'restore' && compareStamp(stamp, next._clocks._deleted) >= 0) { next._deleted = false; next._clocks._deleted = stamp; }
  state.objects.set(operation.entityId, next);
  if (!state.objectOrder.has(operation.entityId)) state.objectOrder.set(operation.entityId, state.nextObjectOrder++);
  const isActive = !next._deleted && next.id !== 'board-meta';
  if (wasActive !== isActive) state.liveObjectCount += isActive ? 1 : -1;
  indexSpatialObject(next);
  if (next.id === 'board-meta' && typeof next.title === 'string') updateBoardTitle(next.title);
  if (isNewObject) state.effects.set(operation.entityId, Date.now());
  if (operation.actor === state.clientId && state.pending.has(operation.id)) removePending(operation.id);
  if (redraw) { requestDraw(); renderCounts(); scheduleCache(); }
}

function collectInverse(entityId, action, fields) {
  const current = state.objects.get(entityId);
  if (!current) return { action: 'delete', fields: {} };
  const previous = {};
  for (const field of Object.keys(fields || {})) if (Object.hasOwn(current, field)) previous[field] = current[field];
  if (action === 'delete') return { action: 'restore', fields: {} };
  if (action === 'restore' && current._deleted) return { action: 'delete', fields: {} };
  if (action === 'upsert' && !current._deleted) return { action: 'delete', fields: {} };
  return { action: Object.keys(previous).length ? 'update' : 'delete', fields: previous };
}

function localOperation(entityId, action, fields = {}, { recordHistory = true, group = null } = {}) {
  const inverse = collectInverse(entityId, action, fields);
  const operation = { id: makeId('op'), actor: state.clientId, lamport: ++state.lamport, entityId, action, fields: structuredClone(fields), createdAt: Date.now() };
  applyOperation(operation, { local: true });
  const entry = { entityId, action, fields: structuredClone(fields), inverseAction: inverse.action, inverseFields: structuredClone(inverse.fields) };
  if (recordHistory) {
    if (group) group.push(entry);
    else { state.history.push([entry]); if (state.history.length > 100) state.history.shift(); state.redo = []; }
  }
  state.pending.set(operation.id, operation);
  persistPending(operation);
  if (state.socket?.readyState === WebSocket.OPEN && state.joined) state.socket.send(JSON.stringify({ type: 'op', operation }));
  updateSyncUi();
  return operation;
}

function commitGroup(entries) {
  if (entries.length) { state.history.push(entries); if (state.history.length > 100) state.history.shift(); state.redo = []; }
}

function undo() {
  const group = state.history.pop();
  if (!group) return toast('Nothing to undo just yet.');
  const redoGroup = [];
  for (const entry of [...group].reverse()) {
    const inverse = collectInverse(entry.entityId, entry.inverseAction, entry.inverseFields);
    localOperation(entry.entityId, entry.inverseAction, entry.inverseFields, { recordHistory: false });
    redoGroup.unshift({ ...entry, redoAction: inverse.action, redoFields: inverse.fields });
  }
  state.redo.push(redoGroup); renderInspector(); toast('Your last move is undone.');
}

function redo() {
  const group = state.redo.pop();
  if (!group) return toast('Nothing to redo just yet.');
  const restored = [];
  for (const entry of group) {
    const operation = localOperation(entry.entityId, entry.action, entry.fields, { recordHistory: false });
    restored.push({ ...entry, operationId: operation.id });
  }
  state.history.push(restored.map((entry) => ({ entityId: entry.entityId, action: entry.action, fields: entry.fields, inverseAction: entry.inverseAction, inverseFields: entry.inverseFields })));
  renderInspector(); toast('That idea is back.');
}

function persistPending(operation) {
  if (!state.db) return;
  try { const transaction = state.db.transaction('outbox', 'readwrite'); transaction.objectStore('outbox').put({ ...operation, boardId }); } catch { /* Keep the in-memory outbox active. */ }
}

function removePending(id) {
  state.pending.delete(id);
  if (state.db) { try { state.db.transaction('outbox', 'readwrite').objectStore('outbox').delete(id); } catch { /* Best effort cleanup. */ } }
  updateSyncUi();
}

let cacheTimer = 0;
function scheduleCache() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = 0;
    if (!state.db) return;
    try { state.db.transaction('boards', 'readwrite').objectStore('boards').put({ boardId, lastStreamId: state.lastStreamId, objects: [...state.objects.values()] }); } catch { /* Browser storage may be full. */ }
  }, 750);
}

function openDatabase() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    const request = indexedDB.open('syncboard-local-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'boardId' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function dbRead(storeName, key) {
  return new Promise((resolve) => {
    if (!state.db) return resolve(null);
    try { const request = state.db.transaction(storeName).objectStore(storeName).get(key); request.onsuccess = () => resolve(request.result || null); request.onerror = () => resolve(null); } catch { resolve(null); }
  });
}

function loadOutbox() {
  return new Promise((resolve) => {
    if (!state.db) return resolve([]);
    try { const request = state.db.transaction('outbox').objectStore('outbox').getAll(); request.onsuccess = () => resolve((request.result || []).filter((entry) => entry.boardId === boardId)); request.onerror = () => resolve([]); } catch { resolve([]); }
  });
}

async function loadBoard() {
  state.db = await openDatabase();
  const cached = await dbRead('boards', boardId);
  const queue = await loadOutbox();
  for (const operation of queue) state.pending.set(operation.id, operation);
  if (cached?.objects?.length) {
    state.objects = new Map(cached.objects.map((item) => [item.id, item]));
    rebuildSpatialIndex();
    state.lastStreamId = cached.lastStreamId || '0-0';
    const sharedTitle = cached.objects.find((item) => item.id === 'board-meta')?.title;
    if (sharedTitle) updateBoardTitle(sharedTitle);
  } else {
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Board request returned ${response.status}`);
      const data = await response.json();
      installSnapshot(data.snapshot, data.operations || []);
      if (data.title) updateBoardTitle(data.title);
      state.lastStreamId = data.latestId || data.snapshot?.cursor || '0-0';
    } catch {
      setConnection('offline');
      toast('Board storage is offline. Your edits will wait on this device.');
    }
  }
  for (const operation of state.pending.values()) applyOperation(operation, { local: true, redraw: false });
  state.loading = false;
  renderCounts(); renderInspector(); requestDraw();
  safeWrite(`syncboard:cursor:${boardId}`, state.lastStreamId);
  scheduleCache(); fitBoard();
  connectSocket();
}

function installSnapshot(snapshot, operations) {
  if (snapshot?.objects) { state.objects = new Map(Object.values(snapshot.objects).map((item) => [item.id, item])); rebuildSpatialIndex(); }
  for (const operation of operations) applyOperation(operation, { redraw: false });
  if (snapshot?.cursor && compareStream(snapshot.cursor, state.lastStreamId) > 0) state.lastStreamId = snapshot.cursor;
}

function connectSocket() {
  if (state.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.socket.readyState)) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/collab?board=${encodeURIComponent(boardId)}`);
  state.socket = socket; state.joined = false;
  socket.addEventListener('open', () => {
    clearTimeout(state.reconnectTimer); state.reconnectTimer = 0;
    setConnection('connecting');
    socket.send(JSON.stringify({ type: 'join', boardId, clientId: state.clientId, name: state.name, color: state.color, cursor: state.lastStreamId, reconnect: state.everConnected }));
  });
  socket.addEventListener('message', (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    handleSocketMessage(message);
  });
  socket.addEventListener('close', () => {
    state.joined = false;
    if (state.socket === socket) {
      setConnection('offline');
      const delay = Math.min(10_000, 750 * (2 ** Math.min(state.reconnectAttempt, 4))) * (.75 + Math.random() * .5);
      state.reconnectAttempt += 1;
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectSocket, delay);
    }
  });
  socket.addEventListener('error', () => { /* close event schedules reconnect */ });
}

function handleSocketMessage(message) {
  if (message.type === 'welcome') {
    state.joined = true; state.everConnected = true; state.lastStreamId = message.sync?.latestId || state.lastStreamId;
    state.reconnectAttempt = 0;
    if (message.title) updateBoardTitle(message.title);
    if (message.sync?.snapshot) {
      const localPending = [...state.pending.values()];
      state.objects = new Map(Object.values(message.sync.snapshot.objects || {}).map((item) => [item.id, item]));
      rebuildSpatialIndex();
      for (const operation of message.sync.operations || []) applyOperation(operation, { redraw: false });
      for (const operation of localPending) applyOperation(operation, { local: true, redraw: false });
    } else for (const operation of message.sync?.operations || []) applyOperation(operation, { redraw: false });
    for (const person of message.presence || []) state.users.set(person.id, person);
    state.users.set(state.clientId, { id: state.clientId, name: state.name, color: state.color, cursor: state.pointerWorld, activeObject: [...state.selected][0], self: true });
    setConnection('online');
    $('#instanceLabel').textContent = `INSTANCE ${String(message.server?.instance || 'local').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()}`;
    for (const operation of state.pending.values()) state.socket?.send(JSON.stringify({ type: 'op', operation }));
    renderPresence(); renderCounts(); renderInspector(); renderHistory(); requestDraw(); scheduleCache();
    return;
  }
  if (message.type === 'operation') {
    applyOperation(message);
    if (message.actor !== state.clientId) addActivity(message.actor, message.entityId, message.action);
    if (message.actor === state.clientId && state.pending.has(message.id)) removePending(message.id);
    if (state.selected.has(message.entityId)) renderInspector();
    renderLayersIfVisible();
    return;
  }
  if (message.type === 'presence') {
    const person = message.person;
    if (!person || person.id === state.clientId) return;
    const previous = state.users.get(person.id);
    state.users.set(person.id, person);
    if (!previous || previous.activeObject !== person.activeObject) renderPresence();
    else renderCursor(person);
    return;
  }
  if (message.type === 'presence-left') {
    state.users.delete(message.id); state.cursors.delete(message.id);
    state.cursorNodes.get(message.id)?.remove(); state.cursorNodes.delete(message.id);
    renderPresence(); renderCursors();
    return;
  }
  if (message.type === 'ack') { removePending(message.operationId); if (message.streamId && compareStream(message.streamId, state.lastStreamId) > 0) state.lastStreamId = message.streamId; return; }
  if (message.type === 'error') {
    if (message.operationId && message.code === 'rate_limited') {
      const operation = state.pending.get(message.operationId);
      if (operation) setTimeout(() => { if (state.socket?.readyState === WebSocket.OPEN && state.joined) state.socket.send(JSON.stringify({ type: 'op', operation })); }, 1100);
    } else if (message.code === 'storage_unavailable') {
      setConnection('offline');
      if (state.socket?.readyState === WebSocket.OPEN) state.socket.close(1013, 'Shared store unavailable');
    }
    toast(message.message || 'The edit could not sync.');
    return;
  }
}

function sendPresence() {
  if (state.socket?.readyState !== WebSocket.OPEN || !state.joined) return;
  const now = performance.now();
  if (now - state.lastPresenceAt < 100) return;
  state.lastPresenceAt = now;
  state.socket.send(JSON.stringify({ type: 'presence', cursor: state.pointerWorld, activeObject: [...state.selected][0] || null }));
}

function setConnection(mode) {
  const online = mode === 'online'; const offline = mode === 'offline';
  syncPill.classList.toggle('is-offline', offline); syncPill.classList.toggle('is-saving', mode === 'connecting' || state.pending.size > 0);
  syncLabel.textContent = offline ? 'Offline — edits saved here' : mode === 'connecting' ? 'Finding your team…' : state.pending.size ? `Saving ${state.pending.size} edit${state.pending.size === 1 ? '' : 's'}` : 'All changes saved';
  $('#footerConnection').textContent = offline ? 'Offline — safely on this device' : online ? 'You’re live' : 'Connecting…';
  $('#connectionToast').classList.toggle('show', offline && state.pending.size > 0);
  $('.live-dot').style.background = offline ? '#dd8881' : online ? '#80be83' : '#d4b66f';
  updateSyncUi();
}

function updateSyncUi() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (!state.joined) return;
  const count = state.pending.size;
  syncPill.classList.toggle('is-saving', count > 0); syncPill.classList.remove('is-offline');
  syncLabel.textContent = count ? `Saving ${count} edit${count === 1 ? '' : 's'}` : 'All changes saved';
  $('#pendingCount').textContent = count ? `${count} change${count === 1 ? '' : 's'} waiting to sync` : 'Nothing waiting to sync';
  $('#connectionToast').classList.toggle('show', !state.joined && count > 0);
}

function renderCounts() {
  const count = state.liveObjectCount;
  $('#objectCount').innerHTML = `<span class="count-spark">✳</span><strong>${count.toLocaleString()}</strong><span>object${count === 1 ? '' : 's'}</span>`;
  $('#layersBadge').textContent = count.toLocaleString();
  $('#peopleCount').textContent = String(state.users.size || 1);
  updateSyncUi();
}

function renderPresence() {
  const people = [...state.users.values()];
  if (!people.some((person) => person.id === state.clientId)) people.unshift({ id: state.clientId, name: state.name, color: state.color, self: true });
  $('#peopleCount').textContent = String(people.length);
  $('#metricUsers').textContent = String(people.length);
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  $('#topAvatars').innerHTML = people.slice(0, 4).map((person, index) => `<span class="avatar" title="${escapeHtml(person.name)}" style="z-index:${10 - index};background:${escapeHtml(person.color || '#dce5fb')};animation-delay:${index * 45}ms">${escapeHtml(initials(person.name))}</span>`).join('') + (people.length > 4 ? `<span class="avatar more-people" title="${people.length - 4} more">+${people.length - 4}</span>` : '');
  $('#peopleList').innerHTML = people.slice(0, 8).map((person, index) => `<div class="person-row" style="animation-delay:${index * 35}ms"><span class="person-avatar" style="background:${escapeHtml(person.color || '#dce5fb')}">${escapeHtml(initials(person.name))}</span><span class="person-details"><span class="person-name">${escapeHtml(person.name)}${person.id === state.clientId ? ' (you)' : ''}</span><span class="person-status">${person.activeObject ? 'Editing an object' : person.cursor ? 'Exploring the board' : 'Around today'}</span></span>${person.id === state.clientId ? '<span class="person-self">YOU</span>' : ''}</div>`).join('');
  renderCursors();
}

function renderCursor(person) {
  if (!person || person.id === state.clientId || !person.cursor) return;
  let cursor = state.cursorNodes.get(person.id);
  if (!cursor) {
    cursor = document.createElement('div'); cursor.className = 'remote-cursor'; cursor.dataset.id = person.id;
    cursorLayer.append(cursor); state.cursorNodes.set(person.id, cursor);
  }
  const color = person.color || '#8299ee'; const name = person.name || 'Collaborator';
  if (cursor.dataset.color !== color || cursor.dataset.name !== name) {
    cursor.dataset.color = color; cursor.dataset.name = name;
    cursor.innerHTML = `<svg viewBox="0 0 24 24" fill="${escapeHtml(color)}" stroke="white" stroke-width="1.6" stroke-linejoin="round"><path d="M4 2.8 19.5 14l-7.1.7-3.7 6.1L4 2.8Z"/></svg><span class="remote-cursor-label" style="background:${escapeHtml(color)}">${escapeHtml(name)}</span>`;
  }
  const x = person.cursor.x * state.zoom + state.panX; const y = person.cursor.y * state.zoom + state.panY;
  cursor.style.transform = `translate3d(${x}px,${y}px,0)`;
}

function renderCursors() {
  const active = new Set();
  for (const person of state.users.values()) {
    if (person.id === state.clientId || !person.cursor) continue;
    active.add(person.id); renderCursor(person);
  }
  for (const [id, node] of state.cursorNodes) if (!active.has(id)) { node.remove(); state.cursorNodes.delete(id); }
}

function renderInspector() {
  const selection = [...state.selected].map((id) => state.objects.get(id)).filter((item) => item && !item._deleted);
  const empty = $('.empty-selection'); const editor = $('#selectionEditor');
  $('#selectionCount').textContent = selection.length ? `${selection.length} selected` : 'Nothing selected';
  empty.classList.toggle('hidden', selection.length > 0); editor.classList.toggle('hidden', !selection.length);
  if (!selection.length) return;
  const item = selection[0];
  const title = item.label || item.text?.split('\n')[0] || `${item.type || 'Object'} ${item.id.slice(-4)}`;
  const colors = palette.map((color) => `<button class="swatch ${item.fill === color ? 'selected' : ''}" data-color="${color}" style="background:${color}" aria-label="Set color ${color}"></button>`).join('');
  const multi = selection.length > 1;
  editor.innerHTML = `<div class="editor-heading"><span class="object-type-icon">${svgIcon(item.type === 'text' ? 'text' : item.type === 'connector' ? 'line' : item.type === 'draw' ? 'pen' : 'shapes')}</span><span>${escapeHtml(multi ? `${selection.length} objects` : title)}</span></div>
    ${!multi && item.text !== undefined ? `<label class="editor-field-label">TEXT<textarea class="editor-text" id="textEditor" maxlength="1000">${escapeHtml(item.text)}</textarea></label>` : ''}
    <div><span class="editor-field-label" style="margin-bottom:7px">FILL</span><div class="swatch-row">${colors}</div></div>
    ${selection.length === 1 ? `<div><span class="editor-field-label" style="margin-bottom:7px">POSITION & SIZE</span><div class="editor-row"><input class="editor-number" data-field="x" aria-label="X position" type="number" value="${Math.round(item.x || 0)}"><input class="editor-number" data-field="y" aria-label="Y position" type="number" value="${Math.round(item.y || 0)}"></div><div class="editor-row" style="margin-top:6px"><input class="editor-number" data-field="w" aria-label="Width" type="number" min="1" value="${Math.round(item.w || 0)}"><input class="editor-number" data-field="h" aria-label="Height" type="number" min="1" value="${Math.round(item.h || 0)}"></div></div>
    <div class="editor-action-row"><label class="editor-field-label" style="flex-direction:row;align-items:center;gap:8px">ROTATE <input class="rotate-range" id="rotateEditor" type="range" min="-180" max="180" value="${Math.round(item.rotation || 0)}"></label><button class="delete-button" id="deleteSelected">${svgIcon('eraser')} Delete</button></div>` : `<div class="editor-action-row"><span class="selection-count">Multi-select</span><button class="delete-button" id="deleteSelected">${svgIcon('eraser')} Delete all</button></div>`}`;
  $$('.swatch', editor).forEach((button) => button.addEventListener('click', () => updateSelectionFields({ fill: button.dataset.color })));
  const textInput = $('#textEditor', editor);
  textInput?.addEventListener('change', () => updateSelectionFields({ text: textInput.value }));
  $$('[data-field]', editor).forEach((input) => input.addEventListener('change', () => {
    const field = input.dataset.field; const value = Number(input.value);
    if (Number.isFinite(value)) updateSelectionFields({ [field]: field === 'w' || field === 'h' ? Math.max(4, value) : value });
  }));
  $('#rotateEditor', editor)?.addEventListener('change', (event) => updateSelectionFields({ rotation: Number(event.target.value) }));
  $('#deleteSelected', editor)?.addEventListener('click', deleteSelection);
}

let layersRenderQueued = false;
function renderLayersIfVisible() {
  if ($('.inspector-tab.active')?.dataset.panel !== 'layers' || layersRenderQueued) return;
  layersRenderQueued = true;
  requestAnimationFrame(() => { layersRenderQueued = false; if ($('.inspector-tab.active')?.dataset.panel === 'layers') renderLayers(); });
}

function renderLayers() {
  const objects = activeObjects().slice().reverse();
  $('#layersList').innerHTML = objects.slice(0, 150).map((item) => {
    const name = item.label || item.text?.split('\n')[0] || item.type || 'Object';
    return `<button class="layer-row ${state.selected.has(item.id) ? 'selected' : ''}" type="button" aria-pressed="${state.selected.has(item.id)}" data-id="${escapeHtml(item.id)}"><span class="layer-swatch" style="background:${escapeHtml(item.fill || item.stroke || '#e5edff')}"></span><span class="layer-name">${escapeHtml(name)}</span><span class="layer-type">${escapeHtml(item.type || 'shape')}</span></button>`;
  }).join('');
  $$('.layer-row', $('#layersList')).forEach((row) => row.addEventListener('click', () => { state.selected = new Set([row.dataset.id]); renderInspector(); requestDraw(); }));
}

function addActivity(actor, entityId, action) {
  const person = state.users.get(actor) || { id: actor, name: 'A collaborator', color: '#d8e1fb' };
  const item = state.objects.get(entityId);
  state.activity.unshift({ name: person.name, color: person.color, action, label: item?.label || item?.text?.split('\n')[0] || 'an idea', at: Date.now() });
  state.activity = state.activity.slice(0, 20);
  if (!activityRenderQueued) {
    activityRenderQueued = true;
    requestAnimationFrame(() => { activityRenderQueued = false; renderHistory(); });
  }
}

let activityRenderQueued = false;

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  return bytes < 1024 ? `${Math.round(bytes)} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function renderHistory() {
  if (!state.activity.length) {
    $('#activityList').innerHTML = `<div class="activity-item"><span class="activity-avatar" style="background:${state.color}">${escapeHtml(state.name[0] || 'J')}</span><div class="activity-copy"><strong>${escapeHtml(state.name)}</strong> opened the board.<span class="activity-time">Just now</span></div></div>`;
    return;
  }
  $('#activityList').innerHTML = state.activity.slice(0, 8).map((item) => `<div class="activity-item"><span class="activity-avatar" style="background:${escapeHtml(item.color)}">${escapeHtml(item.name.split(/\s+/).map((word) => word[0]).slice(0,2).join('').toUpperCase())}</span><div class="activity-copy"><strong>${escapeHtml(item.name)}</strong> ${item.action === 'delete' ? 'removed' : item.action === 'upsert' ? 'added' : 'updated'} <strong>${escapeHtml(item.label)}</strong>.<span class="activity-time">Just now</span></div></div>`).join('');
}

function updateSelectionFields(fields) {
  const entries = [];
  for (const id of state.selected) {
    if (!state.objects.has(id)) continue;
    localOperation(id, 'update', fields, { recordHistory: false, group: entries });
  }
  commitGroup(entries); renderInspector(); renderLayersIfVisible();
}

function deleteSelection() {
  const entries = [];
  for (const id of state.selected) if (state.objects.has(id)) localOperation(id, 'delete', {}, { recordHistory: false, group: entries });
  commitGroup(entries); state.selected.clear(); renderInspector(); renderCounts(); requestDraw();
}

function setSelection(ids) {
  state.selected = new Set([...ids].filter((id) => state.objects.has(id) && !state.objects.get(id)._deleted));
  renderInspector(); renderLayersIfVisible(); requestDraw(); sendPresence();
}

function fitBoard() {
  const objects = activeObjects();
  if (!objects.length) { state.zoom = 1; state.panX = stage.clientWidth / 2; state.panY = stage.clientHeight / 2; requestDraw(); return; }
  const bounds = objects.map(objectBounds).reduce((box, item) => {
    const x = Math.min(box.x, item.x); const y = Math.min(box.y, item.y);
    const right = Math.max(box.x + box.w, item.x + item.w); const bottom = Math.max(box.y + box.h, item.y + item.h);
    return { x, y, w: right - x, h: bottom - y };
  });
  const padding = 150; const width = Math.max(1, stage.clientWidth - padding * 2); const height = Math.max(1, stage.clientHeight - padding * 2);
  state.zoom = clamp(Math.min(width / bounds.w, height / bounds.h, 1), .045, 1.3);
  state.panX = (stage.clientWidth - bounds.w * state.zoom) / 2 - bounds.x * state.zoom;
  state.panY = (stage.clientHeight - bounds.h * state.zoom) / 2 - bounds.y * state.zoom;
  updateZoomUi(); renderCursors(); requestDraw();
}

function zoomAt(scale, screenPoint = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }) {
  const next = clamp(scale, .045, 3.5);
  const worldX = (screenPoint.x - state.panX) / state.zoom; const worldY = (screenPoint.y - state.panY) / state.zoom;
  state.zoom = next; state.panX = screenPoint.x - worldX * next; state.panY = screenPoint.y - worldY * next;
  updateZoomUi(); renderCursors(); requestDraw();
}

function updateZoomUi() { $('#zoomValue').textContent = `${Math.round(state.zoom * 100)}%`; }

function updateMiniMap() {
  const visible = { x: -state.panX / state.zoom, y: -state.panY / state.zoom, w: stage.clientWidth / state.zoom, h: stage.clientHeight / state.zoom };
  const all = state.worldBounds || { x: 0, y: 0, w: 1, h: 1 };
  const minimap = $('#miniMap'); const inner = $('.mini-map-glow', minimap);
  const sx = 75 / Math.max(all.w, 1); const sy = 39 / Math.max(all.h, 1); const factor = Math.min(sx, sy);
  const width = clamp(visible.w * factor, 11, 77); const height = clamp(visible.h * factor, 8, 43);
  const x = clamp(13 + (visible.x - all.x) * factor, 9, 95 - width); const y = clamp(8 + (visible.y - all.y) * factor, 6, 46 - height);
  inner.style.left = `${x}px`; inner.style.top = `${y}px`; inner.style.width = `${width}px`; inner.style.height = `${height}px`;
}

function newShape(tool, start, end = start) {
  const deltaX = end.x - start.x; const deltaY = end.y - start.y;
  let x = Math.min(start.x, end.x); let y = Math.min(start.y, end.y); let w = Math.abs(deltaX); let h = Math.abs(deltaY);
  let type = tool; let fields = {};
  const fill = state.drag?.previewFill || palette[(activeObjects().length + Math.floor(Math.random() * 2)) % palette.length];
  if (tool === 'sticky') { type = 'sticky'; w = w < 35 ? 180 : w; h = h < 35 ? 155 : h; fields = { text: 'A little idea\nwith big energy.', fill: '#fff0b9', color: '#765e22', fontSize: 18, radius: 11, rotation: Math.round(Math.random() * 4 - 2) }; }
  else if (tool === 'text') { type = 'text'; w = w < 25 ? 335 : w; h = h < 25 ? 60 : h; fields = { text: 'A thought worth sharing', color: '#273247', fontSize: 32, fontWeight: 700 }; }
  else if (tool === 'rect') { type = 'rect'; w = w < 35 ? 180 : w; h = h < 35 ? 120 : h; fields = { fill, color: '#49566d', radius: 18 }; }
  else if (tool === 'ellipse') { type = 'ellipse'; w = w < 35 ? 125 : w; h = h < 35 ? 125 : h; fields = { fill, color: '#49566d' }; }
  else if (tool === 'connector') { type = 'connector'; x = start.x; y = start.y; w = Math.abs(deltaX) < 4 && Math.abs(deltaY) < 4 ? 130 : deltaX; h = Math.abs(deltaX) < 4 && Math.abs(deltaY) < 4 ? 0 : deltaY; fields = { stroke: '#95a0b1', strokeWidth: 2.5, arrow: true }; }
  else if (tool === 'draw') { type = 'draw'; w = Math.max(1, w); h = Math.max(1, h); const points = state.drag?.points || [start, end]; fields = { points: JSON.stringify(points), stroke: '#677be1', strokeWidth: 3.5 }; }
  return { id: makeId('shape'), fields: { type, x, y, w, h, rotation: 0, fill: '#e5edff', color: '#49566d', stroke: '#9aa5b7', strokeWidth: 1.5, ...fields } };
}

function makeCreation(start, end, dragState) {
  if (dragState.type === 'draw') state.drag = { ...dragState, points: dragState.points };
  const created = newShape(dragState.type, start, end);
  if (dragState.type === 'draw') state.drag = null;
  localOperation(created.id, 'upsert', created.fields);
  setSelection([created.id]);
  state.tool = 'select'; selectTool('select');
  addActivity(state.clientId, created.id, 'upsert'); renderCounts();
}

function selectionHandle(point) {
  if (state.selected.size !== 1) return null;
  const bounds = currentSelectionBounds(); if (!bounds) return null;
  const distance = 10 / state.zoom;
  if (Math.abs(point.x - (bounds.x + bounds.w)) < distance && Math.abs(point.y - (bounds.y + bounds.h)) < distance) return 'resize';
  return null;
}

function alignMove(proposedX, proposedY, movingIds) {
  const moving = [...movingIds].map((id) => state.objects.get(id)).filter(Boolean);
  if (!moving.length) return { dx: proposedX, dy: proposedY, guides: [] };
  const movingBounds = moving.map(objectBounds).reduce((box, item) => { const x = Math.min(box.x, item.x); const y = Math.min(box.y, item.y); const right = Math.max(box.x + box.w, item.x + item.w); const bottom = Math.max(box.y + box.h, item.y + item.h); return { x, y, w: right - x, h: bottom - y }; });
  const others = activeObjects().filter((item) => !movingIds.has(item.id));
  let dx = proposedX; let dy = proposedY; const guides = []; const threshold = 6 / state.zoom;
  const xEdges = [movingBounds.x + dx, movingBounds.x + movingBounds.w / 2 + dx, movingBounds.x + movingBounds.w + dx];
  const yEdges = [movingBounds.y + dy, movingBounds.y + movingBounds.h / 2 + dy, movingBounds.y + movingBounds.h + dy];
  let bestX = null; let bestY = null;
  for (const other of others.slice(0, 180)) {
    const box = objectBounds(other); const otherX = [box.x, box.x + box.w / 2, box.x + box.w]; const otherY = [box.y, box.y + box.h / 2, box.y + box.h];
    const matchX = xEdges.flatMap((edge) => otherX.map((target) => ({ diff: target - edge, value: target }))).sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))[0];
    const matchY = yEdges.flatMap((edge) => otherY.map((target) => ({ diff: target - edge, value: target }))).sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))[0];
    if (matchX && Math.abs(matchX.diff) < threshold && (!bestX || Math.abs(matchX.diff) < Math.abs(bestX.diff))) bestX = matchX;
    if (matchY && Math.abs(matchY.diff) < threshold && (!bestY || Math.abs(matchY.diff) < Math.abs(bestY.diff))) bestY = matchY;
  }
  if (bestX) { dx += bestX.diff; guides.push({ axis: 'x', value: bestX.value }); }
  if (bestY) { dy += bestY.diff; guides.push({ axis: 'y', value: bestY.value }); }
  return { dx, dy, guides: guides.slice(0, 2) };
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  const point = screenToWorld(event.clientX, event.clientY);
  const pan = state.tool === 'hand' || state.spaceDown || event.button === 1;
  if (pan) { state.drag = { type: 'pan', clientX: event.clientX, clientY: event.clientY, panX: state.panX, panY: state.panY }; canvas.style.cursor = 'grabbing'; return; }
  if (state.tool === 'select') {
    const handle = selectionHandle(point);
    if (handle) {
      const item = state.objects.get([...state.selected][0]);
      state.drag = { type: handle, start: point, itemId: item.id, original: { x: item.x, y: item.y, w: item.w, h: item.h }, changed: false };
      return;
    }
    const hit = hitTest(point);
    if (hit) {
      if (event.shiftKey) { const next = new Set(state.selected); next.has(hit.id) ? next.delete(hit.id) : next.add(hit.id); setSelection(next); }
      else if (!state.selected.has(hit.id)) setSelection([hit.id]);
      state.drag = { type: 'move', start: point, previous: point, selectedIds: new Set(state.selected), initial: [...state.selected].map((id) => { const item = state.objects.get(id); return [id, { x: item.x, y: item.y }]; }), moved: false };
      return;
    }
    if (!event.shiftKey) setSelection([]);
    state.drag = { type: 'marquee', start: point, additive: event.shiftKey };
    state.marquee = { x: point.x, y: point.y, w: 0, h: 0 }; requestDraw(); return;
  }
  if (state.tool === 'eraser') {
    const hit = hitTest(point); if (hit) { localOperation(hit.id, 'delete', {}); renderCounts(); }
    return;
  }
  state.drag = { type: state.tool, start: point, current: point, points: [point], previewFill: palette[(activeObjects().length + Math.floor(Math.random() * 2)) % palette.length] };
});

canvas.addEventListener('pointermove', (event) => {
  const point = screenToWorld(event.clientX, event.clientY); state.pointerWorld = point;
  sendPresence();
  if (!state.drag) { if (state.tool === 'select') canvas.style.cursor = hitTest(point) ? 'move' : 'default'; return; }
  const drag = state.drag;
  if (drag.type === 'pan') { state.panX = drag.panX + event.clientX - drag.clientX; state.panY = drag.panY + event.clientY - drag.clientY; renderCursors(); requestDraw(); return; }
  if (drag.type === 'move') {
    const dx = point.x - drag.start.x; const dy = point.y - drag.start.y;
    const snapped = alignMove(dx, dy, drag.selectedIds); state.snapGuides = snapped.guides;
    for (const [id, origin] of drag.initial) {
      const item = state.objects.get(id); if (item) { item.x = origin.x + snapped.dx; item.y = origin.y + snapped.dy; }
    }
    drag.moved = Math.abs(dx) + Math.abs(dy) > 1; requestDraw(); renderCursors(); return;
  }
  if (drag.type === 'resize') {
    const item = state.objects.get(drag.itemId); if (item) { item.w = Math.max(20, drag.original.w + point.x - drag.start.x); item.h = Math.max(20, drag.original.h + point.y - drag.start.y); drag.changed = true; }
    requestDraw(); return;
  }
  if (drag.type === 'marquee') {
    state.marquee = { x: Math.min(point.x, drag.start.x), y: Math.min(point.y, drag.start.y), w: Math.abs(point.x - drag.start.x), h: Math.abs(point.y - drag.start.y) };
    requestDraw(); return;
  }
  drag.current = point;
  if (drag.type === 'draw') {
    const previous = drag.points.at(-1); if (Math.hypot(point.x - previous.x, point.y - previous.y) > 2 / state.zoom) drag.points.push(point);
  }
  requestDraw();
});

canvas.addEventListener('pointerup', (event) => {
  if (!state.drag) return;
  const drag = state.drag; const end = screenToWorld(event.clientX, event.clientY); state.drag = null; state.snapGuides = [];
  if (drag.type === 'pan') { canvas.style.cursor = state.tool === 'hand' ? 'grab' : 'default'; requestDraw(); return; }
  if (drag.type === 'move' && drag.moved) {
    const entries = [];
    for (const [id, origin] of drag.initial) {
      const item = state.objects.get(id); if (item) { const fields = { x: item.x, y: item.y }; item.x = origin.x; item.y = origin.y; localOperation(id, 'update', fields, { recordHistory: false, group: entries }); }
    }
    commitGroup(entries); renderInspector();
  } else if (drag.type === 'resize' && drag.changed) {
    const item = state.objects.get(drag.itemId); if (item) { const fields = { x: item.x, y: item.y, w: item.w, h: item.h }; Object.assign(item, drag.original); localOperation(drag.itemId, 'update', fields); renderInspector(); }
  } else if (drag.type === 'marquee') {
    const rect = state.marquee; const ids = drag.additive ? new Set(state.selected) : new Set();
    if (rect && (rect.w > 3 || rect.h > 3)) for (const item of activeObjects()) { const box = objectBounds(item); if (box.x + box.w >= rect.x && box.x <= rect.x + rect.w && box.y + box.h >= rect.y && box.y <= rect.y + rect.h) ids.add(item.id); }
    state.marquee = null; setSelection(ids);
  } else if (['rect', 'ellipse', 'sticky', 'text', 'connector', 'draw'].includes(drag.type)) {
    if (drag.type === 'draw' && drag.points.length === 1) drag.points.push(end);
    makeCreation(drag.start, end, drag);
  }
  requestDraw();
});

canvas.addEventListener('pointercancel', () => { state.drag = null; state.marquee = null; state.snapGuides = []; requestDraw(); });
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const rect = canvasRect(); zoomAt(state.zoom * (event.deltaY < 0 ? 1.09 : .92), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  } else { state.panX -= event.deltaX; state.panY -= event.deltaY; renderCursors(); requestDraw(); }
}, { passive: false });

$$('[data-tool]').forEach((button) => button.addEventListener('click', () => selectTool(button.dataset.tool)));
$('#undoButton').addEventListener('click', undo); $('#redoButton').addEventListener('click', redo); $('#quickUndo').addEventListener('click', undo); $('#quickRedo').addEventListener('click', redo);
$('#zoomOut').addEventListener('click', () => zoomAt(state.zoom / 1.15)); $('#zoomIn').addEventListener('click', () => zoomAt(state.zoom * 1.15));
$('#zoomValue').addEventListener('click', fitBoard); $('#fitBoard').addEventListener('click', fitBoard); $('#miniMap').addEventListener('click', fitBoard);
$('#outlineButton').addEventListener('click', () => setInspectorPanel('layers'));
$('#historyButton').addEventListener('click', () => setInspectorPanel('activity'));

function setInspectorPanel(panel) {
  $$('.inspector-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === panel));
  $('#selectionSection').classList.toggle('hidden', panel !== 'design');
  $('.people-section').classList.toggle('hidden', panel !== 'design');
  $('.live-section').classList.toggle('hidden', panel !== 'design');
  $('#layersPanel').classList.toggle('hidden', panel !== 'layers');
  $('#activityPanel').classList.toggle('hidden', panel !== 'activity');
  if (panel === 'layers') renderLayers(); if (panel === 'activity') renderHistory();
}
$$('.inspector-tab').forEach((tab) => tab.addEventListener('click', () => setInspectorPanel(tab.dataset.panel)));

$('#inviteButton').addEventListener('click', () => openShareDialog()); $('#addPersonButton').addEventListener('click', () => openShareDialog());
function sharedBoardUrl() {
  const link = new URL(location.pathname, location.origin);
  link.searchParams.set('board', boardId);
  return link.href;
}
function openShareDialog() {
  const link = sharedBoardUrl(); const linkElement = $('#shareUrl');
  linkElement.value = link;
  $('#shareRoomId').textContent = boardId;
  $('#shareDialog').showModal();
}
$('#shareUrl').addEventListener('click', (event) => event.currentTarget.select());
$('#copyLink').addEventListener('click', async () => {
  const link = sharedBoardUrl();
  try { await navigator.clipboard.writeText(link); $('#copyLink').innerHTML = `${svgIcon('check')} Copied`; toast('Board link copied. Bring your people in.'); }
  catch { toast(link); }
});
$('#profileButton').addEventListener('click', () => { $('#nameInput').value = state.name; $('#nameDialog').showModal(); setTimeout(() => $('#nameInput').select(), 50); });
$('#nameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#nameInput').value.trim().slice(0, 24); if (!name) return;
  state.name = name; safeWrite('syncboard:name', name); safeWrite('syncboard:name-customized', '1'); $('#nameDialog').close(); renderPresence();
  if (state.socket?.readyState === WebSocket.OPEN) { state.socket.close(); state.joined = false; setTimeout(connectSocket, 100); }
});
$('#dismissTip').addEventListener('click', () => $('.inspector-bottom').classList.add('hidden'));
$('#loadTestButton').addEventListener('click', generateTestBoard);
$('#boardTitle').addEventListener('change', (event) => {
  updateBoardTitle(event.target.value);
  localOperation('board-meta', 'update', { title: state.title }, { recordHistory: false });
});

async function generateTestBoard() {
  const button = $('#loadTestButton'); const old = button.innerHTML;
  button.disabled = true; button.innerHTML = '<span class="toast-spinner"></span><span>Building a big board…</span>';
  const stressId = 'stress-demo';
  try {
    const response = await fetch('/api/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boardId: stressId, count: 5000 }) });
    if (!response.ok && response.status !== 409) throw new Error('Could not create the 5,000 object canvas.');
    location.href = `/?board=${encodeURIComponent(stressId)}`;
  } catch (error) { toast(error.message || 'Could not create the canvas.'); button.disabled = false; button.innerHTML = old; }
}

function toast(message) {
  const node = $('#appToast'); node.textContent = message; node.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
}

window.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  if (event.code === 'Space' && !typing) { event.preventDefault(); state.spaceDown = true; stage.classList.add('is-panning'); canvas.style.cursor = 'grab'; return; }
  if (typing) return;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
  if (mod && event.key === 'Enter') { event.preventDefault(); openShareDialog(); return; }
  if (event.key === 'Escape') { setSelection([]); selectTool('select'); }
  if (event.key === 'Delete' || event.key === 'Backspace') { if (state.selected.size) { event.preventDefault(); deleteSelection(); } return; }
  const shortcuts = { v: 'select', h: 'hand', n: 'sticky', t: 'text', r: 'rect', e: 'ellipse', c: 'connector', d: 'draw', x: 'eraser' };
  if (shortcuts[event.key.toLowerCase()]) selectTool(shortcuts[event.key.toLowerCase()]);
});
window.addEventListener('keyup', (event) => { if (event.code === 'Space') { state.spaceDown = false; stage.classList.remove('is-panning'); canvas.style.cursor = state.tool === 'hand' ? 'grab' : 'default'; } });
window.addEventListener('blur', () => { state.spaceDown = false; stage.classList.remove('is-panning'); });
window.addEventListener('online', () => { toast('Back online. Catching up your board…'); connectSocket(); });
window.addEventListener('offline', () => { setConnection('offline'); toast('You’re offline. Your new edits are safe on this device.'); });
window.addEventListener('resize', resizeCanvas);
if ('ResizeObserver' in window) { state.resizeObserver = new ResizeObserver(resizeCanvas); state.resizeObserver.observe(stage); }

async function refreshMetrics() {
  try {
    const response = await fetch('/api/metrics', { cache: 'no-store' }); if (!response.ok) return;
    const data = await response.json(); state.metrics = { p95: data.relayP95 || 0, ops: data.opsPerSecond || 0, users: data.users || 1 };
    $('#metricOps').textContent = String(state.metrics.ops); $('#metricP95').innerHTML = `${Math.round(state.metrics.p95)}<small>ms</small>`;
    $('#metricUsers').textContent = String(Math.max(state.users.size, data.users, 1)); $('#latencyLabel').textContent = `${Math.max(1, Math.round(state.metrics.p95))} ms`;
    $('#metricBoards').textContent = String(data.boards ?? 1); $('#metricReconnects').textContent = String(data.reconnections ?? 0);
    $('#metricOffline').textContent = String(data.offlineMerges ?? 0); $('#metricSnapshot').textContent = formatBytes(data.snapshotBytes || 0);
    $('#storageMode').textContent = String(data.store || 'local').toUpperCase();
  } catch { /* The live panel recovers on its next refresh. */ }
}

setInterval(() => {
  if (state.socket?.readyState === WebSocket.OPEN && state.joined) sendPresence();
}, 2500);
setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const [id, person] of state.users) {
    if (id !== state.clientId && person.lastSeen && now - person.lastSeen > 4000) {
      state.users.delete(id); state.cursorNodes.get(id)?.remove(); state.cursorNodes.delete(id); changed = true;
    }
  }
  if (changed) renderPresence();
}, 500);
setInterval(refreshMetrics, 5000);
setInterval(() => {
  if (!state.joined && navigator.onLine) connectSocket();
}, 6000);

selectTool('select'); resizeCanvas(); renderPresence(); renderHistory(); updateZoomUi();
loadBoard();
