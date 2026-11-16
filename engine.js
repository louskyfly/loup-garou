/**
 * Moteur du loup-garou — sans dependance, sans transport.
 * Utilise par le serveur Node (require) et par l'onglet hote sur GitHub Pages
 * (window.LoupEngine). Toute la logique de jeu vit ici, une seule fois.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoupEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* Roles                                                            */
  /* ---------------------------------------------------------------- */

  const ROLES = {
    villager: {
      name: 'Villageois', team: 'village', emoji: '\u{1F33E}',
      desc: 'Aucun pouvoir. Ton arme : parler, mentir, et voter juste.',
      night: 'Tu dors. Garde les yeux fermés et écoute.',
    },
    wolf: {
      name: 'Loup-garou', team: 'wolves', emoji: '\u{1F43A}',
      desc: 'Chaque nuit, ta meute dévore un habitant. Le jour, fais-toi passer pour un innocent.',
      night: 'Choisis ta proie avec ta meute.',
    },
    seer: {
      name: 'Voyante', team: 'village', emoji: '\u{1F52E}',
      desc: "Chaque nuit, découvre le rôle exact d'un joueur.",
      night: "Perce le secret d'un joueur.",
    },
    witch: {
      name: 'Sorcière', team: 'village', emoji: '\u{1F9EA}',
      desc: 'Une potion de vie, une potion de mort. Une seule fois chacune.',
      night: "Sauve la victime, ou empoisonne quelqu'un.",
    },
    hunter: {
      name: 'Chasseur', team: 'village', emoji: '\u{1F3F9}',
      desc: "Si tu meurs, tu emportes quelqu'un avec toi.",
      night: "Tu ne tires qu'en mourant.",
    },
    cupid: {
      name: 'Cupidon', team: 'village', emoji: '\u{1F498}',
      desc: "La première nuit, désigne deux amoureux : si l'un meurt, l'autre meurt de chagrin.",
      night: 'Désigne deux amoureux.',
    },
    guard: {
      name: 'Salvateur', team: 'village', emoji: '\u{1F6E1}',
      desc: 'Chaque nuit, protège un joueur des loups. Jamais deux nuits de suite la même personne.',
      night: "Protège quelqu'un cette nuit.",
    },
  };

  const SPECIALS = ['seer', 'witch', 'hunter', 'cupid', 'guard'];

  /* ---------------------------------------------------------------- */
  /* Utilitaires                                                      */
  /* ---------------------------------------------------------------- */

  function uid(n) {
    n = n || 8;
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

  function majority(values) {
    const map = counts(values);
    if (!map.size) return null;
    const max = Math.max.apply(null, Array.from(map.values()));
    const top = Array.from(map.entries()).filter(([, v]) => v === max).map(([k]) => k);
    return top[Math.floor(Math.random() * top.length)];
  }

  function tally(values) {
    const map = counts(values);
    if (!map.size) return { top: null, unique: false };
    const max = Math.max.apply(null, Array.from(map.values()));
    const top = Array.from(map.entries()).filter(([, v]) => v === max).map(([k]) => k);
    return { top: top[0], unique: top.length === 1 };
  }

  /* ---------------------------------------------------------------- */
  /* Salles                                                           */
  /* ---------------------------------------------------------------- */

  const rooms = new Map();
  let MIN_PLAYERS = 5;

  function setMinPlayers(n) {
    MIN_PLAYERS = Math.max(2, Math.min(20, Number(n) || 5));
  }

  function minPlayers() {
    return MIN_PLAYERS;
  }

  function newRoom(ctx) {
    const room = {
      code: code4(),
      phase: 'lobby',
      day: 0,
      players: [],
      chat: [],
      winner: null,
      deadline: 0,
      phaseMs: 0,
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
      configTouched: false,
      config: {
        nightMs: 45000,
        dayMs: 180000,
        voteMs: 60000,
        roles: { wolf: 1, seer: 0, witch: 0, hunter: 0, cupid: 0, guard: 0 },
      },
      lastActivity: Date.now(),
      ctx: ctx,
    };
    rooms.set(room.code, room);
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

  function newPlayer(room, name, token) {
    const clean = String(name || '').trim().slice(0, 14) || 'Joueur';
    const player = {
      id: uid(),
      token: token || uid(16),
      name: clean,
      alive: true,
      connected: true,
      role: null,
      isHost: room.players.length === 0,
      buried: null,
      hunterShot: false,
      link: null,
      ws: null,
    };
    room.players.push(player);
    applyDefaults(room);
    return player;
  }

  function roleCount(room) {
    const c = room.config.roles;
    const wolves = c.wolf || 0;
    const specials = SPECIALS.reduce((s, r) => s + (c[r] || 0), 0);
    return { wolves, specials, villagers: Math.max(0, room.players.length - wolves - specials) };
  }

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

  function bcast(room) {
    if (room.ctx && room.ctx.broadcast) room.ctx.broadcast(room);
  }

  function err(room, playerId, message) {
    if (room.ctx && room.ctx.error) room.ctx.error(playerId, message);
  }

  /* ---------------------------------------------------------------- */
  /* Vue personnalisee                                                */
  /* ---------------------------------------------------------------- */

  function view(room, me, now) {
    now = now || Date.now();
    const wolves = room.players.filter((p) => p.role === 'wolf').map((p) => p.id);
    const over = room.phase === 'over';
    const isLover = !!(room.lovers && room.lovers.indexOf(me.id) >= 0);
    const iAmWolf = me.role === 'wolf';

    const players = room.players
      .map((p) => {
        const known =
          over ||
          p.id === me.id ||
          (iAmWolf && p.role === 'wolf') ||
          (isLover && room.lovers.indexOf(p.id) >= 0);
        return {
          id: p.id,
          name: p.name,
          alive: p.alive,
          connected: p.connected,
          isHost: !!p.isHost,
          isMe: p.id === me.id,
          role: known && p.role ? p.role : null,
          voted: room.phase === 'vote' ? !!room.votes[p.id] : undefined,
        };
      })
      .sort((a, b) => Number(b.alive) - Number(a.alive));

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
      players: players,
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
        acted: room.phase === 'night' && room.night ? room.night.done.indexOf(me.id) >= 0 : false,
        voted: room.phase === 'vote' ? me.id in room.votes : false,
        potions: me.role === 'witch' ? room.potions : null,
        attacked: attacked,
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

  /* ---------------------------------------------------------------- */
  /* Boucle de jeu                                                    */
  /* ---------------------------------------------------------------- */

  function setPhase(room, phase, ms) {
    room.phase = phase;
    room.phaseMs = ms || 0;
    room.deadline = ms ? Date.now() + ms : 0;
    room.lastActivity = Date.now();
    bcast(room);
  }

  function startGame(room) {
    const n = room.players.length;
    const c = room.config.roles;
    const list = [];
    for (let i = 0; i < (c.wolf || 0); i++) list.push('wolf');
    for (const r of SPECIALS) for (let i = 0; i < (c[r] || 0); i++) list.push(r);
    while (list.length < n) list.push('villager');
    list.length = n;
    if (list.indexOf('wolf') < 0) list[0] = 'wolf';
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

    if (room.players.some((p) => p.role === 'cupid')) setPhase(room, 'cupid', 45000);
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
      .filter((p) => ['wolf', 'seer', 'witch', 'guard'].indexOf(p.role) >= 0)
      .map((p) => p.id);
  }

  function maybeFinishNight(room) {
    if (room.phase !== 'night' || room._resolving) return;
    const need = nightActors(room);
    const all = need.every((id) => room.night.done.indexOf(id) >= 0);
    if (!all) return;
    room._resolving = true;
    room.deadline = Date.now() + 1500;
    bcast(room);
  }

  function killAll(room, ids) {
    const dead = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      if (room.lovers) {
        for (const id of Array.from(dead)) {
          if (room.lovers.indexOf(id) < 0) continue;
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
      living.every((p) => room.lovers.indexOf(p.id) >= 0) &&
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
    const hunter = room.players.find((p) => !p.alive && p.role === 'hunter' && !p.hunterShot);
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
    const res = tally(Object.values(room.votes));
    const lynched = res.unique && res.top ? findPlayer(room, res.top) : null;
    room.lastLynch = lynched ? { id: lynched.id, name: lynched.name } : null;
    if (lynched) killAll(room, [lynched.id]);
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

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  function actCupid(room, me, msg) {
    const a = msg.lovers;
    if (!Array.isArray(a) || a.length !== 2 || a[0] === a[1]) return;
    const p1 = findPlayer(room, a[0]);
    const p2 = findPlayer(room, a[1]);
    if (!p1 || !p2 || !p1.alive || !p2.alive) return;
    if (me.role !== 'cupid') return;
    room.lovers = [p1.id, p2.id];
    startNight(room);
  }

  function actNight(room, me, msg) {
    const n = room.night;
    if (!n || !me.alive) return;
    const mark = function () {
      if (n.done.indexOf(me.id) < 0) n.done.push(me.id);
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
          return err(room, me.id, "Les loups n'ont pas encore choisi leur proie.");
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
    if (voters.every((id) => id in room.votes)) room.deadline = Date.now() + 900;
    bcast(room);
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

  /* ---------------------------------------------------------------- */
  /* Entree des messages (le transport fait le reste)                 */
  /* ---------------------------------------------------------------- */

  function handle(room, me, msg) {
    if (!room || !me) return;
    room.lastActivity = Date.now();

    switch (msg.t) {
      case 'config': {
        if (!me.isHost || room.phase !== 'lobby') return;
        room.configTouched = true;
        const c = msg.config || {};
        const next = {
          nightMs: room.config.nightMs,
          dayMs: room.config.dayMs,
          voteMs: room.config.voteMs,
          roles: Object.assign({}, room.config.roles),
          ...c,
        };
        next.roles = Object.assign({}, room.config.roles, c.roles || {});

        const clamp = (v, lo, hi, def) =>
          Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
        next.nightMs = clamp(next.nightMs, 15000, 180000, 45000);
        next.dayMs = clamp(next.dayMs, 30000, 600000, 180000);
        next.voteMs = clamp(next.voteMs, 15000, 180000, 60000);
        next.roles.wolf = clamp(next.roles.wolf, 1, 8, 1);
        for (const r of SPECIALS) next.roles[r] = clamp(next.roles[r], 0, 1, 0);

        const total = next.roles.wolf + SPECIALS.reduce((s, r) => s + next.roles[r], 0);
        if (total > room.players.length) {
          return err(room, me.id, 'Trop de rôles pour le nombre de joueurs.');
        }
        if (next.roles.wolf * 2 >= room.players.length) {
          next.roles.wolf = Math.max(1, Math.ceil(room.players.length / 2) - 1);
        }

        room.config = next;
        return bcast(room);
      }

      case 'start':
        if (!me.isHost || room.phase !== 'lobby') return;
        if (room.players.length < MIN_PLAYERS) {
          return err(room, me.id, 'Il faut au moins ' + MIN_PLAYERS + ' joueurs.');
        }
        return startGame(room);

      case 'restart':
        if (!me.isHost || room.phase !== 'over') return;
        room.phase = 'lobby';
        room.deadline = 0;
        room.phaseMs = 0;
        room.players.forEach((p) => {
          p.role = null;
          p.alive = true;
          p.buried = null;
          p.hunterShot = false;
        });
        room.winner = null;
        room.lastVictims = [];
        room.lastLynch = null;
        room.lovers = null;
        return bcast(room);

      case 'skip':
        if (!me.isHost) return;
        if (room.phase === 'night') return resolveNight(room);
        if (room.phase === 'day') return startVote(room);
        if (room.phase === 'vote') return resolveVote(room);
        if (room.phase === 'dawn') return setPhase(room, 'day', room.config.dayMs);
        if (room.phase === 'verdict') return startNight(room);
        if (room.phase === 'hunter' && me.id === room.pendingHunter) {
          return actHunter(room, me, { target: null });
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
        room.chat.push({ id: me.id, name: me.name, text: text, at: Date.now() });
        if (room.chat.length > 200) room.chat.shift();
        return bcast(room);
      }

      default:
        return;
    }
  }

  return {
    ROLES: ROLES,
    SPECIALS: SPECIALS,
    rooms: rooms,
    uid: uid,
    newRoom: newRoom,
    newPlayer: newPlayer,
    findPlayer: findPlayer,
    alive: alive,
    hostId: hostId,
    ensureHost: ensureHost,
    roleCount: roleCount,
    defaultRoles: defaultRoles,
    applyDefaults: applyDefaults,
    view: view,
    handle: handle,
    tick: tick,
    setMinPlayers: setMinPlayers,
    minPlayers: minPlayers,
    startGame: startGame,
  };
});
