/* ============================================================
   reorder.js — free-form canvas layout for the bento panels
   • configurable snap grid (background + snapping granularity)
   • move panels anywhere (drag the ⠿ grip)
   • resize width / height independently (edge + corner grips)
   • everything persisted to localStorage
   Runs after dash.js has mounted the panels.
   ============================================================ */
(function () {
  const bento = document.getElementById('bento');
  if (!bento) return;
  const KEY = 'avatarConsole.freeform.v1';

  /* ---- stable ids from the c-* class ---- */
  const panels = [...bento.children];
  panels.forEach(p => {
    const cls = [...p.classList].find(c => c.startsWith('c-'));
    p.dataset.pid = cls ? cls.slice(2) : Math.random().toString(36).slice(2);
  });

  const num = (s, d) => { const n = parseFloat(s); return isNaN(n) ? d : n; };
  const q = id => bento.querySelector('[data-pid="' + CSS.escape(id) + '"]');

  /* ---- state ---- */
  const DEF = { cell: 20, snap: true, edit: false };
  let STATE = { rects: {}, cell: DEF.cell, snap: DEF.snap, edit: DEF.edit };
  let zTop = 10;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(STATE)); } catch (_) {}
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) STATE = Object.assign({ rects: {}, cell: DEF.cell, snap: DEF.snap, edit: DEF.edit }, JSON.parse(raw));
    } catch (_) {}
  }

  const cell = () => Math.max(6, STATE.cell || DEF.cell);
  const snapV = v => STATE.snap ? Math.round(v / cell()) * cell() : Math.round(v);

  const MIN_W = () => Math.max(180, cell() * 6);
  const MIN_H = () => Math.max(96, cell() * 4);

  /* ---- canvas grid background (visible only while editing) ---- */
  function applyGridStyle() {
    document.documentElement.style.setProperty('--cell', cell() + 'px');
    bento.classList.toggle('editing', !!STATE.edit);
  }

  /* ---- write a panel's rect to the DOM ---- */
  function place(p, r, animate) {
    if (animate) { p.classList.add('placing'); setTimeout(() => p.classList.remove('placing'), 220); }
    p.style.left = r.x + 'px';
    p.style.top = r.y + 'px';
    p.style.width = r.w + 'px';
    p.style.height = r.h + 'px';
  }
  function applyAll(animate) {
    panels.forEach(p => { const r = STATE.rects[p.dataset.pid]; if (r) place(p, r, animate); });
    growCanvas();
  }
  function growCanvas() {
    let max = 0;
    for (const id in STATE.rects) { const r = STATE.rects[id]; max = Math.max(max, r.y + r.h); }
    bento.style.height = (max + cell() * 2) + 'px';
  }

  /* ---- seed rects from the original grid layout (first run) ---- */
  function seedFromGrid() {
    const bRect = bento.getBoundingClientRect();
    const bs = getComputedStyle(bento);
    const ox = bRect.left + num(bs.paddingLeft, 0) + num(bs.borderLeftWidth, 0);
    const oy = bRect.top + num(bs.paddingTop, 0) + num(bs.borderTopWidth, 0);
    const seeded = {};
    panels.forEach(p => {
      const r = p.getBoundingClientRect();
      seeded[p.dataset.pid] = {
        x: snapV(r.left - ox),
        y: snapV(r.top - oy),
        w: snapV(r.width),
        h: snapV(r.height)
      };
    });
    return seeded;
  }

  /* ---- snap ghost (preview of landing spot) ---- */
  const ghost = document.createElement('div');
  ghost.className = 'snapghost';
  function showGhost(r) {
    ghost.style.left = r.x + 'px'; ghost.style.top = r.y + 'px';
    ghost.style.width = r.w + 'px'; ghost.style.height = r.h + 'px';
  }

  /* ===================== MOVE ===================== */
  function startMove(e, p) {
    if (!STATE.edit) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    const r = STATE.rects[p.dataset.pid];
    const sx = e.clientX, sy = e.clientY;
    const ox = r.x, oy = r.y;
    p.style.zIndex = ++zTop;
    p.classList.add('dragging'); bento.classList.add('reordering', 'canvas');
    let cur = { ...r };
    showGhost(r);
    function move(ev) {
      const nx = Math.max(0, ox + (ev.clientX - sx));
      const ny = Math.max(0, oy + (ev.clientY - sy));
      p.style.left = nx + 'px'; p.style.top = ny + 'px';
      cur = { x: snapV(nx), y: Math.max(0, snapV(ny)), w: r.w, h: r.h };
      showGhost(cur);
      // expand canvas live while dragging downward
      if (cur.y + cur.h + cell() * 2 > parseFloat(bento.style.height || 0)) growCanvas2(cur.y + cur.h);
    }
    function up() {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      p.classList.remove('dragging'); bento.classList.remove('reordering');
      STATE.rects[p.dataset.pid] = cur;
      place(p, cur, true); growCanvas(); save();
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  }
  function growCanvas2(bottom) { bento.style.height = (bottom + cell() * 2) + 'px'; }

  /* ===================== RESIZE ===================== */
  function startResize(e, p, mode) {
    if (!STATE.edit) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const grip = e.currentTarget;
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    const r = STATE.rects[p.dataset.pid];
    const sx = e.clientX, sy = e.clientY;
    const ow = r.w, oh = r.h;
    p.style.zIndex = ++zTop;
    p.classList.add('resizing'); bento.classList.add('reordering', 'canvas');
    let cur = { ...r };
    showGhost(r);
    function move(ev) {
      let nw = ow, nh = oh;
      if (mode !== 's') nw = Math.max(MIN_W(), ow + (ev.clientX - sx));
      if (mode !== 'e') nh = Math.max(MIN_H(), oh + (ev.clientY - sy));
      p.style.width = nw + 'px'; p.style.height = nh + 'px';
      cur = { x: r.x, y: r.y, w: Math.max(MIN_W(), snapV(nw)), h: Math.max(MIN_H(), snapV(nh)) };
      showGhost(cur);
      if (cur.y + cur.h + cell() * 2 > parseFloat(bento.style.height || 0)) growCanvas2(cur.y + cur.h);
    }
    function up() {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      p.classList.remove('resizing'); bento.classList.remove('reordering');
      STATE.rects[p.dataset.pid] = cur;
      place(p, cur, true); growCanvas(); save();
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  }

  /* ---- attach grips to every panel ---- */
  panels.forEach(p => {
    // move grip in the header
    const ph = p.querySelector('.ph');
    if (ph) {
      const h = document.createElement('div');
      h.className = 'drag'; h.title = 'Arraste para mover'; h.textContent = '⠿';
      h.style.touchAction = 'none';
      ph.insertBefore(h, ph.firstChild);
      h.addEventListener('pointerdown', e => startMove(e, p));
    }
    // corner (both axes)
    const se = document.createElement('div');
    se.className = 'rsz'; se.title = 'Redimensionar';
    se.addEventListener('pointerdown', e => startResize(e, p, 'se'));
    p.appendChild(se);
    // right edge (width only)
    const ge = document.createElement('div');
    ge.className = 'rgrip e'; ge.title = 'Largura';
    ge.addEventListener('pointerdown', e => startResize(e, p, 'e'));
    p.appendChild(ge);
    // bottom edge (height only)
    const gs = document.createElement('div');
    gs.className = 'rgrip s'; gs.title = 'Altura';
    gs.addEventListener('pointerdown', e => startResize(e, p, 's'));
    p.appendChild(gs);
  });

  /* ===================== INIT ===================== */
  loadState();
  applyGridStyle();
  // seed positions on first run (before switching to absolute)
  if (!STATE.rects || !Object.keys(STATE.rects).length) {
    STATE.rects = seedFromGrid();
  } else {
    // ensure any newly-added panel without a saved rect gets seeded
    const seeded = seedFromGrid();
    panels.forEach(p => { if (!STATE.rects[p.dataset.pid]) STATE.rects[p.dataset.pid] = seeded[p.dataset.pid]; });
  }
  bento.classList.add('canvas');
  bento.appendChild(ghost);
  applyAll(false);
  save();

  /* ---- relayout to grid defaults ---- */
  function resetAll() {
    bento.classList.remove('canvas');
    panels.forEach(p => { p.style.left = p.style.top = p.style.width = p.style.height = p.style.zIndex = ''; });
    bento.style.height = '';
    // force reflow as grid, re-seed, switch back
    void bento.offsetHeight;
    STATE.rects = seedFromGrid();
    bento.classList.add('canvas');
    applyAll(true);
    save();
  }
  window.resetBentoLayout = resetAll;

  /* ---- auto-pack: tidy everything into neat columns ---- */
  function autoPack() {
    const W = bento.clientWidth;
    const gap = cell();
    const order = panels.slice().sort((a, b) => {
      const ra = STATE.rects[a.dataset.pid], rb = STATE.rects[b.dataset.pid];
      return (ra.y - rb.y) || (ra.x - rb.x);
    });
    // shelf packing left→right, wrap by width
    let x = 0, y = 0, shelfH = 0;
    order.forEach(p => {
      const r = STATE.rects[p.dataset.pid];
      if (x + r.w > W && x > 0) { x = 0; y += shelfH + gap; shelfH = 0; }
      const nx = snapV(x), ny = snapV(y);
      STATE.rects[p.dataset.pid] = { x: nx, y: ny, w: r.w, h: r.h };
      x += r.w + gap; shelfH = Math.max(shelfH, r.h);
    });
    applyAll(true); save();
  }
  window.packBentoLayout = autoPack;

  /* ===================== SETTINGS POPOVER (top bar) ===================== */
  function setEdit(on) {
    STATE.edit = !!on;
    applyGridStyle();
    save();
  }

  (function buildSettings() {
    const right = document.querySelector('.topbar .right');
    if (!right) return;

    const wrap = document.createElement('div');
    wrap.className = 'setwrap';

    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.innerHTML = '⚙ Configurações';

    const pop = document.createElement('div');
    pop.className = 'setpop';
    pop.innerHTML =
      '<button class="edit-btn" id="se-edit"></button>' +
      '<div class="sdiv"></div>' +
      '<div class="sgrp">' +
        '<div class="slab">Tamanho da grade · <b id="se-cv">' + cell() + 'px</b></div>' +
        '<input type="range" id="se-cell" min="8" max="48" step="2" value="' + cell() + '">' +
      '</div>' +
      '<div class="sgrp">' +
        '<div class="slab">Encaixe na grade</div>' +
        '<div class="srow"><button id="se-snap">⊞ Encaixar painéis</button></div>' +
      '</div>' +
      '<div class="sgrp">' +
        '<div class="slab">Layout dos painéis</div>' +
        '<div class="srow"><button id="se-pack">⇲ Organizar</button><button id="se-reset">↺ Padrão</button></div>' +
      '</div>' +
      '<div class="shint" id="se-hint"></div>';

    wrap.appendChild(btn);
    wrap.appendChild(pop);
    // place the settings button before the Diagnóstico button
    right.insertBefore(wrap, right.firstChild);

    const editBtn = pop.querySelector('#se-edit');
    const cellInp = pop.querySelector('#se-cell');
    const cellVal = pop.querySelector('#se-cv');
    const snapBtn = pop.querySelector('#se-snap');
    const packBtn = pop.querySelector('#se-pack');
    const resetBtn = pop.querySelector('#se-reset');
    const hint = pop.querySelector('#se-hint');
    const gridGrp = cellInp.closest('.sgrp');

    function syncUI() {
      editBtn.classList.toggle('on', STATE.edit);
      editBtn.innerHTML = STATE.edit ? '✓ Sair do modo de edição' : '✎ Entrar no modo de edição';
      btn.classList.toggle('on', STATE.edit);
      snapBtn.classList.toggle('on', STATE.snap);
      cellInp.value = cell();
      cellVal.textContent = cell() + 'px';
      gridGrp.classList.toggle('smlocked', !STATE.edit);
      hint.innerHTML = STATE.edit
        ? '⠿ mover livre · borda ↔ largura · borda ↕ altura · canto ↘ ambos'
        : 'Ative o modo de edição para mover e redimensionar os painéis.';
    }

    editBtn.addEventListener('click', () => { setEdit(!STATE.edit); syncUI(); });
    cellInp.addEventListener('input', () => {
      STATE.cell = +cellInp.value;
      cellVal.textContent = STATE.cell + 'px';
      applyGridStyle(); growCanvas(); save();
    });
    snapBtn.addEventListener('click', () => { STATE.snap = !STATE.snap; save(); syncUI(); });
    packBtn.addEventListener('click', () => { if (!STATE.edit) setEdit(true); autoPack(); syncUI(); });
    resetBtn.addEventListener('click', () => { resetAll(); syncUI(); });

    btn.addEventListener('click', e => {
      e.stopPropagation();
      pop.classList.toggle('open');
      if (pop.classList.contains('open')) syncUI();
    });
    pop.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => pop.classList.remove('open'));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') pop.classList.remove('open'); });

    syncUI();
  })();
})();
