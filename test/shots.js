'use strict';

// Visual playtest harness: launches the server + a headless Chromium, drives two
// tabs through the full flow (home -> lobby -> match -> game over), and writes PNG
// screenshots of every UI surface to test/shots/ for pixel-level inspection.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const OUT_DIR = path.join(__dirname, 'shots');
const CHROME = '/usr/bin/chromium';
const CDP_PORT = 9333;
const VIEW = { width: 1280, height: 800 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json: ' + body)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForCdp() {
  for (let i = 0; i < 100; i++) {
    try { return await httpJson(CDP_PORT, '/json/version'); }
    catch { await sleep(100); }
  }
  throw new Error('CDP never came up');
}

// Minimal CDP page driver over a single websocket.
class Page {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (m) => {
        const msg = JSON.parse(m);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  shot:', name + '.png');
  }
  close() { try { this.ws.close(); } catch {} }
}

async function newPage(browserWsBase, targetUrl) {
  const target = await httpJson(CDP_PORT, '/json/new?' + encodeURIComponent(targetUrl), 'PUT');
  const page = new Page(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });
  return page;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Start the game server on a fixed port with a low win target for a quick match.
  const env = { ...process.env, PORT: '3210', KILLS_TO_WIN: '3', RESPAWN_MS: '600' };
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'inherit' });
  await sleep(800);

  // 2. Launch headless Chromium with remote debugging in its own process group and
  //    a throwaway profile so a prior run's children can't hold the debug port.
  const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shooter-shots-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + CDP_PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDataDir,
    '--window-size=' + VIEW.width + ',' + VIEW.height,
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  await waitForCdp();

  const url = 'http://127.0.0.1:3210/';
  let host, guest;
  try {
    host = await newPage(null, url);
    guest = await newPage(null, url);
    await sleep(600);

    // ---- Regression guard: overlays with the `hidden` attribute must not render.
    //      (`.overlay { display: flex }` would otherwise override `hidden`.) ----
    const leaked = await host.eval(`
      ['gameover','invite-popup','toast'].filter((id) => {
        const el = document.getElementById(id);
        return el && el.offsetParent !== null; // offsetParent null => not rendered
      })`);
    if (leaked.length) {
      throw new Error('Hidden overlays are rendering on load: ' + leaked.join(', '));
    }
    console.log('  guard: hidden overlays correctly not rendered on load');

    // ---- Home screen ----
    await host.eval(`document.getElementById('name-input').value = 'Ghost'; true`);
    await host.shot('01-home');

    // ---- Host creates a room ----
    await host.eval(`document.getElementById('btn-create').click(); true`);
    await sleep(500);
    const code = await host.eval(`document.getElementById('room-code').textContent`);
    console.log('  room code:', code);
    await host.shot('02-lobby-host-waiting');

    // ---- Guest joins by code ----
    await guest.eval(`document.getElementById('name-input').value = 'Reaper'; true`);
    await guest.eval(`document.getElementById('join-code-input').value = ${JSON.stringify(code)}; document.getElementById('btn-join').click(); true`);
    await sleep(600);
    await host.shot('03-lobby-host-ready');
    await guest.shot('04-lobby-guest');

    // ---- Start the match ----
    await host.eval(`document.getElementById('btn-start').click(); true`);
    await sleep(800);

    // Drive both players toward each other and shoot to populate the HUD.
    await host.eval(`window.__drive = () => { input.right = true; input.shooting = true; }; __drive(); true`).catch(() => {});
    await guest.eval(`input.left = true; input.up = true; input.shooting = true; true`).catch(() => {});
    await sleep(1200);
    await host.shot('05-ingame-host');
    await guest.shot('06-ingame-guest');

    // ---- Scoreboard (Tab) ----
    await host.eval(`document.getElementById('scoreboard').hidden = false; true`);
    await host.shot('07-scoreboard');
    await host.eval(`document.getElementById('scoreboard').hidden = true; true`);

    // ---- Muzzle flash (inject fresh flashes anchored to the local player) ----
    const flashN = await host.eval(`
      const me = state.curr && state.curr.players.get(state.myId);
      if (me) {
        const now = performance.now();
        // Offset toward the arena interior so the burst stays on-screen even
        // when the player is clamped against an arena edge.
        const ox = me.x < 800 ? 40 : -40;
        const oy = me.y < 600 ? 40 : -40;
        state.muzzleFlashes.push({ x: me.x, y: me.y, born: now, color: '#ffd740' });
        state.muzzleFlashes.push({ x: me.x + ox, y: me.y + oy, born: now, color: '#40c4ff' });
      }
      state.muzzleFlashes.length`);
    console.log('  muzzle flashes queued:', flashN);
    await sleep(25);
    await host.shot('07c-muzzle-flash');

    // ---- Damage vignette (force the flash to full strength and capture) ----
    await host.eval(`
      state.damageFlashStrength = 0.6;
      state.damageFlashUntil = performance.now() + 5000;
      true`);
    await sleep(120);
    await host.shot('07b-damage-flash');
    await host.eval(`state.damageFlashUntil = 0; true`);

    // ---- Respawn overlay (simulate a dead local player snapshot) ----
    await host.eval(`document.getElementById('respawn-overlay').hidden = false; document.getElementById('respawn-secs').textContent = '2'; true`);
    await host.shot('08-respawn');
    await host.eval(`document.getElementById('respawn-overlay').hidden = true; true`);

    // ---- Drive to game over ----
    for (let i = 0; i < 40; i++) {
      const over = await host.eval(`document.getElementById('gameover').hidden === false`);
      if (over) break;
      // keep both firing and moving
      await host.eval(`input.right = !input.right; input.down = !input.down; input.shooting = true; true`).catch(() => {});
      await guest.eval(`input.left = !input.left; input.up = !input.up; input.shooting = true; true`).catch(() => {});
      await sleep(400);
    }
    let isOver = await host.eval(`document.getElementById('gameover').hidden === false`);
    if (!isOver) {
      // Fall back to rendering the overlay directly so the surface is still verified.
      await host.eval(`
        document.getElementById('winner-line').textContent = 'Ghost wins!';
        const rows = [['1','Ghost','3','1'],['2','Reaper','1','3']];
        document.getElementById('standings-body').innerHTML =
          rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('');
        document.getElementById('gameover').hidden = false;
        true`);
    }
    await host.shot('09-gameover');

    // ---- Invite popup (render on guest by triggering the handler) ----
    await guest.eval(`
      state.pendingInvite = { hostName: 'Ghost', code: ${JSON.stringify(code)} };
      document.getElementById('invite-text').innerHTML = '<strong>Ghost</strong> invited you to room <strong>' + ${JSON.stringify(code)} + '</strong>.';
      document.getElementById('invite-popup').hidden = false;
      true`);
    await guest.shot('10-invite-popup');

    console.log('\nAll screenshots written to', OUT_DIR);
  } finally {
    if (host) host.close();
    if (guest) guest.close();
    // Kill the whole Chromium process group (headless spawns child processes).
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch { try { chrome.kill('SIGKILL'); } catch {} }
    server.kill('SIGKILL');
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
