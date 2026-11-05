'use strict';
// Multiplayer blackjack against the AI dealer, played with the same chips as the holdem table.
// House rules: 6 decks, dealer stands on all 17s, dealer peeks with an A or 10 up, blackjack pays 3:2 (half chips
// rounded up), double on any first two cards (also after a split), one split per seat, split aces get one card each,
// no insurance or surrender.
// Chips leave the account the moment they are bet and come back at settlement, so a saved ledger only has to
// refund whatever committed() reports for an unfinished round.
const crypto = require('crypto');

const SEATS = 5, DECKS = 6, MAX_HANDS = 2;
const DENOMS = [5, 25, 100, 500];
const RANKS = 'A23456789TJQK', SUITS = 'shdc';
const val = c => (c[0] === 'A' ? 11 : 'TJQK'.includes(c[0]) ? 10 : +c[0]);
function total(cards) {
  let t = 0, a = 0;
  for (const c of cards) { t += val(c); if (c[0] === 'A') a++; }
  while (t > 21 && a) { t -= 10; a--; }
  return { t, soft: a > 0 };
}
const isBJ = h => !h.fromSplit && h.cards.length === 2 && total(h.cards).t === 21;
function newShoe() {
  const s = [];
  for (let d = 0; d < DECKS; d++) for (const su of SUITS) for (const r of RANKS) s.push(r + su);
  for (let i = s.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [s[i], s[j]] = [s[j], s[i]]; }
  return s;
}

function createBlackjack({ players, present, changed, speed = 1 }) {
  const ms = x => Math.max(1, Math.round(x / speed));
  const CFG = { min: 5, max: 5000, betSecs: 15, turnSecs: 20, offlineTurnSecs: 8 };
  // pacing (ms at speed 1); the client animates inside these windows
  const TM = { start: 700, card: 340, shuffle: 1500, peek: 1400, nobj: 500, reveal: 750, step: 950, settle: 650, result: 5500, minResult: 2400, quick: 700 };

  const T = {
    seats: Array(SEATS).fill(null),   // account key per seat
    phase: 'idle',                    // idle → betting → deal → play → dealer → over → idle | betting
    round: 0,
    bets: Array(SEATS).fill(0),       // chips in the circle for the next deal (already taken from the account)
    ready: Array(SEATS).fill(false),
    hands: Array(SEATS).fill(null),   // per seat: [{ cards, bet, done, doubled, fromSplit, splitAces, result, net }]
    names: Array(SEATS).fill(''),     // who played each seat this round (kept on screen if they leave during the result)
    net: Array(SEATS).fill(0),
    dealer: [], holeShown: false, peeking: false,
    turn: null, turnAt: 0, deadline: 0,
    betEnds: 0, overAt: 0, nextAt: 0,
    shoe: [], cutAt: 0, shuffledRound: 0,
    leaving: new Set(),               // seats freed when the round ends
    lastBet: {},                      // key → last bet, for "같은 베팅"
    log: [], logId: 0,
  };
  const P = k => (k ? players()[k] : null);
  const seatOf = k => (k ? T.seats.indexOf(k) : -1);
  const inRound = () => T.phase === 'deal' || T.phase === 'play' || T.phase === 'dealer';
  const ok = (x = {}) => ({ ok: true, ...x });
  const err = (msg, x = {}) => ({ ok: false, msg, ...x });
  function say(text, kind, seat = null) {
    T.log.push({ id: ++T.logId, round: T.round, kind, text, seat });
    if (T.log.length > 10) T.log.shift();
  }

  /* ---------- one flow timer ---------- */
  let timer = null, gen = 0, armedSig = '';
  function arm(fn, delay, sig = '') {
    clearTimeout(timer); const g = ++gen; armedSig = sig;
    timer = setTimeout(() => {
      if (g !== gen) return; timer = null; armedSig = '';
      try { fn(); } catch (e) { console.error('[bj] flow error:', e); abort(); }
      changed();
    }, Math.max(0, delay));
  }
  function disarm() { clearTimeout(timer); timer = null; gen++; armedSig = ''; }

  /* ---------- shoe ---------- */
  function draw() {
    if (!T.shoe.length) { T.shoe = newShoe(); T.cutAt = 0; } // never reached with the cut card in place
    return T.shoe.pop();
  }
  function shuffleIfNeeded() {
    if (T.shoe.length > T.cutAt && T.shoe.length >= 70) return false;
    T.shoe = newShoe(); T.cutAt = Math.floor(T.shoe.length * (0.22 + Math.random() * 0.06));
    return true;
  }

  /* ---------- seats & bets ---------- */
  function free(s) {
    const k = T.seats[s], p = P(k);
    if (p && p.bjSeat === s) p.bjSeat = null;
    T.seats[s] = null; T.bets[s] = 0; T.ready[s] = false;
  }
  function refundBet(s) {
    const p = P(T.seats[s]);
    if (T.bets[s] && p) p.chips += T.bets[s];
    T.bets[s] = 0; T.ready[s] = false;
  }
  const anyBets = () => T.bets.some(b => b > 0);
  // everyone at the table who is here and not leaving has chips down and pressed ready
  function allReady() {
    let any = false;
    for (let s = 0; s < SEATS; s++) {
      const k = T.seats[s]; if (!k || T.leaving.has(s) || !present(k)) continue;
      if (!(T.bets[s] > 0 && T.ready[s])) return false;
      any = true;
    }
    return any;
  }
  // re-plan the timer after a betting change (idle / betting / over)
  function plan() {
    const now = Date.now();
    if (T.phase === 'idle' || T.phase === 'betting') {
      if (!anyBets()) { T.phase = 'idle'; T.betEnds = 0; disarm(); return; }
      if (T.phase === 'idle') { T.phase = 'betting'; T.betEnds = now + ms(CFG.betSecs * 1000); }
      if (allReady()) T.betEnds = Math.min(T.betEnds, now + ms(TM.quick));
      arm(start, T.betEnds - now);
    } else if (T.phase === 'over') {
      T.nextAt = allReady() ? Math.max(T.overAt + ms(TM.minResult), now) : T.overAt + ms(TM.result);
      arm(reset, T.nextAt - now);
    }
  }

  function sit(k, seat) {
    const p = P(k); if (!p) return err('먼저 입장해주세요.');
    if (p.bjSeat != null && T.seats[p.bjSeat] === k) {
      if (!T.leaving.has(p.bjSeat)) return err('이미 앉아 있어요.');
      T.leaving.delete(p.bjSeat); return ok({ seat: p.bjSeat }); // changed their mind before the round ended
    }
    if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS) return err('자리를 다시 골라주세요.');
    if (T.seats[seat]) return err('방금 다른 사람이 앉았어요.');
    if (T.hands[seat]) return err('그 자리는 정리 중이에요. 잠깐 뒤에 앉아주세요.');
    T.seats[seat] = k; p.bjSeat = seat; T.bets[seat] = 0; T.ready[seat] = false;
    say(`${p.name}님, 어서 오세요.`, 'join', seat);
    return ok({ seat });
  }
  function leave(k) {
    const s = seatOf(k); if (s < 0) return ok();
    refundBet(s);
    if (T.hands[s] && T.phase !== 'over') {
      // cards in play: stand them now and give the seat back once the round is over
      T.leaving.add(s);
      if (T.phase === 'play' || T.phase === 'deal') {
        T.hands[s].forEach(h => (h.done = true));
        if (T.phase === 'play' && T.turn && T.turn.seat === s) nextTurn();
      }
      return ok({ pending: true });
    }
    free(s); T.leaving.delete(s);
    plan();
    return ok();
  }
  const bettable = () => T.phase === 'idle' || T.phase === 'betting' || T.phase === 'over';
  function bet(k, amount) {
    const s = seatOf(k), p = P(k);
    if (s < 0 || !p) return err('먼저 자리에 앉아주세요.');
    if (T.leaving.has(s)) return err('곧 자리에서 일어나요.');
    if (!bettable()) return err('지금은 베팅할 수 없어요.');
    if (!DENOMS.includes(amount)) return err();
    if (T.bets[s] + amount > CFG.max) return err(`한 판 최대 베팅은 ${CFG.max.toLocaleString()}이에요.`);
    if (amount > p.chips) return err('칩이 모자라요.');
    p.chips -= amount; T.bets[s] += amount;
    plan();
    return ok({ bet: T.bets[s] });
  }
  function rebet(k) {
    const s = seatOf(k), p = P(k), amt = T.lastBet[k] || 0;
    if (s < 0 || !p) return err('먼저 자리에 앉아주세요.');
    if (T.leaving.has(s)) return err('곧 자리에서 일어나요.');
    if (!bettable()) return err('지금은 베팅할 수 없어요.');
    if (!amt) return err('지난 베팅이 없어요.');
    const add = amt - T.bets[s];
    if (add <= 0) { T.ready[s] = true; plan(); return ok({ bet: T.bets[s] }); }
    if (add > p.chips) return err('칩이 모자라요.');
    p.chips -= add; T.bets[s] = amt; T.ready[s] = true;
    plan();
    return ok({ bet: T.bets[s] });
  }
  function clear(k) {
    const s = seatOf(k); if (s < 0) return err('먼저 자리에 앉아주세요.');
    if (!bettable()) return err('지금은 베팅을 뺄 수 없어요.');
    refundBet(s); plan();
    return ok();
  }
  function ready(k, on = true) {
    const s = seatOf(k); if (s < 0) return err('먼저 자리에 앉아주세요.');
    if (!bettable()) return err('지금은 할 수 없어요.');
    if (on && !(T.bets[s] > 0)) return err('먼저 칩을 걸어주세요.');
    T.ready[s] = !!on; plan();
    return ok();
  }

  /* ---------- the round ---------- */
  function start() {
    const playing = [];
    for (let s = 0; s < SEATS; s++) if (T.seats[s] && T.bets[s] > 0) playing.push(s);
    if (!playing.length) { T.phase = 'idle'; T.betEnds = 0; return; }
    const shuffled = shuffleIfNeeded();
    T.round++; T.phase = 'deal'; T.betEnds = 0; T.holeShown = false; T.peeking = false; T.turn = null;
    if (shuffled) { T.shuffledRound = T.round; say('새 슈로 셔플할게요.', 'shuffle'); }
    T.hands = Array(SEATS).fill(null); T.net = Array(SEATS).fill(0); T.dealer = [];
    playing.forEach(s => {
      T.names[s] = P(T.seats[s]).name;
      T.hands[s] = [{ cards: [], bet: T.bets[s], done: false, doubled: false, fromSplit: false, splitAces: false, result: null, net: null }];
      T.lastBet[T.seats[s]] = T.bets[s]; T.bets[s] = 0; T.ready[s] = false;
    });
    for (let r = 0; r < 2; r++) { playing.forEach(s => T.hands[s][0].cards.push(draw())); T.dealer.push(draw()); }
    say('베팅 마감! 카드 나갑니다.', 'deal');
    arm(afterDeal, ms(TM.start + (playing.length * 2 + 2) * TM.card + (shuffled ? TM.shuffle : 0)));
  }
  function afterDeal() {
    const up = T.dealer[0];
    if (val(up) >= 10) {
      T.peeking = true;
      say(up[0] === 'A' ? '에이스네요. 블랙잭인지 확인할게요.' : '블랙잭인지 확인할게요.', 'peek');
      return arm(resolvePeek, ms(TM.peek));
    }
    beginPlay();
  }
  function resolvePeek() {
    T.peeking = false;
    if (total(T.dealer).t === 21) {
      T.phase = 'dealer'; T.holeShown = true;
      say('딜러 블랙잭이에요!', 'dealerBJ');
      return arm(settle, ms(TM.reveal + TM.settle + 400));
    }
    say('블랙잭 아니에요. 계속할게요.', 'nobj');
    beginPlay();
  }
  function beginPlay() {
    T.phase = 'play';
    for (let s = 0; s < SEATS; s++) {
      const hs = T.hands[s]; if (!hs) continue;
      hs.forEach(h => { if (isBJ(h) || T.leaving.has(s)) h.done = true; });
    }
    nextTurn();
  }
  // the first unfinished hand in seat order gets the turn; a fresh action restarts its clock
  function nextTurn(restart = false) {
    for (let s = 0; s < SEATS; s++) {
      const hs = T.hands[s]; if (!hs) continue;
      for (let i = 0; i < hs.length; i++) {
        if (hs[i].done) continue;
        const same = T.turn && T.turn.seat === s && T.turn.hand === i;
        if (!same || restart) { T.turnAt = Date.now(); }
        if (!same) {
          T.turn = { seat: s, hand: i };
          const p = P(T.seats[s]);
          say(hs.length > 1 ? `${p ? p.name : ''}님 ${['첫', '두'][i] || i + 1} 번째 핸드 차례예요.` : `${p ? p.name : ''}님 차례예요.`, 'turn', s);
        }
        armTurn();
        return;
      }
    }
    T.turn = null;
    dealerTurn();
  }
  function turnSecs(s) {
    const k = T.seats[s];
    return T.leaving.has(s) ? 0 : (k && present(k) ? CFG.turnSecs : CFG.offlineTurnSecs);
  }
  function armTurn() {
    if (T.phase !== 'play' || !T.turn) return;
    const { seat, hand } = T.turn, round = T.round, at = T.turnAt;
    T.deadline = at + ms(turnSecs(seat) * 1000);
    const sig = `${round}:${seat}:${hand}:${at}:${T.deadline}`;
    if (sig === armedSig) return;
    arm(() => {
      if (T.phase !== 'play' || T.round !== round || !T.turn || T.turn.seat !== seat || T.turn.hand !== hand) return;
      const h = T.hands[seat][hand]; h.done = true; h.auto = true;
      nextTurn();
    }, T.deadline - Date.now(), sig);
  }
  const canDouble = (h, p) => h.cards.length === 2 && !h.splitAces && !h.doubled && !!p && p.chips >= h.bet;
  const canSplit = (s, h, p) => h.cards.length === 2 && T.hands[s].length < MAX_HANDS && val(h.cards[0]) === val(h.cards[1]) && !!p && p.chips >= h.bet;
  function act(k, type, round) {
    const s = seatOf(k), p = P(k);
    if (T.phase !== 'play' || !T.turn || s < 0 || T.turn.seat !== s || (round != null && round !== T.round)) return err('지금은 내 차례가 아니에요.');
    const h = T.hands[s][T.turn.hand];
    const bustCheck = () => {
      const t = total(h.cards).t;
      if (t > 21) { h.done = true; say(`${p.name}님 ${t}, 버스트예요.`, 'bust', s); }
      else if (t === 21) h.done = true;
    };
    if (type === 'hit') { h.cards.push(draw()); bustCheck(); }
    else if (type === 'stand') h.done = true;
    else if (type === 'double') {
      if (!canDouble(h, p)) return err('지금은 더블할 수 없어요.');
      p.chips -= h.bet; h.bet *= 2; h.doubled = true; h.cards.push(draw()); h.done = true; bustCheck();
    } else if (type === 'split') {
      if (!canSplit(s, h, p)) return err('지금은 스플릿할 수 없어요.');
      p.chips -= h.bet;
      const aces = h.cards[0][0] === 'A';
      const nh = { cards: [h.cards.pop()], bet: h.bet, done: false, doubled: false, fromSplit: true, splitAces: aces, result: null, net: null };
      h.fromSplit = true; h.splitAces = aces;
      T.hands[s].splice(T.turn.hand + 1, 0, nh);
      h.cards.push(draw()); nh.cards.push(draw());
      if (aces) { h.done = nh.done = true; say('에이스 스플릿은 한 장씩만 받아요.', 'splitAces', s); }
      else [h, nh].forEach(x => { if (total(x.cards).t === 21) x.done = true; });
    } else return err();
    nextTurn(true);
    return ok();
  }
  function dealerTurn() {
    T.phase = 'dealer'; T.turn = null; T.deadline = 0;
    arm(() => {
      T.holeShown = true;
      const live = T.hands.some(hs => hs && hs.some(h => total(h.cards).t <= 21 && !isBJ(h)));
      if (!live) return arm(settle, ms(TM.settle + 300));
      arm(dealerStep, ms(TM.step));
    }, ms(TM.reveal));
  }
  function dealerStep() {
    const { t } = total(T.dealer);
    if (t < 17) { T.dealer.push(draw()); return arm(dealerStep, ms(TM.step)); }
    say(t > 21 ? `딜러 ${t}, 버스트!` : `딜러 ${t}, 스탠드할게요.`, t > 21 ? 'dealerBust' : 'dealerStand');
    arm(settle, ms(TM.settle));
  }
  function settle() {
    const d = total(T.dealer).t, dBJ = T.dealer.length === 2 && d === 21;
    const credit = [];
    for (let s = 0; s < SEATS; s++) {
      const hs = T.hands[s]; if (!hs) continue;
      let back = 0, staked = 0;
      for (const h of hs) {
        const t = total(h.cards).t, bj = isBJ(h); let kind, pay = 0;
        if (t > 21) kind = 'bust';
        else if (bj && !dBJ) { kind = 'bj'; pay = Math.ceil(h.bet * 1.5); }
        else if (dBJ) kind = bj ? 'push' : 'lose';
        else if (d > 21 || t > d) { kind = 'win'; pay = h.bet; }
        else if (t === d) kind = 'push';
        else kind = 'lose';
        const ret = kind === 'win' || kind === 'bj' ? h.bet + pay : kind === 'push' ? h.bet : 0;
        h.result = kind; h.net = ret - h.bet; h.done = true;
        back += ret; staked += h.bet;
      }
      T.net[s] = back - staked;
      credit.push([s, back]);
    }
    for (const [s, back] of credit) {
      const p = P(T.seats[s]); if (!p) continue;
      p.chips += back;
      p.bjRounds = (p.bjRounds || 0) + 1;
      if (T.net[s] > 0) p.bjWins = (p.bjWins || 0) + 1;
      if (p.chips === 0) p.busts = (p.busts || 0) + 1;
    }
    T.phase = 'over'; T.holeShown = true; T.peeking = false; T.turn = null; T.deadline = 0;
    T.overAt = Date.now();
    const winners = T.net.filter((n, s) => T.hands[s] && n > 0).length, players = T.hands.filter(Boolean).length;
    if (dBJ) say('이번 판은 딜러 블랙잭으로 끝났어요.', 'summary');
    else if (d > 21) say('딜러가 버스트했어요. 살아 있던 핸드는 모두 이겼어요!', 'summary');
    else if (winners === players) say('이번 판은 여러분이 다 가져가셨네요.', 'summary');
    else if (winners === 0) say('이번 판은 딜러가 가져갈게요.', 'summary');
    else say(`딜러 ${d}. 정산했어요.`, 'summary');
    plan();
  }
  function reset() {
    T.hands = Array(SEATS).fill(null); T.net = Array(SEATS).fill(0); T.dealer = [];
    T.holeShown = false; T.peeking = false; T.turn = null; T.deadline = 0; T.overAt = 0; T.nextAt = 0;
    T.leaving.forEach(s => { refundBet(s); free(s); }); T.leaving.clear();
    T.phase = 'idle'; T.betEnds = 0;
    plan();
  }
  // something went wrong mid-round: hand every committed chip back and start clean
  function abort() {
    for (let s = 0; s < SEATS; s++) {
      const p = P(T.seats[s]);
      let amt = T.bets[s];
      if (T.hands[s] && inRound()) amt += T.hands[s].reduce((a, h) => a + h.bet, 0);
      if (p && amt) p.chips += amt;
      T.bets[s] = 0; T.ready[s] = false;
    }
    T.hands = Array(SEATS).fill(null); T.dealer = []; T.turn = null; T.phase = 'idle'; T.betEnds = 0; T.holeShown = false; T.peeking = false;
    T.leaving.forEach(s => free(s)); T.leaving.clear();
    say('잠깐 문제가 생겨서 이번 판 베팅은 모두 돌려드렸어요.', 'abort');
    disarm();
  }

  /* ---------- outside hooks ---------- */
  function committedFor(k) {
    const s = seatOf(k); if (s < 0) return 0;
    let amt = T.bets[s];
    if (T.hands[s] && inRound()) amt += T.hands[s].reduce((a, h) => a + h.bet, 0);
    return amt;
  }
  function committed() {
    const out = {};
    for (let s = 0; s < SEATS; s++) { const k = T.seats[s]; if (k) { const a = committedFor(k); if (a) out[k] = (out[k] || 0) + a; } }
    return out;
  }
  const busy = () => inRound() || anyBets();
  // presence changed: an absent player's turn runs on the short clock, and the ready check may now pass
  function tick() {
    if (T.phase === 'play') armTurn();
    else if (T.phase === 'betting' || T.phase === 'over') plan();
  }
  function sweep(gone) {
    let any = false;
    T.seats.forEach(k => { if (k && gone(k) && !T.leaving.has(seatOf(k))) { leave(k); any = true; } });
    return any;
  }

  function view(key) {
    const now = Date.now(), me = P(key), mySeat = seatOf(key);
    const handView = h => {
      const { t, soft } = total(h.cards);
      return { cards: h.cards, bet: h.bet, doubled: h.doubled, split: h.fromSplit, splitAces: h.splitAces, done: h.done, auto: !!h.auto,
        total: t, soft: soft && t < 21, bj: isBJ(h), bust: t > 21, result: h.result, net: h.net };
    };
    const dealerCards = T.holeShown ? T.dealer : T.dealer.map((c, i) => (i === 1 ? null : c));
    const shown = dealerCards.filter(Boolean), dt = total(shown);
    const myTurn = T.phase === 'play' && T.turn && mySeat >= 0 && T.turn.seat === mySeat;
    const myHand = myTurn ? T.hands[mySeat][T.turn.hand] : null;
    return {
      phase: T.phase, round: T.round, peeking: T.peeking,
      cfg: { min: CFG.min, max: CFG.max, turnSecs: CFG.turnSecs, betSecs: CFG.betSecs, denoms: DENOMS },
      seats: T.seats.map((k, s) => {
        const p = P(k), hs = T.hands[s];
        if (!p && !hs) return null;
        return { name: p ? p.name : T.names[s], chips: p ? p.chips : 0, me: !!k && k === key, online: !!k && present(k), leaving: T.leaving.has(s), vacated: !k,
          bet: T.bets[s], ready: T.ready[s], net: T.phase === 'over' && hs ? T.net[s] : null, hands: hs ? hs.map(handView) : null };
      }),
      dealer: { cards: dealerCards, total: shown.length ? dt.t : 0, soft: dt.soft && dt.t < 21, bj: T.holeShown && T.dealer.length === 2 && total(T.dealer).t === 21, bust: shown.length > 2 && dt.t > 21, holeShown: T.holeShown },
      turn: T.phase === 'play' && T.turn ? { seat: T.turn.seat, hand: T.turn.hand, left: Math.max(0, T.deadline - now), total: Math.max(1, T.deadline - T.turnAt) } : null,
      betLeft: T.phase === 'betting' ? Math.max(0, T.betEnds - now) : 0,
      nextIn: T.phase === 'over' ? Math.max(0, T.nextAt - now) : 0,
      shoe: { left: T.shoe.length ? Math.min(1, T.shoe.length / (DECKS * 52)) : 1, shuffled: T.shuffledRound === T.round && T.round > 0 },
      log: T.log.slice(-5),
      me: me ? { name: me.name, chips: me.chips, seat: mySeat >= 0 ? mySeat : null, lastBet: T.lastBet[key] || 0, committed: committedFor(key), leaving: mySeat >= 0 && T.leaving.has(mySeat) } : null,
      opts: myHand ? { hand: T.turn.hand, double: canDouble(myHand, me), split: canSplit(mySeat, myHand, me) } : null,
    };
  }

  return { SEATS, CFG, sit, leave, bet, rebet, clear, ready, act, view, committed, committedFor, busy, tick, sweep,
    seated: () => T.seats.filter(Boolean).length, phase: () => T.phase,
    // tests only: the next cards dealt come from `cards`, in order
    _test: { T, rig(cards) { T.shoe = newShoe().concat(cards.slice().reverse()); T.cutAt = 0; } } };
}

module.exports = { createBlackjack, total, isBJ, val, SEATS, DENOMS };
