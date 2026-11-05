// "AI 알파": the resident house player. It sees only what any seated player sees:
// its own two cards, the board, the bets, and how many opponents are still in the hand.
'use strict';
const E = require('./engine');

const KEY = '<ai>';          // ledger key; human keys can never contain '<'
const NAME = 'AI 알파';
const SEAT_ORDER = [2, 3, 1, 4, 0];
const RANKS = '23456789TJQKA', SUITS = 'shdc';
const toInt = c => RANKS.indexOf(c[0]) * 4 + SUITS.indexOf(c[1]);

/* ---------- fast 5–7 card evaluator: a bigger number is a better hand ---------- */
const pack = (cat, a = 0, b = 0, c = 0, d = 0, e = 0) => cat * 1048576 + a * 65536 + b * 4096 + c * 256 + d * 16 + e;
function straightHigh(m) {
  for (let top = 12; top >= 4; top--) if (((m >> (top - 4)) & 31) === 31) return top;
  return (m & 0x100f) === 0x100f ? 3 : -1; // A-2-3-4-5
}
function topN(m, n, out) { let k = 0; for (let r = 12; r >= 0 && k < n; r--) if ((m >> r) & 1) out[k++] = r; return out; }
const T5 = [0, 0, 0, 0, 0], RC = new Array(13), SM = [0, 0, 0, 0], SC = [0, 0, 0, 0];
function evalN(cs, n) {
  RC.fill(0); SM[0] = SM[1] = SM[2] = SM[3] = 0; SC[0] = SC[1] = SC[2] = SC[3] = 0;
  let m = 0;
  for (let i = 0; i < n; i++) { const c = cs[i], r = c >> 2, s = c & 3; RC[r]++; m |= 1 << r; SM[s] |= 1 << r; SC[s]++; }
  for (let s = 0; s < 4; s++) if (SC[s] >= 5) { // with 7 cards a flush rules out quads and full houses
    const sh = straightHigh(SM[s]); if (sh >= 0) return pack(8, sh);
    const t = topN(SM[s], 5, T5); return pack(5, t[0], t[1], t[2], t[3], t[4]);
  }
  let q = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const k = RC[r];
    if (k === 4) q = r;
    else if (k === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
    else if (k === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }
  if (q >= 0) return pack(7, q, topN(m & ~(1 << q), 1, T5)[0]);
  if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return pack(6, t1, Math.max(t2, p1));
  const sh = straightHigh(m); if (sh >= 0) return pack(4, sh);
  if (t1 >= 0) { const k = topN(m & ~(1 << t1), 2, T5); return pack(3, t1, k[0], k[1]); }
  if (p2 >= 0) return pack(2, p1, p2, topN(m & ~(1 << p1) & ~(1 << p2), 1, T5)[0]);
  if (p1 >= 0) { const k = topN(m & ~(1 << p1), 3, T5); return pack(1, p1, k[0], k[1], k[2]); }
  const k = topN(m, 5, T5); return pack(0, k[0], k[1], k[2], k[3], k[4]);
}

/* ---------- Monte Carlo: share of pots won against `opps` random hands ---------- */
function equity(hole, board, opps, iters) {
  const dead = new Set([...hole, ...board]), deck = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) deck.push(c);
  const need = 5 - board.length, draw = need + 2 * opps, mine = new Array(7), his = new Array(7);
  mine[0] = hole[0]; mine[1] = hole[1];
  board.forEach((c, i) => { mine[2 + i] = c; his[2 + i] = c; });
  let won = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < draw; i++) { const j = i + Math.floor(Math.random() * (deck.length - i)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    for (let i = 0; i < need; i++) mine[2 + board.length + i] = his[2 + board.length + i] = deck[i];
    const me = evalN(mine, 7);
    let ties = 0, lost = false;
    for (let o = 0; o < opps; o++) {
      his[0] = deck[need + 2 * o]; his[1] = deck[need + 2 * o + 1];
      const v = evalN(his, 7);
      if (v > me) { lost = true; break; }
      if (v === me) ties++;
    }
    if (!lost) won += 1 / (ties + 1);
  }
  return won / iters;
}

/* ---------- betting policy ---------- */
// rel = equity × players in the hand: 1 is an average hand, 1.7+ is a monster.
function decide(S, seat) {
  const h = S.hand, me = h.ps[seat], o = E.options(S, seat), bb = h.bb;
  const stack = S.players[me.pid].chips;
  const opps = Math.max(1, h.ps.filter((q, i) => q && i !== seat && !q.folded).length);
  const eq = equity(me.hole.map(toInt), h.board.map(toInt), opps, opps === 1 ? 3000 : 2000);
  const rel = eq * (opps + 1), r = Math.random();
  const short = stack + me.bet <= 8 * bb;
  const raiseTo = f => {
    let to = Math.round((o.currentBet + Math.max(bb, (o.pot + o.toCall) * f)) / bb) * bb;
    if (to >= (me.bet + stack) * 0.7) to = o.maxTo; // most of the stack anyway: shove
    return Math.max(o.minTo, Math.min(o.maxTo, to));
  };
  const raise = f => (o.canRaise ? { type: 'raise', to: raiseTo(f) } : { type: 'call' });
  const shove = () => (o.canRaise ? { type: 'raise', to: o.maxTo } : { type: 'call' });
  if (o.toCall === 0) { // free to check
    if (o.canRaise) {
      if (short && rel >= 1.25) return shove();
      if (rel >= 1.7 && r < 0.8) return raise(0.6 + Math.random() * 0.3);
      if (rel >= 1.35 && r < 0.6) return raise(0.45 + Math.random() * 0.25);
      if (rel >= 1.1 && r < 0.25) return raise(0.35 + Math.random() * 0.15);
      if (rel < 0.8 && opps <= 2 && r < 0.1) return raise(0.5); // the odd bluff
    }
    return { type: 'call', eq };
  }
  const potOdds = o.toCall / (o.pot + o.toCall);
  const betRatio = o.toCall / Math.max(1, o.pot - o.toCall);
  const need = potOdds + 0.03 + 0.1 * Math.min(1.5, betRatio); // bigger bets usually mean stronger hands
  if (short) return rel >= 1.3 ? shove() : eq >= need || rel >= 1.2 ? { type: 'call' } : { type: 'fold' };
  if (rel >= 1.7 && r < 0.75) return raise(0.7 + Math.random() * 0.3);
  if (rel >= 1.4 && r < 0.3) return raise(0.6);
  if (eq >= need) return { type: 'call' };
  if (opps === 1 && h.street < 3 && r < 0.05) return raise(0.7);
  return { type: 'fold' };
}

// how long it "thinks" before acting
function thinkMs(S, seat, mv) {
  const h = S.hand, o = E.options(S, seat);
  let ms = 700 + Math.random() * 1200;
  if (mv.type === 'raise') ms += 400 + Math.random() * 700;
  if (o.toCall > o.pot / 2 || (mv.type === 'raise' && mv.to === o.maxTo)) ms += 900;
  if (h.street === 0 && o.toCall <= h.bb) ms -= 250;
  return Math.round(Math.max(500, Math.min(4000, ms)));
}

module.exports = { KEY, NAME, SEAT_ORDER, toInt, evalN, equity, decide, thinkMs };
