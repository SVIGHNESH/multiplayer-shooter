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
  // Camera trauma: 0..1, squared into screenshake and decayed every frame. Bumped
  // by firing, taking damage, kills, and death for weight on violent events.
  trauma: 0,
  // Death bursts: expanding shockwave + sparks spawned where a player dies.
  deathBursts: [],       // { x, y, born, color }
  // Hit-stop: while performance.now() < this, the world-interpolation clock is
  // frozen for a brief freeze-frame on kills/death (see nowGame()).
  hitStopUntil: 0,
  hitStopFrozenAt: 0,
  // Own-fire prediction: fire the local muzzle flash/sound the instant we press,
  // instead of waiting a 30Hz snapshot round-trip for the authoritative bullet.
  lastLocalShotAt: 0,
  // Dash cooldown UI, driven by the local player's snapshot fields.
  dashCooldownMs: 1600,
  dashReadyIn: 0,
  // Health packs: fixed layout from gameStarted; activePickups is the set of ids
  // currently on the floor (from each snapshot).
  pickupLayout: [],      // [{ id, x, y }]
  activePickups: new Set(),
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
  const name = $('name-input').value.trim();
  if (state.myId) {
    // Already registered. If the player edited their name (and isn't currently
    // in a room), push the change so the new name is used for rooms they create
    // or join - the server keeps the same stable player id.
    if (!state.roomCode && name && name !== state.myName) {
      socket.emit('register', { name });
    }
    return true;
  }
  socket.emit('register', { name });
  return false;
}

// ===========================================================================
// Home screen
// ===========================================================================

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

// Copy the local player's own ID so a friend can invite them by ID.
async function copyMyId(btn) {
  if (!state.myId) return;
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(state.myId);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1200);
  } catch {
    toast('Copy failed - select your ID manually.');
  }
}
$('btn-copy-id').addEventListener('click', (e) => copyMyId(e.currentTarget));
$('btn-copy-id-lobby').addEventListener('click', (e) => copyMyId(e.currentTarget));

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

// Host-only one-click rematch from the results screen: jump back to the lobby
// and start immediately. startGame stays server-authoritative (host + 2 players
// + lobby state), so a mistimed click is simply ignored.
$('btn-rematch').addEventListener('click', () => {
  $('gameover').hidden = true;
  showScreen('lobby');
  socket.emit('startGame');
});

function refreshRematchButton() {
  const amHost = state.hostId === state.myId;
  const btn = $('btn-rematch');
  btn.hidden = !amHost;
  if (!amHost) return;
  btn.disabled = !state.canStart;
  btn.textContent = state.canStart ? 'Rematch' : 'Need 2 players';
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

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
  state.canStart = room.canStart;
  state.colors = new Map(room.players.map((p) => [p.id, p.color]));
  // Keep the game-over rematch button in sync if the results overlay is up
  // (players leaving/joining can flip whether a rematch can start).
  if (!$('gameover').hidden) refreshRematchButton();

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
  // With the invite column hidden for non-hosts, collapse the two-column grid so
  // the roster spans the full panel width instead of leaving the right half blank.
  $('lobby-body').classList.toggle('solo', !amHost);
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
    case 'failed': setInviteStatus(`${res.targetName} accepted, but couldn't join (already in a room or it filled up).`, 'err'); break;
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
  state.killedBy = null;
  // New match: reset juice + pickup + dash state so nothing leaks across matches.
  state.trauma = 0;
  state.deathBursts.length = 0;
  state.hitStopUntil = 0;
  state.lastLocalShotAt = 0;
  lastLocalDashAt = 0;
  state.dashReadyIn = 0;
  state.pickupLayout = Array.isArray(data.pickups) ? data.pickups : [];
  state.activePickups = new Set(state.pickupLayout.map((p) => p.id));
  state.dashCooldownMs = data.dashCooldownMs || 1600;
  // Clear any input held across the lobby (e.g. a movement key still down from
  // the previous match) so a rematch doesn't start with the player auto-moving.
  input.up = input.down = input.left = input.right = input.shooting = false;
  $('gameover').hidden = true;
  $('scoreboard').hidden = true;
  $('health-hud').hidden = true;
  $('hp-fill').style.width = '100%';
  $('hp-fill').style.background = '#69f0ae';
  $('hp-value').textContent = '100';
  state.scoreboardOpen = false;
  // Center the aim reticle so it isn't stuck at (0,0) until the first mouse move.
  mouse.x = window.innerWidth / 2;
  mouse.y = window.innerHeight / 2;
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
    // Our own shots are flashed + sounded the instant we fire (see the input
    // loop), so skip them here to avoid a second, snapshot-late flash/sound.
    if (b.ownerId === state.myId) continue;
    const owner = state.curr.players.get(b.ownerId);
    if (!owner) continue;
    state.muzzleFlashes.push({
      x: owner.x + Math.cos(owner.angle) * (radius + 10),
      y: owner.y + Math.sin(owner.angle) * (radius + 10),
      born: state.recvCurr,
      color: state.colors.get(b.ownerId) || '#ffd740',
    });
    // Gunfire sound for other players, distance-attenuated from the local player.
    if (listener) {
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

  // Death bursts: any player alive in the previous snapshot but dead now just
  // died, so spawn an expanding shockwave + sparks at their last position - the
  // most dramatic event in the game finally gets an on-canvas payoff.
  if (state.prev) {
    for (const [id, cp] of state.curr.players) {
      const pp = state.prev.players.get(id);
      if (pp && pp.alive && !cp.alive) {
        state.deathBursts.push({ x: cp.x, y: cp.y, born: state.recvCurr, color: state.colors.get(id) || '#ffd740' });
      }
    }
    if (state.deathBursts.length > 30) state.deathBursts.splice(0, state.deathBursts.length - 30);
  }

  // Active health packs on the floor this snapshot.
  state.activePickups = new Set(snap.pickups || []);

  // Trigger a red damage vignette when the local player's health drops.
  const me = state.curr.players.get(state.myId);
  if (me) {
    // Dash cooldown readout for the HUD pip.
    if (typeof me.dashReadyIn === 'number') state.dashReadyIn = me.dashReadyIn;
    if (me.alive && me.hp < state.myHp) {
      const dmg = state.myHp - me.hp;
      state.damageFlashUntil = performance.now() + 450;
      state.damageFlashStrength = Math.min(0.6, 0.28 + (dmg / 100) * 0.5);
      addTrauma(Math.min(0.5, 0.28 + (dmg / 100) * 0.5));
      sfxHurt();
    }
    // Death / respawn transitions get their own audio cues.
    if (state.myAlive && !me.alive) { sfxDeath(); addTrauma(0.8); startHitStop(120); }
    else if (!state.myAlive && me.alive) { sfxRespawn(); state.killedBy = null; }
    state.myAlive = me.alive;
    // Reset the baseline to full while dead so respawning back to 100 HP never flashes.
    state.myHp = me.alive ? me.hp : 100;
    updateHealthHud(me);
  }

  // Scores change only a few times per match, but snapshots arrive 30x/sec.
  // Rebuild the HUD DOM only when the scores actually change (and the hidden Tab
  // table only while it's open), instead of wiping innerHTML every frame.
  state.lastScores = snap.scores;
  const sig = snap.scores.map((s) => s.id + ':' + s.kills + ':' + s.deaths).join('|');
  if (sig !== state.scoreSig) {
    state.scoreSig = sig;
    updateScoreStrip(snap.scores);
    if (state.scoreboardOpen) updateScoreboard(snap.scores);
  }
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
  // Remember who eliminated the local player so the death overlay can name them.
  if (state.myName && data.victim === state.myName) {
    state.killedBy = data.killer && data.killer !== state.myName ? data.killer : null;
  }
});

// A player leaves/disconnects mid-match while the game continues: tell the
// survivors so the vanished player doesn't just silently disappear.
socket.on('playerLeft', (data) => {
  const feed = $('kill-feed');
  const div = document.createElement('div');
  div.className = 'kf kf-left';
  div.innerHTML = `<span class="v">${escapeHtml(data.name)}</span> left the match`;
  feed.appendChild(div);
  setTimeout(() => div.remove(), 4000);
  while (feed.children.length > 5) feed.removeChild(feed.firstChild);
});

socket.on('gameOver', (data) => {
  // Close the Tab scoreboard so a player holding Tab as the winning kill lands
  // doesn't leave it rendering (and bleeding through) behind the standings card.
  toggleScoreboard(false);
  $('winner-line').textContent = `${data.winner.name} wins!`;

  // Personal result line so the local player sees their own placement without
  // scanning the whole table.
  const rank = data.standings.findIndex((p) => p.id === state.myId);
  const pr = $('personal-result');
  if (rank === 0) {
    pr.textContent = 'You won!';
    pr.className = 'personal-result win';
  } else if (rank > 0) {
    pr.textContent = `You finished ${ordinal(rank + 1)} of ${data.standings.length}`;
    pr.className = 'personal-result';
  } else {
    pr.textContent = '';
    pr.className = 'personal-result';
  }
  refreshRematchButton();

  const body = $('standings-body');
  body.innerHTML = '';
  data.standings.forEach((p, i) => {
    const tr = document.createElement('tr');
    // Match the live scoreboard's legibility: color dot + "(you)" marker, and
    // highlight the local player's row so they can spot their placement at a
    // glance on the results screen (winner row also gets a gold accent).
    const cls = [];
    if (i === 0) cls.push('winner');
    if (p.id === state.myId) cls.push('me');
    tr.className = cls.join(' ');
    const you = p.id === state.myId ? ' <span class="you">(you)</span>' : '';
    const dot = `<span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color};margin-right:6px;vertical-align:middle"></span>`;
    tr.innerHTML =
      `<td>${i + 1}</td><td>${dot}${escapeHtml(p.name)}${you}</td>` +
      `<td>${p.kills}</td><td>${p.deaths}</td>`;
    body.appendChild(tr);
  });
  $('gameover').hidden = false;
});

socket.on('hitConfirm', (data) => {
  const killed = !!(data && data.killed);
  state.hitMarkers.push({ born: performance.now(), killed });
  if (state.hitMarkers.length > 12) state.hitMarkers.splice(0, state.hitMarkers.length - 12);
  sfxHit(killed);
  // A confirmed kill lands with a jolt + brief freeze-frame; non-lethal hits stay
  // calm so only decisive moments punch.
  if (killed) { addTrauma(0.35); startHitStop(70); }
});

// A health pack was picked up by the local player: heal chime.
socket.on('pickup', () => sfxPickup());

socket.on('errorMsg', (data) => toast(data.message || 'Something went wrong.'));

// Persistent connection-status banner: while the socket is down (server offline or
// a network drop), Socket.IO silently buffers every emit, so a button click looks
// like it did nothing. The banner keeps the player informed until the link is back,
// rather than a single 3s toast that fades and leaves them clicking into the void.
function setConnBanner(text) {
  const b = $('conn-banner');
  if (text) { $('conn-text').innerHTML = text; b.hidden = false; }
  else { b.hidden = true; }
}

socket.on('disconnect', () => {
  setConnBanner('Connection lost - reconnecting&hellip;');
});

// Fires when the initial connection or a reconnection attempt fails (e.g. the
// server is down at page load); surface the same banner so home-screen clicks
// are not silently swallowed.
socket.io.on('reconnect_error', () => setConnBanner('Connection lost - reconnecting&hellip;'));
socket.io.on('error', () => setConnBanner('Connection lost - reconnecting&hellip;'));

// On a transient network drop, Socket.IO auto-reconnects with a brand-new server
// connection, but the server discards a player's identity and room on disconnect.
// Without this, the client keeps its now-orphaned id and freezes on the lobby/game
// screen forever (no snapshots arrive, every action is silently rejected). Recover
// by re-registering for a fresh working session and dropping back to home.
socket.on('connect', () => {
  setConnBanner(null); // link restored - clear the persistent status banner
  if (!state.myId) return; // first connection - nothing to restore
  const wasEngaged = screens.lobby.classList.contains('active') || screens.game.classList.contains('active');
  const name = state.myName || $('name-input').value.trim();
  state.myId = null;
  pendingAction = null;
  resetGameState();
  showScreen('home');
  socket.emit('register', { name });
  if (wasEngaged) toast('Reconnected - your match was ended. Create or join a room to play again.');
});

// ===========================================================================
// HUD updates
// ===========================================================================

function shortName(n) {
  const s = String(n);
  return s.length > 7 ? s.slice(0, 6) + '…' : s;
}

function updateScoreStrip(scores) {
  const strip = $('score-strip');
  strip.innerHTML = '';
  const target = state.arena && state.arena.killsToWin;
  // Sort leader-first (server already does, but stay robust) so the frag race
  // reads left-to-right, and cap the visible chips so 8 players can't overrun
  // the strip into the mute button.
  const sorted = scores.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const leaderKills = sorted.length ? sorted[0].kills : 0;
  // Match point: the leader is a single kill away from winning the match.
  const matchPoint = !!target && leaderKills >= target - 1 && leaderKills < target;

  const MAX_SHOWN = 5;
  for (const s of sorted.slice(0, MAX_SHOWN)) {
    const div = document.createElement('div');
    const isLeader = !!target && leaderKills > 0 && s.kills === leaderKills;
    const isMe = s.id === state.myId;
    div.className = 's' + (isLeader ? ' leader' : '') + (isMe ? ' me' : '');
    const crown = isLeader ? '<span class="crown">♛</span>' : '';
    const who = isMe ? 'You' : shortName(s.name);
    div.innerHTML =
      `${crown}<span class="dot" style="background:${s.color}"></span>` +
      `<span class="who">${escapeHtml(who)}</span><span class="kc">${s.kills}</span>`;
    div.title = `${s.name}: ${s.kills} kills / ${s.deaths} deaths`;
    strip.appendChild(div);
  }
  if (sorted.length > MAX_SHOWN) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = '+' + (sorted.length - MAX_SHOWN);
    strip.appendChild(more);
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

// Add camera trauma (clamped 0..1). draw() squares it into screenshake and
// decays it, so violent events (fire, damage, kills, death) shake the view.
function addTrauma(n) {
  state.trauma = Math.min(1, state.trauma + n);
}

// A game clock that pauses during hit-stop. Only the world interpolation
// (interpFactor / playerRenderPos) reads this, so remote motion freeze-frames
// for a few ms on a kill/death while snapshots keep buffering underneath.
function nowGame() {
  const real = performance.now();
  return real < state.hitStopUntil ? state.hitStopFrozenAt : real;
}

function startHitStop(ms) {
  const real = performance.now();
  // Don't stack freezes; keep the longest pending one.
  if (real >= state.hitStopUntil) state.hitStopFrozenAt = real;
  state.hitStopUntil = Math.max(state.hitStopUntil, real + ms);
}

// ===========================================================================
// Input capture
// ===========================================================================

const input = { up: false, down: false, left: false, right: false, angle: 0, shooting: false, dash: false };
const mouse = { x: 0, y: 0 };
let lastLocalDashAt = 0;

// Desktop-only gate: a coarse-pointer-only device (phone/tablet) can register and
// reach the arena but has no way to move, aim, or shoot - and the canvas hides the
// cursor - so tell them honestly up front. Touchscreen laptops (which also report
// a fine pointer) are unaffected; "Play anyway" covers hybrid/edge cases.
(function deviceGate() {
  try {
    const coarseOnly = window.matchMedia('(pointer: coarse)').matches &&
      !window.matchMedia('(pointer: fine)').matches;
    if (coarseOnly) $('device-gate').hidden = false;
  } catch { /* matchMedia unsupported: assume desktop */ }
})();
$('btn-play-anyway').addEventListener('click', () => { $('device-gate').hidden = true; });

const keyMap = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

window.addEventListener('keydown', (e) => {
  if (!screens.game.classList.contains('active')) return;
  if (e.code === 'Tab') { e.preventDefault(); toggleScoreboard(true); return; }
  if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    e.preventDefault();
    input.dash = true;
    // Predict the dash feel locally the moment it can fire (the server still
    // gates the actual burst on its own authoritative cooldown).
    const me = state.curr && state.curr.players.get(state.myId);
    if (!e.repeat && me && me.alive && performance.now() - lastLocalDashAt >= state.dashCooldownMs) {
      lastLocalDashAt = performance.now();
      addTrauma(0.18);
      sfxDash();
    }
    return;
  }
  if (keyMap[e.code]) { input[keyMap[e.code]] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') { toggleScoreboard(false); return; }
  if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') { input.dash = false; return; }
  if (keyMap[e.code]) { input[keyMap[e.code]] = false; }
});

function toggleScoreboard(open) {
  state.scoreboardOpen = open;
  $('scoreboard').hidden = !open;
  // Rebuild once on open so the table is current even though we skip rebuilding
  // it on every hidden snapshot.
  if (open) updateScoreboard(state.lastScores || []);
}

const canvas = $('game-canvas');

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
});
canvas.addEventListener('mousedown', (e) => { if (e.button === 0) input.shooting = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) input.shooting = false; });
// Suppress the browser context menu over the arena so a right-click mid-fight
// (a reflex in mouse-aimed shooters) doesn't pop an OS menu covering the game.
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('blur', () => {
  input.up = input.down = input.left = input.right = input.shooting = input.dash = false;
});

// Send input to the server at a fixed rate.
setInterval(() => {
  if (!state.arena || !screens.game.classList.contains('active')) return;
  input.angle = aimAngle();
  predictOwnFire();
  socket.emit('input', input);
}, 1000 / 30);

// Own-fire prediction: the moment we're holding fire and our local cooldown is
// up, flash the muzzle, play the shot, and add recoil trauma immediately -
// instead of waiting a 30Hz snapshot round-trip for the authoritative bullet
// (which we suppress in the snapshot handler). The real bullet still comes from
// the server; this only makes the gun feel connected to the hand.
const LOCAL_FIRE_COOLDOWN_MS = 190; // slightly > server's 180ms so we never over-predict
function predictOwnFire() {
  if (!input.shooting) return;
  const me = state.curr && state.curr.players.get(state.myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now - state.lastLocalShotAt < LOCAL_FIRE_COOLDOWN_MS) return;
  state.lastLocalShotAt = now;
  const radius = state.arena ? state.arena.playerRadius : 18;
  const ang = input.angle;
  state.muzzleFlashes.push({
    x: me.x + Math.cos(ang) * (radius + 10),
    y: me.y + Math.sin(ang) * (radius + 10),
    born: now,
    color: state.colors.get(state.myId) || '#ffd740',
  });
  if (state.muzzleFlashes.length > 40) state.muzzleFlashes.splice(0, state.muzzleFlashes.length - 40);
  addTrauma(0.12);
  sfxShoot(1);
}

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
function sfxPickup() {
  // Bright two-note chime so a heal reads as clearly positive.
  tone({ type: 'triangle', freq: 660, dur: 0.09, gain: 0.22 });
  tone({ type: 'triangle', freq: 990, dur: 0.12, gain: 0.22, delay: 0.07 });
}
function sfxDash() {
  // Short airy whoosh: a quick downward sweep.
  tone({ type: 'sawtooth', freq: 520, freqEnd: 180, dur: 0.14, gain: 0.14 });
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
const MAX_SHAKE = 14; // px of camera offset at full trauma

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
  // nowGame() freezes during hit-stop; clamp to [0, 1.2] so a snapshot arriving
  // mid-freeze can't drive the factor negative and snap entities backward.
  const elapsed = nowGame() - state.recvCurr;
  return Math.max(0, Math.min(1.2, elapsed / dt)); // allow slight extrapolation
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

  // Screenshake: decay trauma, then offset the world camera by trauma^2 so small
  // taps barely nudge and big hits jolt. Applied after clamping (so it can push
  // slightly past the arena edge for effect) and before any world draw, leaving
  // the screen-space HUD/reticle/minimap rock steady.
  const nowFrame = performance.now();
  const frameDt = state.lastDrawTs ? Math.min(0.05, (nowFrame - state.lastDrawTs) / 1000) : 0.016;
  state.lastDrawTs = nowFrame;
  if (state.trauma > 0) {
    state.trauma = Math.max(0, state.trauma - frameDt * 1.6);
    const shake = state.trauma * state.trauma;
    camera.x += (Math.random() * 2 - 1) * MAX_SHAKE * shake;
    camera.y += (Math.random() * 2 - 1) * MAX_SHAKE * shake;
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

  // Health packs: pulsing green cross on the floor, drawn under players/bullets.
  drawPickups();

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
      const cp = state.curr.players.get(id);
      if (cp && cp.dashing) drawDashTrail(id, rp, playerRadius);
      drawPlayer(id, rp, playerRadius);
    }
  }

  // Death-burst explosions where players were eliminated.
  drawDeathBursts();

  // Bullet impact sparks where projectiles hit cover or players.
  drawImpacts();

  // Muzzle flashes: brief additive gunfire bursts at each shot's origin.
  drawMuzzleFlashes();

  // Aim reticle + faint line from the player to the cursor, so mouse aim reads
  // clearly in-world instead of relying only on the thin gun barrel.
  drawReticle();

  // Hit markers at the aim point confirm the local player's shots landed.
  drawHitMarkers();

  // Edge-of-screen arrows pointing toward any alive enemy currently off-screen,
  // so a 1600x1200 arena that overflows the viewport stays legible - you can
  // always tell which way the fight is.
  drawOffscreenIndicators(vw, vh);

  // Corner minimap: the whole arena scaled down with obstacles, every alive
  // player, and the current viewport box, for at-a-glance spatial awareness.
  drawMinimap(vw, vh);

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
    if (state.killedBy) {
      $('killed-by-name').textContent = state.killedBy;
      $('killed-by').hidden = false;
    } else {
      $('killed-by').hidden = true;
    }
  } else {
    $('respawn-overlay').hidden = true;
  }

  // Health HUD is only meaningful while the local player is alive in the match.
  const alive = !!(me && me.alive);
  $('health-hud').hidden = !alive;
  if (alive) {
    // Smoothly count the dash cooldown down between snapshots for a fluid pip.
    if (state.dashReadyIn > 0) state.dashReadyIn = Math.max(0, state.dashReadyIn - frameDt * 1000);
    updateDashPip();
  }
}

function updateDashPip() {
  const fill = $('dash-fill');
  if (!fill) return;
  const cd = state.dashCooldownMs || 1600;
  const ready = Math.max(0, Math.min(1, 1 - state.dashReadyIn / cd));
  fill.style.width = ready * 100 + '%';
  fill.classList.toggle('ready', state.dashReadyIn <= 0);
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

// Pulsing green health cross for every active pack on the floor. Layout comes
// from gameStarted; activePickups (from the latest snapshot) gates visibility so
// a picked-up pack disappears until it recharges.
function drawPickups() {
  if (!state.pickupLayout.length) return;
  const now = performance.now();
  const pulse = 0.75 + 0.25 * Math.sin(now / 260);
  for (const pk of state.pickupLayout) {
    if (!state.activePickups.has(pk.id)) continue;
    const x = pk.x - camera.x;
    const y = pk.y - camera.y;
    ctx.save();
    // Soft glow.
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 22);
    glow.addColorStop(0, `rgba(105,240,174,${(0.35 * pulse).toFixed(3)})`);
    glow.addColorStop(1, 'rgba(105,240,174,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fill();
    // Rounded plate.
    ctx.fillStyle = 'rgba(13,17,23,0.85)';
    ctx.strokeStyle = '#69f0ae';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x - 13, y - 13, 26, 26, 6);
    ctx.fill();
    ctx.stroke();
    // Cross.
    ctx.fillStyle = '#69f0ae';
    const a = 3.5, b = 9;
    ctx.fillRect(x - a, y - b, a * 2, b * 2);
    ctx.fillRect(x - b, y - a, b * 2, a * 2);
    ctx.restore();
  }
}

const DEATHBURST_MS = 420;
function drawDeathBursts() {
  if (!state.deathBursts.length) return;
  const now = performance.now();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const kept = [];
  for (const f of state.deathBursts) {
    const age = now - f.born;
    if (age >= DEATHBURST_MS) continue;
    kept.push(f);
    const t = age / DEATHBURST_MS;        // 0 -> 1 over the burst lifetime
    const inv = 1 - t;
    const x = f.x - camera.x;
    const y = f.y - camera.y;
    // Expanding shockwave ring.
    const ringR = 8 + t * 62;
    ctx.strokeStyle = hexToRgba(f.color, 0.55 * inv);
    ctx.lineWidth = 3 * inv + 0.5;
    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, Math.PI * 2);
    ctx.stroke();
    // Hot core flash early in the burst.
    if (t < 0.5) {
      const cr = 10 + t * 26;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, cr);
      grad.addColorStop(0, `rgba(255,255,240,${(0.7 * (1 - t * 2)).toFixed(3)})`);
      grad.addColorStop(0.5, hexToRgba(f.color, 0.5 * (1 - t * 2)));
      grad.addColorStop(1, hexToRgba(f.color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, cr, 0, Math.PI * 2);
      ctx.fill();
    }
    // Radial spark shards flung outward.
    ctx.strokeStyle = hexToRgba(f.color, 0.8 * inv);
    ctx.lineWidth = 2 * inv + 0.4;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + f.born * 0.0001;
      const r0 = 6 + t * 40;
      const r1 = r0 + 8 + inv * 10;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
      ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
      ctx.stroke();
    }
  }
  ctx.restore();
  state.deathBursts = kept;
}

// Fading afterimages behind a dashing player, along their travel direction.
function drawDashTrail(id, rp, radius) {
  const prev = state.prev && state.prev.players.get(id);
  const curr = state.curr && state.curr.players.get(id);
  if (!prev || !curr) return;
  let dx = curr.x - prev.x;
  let dy = curr.y - prev.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return;
  dx /= d; dy /= d;
  const color = state.colors.get(id) || '#ffffff';
  ctx.save();
  for (let i = 1; i <= 3; i++) {
    const back = i * 11;
    const x = rp.x - camera.x - dx * back;
    const y = rp.y - camera.y - dy * back;
    ctx.globalAlpha = 0.22 * (1 - i / 4);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius * (1 - i * 0.14), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
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
// Persistent aim reticle at the cursor plus a faint dashed line from the local
// player to it. Drawn only while the local player is alive (nothing to aim while
// dead). Uses cardinal "+" ticks so it never collides with the diagonal "X" the
// transient hit markers draw at the same point.
function drawReticle() {
  const me = playerRenderPos(state.myId);
  if (!me || !me.alive) return;
  const mx = mouse.x, my = mouse.y;
  const px = me.x - camera.x, py = me.y - camera.y;

  ctx.save();
  ctx.lineCap = 'round';

  // Faint aim line from the player toward the cursor.
  ctx.strokeStyle = 'rgba(220,235,255,0.10)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 9]);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(mx, my);
  ctx.stroke();
  ctx.setLineDash([]);

  // Reticle: soft-glowing ring + four cardinal ticks + center dot.
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 3;
  ctx.strokeStyle = 'rgba(255,235,205,0.9)';
  ctx.fillStyle = 'rgba(255,235,205,0.9)';
  ctx.lineWidth = 2;

  const ring = 12, gap = 4, tick = 6;
  ctx.beginPath();
  ctx.arc(mx, my, ring, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  for (const [sx, sy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    ctx.moveTo(mx + sx * (ring - gap), my + sy * (ring - gap));
    ctx.lineTo(mx + sx * (ring + tick), my + sy * (ring + tick));
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(mx, my, 1.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

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

// Minimap: a scaled-down top-left-origin view of the full arena pinned to the
// bottom-right corner. Shows obstacles, the current camera viewport, and every
// alive player (local player as a white-ringed dot), complementing the
// edge-of-screen arrows with actual positions and distances.
function drawMinimap(vw, vh) {
  if (!state.arena || !state.curr) return;
  const { world, obstacles } = state.arena;
  const margin = 16;
  const mapW = 168;
  const mapH = Math.round((mapW * world.height) / world.width);
  const x0 = vw - margin - mapW;
  const y0 = vh - margin - mapH;
  const sx = mapW / world.width;
  const sy = mapH / world.height;

  ctx.save();

  // Panel background + border.
  ctx.beginPath();
  ctx.roundRect(x0 - 4, y0 - 4, mapW + 8, mapH + 8, 6);
  ctx.fillStyle = 'rgba(13, 17, 23, 0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(57, 70, 90, 0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Clip everything else to the map rect so dots/viewport never bleed out.
  ctx.beginPath();
  ctx.rect(x0, y0, mapW, mapH);
  ctx.clip();

  // Arena floor.
  ctx.fillStyle = 'rgba(20, 26, 34, 0.9)';
  ctx.fillRect(x0, y0, mapW, mapH);

  // Obstacles.
  ctx.fillStyle = 'rgba(70, 84, 104, 0.85)';
  for (const o of obstacles) {
    ctx.fillRect(x0 + o.x * sx, y0 + o.y * sy, o.w * sx, o.h * sy);
  }

  // Current viewport rectangle.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + camera.x * sx, y0 + camera.y * sy, vw * sx, vh * sy);

  // Players (alive only); local player gets a white ring so it stands out.
  for (const id of state.curr.players.keys()) {
    const rp = playerRenderPos(id);
    if (!rp || !rp.alive) continue;
    const px = x0 + rp.x * sx;
    const py = y0 + rp.y * sy;
    const isMe = id === state.myId;
    ctx.beginPath();
    ctx.arc(px, py, isMe ? 3.2 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle = state.colors.get(id) || '#ffffff';
    ctx.fill();
    if (isMe) {
      ctx.beginPath();
      ctx.arc(px, py, 4.6, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  ctx.restore();
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
  state.trauma = 0;
  state.deathBursts.length = 0;
  state.hitStopUntil = 0;
  state.pickupLayout = [];
  state.activePickups = new Set();
  input.up = input.down = input.left = input.right = input.shooting = input.dash = false;
  $('health-hud').hidden = true;
}
