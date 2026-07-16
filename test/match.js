'use strict';

// End-to-end match-lifecycle test: drives a full deathmatch to its win
// condition and verifies the gameOver -> return-to-lobby -> rematch flow, the
// one critical path the basic smoke test does not cover.
//
// KILLS_TO_WIN and RESPAWN_MS are lowered via env (before requiring the server)
// so a real match resolves in seconds instead of ~40s at the default 15 kills.

process.env.KILLS_TO_WIN = '2';
process.env.RESPAWN_MS = '300';

const { io } = require('socket.io-client');
const { server } = require('../server');

const KILLS_TO_WIN = Number(process.env.KILLS_TO_WIN);

const PASS = [];
const FAIL = [];

function check(name, cond) {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

function once(socket, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Drive `hunter` toward `prey` while continuously firing, until `done()` is true
// or the deadline passes. Reads live state snapshots to aim and chase. Includes
// stuck-detection: when the hunter wedges against an obstacle (position barely
// changes while it intends to move), it strafes to get around cover, so the test
// resolves reliably regardless of random spawn placement.
async function hunt(hunter, hunterId, preyId, done, deadlineMs = 40000) {
  const start = Date.now();
  let lastX = null, lastY = null, stuckTicks = 0, dodge = 0;
  while (!done() && Date.now() - start < deadlineMs) {
    let s;
    try {
      s = await once(hunter, 'state', 4000);
    } catch {
      break;
    }
    const me = s.players.find((p) => p.id === hunterId);
    const prey = s.players.find((p) => p.id === preyId);
    if (me && prey && me.alive) {
      const dx = prey.x - me.x;
      const dy = prey.y - me.y;

      if (lastX !== null) {
        const moved = Math.hypot(me.x - lastX, me.y - lastY);
        if (moved < 3) stuckTicks++; else stuckTicks = 0;
      }
      lastX = me.x; lastY = me.y;

      let cmd = { right: dx > 20, left: dx < -20, down: dy > 20, up: dy < -20 };
      if (stuckTicks >= 3) {
        // Wedged against cover: strafe perpendicular to the pursuit direction
        // for a burst of ticks to slide around the obstacle.
        if (dodge <= 0) dodge = 8;
        const perpHorizontal = Math.abs(dx) < Math.abs(dy);
        const sign = (dodge % 2 === 0) ? 1 : -1;
        cmd = perpHorizontal
          ? { right: sign > 0, left: sign < 0, up: false, down: false }
          : { up: sign > 0, down: sign < 0, left: false, right: false };
      }
      if (dodge > 0) dodge--;

      hunter.emit('input', { ...cmd, angle: Math.atan2(dy, dx), shooting: true });
    }
    await wait(40);
  }
  hunter.emit('input', { right: false, left: false, down: false, up: false, angle: 0, shooting: false });
}

async function playMatch(a, aId, b, bId) {
  // Set up gameOver + return-to-lobby listeners before driving the fight.
  const gameOverP = once(a, 'gameOver', 45000);
  const lobbyAgainP = new Promise((resolve) => {
    const onUpdate = (room) => {
      if (room.state === 'lobby') { a.off('roomUpdate', onUpdate); resolve(room); }
    };
    a.on('roomUpdate', onUpdate);
  });

  let over = false;
  gameOverP.then(() => { over = true; }).catch(() => {});
  await hunt(a, aId, bId, () => over);

  const result = await gameOverP;
  const lobbyRoom = await lobbyAgainP;
  return { result, lobbyRoom };
}

async function run(port) {
  const url = `http://localhost:${port}`;
  const a = io(url, { transports: ['websocket'] });
  const b = io(url, { transports: ['websocket'] });

  try {
    a.emit('register', { name: 'Alice' });
    b.emit('register', { name: 'Bob' });
    const regA = await once(a, 'registered');
    const regB = await once(b, 'registered');

    a.emit('createRoom');
    const room = await once(a, 'roomUpdate');
    b.emit('joinRoom', { code: room.code });
    await once(b, 'roomUpdate');

    // --- Match 1: play to the win condition ---
    const startedA = once(a, 'gameStarted');
    const startedB = once(b, 'gameStarted');
    a.emit('startGame');
    const gs = await startedA;
    await startedB;
    check('gameStarted reports killsToWin', gs.killsToWin === KILLS_TO_WIN);

    const { result, lobbyRoom } = await playMatch(a, regA.playerId, b, regB.playerId);

    check('gameOver fires with a winner', !!result.winner && result.winner.id === regA.playerId);
    check('Winner name is Alice', result.winner.name === 'Alice');
    check('Standings include both players', Array.isArray(result.standings) && result.standings.length === 2);
    check('Standings are sorted, winner first', result.standings[0].id === regA.playerId);
    check('Winner reached the kill target', result.standings[0].kills >= KILLS_TO_WIN);

    // --- Room returns to lobby, ready for a rematch ---
    check('Room state returns to lobby after match', lobbyRoom.state === 'lobby');
    check('Both players remain in the room', lobbyRoom.players.length === 2);
    check('Rematch is startable (2+ players)', lobbyRoom.canStart === true);

    // --- Match 2 (rematch): scores must reset ---
    const restartedA = once(a, 'gameStarted');
    a.emit('startGame');
    await restartedA;
    const freshSnap = await once(a, 'state');
    const allZero = freshSnap.scores.every((s) => s.kills === 0 && s.deaths === 0);
    check('Rematch resets all kills and deaths to zero', allZero);

    a.emit('leaveRoom');
  } finally {
    a.close();
    b.close();
  }
}

server.listen(0, async () => {
  const port = server.address().port;
  console.log(`Match test server on port ${port} (killsToWin=${KILLS_TO_WIN})\n`);
  try {
    await run(port);
  } catch (err) {
    console.error('\nMatch test error:', err.message);
    FAIL.push('unexpected error: ' + err.message);
  }
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  server.close();
  process.exit(FAIL.length === 0 ? 0 : 1);
});
