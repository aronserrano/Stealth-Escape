// ------------------------------------------------------------
// PHANTOM BREAK — STEALTH ESCAPE
// ------------------------------------------------------------

const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
const W = canvas.width;   // 800
const H = canvas.height;  // 520
const TILE = 40;
const COLS = W / TILE;    // 20
const ROWS = H / TILE;    // 13

// ── UI elements ──────────────────────────────────────────────
const menuScreen   = document.getElementById('menuScreen');
const overScreen   = document.getElementById('overScreen');
const winScreen    = document.getElementById('winScreen');
const hud          = document.getElementById('hud');
const alertFlashDiv= document.getElementById('alertFlash');
const focusOverlay = document.getElementById('focusOverlay');
const hudLevel     = document.getElementById('hudLevel');
const hudStatus    = document.getElementById('hudStatus');
const hudGuards    = document.getElementById('hudGuards');
const hudTime      = document.getElementById('hudTime');

// ── Game state ───────────────────────────────────────────────
let state          = 'menu';
let currentLevelIdx= 1;
let startTime      = 0;
let elapsedMs      = 0;
let animFrame      = null;
let detectionAccum = 0;
let gameFocused    = false;
let spawnGrace     = 0;   // ms of invincibility after level load

// ── Player ───────────────────────────────────────────────────
const player = {
  x: 0, y: 0,
  w: 16, h: 16,
  speed: 3.2,
  crouching: false
};

// ── Level data ───────────────────────────────────────────────
let currentMap  = [];
let guardsList  = [];
let camerasList = [];
let exitCell    = { col: 0, row: 0 };

// ── Input – attach to WINDOW (not canvas) so keys always register ──
const keyState = new Set();

window.addEventListener('keydown', (e) => {
  const moveKeys = [
    'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
    'KeyW','KeyA','KeyS','KeyD',
    'ShiftLeft','ShiftRight','Space'
  ];
  if (moveKeys.includes(e.code)) {
    e.preventDefault();
  }
  keyState.add(e.code);

  // Hide focus overlay the moment any key is pressed during play
  if (state === 'play') {
    gameFocused = true;
    focusOverlay.classList.remove('visible');
  }
});

window.addEventListener('keyup', (e) => {
  keyState.delete(e.code);
});

// ── Helpers ──────────────────────────────────────────────────
function isSolidTile(col, row) {
  if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return true;
  const cell = currentMap[row]?.[col];
  return cell === 1 || cell === 2;
}

// FIX: was Math.flr (typo → crash) — now Math.floor
function canMoveTo(px, py) {
  const left   = Math.floor(px / TILE);
  const right  = Math.floor((px + player.w - 1) / TILE);
  const top    = Math.floor(py / TILE);          // ← was Math.flr (bug)
  const bottom = Math.floor((py + player.h - 1) / TILE);
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) {
      if (isSolidTile(c, r)) return false;
    }
  }
  return true;
}

function movePlayer(dtMult = 1.0) {
  let dx = 0, dy = 0;
  if (keyState.has('ArrowLeft')  || keyState.has('KeyA')) dx -= 1;
  if (keyState.has('ArrowRight') || keyState.has('KeyD')) dx += 1;
  if (keyState.has('ArrowUp')    || keyState.has('KeyW')) dy -= 1;
  if (keyState.has('ArrowDown')  || keyState.has('KeyS')) dy += 1;

  player.crouching = keyState.has('ShiftLeft') || keyState.has('ShiftRight');

  let moveSpeed = player.speed;
  if (player.crouching) moveSpeed *= 0.55;

  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
  }

  const step = moveSpeed * Math.min(1.0, dtMult);

  if (dx !== 0) {
    const newX = player.x + dx * step;
    if (canMoveTo(newX, player.y)) player.x = newX;
  }
  if (dy !== 0) {
    const newY = player.y + dy * step;
    if (canMoveTo(player.x, newY)) player.y = newY;
  }

  // safety clamp
  player.x = Math.min(Math.max(player.x, 2), W - player.w - 2);
  player.y = Math.min(Math.max(player.y, 2), H - player.h - 2);
}

function lineOfSightClear(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return true;
  const steps = Math.max(8, Math.ceil(distance / 8));
  for (let i = 1; i <= steps; i++) {
    const t  = i / steps;
    const cx = x1 + dx * t;
    const cy = y1 + dy * t;
    if (isSolidTile(Math.floor(cx / TILE), Math.floor(cy / TILE))) return false;
  }
  return true;
}

function isPlayerDetected(observer) {
  const px = player.x + player.w / 2;
  const py = player.y + player.h / 2;
  const dx = px - observer.x;
  const dy = py - observer.y;
  const dist = Math.hypot(dx, dy);
  let effectiveRange = observer.range;
  if (player.crouching) effectiveRange *= 0.68;
  if (dist > effectiveRange) return false;

  const angleToPlayer = Math.atan2(dy, dx);
  let diff = angleToPlayer - observer.angle;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) > observer.fov / 2) return false;

  return lineOfSightClear(observer.x, observer.y, px, py);
}

function updateWatchers() {
  const sweep = (list) => list.forEach(w => {
    w.angle += w.speed * w.dir;
    const delta = w.angle - w.baseAngle;
    if (Math.abs(delta) > w.sweep * 0.5) w.dir *= -1;
  });
  sweep(guardsList);
  sweep(camerasList);
}

function checkSpotted() {
  return [...guardsList, ...camerasList].some(t => isPlayerDetected(t));
}

function checkExitReached() {
  const ex = exitCell.col * TILE + 4;
  const ey = exitCell.row * TILE + 4;
  const ew = TILE - 8, eh = TILE - 8;
  return (
    player.x < ex + ew && player.x + player.w > ex &&
    player.y < ey + eh && player.y + player.h > ey
  );
}

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// ── Level definitions ─────────────────────────────────────────
const LEVELS_DATA = [
  {
    map: [
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1],
      [1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1],
      [1,0,0,2,2,0,0,0,0,0,1,1,0,0,0,2,0,0,0,1],
      [1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,2,0,0,0,1],
      [1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,1],
      [1,1,0,0,1,1,1,0,0,0,1,0,0,1,1,1,1,0,0,1],
      [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1],
      [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
      [1,0,2,2,0,0,0,0,0,0,0,0,0,2,2,0,0,0,0,1],
      [1,0,0,0,0,1,1,1,0,0,0,1,1,0,0,0,0,0,0,1],
      [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    ],
    start: [1, 1], exit: [18, 11],
    guards: [
      { col:10, row:2,  angle: Math.PI/2,  fov:0.98, range:150, speed:0.012, dir: 1, sweep:1.2 },
      { col:5,  row:8,  angle: 0,           fov:0.98, range:145, speed:0.014, dir:-1, sweep:1.2 },
      { col:15, row:6,  angle: Math.PI,     fov:0.98, range:148, speed:0.013, dir: 1, sweep:1.2 },
    ],
    cameras: [
      { col:18, row:1,  angle: Math.PI,     fov:0.7,  range:170, speed:0.008, dir: 1, sweep:1.1 }
    ]
  },
  {
    map: [
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,1],
      [1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,1],
      [1,0,2,0,0,0,0,0,1,0,0,1,0,0,0,0,0,2,0,1],
      [1,0,2,0,0,0,0,0,1,0,0,1,0,0,0,0,0,2,0,1],
      [1,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,1],
      [1,1,1,0,1,1,0,0,0,2,2,0,0,0,1,1,0,1,1,1],
      [1,0,0,0,0,1,0,0,0,2,2,0,0,0,1,0,0,0,0,1],
      [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
      [1,0,2,0,0,0,1,0,0,0,0,0,1,0,0,0,2,0,0,1],
      [1,0,2,0,0,0,1,0,0,0,0,0,1,0,0,0,2,0,0,1],
      [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    ],
    start: [3, 11], exit: [18, 11],
    guards: [
      { col:9,  row:2,  angle: Math.PI/2,  fov:0.95, range:155, speed:0.017, dir: 1, sweep:1.3 },
      { col:3,  row:8,  angle: 0,           fov:0.95, range:150, speed:0.019, dir:-1, sweep:1.2 },
      { col:16, row:8,  angle: Math.PI,    fov:0.95, range:150, speed:0.018, dir: 1, sweep:1.2 },
      { col:9,  row:10, angle:-Math.PI/2,  fov:0.95, range:145, speed:0.016, dir:-1, sweep:1.2 },
    ],
    cameras: [
      { col:1,  row:1,  angle: Math.PI/4,  fov:0.65, range:190, speed:0.011, dir: 1, sweep:1.15 },
      { col:18, row:6,  angle: Math.PI,    fov:0.65, range:190, speed:0.010, dir:-1, sweep:1.15 }
    ]
  },
  {
    map: [
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1],
      [1,0,0,0,1,0,0,2,0,0,0,0,2,0,0,1,0,0,0,1],
      [1,0,0,0,0,0,0,2,0,0,0,0,2,0,0,0,0,0,0,1],
      [1,1,1,0,1,0,0,0,0,0,0,0,0,0,0,1,0,1,1,1],
      [1,0,0,0,1,0,0,0,0,2,2,0,0,0,0,1,0,0,0,1],
      [1,0,0,0,0,0,0,0,0,2,2,0,0,0,0,0,0,0,0,1],
      [1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1],
      [1,1,1,0,1,1,0,0,0,0,0,0,0,1,1,1,0,1,1,1],
      [1,0,0,0,0,0,0,0,2,0,0,2,0,0,0,0,0,0,0,1],
      [1,0,0,0,0,0,0,0,2,0,0,2,0,0,0,0,0,0,0,1],
      [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    ],
    start: [1, 11], exit: [18, 11],
    guards: [
      { col:9,  row:2,  angle: Math.PI/2,  fov:0.96, range:160, speed:0.022, dir: 1, sweep:1.2 },
      { col:3,  row:6,  angle: 0,           fov:0.96, range:155, speed:0.023, dir:-1, sweep:1.2 },
      { col:16, row:5,  angle: Math.PI,    fov:0.96, range:155, speed:0.022, dir: 1, sweep:1.2 },
      { col:9,  row:9,  angle:-Math.PI/2,  fov:0.96, range:158, speed:0.020, dir:-1, sweep:1.3 },
      { col:6,  row:11, angle: 0,           fov:0.92, range:148, speed:0.024, dir: 1, sweep:1.1 },
    ],
    cameras: [
      { col:1,  row:1,  angle: Math.PI/2,  fov:0.7,  range:195, speed:0.012, dir: 1, sweep:1.2 },
      { col:18, row:1,  angle: Math.PI,    fov:0.7,  range:195, speed:0.011, dir:-1, sweep:1.2 },
      { col:10, row:6,  angle:-Math.PI/2,  fov:0.68, range:190, speed:0.012, dir: 1, sweep:1.2 }
    ]
  }
];

// ── Load level ────────────────────────────────────────────────
function loadLevel(levelNumber) {
  const idx      = (levelNumber - 1) % LEVELS_DATA.length;
  const levelDef = LEVELS_DATA[idx];

  currentMap = levelDef.map.map(row => [...row]);

  const startCol = levelDef.start[0];
  const startRow = levelDef.start[1];
  player.x = startCol * TILE + (TILE / 2) - player.w / 2;
  player.y = startRow * TILE + (TILE / 2) - player.h / 2;
  player.crouching = false;

  exitCell = { col: levelDef.exit[0], row: levelDef.exit[1] };

  guardsList = levelDef.guards.map(g => ({
    x: g.col * TILE + TILE / 2,
    y: g.row * TILE + TILE / 2,
    baseAngle: g.angle, angle: g.angle,
    fov: g.fov, range: g.range,
    speed: g.speed, dir: g.dir, sweep: g.sweep || 1.2
  }));

  camerasList = levelDef.cameras.map(c => ({
    x: c.col * TILE + TILE / 2,
    y: c.row * TILE + TILE / 2,
    baseAngle: c.angle, angle: c.angle,
    fov: c.fov, range: c.range,
    speed: c.speed, dir: c.dir, sweep: c.sweep || 1.1
  }));
}

// ── Draw ──────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#060d14';
  ctx.fillRect(0, 0, W, H);

  // tiles
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const cell = currentMap[row][col];
      const x = col * TILE, y = row * TILE;
      if (cell === 1) {
        ctx.fillStyle = '#0d1f2c';
        ctx.fillRect(x, y, TILE, TILE);
        ctx.strokeStyle = '#1a3a48';
        ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
        ctx.fillStyle = 'rgba(0,200,100,0.05)';
        ctx.fillRect(x, y, TILE, 2);
      } else if (cell === 2) {
        ctx.fillStyle = '#0e2330';
        ctx.fillRect(x, y, TILE, TILE);
        ctx.fillStyle = '#1f4055';
        ctx.fillRect(x + 4, y + 4, TILE - 8, TILE - 8);
        ctx.strokeStyle = '#2c5a70';
        ctx.strokeRect(x + 4.5, y + 4.5, TILE - 9, TILE - 9);
      } else {
        ctx.strokeStyle = 'rgba(0,140,80,0.07)';
        ctx.strokeRect(x, y, TILE, TILE);
      }
    }
  }

  // exit marker
  const exX   = exitCell.col * TILE, exY = exitCell.row * TILE;
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 380);
  ctx.fillStyle = `rgba(0,255,136,${0.1 + pulse * 0.15})`;
  ctx.fillRect(exX, exY, TILE, TILE);
  ctx.strokeStyle = 'rgba(0,255,136,0.7)';
  ctx.lineWidth = 2;
  ctx.strokeRect(exX + 3, exY + 3, TILE - 6, TILE - 6);
  ctx.fillStyle = '#ccff88';
  ctx.font = 'bold 11px "Share Tech Mono"';
  ctx.textAlign = 'center';
  ctx.fillText('EXIT', exX + TILE / 2, exY + TILE / 2 + 4);

  // detection cones
  [...guardsList, ...camerasList].forEach(w => {
    const detecting = isPlayerDetected(w);
    const alpha     = detecting ? 0.55 : 0.20;
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, w.range, w.angle - w.fov / 2, w.angle + w.fov / 2);
    ctx.closePath();
    ctx.fillStyle   = detecting ? `rgba(255,40,70,${alpha})` : `rgba(255,210,0,${alpha})`;
    ctx.fill();
    ctx.strokeStyle = detecting ? '#ff5577' : '#ffaa33';
    ctx.lineWidth   = 1.2;
    ctx.stroke();
    ctx.restore();
  });

  // guards
  guardsList.forEach(g => {
    const spotted = isPlayerDetected(g);
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#10222e'; ctx.fill();
    ctx.strokeStyle = spotted ? '#ff3366' : '#ffaa44';
    ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(g.angle) * 12, Math.sin(g.angle) * 12);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(Math.cos(g.angle) * 5, Math.sin(g.angle) * 5, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffaa55'; ctx.fill();
    ctx.restore();
  });

  // cameras
  camerasList.forEach(c => {
    const spotted = isPlayerDetected(c);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.fillStyle = '#1f3545';
    ctx.fillRect(-8, -5, 14, 10);
    ctx.strokeStyle = '#44ddff';
    ctx.strokeRect(-8, -5, 14, 10);
    ctx.beginPath(); ctx.arc(6, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#030b10'; ctx.fill();
    ctx.beginPath(); ctx.arc(6, 0, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = spotted ? '#ff3366' : '#22ccff'; ctx.fill();
    ctx.restore();
  });

  // player
  const px = player.x + player.w / 2;
  const py = player.y + player.h / 2;
  ctx.beginPath();
  if (player.crouching) {
    ctx.ellipse(px, py, 8, 5, 0, 0, Math.PI * 2);
  } else {
    ctx.arc(px, py, 9, 0, Math.PI * 2);
  }
  ctx.fillStyle = '#001f14'; ctx.fill();
  ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2.2; ctx.stroke();
  ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#00ff88'; ctx.fill();
  if (player.crouching) {
    ctx.fillStyle = '#88ffaa';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('CROUCH', px, py - 13);
  }
}

// ── Game loop ─────────────────────────────────────────────────
let lastTimestamp = 0;

function gameUpdate(now) {
  if (state !== 'play') return;
  if (!lastTimestamp) lastTimestamp = now;

  let dt = Math.min(0.033, (now - lastTimestamp) / 1000);
  if (dt <= 0) dt = 0.016;
  lastTimestamp = now;
  elapsedMs = now - startTime;

  hudTime.textContent   = formatTime(elapsedMs);
  hudLevel.textContent  = String(currentLevelIdx).padStart(2, '0');
  hudGuards.textContent = guardsList.length + camerasList.length;

  movePlayer(dt * 60);
  updateWatchers();

  if (spawnGrace > 0) spawnGrace -= dt * 1000;
  const spottedNow = spawnGrace > 0 ? false : checkSpotted();
  if (spottedNow) {
    detectionAccum += 1;
    hudStatus.textContent  = '!!! ALERT !!!';
    hudStatus.style.color  = '#ff3366';
    alertFlashDiv.style.display = 'block';
    if (detectionAccum > 14) { triggerGameOver(); return; }
  } else {
    detectionAccum = Math.max(0, detectionAccum - 0.5);
    if (detectionAccum <= 0) {
      hudStatus.textContent = 'CLEAR';
      hudStatus.style.color = '#00ff88';
      alertFlashDiv.style.display = 'none';
    }
  }

  if (checkExitReached()) { triggerWin(); return; }

  draw();
  animFrame = requestAnimationFrame(gameUpdate);
}

// ── Screen transitions ────────────────────────────────────────
function triggerGameOver() {
  state = 'over';
  cancelAnimationFrame(animFrame);
  document.getElementById('overTime').textContent  = formatTime(elapsedMs);
  document.getElementById('overLevel').textContent = currentLevelIdx;
  alertFlashDiv.style.display = 'none';
  focusOverlay.classList.remove('visible');
  canvas.classList.remove('active');
  hud.classList.remove('active');
  overScreen.classList.add('active');
  lastTimestamp = 0;
}

function triggerWin() {
  state = 'win';
  cancelAnimationFrame(animFrame);
  document.getElementById('winTime').textContent   = formatTime(elapsedMs);
  document.getElementById('winLevels').textContent = currentLevelIdx;
  alertFlashDiv.style.display = 'none';
  focusOverlay.classList.remove('visible');
  canvas.classList.remove('active');
  hud.classList.remove('active');
  document.getElementById('nextBtn').style.display =
    currentLevelIdx >= LEVELS_DATA.length ? 'none' : '';
  winScreen.classList.add('active');
  lastTimestamp = 0;
}

function hideAllScreens() {
  menuScreen.classList.remove('active');
  overScreen.classList.remove('active');
  winScreen.classList.remove('active');
}

function startGame(levelNum) {
  currentLevelIdx = levelNum;
  hideAllScreens();
  canvas.classList.add('active');
  hud.classList.add('active');
  loadLevel(currentLevelIdx);
  state          = 'play';
  detectionAccum = 0;
  spawnGrace     = 1200;  // 1.2 s of invincibility on spawn
  gameFocused    = false;
  startTime      = performance.now();
  elapsedMs      = 0;
  alertFlashDiv.style.display = 'none';
  if (animFrame) cancelAnimationFrame(animFrame);
  lastTimestamp = 0;

  // Show focus overlay — disappears on first key press (handled in keydown)
  focusOverlay.classList.add('visible');

  animFrame = requestAnimationFrame(gameUpdate);
}

function goToMenu() {
  state = 'menu';
  cancelAnimationFrame(animFrame);
  canvas.classList.remove('active');
  hud.classList.remove('active');
  alertFlashDiv.style.display = 'none';
  focusOverlay.classList.remove('visible');
  hideAllScreens();
  menuScreen.classList.add('active');
}

// ── Button wiring ─────────────────────────────────────────────
document.getElementById('startBtn').addEventListener('click',  () => startGame(1));
document.getElementById('retryBtn').addEventListener('click',  () => startGame(currentLevelIdx));
document.getElementById('nextBtn').addEventListener('click',   () => {
  if (currentLevelIdx < LEVELS_DATA.length) startGame(currentLevelIdx + 1);
});
document.getElementById('menuBtn1').addEventListener('click',  goToMenu);
document.getElementById('menuBtn2').addEventListener('click',  goToMenu);

// Clicking the canvas or overlay dismisses the focus prompt
canvas.addEventListener('click', () => {
  if (state === 'play') {
    gameFocused = true;
    focusOverlay.classList.remove('visible');
  }
});
focusOverlay.addEventListener('click', () => {
  gameFocused = true;
  focusOverlay.classList.remove('visible');
});

console.log('✅ Phantom Break loaded — press any movement key to play!');