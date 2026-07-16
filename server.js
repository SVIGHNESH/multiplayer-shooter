'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORLD = { width: 1600, height: 1200 };
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 260; // px/s
const PLAYER_MAX_HP = 100;
// RESPAWN_MS and KILLS_TO_WIN can be overridden via env for fast, deterministic
// automated match tests; defaults match the plan's gameplay design.
const RESPAWN_MS = Number(process.env.RESPAWN_MS) || 2500;
const FIRE_COOLDOWN_MS = 180;
const BULLET_SPEED = 700; // px/s
const BULLET_RADIUS = 4;
const BULLET_DAMAGE = 25;
const KILLS_TO_WIN = Number(process.env.KILLS_TO_WIN) || 15;
const ROOM_MAX_PLAYERS = 8;
const TICK_HZ = 60;
const SNAPSHOT_HZ = 30;

// Rectangular obstacles inside the arena (x, y = top-left corner).
const OBSTACLES = [
  { x: 300, y: 250, w: 200, h: 60 },
  { x: 1100, y: 250, w: 200, h: 60 },
  { x: 720, y: 540, w: 160, h: 120 },
  { x: 300, y: 890, w: 200, h: 60 },
  { x: 1100, y: 890, w: 200, h: 60 },
  { x: 150, y: 540, w: 60, h: 120 },
  { x: 1390, y: 540, w: 60, h: 120 },
];

const PLAYER_COLORS = [
  '#ff5252', '#40c4ff', '#69f0ae', '#ffd740',
  '#e040fb', '#ff6e40', '#18ffff', '#b2ff59',
];

// Characters used for IDs / room codes (ambiguous 0/O/1/I removed).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

/** playerId -> { id, name, socketId, roomCode } */
const players = new Map();
/** socketId -> playerId */
const socketToPlayer = new Map();
/** roomCode -> room */
const rooms = new Map();

function randCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function uniquePlayerId() {
  let id;
  do {
    id = 'P-' + randCode(4);
  } while (players.has(id));
  return id;
}

function uniqueRoomCode() {
  let code;
  do {
    code = randCode(6);
  } while (rooms.has(code));
  return code;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// Closest point on an axis-aligned rectangle to a circle, used for collision.
function circleRectHit(cx, cy, r, rect) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function pointInRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

function collidesWorld(cx, cy, r) {
  if (cx - r < 0 || cx + r > WORLD.width || cy - r < 0 || cy + r > WORLD.height) {
    return true;
  }
  for (const o of OBSTACLES) {
    if (circleRectHit(cx, cy, r, o)) return true;
  }
  return false;
}

function pickSpawn(room) {
  let best = null;
  let bestDist = -1;
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = 60 + Math.random() * (WORLD.width - 120);
    const y = 60 + Math.random() * (WORLD.height - 120);
    if (collidesWorld(x, y, PLAYER_RADIUS)) continue;
    // Maximise distance to the nearest living player.
    let nearest = Infinity;
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < nearest) nearest = d;
    }
    if (nearest > bestDist) {
      bestDist = nearest;
      best = { x, y };
    }
    if (nearest === Infinity) break; // no other players, first valid spot is fine
  }
  return best || { x: WORLD.width / 2, y: WORLD.height / 2 };
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------

function createRoom(hostPlayerId) {
  const code = uniqueRoomCode();
  const room = {
    code,
    hostId: hostPlayerId,
    state: 'lobby', // 'lobby' | 'playing'
    players: new Map(), // playerId -> game/lobby player object
    joinOrder: [], // playerIds in arrival order (for host succession)
    bullets: [],
    nextBulletId: 1,
    loop: null,
    lastTick: 0,
    snapshotAccum: 0,
  };
  rooms.set(code, room);
  return room;
}

function addPlayerToRoom(room, playerId, name) {
  const colorIdx = room.players.size % PLAYER_COLORS.length;
  const gp = {
    id: playerId,
    name,
    color: PLAYER_COLORS[colorIdx],
    x: WORLD.width / 2,
    y: WORLD.height / 2,
    angle: 0,
    hp: PLAYER_MAX_HP,
    alive: true,
    respawnAt: 0,
    lastShotAt: 0,
    kills: 0,
    deaths: 0,
    input: { up: false, down: false, left: false, right: false, angle: 0, shooting: false },
  };
  room.players.set(playerId, gp);
  room.joinOrder.push(playerId);
  const pl = players.get(playerId);
  if (pl) pl.roomCode = room.code;
  return gp;
}

function removePlayerFromRoom(room, playerId) {
  room.players.delete(playerId);
  room.joinOrder = room.joinOrder.filter((id) => id !== playerId);
  const pl = players.get(playerId);
  if (pl) pl.roomCode = null;

  if (room.players.size === 0) {
    destroyRoom(room);
    return;
  }
  // Host succession: longest-present remaining player.
  if (room.hostId === playerId) {
    room.hostId = room.joinOrder[0];
  }
}

function destroyRoom(room) {
  if (room.loop) {
    clearInterval(room.loop);
    room.loop = null;
  }
  rooms.delete(room.code);
}

function roomRoster(room) {
  return room.joinOrder
    .map((id) => room.players.get(id))
    .filter(Boolean)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, isHost: p.id === room.hostId }));
}

function emitRoomUpdate(room) {
  const payload = {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    players: roomRoster(room),
    maxPlayers: ROOM_MAX_PLAYERS,
    canStart: room.players.size >= 2,
  };
  io.to(room.code).emit('roomUpdate', payload);
}

// ---------------------------------------------------------------------------
// Game simulation
// ---------------------------------------------------------------------------

function startGame(room) {
  room.state = 'playing';
  room.bullets = [];
  for (const p of room.players.values()) {
    const spawn = pickSpawn(room);
    p.x = spawn.x;
    p.y = spawn.y;
    p.hp = PLAYER_MAX_HP;
    p.alive = true;
    p.respawnAt = 0;
    p.kills = 0;
    p.deaths = 0;
    p.input = { up: false, down: false, left: false, right: false, angle: 0, shooting: false };
  }

  io.to(room.code).emit('gameStarted', {
    world: WORLD,
    obstacles: OBSTACLES,
    playerRadius: PLAYER_RADIUS,
    killsToWin: KILLS_TO_WIN,
    players: roomRoster(room),
  });

  room.lastTick = Date.now();
  room.snapshotAccum = 0;
  room.loop = setInterval(() => tickRoom(room), 1000 / TICK_HZ);
}

function tickRoom(room) {
  const now = Date.now();
  let dt = (now - room.lastTick) / 1000;
  room.lastTick = now;
  if (dt > 0.1) dt = 0.1; // clamp to avoid huge jumps after a stall

  // --- Players: movement, respawn, shooting ---
  for (const p of room.players.values()) {
    if (!p.alive) {
      if (now >= p.respawnAt) {
        const spawn = pickSpawn(room);
        p.x = spawn.x;
        p.y = spawn.y;
        p.hp = PLAYER_MAX_HP;
        p.alive = true;
      }
      continue;
    }

    let mx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    let my = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    if (mx !== 0 || my !== 0) {
      const len = Math.hypot(mx, my);
      mx /= len;
      my /= len;
      const step = PLAYER_SPEED * dt;
      // Move each axis independently so we can slide along walls/obstacles.
      const nx = p.x + mx * step;
      if (!collidesWorld(nx, p.y, PLAYER_RADIUS)) p.x = nx;
      const ny = p.y + my * step;
      if (!collidesWorld(p.x, ny, PLAYER_RADIUS)) p.y = ny;
    }

    p.angle = p.input.angle;

    if (p.input.shooting && now - p.lastShotAt >= FIRE_COOLDOWN_MS) {
      p.lastShotAt = now;
      const bx = p.x + Math.cos(p.angle) * (PLAYER_RADIUS + BULLET_RADIUS + 1);
      const by = p.y + Math.sin(p.angle) * (PLAYER_RADIUS + BULLET_RADIUS + 1);
      room.bullets.push({
        id: room.nextBulletId++,
        ownerId: p.id,
        x: bx,
        y: by,
        vx: Math.cos(p.angle) * BULLET_SPEED,
        vy: Math.sin(p.angle) * BULLET_SPEED,
      });
    }
  }

  // --- Bullets: movement + collisions ---
  const survivors = [];
  for (const b of room.bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x < 0 || b.x > WORLD.width || b.y < 0 || b.y > WORLD.height) continue;

    let dead = false;
    for (const o of OBSTACLES) {
      if (pointInRect(b.x, b.y, o)) { dead = true; break; }
    }
    if (dead) continue;

    for (const p of room.players.values()) {
      if (!p.alive || p.id === b.ownerId) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy <= (PLAYER_RADIUS + BULLET_RADIUS) ** 2) {
        applyDamage(room, p, b.ownerId, now);
        dead = true;
        break;
      }
    }
    if (dead) continue;

    survivors.push(b);
  }
  room.bullets = survivors;

  // --- Snapshot broadcast at SNAPSHOT_HZ ---
  room.snapshotAccum += dt;
  if (room.snapshotAccum >= 1 / SNAPSHOT_HZ) {
    room.snapshotAccum = 0;
    broadcastState(room, now);
  }
}

function applyDamage(room, victim, shooterId, now) {
  victim.hp -= BULLET_DAMAGE;
  if (victim.hp > 0) return;

  victim.hp = 0;
  victim.alive = false;
  victim.deaths += 1;
  victim.respawnAt = now + RESPAWN_MS;

  const shooter = room.players.get(shooterId);
  const killerName = shooter ? shooter.name : 'World';
  if (shooter && shooter.id !== victim.id) {
    shooter.kills += 1;
  }

  io.to(room.code).emit('killFeed', { killer: killerName, victim: victim.name });

  if (shooter && shooter.kills >= KILLS_TO_WIN) {
    endGame(room, shooter);
  }
}

function scoreboard(room) {
  return room.joinOrder
    .map((id) => room.players.get(id))
    .filter(Boolean)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
}

function broadcastState(room, now) {
  const snapshot = {
    t: now,
    players: [],
    bullets: room.bullets.map((b) => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), ownerId: b.ownerId })),
    scores: scoreboard(room),
  };
  for (const id of room.joinOrder) {
    const p = room.players.get(id);
    if (!p) continue;
    snapshot.players.push({
      id: p.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      angle: Number(p.angle.toFixed(3)),
      hp: p.hp,
      alive: p.alive,
      respawnIn: p.alive ? 0 : Math.max(0, Math.ceil((p.respawnAt - now) / 1000)),
    });
  }
  io.to(room.code).emit('state', snapshot);
}

function endGame(room, winner) {
  if (room.loop) {
    clearInterval(room.loop);
    room.loop = null;
  }
  room.state = 'lobby';
  room.bullets = [];
  io.to(room.code).emit('gameOver', {
    winner: { id: winner.id, name: winner.name },
    standings: scoreboard(room),
  });
  emitRoomUpdate(room);
}

// ---------------------------------------------------------------------------
// Socket wiring
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('register', ({ name } = {}) => {
    const clean = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 16) : 'Player';
    const id = uniquePlayerId();
    players.set(id, { id, name: clean, socketId: socket.id, roomCode: null });
    socketToPlayer.set(socket.id, id);
    socket.emit('registered', { playerId: id, name: clean });
  });

  socket.on('createRoom', () => {
    const playerId = socketToPlayer.get(socket.id);
    const pl = players.get(playerId);
    if (!pl) return socket.emit('errorMsg', { message: 'Register first.' });
    if (pl.roomCode) return socket.emit('errorMsg', { message: 'Already in a room.' });

    const room = createRoom(playerId);
    addPlayerToRoom(room, playerId, pl.name);
    socket.join(room.code);
    emitRoomUpdate(room);
  });

  socket.on('joinRoom', ({ code } = {}) => {
    const playerId = socketToPlayer.get(socket.id);
    const pl = players.get(playerId);
    if (!pl) return socket.emit('errorMsg', { message: 'Register first.' });
    joinByCode(socket, pl, typeof code === 'string' ? code.trim().toUpperCase() : '');
  });

  socket.on('invitePlayer', ({ playerId: targetId } = {}) => {
    const hostPlayerId = socketToPlayer.get(socket.id);
    const host = players.get(hostPlayerId);
    if (!host || !host.roomCode) return;
    const room = rooms.get(host.roomCode);
    if (!room || room.hostId !== hostPlayerId) {
      return socket.emit('inviteResult', { status: 'error', message: 'Only the host can invite.' });
    }
    const target = players.get(typeof targetId === 'string' ? targetId.trim().toUpperCase() : '');
    if (!target) {
      return socket.emit('inviteResult', { status: 'notfound', targetId });
    }
    if (target.id === hostPlayerId) {
      return socket.emit('inviteResult', { status: 'error', message: 'You cannot invite yourself.' });
    }
    io.to(target.socketId).emit('inviteReceived', {
      code: room.code,
      hostName: host.name,
      hostId: host.id,
    });
    socket.emit('inviteResult', { status: 'sent', targetId: target.id, targetName: target.name });
  });

  socket.on('inviteResponse', ({ accepted, code } = {}) => {
    const playerId = socketToPlayer.get(socket.id);
    const pl = players.get(playerId);
    if (!pl) return;
    const room = rooms.get(typeof code === 'string' ? code.trim().toUpperCase() : '');
    const hostSocketId = room ? players.get(room.hostId)?.socketId : null;

    if (!accepted) {
      if (hostSocketId) {
        io.to(hostSocketId).emit('inviteResult', { status: 'declined', targetName: pl.name });
      }
      return;
    }
    if (!room) {
      return socket.emit('errorMsg', { message: 'That room no longer exists.' });
    }
    const ok = joinByCode(socket, pl, room.code);
    if (ok && hostSocketId) {
      io.to(hostSocketId).emit('inviteResult', { status: 'accepted', targetName: pl.name });
    }
  });

  socket.on('startGame', () => {
    const playerId = socketToPlayer.get(socket.id);
    const pl = players.get(playerId);
    if (!pl || !pl.roomCode) return;
    const room = rooms.get(pl.roomCode);
    if (!room) return;
    if (room.hostId !== playerId) {
      return socket.emit('errorMsg', { message: 'Only the host can start.' });
    }
    if (room.state === 'playing') return;
    if (room.players.size < 2) {
      return socket.emit('errorMsg', { message: 'Need at least 2 players to start.' });
    }
    startGame(room);
  });

  socket.on('input', (input = {}) => {
    const playerId = socketToPlayer.get(socket.id);
    const pl = players.get(playerId);
    if (!pl || !pl.roomCode) return;
    const room = rooms.get(pl.roomCode);
    if (!room || room.state !== 'playing') return;
    const gp = room.players.get(playerId);
    if (!gp) return;
    gp.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
      angle: typeof input.angle === 'number' && Number.isFinite(input.angle) ? input.angle : gp.input.angle,
      shooting: !!input.shooting,
    };
  });

  socket.on('leaveRoom', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    const playerId = socketToPlayer.get(socket.id);
    leaveCurrentRoom(socket);
    if (playerId) players.delete(playerId);
    socketToPlayer.delete(socket.id);
  });
});

function joinByCode(socket, pl, code) {
  if (!code) {
    socket.emit('errorMsg', { message: 'Enter a room code.' });
    return false;
  }
  const room = rooms.get(code);
  if (!room) {
    socket.emit('errorMsg', { message: 'No room with that code.' });
    return false;
  }
  if (pl.roomCode === room.code) return true; // already in it
  if (pl.roomCode) {
    socket.emit('errorMsg', { message: 'Leave your current room first.' });
    return false;
  }
  if (room.state === 'playing') {
    socket.emit('errorMsg', { message: 'That match is already in progress.' });
    return false;
  }
  if (room.players.size >= ROOM_MAX_PLAYERS) {
    socket.emit('errorMsg', { message: 'That room is full.' });
    return false;
  }
  addPlayerToRoom(room, pl.id, pl.name);
  socket.join(room.code);
  emitRoomUpdate(room);
  return true;
}

function leaveCurrentRoom(socket) {
  const playerId = socketToPlayer.get(socket.id);
  const pl = players.get(playerId);
  if (!pl || !pl.roomCode) return;
  const room = rooms.get(pl.roomCode);
  socket.leave(pl.roomCode);
  if (!room) {
    pl.roomCode = null;
    return;
  }
  const wasPlaying = room.state === 'playing';
  removePlayerFromRoom(room, playerId);
  if (rooms.has(room.code)) {
    // If a match drops below 2 players, end it and return to lobby.
    if (wasPlaying && room.players.size < 2) {
      const remaining = scoreboard(room);
      endGame(room, room.players.get(room.joinOrder[0]) || remaining[0] || { id: null, name: '-' });
    } else {
      emitRoomUpdate(room);
    }
  }
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Multiplayer shooter server listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, server, io };
