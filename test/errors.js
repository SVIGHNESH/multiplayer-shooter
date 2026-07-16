'use strict';

// End-to-end coverage for the room system's negative/guard paths, which the
// happy-path smoke and match tests never exercise. The plan promises clear
// errors when a join is blocked (bad code, mid-game, full room) plus host-only
// guards and the invite notfound/self/decline outcomes; this locks all of that in.

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
  return { socket, id: reg.playerId };
}

async function run(port) {
  const url = `http://localhost:${port}`;
  const sockets = [];
  const track = (p) => { sockets.push(p.socket); return p; };

  try {
    // --- Setup: a host with a real room, and a lone bystander ---
    const host = track(await mkPlayer(url, 'Host'));
    host.socket.emit('createRoom');
    const room = await once(host.socket, 'roomUpdate');
    const code = room.code;

    const lone = track(await mkPlayer(url, 'Lone'));

    // --- Bad room code is rejected with a clear error ---
    lone.socket.emit('joinRoom', { code: 'ZZZZZZ' });
    const badCode = await once(lone.socket, 'errorMsg');
    check('Joining a non-existent code errors', /no room with that code/i.test(badCode.message));

    // --- Empty code is rejected ---
    lone.socket.emit('joinRoom', { code: '   ' });
    const emptyCode = await once(lone.socket, 'errorMsg');
    check('Joining with an empty code errors', /enter a room code/i.test(emptyCode.message));

    // --- Start with only the host (needs 2+) is blocked ---
    host.socket.emit('startGame');
    const tooFew = await once(host.socket, 'errorMsg');
    check('Starting with <2 players errors', /at least 2 players/i.test(tooFew.message));

    // --- A second player joins so the room is startable ---
    const guest = track(await mkPlayer(url, 'Guest'));
    guest.socket.emit('joinRoom', { code });
    await once(guest.socket, 'roomUpdate');

    // --- Non-host cannot start the match ---
    guest.socket.emit('startGame');
    const notHostStart = await once(guest.socket, 'errorMsg');
    check('Non-host starting the match errors', /only the host can start/i.test(notHostStart.message));

    // --- Non-host cannot invite ---
    guest.socket.emit('invitePlayer', { playerId: lone.id });
    const notHostInvite = await once(guest.socket, 'inviteResult');
    check('Non-host invite is rejected', notHostInvite.status === 'error' && /only the host/i.test(notHostInvite.message));

    // --- Inviting an unknown player id reports notfound ---
    host.socket.emit('invitePlayer', { playerId: 'P-XXXX' });
    const notFound = await once(host.socket, 'inviteResult');
    check('Inviting an unknown id reports notfound', notFound.status === 'notfound');

    // --- Host cannot invite themselves ---
    host.socket.emit('invitePlayer', { playerId: host.id });
    const selfInvite = await once(host.socket, 'inviteResult');
    check('Self-invite is rejected', selfInvite.status === 'error' && /cannot invite yourself/i.test(selfInvite.message));

    // --- Declining an invite notifies the host ---
    host.socket.emit('invitePlayer', { playerId: lone.id });
    const invite = await once(lone.socket, 'inviteReceived');
    await once(host.socket, 'inviteResult'); // the 'sent' ack
    lone.socket.emit('inviteResponse', { accepted: false, code: invite.code });
    const declined = await once(host.socket, 'inviteResult');
    check('Declining an invite tells the host', declined.status === 'declined' && declined.targetName === 'Lone');

    // --- Accepting an invite you can't actually fulfill still notifies the host ---
    // (plan: "the host is notified of the outcome either way"). Here the invitee is
    // already in their own room, so the accept fails and the host must hear 'failed'.
    const inviteHost = track(await mkPlayer(url, 'InviteHost'));
    inviteHost.socket.emit('createRoom');
    const r2 = await once(inviteHost.socket, 'roomUpdate');
    const busy = track(await mkPlayer(url, 'Busy'));
    busy.socket.emit('createRoom'); // busy now sits in their own room
    await once(busy.socket, 'roomUpdate');
    inviteHost.socket.emit('invitePlayer', { playerId: busy.id });
    const busyInvite = await once(busy.socket, 'inviteReceived');
    await once(inviteHost.socket, 'inviteResult'); // the 'sent' ack
    busy.socket.emit('inviteResponse', { accepted: true, code: busyInvite.code });
    const failed = await once(inviteHost.socket, 'inviteResult');
    check('Accept that cannot join notifies host as failed',
      failed.status === 'failed' && failed.targetName === 'Busy');
    void r2;

    // --- Joining a match that is already in progress is blocked ---
    const started = once(host.socket, 'gameStarted');
    host.socket.emit('startGame');
    await started;
    lone.socket.emit('joinRoom', { code });
    const midGame = await once(lone.socket, 'errorMsg');
    check('Joining a mid-game room errors', /already in progress/i.test(midGame.message));

    // --- Full room (cap 8) rejects the 9th joiner ---
    const fullHost = track(await mkPlayer(url, 'FullHost'));
    fullHost.socket.emit('createRoom');
    const fullRoom = await once(fullHost.socket, 'roomUpdate');
    for (let i = 0; i < 7; i++) {
      const g = track(await mkPlayer(url, 'F' + i));
      g.socket.emit('joinRoom', { code: fullRoom.code });
      await once(g.socket, 'roomUpdate');
    }
    const ninth = track(await mkPlayer(url, 'Ninth'));
    ninth.socket.emit('joinRoom', { code: fullRoom.code });
    const full = await once(ninth.socket, 'errorMsg');
    check('9th joiner into an 8-player room is rejected as full', /room is full/i.test(full.message));
  } finally {
    for (const s of sockets) s.close();
  }
}

server.listen(0, async () => {
  const port = server.address().port;
  console.log(`Error-path test server on port ${port}\n`);
  try {
    await run(port);
  } catch (err) {
    console.error('\nError-path test error:', err.message);
    FAIL.push('unexpected error: ' + err.message);
  }
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  server.close();
  process.exit(FAIL.length === 0 ? 0 : 1);
});
