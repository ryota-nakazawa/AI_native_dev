// 3つの画面で共通の部品: 拡大縮小、整形、サーバーとの接続、下部の操作バー (ライブ / 再生 / 倍速)
window.Watch = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const num = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(Math.round(n));
  const dur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const hms = ts => ts ? new Date(ts).toLocaleTimeString('ja-JP', { hour12: false }) : '--:--:--';
  const short = m => (m || '').replace(/^claude-/, '');
  const tool = t => String(t || '').replace(/^mcp__.*__/, '');
  // モデル名から色を決める
  const fam = m => /opus/.test(m) ? 'purple' : /sonnet/.test(m) ? 'orange' : /haiku/.test(m) ? 'blue' : 'green';
  const HEX = { purple: '#b9a8f7', orange: '#f5a97f', blue: '#8fb4f8', green: '#a3d9a5', red: '#f7768e', dim: '#5b6488' };
  const spin = () => ['◐', '◓', '◑', '◒'][Math.floor(Date.now() / 250) % 4];
  const total = a => a ? a.inp + a.out : 0;
  const nowOf = d => d.mode === 'live' ? Date.now() : d.now;

  function fit() {
    // 下部の操作バーは、幅が狭いと折り返して高くなる。その分だけステージを縮める
    const stage = $('stage'), h = innerHeight - ($('ctl')?.offsetHeight ?? 52);
    const s = Math.min(innerWidth / 1200, h / 1500) * 0.98;
    stage.style.top = h / 2 + 'px';
    stage.style.transform = `scale(${s}) translate(-50%, -50%)`;
  }

  // 札 (flow:xx / case:xx) が同じエージェントが複数あれば、最後に始まったものを採用する
  function pickAgents(d, kind) {
    const since = Date.parse(d.manifest?.startedAt) || 0, map = new Map();
    for (const a of d.agents) {
      if (a.tag?.kind !== kind || a.firstTs < since) continue;
      const cur = map.get(a.tag.id);
      if (!cur || a.firstTs > cur.firstTs) map.set(a.tag.id, a);
    }
    return map;
  }
  const stateOf = a => !a ? 'queued' : a.status === 'done' ? 'done' : 'run';
  const timeOf = (a, now) => !a ? '' : dur((a.status === 'done' ? a.lastTs : now) - a.firstTs);

  // ツール呼び出しのログ欄。lines 行まで表示し、新しい行を下に足す
  function logger(el, lines, labelOf) {
    return (events, animate) => {
      for (const e of events) {
        const row = document.createElement('div');
        row.className = animate ? 'l in' : 'l';
        row.innerHTML = `<span class="dim">${hms(e.ts)}</span>  <b class="${fam(e.model)}" style="display:inline-block;width:215px;overflow:hidden;vertical-align:bottom">${esc(cut(labelOf(e), 16))}</b> ${esc(cut(tool(e.tool), 12).padEnd(12))} <span>${esc(cut(e.text, 48))}</span>`;
        el.appendChild(row);
      }
      while (el.children.length > lines) el.firstChild.remove();
    };
  }

  // ---------- 接続と操作バー ----------
  // opts: { page: 'agents'|'flow'|'regression', scope: 再生する範囲, onSnapshot(d, fresh, first), onReset() }
  function start(opts) {
    let es = null, mode = 'live', speed = 3, last = null, epoch = null, lastSeq = 0, first = true;
    try { speed = Number(localStorage.getItem('watch-speed')) || 3; } catch {}

    const ctl = document.createElement('div');
    ctl.id = 'ctl';
    // STATIC = サーバーなしの公開版。記録済みのコマ (frames-*.json) を再生するだけで、ライブ表示は無い
    const STATIC = !!window.WATCH_STATIC;
    const pages = STATIC
      ? [['index', 'index.html', '概要'], ['agents', 'agents.html', 'エージェント別'], ['flow', 'flow.html', '開発フロー'], ['regression', 'regression.html', 'リグレッション']]
      : [['agents', '/', 'エージェント別'], ['flow', '/flow', '開発フロー'], ['regression', '/regression', 'リグレッション']];
    ctl.innerHTML = pages.map(([id, href, label]) => `<a href="${href}" class="${id === opts.page ? 'on' : ''}">${label}</a>`).join('') +
      `<span class="gap"></span><button id="cLive"${STATIC ? ' hidden' : ''}>● ライブ</button>` +
      `<button id="cPlay" class="play">▶ 再生</button><span class="sep"></span>` +
      [1, 3, 10, 30].map(v => `<button class="spd" data-v="${v}" aria-label="${v}倍速">${v}×</button>`).join('') +
      `<span class="sep"></span><span class="track"><s id="cProg"></s></span><span class="note" id="cNote"></span>`;
    document.body.appendChild(ctl);

    function paint(d) {
      $('cLive').classList.toggle('on', mode === 'live');
      $('cPlay').classList.toggle('on', mode === 'replay');
      ctl.querySelectorAll('.spd').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === speed));
      const replay = d && d.mode === 'replay' && mode === 'replay';
      $('cProg').style.width = replay ? (d.progress * 100) + '%' : '0';
      $('cNote').textContent = !d ? '' : replay
        ? (d.lengthMs ? dur(d.progress * d.lengthMs) + ' / ' + dur(d.lengthMs) + (d.ended ? ' 終了' : '') : '実行の記録なし')
        : (d.mode === 'replay' ? `サーバー再生 ×${d.speed}` : '');
      $('cPlay').textContent = replay && d.ended ? '↻ もう一度' : '▶ 再生';
      fit();                              // 表示が変わってバーが折り返すことがあるので合わせ直す
    }
    function handle(d) {
      if (d.epoch !== epoch) { epoch = d.epoch; lastSeq = 0; first = true; opts.onReset && opts.onReset(); }
      last = d;
      const fresh = d.events.filter(e => e.seq > lastSeq);
      if (fresh.length) lastSeq = fresh[fresh.length - 1].seq;
      opts.onSnapshot(d, fresh, first);
      first = false;
      const el = $('mode');
      if (el) { el.className = d.mode === 'replay' ? 'replay' : ''; el.textContent = d.badge || (d.mode === 'replay' ? `REPLAY ×${d.speed}` : 'LIVE'); }
      if ($('clock')) $('clock').textContent = hms(nowOf(d));
      if ($('tb')) $('tb').textContent = `${cut(d.title || 'session', 50)} · ${d.sessionId.slice(0, 8)}`;
      paint(d);
    }
    // ---- 公開版: 記録済みのコマを順に表示する ----
    let rec = null, timer = null, playN = 0;
    function showFrame(i, extra) {
      const f = rec.frames[i];
      handle({ ...f.snap, manifest: rec.manifest, mode: 'replay', speed, lengthMs: rec.lengthMs,
               progress: rec.lengthMs ? f.at / rec.lengthMs : 1, ...extra });
    }
    function playStatic() {
      clearInterval(timer);
      const epochId = 'play-' + (++playN), t0 = performance.now();
      let i = 0;
      timer = setInterval(() => {
        const at = (performance.now() - t0) * speed;
        while (i < rec.frames.length - 1 && rec.frames[i + 1].at <= at) i++;
        const ended = i >= rec.frames.length - 1;
        showFrame(i, { epoch: epochId, ended });
        if (ended) clearInterval(timer);
      }, 100);
    }
    async function openStatic() {
      mode = 'replay';
      try {
        rec = await (await fetch(`frames-${opts.scope === 'run' ? 'demo' : opts.scope}.json`)).json();
      } catch { const el = $('mode'); if (el) { el.className = 'off'; el.textContent = 'NO DATA'; } return; }
      // 最初は終わった状態を見せておき、再生ボタンで最初から流す
      showFrame(rec.frames.length - 1, { epoch: 'idle', ended: true, badge: 'RECORDED' });
    }

    function open() {
      if (STATIC) { rec ? playStatic() : openStatic(); return; }
      if (es) es.close();
      es = new EventSource(mode === 'replay' ? `/events?replay=${opts.scope}&speed=${speed}` : '/events');
      es.onmessage = m => handle(JSON.parse(m.data));
      es.onerror = () => { const el = $('mode'); if (el) { el.className = 'off'; el.textContent = 'DISCONNECTED'; } };
      paint(null);
    }
    $('cLive').onclick = () => { mode = 'live'; open(); };
    $('cPlay').onclick = () => { mode = 'replay'; open(); };       // 押すたびに最初から
    ctl.querySelectorAll('.spd').forEach(b => b.onclick = () => {
      speed = Number(b.dataset.v);
      try { localStorage.setItem('watch-speed', speed); } catch {}
      if (mode === 'replay') open(); else paint(last);              // 再生中に変えたら、その倍速で最初から
    });

    addEventListener('resize', fit); fit();
    open();
    // くるくる表示と経過時間を進める (ライブ、または再生が終わって止まっているとき以外は届く更新で足りる)
    setInterval(() => { if (last && es && es.readyState === 1 && last.mode === 'live') opts.onSnapshot(last, [], false); }, 500);
  }

  return { $, esc, cut, num, dur, hms, short, tool, fam, HEX, spin, total, nowOf, fit, pickAgents, stateOf, timeOf, logger, start };
})();
