'use strict';

/* global io */

// ===========================================================================
// Socket + shared state
// ===========================================================================

const socket = io();

const state = {
  myId: null,
  myName: null,
  roomCode: null,
  hostId: null,
  arena: null,        // { world, obstacles, playerRadius, killsToWin, colors:Map }
  colors: new Map(),  // playerId -> color (from roster)
  // Snapshot buffer for interpolation.
  prev: null,         // { t, players:Map, bullets, scores }
  curr: null,
  recvPrev: 0,        // client-clock time we received prev
  recvCurr: 0,
  scoreboardOpen: false,
  pendingInvite: null,
  // Local-player damage feedback.
  myHp: 100,
  myAlive: true,         // tracks alive<->dead transitions for death/respawn sfx
  damageFlashUntil: 0,   // performance.now() timestamp the red vignette fades out
  damageFlashStrength: 0,
  // Muzzle flashes: short-lived gunfire bursts at a shooter's barrel, spawned
  // when a new bullet id first appears in a snapshot.
  muzzleFlashes: [],     // { x, y, born, color }
  // Bullet impacts: short-lived sparks where a bullet was removed (hit a wall,
  // obstacle, or player). Detected when a bullet id disappears from the snapshot.
  impacts: [],           // { x, y, dx, dy, born, color }
  bulletDir: new Map(),  // bullet id -> { dx, dy } unit travel direction
  // Hit markers: brief crosshair X drawn at the aim point when one of the local
  // player's bullets damages an enemy (server-confirmed, since the client can't
  // tell a non-lethal hit apart from a bullet that hit cover).
  hitMarkers: [],        // { born, killed }
};

// ===========================================================================
// DOM helpers
// ===========================================================================

const $ = (id) => document.getElementById(id);
const screens = {
  home: $('screen-home'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('active', key === name);
  }
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function ensureRegistered() {
  if (state.myId) return true;
  const name = $('name-input').value.trim();
  socket.emit('register', { name });
  return false;
}

// ===========================================================================
// Home screen
// ===========================================================================

$('name-input').addEventListener('input', () => {
  // Re-register with the new name if we already have an id and are not in a room.
  state.pendingName = $('name-input').value.trim();
});

$('btn-create').addEventListener('click', () => {
  if (!ensureRegistered()) { pendingAction = () => socket.emit('createRoom'); return; }
  socket.emit('createRoom');
});

$('btn-join').addEventListener('click', joinFromInput);
$('join-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput(); });

function joinFromInput() {
  const code = $('join-code-input').value.trim().toUpperCase();
  if (!code) { toast('Enter a room code.'); return; }
  if (!ensureRegistered()) { pendingAction = () => socket.emit('joinRoom', { code }); return; }
  socket.emit('joinRoom', { code });
}

let pendingAction = null;

// ===========================================================================
// Lobby screen
// ===========================================================================

$('btn-copy').addEventListener('click', async () => {
  if (!state.roomCode) return;
  try {
    await navigator.clipboard.writeText(state.roomCode);
    const b = $('btn-copy');
    b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = 'Copy'; }, 1200);
  } catch {
    toast('Copy failed - select the code manually.');
  }
});

$('btn-invite').addEventListener('click', sendInvite);
$('invite-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendInvite(); });

function sendInvite() {
  const target = $('invite-input').value.trim().toUpperCase();
  if (!target) return;
  socket.emit('invitePlayer', { playerId: target });
  setInviteStatus('Sending invite to ' + target + '...', '');
}

function setInviteStatus(msg, kind) {
  const el = $('invite-status');
  el.textContent = msg;
  el.className = 'invite-status' + (kind ? ' ' + kind : '');
}

$('btn-start').addEventListener('click', () => socket.emit('startGame'));
$('btn-leave').addEventListener('click', leaveRoom);
$('btn-quit').addEventListener('click', leaveRoom);

function leaveRoom() {
  socket.emit('leaveRoom');
  resetGameState();
  showScreen('home');
}

// ===========================================================================
// Invite popup
// ===========================================================================

$('btn-accept').addEventListener('click', () => {
  if (!state.pendingInvite) return;
  socket.emit('inviteResponse', { accepted: true, code: state.pendingInvite.code });
  $('invite-popup').hidden = true;
  state.pendingInvite = null;
});
$('btn-decline').addEventListener('click', () => {
  if (!state.pendingInvite) return;
  socket.emit('inviteResponse', { accepted: false, code: state.pendingInvite.code });
  $('invite-popup').hidden = true;
  state.pendingInvite = null;
});

// ===========================================================================
// Game over overlay
// ===========================================================================

$('btn-back-lobby').addEventListener('click', () => {
  $('gameover').hidden = true;
  showScreen('lobby');
});

// ===========================================================================
// Socket event handlers
// ===========================================================================

socket.on('registered', (data) => {
  state.myId = data.playerId;
  state.myName = data.name;
  $('my-id').textContent = data.playerId;
  $('lobby-my-id').textContent = data.playerId;
  $('you-are').hidden = false;
  if (pendingAction) { pendingAction(); pendingAction = null; }
});

socket.on('roomUpdate', (room) => {
  state.roomCode = room.code;
  state.hostId = room.hostId;
  state.colors = new Map(room.players.map((p) => [p.id, p.color]));

  $('room-code').textContent = room.code;
  $('player-count').textContent = `(${room.players.length}/${room.maxPlayers})`;

  const roster = $('roster');
  roster.innerHTML = '';
  for (const p of room.players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    li.appendChild(dot);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name + (p.id === state.myId ? ' (you)' : '');
    li.appendChild(nameSpan);

    if (p.isHost) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'Host';
      li.appendChild(badge);
    }
    roster.appendChild(li);
  }

  const amHost = room.hostId === state.myId;
  $('invite-col').style.display = amHost ? '' : 'none';
  const startBtn = $('btn-start');
  startBtn.style.display = amHost ? '' : 'none';
  startBtn.disabled = !room.canStart;
  $('lobby-note').textContent = amHost
    ? (room.canStart ? '' : 'Need at least 2 players to start.')
    : 'Waiting for the host to start the match...';

  // If a match ended we may still be sitting on the game screen; return to lobby.
  if (room.state === 'lobby' && screens.game.classList.contains('active') && $('gameover').hidden) {
    showScreen('lobby');
  } else if (!screens.game.classList.contains('active')) {
    showScreen('lobby');
  }
});

socket.on('inviteReceived', (data) => {
  state.pendingInvite = data;
  $('invite-text').innerHTML = `<strong>${escapeHtml(data.hostName)}</strong> invited you to room <strong>${data.code}</strong>.`;
  $('invite-popup').hidden = false;
});

socket.on('inviteResult', (res) => {
  switch (res.status) {
    case 'sent': setInviteStatus(`Invite sent to ${res.targetName || res.targetId}.`, 'ok'); break;
    case 'accepted': setInviteStatus(`${res.targetName} accepted!`, 'ok'); break;
    case 'declined': setInviteStatus(`${res.targetName} declined.`, 'err'); break;
    case 'notfound': setInviteStatus(`No online player with ID ${res.targetId}.`, 'err'); break;
    default: setInviteStatus(res.message || 'Invite failed.', 'err');
  }
});

socket.on('gameStarted', (data) => {
  state.arena = data;
  state.colors = new Map(data.players.map((p) => [p.id, p.color]));
  state.prev = null;
  state.curr = null;
  state.myHp = 100;
  state.myAlive = true;
  state.damageFlashUntil = 0;
  state.muzzleFlashes.length = 0;
  state.impacts.length = 0;
  state.bulletDir.clear();
  state.hitMarkers.length = 0;
  $('gameover').hidden = true;
  $('scoreboard').hidden = true;
  $('health-hud').hidden = true;
  $('hp-fill').style.width = '100%';
  $('hp-fill').style.background = '#69f0ae';
  $('hp-value').textContent = '100';
  state.scoreboardOpen = false;
  showScreen('game');
  resizeCanvas();
});

socket.on('state', (snap) => {
  state.prev = state.curr;
  state.recvPrev = state.recvCurr;
  state.curr = {
    t: snap.t,
    players: new Map(snap.players.map((p) => [p.id, p])),
    bullets: snap.bullets,
    scores: snap.scores,
  };
  state.recvCurr = performance.now();

  // Muzzle flash: any bullet id present now but not in the previous snapshot was
  // just fired, so burst a flash at the shooter's barrel tip.
  const prevIds = state.prev ? new Set(state.prev.bullets.map((b) => b.id)) : new Set();
  const radius = state.arena ? state.arena.playerRadius : 18;
  const listener = state.curr.players.get(state.myId);
  for (const b of snap.bullets) {
    if (prevIds.has(b.id)) continue;
    const owner = state.curr.players.get(b.ownerId);
    if (!owner) continue;
    state.muzzleFlashes.push({
      x: owner.x + Math.cos(owner.angle) * (radius + 10),
      y: owner.y + Math.sin(owner.angle) * (radius + 10),
      born: state.recvCurr,
      color: state.colors.get(b.ownerId) || '#ffd740',
    });
    // Gunfire sound: full volume for your own shots, distance-attenuated for others.
    if (b.ownerId === state.myId) {
      sfxShoot(1);
    } else if (listener) {
      const dist = Math.hypot(owner.x - listener.x, owner.y - listener.y);
      const vol = 1 - dist / 1400;
      if (vol > 0.06) sfxShoot(vol * 0.7);
    }
  }
  if (state.muzzleFlashes.length > 40) state.muzzleFlashes.splice(0, state.muzzleFlashes.length - 40);

  // Bullet impacts: track each bullet's travel direction across snapshots, then
  // when an id disappears (bullets are only ever removed by hitting a wall,
  // obstacle, or player) spawn a spark burst at its last position, sprayed back
  // against its travel direction.
  const currBullets = new Map();
  for (const b of snap.bullets) currBullets.set(b.id, b);
  const prevBulletMap = new Map();
  if (state.prev) for (const pb of state.prev.bullets) prevBulletMap.set(pb.id, pb);
  // Update stored directions for bullets seen in both snapshots.
  for (const [id, b] of currBullets) {
    const pb = prevBulletMap.get(id);
    if (!pb) continue;
    const dx = b.x - pb.x;
    const dy = b.y - pb.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.5) state.bulletDir.set(id, { dx: dx / d, dy: dy / d });
  }
  // Any bullet in the previous snapshot but gone now hit something.
  for (const [id, pb] of prevBulletMap) {
    if (currBullets.has(id)) continue;
    let dir = state.bulletDir.get(id);
    if (!dir) {
      // Bullet lived less than two snapshots, so fall back to the shooter's aim.
      const owner = state.curr.players.get(pb.ownerId);
      dir = owner ? { dx: Math.cos(owner.angle), dy: Math.sin(owner.angle) } : { dx: 0, dy: 0 };
    }
    state.impacts.push({
      // Nudge the spark forward toward the real collision point, which is ~1
      // snapshot ahead of the last position we saw the bullet at.
      x: pb.x + dir.dx * 8,
      y: pb.y + dir.dy * 8,
      dx: dir.dx,
      dy: dir.dy,
      born: state.recvCurr,
      color: state.colors.get(pb.ownerId) || '#ffd740',
    });
    state.bulletDir.delete(id);
  }
  if (state.impacts.length > 40) state.impacts.splice(0, state.impacts.length - 40);

  // Trigger a red damage vignette when the local player's health drops.
  const me = state.curr.players.get(state.myId);
  if (me) {
    if (me.alive && me.hp < state.myHp) {
      const dmg = state.myHp - me.hp;
      state.damageFlashUntil = performance.now() + 450;
      state.damageFlashStrength = Math.min(0.6, 0.28 + (dmg / 100) * 0.5);
      sfxHurt();
    }
    // Death / respawn transitions get their own audio cues.
    if (state.myAlive && !me.alive) sfxDeath();
    else if (!state.myAlive && me.alive) sfxRespawn();
    state.myAlive = me.alive;
    // Reset the baseline to full while dead so respawning back to 100 HP never flashes.
    state.myHp = me.alive ? me.hp : 100;
    updateHealthHud(me);
  }

  updateScoreStrip(snap.scores);
  updateScoreboard(snap.scores);
});

function updateHealthHud(me) {
  const hp = Math.max(0, Math.min(100, Math.round(me.hp)));
  const frac = hp / 100;
  $('hp-fill').style.width = frac * 100 + '%';
  $('hp-fill').style.background = frac > 0.5 ? '#69f0ae' : frac > 0.25 ? '#ffd740' : '#ff5252';
  $('hp-value').textContent = hp;
}

socket.on('killFeed', (data) => {
  const feed = $('kill-feed');
  const div = document.createElement('div');
  div.className = 'kf';
  div.innerHTML = `<b>${escapeHtml(data.killer)}</b> eliminated <span class="v">${escapeHtml(data.victim)}</span>`;
  feed.appendChild(div);
  setTimeout(() => div.remove(), 4000);
  while (feed.children.length > 5) feed.removeChild(feed.firstChild);
  // Reward the local player with a confirm tone for their own eliminations.
  if (state.myName && data.killer === state.myName && data.victim !== state.myName) sfxKill();
});

socket.on('gameOver', (data) => {
  $('winner-line').textContent = `${data.winner.name} wins!`;
  const body = $('standings-body');
  body.innerHTML = '';
  data.standings.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td>`;
    body.appendChild(tr);
  });
  $('gameover').hidden = false;
});

socket.on('hitConfirm', (data) => {
  state.hitMarkers.push({ born: performance.now(), killed: !!(data && data.killed) });
  if (state.hitMarkers.length > 12) state.hitMarkers.splice(0, state.hitMarkers.length - 12);
  sfxHit(!!(data && data.killed));
});

socket.on('errorMsg', (data) => toast(data.message || 'Something went wrong.'));

socket.on('disconnect', () => {
  toast('Disconnected from server.');
});

// ===========================================================================
// HUD updates
// ===========================================================================

function updateScoreStrip(scores) {
  const strip = $('score-strip');
  strip.innerHTML = '';
  const target = state.arena && state.arena.killsToWin;
  const leaderKills = scores.length ? Math.max(...scores.map((s) => s.kills)) : 0;
  // Match point: the leader is a single kill away from winning the match.
  const matchPoint = !!target && leaderKills >= target - 1 && leaderKills < target;

  for (const s of scores) {
    const div = document.createElement('div');
    // Mark whoever currently leads so the frag race is readable at a glance.
    const isLeader = !!target && leaderKills > 0 && s.kills === leaderKills;
    div.className = 's' + (isLeader ? ' leader' : '');
    div.innerHTML = `<span class="dot" style="background:${s.color}"></span>${s.kills}`;
    div.title = `${s.name}: ${s.kills} kills / ${s.deaths} deaths`;
    strip.appendChild(div);
  }

  // Frag-limit chip so players always see the win target and feel the tension as
  // the leader closes in (the server sends killsToWin but nothing showed it).
  if (target) {
    const goal = document.createElement('div');
    goal.className = 'goal' + (matchPoint ? ' match-point' : '');
    goal.textContent = matchPoint ? `MATCH POINT ${leaderKills}/${target}` : `/ ${target}`;
    strip.appendChild(goal);
  }
}

function updateScoreboard(scores) {
  const body = $('sb-body');
  body.innerHTML = '';
  for (const s of scores) {
    const tr = document.createElement('tr');
    const you = s.id === state.myId ? ' (you)' : '';
    tr.innerHTML =
      `<td><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.color};margin-right:6px"></span>${escapeHtml(s.name)}${you}</td>` +
      `<td>${s.kills}</td><td>${s.deaths}</td>`;
    body.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===========================================================================
// Input capture
// ===========================================================================

const input = { up: false, down: false, left: false, right: false, angle: 0, shooting: false };
const mouse = { x: 0, y: 0 };

const keyMap = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

window.addEventListener('keydown', (e) => {
  if (!screens.game.classList.contains('active')) return;
  if (e.code === 'Tab') { e.preventDefault(); toggleScoreboard(true); return; }
  if (keyMap[e.code]) { input[keyMap[e.code]] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') { toggleScoreboard(false); return; }
  if (keyMap[e.code]) { input[keyMap[e.code]] = false; }
});

function toggleScoreboard(open) {
  state.scoreboardOpen = open;
  $('scoreboard').hidden = !open;
}

const canvas = $('game-canvas');

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
});
canvas.addEventListener('mousedown', (e) => { if (e.button === 0) input.shooting = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) input.shooting = false; });
window.addEventListener('blur', () => {
  input.up = input.down = input.left = input.right = input.shooting = false;
});

// Send input to the server at a fixed rate.
setInterval(() => {
  if (!state.arena || !screens.game.classList.contains('active')) return;
  input.angle = aimAngle();
  socket.emit('input', input);
}, 1000 / 30);

// ===========================================================================
// Audio: synthesized combat sound effects (Web Audio, no assets)
// ===========================================================================

const audio = { ctx: null, master: null, muted: false };

function initAudio() {
  if (audio.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audio.ctx = new AC();
  audio.master = audio.ctx.createGain();
  audio.master.gain.value = audio.muted ? 0 : 0.5;
  audio.master.connect(audio.ctx.destination);
}

// Browsers block audio until a user gesture; create/resume the context on the
// first interaction so the first shot is audible.
function resumeAudio() {
  if (!audio.ctx) initAudio();
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
}
window.addEventListener('pointerdown', resumeAudio);
window.addEventListener('keydown', resumeAudio);

// A single decaying oscillator note - the building block for every cue.
function tone({ type = 'square', freq = 440, freqEnd = null, dur = 0.1, gain = 0.3, delay = 0 }) {
  if (!audio.ctx || audio.muted) return;
  const ctx = audio.ctx;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd && freqEnd !== freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(audio.master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function sfxShoot(vol) {
  tone({ type: 'square', freq: 720, freqEnd: 240, dur: 0.09, gain: 0.16 * vol });
}
function sfxHurt() {
  tone({ type: 'sawtooth', freq: 220, freqEnd: 90, dur: 0.16, gain: 0.28 });
}
function sfxHit(killed) {
  // A crisp tick that confirms a shot landed; a touch higher/brighter on a kill.
  tone({ type: 'square', freq: killed ? 1320 : 1040, dur: 0.05, gain: 0.18 });
}
function sfxKill() {
  tone({ type: 'square', freq: 660, dur: 0.08, gain: 0.22 });
  tone({ type: 'square', freq: 990, dur: 0.12, gain: 0.22, delay: 0.08 });
}
function sfxDeath() {
  tone({ type: 'sawtooth', freq: 300, freqEnd: 70, dur: 0.5, gain: 0.3 });
}
function sfxRespawn() {
  tone({ type: 'triangle', freq: 440, freqEnd: 880, dur: 0.18, gain: 0.22 });
}

function setMuted(muted) {
  audio.muted = muted;
  if (audio.master) audio.master.gain.value = muted ? 0 : 0.5;
  const btn = $('btn-mute');
  btn.classList.toggle('muted', muted);
  btn.setAttribute('aria-pressed', String(muted));
  btn.title = muted ? 'Unmute sound (M)' : 'Mute sound (M)';
  btn.innerHTML = muted ? '&#128263;' : '&#128266;';
}

$('btn-mute').addEventListener('click', () => setMuted(!audio.muted));
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && screens.game.classList.contains('active')) setMuted(!audio.muted);
});

// ===========================================================================
// Rendering
// ===========================================================================

const ctx = canvas.getContext('2d');
const camera = { x: 0, y: 0 };

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

function localPlayerRender() {
  // Position of the local player from the newest snapshot (no interp needed for self aim).
  if (!state.curr) return null;
  return state.curr.players.get(state.myId) || null;
}

function aimAngle() {
  const me = localPlayerRender();
  if (!me) return input.angle;
  // Local player is drawn at screen center (camera follows), so aim from center to mouse.
  const vw = window.innerWidth, vh = window.innerHeight;
  const cx = me.x - camera.x, cy = me.y - camera.y;
  // Guard: if camera not yet set, fall back to screen center.
  const px = Number.isFinite(cx) ? cx : vw / 2;
  const py = Number.isFinite(cy) ? cy : vh / 2;
  return Math.atan2(mouse.y - py, mouse.x - px);
}

function interpFactor() {
  // Interpolate between prev and curr snapshots using client clock, with a small delay.
  if (!state.prev || !state.curr) return 1;
  const dt = state.recvCurr - state.recvPrev;
  if (dt <= 0) return 1;
  const elapsed = performance.now() - state.recvCurr;
  return Math.min(1.2, elapsed / dt); // allow slight extrapolation
}

function lerp(a, b, t) { return a + (b - a) * t; }

function playerRenderPos(id) {
  const c = state.curr && state.curr.players.get(id);
  if (!c) return null;
  const p = state.prev && state.prev.players.get(id);
  if (!p) return { x: c.x, y: c.y, angle: c.angle, hp: c.hp, alive: c.alive, respawnIn: c.respawnIn };
  const t = interpFactor();
  return {
    x: lerp(p.x, c.x, t),
    y: lerp(p.y, c.y, t),
    angle: c.angle,
    hp: c.hp,
    alive: c.alive,
    respawnIn: c.respawnIn,
  };
}

function draw() {
  requestAnimationFrame(draw);
  if (!state.arena || !screens.game.classList.contains('active')) return;

  const { world, obstacles, playerRadius } = state.arena;
  const vw = window.innerWidth, vh = window.innerHeight;

  // Camera follows local player, clamped to arena.
  const me = playerRenderPos(state.myId);
  if (me) {
    camera.x = clampCam(me.x - vw / 2, world.width - vw);
    camera.y = clampCam(me.y - vh / 2, world.height - vh);
  }

  ctx.clearRect(0, 0, vw, vh);

  // Background
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, vw, vh);

  drawGrid(world);

  // Arena border
  ctx.strokeStyle = '#2b3441';
  ctx.lineWidth = 4;
  ctx.strokeRect(-camera.x, -camera.y, world.width, world.height);

  // Obstacles
  for (const o of obstacles) {
    ctx.fillStyle = '#232c38';
    ctx.strokeStyle = '#39465a';
    ctx.lineWidth = 2;
    ctx.fillRect(o.x - camera.x, o.y - camera.y, o.w, o.h);
    ctx.strokeRect(o.x - camera.x, o.y - camera.y, o.w, o.h);
  }

  // Bullets: interpolate each bullet's head between snapshots (matched by id) and
  // draw a short tracer streak behind it so fast projectiles read smoothly at 60fps
  // instead of stuttering ~23px per 30Hz snapshot.
  if (state.curr) {
    const bt = interpFactor();
    const prevBullets = new Map();
    if (state.prev) for (const pb of state.prev.bullets) prevBullets.set(pb.id, pb);

    ctx.lineCap = 'round';
    for (const b of state.curr.bullets) {
      const color = state.colors.get(b.ownerId) || '#ffd740';
      const p = prevBullets.get(b.id);
      const hx = (p ? lerp(p.x, b.x, bt) : b.x) - camera.x;
      const hy = (p ? lerp(p.y, b.y, bt) : b.y) - camera.y;

      if (p) {
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.5) {
          const streak = Math.min(d, 26);
          const tx = hx - (dx / d) * streak;
          const ty = hy - (dy / d) * streak;
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

  // Players
  if (state.curr) {
    for (const id of state.curr.players.keys()) {
      const rp = playerRenderPos(id);
      if (!rp || !rp.alive) continue;
      drawPlayer(id, rp, playerRadius);
    }
  }

  // Bullet impact sparks where projectiles hit cover or players.
  drawImpacts();

  // Muzzle flashes: brief additive gunfire bursts at each shot's origin.
  drawMuzzleFlashes();

  // Hit markers at the aim point confirm the local player's shots landed.
  drawHitMarkers();

  // Edge-of-screen arrows pointing toward any alive enemy currently off-screen,
  // so a 1600x1200 arena that overflows the viewport stays legible - you can
  // always tell which way the fight is.
  drawOffscreenIndicators(vw, vh);

  // Damage vignette: red glow creeping in from the screen edges, fading out.
  const nowMs = performance.now();
  if (nowMs < state.damageFlashUntil) {
    const remain = (state.damageFlashUntil - nowMs) / 450;
    const alpha = state.damageFlashStrength * remain;
    const inner = Math.min(vw, vh) * 0.32;
    const outer = Math.hypot(vw, vh) * 0.62;
    const grad = ctx.createRadialGradient(vw / 2, vh / 2, inner, vw / 2, vh / 2, outer);
    grad.addColorStop(0, 'rgba(255,40,40,0)');
    grad.addColorStop(1, `rgba(210,20,20,${alpha.toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, vw, vh);
  }

  // Respawn overlay for local player
  if (me && !me.alive) {
    $('respawn-overlay').hidden = false;
    $('respawn-secs').textContent = me.respawnIn;
  } else {
    $('respawn-overlay').hidden = true;
  }

  // Health HUD is only meaningful while the local player is alive in the match.
  $('health-hud').hidden = !(me && me.alive);
}

const IMPACT_MS = 200;
function drawImpacts() {
  if (!state.impacts.length) return;
  const now = performance.now();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const kept = [];
  for (const f of state.impacts) {
    const age = now - f.born;
    if (age >= IMPACT_MS) continue;
    kept.push(f);
    const t = 1 - age / IMPACT_MS;      // 1 -> 0 over the spark lifetime
    const x = f.x - camera.x;
    const y = f.y - camera.y;
    // Small hot flash at the point of impact.
    const r = 3 + (1 - t) * 5;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,235,${(0.85 * t).toFixed(3)})`);
    grad.addColorStop(0.5, hexToRgba(f.color, 0.6 * t));
    grad.addColorStop(1, hexToRgba(f.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // A few spark shards spraying back against the bullet's travel direction.
    const base = Math.atan2(-f.dy, -f.dx);
    ctx.strokeStyle = hexToRgba(f.color, 0.8 * t);
    ctx.lineWidth = 1.5;
    for (let i = -1; i <= 1; i++) {
      const a = base + i * 0.55;
      const len = (7 + (1 - t) * 9) * (0.7 + Math.abs(i) * 0.3);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
  }
  ctx.lineCap = 'butt';
  ctx.restore();
  state.impacts = kept;
}

const MUZZLE_MS = 110;
function drawMuzzleFlashes() {
  if (!state.muzzleFlashes.length) return;
  const now = performance.now();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const kept = [];
  for (const f of state.muzzleFlashes) {
    const age = now - f.born;
    if (age >= MUZZLE_MS) continue;
    kept.push(f);
    const t = 1 - age / MUZZLE_MS;   // 1 -> 0 over the flash lifetime
    const x = f.x - camera.x;
    const y = f.y - camera.y;
    const r = 6 + (1 - t) * 12;       // expands slightly as it fades
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,240,${(0.9 * t).toFixed(3)})`);
    grad.addColorStop(0.4, hexToRgba(f.color, 0.7 * t));
    grad.addColorStop(1, hexToRgba(f.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  state.muzzleFlashes = kept;
}

const HITMARKER_MS = 180;
function drawHitMarkers() {
  if (!state.hitMarkers.length) return;
  const now = performance.now();
  const kept = [];
  ctx.save();
  ctx.lineCap = 'round';
  for (const h of state.hitMarkers) {
    const age = now - h.born;
    if (age >= HITMARKER_MS) continue;
    kept.push(h);
    const t = 1 - age / HITMARKER_MS;   // 1 -> 0 over the marker lifetime
    // Classic four-tick "X" bracketing the crosshair; red-gold on a kill, white otherwise.
    const gap = 4 + (1 - t) * 3;        // ticks flick outward as they fade
    const len = 7;
    ctx.strokeStyle = h.killed ? `rgba(255,80,60,${t.toFixed(3)})` : `rgba(255,255,255,${(0.9 * t).toFixed(3)})`;
    ctx.lineWidth = h.killed ? 3 : 2.2;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(mouse.x + sx * gap, mouse.y + sy * gap);
      ctx.lineTo(mouse.x + sx * (gap + len), mouse.y + sy * (gap + len));
    }
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.restore();
  state.hitMarkers = kept;
}

function drawOffscreenIndicators(vw, vh) {
  if (!state.curr) return;
  const meRp = playerRenderPos(state.myId);
  const margin = 34;                       // keep arrows fully inside the edge
  const cx = vw / 2, cy = vh / 2;
  const halfW = Math.max(10, vw / 2 - margin);
  const halfH = Math.max(10, vh / 2 - margin);
  for (const id of state.curr.players.keys()) {
    if (id === state.myId) continue;
    const rp = playerRenderPos(id);
    if (!rp || !rp.alive) continue;
    const sx = rp.x - camera.x;
    const sy = rp.y - camera.y;
    if (sx >= 0 && sx <= vw && sy >= 0 && sy <= vh) continue; // on screen already
    // Direction from the local player (screen center) toward the enemy.
    const dx = sx - cx, dy = sy - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) continue;
    const ux = dx / dist, uy = dy / dist;
    // March out to where that ray meets the inset viewport rectangle.
    const scale = Math.min(
      Math.abs(ux) > 1e-4 ? halfW / Math.abs(ux) : Infinity,
      Math.abs(uy) > 1e-4 ? halfH / Math.abs(uy) : Infinity,
    );
    const px = cx + ux * scale;
    const py = cy + uy * scale;
    const color = state.colors.get(id) || '#ffffff';
    // Fade far-away enemies so nearby threats read as more urgent.
    const worldDist = meRp ? Math.hypot(rp.x - meRp.x, rp.y - meRp.y) : 0;
    const alpha = Math.max(0.32, Math.min(0.95, 1 - worldDist / 2600));

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.atan2(uy, ux));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-7, -8);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function clampCam(v, max) {
  if (max <= 0) return max / 2; // arena smaller than viewport: center it
  return Math.max(0, Math.min(v, max));
}

function drawGrid(world) {
  const step = 80;
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const startX = -((camera.x % step) + step) % step;
  const startY = -((camera.y % step) + step) % step;
  ctx.beginPath();
  for (let x = startX; x < window.innerWidth; x += step) {
    ctx.moveTo(x, 0); ctx.lineTo(x, window.innerHeight);
  }
  for (let y = startY; y < window.innerHeight; y += step) {
    ctx.moveTo(0, y); ctx.lineTo(window.innerWidth, y);
  }
  ctx.stroke();
}

function drawPlayer(id, rp, radius) {
  const x = rp.x - camera.x;
  const y = rp.y - camera.y;
  const color = state.colors.get(id) || '#ffffff';
  const roster = state.arena.players.find((p) => p.id === id);
  const name = roster ? roster.name : id;

  // Body
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  if (id === state.myId) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  // Barrel: drawn on top of the body in a dark gunmetal so the aim direction
  // reads clearly against the player's own colour, extending past the body.
  const cos = Math.cos(rp.angle);
  const sin = Math.sin(rp.angle);
  ctx.strokeStyle = '#11161d';
  ctx.lineCap = 'round';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(x + cos * (radius - 4), y + sin * (radius - 4));
  ctx.lineTo(x + cos * (radius + 14), y + sin * (radius + 14));
  ctx.stroke();
  ctx.lineCap = 'butt';

  // Name
  ctx.fillStyle = '#e6edf3';
  ctx.font = '13px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name, x, y - radius - 14);

  // Health bar
  const bw = radius * 2.2;
  const bh = 5;
  const bx = x - bw / 2;
  const by = y - radius - 10;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(bx, by, bw, bh);
  const frac = Math.max(0, Math.min(1, rp.hp / 100));
  ctx.fillStyle = frac > 0.5 ? '#69f0ae' : frac > 0.25 ? '#ffd740' : '#ff5252';
  ctx.fillRect(bx, by, bw * frac, bh);
}

requestAnimationFrame(draw);

// ===========================================================================
// Cleanup helpers
// ===========================================================================

function resetGameState() {
  state.roomCode = null;
  state.hostId = null;
  state.arena = null;
  state.prev = state.curr = null;
  state.myHp = 100;
  state.damageFlashUntil = 0;
  state.muzzleFlashes.length = 0;
  state.impacts.length = 0;
  state.bulletDir.clear();
  state.hitMarkers.length = 0;
  input.up = input.down = input.left = input.right = input.shooting = false;
  $('health-hud').hidden = true;
}
