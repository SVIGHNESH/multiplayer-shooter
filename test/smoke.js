'use strict';

// End-to-end smoke test for the server: exercises register -> create ->
// join by code -> invite by ID -> start -> movement/shooting -> kill credit,
// using two real socket.io-client connections against a live server instance.

const { io } = require('socket.io-client');
const { server } = require('../server');
const { once, wait, hunt } = require('./helpers');

const PASS = [];
const FAIL = [];

function check(name, cond) {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

async function run(port) {
  const url = `http://localhost:${port}`;
  const a = io(url, { transports: ['websocket'] });
  const b = io(url, { transports: ['websocket'] });

  try {
    // --- Register both players ---
    a.emit('register', { name: 'Alice' });
    b.emit('register', { name: 'Bob' });
    const regA = await once(a, 'registered');
    const regB = await once(b, 'registered');
    check('Alice gets a P- player id', /^P-[A-Z0-9]{4}$/.test(regA.playerId));
    check('Bob gets a distinct player id', regB.playerId && regB.playerId !== regA.playerId);

    // --- Alice creates a room ---
    a.emit('createRoom');
    const roomA = await once(a, 'roomUpdate');
    check('Room code is 6 chars', /^[A-Z0-9]{6}$/.test(roomA.code));
    check('Creator is host', roomA.hostId === regA.playerId);
    check('Room starts in lobby', roomA.state === 'lobby');

    // --- Bob joins by code ---
    b.emit('joinRoom', { code: roomA.code });
    const roomB = await once(b, 'roomUpdate');
    check('Bob joined the room by code', roomB.players.length === 2);
    check('Room reports it can start with 2 players', roomB.canStart === true);

    // --- Invite by ID: Alice invites Bob (already in room she can, but test flow with a 3rd) ---
    const c = io(url, { transports: ['websocket'] });
    c.emit('register', { name: 'Carol' });
    const regC = await once(c, 'registered');
    a.emit('invitePlayer', { playerId: regC.playerId });
    const invite = await once(c, 'inviteReceived');
    check('Carol receives an invite with room code', invite.code === roomA.code);
    check('Invite carries host name', invite.hostName === 'Alice');
    const inviteResult = await once(a, 'inviteResult');
    check('Host told invite was sent', inviteResult.status === 'sent');
    c.emit('inviteResponse', { accepted: true, code: invite.code });
    const accepted = await once(a, 'inviteResult');
    check('Host told invite accepted', accepted.status === 'accepted');

    // --- Start the game (host only) ---
    const startedA = once(a, 'gameStarted');
    const startedB = once(b, 'gameStarted');
    a.emit('startGame');
    const gs = await startedA;
    await startedB;
    check('gameStarted sends arena world', gs.world && gs.world.width === 1600);
    check('gameStarted sends obstacles', Array.isArray(gs.obstacles) && gs.obstacles.length > 0);

    // --- Receive at least one state snapshot ---
    const snap = await once(a, 'state');
    check('State snapshot lists all players', snap.players.length === 3);
    check('State snapshot has a scores array', Array.isArray(snap.scores));

    // --- Movement: Alice moves right, expect her x to increase ---
    const before = snap.players.find((p) => p.id === regA.playerId);
    a.emit('input', { right: true, angle: 0, shooting: false });
    await wait(300);
    const snap2 = await once(a, 'state');
    const after = snap2.players.find((p) => p.id === regA.playerId);
    check('Player moves right when input sent', after.x > before.x);
    a.emit('input', { right: false, angle: 0, shooting: false });

    // --- Shooting + kill credit: chase Bob down and fire ---
    // We verify that a killFeed fires and Alice ends up with a scoreboard entry.
    // Alice hunts the passive Bob using the shared, obstacle-aware hunt() driver
    // (stuck-detection + snapshot resilience) so the kill lands reliably even
    // when spawns place cover between them or the machine is under load.
    let killed = false;
    const killFeedP = once(a, 'killFeed', 30000).then(() => { killed = true; }).catch(() => {});
    await hunt(a, regA.playerId, regB.playerId, () => killed, 25000);
    await Promise.race([killFeedP, wait(500)]);
    check('A kill was registered (killFeed fired)', killed);

    const finalSnap = await once(a, 'state');
    const aliceScore = finalSnap.scores.find((p) => p.id === regA.playerId);
    check('Alice has a scoreboard entry', !!aliceScore);

    c.close();
  } finally {
    a.close();
    b.close();
  }
}

server.listen(0, async () => {
  const port = server.address().port;
  console.log(`Smoke test server on port ${port}\n`);
  try {
    await run(port);
  } catch (err) {
    console.error('\nSmoke test error:', err.message);
    FAIL.push('unexpected error: ' + err.message);
  }
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  server.close();
  process.exit(FAIL.length === 0 ? 0 : 1);
});
