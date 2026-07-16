'use strict';

// End-to-end coverage for host succession. The plan promises: "If the host
// leaves, host role transfers to the longest-present remaining player." That
// path (create with 3 players, host leaves in the lobby) had zero test coverage
// through 27 iterations even though the server implements it. This locks in that
// the crown passes to the *earliest-joined* survivor (not just any remaining
// player), that survivors are notified via roomUpdate, that the promoted player
// gains the host-only start privilege, and that succession chains correctly on a
// second host departure.

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

async function mkPlayer(url, name) {
  const socket = io(url, { transports: ['websocket'] });
  socket.emit('register', { name });
  const reg = await once(socket, 'registered');
  return { socket, id: reg.playerId, name };
}

async function run(port) {
  const url = `http://localhost:${port}`;
  const sockets = [];
  const track = (p) => { sockets.push(p.socket); return p; };

  try {
    // --- Three players in one lobby, joined in a known order ---
    const host = track(await mkPlayer(url, 'Host'));
    host.socket.emit('createRoom');
    const room = await once(host.socket, 'roomUpdate');
    const code = room.code;

    const g1 = track(await mkPlayer(url, 'Early')); // longest-present survivor
    g1.socket.emit('joinRoom', { code });
    await once(g1.socket, 'roomUpdate');

    const g2 = track(await mkPlayer(url, 'Late'));  // joined last
    g2.socket.emit('joinRoom', { code });
    await once(g2.socket, 'roomUpdate');

    check('Original creator is the host', room.hostId === host.id);

    // --- Host leaves the lobby: the crown must pass to the earliest-joined
    //     remaining player (g1 'Early'), NOT the most recent joiner. ---
    const g1Update = once(g1.socket, 'roomUpdate');
    const g2Update = once(g2.socket, 'roomUpdate');
    host.socket.emit('leaveRoom');
    const [u1, u2] = await Promise.all([g1Update, g2Update]);

    check('Surviving players are notified of the new host', !!u1 && !!u2);
    check('Host role transfers to the longest-present remaining player', u1.hostId === g1.id);
    check('The later joiner is not promoted', u1.hostId !== g2.id);
    check('The departed host is dropped from the roster', !u1.players.some((p) => p.id === host.id));
    const earlyRow = u1.players.find((p) => p.id === g1.id);
    check('New host carries the isHost flag in the roster', !!earlyRow && earlyRow.isHost === true);
    check('Room still reports it can start with 2 players', u1.canStart === true);

    // --- The promoted player must gain the host-only privileges. A non-host
    //     (g2) still cannot start; the new host (g1) can. ---
    const g2Denied = once(g2.socket, 'errorMsg');
    g2.socket.emit('startGame');
    const denied = await g2Denied;
    check('Non-host still cannot start after succession', /host/i.test(denied.message || ''));

    const started = once(g1.socket, 'gameStarted');
    g1.socket.emit('startGame');
    const gs = await started;
    check('Promoted host can start the match', !!gs);

    // Return to lobby for the chained-succession check.
    g1.socket.emit('leaveRoom'); // ends match (drops to 1); g2 wins and stays.
    await once(g2.socket, 'gameOver');
    // g2 is now alone; joinOrder[0] is g2, so it should be the host now.
    const g3 = track(await mkPlayer(url, 'Third'));
    g3.socket.emit('joinRoom', { code });
    const afterJoin = await once(g3.socket, 'roomUpdate');
    check('Succession chains: last remaining player holds the host role', afterJoin.hostId === g2.id);
  } finally {
    for (const s of sockets) s.close();
  }
}

server.listen(0, async () => {
  const port = server.address().port;
  console.log(`Host-succession test server on port ${port}\n`);
  try {
    await run(port);
  } catch (err) {
    console.error('\nHost-succession test error:', err.message);
    FAIL.push('unexpected error: ' + err.message);
  }
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  server.close();
  process.exit(FAIL.length === 0 ? 0 : 1);
});
