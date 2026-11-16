'use strict';

/**
 * Remplissage : ajoute N robots a une salle existante pour tester l'interface
 * a plusieurs. Ils jouent leur role mais laissent l'hote (humain) gerer le rythme.
 *
 *   node test/fill.js N965 "Zoe,Karim,Nino"
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 3100;
const URL = `ws://127.0.0.1:${PORT}`;
const code = (process.argv[2] || '').toUpperCase();
const names = (process.argv[3] || 'Zoe,Karim,Nino').split(',').map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

if (!code) {
  console.log('usage : node test/fill.js CODE "Nom1,Nom2,Nom3"');
  process.exit(1);
}

names.forEach((name, i) => {
  const ws = new WebSocket(URL);
  const done = {};

  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', code, name })));
  ws.on('error', (e) => console.log(`${name}: ${e.message}`));

  ws.on('message', (raw) => {
    const s = JSON.parse(raw.toString());
    if (s.t === 'error') return console.log(`${name}: ${s.message}`);
    if (s.t !== 'state') return;
    const me = s.me;
    const round = `${s.day}:${s.phase}`;

    if (s.phase === 'over') {
      if (!done['over' + s.day]) {
        done['over' + s.day] = 1;
        console.log(`${name}: partie finie (${s.winner}), j'attends la relance`);
      }
      return;
    }

    if (s.phase === 'cupid' && me.alive && me.role === 'cupid' && !done.cupid) {
      done.cupid = 1;
      const others = s.players.filter((p) => p.alive && !p.isMe);
      return ws.send(JSON.stringify({ t: 'cupid', lovers: [pick(others).id, pick(others).id] }));
    }

    if (s.phase === 'night' && me.alive && !me.acted && !done['n' + round]) {
      done['n' + round] = 1;
      const others = s.players.filter((p) => p.alive && !p.isMe);
      if (!others.length) return;
      setTimeout(() => {
        if (me.role === 'wolf') {
          const prey = others.filter((p) => p.role !== 'wolf');
          ws.send(JSON.stringify({ t: 'night', target: pick(prey.length ? prey : others).id }));
        } else if (me.role === 'seer') {
          ws.send(JSON.stringify({ t: 'night', target: pick(others).id }));
        } else if (me.role === 'guard') {
          const ok = s.players.filter((p) => p.alive && p.id !== me.lastGuard);
          ws.send(JSON.stringify({ t: 'night', target: pick(ok.length ? ok : others).id }));
        } else if (me.role === 'witch') {
          ws.send(JSON.stringify({ t: 'night', action: 'pass' }));
        }
      }, 900 + i * 400);
    }

    if (s.phase === 'vote' && me.alive && !me.voted && !done['v' + round]) {
      done['v' + round] = 1;
      const targets = s.players.filter((p) => p.alive && !p.isMe);
      setTimeout(() => {
        if (!targets.length) return ws.send(JSON.stringify({ t: 'vote', action: 'abstain' }));
        ws.send(JSON.stringify({ t: 'vote', target: pick(targets).id }));
      }, 1200 + i * 500);
    }

    if (s.phase === 'hunter' && s.pendingHunter === me.id && !done['h' + round]) {
      done['h' + round] = 1;
      const targets = s.players.filter((p) => p.alive);
      setTimeout(() => ws.send(JSON.stringify({ t: 'hunter', target: targets.length ? pick(targets).id : null })), 800);
    }
  });

  ws.on('close', () => console.log(`${name}: deconnecte`));
  sleep(0);
});

setInterval(() => {}, 1 << 30); // garde le process en vie
