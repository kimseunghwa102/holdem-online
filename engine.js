// Pure Texas Hold'em engine for up to 5 seats. All functions mutate a plain state object:
// { cfg:{sb,bb,...}, players:{ key:{chips, away, ...} }, seats:[key|null x5], button, handNo, hand }
'use strict';
const { randomInt } = require('crypto');

const SEATS = 5;
const SI = [0, 1, 2, 3, 4];
const RANKS = '23456789TJQKA';
const HAND_NAMES = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시'];

const rv = c => RANKS.indexOf(c[0]) + 2;

function freshDeck() {
  const d = [];
  for (const s of 'shdc') for (const r of RANKS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) { const j = randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

/* ---------- evaluation ---------- */
function score5(cs) {
  const rs = cs.map(rv).sort((a, b) => b - a);
  const flush = cs.every(c => c[1] === cs[0][1]);
  let sh = 0;
  if (new Set(rs).size === 5) { if (rs[0] - rs[4] === 4) sh = rs[0]; else if (rs[0] === 14 && rs[1] === 5) sh = 5; }
  const cnt = {}; rs.forEach(r => (cnt[r] = (cnt[r] || 0) + 1));
  const g = Object.entries(cnt).map(([r, c]) => [c, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const ord = g.map(x => x[1]);
  if (sh && flush) return [8, sh];
  if (g[0][0] === 4) return [7, ...ord];
  if (g[0][0] === 3 && g[1][0] === 2) return [6, ...ord];
  if (flush) return [5, ...rs];
  if (sh) return [4, sh];
  if (g[0][0] === 3) return [3, ...ord];
  if (g[0][0] === 2 && g[1][0] === 2) return [2, ...ord];
  if (g[0][0] === 2) return [1, ...ord];
  return [0, ...rs];
}
function cmp(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }
function bestHand(cards) {
  let best = null, five = null; const n = cards.length, pick = [];
  (function rec(st) {
    if (pick.length === 5) { const s = score5(pick); if (!best || cmp(s, best) > 0) { best = s; five = pick.slice(); } return; }
    for (let i = st; i <= n - (5 - pick.length); i++) { pick.push(cards[i]); rec(i + 1); pick.pop(); }
  })(0);
  return { score: best, cards: five };
}
const handName = s => (s[0] === 8 && s[1] === 14 ? '로열 플러시' : HAND_NAMES[s[0]]);

/* ---------- helpers ---------- */
const hp = (s, i) => s.hand && s.hand.ps[i];
const stk = (s, i) => { const p = hp(s, i); return p ? (s.players[p.pid] ? s.players[p.pid].chips : 0) : 0; };
const isLive = (s, i) => { const p = hp(s, i); return !!p && !p.folded; };
const canAct = (s, i) => isLive(s, i) && stk(s, i) > 0;
const pname = (s, i) => { const p = hp(s, i); return (p && s.players[p.pid] && s.players[p.pid].name) || '?'; };
function putIn(s, i, a) { const p = hp(s, i); s.players[p.pid].chips -= a; p.bet += a; p.total += a; }
function logH(h, t) { h.log.push(t); if (h.log.length > 6) h.log.shift(); }

function needsAct(s, i) {
  const h = s.hand; if (!canAct(s, i)) return false;
  const p = h.ps[i];
  const others = SI.filter(j => j !== i && canAct(s, j)).length;
  if (others === 0 && p.bet >= h.currentBet) return false;
  return !p.acted || p.bet < h.currentBet;
}
function canRaise(s, i) {
  const h = s.hand, p = h.ps[i];
  if (stk(s, i) <= h.currentBet - p.bet) return false;
  if (p.acted) return false; // only an incomplete all-in raise since this player acted
  return SI.some(j => j !== i && canAct(s, j));
}
function options(s, i) {
  const h = s.hand, p = h.ps[i], st = stk(s, i);
  const maxTo = p.bet + st;
  return {
    toCall: Math.min(h.currentBet - p.bet, st),
    minTo: Math.min(h.currentBet + h.minRaise, maxTo),
    maxTo,
    canRaise: canRaise(s, i),
    currentBet: h.currentBet,
    pot: h.ps.reduce((a, q) => a + (q ? q.total : 0), 0),
  };
}
function eligibleSeats(s) {
  return SI.filter(i => { const p = s.players[s.seats[i]]; return p && p.chips > 0 && !p.away; });
}
function nextIn(list, from) { for (let k = 1; k <= SEATS; k++) { const j = (from + k) % SEATS; if (list.includes(j)) return j; } return -1; }

/* ---------- flow ---------- */
function startHand(s) {
  const el = eligibleSeats(s); if (el.length < 2) return false;
  const button = nextIn(el, s.button < 0 ? randomInt(SEATS) : s.button);
  let sbSeat, bbSeat;
  if (el.length === 2) { sbSeat = button; bbSeat = nextIn(el, button); }
  else { sbSeat = nextIn(el, button); bbSeat = nextIn(el, sbSeat); }
  const deck = freshDeck(), ps = Array(SEATS).fill(null);
  el.forEach(i => (ps[i] = { pid: s.seats[i], hole: [deck.pop(), deck.pop()], bet: 0, total: 0, folded: false, acted: false }));
  s.handNo = (s.handNo || 0) + 1; s.button = button;
  s.hand = { no: s.handNo, sb: s.cfg.sb, bb: s.cfg.bb, button, sbSeat, bbSeat, deck, board: [], street: 0,
    currentBet: 0, minRaise: s.cfg.bb, toAct: -1, turnAt: 0, ps, log: [], over: false, result: null };
  const h = s.hand;
  const a = Math.min(h.sb, stk(s, sbSeat)); putIn(s, sbSeat, a);
  const b = Math.min(h.bb, stk(s, bbSeat)); putIn(s, bbSeat, b);
  h.currentBet = Math.max(a, b);
  logH(h, `${pname(s, sbSeat)} SB ${a} · ${pname(s, bbSeat)} BB ${b}`);
  advance(s, bbSeat);
  return true;
}
function advance(s, from) {
  const h = s.hand;
  const live = SI.filter(i => isLive(s, i));
  if (live.length === 1) { winByFold(s, live[0]); return; }
  for (let k = 1; k <= SEATS; k++) { const j = (from + k) % SEATS; if (needsAct(s, j)) { h.toAct = j; h.turnAt = Date.now(); return; } }
  endStreet(s);
}
function endStreet(s) {
  const h = s.hand;
  h.ps.forEach(p => { if (p) { p.bet = 0; p.acted = false; } });
  h.currentBet = 0; h.minRaise = h.bb; h.toAct = -1;
  const actors = SI.filter(i => canAct(s, i)).length;
  if (h.street === 3 || actors <= 1) {
    while (h.board.length < 5) h.board.push(h.deck.pop());
    h.street = 3; showdown(s); return;
  }
  h.street++;
  if (h.street === 1) h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop()); else h.board.push(h.deck.pop());
  advance(s, h.button);
}
// type: fold | call (check/call) | raise (to = total bet this street) | auto (timeout: check if free, else fold)
function doAction(s, seat, type, to) {
  const h = s.hand; if (!h || h.over || h.toAct !== seat) return false;
  const p = h.ps[seat], st = stk(s, seat), n = pname(s, seat);
  if (type === 'auto') {
    if (h.currentBet - p.bet <= 0) { p.acted = true; logH(h, `${n} 시간초과 체크`); }
    else { p.folded = true; p.acted = true; logH(h, `${n} 시간초과 폴드`); }
  } else if (type === 'fold') { p.folded = true; p.acted = true; logH(h, `${n} 폴드`); }
  else if (type === 'call') {
    const a = Math.min(h.currentBet - p.bet, st); putIn(s, seat, a); p.acted = true;
    logH(h, a ? `${n} 콜 ${a}${stk(s, seat) === 0 ? ' (올인)' : ''}` : `${n} 체크`);
  } else if (type === 'raise') {
    if (!canRaise(s, seat)) return false;
    const maxTo = p.bet + st; to = Math.min(Math.floor(Number(to) || 0), maxTo);
    const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
    if (!(to >= minTo && to > h.currentBet)) return false;
    const inc = to - h.currentBet, was = h.currentBet;
    putIn(s, seat, to - p.bet);
    if (inc >= h.minRaise) { h.minRaise = inc; h.ps.forEach((q, j) => { if (q && j !== seat) q.acted = false; }); }
    h.currentBet = to; p.acted = true;
    logH(h, `${n} ${was === 0 ? '벳' : '레이즈'} ${to}${stk(s, seat) === 0 ? ' (올인)' : ''}`);
  } else return false;
  advance(s, seat);
  return true;
}
function winByFold(s, w) {
  const h = s.hand; const amount = h.ps.reduce((a, p) => a + (p ? p.total : 0), 0);
  s.players[h.ps[w].pid].chips += amount;
  h.ps.forEach(p => { if (p) p.bet = 0; });
  h.over = true; h.toAct = -1; h.result = { reason: 'fold', wins: { [w]: amount }, shown: {}, best: {}, pot: amount };
  logH(h, `${pname(s, w)} +${amount}`);
}
function showdown(s) {
  const h = s.hand, live = SI.filter(i => isLive(s, i)), ev = {};
  live.forEach(i => (ev[i] = bestHand([...h.ps[i].hole, ...h.board])));
  const contrib = h.ps.map(p => (p ? p.total : 0)), wins = {};
  const potTotal = contrib.reduce((a, c) => a + c, 0);
  const dist = i => ((i - h.button + SEATS) % SEATS) || SEATS;
  const bestOf = arr => { let b = []; arr.forEach(i => { if (!b.length) b = [i]; else { const c = cmp(ev[i].score, ev[b[0]].score); if (c > 0) b = [i]; else if (!c) b.push(i); } }); return b; };
  const pay = (amt, ws, refund) => {
    const o = ws.slice().sort((a, b) => dist(a) - dist(b)); const base = Math.floor(amt / o.length); let rem = amt - base * o.length;
    o.forEach(i => { const x = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; s.players[h.ps[i].pid].chips += x; if (!refund) wins[i] = (wins[i] || 0) + x; });
  };
  for (let guard = 0; guard < 12 && contrib.some(c => c > 0); guard++) {
    const cands = live.filter(i => contrib[i] > 0);
    if (!cands.length) { const rest = contrib.reduce((a, c) => a + c, 0); contrib.fill(0); pay(rest, bestOf(live), false); break; }
    const lvl = Math.min(...cands.map(i => contrib[i])); let amt = 0;
    contrib.forEach((c, i) => { const t = Math.min(c, lvl); amt += t; contrib[i] -= t; });
    pay(amt, bestOf(cands), cands.length === 1 && live.length > 1);
  }
  h.ps.forEach(p => { if (p) p.bet = 0; });
  h.over = true; h.toAct = -1;
  const shown = {}, best = {};
  live.forEach(i => (shown[i] = handName(ev[i].score)));
  Object.keys(wins).forEach(i => (best[i] = ev[i].cards));
  h.result = { reason: 'show', wins, shown, best, pot: potTotal };
  logH(h, Object.entries(wins).map(([i, a]) => `${pname(s, +i)} +${a}`).join(' · ') || '쇼다운');
}
// A seated player leaves or disconnects for good mid-hand: fold them and keep the hand moving.
function foldOut(s, seat, why) {
  const h = s.hand; if (!h || h.over) return;
  const p = h.ps[seat]; if (!p || p.folded) return;
  p.folded = true; p.acted = true; logH(h, `${pname(s, seat)} ${why}`);
  const live = SI.filter(i => isLive(s, i));
  if (live.length === 1) { winByFold(s, live[0]); return; }
  if (!needsAct(s, h.toAct)) advance(s, h.toAct);
}
const inActiveHand = (s, key) => !!(s.hand && !s.hand.over && s.hand.ps.some(p => p && p.pid === key && !p.folded));

module.exports = { SEATS, SI, bestHand, handName, cmp, startHand, doAction, options, needsAct, canRaise, eligibleSeats, foldOut, inActiveHand };
