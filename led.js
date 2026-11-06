/* GYBM notice board: an LED ticker that runs under the header while you play, and a sheet with the whole notice.
   Shared by the holdem and blackjack pages. The room owner edits the text; the server keeps it. */
(() => {
  'use strict';
  const CSS = `
.led{--on:#ffb23e;--hot:#ff5440;--grn:#66f59c;--off:#1d1109;--gap:#080504;--pitch:2px;
  position:relative;display:flex;align-items:stretch;height:32px;border-radius:9px;overflow:hidden;cursor:pointer;background:var(--gap);
  box-shadow:0 0 0 1px rgba(255,170,80,.2),0 6px 18px rgba(0,0,0,.45),0 0 26px rgba(255,140,40,.13);-webkit-user-select:none;user-select:none}
.led:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.led-tag{flex:none;display:flex;align-items:center;gap:6px;padding:0 10px 0 10px;font:800 13px/1 var(--f-body);letter-spacing:.04em;color:#ffd9cf;
  background:linear-gradient(180deg,#b3261a,#7d140c);text-shadow:0 0 6px rgba(255,120,90,.9);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset -1px 0 0 rgba(0,0,0,.5)}
.led-tag i{width:6px;height:6px;border-radius:50%;background:#ffe2d6;box-shadow:0 0 6px #fff,0 0 10px var(--hot)}
.led.new .led-tag i{animation:ledblink .9s steps(1) infinite}
.led.new .led-tag::after{content:"NEW";font:700 9.5px/1 var(--f-num,sans-serif);letter-spacing:.12em;color:#fff;padding:2px 3px 1px;border-radius:3px;background:rgba(0,0,0,.35)}
.led-win{position:relative;flex:1;min-width:0;overflow:hidden;background:var(--off)}
.led-win::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(circle at 50% 50%,rgba(8,5,4,0) 0 .72px,var(--gap) 1px) 0 0/var(--pitch) var(--pitch)}
.led-win::before{content:"";position:absolute;inset:0;z-index:2;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,0) 42%,rgba(0,0,0,.22))}
.led-run{position:absolute;left:0;top:0;bottom:0;display:flex;align-items:center;white-space:nowrap;will-change:transform;
  font:800 17px/1 var(--f-body);color:var(--on);text-shadow:0 0 3px currentColor,0 0 9px rgba(255,150,40,.55)}
.led-run .cp{display:flex;align-items:center;flex:none}
.led-run .h{color:var(--hot);animation:ledflash 1.8s steps(1) infinite}
.led-run .g{color:var(--grn)}
.led-run .r{color:var(--hot)}
.led-run .s{color:#ffc75c}
.led-run .s::before{content:"›";margin:0 7px 0 9px;color:var(--on)}
.led-run .t{color:var(--gap);background:var(--hot);text-shadow:none;padding:3px 5px 2px;margin-right:7px;border-radius:2px;font-size:13px}
.led-run .t.soon{background:var(--on)}
.led-run .sep{font-size:9px;color:rgba(255,178,62,.6);margin:0 18px;text-shadow:none}
.led-run.fade{left:10px;right:10px;transition:opacity .35s}
.led-run.fade.out{opacity:0}
@keyframes ledblink{50%{opacity:.15}}
@keyframes ledflash{0%{opacity:1}72%{opacity:.5}}
/* screens with big pixels (most desktops): coarser dots and bigger letters, so it still reads as an LED board */
@media (max-resolution:1.5dppx){
  .led{height:38px}.led-run{font-size:20px}
  .led-win::after{background:radial-gradient(circle at 50% 50%,rgba(8,5,4,0) 0 1.05px,var(--gap) 1.45px) 0 0/3px 3px}
  .led-run .t,.led-run .t.soon{background:none;color:var(--hot);text-shadow:0 0 3px currentColor;padding:0;font-size:inherit;margin-right:10px}
  .led-run .t.soon{color:var(--on)}
  .led-run .t::before{content:"["}.led-run .t::after{content:"]"}
}
@media (orientation:landscape) and (max-height:520px){
  .led{height:26px}.led-run{font-size:14px}.led-tag{font-size:11.5px;padding:0 8px}.led-run .t{font-size:11px}
}
.nb .nb-banner{position:relative;overflow:hidden;border-radius:10px;padding:14px 12px;text-align:center;background:#1d1109;
  font:900 26px/1.3 var(--f-body);color:#ff5a44;text-shadow:0 0 4px currentColor,0 0 14px rgba(255,84,64,.6);box-shadow:0 0 0 1px rgba(255,120,80,.25),0 0 24px rgba(255,84,64,.15)}
.nb .nb-banner::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 50% 50%,rgba(8,5,4,0) 0 .95px,#080504 1.3px) 0 0/2.5px 2.5px}
.nb .nb-banner span{display:block}
.nb-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.nb-list li{padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);font-size:14.5px;line-height:1.45;color:var(--ink);word-break:keep-all;overflow-wrap:anywhere}
.nb-list li p{margin:4px 0 0;font-size:13px;color:var(--muted)}
.nb-list li p::before{content:"→ ";color:var(--dim)}
.nb-list .g{color:#7be3a3;font-weight:700}
.nb-list .r{color:#ff8a72;font-weight:700}
.nb-list li.today{background:rgba(255,84,64,.09);box-shadow:inset 0 0 0 1.5px rgba(255,84,64,.55)}
.nb-list li.past{opacity:.45}
.nb-when{display:inline-block;font-style:normal;font-size:11px;font-weight:800;line-height:1;padding:3px 6px 2px;border-radius:5px;margin-right:6px;vertical-align:1px;background:#ff5440;color:#1a0503}
.nb-when.soon{background:#ffb23e;color:#241404}
.nb-when.past{background:rgba(255,255,255,.16);color:var(--ink)}
.nb-meta{font-size:12px;color:var(--dim);text-align:right;margin-top:-4px}
.nb-ed{display:flex;flex-direction:column;gap:10px}
.nb-ed textarea{width:100%;min-height:230px;resize:vertical;font:14px/1.5 var(--f-body);color:var(--ink);background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:12px;padding:10px 12px;-webkit-user-select:text;user-select:text}
.nb-ed textarea:focus{outline:none;border-color:var(--gold)}
.nb-help{font-size:12px;line-height:1.55;color:var(--dim)}
.nb-help b{color:var(--muted);font-weight:600}
.nb-msg{font-size:12.5px;min-height:1em}
.nb-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
`;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const SEEN = 'gybm.noticeSeen';
  const seenGet = () => { try { return localStorage.getItem(SEEN); } catch { return null; } };
  const seenSet = v => { try { localStorage.setItem(SEEN, String(v)); } catch {} };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- reading the owner's text ----------
     "quoted" or plain lines before the first bullet → headline (red) · "- " starts an item · "-> " adds a detail to it ·
     a date like 11.7(토) gets 오늘 / 내일 / D-n, and items whose date has passed drop off the ticker */
  const DATE_WD = /(\d{1,2})\s*[./]\s*(\d{1,2})\s*\(\s*[월화수목금토일]\s*\)/, DATE_LEAD = /^(\d{1,2})\s*[./]\s*(\d{1,2})(?!\d)/;
  const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  function daysTo(m, d) {
    const t = today0(), y = t.getFullYear();
    let c = new Date(y, m - 1, d);
    if (c - t > 183 * 864e5) c = new Date(y - 1, m - 1, d); else if (t - c > 183 * 864e5) c = new Date(y + 1, m - 1, d);
    return Math.round((c - t) / 864e5);
  }
  function parse(text) {
    const out = { heads: [], items: [] };
    for (let raw of String(text || '').split('\n')) {
      const line = raw.trim(); if (!line) continue;
      if (/^<[^<>]{1,30}>$/.test(line)) continue; // a "<공지사항>" title line: the board says that already
      const sub = line.match(/^(?:->|→|=>|ㄴ|└)\s*(.*)$/);
      if (sub) { const it = out.items[out.items.length - 1]; if (it) { if (sub[1]) it.subs.push(sub[1]); } else if (sub[1]) out.heads.push(sub[1]); continue; }
      const bul = line.match(/^[-•·*▪]\s*(.*)$/);
      if (!bul && !out.items.length) { out.heads.push(line.replace(/^["“”'‘’「『]+|["“”'‘’」』]+$/g, '').trim() || line); continue; }
      const t = bul ? bul[1] : line; if (!t) continue;
      const m = t.match(DATE_WD) || t.match(DATE_LEAD), it = { text: t, subs: [], days: null };
      if (m) { const mo = +m[1], da = +m[2]; if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) it.days = daysTo(mo, da); }
      out.items.push(it);
    }
    return out;
  }
  const deco = s => esc(s).replace(new RegExp(DATE_WD.source, 'g'), '<span class="g">$&</span>').replace(DATE_LEAD, '<span class="g">$&</span>').replace(/필참|반드시|필수|마감|긴급|오늘까지/g, '<span class="r">$&</span>');
  const when = n => (n == null || n > 6 ? null : n < 0 ? ['지남', 'past'] : n === 0 ? ['오늘', ''] : n === 1 ? ['내일', 'soon'] : [`D-${n}`, 'soon']);

  /* ---------- the ticker ---------- */
  let led, win, run, anim = null, rmT = null, N = null, ctx = {}, sig = '', justSaved = false, autoT = null;
  function mount(slot) {
    if (led || !slot) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    slot.innerHTML = '<div class="led" id="led" role="button" tabindex="0" hidden><b class="led-tag"><i></i>공지</b><div class="led-win"><div class="led-run" id="ledRun"></div></div></div>';
    led = $('led'); win = led.querySelector('.led-win'); run = $('ledRun');
    led.addEventListener('click', () => open());
    led.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { sig = ''; paint(); });
    addEventListener('resize', () => { clearTimeout(mount.rT); mount.rT = setTimeout(() => { sig = ''; paint(); }, 200); });
    setInterval(paint, 60000); // dates move to 내일 / 오늘 / 지남 without a reload
  }
  function segments(p) {
    const segs = p.heads.map(h => `<span class="h">${esc(h)}</span>`);
    p.items.forEach(it => {
      if (it.days != null && it.days < 0) return;
      const w = when(it.days);
      segs.push((w ? `<span class="t ${w[1]}">${w[0]}</span>` : '') + `<span>${deco(it.text)}</span>` + it.subs.map(s => `<span class="s">${deco(s)}</span>`).join(''));
    });
    return segs;
  }
  function paint() {
    if (!led) return;
    const text = N && N.text ? N.text : '';
    const s = `${N ? N.at : 0}|${text.length}|${today0().getTime()}`;
    led.classList.toggle('new', !!text && String(N.at) !== seenGet());
    if (s === sig) return; sig = s;
    if (anim) { anim.cancel(); anim = null; } clearInterval(rmT);
    led.hidden = !text; if (!text) { run.innerHTML = ''; return; }
    const segs = segments(parse(text));
    if (!segs.length) { led.hidden = true; return; }
    led.setAttribute('aria-label', '공지사항 · 누르면 전체 보기');
    if (reduce) { // no scrolling: one line at a time
      let i = 0; run.className = 'led-run fade'; run.innerHTML = segs[0];
      if (segs.length > 1) rmT = setInterval(() => { run.classList.add('out'); setTimeout(() => { i = (i + 1) % segs.length; run.innerHTML = segs[i]; run.classList.remove('out'); }, 350); }, 4200);
      return;
    }
    run.className = 'led-run';
    const one = `<span class="cp">${segs.join('<i class="sep">◆</i>')}<i class="sep">◆</i></span>`;
    run.innerHTML = one;
    const w = run.firstElementChild.getBoundingClientRect().width, ww = win.clientWidth || 360;
    if (!w) { sig = ''; return; } // not on screen yet; try again on the next update
    run.innerHTML = one.repeat(Math.ceil(ww / w) + 1);
    const speed = Math.max(46, Math.min(80, ww * .13)); // px per second
    anim = run.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-w}px)` }], { duration: w / speed * 1000, iterations: Infinity });
  }

  /* ---------- the whole notice ---------- */
  let sheet;
  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement('div');
    sheet.className = 'overlay nb'; sheet.id = 'noticeSheet'; sheet.hidden = true;
    sheet.innerHTML = '<div class="sheet" role="dialog" aria-label="공지사항"><h2>공지사항</h2><div id="nbView"></div><div class="nb-ed" id="nbEd" hidden>'
      + '<textarea id="nbText" maxlength="1500" placeholder="공지 내용을 쓰세요"></textarea>'
      + '<div class="nb-help"><b>"따옴표"</b> 줄 → 빨간 강조 · <b>- </b>로 시작 → 항목 · <b>-&gt; </b>로 시작 → 세부 내용 · 날짜는 <b>11.7(토)</b>처럼 쓰면 오늘·내일이 자동으로 붙고 지난 일정은 전광판에서 빠져요. 비우고 저장하면 공지를 내려요.</div>'
      + '<div class="nb-msg" id="nbMsg"></div><div class="nb-grid"><button type="button" class="sbtn" id="nbCancel">취소</button><button type="button" class="sbtn pri" id="nbSave">저장 · 모두에게 표시</button></div></div>'
      + '<button type="button" class="sbtn" id="nbEditBtn" hidden>공지 수정</button><button type="button" class="sbtn" id="nbClose">닫기</button></div>';
    document.body.appendChild(sheet);
    sheet.addEventListener('click', e => { if (e.target === sheet && $('nbEd').hidden) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden && $('nbEd').hidden) close(); });
    $('nbClose').addEventListener('click', close);
    $('nbEditBtn').addEventListener('click', () => edit());
    $('nbCancel').addEventListener('click', () => { $('nbEd').hidden = true; $('nbView').hidden = false; $('nbEditBtn').hidden = !ctx.canEdit; });
    $('nbSave').addEventListener('click', async () => {
      if (!ctx.save) return;
      const b = $('nbSave'); b.disabled = true; $('nbMsg').textContent = '';
      let r; try { r = await ctx.save($('nbText').value); } catch { r = null; }
      b.disabled = false;
      $('nbMsg').style.color = r && r.ok ? 'var(--good,#5fd38d)' : 'var(--danger,#e3624f)';
      $('nbMsg').textContent = (r && r.msg) || (r && r.ok ? '저장했어요.' : '저장하지 못했어요.');
      if (r && r.ok) { justSaved = true; $('nbEd').hidden = true; $('nbView').hidden = false; $('nbEditBtn').hidden = !ctx.canEdit; if (!$('nbText').value.trim()) close(); }
    });
    return sheet;
  }
  function fmtAt(t) {
    const d = new Date(t); if (!t || isNaN(d)) return '';
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}`;
  }
  function paintSheet() {
    if (!sheet) return;
    const text = N && N.text ? N.text : '', p = parse(text);
    $('nbView').innerHTML = !text ? '<div class="nb-help">지금은 공지가 없어요.</div>' : (p.heads.length ? `<div class="nb-banner">${p.heads.map(h => `<span>${esc(h)}</span>`).join('')}</div>` : '')
      + (p.items.length ? `<ul class="nb-list" style="margin-top:${p.heads.length ? 12 : 0}px">${p.items.map(it => {
        const w = when(it.days);
        return `<li class="${it.days === 0 ? 'today' : it.days != null && it.days < 0 ? 'past' : ''}">${w ? `<em class="nb-when ${w[1]}">${w[0]}</em>` : ''}${deco(it.text)}${it.subs.map(s => `<p>${deco(s)}</p>`).join('')}</li>`;
      }).join('')}</ul>` : '')
      + (N && N.at ? `<div class="nb-meta" style="margin-top:10px">${N.by ? `방장 ${esc(N.by)} · ` : ''}${fmtAt(N.at)} 올림</div>` : '');
    $('nbEditBtn').hidden = !ctx.canEdit || !$('nbEd').hidden;
  }
  function open() {
    if (!(N && N.text) && !ctx.canEdit) return;
    ensureSheet(); $('nbEd').hidden = true; $('nbView').hidden = false; $('nbMsg').textContent = '';
    paintSheet(); sheet.hidden = false;
    if (N && N.text) { seenSet(N.at); led && led.classList.remove('new'); }
  }
  function edit() {
    if (!ctx.canEdit) return;
    ensureSheet(); paintSheet();
    $('nbText').value = N && N.text ? N.text : ''; $('nbMsg').textContent = '';
    $('nbView').hidden = true; $('nbEd').hidden = false; $('nbEditBtn').hidden = true; sheet.hidden = false;
    const ta = $('nbText'); ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight + 4, Math.max(240, innerHeight * .5)) + 'px';
    setTimeout(() => { ta.focus({ preventScroll: true }); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 50);
  }
  function close() { if (sheet) sheet.hidden = true; }

  /* ---------- called on every state the page gets ----------
     ctx: { canEdit, idle (not in the middle of your own game), save(text) → Promise<{ok,msg}> } */
  function update(notice, c) {
    ctx = c || {};
    const prevAt = N && N.at;
    N = notice && typeof notice.text === 'string' ? notice : null;
    if (justSaved && N && N.at !== prevAt) { justSaved = false; seenSet(N.at); }
    paint();
    if (sheet && !sheet.hidden) { if (!(N && N.text) && !ctx.canEdit) close(); else if ($('nbEd').hidden) { paintSheet(); if (N && N.text) seenSet(N.at); } }
    // a new notice opens by itself once, when you are not in the middle of a hand and nothing else is open
    if (N && N.text && String(N.at) !== seenGet() && ctx.idle && !autoT) {
      autoT = setTimeout(() => {
        autoT = null;
        if (!(N && N.text) || String(N.at) === seenGet() || !ctx.idle || document.querySelector('.overlay:not([hidden])') || document.visibilityState !== 'visible') return;
        open();
      }, 1200);
    }
  }
  window.GYBMNotice = { mount, update, open, edit, parse };
})();
