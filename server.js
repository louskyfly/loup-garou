'use strict';

/**
 * Loup-Garou -- serveur autoritaire.
 * Le serveur tient l'etat, distribue les roles, cache l'information
 * et envoie a chaque telephone une vue personnalisee.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 5);

/* ------------------------------------------------------------------ */
/* Roles                                                              */
/* ------------------------------------------------------------------ */

const ROLES = {
  villager: {
    name: 'Villageois',
    team: 'village',
    emoji: '\u{1F33E}',
    desc: "Aucun pouvoir. Ton arme : parler, mentir, et voter juste.",
    night: 'Tu dors. Garde les yeux fermés et écoute.',
  },
  wolf: {
    name: 'Loup-garou',
    team: 'wolves',
    emoji: '\u{1F43A}',
    desc: "Chaque nuit, ta meute dévore un habitant. Le jour, fais-toi passer pour un innocent.",
    night: 'Choisis ta proie avec ta meute.',
  },
  seer: {
    name: 'Voyante',
    team: 'village',
    emoji: '\u{1F52E}',
    desc: "Chaque nuit, découvre le rôle exact d'un joueur.",
    night: "Perce le secret d'un joueur.",
  },
  witch: {
    name: 'Sorcière',
    team: 'village',
    emoji: '\u{1F9EA}',
    desc: "Une potion de vie, une potion de mort. Une seule fois chacune.",
    night: "Sauve la victime, ou empoisonne quelqu'un.",
  },
  hunter: {
    name: 'Chasseur',
    team: 'village',
    emoji: '\u{1F3F9}',
    desc: "Si tu meurs, tu emportes quelqu'un avec toi.",
    night: "Tu ne tires qu'en mourant.",
  },
  cupid: {
    name: 'Cupidon',
    team: 'village',
    emoji: '\u{1F498}',
    desc: "La première nuit, désigne deux amoureux : si l'un meurt, l'autre meurt de chagrin.",
    night: 'Désigne deux amoureux.',
  },
  guard: {
    name: 'Salvateur',
    team: 'village',
    emoji: '\u{1F6E1}',
    desc: "Chaque nuit, protège un joueur des loups. Jamais deux nuits de suite la même personne.",
    night: "Protège quelqu'un cette nuit.",
  },
};

const SPECIALS = ['seer', 'witch', 'hunter', 'cupid', 'guard'];

/* ------------------------------------------------------------------ */
/* Utilitaires                                                        */
/* ------------------------------------------------------------------ */

function uid(n = 8) {
  const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function code4() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return rooms.has(s) ? code4() : s;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function counts(values) {
  const map = new Map();
  for (const v of values) {
    if (!v) continue;
    map.set(v, (map.get(v) || 0) + 1);
  }
  return map;
}

/** Renvoie la cible majoritaire, ties tranchees au hasard (usage : loups). */
function majority(values) {
  const map = counts(values);
  if (!map.size) return null;
  const max = Math.max(...map.values());
  const top = [...map.entries()].filter(([, v]) => v === max).map(([k]) => k);
  return top[Math.floor(Math.random() * top.length)];
}

/** Renvoie { top, unique } ou unique=false si egalite (usage : vote du village). */
function tally(values) {
  const map = counts(values);
  if (!map.size) return { top: null, unique: false };
  const max = Math.max(...map.values());
  const top = [...map.entries()].filter(([, v]) => v === max).map(([k]) => k);
  return { top: top[0], unique: top.length === 1 };
}

/* ------------------------------------------------------------------ */
/* Salles                                                             */
/* ------------------------------------------------------------------ */

const rooms = new Map();

function newRoom(code) {
  const room = {
    code,
    phase: 'lobby',
    day: 0,
    players: [],
    chat: [],
    winner: null,
    deadline: 0,
    night: null,
    votes: {},
    lovers: null,
    potions: { heal: true, poison: true },
    seerLog: [],
    lastGuard: null,
    lastVictims: [],
    lastLynch: null,
    pendingHunter: null,
    afterDeaths: 'dawn',
    config: {
      nightMs: 45000,
      dayMs: 180000,
      voteMs: 60000,
      roles: { wolf: 1, seer: 0, witch: 0, hunter: 0, cupid: 0, guard: 0 },
    },
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id) || null;
}

function alive(room) {
  return room.players.filter((p) => p.alive);
}

function hostId(room) {
  const h = room.players.find((p) => p.isHost);
  return h ? h.id : null;
}

function ensureHost(room) {
  if (hostId(room)) return;
  const next = room.players.find((p) => p.connected) || room.players[0];
  if (next) next.isHost = true;
}

function roleCount(room) {
  const c = room.config.roles;
  const wolves = c.wolf || 0;
  const specials = SPECIALS.reduce((s, r) => s + (c[r] || 0), 0);
  return { wolves, specials, villagers: Math.max(0, room.players.length - wolves - specials) };
}

/** Composition raisonnable pour n joueurs, tant que l'hote n'a rien touche. */
function defaultRoles(n) {
  const wolves = Math.max(1, Math.floor(n / 4));
  const r = {
    wolf: wolves,
    seer: n >= 5 ? 1 : 0,
    witch: n >= 7 ? 1 : 0,
    hunter: n >= 9 ? 1 : 0,
    cupid: n >= 10 ? 1 : 0,
    guard: n >= 11 ? 1 : 0,
  };
  while (r.wolf + SPECIALS.reduce((s, k) => s + r[k], 0) > n - 1) {
    if (r.guard) r.guard = 0;
    else if (r.cupid) r.cupid = 0;
    else if (r.hunter) r.hunter = 0;
    else break;
  }
  return r;
}

function applyDefaults(room) {
  if (room.configTouched) return;
  if (room.players.length < 5) return;
  room.config.roles = defaultRoles(room.players.length);
}

function broadcast(room) {
  const now = Date.now();
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) {
      try {
        p.ws.send(JSON.stringify(view(room, p, now)));
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Vue personnalisee : chacun ne voit que ce qu'il a le droit de voir  */
/* ------------------------------------------------------------------ */

function view(room, me, now) {
  const wolves = room.players.filter((p) => p.role === 'wolf').map((p) => p.id);
  const over = room.phase === 'over';
  const isLover = !!(room.lovers && room.lovers.includes(me.id));
  const iAmWolf = me.role === 'wolf';

  const players = room.players
    .map((p) => {
      const known =
        over ||
        p.id === me.id ||
        (iAmWolf && p.role === 'wolf') ||
        (isLover && room.lovers.includes(p.id));
      return {
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        isHost: !!p.isHost,
        isMe: p.id === me.id,
        role: known && p.role ? p.role : null,
        voted: room.phase === 'vote' ? !!room.votes[p.id] : undefined,
        buried: p.buried || null,
      };
    })
    .sort((a, b) => Number(b.alive) - Number(a.alive));

  // La sorciere voit en direct la proie des loups (comme le narrateur le ferait).
  let attacked = null;
  if (me.role === 'witch' && room.phase === 'night' && room.night) {
    attacked = majority(Object.values(room.night.wolfVotes));
  }

  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    day: room.day,
    winner: room.winner,
    msLeft: room.deadline ? Math.max(0, room.deadline - now) : 0,
    totalMs: room.phaseMs || 0,
    players,
    chat: room.chat.slice(-40),
    lastVictims: room.lastVictims,
    lastLynch: room.lastLynch,
    pendingHunter: room.pendingHunter,
    hostId: hostId(room),
    config: room.config,
    composition: roleCount(room),
    canStart: room.players.length >= MIN_PLAYERS,
    minPlayers: MIN_PLAYERS,
    me: {
      id: me.id,
      name: me.name,
      alive: me.alive,
      isHost: !!me.isHost,
      role: me.role,
      roleInfo: me.role ? ROLES[me.role] : null,
      teammates: iAmWolf ? wolves.filter((id) => id !== me.id) : [],
      lovers: isLover ? room.lovers.filter((id) => id !== me.id) : [],
      acted: room.phase === 'night' && room.night ? room.night.done.includes(me.id) : false,
      voted: room.phase === 'vote' ? me.id in room.votes : false,
      potions: me.role === 'witch' ? room.potions : null,
      attacked,
      seerLog: me.role === 'seer' ? room.seerLog : null,
      lastGuard: me.role === 'guard' ? room.lastGuard : null,
      wolfVotes: iAmWolf && room.night ? room.night.wolfVotes : null,
      myPick:
        !room.night || room.phase !== 'night'
          ? null
          : me.role === 'wolf'
          ? room.night.wolfVotes[me.id] || null
          : me.role === 'seer'
          ? room.night.seerPick
          : me.role === 'guard'
          ? room.night.guardPick
          : me.role === 'witch'
          ? { heal: room.night.healSave, poison: room.night.poison }
          : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Boucle de jeu                                                      */
/* ------------------------------------------------------------------ */

function setPhase(room, phase, ms) {
  room.phase = phase;
  room.phaseMs = ms || 0;
  room.deadline = ms ? Date.now() + ms : 0;
  room.lastActivity = Date.now();
  broadcast(room);
}

function startGame(room) {
  const n = room.players.length;
  const c = room.config.roles;
  const list = [];
  for (let i = 0; i < (c.wolf || 0); i++) list.push('wolf');
  for (const r of SPECIALS) for (let i = 0; i < (c[r] || 0); i++) list.push(r);
  while (list.length < n) list.push('villager');
  list.length = n;
  if (!list.includes('wolf')) list[0] = 'wolf';
  shuffle(list);

  room.players.forEach((p, i) => {
    p.role = list[i];
    p.alive = true;
    p.buried = null;
    p.hunterShot = false;
  });

  room.day = 0;
  room.winner = null;
  room.lovers = null;
  room.potions = { heal: true, poison: true };
  room.seerLog = [];
  room.lastGuard = null;
  room.lastVictims = [];
  room.lastLynch = null;
  room.pendingHunter = null;
  room.votes = {};
  room.chat = [];
  room.night = null;

  const hasCupid = room.players.some((p) => p.role === 'cupid');
  if (hasCupid) setPhase(room, 'cupid', 45000);
  else startNight(room);
}

function startNight(room) {
  room.day += 1;
  room.votes = {};
  room.night = {
    wolfVotes: {},
    seerPick: null,
    guardPick: null,
    healSave: false,
    poison: null,
    done: [],
  };
  setPhase(room, 'night', room.config.nightMs);
}

function nightActors(room) {
  return alive(room)
    .filter((p) => ['wolf', 'seer', 'witch', 'guard'].includes(p.role))
    .map((p) => p.id);
}

function maybeFinishNight(room) {
  if (room.phase !== 'night' || room._resolving) return;
  const need = nightActors(room);
  const all = need.every((id) => room.night.done.includes(id));
  if (!all) return;
  room._resolving = true;
  room.deadline = Date.now() + 1500;
  broadcast(room);
}

function killAll(room, ids) {
  const dead = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    if (room.lovers) {
      for (const id of [...dead]) {
        if (!room.lovers.includes(id)) continue;
        for (const other of room.lovers) {
          const p = findPlayer(room, other);
          if (p && p.alive && !dead.has(other)) {
            dead.add(other);
            changed = true;
          }
        }
      }
    }
  }
  for (const id of dead) {
    const p = findPlayer(room, id);
    if (!p || !p.alive) continue;
    p.alive = false;
    room.lastVictims.push({ id: p.id, name: p.name });
  }
}

function checkWin(room) {
  const living = alive(room);
  const wolves = living.filter((p) => p.role === 'wolf');
  if (!wolves.length) {
    endGame(room, 'village');
    return true;
  }
  if (wolves.length >= living.length - wolves.length) {
    endGame(room, 'wolves');
    return true;
  }
  if (
    room.lovers &&
    living.length === 2 &&
    living.every((p) => room.lovers.includes(p.id)) &&
    wolves.length === 1
  ) {
    endGame(room, 'lovers');
    return true;
  }
  return false;
}

function endGame(room, winner) {
  room.winner = winner;
  room.pendingHunter = null;
  setPhase(room, 'over', 0);
}

function afterDeaths(room) {
  if (checkWin(room)) return;
  const hunter = room.players.find(
    (p) => !p.alive && p.role === 'hunter' && !p.hunterShot
  );
  if (hunter) {
    hunter.hunterShot = true;
    room.pendingHunter = hunter.id;
    setPhase(room, 'hunter', 25000);
    return;
  }
  if (room.afterDeaths === 'night') return startNight(room);
  if (room.afterDeaths === 'verdict') return setPhase(room, 'verdict', 7000);
  setPhase(room, 'dawn', 7000);
}

function resolveNight(room) {
  room._resolving = false;
  const n = room.night;
  room.lastVictims = [];
  room.afterDeaths = 'dawn';

  const target = majority(Object.values(n.wolfVotes));
  if (target) {
    const guarded = n.guardPick === target;
    const healed = n.healSave && room.potions.heal;
    if (!guarded && !healed) killAll(room, [target]);
    if (healed) room.potions.heal = false;
    if (guarded) room.lastGuard = n.guardPick;
  }
  if (n.poison && room.potions.poison) {
    killAll(room, [n.poison]);
    room.potions.poison = false;
  }
  if (n.guardPick) room.lastGuard = n.guardPick;
  afterDeaths(room);
}

function startVote(room) {
  room.votes = {};
  setPhase(room, 'vote', room.config.voteMs);
}

function resolveVote(room) {
  room.lastVictims = [];
  room.afterDeaths = 'verdict';
  const { top, unique } = tally(Object.values(room.votes));
  room.lastLynch = unique && top ? { id: top, name: (findPlayer(room, top) || {}).name } : null;
  if (room.lastLynch) killAll(room, [top]);
  afterDeaths(room);
}

function tick(room) {
  if (!room.deadline || Date.now() < room.deadline) return;
  room.deadline = 0;
  switch (room.phase) {
    case 'cupid':
      startNight(room);
      break;
    case 'night':
      resolveNight(room);
      break;
    case 'dawn':
      setPhase(room, 'day', room.config.dayMs);
      break;
    case 'day':
      startVote(room);
      break;
    case 'vote':
      resolveVote(room);
      break;
    case 'verdict':
      startNight(room);
      break;
    case 'hunter': {
      // Le chasseur n'a pas tire : on continue.
      room.pendingHunter = null;
      if (checkWin(room)) break;
      if (room.afterDeaths === 'night') startNight(room);
      else setPhase(room, 'dawn', 7000);
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

function actCupid(room, me, msg) {
  const a = msg.lovers;
  if (!Array.isArray(a) || a.length !== 2 || a[0] === a[1]) return;
  const p1 = findPlayer(room, a[0]);
  const p2 = findPlayer(room, a[1]);
  if (!p1 || !p2 || !p1.alive || !p2.alive) return;
  room.lovers = [p1.id, p2.id];
  startNight(room);
}

function actNight(room, me, msg) {
  const n = room.night;
  if (!n || !me.alive) return;
  const mark = () => {
    if (!n.done.includes(me.id)) n.done.push(me.id);
    maybeFinishNight(room);
  };
  const target = msg.target ? findPlayer(room, msg.target) : null;

  if (me.role === 'wolf') {
    if (msg.action === 'pass') return mark();
    if (!target || !target.alive || target.role === 'wolf') return;
    n.wolfVotes[me.id] = target.id;
    return mark();
  }
  if (me.role === 'seer') {
    if (msg.action === 'pass') return mark();
    if (!target || !target.alive || target.id === me.id) return;
    n.seerPick = target.id;
    room.seerLog.push({ name: target.name, role: target.role, id: target.id, day: room.day });
    return mark();
  }
  if (me.role === 'guard') {
    if (msg.action === 'pass') return mark();
    if (!target || !target.alive) return;
    if (room.lastGuard === target.id) return;
    n.guardPick = target.id;
    return mark();
  }
  if (me.role === 'witch') {
    if (msg.action === 'pass') return mark();
    if (msg.action === 'heal') {
      if (!room.potions.heal) return;
      const victim = majority(Object.values(n.wolfVotes));
      if (!victim) {
        return send(me.ws, { t: 'error', message: "Les loups n'ont pas encore choisi leur proie." });
      }
      n.healSave = true;
      return mark();
    }
    if (msg.action === 'poison') {
      if (!room.potions.poison) return;
      if (!target || !target.alive) return;
      n.poison = target.id;
      return mark();
    }
  }
}

function actVote(room, me, msg) {
  if (!me.alive) return;
  if (msg.action === 'abstain') {
    room.votes[me.id] = null;
  } else {
    const t = findPlayer(room, msg.target);
    if (!t || !t.alive) return;
    room.votes[me.id] = t.id;
  }
  const voters = alive(room).map((p) => p.id);
  if (voters.every((id) => id in room.votes)) {
    room.deadline = Date.now() + 900;
  }
  broadcast(room);
}

function actHunter(room, me, msg) {
  if (room.pendingHunter !== me.id) return;
  room.pendingHunter = null;
  const t = msg.target ? findPlayer(room, msg.target) : null;
  if (t && t.alive) {
    room.lastVictims = [];
    killAll(room, [t.id]);
  }
  afterDeaths(room);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/qr', async (req, res) => {
  try {
    const text = String(req.query.text || '').slice(0, 300);
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0d18', light: '#ffffff' },
    });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=60').send(svg);
  } catch (err) {
    res.status(400).end('qr error');
  }
});

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
  const name = String(msg.name || '').trim().slice(0, 14) || 'Joueur';
  const token = msg.token ? String(msg.token) : null;

  let room = code ? rooms.get(code) : null;

  if (room) {
    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        if (existing.name !== name) existing.name = name;
        return attach(ws, room, existing);
      }
    }
    if (room.phase !== 'lobby') {
      return send(ws, { t: 'error', fatal: true, message: 'La partie a deja commence.' });
    }
    if (room.players.length >= 20) {
      return send(ws, { t: 'error', fatal: true, message: 'La salle est pleine (20 max).' });
    }
  } else {
    if (code) return send(ws, { t: 'error', fatal: true, message: 'Aucune partie avec ce code.' });
    room = newRoom(code4());
  }

  const player = {
    id: uid(),
    token: uid(16),
    name,
    ws,
    alive: true,
    connected: true,
    role: null,
    isHost: room.players.length === 0,
    buried: null,
    hunterShot: false,
  };
  room.players.push(player);
  applyDefaults(room);
  ws.room = room;
  ws.player = player;
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

    const room = ws.room;
    const me = ws.player;
    if (!room || !me || !findPlayer(room, me.id)) return;
    room.lastActivity = Date.now();

    switch (msg.t) {
      case 'ping':
        return send(ws, { t: 'pong' });

      case 'config': {
        if (!me.isHost || room.phase !== 'lobby') return;
        room.configTouched = true;
        const c = msg.config || {};
        const next = { ...room.config, ...c, roles: { ...room.config.roles, ...(c.roles || {}) } };
        const clamp = (v, lo, hi, def) =>
          Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
        next.nightMs = clamp(next.nightMs, 15000, 180000, 45000);
        next.dayMs = clamp(next.dayMs, 30000, 600000, 180000);
        next.voteMs = clamp(next.voteMs, 15000, 180000, 60000);
        next.roles.wolf = clamp(next.roles.wolf, 1, 8, 1);
        for (const r of SPECIALS) next.roles[r] = clamp(next.roles[r], 0, 1, 0);

        const total =
          next.roles.wolf + SPECIALS.reduce((s, r) => s + next.roles[r], 0);
        if (total > room.players.length) return send(ws, { t: 'error', message: 'Trop de roles pour le nombre de joueurs.' });
        if (next.roles.wolf * 2 >= room.players.length) next.roles.wolf = Math.max(1, Math.ceil(room.players.length / 2) - 1);

        room.config = next;
        return broadcast(room);
      }

      case 'start':
        if (!me.isHost || room.phase !== 'lobby') return;
        if (room.players.length < MIN_PLAYERS) {
          return send(ws, { t: 'error', message: `Il faut au moins ${MIN_PLAYERS} joueurs.` });
        }
        return startGame(room);

      case 'restart':
        if (!me.isHost || !['over'].includes(room.phase)) return;
        room.phase = 'lobby';
        room.players.forEach((p) => {
          p.role = null;
          p.alive = true;
          p.buried = null;
          p.hunterShot = false;
        });
        room.winner = null;
        room.lastVictims = [];
        room.lastLynch = null;
        room.deadline = 0;
        return broadcast(room);

      case 'skip':
        if (!me.isHost) return;
        if (room.phase === 'night') {
          resolveNight(room);
        } else if (room.phase === 'day') {
          startVote(room);
        } else if (room.phase === 'vote') {
          resolveVote(room);
        } else if (room.phase === 'dawn') {
          setPhase(room, 'day', room.config.dayMs);
        } else if (room.phase === 'verdict') {
          startNight(room);
        } else if (room.phase === 'hunter' && me.id === room.pendingHunter) {
          actHunter(room, me, { target: null });
        }
        return;

      case 'night':
        return actNight(room, me, msg);

      case 'cupid':
        return actCupid(room, me, msg);

      case 'vote':
        return actVote(room, me, msg);

      case 'hunter':
        return actHunter(room, me, msg);

      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        const last = room.chat.filter((m) => m.id === me.id).pop();
        if (last && Date.now() - last.at < 700) return;
        room.chat.push({ id: me.id, name: me.name, text, at: Date.now() });
        if (room.chat.length > 200) room.chat.shift();
        return broadcast(room);
      }

      default:
        return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    const me = ws.player;
    if (!room || !me) return;
    me.connected = false;
    if (me.ws === ws) me.ws = null;
    if (me.isHost) {
      me.isHost = false;
      ensureHost(room);
    }
    broadcast(room);
  });
});

/* ------------------------------------------------------------------ */
/* Battements : timers + menage                                       */
/* ------------------------------------------------------------------ */

setInterval(() => {
  for (const room of rooms.values()) tick(room);
}, 200);

// Compte a rebours fluide cote clients.
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
    // Le QR ASCII s'affiche mal dans certains terminaux Windows (encodage OEM).
    if (process.platform !== 'win32') {
      QRCode.toString(`http://${ip}:${PORT}`, { type: 'terminal', small: true })
        .then((qr) => console.log(qr))
        .catch(() => {});
    }
  }
  console.log('  Ouvre le navigateur, cree une partie, fais scanner le code.');
  console.log('');
});
