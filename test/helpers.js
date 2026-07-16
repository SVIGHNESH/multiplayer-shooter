'use strict';

// Shared primitives for the socket-level E2E tests.
//
// The gameplay-driving tests (smoke, match) both need to make one bot bot
// reliably kill another against the server-authoritative simulation. Doing that
// robustly - regardless of random spawn placement, obstacles between the two
// players, and delayed state snapshots when the CI machine is under load - is
// subtle enough that it lives here once rather than being copy-pasted (and
// drifting) across test files.

function once(socket, event, timeout = 4000) {
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

// Drive `hunter` toward `prey`, aiming and continuously firing, until `done()`
// returns true or the deadline passes.
//
// Robustness properties that keep the gameplay-driven assertions from flaking:
//   - Stuck-detection: when the hunter wedges against an obstacle (its position
//     barely changes while it intends to move), it strafes perpendicular to the
//     pursuit direction for a burst of ticks to slide around cover. Without this
//     a naive cardinal-direction chase can wedge forever behind an obstacle and
//     never land a shot.
//   - Snapshot resilience: a single delayed/missed state snapshot (common when
//     the machine is under load) does NOT abandon the hunt - the loop simply
//     retries until the wall-clock deadline. Breaking out on the first missed
//     snapshot was the cause of the intermittent "no kill / gameOver timeout"
//     failures under CPU contention.
async function hunt(hunter, hunterId, preyId, done, deadlineMs = 40000, startMs) {
  const start = startMs !== undefined ? startMs : Date.now();
  let lastX = null, lastY = null, stuckTicks = 0;
  let dodgeTicksLeft = 0, dodgeDir = 1;
  while (!done() && Date.now() - start < deadlineMs) {
    let s;
    try {
      // Generous per-snapshot wait; on timeout we retry rather than give up so
      // transient snapshot delays under load can't end the hunt prematurely.
      s = await once(hunter, 'state', 3000);
    } catch {
      continue;
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

      // Wedged against cover: strafe perpendicular to the pursuit direction to
      // slide around the obstacle. The strafe COMMITS to one direction for a
      // burst of consecutive ticks (a short wall-follow) rather than flipping
      // every tick - alternating per tick just jitters the bot in place and it
      // never clears the corner. Each new stuck episode flips the direction, so
      // if one way is blocked the next episode tries the other.
      if (stuckTicks >= 3 && dodgeTicksLeft <= 0) {
        dodgeTicksLeft = 10;
        dodgeDir = -dodgeDir;
        stuckTicks = 0;
      }
      if (dodgeTicksLeft > 0) {
        const perpHorizontal = Math.abs(dx) < Math.abs(dy);
        cmd = perpHorizontal
          ? { right: dodgeDir > 0, left: dodgeDir < 0, up: false, down: false }
          : { up: dodgeDir > 0, down: dodgeDir < 0, left: false, right: false };
        dodgeTicksLeft--;
      }

      hunter.emit('input', { ...cmd, angle: Math.atan2(dy, dx), shooting: true });
    }
    await wait(40);
  }
  hunter.emit('input', { right: false, left: false, down: false, up: false, angle: 0, shooting: false });
}

module.exports = { once, wait, hunt };
