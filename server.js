'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const E = require('./engine');
const makeStore = require('./store');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DEFAULT_CFG = { start: 1000, sb: 10, bb: 20, recoverPct: 50, turnSecs: 30 };
const MAX_PLAYERS = 300;           // accounts kept in the ledger
const OFFLINE_STAND_MS = 120000;   // offline this long while not in a hand → stood up
const NEXT_HAND_MS = +process.env.NEXT_HAND_MS || 6000; // pause between hands so everyone sees the result

/* ---------- state ---------- */
// admin = name key of the room owner (the first account ever registered, transferable)
const S = { cfg: { ...DEFAULT_CFG }, players: {}, admin: null, seats: Array(E.SEATS).fill(null), button: -1, handNo: 0, hand: null, nextAt: 0 };
const RT = new Map(); // per-player runtime (never persisted): sock, lastSeen, fails, lockUntil, timeouts
const rt = k => { let r = RT.get(k); if (!r) { r = { sock: null, lastSeen: 0, fails: 0, lockUntil: 0, timeouts: 0 }; RT.set(k, r); } return r; };

const PERSIST = ['name', 'pinHash', 'salt', 'chips', 'invested', 'busts', 'recovers', 'handsPlayed', 'handsWon', 'bestPot', 'token', 'createdAt', 'lastSeen'];
let store;
function snapshot() {
  const players = {};
  for (const [k, p] of Object.entries(S.players)) { const o = {}; PERSIST.forEach(f => { if (p[f] !== undefined) o[f] = p[f]; }); players[k] = o; }
  // chips committed to an unfinished hand are saved as if refunded, so a restart never eats a pot
  if (S.hand && !S.hand.over) S.hand.ps.forEach(q => { if (q && players[q.pid]) players[q.pid].chips += q.total; });
  return { v: 1, cfg: S.cfg, admin: S.admin, players };
}
let saveT = null, saving = false, dirty = false;
function saveSoon() { dirty = true; if (!saveT) saveT = setTimeout(flush, 800); }
async function flush() {
  saveT = null; if (!dirty) return; if (saving) { saveSoon(); return; }
  dirty = false; saving = true;
  try { await store.save(snapshot()); }
  catch (e) { console.error('[save] failed:', e.message); dirty = true; setTimeout(saveSoon, 3000); }
  finally { saving = false; }
}

/* ---------- accounts ---------- */
const nameKey = n => n.normalize('NFC').trim().toLowerCase();
function validName(n) {
  if (typeof n !== 'string') return null;
  n = n.normalize('NFC').trim().replace(/\s+/g, ' ');
  const len = Array.from(n).length;
  if (len < 1 || len > 10 || /[\u0000-\u001f\u007f<>]/.test(n)) return null;
  return n;
}
const validPin = p => typeof p === 'string' && /^\d{4}$/.test(p);
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
function checkPin(p, pin) {
  const a = Buffer.from(hashPin(pin, p.salt), 'hex'), b = Buffer.from(p.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPin(p, pin) { p.salt = crypto.randomBytes(16).toString('hex'); p.pinHash = hashPin(pin, p.salt); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

/* ---------- game flow ---------- */
let turnT = null, nextT = null;
function armTurn() {
  clearTimeout(turnT); turnT = null;
  const h = S.hand; if (!h || h.over || h.toAct < 0) return;
  const key = h.ps[h.toAct].pid, offline = !rt(key).sock;
  const ms = (offline ? Math.min(8, S.cfg.turnSecs) : S.cfg.turnSecs) * 1000;
  h.deadline = h.turnAt + ms;
  const no = h.no, seat = h.toAct, at = h.turnAt;
  turnT = setTimeout(() => {
    const x = S.hand; if (!x || x.no !== no || x.over || x.toAct !== seat || x.turnAt !== at) return;
    const r = rt(key); r.timeouts++;
    E.doAction(S, seat, 'auto');
    if (r.timeouts >= 2 && S.players[key]) S.players[key].away = true;
    changed();
  }, Math.max(0, h.deadline - Date.now()));
}
function scheduleNext() {
  const h = S.hand;
  if ((h && !h.over) || E.eligibleSeats(S).length < 2) { clearTimeout(nextT); nextT = null; S.nextAt = 0; return; }
  if (nextT) return;
  const delay = h ? NEXT_HAND_MS : 3000; S.nextAt = Date.now() + delay;
  nextT = setTimeout(() => { nextT = null; S.nextAt = 0; if (S.hand && !S.hand.over) return; E.startHand(S); changed(); }, delay);
}
function book(h) {
  h.booked = true;
  h.ps.forEach((q, i) => {
    if (!q) return; const p = S.players[q.pid]; if (!p) return;
    p.handsPlayed = (p.handsPlayed || 0) + 1;
    if (h.result && h.result.wins[i]) { p.handsWon = (p.handsWon || 0) + 1; p.bestPot = Math.max(p.bestPot || 0, h.result.pot || 0); }
    if (p.chips === 0) p.busts = (p.busts || 0) + 1;
  });
}
function changed() {
  if (S.hand && S.hand.over && !S.hand.booked) book(S.hand);
  armTurn(); scheduleNext(); saveSoon(); broadcast();
}
function stand(key, why) {
  const p = S.players[key]; if (!p || p.seat == null) return;
  const seat = p.seat, h = S.hand;
  if (h && !h.over && h.ps[seat] && h.ps[seat].pid === key) E.foldOut(S, seat, why);
  if (S.seats[seat] === key) S.seats[seat] = null;
  p.seat = null; p.away = false;
}

/* ---------- views ---------- */
function ranking() {
  return Object.entries(S.players)
    .map(([k, p]) => ({ name: p.name, chips: p.chips, net: p.chips - (p.invested || 0), busts: p.busts || 0, recovers: p.recovers || 0,
      handsWon: p.handsWon || 0, handsPlayed: p.handsPlayed || 0, bestPot: p.bestPot || 0, online: !!rt(k).sock, seated: p.seat != null }))
    .sort((a, b) => b.chips - a.chips || b.net - a.net)
    .slice(0, 100);
}
function viewFor(key, rank) {
  const now = Date.now(), h = S.hand, me = key && S.players[key];
  const recoverAmt = Math.max(S.cfg.bb, Math.floor(S.cfg.start * S.cfg.recoverPct / 100));
  const v = {
    cfg: { start: S.cfg.start, sb: S.cfg.sb, bb: S.cfg.bb, recoverPct: S.cfg.recoverPct, turnSecs: S.cfg.turnSecs },
    adminKeyEnabled: !!ADMIN_KEY,
    owner: S.admin && S.players[S.admin] ? S.players[S.admin].name : null,
    me: me ? { name: me.name, isAdmin: key === S.admin, chips: me.chips, invested: me.invested || 0, seat: me.seat ?? null, away: !!me.away, busts: me.busts || 0,
      recovers: me.recovers || 0, canRecover: me.chips === 0 && !E.inActiveHand(S, key), recoverAmt } : null,
    seats: S.seats.map(k => { const p = k && S.players[k]; return p ? { name: p.name, chips: p.chips, away: !!p.away, online: !!rt(k).sock, me: k === key } : null; }),
    button: S.button, handNo: S.handNo, nextIn: S.nextAt ? Math.max(0, S.nextAt - now) : 0,
    hand: null, ranking: rank,
  };
  if (h) {
    const mySeat = me && me.seat != null ? me.seat : -1;
    v.hand = {
      no: h.no, street: h.street, board: h.board, toAct: h.toAct, over: h.over, sb: h.sb, bb: h.bb, button: h.button,
      turnLeft: h.over ? 0 : Math.max(0, (h.deadline || 0) - now), log: h.log.slice(-3),
      pot: h.ps.reduce((a, q) => a + (q ? q.total : 0), 0),
      ps: h.ps.map((q, i) => {
        if (!q) return null; const p = S.players[q.pid];
        const reveal = q.pid === key || (h.over && h.result && h.result.shown[i] != null);
        return { name: p ? p.name : '?', bet: q.bet, folded: q.folded, allin: !q.folded && !h.over && (p ? p.chips : 0) === 0,
          cards: reveal ? q.hole : null, current: S.seats[i] === q.pid };
      }),
      result: h.over ? h.result : null,
      opts: !h.over && mySeat >= 0 && h.toAct === mySeat && h.ps[mySeat] && h.ps[mySeat].pid === key ? E.options(S, mySeat) : null,
      myBest: mySeat >= 0 && h.ps[mySeat] && h.ps[mySeat].pid === key && !h.ps[mySeat].folded && h.board.length >= 3
        ? E.handName(E.bestHand([...h.ps[mySeat].hole, ...h.board]).score) : null,
    };
  }
  return v;
}
let io;
function broadcast() {
  const rank = ranking();
  for (const sock of io.sockets.sockets.values()) sock.emit('state', viewFor(sock.data.key, rank));
}

/* ---------- sockets ---------- */
function attach(sock, key) {
  const r = rt(key);
  if (r.sock && r.sock !== sock) { r.sock.emit('kicked'); r.sock.data.key = null; }
  r.sock = sock; r.lastSeen = Date.now(); sock.data.key = key;
  S.players[key].lastSeen = Date.now();
}
function handler(sock, fn) {
  return (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try { fn(msg || {}, reply); } catch (e) { console.error('[handler]', e); reply({ ok: false, msg: '서버 오류가 났어요.' }); }
  };
}

function setupSockets(server) {
  io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });
  io.on('connection', sock => {
    sock.data.key = null; sock.data.tries = 0; sock.data.adminTries = 0;
    sock.emit('state', viewFor(null, ranking()));

    sock.on('resume', handler(sock, ({ token }, ack) => {
      if (typeof token !== 'string' || token.length < 20) return ack({ ok: false });
      const entry = Object.entries(S.players).find(([, p]) => p.token && safeEq(p.token, token));
      if (!entry) return ack({ ok: false });
      attach(sock, entry[0]); ack({ ok: true, name: entry[1].name }); changed();
    }));

    sock.on('login', handler(sock, ({ name, pin }, ack) => {
      if (++sock.data.tries > 30) return ack({ ok: false, msg: '시도가 너무 많아요. 새로고침 후 다시 해주세요.' });
      const n = validName(name);
      if (!n) return ack({ ok: false, msg: '닉네임은 1~10자로 입력하세요.' });
      if (!validPin(pin)) return ack({ ok: false, msg: 'PIN은 숫자 4자리예요.' });
      const key = nameKey(n), r = rt(key); let p = S.players[key], isNew = false;
      if (p) {
        if (r.lockUntil > Date.now()) return ack({ ok: false, msg: `PIN을 여러 번 틀렸어요. ${Math.ceil((r.lockUntil - Date.now()) / 60000)}분 뒤에 다시 해주세요.` });
        if (!checkPin(p, pin)) {
          r.fails++; if (r.fails >= 5) { r.lockUntil = Date.now() + 5 * 60000; r.fails = 0; }
          return ack({ ok: false, msg: '이미 있는 닉네임이고 PIN이 달라요. 처음이면 다른 닉네임을 쓰세요.' });
        }
        r.fails = 0;
      } else {
        if (Object.keys(S.players).length >= MAX_PLAYERS) return ack({ ok: false, msg: '등록 인원이 가득 찼어요. 관리자에게 문의하세요.' });
        p = S.players[key] = { name: n, chips: S.cfg.start, invested: S.cfg.start, busts: 0, recovers: 0, handsPlayed: 0, handsWon: 0, bestPot: 0, createdAt: Date.now() };
        setPin(p, pin); isNew = true;
        if (!S.admin || !S.players[S.admin]) S.admin = key; // first account becomes the room owner
      }
      p.token = crypto.randomBytes(24).toString('hex');
      attach(sock, key);
      ack({ ok: true, name: p.name, token: p.token, isNew, chips: p.chips });
      changed();
    }));

    sock.on('logout', handler(sock, (_, ack) => {
      const key = sock.data.key; if (!key) return ack({ ok: true });
      stand(key, '퇴장 (폴드)'); const p = S.players[key]; if (p) p.token = null;
      const r = rt(key); if (r.sock === sock) r.sock = null;
      sock.data.key = null; ack({ ok: true }); changed();
    }));

    const authed = fn => handler(sock, (msg, ack) => {
      const key = sock.data.key; if (!key || !S.players[key]) return ack({ ok: false, msg: '먼저 입장해주세요.' });
      fn(key, S.players[key], msg, ack);
    });

    sock.on('sit', authed((key, p, { seat }, ack) => {
      seat = Number(seat);
      if (!Number.isInteger(seat) || seat < 0 || seat >= E.SEATS) return ack({ ok: false });
      if (p.seat != null) return ack({ ok: false, msg: '이미 앉아 있어요.' });
      if (S.seats[seat]) return ack({ ok: false, msg: '방금 다른 사람이 앉았어요.' });
      S.seats[seat] = key; p.seat = seat; p.away = false; rt(key).timeouts = 0;
      ack({ ok: true }); changed();
    }));
    sock.on('stand', authed((key, p, _, ack) => { stand(key, '퇴장 (폴드)'); ack({ ok: true }); changed(); }));
    sock.on('away', authed((key, p, _, ack) => {
      if (p.seat == null) return ack({ ok: false });
      p.away = !p.away; rt(key).timeouts = 0; ack({ ok: true }); changed();
    }));
    sock.on('recover', authed((key, p, _, ack) => {
      if (p.chips > 0) return ack({ ok: false, msg: '칩이 남아 있으면 복구할 수 없어요.' });
      if (E.inActiveHand(S, key)) return ack({ ok: false, msg: '이번 핸드가 끝난 뒤에 복구할 수 있어요.' });
      const amt = Math.max(S.cfg.bb, Math.floor(S.cfg.start * S.cfg.recoverPct / 100));
      p.chips += amt; p.invested = (p.invested || 0) + amt; p.recovers = (p.recovers || 0) + 1;
      ack({ ok: true, amount: amt }); changed();
    }));
    sock.on('act', authed((key, p, { type, to, no }, ack) => {
      const h = S.hand;
      if (!h || h.over || h.no !== no || p.seat == null || h.toAct !== p.seat || !h.ps[p.seat] || h.ps[p.seat].pid !== key) return ack({ ok: false, msg: '지금은 내 차례가 아니에요.' });
      if (!['fold', 'call', 'raise'].includes(type)) return ack({ ok: false });
      if (!E.doAction(S, p.seat, type, to)) return ack({ ok: false, msg: '그 금액으로는 레이즈할 수 없어요.' });
      rt(key).timeouts = 0; ack({ ok: true }); changed();
    }));

    sock.on('admin', handler(sock, (msg, ack) => {
      const byOwner = !!sock.data.key && sock.data.key === S.admin;
      const byKey = !!ADMIN_KEY && typeof msg.key === 'string' && msg.key.length > 0 && ++sock.data.adminTries <= 200 && safeEq(msg.key, ADMIN_KEY);
      if (!byOwner && !byKey) return ack({ ok: false, msg: ADMIN_KEY ? '방장만 쓸 수 있어요. (또는 관리자 키가 틀렸어요)' : '방장만 쓸 수 있어요.' });
      const int = x => (Number.isFinite(+x) ? Math.floor(+x) : NaN);
      const target = () => { const n = validName(msg.name); return n ? [nameKey(n), S.players[nameKey(n)]] : [null, null]; };
      switch (msg.op) {
        case 'check': return ack({ ok: true, cfg: S.cfg, owner: S.admin && S.players[S.admin] ? S.players[S.admin].name : null, names: Object.values(S.players).map(p => p.name).sort() });
        case 'setAdmin': {
          const [k, p] = target();
          if (!p) return ack({ ok: false, msg: '그런 닉네임이 없어요.' });
          S.admin = k; ack({ ok: true, msg: `이제 ${p.name}이(가) 방장이에요.` }); return changed();
        }
        case 'cfg': {
          const c = { start: int(msg.start), sb: int(msg.sb), bb: int(msg.bb), recoverPct: int(msg.recoverPct), turnSecs: int(msg.turnSecs) };
          if (!(c.sb >= 1 && c.bb >= c.sb)) return ack({ ok: false, msg: 'BB는 SB 이상이어야 해요.' });
          if (!(c.start >= c.bb * 2)) return ack({ ok: false, msg: `시작 칩은 BB의 2배(${c.bb * 2}) 이상이어야 해요.` });
          if (!(c.recoverPct >= 1 && c.recoverPct <= 100)) return ack({ ok: false, msg: '복구 비율은 1~100%예요.' });
          if (!(c.turnSecs >= 10 && c.turnSecs <= 120)) return ack({ ok: false, msg: '제한 시간은 10~120초예요.' });
          S.cfg = c; ack({ ok: true, msg: '저장했어요. 블라인드는 다음 핸드부터 적용돼요.' }); return changed();
        }
        case 'setChips': {
          const [k, p] = target(); const v = int(msg.chips);
          if (!p) return ack({ ok: false, msg: '그런 닉네임이 없어요.' });
          if (E.inActiveHand(S, k)) return ack({ ok: false, msg: '핸드가 끝난 뒤에 바꿀 수 있어요.' });
          if (!(v >= 0)) return ack({ ok: false, msg: '칩은 0 이상이에요.' });
          p.chips = v; if (msg.alsoInvested) p.invested = v;
          ack({ ok: true, msg: `${p.name} 칩을 ${v.toLocaleString()}으로 바꿨어요.` }); return changed();
        }
        case 'resetPin': {
          const [k, p] = target();
          if (!p) return ack({ ok: false, msg: '그런 닉네임이 없어요.' });
          if (!validPin(msg.pin)) return ack({ ok: false, msg: '새 PIN은 숫자 4자리예요.' });
          setPin(p, msg.pin); p.token = null; rt(k).fails = 0; rt(k).lockUntil = 0;
          ack({ ok: true, msg: `${p.name} PIN을 바꿨어요.` }); return changed();
        }
        case 'delete': {
          const [k, p] = target();
          if (!p) return ack({ ok: false, msg: '그런 닉네임이 없어요.' });
          if (p.seat != null || E.inActiveHand(S, k)) return ack({ ok: false, msg: '자리에 앉아 있는 사람은 지울 수 없어요.' });
          if (k === S.admin) return ack({ ok: false, msg: '방장 계정은 지울 수 없어요. 먼저 방장을 넘겨주세요.' });
          const r = rt(k); if (r.sock) { r.sock.emit('kicked'); r.sock.data.key = null; }
          delete S.players[k]; RT.delete(k);
          ack({ ok: true, msg: `${p.name}을(를) 삭제했어요.` }); return changed();
        }
        case 'resetAll': {
          if (S.hand && !S.hand.over) return ack({ ok: false, msg: '진행 중인 핸드가 끝난 뒤에 초기화할 수 있어요.' });
          Object.values(S.players).forEach(p => Object.assign(p, { chips: S.cfg.start, invested: S.cfg.start, busts: 0, recovers: 0, handsPlayed: 0, handsWon: 0, bestPot: 0 }));
          S.hand = null;
          ack({ ok: true, msg: `모든 칩을 ${S.cfg.start.toLocaleString()}으로 초기화했어요.` }); return changed();
        }
        default: return ack({ ok: false });
      }
    }));

    sock.on('disconnect', () => {
      const key = sock.data.key; if (!key) return;
      const r = rt(key); if (r.sock === sock) { r.sock = null; r.lastSeen = Date.now(); }
      changed();
    });
  });
}

// stand up players who have been gone a while (only between their hands)
setInterval(() => {
  let any = false;
  S.seats.forEach(k => {
    if (!k) return; const r = rt(k);
    if (!r.sock && Date.now() - r.lastSeen > OFFLINE_STAND_MS && !E.inActiveHand(S, k)) { stand(k, '연결 끊김'); any = true; }
  });
  if (any) changed();
}, 15000).unref();

/* ---------- boot ---------- */
(async () => {
  store = await makeStore();
  const data = await store.load();
  if (data) {
    S.cfg = { ...DEFAULT_CFG, ...(data.cfg || {}) };
    S.players = data.players || {};
    S.admin = data.admin && S.players[data.admin] ? data.admin : null;
    Object.values(S.players).forEach(p => { p.seat = null; p.away = false; });
  }
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_, res) => res.json({ ok: true, store: store.kind.split(':')[0], players: Object.keys(S.players).length }));
  const INDEX = path.join(__dirname, 'index.html'); // only this file is served; server code stays private
  app.get(['/', '/index.html'], (_, res) => res.sendFile(INDEX));
  const server = http.createServer(app);
  setupSockets(server);
  server.listen(PORT, () => console.log(`holdem on :${PORT} · store ${store.kind} · admin ${ADMIN_KEY ? 'on' : 'off'}`));
  const bye = async () => { try { dirty = true; await flush(); } finally { process.exit(0); } };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
})().catch(e => { console.error('boot failed:', e); process.exit(1); });
