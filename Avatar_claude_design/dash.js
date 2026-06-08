/* ============================================================
   dash.js — real-data Bento dashboard (no simulated telemetry)
   ============================================================ */
(function () {
  const D = window.DASH;
  const NS = 'http://www.w3.org/2000/svg';

  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const add = (p, ...k) => { k.forEach(x => x && p.appendChild(x)); return p; };

  function panel(opts, ...body) {
    const p = el('div', 'panel' + (opts.cls ? ' ' + opts.cls : ''));
    const ph = el('div', 'ph');
    if (opts.led !== undefined) ph.appendChild(led(opts.led, opts.blink));
    if (opts.icon) ph.appendChild(el('div', 'ico', opts.icon));
    ph.appendChild(el('div', 'tt', opts.title + (opts.sub ? ' <small>· ' + opts.sub + '</small>' : '')));
    if (opts.badge) ph.appendChild(el('div', 'badge ' + (opts.badgeCls || ''), opts.badge));
    if (opts.right) { const r = el('div', 'r'); opts.right.forEach(x => r.appendChild(x)); ph.appendChild(r); }
    p.appendChild(ph);
    if (opts.toolbar) p.appendChild(opts.toolbar);
    const pb = el('div', 'pb' + (opts.flush ? ' flush' : ''));
    body.forEach(b => b && pb.appendChild(b));
    if (!opts.noBody) p.appendChild(pb);
    if (opts.foot) p.appendChild(opts.foot);
    return p;
  }
  function led(state, blink, delay) {
    const l = el('span', 'led ' + (state || 'off') + (blink ? ' blink' : ''));
    if (delay) l.style.animationDelay = delay + 'ms';
    return l;
  }
  function statusList(items) {
    const w = el('div', 'statlist');
    items.forEach((s, i) => {
      const r = el('div', 'statrow');
      r.appendChild(led(s.led, s.blink, i * 200));
      r.appendChild(el('div', 'nm', s.nm + (s.sub ? '<small>' + s.sub + '</small>' : '')));
      r.appendChild(el('div', 'vl ' + (s.cls || ''), s.vl));
      w.appendChild(r);
    });
    return w;
  }

  /* -------- log -------- */
  let logFeed, logCountEl, logCount = 1, logIdx = 0, paused = false;
  function fmtTs() { const d = new Date(), p = n => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function logLineEl(lv, ts, msg) {
    const l = el('div', 'logline ' + lv);
    l.appendChild(el('span', 'ts', ts)); l.appendChild(el('span', 'lv', lv.toUpperCase())); l.appendChild(el('span', 'msg', msg));
    return l;
  }
  function buildLog() {
    const tools = el('div', 'logtools');
    const search = el('div', 'search', '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 8l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>');
    const si = el('input'); si.placeholder = 'filtrar mensagens…'; si.spellcheck = false;
    si.addEventListener('input', () => { const q = si.value.toLowerCase(); logFeed.querySelectorAll('.logline').forEach(l => { l.style.display = (!q || l.textContent.toLowerCase().includes(q)) ? '' : 'none'; }); });
    search.appendChild(si); tools.appendChild(search);
    [['info', 'INFO'], ['warn', 'WARN'], ['err', 'ERR'], ['debug', 'DEBUG']].forEach(([lv, t]) => {
      const c = el('div', 'lchip on', t); c.dataset.lv = lv;
      c.addEventListener('click', () => { c.classList.toggle('off'); c.classList.toggle('on'); logFeed.classList.toggle('h-' + lv, c.classList.contains('off')); });
      tools.appendChild(c);
    });
    const pause = el('button', 'btn sm', '❚❚ pausar');
    pause.addEventListener('click', () => { paused = !paused; pause.innerHTML = paused ? '▶ retomar' : '❚❚ pausar'; });
    tools.appendChild(pause);
    logFeed = el('div', 'logfeed');
    logFeed.appendChild(logLineEl('debug', '[boot]', 'Log verboso — console de diagnóstico inicializado…'));
    const foot = el('div', 'logfoot');
    foot.innerHTML = 'linhas <b id="lc">1</b> · taxa <b>~1.5/s</b> · nível <b>DEBUG</b> · buffer <b>2000</b> · <span class="cursor"></span>';
    const p = panel({ icon: '›_', title: 'Log verboso', sub: 'fluxo principal', cls: 'c-log', flush: true, right: [el('div', 'badge', 'AO VIVO')], toolbar: tools, foot }, logFeed);
    logCountEl = foot.querySelector('#lc');
    return p;
  }
  function pushLog() {
    if (paused || !logFeed) return;
    const e = D.log[logIdx % D.log.length]; logIdx++;
    const msg = e[1].replace(/\b(TODO|FIXME|hot-swap|n8n|heygen|recall|filler)\b/g, '<b>$1</b>');
    const line = logLineEl(e[0], fmtTs(), msg); line.classList.add('new');
    logFeed.appendChild(line);
    while (logFeed.children.length > 200) logFeed.removeChild(logFeed.firstChild);
    logFeed.scrollTop = logFeed.scrollHeight;
    logCount++; if (logCountEl) logCountEl.textContent = logCount;
  }

  /* -------- avatar SESSION console -------- */
  function previewTile() {
    const box = el('div', 'avbox framed'); box.style.minHeight = '184px';
    box.appendChild(el('div', 'grid-ov'));
    box.appendChild(el('div', 'scan'));
    box.appendChild(el('div', 'rec', '<span class="d"></span> REC OFF'));
    box.appendChild(el('div', 'res', '720×540 · poster'));
    const scrn = el('div', 'scrn');
    scrn.appendChild(el('div', 'ce', '🎭'));
    scrn.appendChild(el('div', 'st', 'avatar desconectado'));
    const sub = el('div', 'sub2'); sub.style.cssText = 'display:flex;gap:7px;align-items:center';
    sub.appendChild(el('span', 'spin')); sub.appendChild(el('span', null, 'clique em “Conectar avatar”'));
    scrn.appendChild(sub); box.appendChild(scrn);
    const bar = el('div', 'bar');
    bar.appendChild(led('red', true));
    bar.appendChild(el('span', null, '<span style="font-family:var(--mono);font-size:10px;color:#8b95a3">avatar.preview</span>'));
    const fs = el('div', 'ib fs', '⛶'); fs.title = 'Abrir sessão em tela cheia'; fs.style.cursor = 'pointer';
    fs.addEventListener('click', () => { location.href = 'Avatar Session.html'; });
    add(bar, el('div', 'ib', '🔊'), el('div', 'ib', '⚙'), fs);
    box.appendChild(bar);
    return box;
  }
  function devBtn(icon, label, on) {
    const b = el('button', 'devbtn' + (on ? '' : ' off'));
    b.innerHTML = '<span class="ic">' + icon + '</span><span>' + label + '</span><span class="state">' + (on ? 'ON' : 'OFF') + '</span>';
    b.addEventListener('click', () => { const off = b.classList.toggle('off'); b.querySelector('.state').textContent = off ? 'OFF' : 'ON'; });
    return b;
  }
  function sessionPanel() {
    const deck = el('div', 'sessiondeck');

    // modo / comportamento
    const r1 = el('div', 'deckrow');
    r1.appendChild(el('label', null, 'Modo / comportamento'));
    const modo = el('select', 'inp');
    D.modes.forEach(m => { const o = el('option'); o.textContent = m; modo.appendChild(o); });
    r1.appendChild(modo);

    // destino: Local | Google Meet
    const r2 = el('div', 'deckrow');
    r2.appendChild(el('label', null, 'Destino da sessão'));
    const seg = el('div', 'segm');
    const bLocal = el('button', 'on', '<span class="dt"></span> Local (avatar)');
    const bMeet = el('button', null, '<span class="dt"></span> Google Meet');
    seg.appendChild(bLocal); seg.appendChild(bMeet);
    r2.appendChild(seg);

    // meet url (conditional)
    const meetRow = el('div', 'deckrow meeturl hide');
    meetRow.appendChild(el('label', null, 'Link do Google Meet <span class="hint">recall</span>'));
    const meetInp = el('input', 'inp'); meetInp.placeholder = 'https://meet.google.com/…'; meetInp.spellcheck = false;
    meetRow.appendChild(meetInp);

    bLocal.addEventListener('click', () => { bLocal.classList.add('on'); bMeet.classList.remove('on'); meetRow.classList.add('hide'); });
    bMeet.addEventListener('click', () => { bMeet.classList.add('on'); bLocal.classList.remove('on'); meetRow.classList.remove('hide'); });

    // user devices
    const r3 = el('div', 'deckrow');
    r3.appendChild(el('label', null, 'Seus dispositivos'));
    const dev = el('div', 'devrow');
    dev.appendChild(devBtn('📷', 'Câmera', false));
    dev.appendChild(devBtn('🎙', 'Microfone', false));
    r3.appendChild(dev);

    // connect + session actions
    const conn = el('div', 'connectrow');
    const connBtn = el('button', 'btn primary', '🔌 Conectar avatar');
    connBtn.addEventListener('click', () => { location.href = 'Avatar Session.html'; });
    conn.appendChild(connBtn);
    conn.appendChild(el('button', 'btn', '🔊 Testar'));
    conn.appendChild(el('button', 'btn', '⏹ Interromper'));

    const meta = el('div', 'sessmeta');
    meta.innerHTML = '<span class="led red blink"></span> <b>desconectado</b> · 720×540 · 0 fps · hot-swap 270s';

    // send a message to the avatar
    const send = el('div', 'deckrow');
    send.appendChild(el('label', null, 'Enviar mensagem ao avatar'));
    const sc = el('div', 'composer');
    const si = el('input', 'inp'); si.placeholder = 'digite e Enviar…'; si.spellcheck = false;
    sc.appendChild(si); sc.appendChild(el('button', 'btn primary', '✉ Enviar'));
    send.appendChild(sc);

    add(deck, r1, r2, meetRow, r3, conn, meta, send);
    return panel({ icon: '🎬', title: 'Sessão do avatar', sub: 'preview & conexão', cls: 'c-avatar', right: [el('div', 'badge wip', 'OFFLINE')] },
      previewTile(), deck);
  }

  /* -------- config fields -------- */
  function buildField(f) {
    if (f.t === 'toggle') {
      const s = el('div', 'switch');
      s.appendChild(el('div', 'lab', f.label + (f.sub ? '<small>' + f.sub + '</small>' : '')));
      const sw = el('div', 'sw' + (f.on ? ' on' : '') + (f.blue ? ' blue' : ''));
      sw.addEventListener('click', () => sw.classList.toggle('on'));
      s.appendChild(sw); return s;
    }
    const empty = !f.val;
    const wrap = el('div', 'field' + (f.wide ? ' wide' : '') + (f.req ? ' req' : '') + (f.req && empty ? ' err' : ''));
    wrap.appendChild(el('label', null, f.label + (f.hint ? ' <span class="hint">' + f.hint + '</span>' : '')));
    if (f.t === 'sel') {
      const sel = el('select', 'inp'); f.opts.forEach(o => { const op = el('option'); op.textContent = o; if (o === f.val) op.selected = true; sel.appendChild(op); }); wrap.appendChild(sel);
    } else if (f.t === 'area') {
      const ta = el('textarea', 'inp'); ta.value = f.val; ta.rows = 2; ta.spellcheck = false; wrap.appendChild(ta);
    } else {
      const i = el('input', 'inp' + (f.t === 'pass' ? ' pass' : '') + (f.url ? ' url' : ''));
      if (f.t === 'pass') i.type = 'password';
      i.value = f.val || ''; if (f.ph) i.placeholder = f.ph; i.spellcheck = false; wrap.appendChild(i);
    }
    if (f.req && empty) wrap.appendChild(el('div', 'reqmsg', 'Obrigatório'));
    return wrap;
  }
  function configPanel(g) {
    const fg = el('div', 'fields');
    g.fields.forEach(f => fg.appendChild(buildField(f)));
    const body = [];
    if (g.note) body.push(el('div', 'cfgnote', g.note));
    body.push(fg);
    if (g.status) { const st = el('div', 'cfgstatus'); st.appendChild(led(g.status.led, g.status.led !== 'off')); st.appendChild(el('span', null, g.status.txt)); body.push(st); }
    if (g.footer) {
      const fb = el('div', 'footerbtns');
      if (g.enterAs) {
        const ea = el('div', 'enteras', 'Entrar como');
        const sel = el('select', 'inp'); g.enterAs.forEach(o => { const op = el('option'); op.textContent = o; sel.appendChild(op); });
        ea.appendChild(sel); fb.appendChild(ea);
      }
      g.footer.forEach(b => fb.appendChild(el('button', 'btn sm ' + (b.cls || ''), b.label)));
      body.push(fb);
    }
    return panel({ icon: g.icon, title: g.title, sub: g.sub, led: g.led, blink: g.blink, badge: g.badge, badgeCls: g.badgeCls, cls: g.cls, right: [el('div', 'badge', g.fields.length + ' ch')] }, ...body);
  }

  /* -------- Modos (custom) -------- */
  function modosPanel() {
    const m = D.modos;
    const note = el('div', 'cfgnote', m.note);
    const grid = el('div', 'modegrid');
    m.modes.forEach(mode => {
      const c = el('div', 'modecard');
      const mh = el('div', 'mh'); mh.innerHTML = '<b>' + mode.name + '</b><span class="modetag ' + (mode.tagCls || '') + '">' + mode.tag + '</span>';
      c.appendChild(mh);
      const f1 = el('div'); f1.innerHTML = '<label>Fala inicial (ao conectar)</label>';
      const ta = el('textarea', 'inp'); ta.value = mode.fala; ta.rows = 3; ta.spellcheck = false; f1.appendChild(ta); c.appendChild(f1);
      const f2 = el('div'); f2.innerHTML = '<label>Comportamento</label>';
      const sel = el('select', 'inp');
      ['Sempre ativo (responde tudo)', 'Só quando chamado pelo nome (wake word)'].forEach(o => { const op = el('option'); op.textContent = o; if (o === mode.comportamento) op.selected = true; sel.appendChild(op); });
      f2.appendChild(sel); c.appendChild(f2);
      const sw = el('div', 'switch');
      sw.innerHTML = '<div class="lab" style="font-size:11.5px">Interromper falando<small>barge-in</small></div>';
      const t = el('div', 'sw' + (mode.bargein ? ' on' : '')); t.addEventListener('click', () => t.classList.toggle('on')); sw.appendChild(t); c.appendChild(sw);
      if (mode.tolerancia) {
        const f3 = el('div'); f3.innerHTML = '<label>Tolerância de silêncio (s)</label>';
        const i = el('input', 'inp'); i.value = mode.tolerancia; f3.appendChild(i); c.appendChild(f3);
      }
      grid.appendChild(c);
    });
    const hsHd = el('div', 'subhd', 'Reconexão automática (hot-swap)');
    const hsf = el('div', 'fields');
    const hf = el('div', 'field'); hf.innerHTML = '<label>Reconectar a cada <span class="hint">segundos</span></label>';
    const hi = el('input', 'inp'); hi.value = D.session.hotswap; hf.appendChild(hi);
    const hnote = el('div', 'field wide'); hnote.innerHTML = '<div class="cfgnote" style="margin:0">Renova a sessão do HeyGen antes do limite de 5 min do plano. <b>270s</b> (4:30) em produção.</div>';
    add(hsf, hf, hnote);
    const meetHd = el('div', 'subhd', 'Geral — dentro do Google Meet (Camada 3)');
    const mf = el('div', 'fields');
    const pf = el('div', 'field'); pf.innerHTML = '<label>Pausa antes de enviar <span class="hint">segundos</span></label>';
    const pi = el('input', 'inp'); pi.value = D.session.meetPause; pf.appendChild(pi);
    const diag = el('div', 'switch'); diag.style.gridColumn = '1 / -1';
    diag.innerHTML = '<div class="lab">Modo diagnóstico no Meet<small>mostra status na câmera do bot</small></div>';
    const dt = el('div', 'sw' + (D.session.meetDiag ? ' on' : '')); dt.addEventListener('click', () => dt.classList.toggle('on')); diag.appendChild(dt);
    add(mf, pf, diag);
    return panel({ icon: m.icon, title: m.title, sub: m.sub, led: m.led, badge: m.badge, cls: m.cls, right: [el('div', 'badge', '3 modos')] },
      note, grid, el('div', 'divider'), hsHd, hsf, el('div', 'divider'), meetHd, mf);
  }

  /* -------- hot-swap countdown -------- */
  function hotSwapPanel() {
    const wrap = el('div', 'hotswap');
    const r = 26, C = 2 * Math.PI * r;
    const ring = el('div', 'ring');
    const s = svg('svg', { width: '64', height: '64', viewBox: '0 0 64 64' });
    s.appendChild(svg('circle', { cx: 32, cy: 32, r, fill: 'none', stroke: 'var(--border-2)', 'stroke-width': '6' }));
    const arc = svg('circle', { cx: 32, cy: 32, r, fill: 'none', stroke: 'var(--blue)', 'stroke-width': '6', 'stroke-linecap': 'round', transform: 'rotate(-90 32 32)', 'stroke-dasharray': C, 'stroke-dashoffset': 0 });
    s.appendChild(arc); ring.appendChild(s);
    const tEl = el('div', 't', '4:30'); ring.appendChild(tEl);
    const meta = el('div', 'meta');
    meta.innerHTML = '<div class="big">Próximo hot-swap</div><div class="sub">renova a sessão a cada <b>270s</b><br>driblando o limite de 5 min do plano</div>';
    add(wrap, ring, meta);
    let left = D.session.hotswap; const total = D.session.hotswap;
    setInterval(() => {
      left -= 1; if (left < 0) left = total;
      const mm = Math.floor(left / 60), sec = String(left % 60).padStart(2, '0');
      tEl.textContent = mm + ':' + sec;
      arc.setAttribute('stroke-dashoffset', (C * (1 - left / total)).toFixed(1));
    }, 1000);
    return panel({ icon: '♻', title: 'Hot-swap', sub: 'reconexão', cls: 'c-hotswap', right: [el('div', 'badge', 'T-270s')] }, wrap);
  }

  /* -------- voice diagnostics -------- */
  function voicePanel() {
    const list = statusList(D.voice.map(v => ({ nm: v.nm, vl: v.vl, led: v.led, blink: false })));
    const tr = el('div', 'transcript'); tr.style.marginTop = '10px';
    const hd = el('div', 'subhd'); hd.innerHTML = '<span style="flex:none">Transcrição ao vivo</span>';
    const cc = el('span', 'badge blue', '💬 Legendas ON'); cc.style.cssText = 'margin-left:auto;font-size:9px'; hd.appendChild(cc);
    tr.appendChild(hd);
    D.transcript.forEach(l => tr.appendChild(el('div', 'ln', '<span style="color:var(--ink-3)">' + l.txt + '</span>')));
    const typing = el('div', 'ln'); typing.innerHTML = '<span class="who me">interim › </span><span data-typetext style="color:var(--ink-3)"></span><span class="cursor"></span>';
    tr.appendChild(typing);
    const mic = el('div'); mic.style.cssText = 'margin-top:8px;font-family:var(--mono);font-size:10.5px;color:var(--ink-3);display:flex;align-items:center;gap:6px';
    mic.innerHTML = '<span class="led off" style="width:8px;height:8px"></span> Mic desligado';
    tr.appendChild(mic);
    return panel({ icon: '🎙', title: 'Diagnóstico de voz', sub: 'STT', cls: 'c-voice', right: [el('div', 'badge', 'DIAG')] }, list, tr);
  }

  /* -------- VU helper -------- */
  function buildVu(n) { const v = el('div', 'vu'); for (let i = 0; i < (n || 22); i++) v.appendChild(el('i')); return v; }
  function animateVu(vu, on) {
    vu.querySelectorAll('i').forEach((b, idx) => {
      if (!on) { b.style.height = '8%'; b.className = ''; return; }
      const h = 10 + Math.random() * (38 + (Math.sin(Date.now() / 190 + idx) + 1) * 24);
      b.style.height = Math.min(100, h).toFixed(0) + '%';
      b.className = h > 78 ? 'hot' : 'on';
    });
  }

  /* -------- transcription tester -------- */
  function transcriptionPanel() {
    const st = el('div', 'testrow');
    st.innerHTML = '<span class="led off" data-ws></span><span style="font-family:var(--mono);font-size:10.5px;color:var(--ink-3)">WebSocket: <b data-wsst style="color:var(--ink-2)">desconectado</b> · engine webspeech · pt-BR</span>';
    const vu = buildVu(24);
    const ctrl = el('div', 'testrow'); ctrl.style.marginTop = '4px';
    const startB = el('button', 'btn primary sm', '▶ Iniciar teste');
    const stopB = el('button', 'btn sm', '■ Parar'); stopB.disabled = true;
    add(ctrl, startB, stopB);
    const out = el('div', 'transout');
    out.innerHTML = '<div class="subhd">saída do STT</div>' +
      '<div class="il">interim › <span data-itx></span><span class="cursor" data-icur style="display:none"></span></div>' +
      '<div class="fl"><span class="lab2">FINAL</span> › <span data-ftx>—</span></div>';
    const hint = el('div', 'cfgnote'); hint.style.marginTop = '8px';
    hint.textContent = 'Fale algo — o interim aparece em tempo real e o FINAL ao terminar a frase.';

    const wsLed = st.querySelector('[data-ws]'), wsSt = st.querySelector('[data-wsst]');
    const itx = out.querySelector('[data-itx]'), ftx = out.querySelector('[data-ftx]'), icur = out.querySelector('[data-icur]');
    const phr = ['olá, teste de microfone', 'um, dois, três', 'consegue me ouvir', 'a transcrição está funcionando'];
    let vt, tt, p = '', i = 0;
    function start() {
      startB.disabled = true; stopB.disabled = false;
      wsLed.className = 'led green'; wsSt.textContent = 'conectado'; icur.style.display = 'inline-block';
      p = phr[Math.floor(Math.random() * phr.length)]; i = 0; itx.textContent = '';
      clearInterval(tt); tt = setInterval(() => {
        if (i < p.length) itx.textContent = p.slice(0, ++i);
        else { ftx.textContent = p; itx.textContent = ''; i = 0; p = phr[Math.floor(Math.random() * phr.length)]; }
      }, 95);
      clearInterval(vt); vt = setInterval(() => animateVu(vu, true), 80);
    }
    function stop() {
      startB.disabled = false; stopB.disabled = true;
      clearInterval(tt); clearInterval(vt); animateVu(vu, false);
      wsLed.className = 'led off'; wsSt.textContent = 'desconectado'; icur.style.display = 'none'; itx.textContent = '';
    }
    startB.onclick = start; stopB.onclick = stop;
    return panel({ icon: '🎧', title: 'Teste de transcrição', sub: 'STT · WebSocket', cls: 'c-trans', right: [el('div', 'badge', 'STT')] }, st, vu, ctrl, out, hint);
  }

  /* -------- device tester (mic & câmera) -------- */
  function devicesPanel() {
    const camHd = el('div', 'subhd', 'Câmera');
    const cam = el('div', 'camtest');
    cam.innerHTML = '<div class="cbadge"><span class="d"></span> <span data-camb>off</span></div><span data-camtxt>câmera desligada</span>';
    const camSel = el('div', 'devsel');
    const cs = el('select', 'inp'); ['Padrão do sistema', 'Câmera externa (USB)', 'Câmera virtual (OBS)'].forEach(o => { const op = el('option'); op.textContent = o; cs.appendChild(op); });
    const camBtn = el('button', 'btn sm', 'Testar câmera');
    add(camSel, cs, camBtn);
    let camOn = false;
    camBtn.onclick = () => {
      camOn = !camOn; cam.classList.toggle('live', camOn);
      cam.querySelector('[data-camtxt]').textContent = camOn ? 'prévia da câmera (simulada)' : 'câmera desligada';
      cam.querySelector('[data-camb]').textContent = camOn ? 'live' : 'off';
      camBtn.textContent = camOn ? 'Parar câmera' : 'Testar câmera';
    };

    const micHd = el('div', 'subhd', 'Microfone');
    const vu = buildVu(22);
    const micSel = el('div', 'devsel');
    const ms = el('select', 'inp'); ['Padrão do sistema', 'Headset USB', 'Microfone externo'].forEach(o => { const op = el('option'); op.textContent = o; ms.appendChild(op); });
    const micBtn = el('button', 'btn sm', '🎤 Testar (5s)');
    add(micSel, ms, micBtn);
    let mvt, cd;
    micBtn.onclick = () => {
      if (mvt) return;
      let left = 5; micBtn.disabled = true; micBtn.textContent = 'gravando… 5s';
      mvt = setInterval(() => animateVu(vu, true), 80);
      cd = setInterval(() => { left--; micBtn.textContent = 'gravando… ' + left + 's'; if (left <= 0) { clearInterval(cd); clearInterval(mvt); mvt = null; animateVu(vu, false); micBtn.disabled = false; micBtn.textContent = '🎤 Testar (5s)'; } }, 1000);
    };

    const perm = el('div', 'cfgstatus');
    perm.innerHTML = '<span class="led amber blink"></span> permissão de mídia: <b style="color:var(--accent-ink)">pendente</b>';

    return panel({ icon: '🎚', title: 'Teste de dispositivos', sub: 'câmera & microfone', cls: 'c-devices', right: [el('div', 'badge', 'MÍDIA')] },
      camHd, cam, camSel, el('div', 'divider'), micHd, vu, micSel, perm);
  }

  /* ===================== MOUNT ===================== */
  const bento = document.getElementById('bento');
  add(bento,
    sessionPanel(),
    buildLog(),
    panel({ icon: '◉', title: 'Status da sessão', sub: 'ao vivo', cls: 'c-status' }, statusList(D.status)),
    panel({ icon: '✓', title: 'Prontidão da config', sub: '4 abas', cls: 'c-ready' }, statusList(D.ready)),
    hotSwapPanel(),
    voicePanel(),
    devicesPanel(),
    transcriptionPanel()
  );
  D.configGroups.forEach(g => bento.appendChild(configPanel(g)));
  bento.appendChild(modosPanel());

  document.querySelectorAll('.seg-ctl button').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.seg-ctl button').forEach(x => x.classList.remove('on')); b.classList.add('on'); }));

  /* ===================== ANIMATION ===================== */
  const Tm = { motion: 1 };
  let logTimer;
  function scheduleLog() { clearTimeout(logTimer); logTimer = setTimeout(() => { pushLog(); scheduleLog(); }, (560 + Math.random() * 720) * Tm.motion); }
  scheduleLog();

  const phrases = ['aguardando fala…', '(silêncio)', 'detectando voz…', 'sem sessão ativa'];
  let tgt = '', ti = 0;
  setInterval(() => {
    const e = document.querySelector('[data-typetext]'); if (!e) return;
    if (ti >= tgt.length) { tgt = phrases[Math.floor(Math.random() * phrases.length)]; ti = 0; e.textContent = ''; }
    else e.textContent = tgt.slice(0, ++ti);
  }, 120);

  /* ===================== TWEAKS ===================== */
  (function tweaks() {
    const d = el('div', 'tweaks min');
    const th = el('div', 'th', '<span class="ico">✦</span> Ajustes');
    const car = el('span', null, '▸'); car.style.marginLeft = 'auto'; th.appendChild(car);
    th.addEventListener('click', () => { d.classList.toggle('min'); car.textContent = d.classList.contains('min') ? '▸' : '▾'; });
    const b = el('div', 'tb');
    const m = el('div', 'tw'); m.innerHTML = '<span>Velocidade · <b id="mv">1.0×</b></span>';
    const mr = el('input'); mr.type = 'range'; mr.min = .3; mr.max = 2.2; mr.step = .1; mr.value = 1;
    mr.addEventListener('input', () => { const v = +mr.value; Tm.motion = 1 / v; document.documentElement.style.setProperty('--motion', Tm.motion); document.getElementById('mv').textContent = v.toFixed(1) + '×'; scheduleLog(); });
    m.appendChild(mr); b.appendChild(m);
    const a = el('div', 'tw'); a.innerHTML = '<span>Cor de destaque</span>';
    const sr = el('div', 'swr');
    [['#cf7a1f', '#90520c', '#fbf1e3'], ['#2f62d8', '#1c3f96', '#ecf1fd'], ['#1f9d63', '#136b42', '#e7f5ee'], ['#7c4dd6', '#4f2c95', '#f1ecfb']].forEach(([c, ink, bg], i) => {
      const btn = el('button', i === 0 ? 'on' : ''); btn.style.background = c;
      btn.addEventListener('click', () => { const r = document.documentElement.style; r.setProperty('--accent', c); r.setProperty('--accent-ink', ink); r.setProperty('--accent-bg', bg); [...sr.children].forEach(x => x.classList.remove('on')); btn.classList.add('on'); });
      sr.appendChild(btn);
    });
    a.appendChild(sr); b.appendChild(a);
    const dens = el('div', 'tw'); dens.innerHTML = '<span>Densidade</span>';
    const ds = el('div', 'seg');
    [['compacto', '11px'], ['padrão', '13px'], ['amplo', '16px']].forEach(([t, g], i) => {
      const btn = el('button', i === 1 ? 'on' : '', t);
      btn.addEventListener('click', () => { document.querySelector('.bento').style.gap = g; [...ds.children].forEach(x => x.classList.remove('on')); btn.classList.add('on'); });
      ds.appendChild(btn);
    });
    dens.appendChild(ds); b.appendChild(dens);
    d.appendChild(th); d.appendChild(b); document.body.appendChild(d);
  })();
})();
