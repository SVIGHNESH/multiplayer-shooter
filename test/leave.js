'use strict';

// End-to-end coverage for the "player leaves mid-match" notification. The plan
// promises that when a player is removed from a room "the remaining players are
// notified". While the match is in the lobby that is the roomUpdate roster; but
// mid-match the survivors are on the game screen, so the server must emit a
// distinct playerLeft feed event - otherwise the departed player just silently
// vanishes from the arena. This locks that in, plus the below-2-players case
// which ends the match instead (a gameOver, not a playerLeft).

const { io } = require('socket.io-client');
const { server } = require('../server');

const PASS = [];
const FAIL = [];

function check(name, cond) {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

function once(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Resolve true if `event` fires before `timeout`, false otherwise (no throw).
function fires(socket, event, timeout = 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(false); }, timeout);
    function handler() { clearTimeout(timer); resolve(true); }
    socket.once(event, handler);
  });
}

async function mkPlayer(url, name) {
  const socket = io(url, { transports: ['websocket'] });
  socket.emit('register', { name });
  const reg = await once(socket, 'registered');
  return { socket, id: reg.playerId };
}

async function run(port) {
  const url = `http://localhost:${port}`;
  const sockets = [];
  const track = (p) => { sockets.push(p.socket); return p; };

  try {
    // --- Three players in one room, match started ---
    const host = track(await mkPlayer(url, 'Host'));
    host.socket.emit('createRoom');
    const room = await once(host.socket, 'roomUpdate');
    const code = room.code;

    const g1 = track(await mkPlayer(url, 'Ghost'));
    g1.socket.emit('joinRoom', { code });
    await once(g1.socket, 'roomUpdate');

    const g2 = track(await mkPlayer(url, 'Viper'));
    g2.socket.emit('joinRoom', { code });
    await once(g2.socket, 'roomUpdate');

    const hostStarted = once(host.socket, 'gameStarted');
    host.socket.emit('startGame');
    await hostStarted;

    // --- One guest leaves mid-match; 2 players remain, so the match continues
    //     and the survivors must be told who left. ---
    const hostFeed = once(host.socket, 'playerLeft');
    const g1Feed = once(g1.socket, 'playerLeft');
    g2.socket.emit('leaveRoom');
    const [hf, gf] = await Promise.all([hostFeed, g1Feed]);
    check('Survivors receive a playerLeft event mid-match', hf && gf);
    check('playerLeft names the departed player', hf.name === 'Viper' && gf.name === 'Viper');

    // --- Now the match is 2 players; when it drops below 2 the server ends the
    //     match (gameOver) rather than emitting playerLeft. ---
    const hostOver = once(host.socket, 'gameOver');
    const hostLeftAgain = fires(host.socket, 'playerLeft', 800);
    g1.socket.emit('leaveRoom');
    const over = await hostOver;
    check('Dropping below 2 players ends the match with gameOver', !!over && !!over.winner);
    check('No playerLeft feed spam when the match ends', (await hostLeftAgain) === false);
  } finally {
    for (const s of sockets) s.close();
  }
}

server.listen(0, async () => {
  const port = server.address().port;
  console.log(`Leave-notification test server on port ${port}\n`);
  try {
    await run(port);
  } catch (err) {
    console.error('\nLeave-notification test error:', err.message);
    FAIL.push('unexpected error: ' + err.message);
  }
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  server.close();
  process.exit(FAIL.length === 0 ? 0 : 1);
});
