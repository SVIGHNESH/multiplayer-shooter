# Multiplayer Shooter - Implementation Plan

## Overview

A 2D top-down multiplayer arena shooter playable in the browser.
Players move with WASD, aim with the mouse, and shoot each other in a shared arena.
The core multiplayer feature is a room system: a player creating a game either gets an auto-generated room code to share, or directly invites another online player by their player ID.

## Tech Stack

- **Server:** Node.js with Express (static file serving) and Socket.IO (real-time communication).
- **Client:** Plain HTML5 Canvas + vanilla JavaScript, no framework or build step.
- **Architecture:** Server-authoritative game simulation.
  The server runs the physics tick and broadcasts state; clients only send inputs and render.
  This keeps the game cheat-resistant and avoids desync between players.

## Project Structure

```
multiplayer-shooter/
├── package.json
├── server.js            # Express + Socket.IO server, room manager, game loop
├── plan.md              # This file
└── public/
    ├── index.html       # Lobby UI + game canvas
    ├── style.css        # UI styling
    └── game.js          # Client: lobby flow, input capture, rendering
```

## Identity and Room System

### Player ID

- On connecting, every player registers with a display name and receives a short unique player ID (format: `P-XXXX`, e.g. `P-7K2M`).
- The player ID is shown prominently in the lobby so a friend can type it into an invite box.
- The server keeps a registry mapping player ID to socket for invite delivery.

### Creating a Game

When a player creates a game, both join mechanisms are available at once:

1. **Auto-generated room code:** The server generates a 6-character uppercase alphanumeric room code (e.g. `X4T9QZ`) with ambiguous characters (0/O, 1/I) excluded.
   The code is displayed with a copy button so the host can share it anywhere.
2. **Invite by player ID:** The room screen has an invite box where the host types another player's ID.
   The server looks up that player and pushes them an invite popup (host name + room code) with Accept and Decline buttons.
   Accepting joins them into the room instantly; the host is notified of the outcome either way.

### Joining a Game

- **By room code:** Enter the code on the home screen and join directly.
- **By invite:** Accept an incoming invite popup, no typing needed.
- Rooms cap at 8 players.
- Joining is blocked with a clear error if the room is full, mid-game, or the code does not exist.

### Room Lifecycle

- Room states: `lobby` -> `playing` -> back to `lobby` (after a match ends).
- The creator is the host; only the host can start the match (requires 2+ players).
- If the host leaves, host role transfers to the longest-present remaining player.
- Empty rooms are deleted immediately and their game loop is stopped.
- A disconnecting player is removed from their room and the remaining players are notified.

## Gameplay Design

### Arena

- Fixed 1600 x 1200 world with a bounding wall and a handful of rectangular obstacles for cover.
- Obstacles block both player movement and bullets.
- Players spawn at randomized points chosen away from other players.

### Player

- Circle body (radius 18) with a gun barrel indicating aim direction.
- Movement: WASD / arrow keys, speed ~260 px/s, normalized diagonals.
- Health: 100 HP, shown as a bar above each player.
- Death: killed players respawn after 2.5 seconds at a fresh spawn point.
- Each player gets a distinct color assigned by the server.

### Shooting

- Mouse aims (angle from player to cursor), hold left mouse button to fire.
- Fire cooldown: 180 ms between shots.
- Bullets: speed 700 px/s, 25 damage, removed on hitting a wall, obstacle, or player.
- Bullets carry the shooter's ID so kills are credited correctly.

### Match Rules

- Deathmatch: first player to 15 kills wins.
- Scoreboard (kills/deaths) visible in-game via Tab or always-on panel.
- Kill feed messages ("A eliminated B") shown briefly in the HUD.
- On win: game-over overlay with final standings, then everyone returns to the room lobby for a rematch.

## Networking Design

### Server Tick

- Fixed 60 Hz simulation tick per active room: apply inputs, move players and bullets, resolve collisions, handle damage/kills/respawns.
- State snapshots broadcast to the room at 30 Hz (positions, angles, health, scores, bullets).

### Client -> Server Events

| Event | Payload | Purpose |
|---|---|---|
| `register` | `{ name }` | Get assigned a player ID |
| `createRoom` | - | Create room, receive room code |
| `joinRoom` | `{ code }` | Join by room code |
| `invitePlayer` | `{ playerId }` | Host invites a player by ID |
| `inviteResponse` | `{ accepted, code }` | Accept/decline an invite |
| `startGame` | - | Host starts the match |
| `input` | `{ up, down, left, right, angle, shooting }` | Continuous input state (sent ~30 Hz) |
| `leaveRoom` | - | Return to home screen |

### Server -> Client Events

| Event | Purpose |
|---|---|
| `registered` | Confirms name and assigned player ID |
| `roomUpdate` | Lobby roster, host, room code, state |
| `inviteReceived` | Popup an invite (from host name + code) |
| `inviteResult` | Tell host whether invite was delivered/accepted/declined |
| `gameStarted` | Switch clients to the game screen, send arena layout |
| `state` | 30 Hz snapshot of players and bullets |
| `killFeed` | Kill notifications |
| `gameOver` | Winner + final standings, return to lobby |
| `errorMsg` | Human-readable errors (bad code, room full, etc.) |

### Client Rendering

- Full-window canvas, camera centered on the local player and clamped to arena bounds.
- Render order: background grid, obstacles, bullets, players (body, barrel, name, health bar), HUD (scoreboard, kill feed, respawn countdown).
- Linear interpolation between the last two snapshots for smooth remote player motion at 30 Hz snapshots / 60+ fps rendering.

## UI Screens

1. **Home:** name input, then two actions: "Create Game" and "Join with Code".
2. **Room lobby:** big room code with copy button, own player ID, player roster with host badge, invite-by-ID box (host), Start button (host, needs 2+ players).
3. **Invite popup:** shown over any screen when an invite arrives.
4. **Game:** canvas + HUD.
5. **Game over overlay:** winner, standings, "Back to Lobby".

## Implementation Steps

1. Scaffold project: `package.json`, install `express` + `socket.io`.
2. Build `server.js`: connection/registration, player ID registry, room create/join/leave, invite flow.
3. Add the game simulation: tick loop, movement, collisions, bullets, damage, kills, respawn, win condition.
4. Build `index.html` + `style.css`: all lobby screens and popups.
5. Build `game.js`: socket wiring for the lobby flow, then input capture, snapshot interpolation, and canvas rendering.
6. Smoke test: automated script with two `socket.io-client` instances covering register -> create -> join by code -> invite by ID -> start -> movement/shooting -> kill credit.
7. Manual playtest in two browser windows for feel (speeds, cooldowns) and UI polish.

## Out of Scope (for v1)

- Accounts, persistence, or matchmaking beyond codes/invites.
- Client-side prediction and lag compensation (interpolation only; fine for low-latency play).
- Multiple weapons, pickups, or game modes beyond deathmatch.
- Mobile/touch controls.
