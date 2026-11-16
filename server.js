'use strict';

/**
 * Transport Node/WebSocket du loup-garou.
 * Toute la logique de jeu est dans public/engine.js, partagee avec la version
 * GitHub Pages (onglet hote en WebRTC).
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const E = require('./public/engine.js');

const PORT = process.env.PORT || 3000;
E.setMinPlayers(process.env.MIN_PLAYERS || 5);

const rooms = E.rooms;

/* ------------------------------------------------------------------ */
/* Diffusion                                                          */
/* ------------------------------------------------------------------ */

function broadcast(room) {
  const now = Date.now();
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) {
      try {
        p.ws.send(JSON.stringify(E.view(room, p, now)));
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function errorTo(playerId, message) {
  for (const room of rooms.values()) {
    const p = room.players.find((x) => x.id === playerId);
    if (p && p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ t: 'error', message: message }));
      return;
    }
  }
}

const ctx = { broadcast: broadcast, error: errorTo };

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ------------------------------------------------------------------ */
/* WebSocket                                                          */
/* ------------------------------------------------------------------ */

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws && player.ws.readyState === 1) {
    try {
      send(player.ws, { t: 'kicked', reason: 'ouvert ailleurs' });
      player.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
  player.ws = ws;
  player.connected = true;
  ws.room = room;
  ws.player = player;
  room.lastActivity = Date.now();
  send(ws, { t: 'joined', code: room.code, token: player.token, id: player.id });
  broadcast(room);
}

function joinRoom(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  const token = msg.token ? String(msg.token) : null;
  let room = code ? rooms.get(code) : null;

  if (room) {
    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        if (msg.name) existing.name = String(msg.name).trim().slice(0, 14) || existing.name;
        return attach(ws, room, existing);
      }
    }
    if (room.phase !== 'lobby') {
      return send(ws, { t: 'error', fatal: true, message: 'La partie a déjà commencé.' });
    }
    if (room.players.length >= 20) {
      return send(ws, { t: 'error', fatal: true, message: 'La salle est pleine (20 max).' });
    }
  } else {
    if (code) return send(ws, { t: 'error', fatal: true, message: 'Aucune partie avec ce code.' });
    room = E.newRoom(ctx);
  }

  const player = E.newPlayer(room, msg.name);
  ws.room = room;
  ws.player = player;
  player.ws = ws;
  send(ws, { t: 'joined', code: room.code, token: player.token, id: player.id });
  broadcast(room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString().slice(0, 4000));
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') return joinRoom(ws, msg);
    if (msg.t === 'ping') return send(ws, { t: 'pong' });

    const room = ws.room;
    const me = ws.player;
    if (!room || !me || !E.findPlayer(room, me.id)) return;

    E.handle(room, me, msg);
  });

  ws.on('close', () => {
    const room = ws.room;
    const me = ws.player;
    if (!room || !me) return;
    me.connected = false;
    if (me.ws === ws) me.ws = null;
    if (me.isHost) {
      me.isHost = false;
      E.ensureHost(room);
    }
    broadcast(room);
  });
});

/* ------------------------------------------------------------------ */
/* Battements                                                         */
/* ------------------------------------------------------------------ */

setInterval(() => {
  for (const room of rooms.values()) E.tick(room);
}, 200);

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.deadline) broadcast(room);
  }
}, 1000);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      /* ignore */
    }
  }
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.lastActivity;
    const empty = !room.players.some((p) => p.connected);
    if ((empty && idle > 10 * 60 * 1000) || idle > 6 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 60000);

/* ------------------------------------------------------------------ */
/* Demarrage                                                          */
/* ------------------------------------------------------------------ */

server.listen(PORT, () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let ip = null;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ip = ip || net.address;
    }
  }

  console.log('');
  console.log(`  Loup-garou  ->  http://localhost:${PORT}`);
  if (ip) {
    console.log(`  En classe   ->  http://${ip}:${PORT}   (meme wifi, scanne le QR)`);
    if (process.platform !== 'win32') {
      QRCode.toString(`http://${ip}:${PORT}`, { type: 'terminal', small: true })
        .then((qr) => console.log(qr))
        .catch(() => {});
    }
  }
  console.log('  Ouvre le navigateur, cree une partie, fais scanner le code.');
  console.log('');
});
