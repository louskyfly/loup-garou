'use strict';

/* ------------------------------------------------------------------ */
/* Etat local                                                         */
/* ------------------------------------------------------------------ */

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const KEY = 'lg.sess.v1';

let sess = {};
try {
  sess = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
} catch (e) {
  sess = {};
}

let S = null;
let intent = null;
let sel = [];
let witchMode = 'idle';
let roleOpen = false;
let chatDraft = '';
let retry = null;
let focusId = null;

const params = new URLSearchParams(location.search);
let draftCode = (params.get('c') || '').toUpperCase();
let draftName = sess.name || '';

const ROLE_LABELS = {
  villager: 'Villageois', wolf: 'Loup-garou', seer: 'Voyante',
  witch: 'Sorcière', hunter: 'Chasseur', cupid: 'Cupidon', guard: 'Salvateur',
};
const ROLE_EMOJI = {
  villager: '🌾', wolf: '🐺', seer: '🔮',
  witch: '🧪', hunter: '🏹', cupid: '💘', guard: '🛡️',
};

/* ------------------------------------------------------------------ */
/* Outils                                                             */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ini = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

const hue = (name) => {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
};

const avStyle = (name) => `--seal:hsl(${hue(name)} 42% 31%)`;

const fmtDur = (ms) =>
  ms >= 60000
    ? ms % 60000 === 0
      ? `${ms / 60000} min`
      : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`
    : `${ms / 1000} s`;

function toast(m) {
  toastEl.textContent = m;
  toastEl.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('on'), 2600);
}

function send(o) {
  if (net && net.send) net.send(o);
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(sess));
}

/* ------------------------------------------------------------------ */
/* Transport                                                          */
/* WebSocket quand un serveur Node sert la page (npm start).            */
/* WebRTC (PeerJS) quand la page est statique : l'onglet de l'hote      */
/* fait tourner le moteur, les autres s'y connectent directement.       */
/* ------------------------------------------------------------------ */

const E = window.LoupEngine;

const IS_PAGES =
  /\.github\.io$/i.test(location.hostname) || /\.pages\.dev$/i.test(location.hostname);
const P2P = IS_PAGES || /(^|[?&])p2p=1(&|$)/.test(location.search);
const PEER_PREFIX = 'loupgarou-';

let net = null;
let hostRoom = null;
let hostPeer = null;
let hostTimers = [];

function handleServerMessage(m) {
  {
    if (m.t === 'joined') {
      sess.code = m.code;
      sess.token = m.token;
      sess.name = (intent && intent.name) || sess.name;
      save();
      intent = null;
    } else if (m.t === 'state') {
      const prev = S && S.phase;
      S = m;
      if (prev !== S.phase) {
        sel = [];
        witchMode = 'idle';
        if (S.phase === 'night') roleOpen = false;
      }
      render();
    } else if (m.t === 'error') {
      toast(m.message || 'Erreur');
      if (!S || m.fatal) {
        S = null;
        sess = {};
        intent = null;
        save();
        render();
      }
    } else if (m.t === 'kicked') {
      S = null;
      sess = {};
      save();
      intent = null;
      render();
      toast(m.reason || 'Session ouverte ailleurs');
    }
  }
}

/* ---------- WebSocket (serveur Node) ---------- */

function wsConnect() {
  if (net && net.open) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${location.host}`);

  net = {
    open: true,
    send(o) {
      if (socket.readyState === 1) socket.send(JSON.stringify(o));
    },
    close() {
      net = null;
      try {
        socket.close();
      } catch (e) {
        /* ignore */
      }
    },
  };

  socket.onopen = () => {
    if (intent) net.send(intent);
  };

  socket.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    handleServerMessage(m);
  };

  socket.onclose = () => {
    net = null;
    clearTimeout(retry);
    if (sess.token && sess.code) {
      retry = setTimeout(() => {
        intent = { t: 'join', code: sess.code, name: sess.name, token: sess.token };
        wsConnect();
      }, 1200);
    }
  };
}

/* ---------- WebRTC (GitHub Pages) ---------- */

function qrDataUrl(text) {
  try {
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createDataURL(4, 1);
  } catch (e) {
    return '';
  }
}

function joinUrl(code) {
  const u = new URL(location.href);
  u.hash = '';
  const keepP2P = P2P && !IS_PAGES;
  u.search = '?c=' + code + (keepP2P ? '&p2p=1' : '');
  return u.toString();
}

function hostBroadcast(room) {
  const now = Date.now();
  for (const p of room.players) {
    let v;
    try {
      v = E.view(room, p, now);
    } catch (e) {
      continue;
    }
    if (p.link === 'self') handleServerMessage(v);
    else if (p.link && p.link.open) {
      try {
        p.link.send(v);
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function hostAccept(room, conn, msg) {
  const token = msg.token ? String(msg.token) : null;
  if (token) {
    const ex = room.players.find((p) => p.token === token);
    if (ex) {
      ex.link = conn;
      ex.connected = true;
      if (msg.name) ex.name = String(msg.name).trim().slice(0, 14) || ex.name;
      conn.send({ t: 'joined', code: room.code, token: ex.token, id: ex.id });
      return hostBroadcast(room);
    }
  }
  if (room.phase !== 'lobby') {
    return conn.send({ t: 'error', fatal: true, message: 'La partie a déjà commencé.' });
  }
  if (room.players.length >= 20) {
    return conn.send({ t: 'error', fatal: true, message: 'La salle est pleine (20 max).' });
  }
  const p = E.newPlayer(room, msg.name);
  p.link = conn;
  conn.send({ t: 'joined', code: room.code, token: p.token, id: p.id });
  hostBroadcast(room);
}

function startHost(name, attempt) {
  attempt = attempt || 0;
  if (attempt > 3) {
    toast('Impossible de créer le salon, réessaie.');
    S = null;
    render();
    return;
  }

  const ctx = {
    broadcast: hostBroadcast,
    error(playerId, message) {
      const p = hostRoom ? E.findPlayer(hostRoom, playerId) : null;
      if (!p || p.link === 'self') return handleServerMessage({ t: 'error', message: message });
      if (p.link && p.link.open) p.link.send({ t: 'error', message: message });
    },
  };

  const room = E.newRoom(ctx);
  hostRoom = room;
  const me = E.newPlayer(room, name);
  me.link = 'self';

  // L'hote parle directement au moteur : il n'y a pas de serveur.
  net = {
    open: true,
    send(o) {
      if (!hostRoom) return;
      const self = E.findPlayer(hostRoom, me.id);
      if (!self) return;
      E.handle(hostRoom, self, o);
    },
    close() {
      net = null;
    },
  };

  const peer = new Peer(PEER_PREFIX + room.code, { debug: 0 });
  hostPeer = peer;

  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') {
      try {
        peer.destroy();
      } catch (x) {
        /* ignore */
      }
      E.rooms.delete(room.code);
      hostPeer = null;
      hostRoom = null;
      return startHost(name, attempt + 1);
    }
    console.warn('peer', e.type, e.message);
  });

  peer.on('open', () => {
    handleServerMessage({ t: 'joined', code: room.code, token: me.token, id: me.id });
    hostBroadcast(room);
    hostTimers.forEach((t) => clearInterval(t));
    hostTimers = [
      setInterval(() => E.tick(room), 200),
      setInterval(() => {
        if (room.deadline) hostBroadcast(room);
      }, 1000),
    ];
  });

  peer.on('connection', (conn) => {
    conn.on('data', (raw) => {
      let msg = raw;
      if (typeof raw === 'string') {
        try {
          msg = JSON.parse(raw);
        } catch (e) {
          return;
        }
      }
      if (!msg || !msg.t) return;
      if (msg.t === 'join') return hostAccept(room, conn, msg);
      const p = room.players.find((x) => x.link === conn);
      if (!p) return;
      E.handle(room, p, msg);
    });

    conn.on('close', () => {
      const p = room.players.find((x) => x.link === conn);
      if (!p) return;
      p.connected = false;
      p.link = null;
      if (p.isHost) {
        p.isHost = false;
        E.ensureHost(room);
      }
      hostBroadcast(room);
    });
  });
}

function startJoin(code, name, token) {
  const peer = new Peer({ debug: 0 });
  let conn = null;
  let dead = false;

  const fail = (message) => {
    if (dead) return;
    dead = true;
    clearTimeout(timer);
    net = null;
    try {
      peer.destroy();
    } catch (e) {
      /* ignore */
    }
    handleServerMessage({ t: 'error', fatal: true, message: message });
  };

  const timer = setTimeout(
    () => fail('Pas de réponse du salon : hôte déconnecté ou code expiré.'),
    12000
  );

  net = {
    open: true,
    send(o) {
      if (conn && conn.open) conn.send(o);
    },
    close() {
      dead = true;
      try {
        peer.destroy();
      } catch (e) {
        /* ignore */
      }
    },
  };

  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') {
      fail("Aucune partie avec ce code — ou l'hôte a fermé son onglet.");
    } else if (e.type === 'network' || e.type === 'server-error') {
      fail('Le serveur de connexion ne répond pas. Réessaie dans un instant.');
    } else if (e.type === 'browser-incompatible') {
      fail('Ce navigateur ne gère pas le pair-à-pair.');
    }
  });

  peer.on('open', () => {
    conn = peer.connect(PEER_PREFIX + code, { reliable: true });

    conn.on('open', () => {
      clearTimeout(timer);
      conn.send({ t: 'join', code: code, name: name, token: token || undefined });
    });

    conn.on('data', (raw) => {
      let m = raw;
      if (typeof raw === 'string') {
        try {
          m = JSON.parse(raw);
        } catch (e) {
          return;
        }
      }
      handleServerMessage(m);
    });

    conn.on('close', () => fail("L'hôte s'est déconnecté."));
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

function render() {
  document.body.dataset.phase = S ? S.phase : 'home';
  app.innerHTML = S ? viewGame() : viewHome();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (el.setSelectionRange) {
        try {
          el.setSelectionRange(el.value.length, el.value.length);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
}

function viewHome() {
  const resume = sess.token && sess.code;
  return `<div class="home">
    <div class="moon disp">🌕</div>
    <h1 class="disp">Loup-garou</h1>
    <p class="sub dim">Le narrateur est un serveur.<br>Il ne se trompe pas, il ne triche pas.</p>
    ${resume ? `<button class="btn btn-block" data-a="resume">Reprendre la partie ${esc(sess.code)}</button>` : ''}
    <label class="field">Ton pseudo
      <input type="text" id="name" maxlength="14" placeholder="ex : Lucas" value="${esc(draftName)}" autocomplete="off" enterkeyhint="done">
    </label>
    <button class="btn btn-primary btn-lg btn-block" data-a="create">Créer une partie</button>
    <div class="or">ou</div>
    <div class="row">
      <input class="inp inp-code grow" id="code" maxlength="4" placeholder="CODE" value="${esc(draftCode)}" autocomplete="off" enterkeyhint="go">
      <button class="btn" data-a="join">Entrer</button>
    </div>
    <p class="tiny dim center">5 à 20 joueurs · un téléphone chacun · rien à installer</p>
  </div>`;
}

function viewGame() {
  if (S.phase === 'lobby') return lobbyView();
  if (S.phase === 'over') return overView();
  const body =
    S.phase === 'cupid' ? cupidView()
    : S.phase === 'night' ? nightView()
    : S.phase === 'dawn' ? dawnView()
    : S.phase === 'day' ? dayView()
    : S.phase === 'vote' ? voteView()
    : S.phase === 'verdict' ? verdictView()
    : S.phase === 'hunter' ? hunterView()
    : '';
  return `${gameHead()}${body}${chatPanel()}`;
}

function gameHead() {
  const titles = {
    cupid: 'Nuit 1', night: `Nuit ${S.day}`, dawn: 'Aube',
    day: `Jour ${S.day}`, vote: 'Le vote', verdict: 'Verdict', hunter: 'Le chasseur',
  };
  const pct = S.totalMs ? Math.max(0, Math.min(100, (S.msLeft / S.totalMs) * 100)) : 0;
  return `
  <div class="gamehead">
    <span class="ph disp">${titles[S.phase] || ''}</span>
    <span class="when">${S.totalMs ? Math.ceil(S.msLeft / 1000) + ' s' : esc(S.code)}</span>
  </div>
  ${S.totalMs ? `<div class="timerbar"><i style="width:${pct}%"></i></div>` : ''}
  ${roleStrip()}`;
}

function roleStrip() {
  const me = S.me;
  if (!me.role) return '';
  const info = me.roleInfo;
  if (roleOpen) {
    return `<div class="rolecard ${info.team}" data-a="rolecard">
      <div class="emoji">${info.emoji}</div>
      <h2 class="disp">${esc(info.name)}</h2>
      <div class="team">${info.team === 'wolves' ? 'Camp des loups' : 'Camp du village'} · ${esc(me.name)}</div>
      <p>${esc(info.desc)}</p>
      ${me.teammates && me.teammates.length ? `<p class="tiny" style="color:#ff9d9d">Ta meute : ${esc(namesOf(me.teammates))}</p>` : ''}
      ${me.lovers && me.lovers.length ? `<p class="tiny" style="color:#ffb3d1">Ton amoureux·se : ${esc(namesOf(me.lovers))}</p>` : ''}
    </div>`;
  }
  return `<button class="tcard" data-a="rolecard" style="justify-content:flex-start">
      <span style="font-size:1.1rem">${info.emoji}</span>
      <span class="pname">${esc(info.name)}</span>
      <span class="badge ${info.team === 'wolves' ? 'wolf' : 'vil'}" style="margin-left:auto">${info.team === 'wolves' ? 'loup' : 'village'}</span>
    </button>`;
}

function namesOf(ids) {
  return ids
    .map((id) => {
      const p = S.players.find((x) => x.id === id);
      return p ? p.name : '?';
    })
    .join(', ');
}

function playerList(filter) {
  const list = S.players.filter(filter || (() => true));
  return `<div class="plist">${list
    .map(
      (p) => `<div class="prow ${p.alive ? '' : 'dead'} ${p.isMe ? 'me' : ''}">
      <span class="av" style="${avStyle(p.name)}">${ini(p.name)}</span>
      <span class="pname">${esc(p.name)}</span>
      ${p.isMe ? '<span class="badge me-badge">toi</span>' : ''}
      ${p.isHost ? '<span class="badge gold">hôte</span>' : ''}
      ${!p.connected ? '<span class="badge">off</span>' : ''}
      ${p.role ? `<span class="badge ${p.role === 'wolf' ? 'wolf' : 'vil'}" style="margin-left:auto">${ROLE_EMOJI[p.role]} ${esc(ROLE_LABELS[p.role])}</span>` : ''}
    </div>`
    )
    .join('')}</div>`;
}

function targetGrid(list, opts) {
  opts = opts || {};
  return `<div class="gridt">${list
    .map(
      (p) => `<button class="tcard" data-a="pick" data-v="${p.id}" data-on="${sel.includes(p.id) ? '1' : '0'}" ${opts.disabled && opts.disabled(p) ? 'disabled' : ''}>
        <span class="av" style="${avStyle(p.name)}">${ini(p.name)}</span>
        <span class="pname">${esc(p.name)}${p.isMe ? ' <span class="dim tiny">(toi)</span>' : ''}</span>
      </button>`
    )
    .join('')}</div>`;
}

/* ------------------------------- lobby ----------------------------- */

function compSummary() {
  const c = S.config.roles;
  const n = S.players.length;
  const specs = [['seer', 'Voyante'], ['witch', 'Sorcière'], ['hunter', 'Chasseur'], ['cupid', 'Cupidon'], ['guard', 'Salvateur']]
    .filter(([k]) => c[k])
    .map(([, l]) => l);
  const vill = Math.max(0, n - (c.wolf || 0) - specs.length);
  return [`${c.wolf || 0} loup${(c.wolf || 0) > 1 ? 's' : ''}`, ...specs, `${vill} villageois`].join(' · ');
}

function seg(key, values) {
  return `<div class="seg" style="min-width:150px">${values
    .map(
      (v) => `<button data-a="seg" data-k="${key}" data-v="${v}" aria-pressed="${S.config[key] === v ? 'true' : 'false'}">${fmtDur(v)}</button>`
    )
    .join('')}</div>`;
}

function configPanel() {
  const c = S.config.roles;
  const specs = [['seer', '🔮 Voyante'], ['witch', '🧪 Sorcière'], ['hunter', '🏹 Chasseur'], ['cupid', '💘 Cupidon'], ['guard', '🛡️ Salvateur']];
  return `<div class="panel">
    <div class="panel-title">Réglages</div>
    <div class="comp">
      <div class="crow">
        <span class="lab">🐺 Loups-garous</span>
        <div class="stepper">
          <button data-a="wolf" data-v="-1">−</button><span class="n">${c.wolf}</span><button data-a="wolf" data-v="1">+</button>
        </div>
      </div>
      <div class="chips">${specs
        .map(([k, label]) => `<button class="chip" data-a="role" data-v="${k}" aria-pressed="${c[k] ? 'true' : 'false'}">${label}</button>`)
        .join('')}</div>
      <div class="summary">${S.players.length >= 3 ? `<b>${esc(compSummary())}</b>` : '<span class="dim">En attente des joueurs…</span>'}</div>      <div class="crow"><span class="lab tiny dim">Nuit</span>${seg('nightMs', [30000, 45000, 60000])}</div>
      <div class="crow"><span class="lab tiny dim">Débat</span>${seg('dayMs', [90000, 180000, 300000])}</div>
      <div class="crow"><span class="lab tiny dim">Vote</span>${seg('voteMs', [30000, 60000, 90000])}</div>
    </div>
  </div>`;
}

function lobbyView() {
  const url = joinUrl(S.code);
  const qr = qrDataUrl(url);
  const isHost = S.me.isHost;
  return `
  <div class="codebox">
    <div class="grow">
      <div class="tiny dim" style="letter-spacing:.14em;text-transform:uppercase">Code</div>
      <div class="bigcode disp">${S.code}</div>
      <button class="btn btn-sm btn-ghost" data-a="copy">Copier le lien</button>
    </div>
    ${qr ? `<div class="qr"><img alt="QR code" src="${qr}"></div>` : ''}
  </div>
  <div class="panel">
    <div class="panel-title">Joueurs · ${S.players.length}</div>
    ${playerList()}
  </div>
  ${isHost ? configPanel() : '<p class="tiny dim center" style="margin:0">L\'hôte prépare la partie…</p>'}
  <div class="sticky-bottom">
    ${isHost
      ? `<button class="btn btn-primary btn-lg btn-block" data-a="start" ${S.canStart ? '' : 'disabled'}>Lancer la partie</button>
         <p class="tiny dim center" style="margin:0">${S.canStart ? 'Scanne le QR code, on commence quand tu veux.' : `Il faut au moins ${S.minPlayers} joueurs.`}</p>`
      : '<p class="tiny dim center" style="margin:0">En attente de l\'hôte…</p>'}
    ${P2P ? '<p class="tiny dim center" style="margin:0;opacity:.75">Garde cet onglet ouvert pendant toute la partie.</p>' : ''}
  </div>`;
}

/* ------------------------------- nuit ------------------------------ */

function roleHint(role) {
  switch (role) {
    case 'wolf': return 'Choisis la proie de la meute.';
    case 'seer': return 'Choisis qui tu veux démasquer.';
    case 'guard': return 'Choisis qui protéger cette nuit.';
    case 'witch': return 'Sauve la victime, ou empoisonne quelqu\'un.';
    default: return '';
  }
}

function confirmBar(label) {
  return `<div class="row" style="margin-top:10px">
    <button class="btn btn-ghost grow" data-a="pass">Ne rien faire</button>
    <button class="btn btn-primary grow" data-a="confirm" ${sel.length ? '' : 'disabled'}>${label}</button>
  </div>`;
}

function cupidView() {
  const me = S.me;
  const others = S.players.filter((p) => p.alive);
  if (!me.alive) return deadWaiting();
  if (me.role !== 'cupid') {
    return `<div class="annonce solo">
      <div class="moon-anim">💘</div>
      <h2 class="disp big">Cupidon s'éveille</h2>
      <p class="dim">Il désigne deux amoureux. Si l'un meurt, l'autre meurt de chagrin.</p>
    </div>`;
  }
  return `<div class="panel">
    <div class="panel-title">Désigne deux amoureux · ${sel.length}/2</div>
    <p class="summary" style="margin:0 0 10px">Ils sauront qui ils sont. Toi seul sais qui les a liés.</p>
    ${targetGrid(others)}
    <button class="btn btn-block" style="margin-top:10px" data-a="confirm" ${sel.length === 2 ? '' : 'disabled'}>Les marier 💘</button>
  </div>`;
}

function nightView() {
  const me = S.me;
  if (!me.alive) return deadWaiting();
  const role = me.role;
  const aliveOthers = S.players.filter((p) => p.alive && !p.isMe);

  if (role === 'villager' || role === 'hunter' || role === 'cupid') {
    return `<div class="annonce solo">
      <div class="moon-anim">🌙</div>
      <h2 class="disp big">Tu dors…</h2>
      <p class="dim">${esc(me.roleInfo.night)}</p>
      ${me.acted ? '<p class="tiny" style="color:#9fe6c1">Action enregistrée.</p>' : ''}
    </div>`;
  }

  if (role === 'wolf') {
    const mates = S.players.filter((p) => me.teammates.includes(p.id));
    const prey = S.players.filter((p) => p.alive && p.role !== 'wolf' && !p.isMe);
    const votes = me.wolfVotes || {};
    return `
    ${mates.length ? `<div class="panel">
      <div class="panel-title">Ta meute</div>
      ${playerList((p) => me.teammates.includes(p.id) || p.isMe)}
    </div>` : ''}
    <div class="panel">
      <div class="panel-title">${roleHint('wolf')}</div>
      ${me.acted
        ? `<p class="summary">Choix envoyé : <b>${esc(namesOf([me.myPick]))}</b><br><span class="tiny">La nuit se termine dès que toute la meute a choisi.</span></p>`
        : `${targetGrid(prey)}${confirmBar('Confirmer')}`}
      ${mates.length
        ? `<div class="summary" style="margin-top:12px">${mates
            .map((m) => `<div class="tiny">${esc(m.name)} vise <b>${votes[m.id] ? esc(namesOf([votes[m.id]])) : '—'}</b></div>`)
            .join('')}</div>`
        : ''}
    </div>`;
  }

  if (role === 'seer') {
    const log = (me.seerLog || []).slice().reverse();
    return `<div class="panel">
      <div class="panel-title">${me.acted ? 'Ce que tu as vu' : roleHint('seer')}</div>
      ${me.acted
        ? `<p class="summary">Tu as sondé <b>${esc(namesOf([me.myPick]))}</b>.</p>`
        : `${targetGrid(aliveOthers)}${confirmBar('Sonder')}`}
      ${log.length
        ? `<div class="panel-title" style="margin-top:14px">Ton carnet</div>${log
            .map(
              (l) => `<div class="prow"><span class="av" style="${avStyle(l.name)}">${ini(l.name)}</span>
                <span class="pname">${esc(l.name)}</span>
                <span class="badge ${l.role === 'wolf' ? 'wolf' : 'vil'}" style="margin-left:auto">${ROLE_EMOJI[l.role]} ${esc(ROLE_LABELS[l.role])}</span></div>`
            )
            .join('')}`
        : ''}
    </div>`;
  }

  if (role === 'guard') {
    return `<div class="panel">
      <div class="panel-title">${me.acted ? 'Bouclier posé' : roleHint('guard')}</div>
      ${me.acted
        ? `<p class="summary">Tu protèges <b>${esc(namesOf([me.myPick]))}</b> cette nuit.</p>`
        : `${targetGrid(S.players.filter((p) => p.alive), { disabled: (p) => p.id === me.lastGuard })}
           <p class="tiny dim" style="margin:8px 0 0">${me.lastGuard ? `Tu as protégé <b>${esc(namesOf([me.lastGuard]))}</b> la nuit dernière : impossible deux nuits de suite.` : 'Tu peux protéger n\'importe qui.'}</p>
           ${confirmBar('Protéger')}`}
    </div>`;
  }

  if (role === 'witch') {
    const p = me.potions || { heal: true, poison: true };
    if (me.acted) {
      const parts = [];
      if (me.myPick && me.myPick.heal) parts.push('tu as sauvé la victime');
      if (me.myPick && me.myPick.poison) parts.push(`tu as empoisonné ${esc(namesOf([me.myPick.poison]))}`);
      return `<div class="panel">
        <div class="panel-title">Potions</div>
        <p class="summary">${parts.length ? parts.join(' et ') : 'Tu as gardé tes potions.'}</p>
        <p class="tiny dim">Vie : ${p.heal ? 'disponible' : 'utilisée'} · Mort : ${p.poison ? 'disponible' : 'utilisée'}</p>
      </div>`;
    }
    const attacked = me.attacked;
    return `<div class="panel">
      <div class="panel-title">Ce que tu sais</div>
      <p class="summary" style="margin:0 0 10px">${attacked
        ? `Cette nuit, les loups attaquent <b style="color:#ff9d9d">${esc(namesOf([attacked]))}</b>.`
        : 'Les loups ne semblent viser personne pour l\'instant.'}</p>
      <div class="tiny dim" style="margin-bottom:10px">Potion de vie : ${p.heal ? 'disponible' : 'utilisée'} · Potion de mort : ${p.poison ? 'disponible' : 'utilisée'}</div>
      ${witchMode === 'poison'
        ? `${targetGrid(aliveOthers)}
           <div class="row" style="margin-top:10px">
             <button class="btn btn-ghost grow" data-a="witchcancel">Annuler</button>
             <button class="btn btn-wolf grow" data-a="confirm" ${sel.length ? '' : 'disabled'}>Empoisonner</button>
           </div>`
        : `<div class="row" style="flex-wrap:wrap">
             <button class="btn grow" data-a="heal" ${p.heal && attacked ? '' : 'disabled'}>🧪 Sauver${attacked ? ' ' + esc(namesOf([attacked])) : ''}</button>
             <button class="btn grow" data-a="poisonmode" ${p.poison ? '' : 'disabled'}>☠️ Empoisonner</button>
           </div>
           <button class="btn btn-ghost btn-block" style="margin-top:8px" data-a="pass">Ne rien faire</button>`}
    </div>`;
  }

  return '';
}

function deadWaiting() {
  return `<div class="annonce solo">
    <div class="moon-anim">🪦</div>
    <h2 class="disp big">Tu es mort</h2>
    <p class="dim">Silence jusqu'à l'aube. Tu peux regarder, pas parler.</p>
    ${S.lastVictims && S.lastVictims.length ? `<div class="victims">${S.lastVictims.map((v) => `<div class="vrow">${esc(v.name)}</div>`).join('')}</div>` : ''}
  </div>`;
}

/* ------------------------------- jour ------------------------------ */

function dawnView() {
  const v = S.lastVictims || [];
  return `<div class="annonce">
    <div class="moon-anim">🌅</div>
    <h2 class="disp big">Le village se réveille</h2>
    ${v.length
      ? `<p class="dim" style="margin:0 0 8px">Cette nuit, le village a perdu</p>
         <div class="victims">${v.map((x) => `<div class="vrow">${esc(x.name)}</div>`).join('')}</div>`
      : '<p class="dim">Personne n\'est mort cette nuit. Les loups ont raté leur coup.</p>'}
  </div>
  <div class="panel"><div class="panel-title">Le village · ${S.players.filter((p) => p.alive).length} vivants</div>${playerList()}</div>`;
}

function dayView() {
  const me = S.me;
  return `
  ${me.alive ? '' : '<p class="tiny dim center" style="margin:0">Tu es mort : tu ne votes plus, mais tu ne dis rien non plus.</p>'}
  <div class="panel">
    <div class="panel-title">Le village · ${S.players.filter((p) => p.alive).length} vivants</div>
    ${playerList()}
  </div>
  <div class="panel">
    <div class="panel-title">À vous de parler</div>
    <p class="summary" style="margin:0">Qui accuse qui ? Le vote arrive dans ${Math.ceil(S.msLeft / 1000)} s.${me.isHost ? ' Tu peux écourter le débat.' : ''}</p>
    ${me.isHost ? '<button class="btn btn-block" style="margin-top:10px" data-a="skip">Passer au vote</button>' : ''}
  </div>`;
}

function voteView() {
  const me = S.me;
  if (!me.alive) return deadWaiting();
  const targets = S.players.filter((p) => p.alive && !p.isMe);
  const voters = S.players.filter((p) => p.alive);
  return `<div class="panel">
    <div class="panel-title">Qui le village condamne-t-il ?</div>
    ${me.voted
      ? `<p class="summary">Ton vote est enregistré. Attends les autres.</p>`
      : `${targetGrid(targets)}
         <div class="row" style="margin-top:10px">
           <button class="btn btn-ghost grow" data-a="abstain">S'abstenir</button>
           <button class="btn btn-wolf grow" data-a="confirm" ${sel.length ? '' : 'disabled'}>Voter</button>
         </div>`}
  </div>
  <div class="panel">
    <div class="panel-title">Ont voté · ${voters.filter((p) => p.voted).length}/${voters.length}</div>
    <div class="plist">${voters
      .map(
        (p) => `<div class="prow ${p.isMe ? 'me' : ''}">
        <span class="av" style="${avStyle(p.name)}">${ini(p.name)}</span>
        <span class="pname">${esc(p.name)}</span>
        <span class="badge" style="margin-left:auto">${p.voted ? '✓ a voté' : '…'}</span>
      </div>`
      )
      .join('')}</div>
  </div>`;
}

function verdictView() {
  const l = S.lastLynch;
  return `<div class="annonce">
    <div class="moon-anim">⚖️</div>
    <h2 class="disp big">Le verdict</h2>
    ${l ? `<p class="dim" style="margin:0 0 8px">Le village a choisi</p><div class="victims"><div class="vrow">${esc(l.name)}</div></div>` : '<p class="dim">Aucune majorité. Personne ne meurt aujourd\'hui.</p>'}
  </div>
  <div class="panel"><div class="panel-title">Le village</div>${playerList()}</div>`;
}

function hunterView() {
  const me = S.me;
  if (S.pendingHunter !== me.id) {
    return `<div class="annonce solo">
      <div class="moon-anim">🏹</div>
      <h2 class="disp big">Le chasseur arme son fusil</h2>
      <p class="dim">Il tombe, mais il ne tombe pas seul.</p>
      ${S.lastVictims && S.lastVictims.length ? `<div class="victims">${S.lastVictims.map((v) => `<div class="vrow">${esc(v.name)}</div>`).join('')}</div>` : ''}
    </div>`;
  }
  return `<div class="panel">
    <div class="panel-title">Tu meurs, mais tu emportes quelqu'un</div>
    ${targetGrid(S.players.filter((p) => p.alive))}
    <button class="btn btn-wolf btn-block" style="margin-top:10px" data-a="confirm" ${sel.length ? '' : 'disabled'}>Tirer</button>
    <button class="btn btn-ghost btn-block" style="margin-top:8px" data-a="pass">Ne pas tirer</button>
  </div>`;
}

/* ------------------------------- fin ------------------------------- */

function overView() {
  const w = S.winner;
  const title =
    w === 'wolves' ? 'Les loups dévorent le village'
    : w === 'lovers' ? 'Les amoureux gagnent'
    : 'Le village est sauvé';
  const sub =
    w === 'wolves' ? 'La meute a gagné. Personne n\'a rien vu venir.'
    : w === 'lovers' ? 'Ils étaient deux, ils ont survécu à tout le monde.'
    : 'Tous les loups sont morts. Le village respire.';
  return `<div class="over-banner ${w}">
    <div class="t">Fin de la partie</div>
    <h2 class="disp">${esc(title)}</h2>
    <p class="dim" style="margin:8px 0 0;font-size:.9rem">${esc(sub)}</p>
  </div>
  <div class="panel">
    <div class="panel-title">Les rôles</div>
    ${playerList()}
  </div>
  <div class="sticky-bottom">
    ${S.me.isHost ? '<button class="btn btn-primary btn-lg btn-block" data-a="restart">Rejouer avec les mêmes</button>' : '<p class="tiny dim center">L\'hôte peut relancer une manche.</p>'}
  </div>`;
}

/* ------------------------------- chat ------------------------------ */

function chatPanel() {
  if (S.phase !== 'day') return '';
  const me = S.me;
  return `<div class="panel chat">
    <div class="panel-title">Le village parle</div>
    <div class="chatlog" id="chatlog">${S.chat
      .map((m) => `<div class="msg"><span class="who">${esc(m.name)}</span><span class="txt">${esc(m.text)}</span></div>`)
      .join('')}</div>
    <form class="row" data-a="chatform" style="margin-top:8px">
      <input class="inp grow" id="chatinput" maxlength="200" placeholder="${me.alive ? 'Accuser quelqu\'un…' : 'Les morts se taisent'}" ${me.alive ? '' : 'disabled'} autocomplete="off" value="${esc(chatDraft)}">
      <button class="btn btn-sm" type="submit" ${me.alive ? '' : 'disabled'}>Envoyer</button>
    </form>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Interactions                                                       */
/* ------------------------------------------------------------------ */

function confirmAction() {
  const me = S.me;
  if (S.phase === 'cupid') {
    if (sel.length !== 2) return toast('Choisis deux joueurs.');
    return send({ t: 'cupid', lovers: sel.slice(0, 2) });
  }
  if (S.phase === 'night') {
    if (me.role === 'witch') {
      if (witchMode !== 'poison' || !sel.length) return;
      return send({ t: 'night', action: 'poison', target: sel[0] });
    }
    if (!sel.length) return toast('Choisis quelqu\'un.');
    return send({ t: 'night', target: sel[0] });
  }
  if (S.phase === 'vote') {
    if (!sel.length) return;
    return send({ t: 'vote', target: sel[0] });
  }
  if (S.phase === 'hunter') {
    if (!sel.length) return;
    return send({ t: 'hunter', target: sel[0] });
  }
}

document.addEventListener('focusin', (e) => {
  if (e.target && e.target.id) focusId = e.target.id;
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t || !t.id) return;
  if (t.id === 'name') draftName = t.value;
  else if (t.id === 'code') draftCode = t.value.toUpperCase();
  else if (t.id === 'chatinput') chatDraft = t.value;
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-a="chatform"]');
  if (!f) return;
  e.preventDefault();
  const v = chatDraft.trim();
  if (!v) return;
  send({ t: 'chat', text: v });
  chatDraft = '';
  const input = document.getElementById('chatinput');
  if (input) input.value = '';
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a;
  const v = b.dataset.v;

  switch (a) {
    case 'create': {
      const name = (draftName || '').trim();
      if (name.length < 2) {
        const el = document.getElementById('name');
        if (el) el.focus();
        return toast('Choisis un pseudo (2 lettres min).');
      }
      sess = { name };
      save();
      if (P2P) return startHost(name);
      intent = { t: 'join', name };
      wsConnect();
      return;
    }
    case 'join': {
      const name = (draftName || '').trim();
      const code = (draftCode || '').trim().toUpperCase();
      if (name.length < 2) {
        const el = document.getElementById('name');
        if (el) el.focus();
        return toast('Choisis un pseudo d\'abord.');
      }
      if (code.length !== 4) {
        const el = document.getElementById('code');
        if (el) el.focus();
        return toast('Le code fait 4 caractères.');
      }
      sess = { name, code };
      save();
      if (P2P) return startJoin(code, name, null);
      intent = { t: 'join', name, code };
      wsConnect();
      return;
    }
    case 'resume':
      if (P2P) return startJoin(sess.code, sess.name || draftName, sess.token);
      intent = { t: 'join', code: sess.code, name: sess.name || draftName, token: sess.token };
      wsConnect();
      return;
    case 'copy': {
      const url = joinUrl(S.code);
      const done = () => toast('Lien copié');
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => toast(url));
      else toast(url);
      return;
    }
    case 'wolf': {
      const c = { ...S.config, roles: { ...S.config.roles } };
      c.roles.wolf = Math.max(1, Math.min(8, c.roles.wolf + Number(v)));
      return send({ t: 'config', config: { roles: c.roles } });
    }
    case 'role': {
      const c = { ...S.config, roles: { ...S.config.roles } };
      c.roles[v] = c.roles[v] ? 0 : 1;
      return send({ t: 'config', config: { roles: c.roles } });
    }
    case 'seg': {
      const cfg = {};
      cfg[b.dataset.k] = Number(v);
      return send({ t: 'config', config: cfg });
    }
    case 'start':
      return send({ t: 'start' });
    case 'restart':
      return send({ t: 'restart' });
    case 'skip':
      return send({ t: 'skip' });
    case 'rolecard':
      roleOpen = !roleOpen;
      return render();
    case 'pick': {
      const max = S.phase === 'cupid' ? 2 : 1;
      if (sel.includes(v)) sel = sel.filter((x) => x !== v);
      else {
        sel.push(v);
        if (sel.length > max) sel = sel.slice(-max);
      }
      return render();
    }
    case 'confirm':
      return confirmAction();
    case 'heal':
      if (S.me.role === 'witch') return send({ t: 'night', action: 'heal' });
      return;
    case 'poisonmode':
      witchMode = 'poison';
      sel = [];
      return render();
    case 'witchcancel':
      witchMode = 'idle';
      sel = [];
      return render();
    case 'pass':
      if (S.phase === 'night') return send({ t: 'night', action: 'pass' });
      if (S.phase === 'hunter') return send({ t: 'hunter', target: null });
      return;
    case 'abstain':
      return send({ t: 'vote', action: 'abstain' });
    default:
      return;
  }
});

/* ------------------------------------------------------------------ */
/* Demarrage                                                          */
/* ------------------------------------------------------------------ */

if (sess.name) draftName = sess.name;
render();
if (!P2P && sess.token && sess.code) {
  intent = { t: 'join', code: sess.code, name: sess.name, token: sess.token };
  wsConnect();
}
