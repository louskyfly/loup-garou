'use strict';

/**
 * Simulation : N robots jouent une partie complete contre le vrai serveur.
 * But : verifier que la machine a etats ne se bloque jamais et qu'aucune
 * information secrete ne fuit.  Usage : node test/sim.js [nbJoueurs]
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 3100;
const URL = `ws://127.0.0.1:${PORT}`;
const N = Number(process.argv[2] || 7);
const GAMES = Number(process.argv[3] || 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let finished = 0;
let failures = 0;
let leaks = 0;
const doneGames = new Set();

class Bot {
  constructor(i) {
    this.i = i;
    this.name = 'Bot' + i;
    this.ws = null;
    this.state = null;
    this.done = {};
    this.code = null;
    this.game = 0;
  }

  open() {
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'joined') this.code = m.code;
      if (m.t === 'state') this.onState(m);
      if (m.t === 'error') console.log(`[bot${this.i}] erreur: ${m.message}`);
    });
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ t: 'join', code: this.code, name: this.name }));
    });
    this.ws.on('close', () => console.log(`[bot${this.i}] socket fermee`));
    this.ws.on('error', (e) => console.log(`[bot${this.i}] ${e.message}`));
  }

  send(o) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  }

  once(key) {
    if (this.done[key]) return false;
    this.done[key] = true;
    return true;
  }

  checkLeaks(s) {
    if (s.phase === 'over') return;
    const lovers = s.me.lovers || [];
    for (const p of s.players) {
      if (p.isMe || !p.role) continue;
      const okWolf = s.me.role === 'wolf' && p.role === 'wolf';
      const okLover = lovers.includes(p.id);
      if (!okWolf && !okLover) {
        leaks++;
        console.log(`FUITE : bot${this.i} voit ${p.name} = ${p.role} en phase ${s.phase}`);
      }
    }
  }

  onState(s) {
    this.state = s;
    this.checkLeaks(s);
    const me = s.me;
    const round = `${this.game}:${s.day}`;

    if (s.phase === 'lobby') {
      if (me.isHost && s.players.length === N && this.once('start' + this.game)) {
        setTimeout(() => this.send({ t: 'start' }), 80);
      }
      return;
    }

    if (s.phase === 'over') {
      if (this.once('over' + this.game)) {
        if (!doneGames.has(this.game)) {
          doneGames.add(this.game);
          finished++;
          const wolves = s.players.filter((p) => p.role === 'wolf').map((p) => p.name);
          console.log(
            `partie ${this.game} : ${s.winner} en ${s.day} jours ` +
              `(loups: ${wolves.join(', ') || 'aucun'})`
          );
        }
        if (finished >= GAMES) {
          setTimeout(() => {
            console.log(
              (failures || leaks ? 'ECHEC' : 'OK') +
                ` : ${finished} partie(s) terminee(s), ${leaks} fuite(s) d'information`
            );
            process.exit(failures || leaks ? 1 : 0);
          }, 300);
        }
      }
      return;
    }

    if (s.phase === 'cupid') {
      if (!me.alive) return;
      if (me.role === 'cupid' && this.once('cupid' + round)) {
        const others = s.players.filter((p) => p.alive && !p.isMe);
        this.send({ t: 'cupid', lovers: [pick(others).id, pick(others).id] });
      }
      return;
    }

    if (s.phase === 'night') {
      if (!me.alive) return;
      if (me.acted) return;
      if (this.done['n' + round]) return;
      const alive = s.players.filter((p) => p.alive);
      const others = alive.filter((p) => !p.isMe);
      if (!others.length) return;
      this.done['n' + round] = true;

      if (me.role === 'wolf') {
        const prey = others.filter((p) => p.role !== 'wolf');
        this.send({ t: 'night', target: pick(prey.length ? prey : others).id });
      } else if (me.role === 'seer') {
        this.send({ t: 'night', target: pick(others).id });
      } else if (me.role === 'guard') {
        const ok = alive.filter((p) => p.id !== me.lastGuard);
        this.send({ t: 'night', target: pick(ok.length ? ok : alive).id });
      } else if (me.role === 'witch') {
        const r = Math.random();
        if (r < 0.3) this.send({ t: 'night', action: 'heal' });
        else if (r < 0.6 && me.potions.poison) this.send({ t: 'night', action: 'poison', target: pick(others).id });
        else this.send({ t: 'night', action: 'pass' });
      }
      return;
    }

    if (s.phase === 'day') {
      if (me.isHost && this.once('day' + round)) setTimeout(() => this.send({ t: 'skip' }), 250);
      return;
    }

    if (s.phase === 'vote') {
      if (!me.alive) return;
      if (me.voted) return;
      if (this.done['v' + round]) return;
      this.done['v' + round] = true;
      const targets = s.players.filter((p) => p.alive && !p.isMe);
      if (!targets.length) return this.send({ t: 'vote', action: 'abstain' });
      this.send({ t: 'vote', target: pick(targets).id });
      return;
    }

    if (s.phase === 'hunter') {
      if (s.pendingHunter === me.id && this.once('h' + round)) {
        const targets = s.players.filter((p) => p.alive);
        this.send({ t: 'hunter', target: targets.length ? pick(targets).id : null });
      }
      return;
    }

    if (s.phase === 'dawn' || s.phase === 'verdict') {
      if (me.isHost && this.once('s' + round + s.phase)) setTimeout(() => this.send({ t: 'skip' }), 250);
      return;
    }
  }
}

const bots = [];

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(40);
  }
  return false;
}

async function runGroup(game) {
  const group = [];
  for (let i = 0; i < N; i++) group.push(new Bot(game * N + i));
  bots.push(...group);

  const first = group[0];
  first.open();
  if (!(await waitFor(() => first.code, 4000))) {
    console.log('la salle n\'a pas ete creee');
    failures++;
    return;
  }
  for (const b of group.slice(1)) {
    b.code = first.code;
    b.open();
    await sleep(70);
  }
}

async function run() {
  for (let g = 0; g < GAMES; g++) await runGroup(g);
}

const timeout = setTimeout(() => {
  console.log('TIMEOUT : la partie ne s\'est pas terminee');
  for (const b of bots) {
    if (b.state) console.log(`bot${b.i} ${b.state.phase} jour ${b.state.day} vivant=${b.state.me.alive}`);
  }
  process.exit(2);
}, 120000);

run();

process.on('exit', () => clearTimeout(timeout));
