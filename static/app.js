(() => {
'use strict';
const { THREE, OrbitControls, RoomEnvironment, vtk } = window.ZKLIB;

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}
const ICON = {
  play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>',
  max: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>',
  caret: '<svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M3 1l4 4-4 4z"/></svg>',
  colour: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.5" cy="6" r="3.5" fill="#e4572e"/><circle cx="10.5" cy="6" r="3.5" fill="#3b82f6" fill-opacity=".85"/><circle cx="8" cy="10.5" r="3.5" fill="#f4b740" fill-opacity=".85"/></svg>',
};
const fmt = (n, d = 0) => n.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });

/* ------------------------------------------------------------------ state */
// Per-structure tables, indexed by the registry's stable structure id. Sized once, from the registry.
let COL = new Uint8Array(3), COL3 = new Uint8Array(3), VIS = new Uint8Array(1), PAINT = new Uint8Array(1), HIT = new Uint8Array(1);
const NAME = [], GROUP = [], GKEY = [], ML = [], KEY = [], PARENT = [], ENTRY = [];
const BODY_ID = 65535;
const GRAY = new Uint8Array(4096);
const S = { opacity: 0.48, linkAB: true, selected: 0, model: null, lang: 'en', meta: null, study: null, open: 0, present: new Set(), rows: new Set(), kids: new Map(), total: new Map(), task: new Map(), idOf: new Map() };
try { S.lang = localStorage.getItem('zk.anatomy.lang') || 'en'; } catch (e) { /* storage unavailable: English */ }
const P = { vol: null, cross: [0, 0, 0], dir: [1, 1, 1], views: [] };   // patient space
const R = { vol: null, cross: [0, 0, 0], dir: [1, 1, 1], views: [] };   // reference space, never linked to P
const MESH = new Map(), MESH_LO = new Map();       // full surfaces; light ones drawn while a 3D view moves
const UI = {};
const tip = $('#tip');

function setWindow(c, w) {
  const lo = c - w / 2;
  for (let i = 0; i < 4096; i++) GRAY[i] = clamp(Math.round(((i - 1024 - lo) / w) * 255), 0, 255);
  markAll();
}
function mark(space) {
  for (const v of space.views) v.dirty = true;
  if (space === P) { CPR.dirty = true; if (D.ready && D.plane) D.updatePlane(); }
}
function markAll() { mark(P); mark(R); }

/* ------------------------------------------------------------------ loading */
async function api(path, init) {
  const res = await fetch(path, { cache: 'no-store', ...init });
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(body && body.error ? body.error.message : `${path} returned HTTP ${res.status}`);
    err.code = body && body.error ? body.error.code : null; err.status = res.status; err.body = body; throw err;
  }
  return body;
}
async function fetchBytes(url, length, onProgress) {
  // The server sends the volume gzip-encoded; the browser inflates it, so the bytes read here are the voxels themselves.
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const reader = res.body.getReader(), out = new Uint8Array(length); let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > length) throw new Error(`${url} holds more than the ${length} bytes the study states`);
    out.set(value, got); got += value.length;
    if (onProgress) onProgress(got / length);
  }
  if (got !== length) throw new Error(`${url} holds ${got} bytes, the study states ${length}`);
  return out;
}
const valueText = (vol, v) => (vol.unit === 'HU' ? `${v} HU` : `value ${fmt((v + 1024) / vol.scale + vol.offset)}`);

/* ------------------------------------------------------------------ names */
const langName = () => (S.meta.registry.locales.find((l) => l.code === S.lang) || { name: S.lang }).name;
function term(id, lang = S.lang) {
  const e = ENTRY[id];
  if (!e) return { text: `Structure ${id}`, missing: false, source: null };
  if (lang === 'en') return { text: e.en, missing: false, source: 'en' };
  const t = e.terms[lang];
  return t ? { text: t[0], missing: false, source: t[1], note: t[2] || null } : { text: e.en, missing: true, source: null };
}
function showTip(x, y, id, sub) {
  const t = term(id), e = ENTRY[id], second = [];
  if (t.missing) second.push(`No ${langName()} name on record, English shown`);
  else if (S.lang !== 'en' && e) second.push(e.en);
  if (PARENT[id] && NAME[PARENT[id]]) second.push(`part of ${NAME[PARENT[id]]}`);
  tip.replaceChildren(...[
    h('b', { dir: 'auto' }, h('i', { style: `background:rgb(${COL[id * 3]},${COL[id * 3 + 1]},${COL[id * 3 + 2]})` }), t.text),
    second.length ? h('span', { class: t.missing ? 'miss' : null, dir: 'auto', text: second.join(' · ') }) : null,
    h('span', { text: `${GROUP[id] || ''}${sub ? ' · ' + sub : ''}` })].filter(Boolean));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 14, window.innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(y + 16, window.innerHeight - r.height - 8)}px`;
}
function setHover(id) {
  $('#stHover').textContent = id ? `${NAME[id]}  ·  ${GROUP[id]}` : 'No structure under the pointer';
}


/* ------------------------------------------------------------------ slice geometry */
const PLANES = { ax: 'Axial', cor: 'Coronal', sag: 'Sagittal' };
function geom(vol, plane) {
  const [nx, ny, nz] = vol.dims, [sx, sy, sz] = vol.sp, nxy = nx * ny;
  if (plane === 'ax') return { w: nx, h: ny, su: sx, sv: sy, sn: sz, count: nz, axis: 2, stepC: 1, stepR: nx, stepN: nxy, base: (i) => i * nxy, edge: ['R', 'L', 'A', 'P'] };
  if (plane === 'cor') return { w: nx, h: nz, su: sx, sv: sz, sn: sy, count: ny, axis: 1, stepC: 1, stepR: -nxy, stepN: nx, base: (i) => i * nx + nxy * (nz - 1), edge: ['R', 'L', 'S', 'I'] };
  return { w: ny, h: nz, su: sy, sv: sz, sn: sx, count: nx, axis: 0, stepC: nx, stepR: -nxy, stepN: 1, base: (i) => i + nxy * (nz - 1), edge: ['A', 'P', 'S', 'I'] };
}
function voxelOf(vol, plane, c, r, p) {
  const nz = vol.dims[2];
  if (plane === 'ax') return [c, r, p];
  if (plane === 'cor') return [c, p, nz - 1 - r];
  return [p, c, nz - 1 - r];
}
function inPlane(vol, plane, cross) {
  const nz = vol.dims[2];
  if (plane === 'ax') return [cross[0], cross[1]];
  if (plane === 'cor') return [cross[0], nz - 1 - cross[2]];
  return [cross[1], nz - 1 - cross[2]];
}

/* ------------------------------------------------------------------ slice view */
class SliceView {
  constructor(host, space, o = {}) {
    this.host = host; this.space = space; this.o = o;
    this.plane = o.plane || 'ax';
    this.colour = !!o.overlay;
    this.playing = false; this.speed = 24; this.zoom = 1;
    this.hoverId = 0; this.dirty = true; this.buf = null; this.fit = null;
    this.canvas = h('canvas', { tabindex: o.mini ? null : '0', 'aria-label': o.label || 'Image' });
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const cv = this.canvas;
    cv.addEventListener('pointermove', (e) => this.onMove(e));
    cv.addEventListener('pointerleave', () => { this.ptr = null; if (this.hoverId) { this.hoverId = 0; this.dirty = true; } tip.hidden = true; setHover(0); });
    cv.addEventListener('click', (e) => this.onClick(e));
    cv.addEventListener('dblclick', () => { this.zoom = 1; this.dirty = true; });
    cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    cv.addEventListener('keydown', (e) => this.onKey(e));
    space.views.push(this);
  }
  resize() {
    const r = this.host.getBoundingClientRect(), d = DPR();
    const w = Math.max(1, Math.round(r.width * d)), hh = Math.max(1, Math.round(r.height * d));
    if (this.canvas.width !== w || this.canvas.height !== hh) { this.canvas.width = w; this.canvas.height = hh; }
    this.dirty = true;
  }
  buffer(w, hh) {
    if (!this.buf || this.buf.w !== w || this.buf.h !== hh) {
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = hh;
      const ctx = canvas.getContext('2d'); const img = ctx.createImageData(w, hh);
      this.buf = { w, h: hh, canvas, ctx, img, d32: new Uint32Array(img.data.buffer), lab: new Uint16Array(w * hh), gray: new Uint8Array(w * hh), hasLab: false };
    }
    return this.buf;
  }
  render() {
    this.dirty = false;
    const cv = this.canvas, ctx = this.ctx, vol = this.space.vol, cw = cv.width, ch = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    if (!vol) { this.fit = null; return; }
    const g = geom(vol, this.plane), { w, h: hh, stepC, stepR, stepN } = g;
    const p = clamp(this.space.cross[g.axis], 0, g.count - 1);
    let i0 = Math.floor(p), t = p - i0;
    if (i0 >= g.count - 1) { i0 = g.count - 1; t = 0; }
    if (t < 0.004) t = 0;
    const base = g.base(i0), b = this.buffer(w, hh), d32 = b.d32, labS = b.lab;
    const vis = this.space === R ? RVIS : VIS, lab = vol.lab, canLab = !!lab && !!this.o.overlay, showCol = this.colour && canLab, needLab = canLab && (showCol || !!this.o.hover || S.selected > 0);
    b.hasLab = needLab;
    if (vol.rgb) {
      const rgb = vol.rgb; let k = 0;
      for (let r = 0; r < hh; r++) {
        let idx = (base + r * stepR) * 3;
        const sc = stepC * 3, sn = stepN * 3;
        for (let c = 0; c < w; c++, idx += sc, k++) {
          let R0 = rgb[idx], G0 = rgb[idx + 1], B0 = rgb[idx + 2];
          if (t) { R0 += (rgb[idx + sn] - R0) * t; G0 += (rgb[idx + sn + 1] - G0) * t; B0 += (rgb[idx + sn + 2] - B0) * t; }
          d32[k] = 0xff000000 | (B0 << 16) | (G0 << 8) | R0;
        }
      }
    } else {
      const hu = vol.hu, gray = b.gray, nb = t >= 0.5 ? stepN : 0; let k = 0;
      for (let r = 0; r < hh; r++) {
        let idx = base + r * stepR;
        for (let c = 0; c < w; c++, idx += stepC, k++) {
          let v = hu[idx];
          if (t) v += (hu[idx + stepN] - v) * t;
          let q = (v + 1024) | 0; q = q < 0 ? 0 : q > 4095 ? 4095 : q;
          gray[k] = GRAY[q];
          if (needLab) { const L = lab[idx + nb]; labS[k] = vis[L] ? L : 0; }
        }
      }
      const a0 = S.opacity, hov = this.hoverId, sel = S.selected;
      k = 0;
      for (let r = 0; r < hh; r++) {
        for (let c = 0; c < w; c++, k++) {
          const G0 = gray[k]; let R1 = G0, G1 = G0, B1 = G0;
          const L = needLab ? labS[k] : 0;
          if (L && ((showCol && PAINT[L]) || L === hov || HIT[L])) {
            const edge = (c > 0 && labS[k - 1] !== L) || (c < w - 1 && labS[k + 1] !== L) || (r > 0 && labS[k - w] !== L) || (r < hh - 1 && labS[k + w] !== L);
            let cr = COL[L * 3], cg = COL[L * 3 + 1], cb = COL[L * 3 + 2], a = 0;
            if (L === hov) { a = edge ? 1 : (showCol ? Math.min(0.9, a0 + 0.22) : 0.3); if (edge) { cr = cg = cb = 255; } }
            else if (HIT[L]) { a = edge ? 1 : (showCol ? Math.min(0.9, a0 + 0.12) : 0.16); if (edge) { cr = 255; cg = 255; cb = 255; } }
            else if (showCol) a = edge ? Math.min(1, a0 + 0.38) : a0;
            if (a) { R1 = G0 + (cr - G0) * a; G1 = G0 + (cg - G0) * a; B1 = G0 + (cb - G0) * a; }
          }
          d32[k] = 0xff000000 | (B1 << 16) | (G1 << 8) | R1;
        }
      }
    }
    b.ctx.putImageData(b.img, 0, 0);
    const mmW = w * g.su, mmH = hh * g.sv, pad = this.o.mini ? 4 : 10;
    const sc = Math.min((cw - pad * 2) / mmW, (ch - pad * 2) / mmH) * this.zoom;
    const dw = mmW * sc, dh = mmH * sc, dx = (cw - dw) / 2, dy = (ch - dh) / 2;
    this.fit = { dx, dy, dw, dh, w, h: hh, g, p };
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(b.canvas, dx, dy, dw, dh);
    const d = DPR();
    if (this.o.cross) {
      const [u, v] = inPlane(vol, this.plane, this.space.cross);
      const px = dx + ((u + 0.5) / w) * dw, py = dy + ((v + 0.5) / hh) * dh, gap = 9 * d;
      ctx.strokeStyle = 'rgba(96,165,250,.8)'; ctx.lineWidth = d;
      ctx.beginPath();
      ctx.moveTo(dx, py); ctx.lineTo(px - gap, py); ctx.moveTo(px + gap, py); ctx.lineTo(dx + dw, py);
      ctx.moveTo(px, dy); ctx.lineTo(px, py - gap); ctx.moveTo(px, py + gap); ctx.lineTo(px, dy + dh);
      ctx.stroke();
    }
    ctx.font = `600 ${11 * d}px Inter, system-ui, sans-serif`; ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3 * d;
    ctx.fillStyle = 'rgba(244,183,64,.95)';
    const mx = clamp(dx, 0, cw) + 6 * d, mX = clamp(dx + dw, 0, cw) - 6 * d, my = clamp(dy, 0, ch) + 9 * d, mY = clamp(dy + dh, 0, ch) - 9 * d;
    ctx.textAlign = 'left'; ctx.fillText(g.edge[0], mx, ch / 2);
    ctx.textAlign = 'right'; ctx.fillText(g.edge[1], mX, ch / 2);
    ctx.textAlign = 'center'; ctx.fillText(g.edge[2], cw / 2, my); ctx.fillText(g.edge[3], cw / 2, mY);
    ctx.fillStyle = 'rgba(238,241,246,.92)'; ctx.font = `500 ${10.5 * d}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = 'left';
    const txt = this.o.mini ? `${PLANES[this.plane]} ${Math.round(p) + 1}/${g.count}` : `${PLANES[this.plane]}  ${Math.round(p) + 1} / ${g.count}   ${(p * g.sn).toFixed(1)} mm`;
    ctx.fillText(txt, 7 * d, ch - 9 * d);
    ctx.shadowBlur = 0;
    if (this.o.hover && this.ptr) {
      const hit = this.hit(this.ptr), id = hit ? hit.L : 0;
      if (id !== this.hoverId) { this.hoverId = id; this.dirty = true; if (id) { showTip(this.ptr.clientX, this.ptr.clientY, id, this.space === R ? 'Reference label, another body' : 'AI segmentation, not reviewed'); setHover(id); } else { tip.hidden = true; setHover(0); } }
    }
  }
  hit(e) {
    const f = this.fit; if (!f) return null;
    const rc = this.canvas.getBoundingClientRect(), d = this.canvas.width / rc.width;
    const c = ((e.clientX - rc.left) * d - f.dx) / f.dw * f.w, r = ((e.clientY - rc.top) * d - f.dy) / f.dh * f.h;
    if (c < 0 || r < 0 || c >= f.w || r >= f.h) return null;
    const ci = c | 0, ri = r | 0, vol = this.space.vol;
    const L = this.buf && this.buf.hasLab ? this.buf.lab[ri * f.w + ci] : 0;
    return { c: ci, r: ri, L, vox: voxelOf(vol, this.plane, ci, ri, Math.round(f.p)) };
  }
  onMove(e) {
    this.ptr = { clientX: e.clientX, clientY: e.clientY };
    const hit = this.hit(e), vol = this.space.vol;
    if (!hit) { if (this.hoverId) { this.hoverId = 0; this.dirty = true; } tip.hidden = true; setHover(0); return; }
    const [x, y, z] = hit.vox, [nx, ny] = vol.dims;
    const hu = vol.hu ? vol.hu[x + nx * (y + ny * z)] : null;
    $('#stPos').textContent = `${this.space === P ? 'Patient' : 'Reference'}  x ${(x * vol.sp[0]).toFixed(0)}  y ${(y * vol.sp[1]).toFixed(0)}  z ${(z * vol.sp[2]).toFixed(0)} mm${hu == null ? '' : '   ' + valueText(vol, hu)}`;
    const id = this.o.hover ? hit.L : 0;
    if (id !== this.hoverId) { this.hoverId = id; this.dirty = true; }
    if (id) { showTip(e.clientX, e.clientY, id, this.space === R ? 'Reference label, another body' : 'AI segmentation, not reviewed'); setHover(id); }
    else { tip.hidden = true; setHover(0); }
  }
  onClick(e) {
    const hit = this.hit(e); if (!hit) return;
    this.canvas.focus({ preventScroll: true });
    const g = this.fit.g, keep = this.space.cross[g.axis];
    this.space.cross = hit.vox.slice(); this.space.cross[g.axis] = keep;
    if (this.o.select && hit.L) select(hit.L, false);
    mark(this.space);
  }
  onWheel(e) {
    if (!this.fit) return;
    e.preventDefault();
    if (e.ctrlKey) { this.zoom = clamp(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.5, 8); this.dirty = true; return; }
    const g = this.fit.g, step = Math.abs(e.deltaY) >= 40 ? Math.sign(e.deltaY) : e.deltaY / 40;
    this.space.cross[g.axis] = clamp(Math.round((this.space.cross[g.axis] - step) * 4) / 4, 0, g.count - 1);
    if (Math.abs(e.deltaY) >= 40) this.space.cross[g.axis] = Math.round(this.space.cross[g.axis]);
    mark(this.space);
  }
  onKey(e) {
    if (!this.fit) return;
    const g = this.fit.g;
    if (e.key === ' ') { e.preventDefault(); togglePlay(this); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.space.cross[g.axis] = clamp(Math.round(this.space.cross[g.axis]) + (e.key === 'ArrowUp' ? 1 : -1), 0, g.count - 1); mark(this.space); }
    else if (e.key === '1' || e.key === '2' || e.key === '3') setPlane(this, ['ax', 'cor', 'sag'][Number(e.key) - 1]);
    else if ((e.key === 'c' || e.key === 'C') && this.o.overlay && this.panel) this.panel.setColour(!this.colour);
  }
}

/* ------------------------------------------------------------------ cine */
let lastT = 0, fpsN = 0, fpsT = 0;
function advance(space, dt) {
  if (!space.vol) return false;
  const sp = [0, 0, 0];
  for (const v of space.views) if (v.playing) { const a = geom(space.vol, v.plane).axis; sp[a] = Math.max(sp[a], v.speed); }
  let moved = false;
  for (let a = 0; a < 3; a++) {
    if (!sp[a]) continue;
    const max = space.vol.dims[a] - 1;
    let p = space.cross[a] + space.dir[a] * sp[a] * dt;
    if (p >= max) { p = max - (p - max); space.dir[a] = -1; }
    if (p <= 0) { p = -p; space.dir[a] = 1; }
    space.cross[a] = clamp(p, 0, max); moved = true;
  }
  if (moved) mark(space);
  return moved;
}
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  const moving = advance(P, dt) | advance(R, dt);
  for (const v of P.views) if (v.dirty) v.render();
  for (const v of R.views) if (v.dirty) v.render();
  if (CPR.dirty) CPR.render();
  if (D.ready) {
    D.tick(now, dt);
    D.controls.update();
    // The 3D view follows the cine only while the graphics card keeps up. If frames slow down, it waits for the cine to stop.
    if (moving && D.drew) { D.slow = dt > 0.03 ? D.slow + 1 : Math.max(0, D.slow - 0.25); if (D.slow > 5) D.defer = true; }
    D.drew = false;
    if (D.needs && !(moving && (D.defer || D.cost > 20))) { D.needs = false; D.drew = true; const t0 = performance.now(); D.draw(); D.cost = performance.now() - t0; }
  }
  if (moving) {
    fpsN++; fpsT += dt;
    if (fpsT >= 0.5) { $('#stCine').textContent = `Cine drawing at ${Math.round(fpsN / fpsT)} frames/s`; fpsN = 0; fpsT = 0; }
  } else if (fpsN || $('#stCine').textContent) { fpsN = 0; fpsT = 0; $('#stCine').textContent = ''; }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ panels */
const grid = $('#grid');
function panel(id, title, cap) {
  const capEl = h('span', { class: 'cap', text: cap, title: cap });
  const maxBtn = h('button', { class: 'btn icon', title: 'Enlarge or restore this panel', 'aria-label': `Enlarge panel ${id}`, html: ICON.max });
  const tools = h('div', { class: 'tools' });
  const body = h('div', { class: 'body' });
  const el = h('article', { class: 'panel', 'data-panel': id },
    h('header', {}, h('span', { class: 'tag', text: id }), h('h3', { text: title }), capEl, maxBtn), tools, body);
  maxBtn.addEventListener('click', () => {
    const on = !el.classList.contains('is-max');
    for (const p of grid.children) p.classList.remove('is-max');
    el.classList.toggle('is-max', on); grid.classList.toggle('max', on);
  });
  grid.append(el);
  const veil = h('div', { class: 'veil' }, h('div', {}, h('b', { text: 'Loading' }), h('span', {}), h('div', { class: 'bar' }, h('i'))));
  body.append(veil);
  const api = { id, el, tools, body, capEl, veil,
    setTitle(t) { el.querySelector('h3').textContent = t; }, setCap(t) { capEl.textContent = capEl.title = t; },
    wait(title2, text, frac) { veil.hidden = false; veil.querySelector('b').textContent = title2; veil.querySelector('span').textContent = text || ''; const bar = veil.querySelector('.bar'); bar.style.display = frac == null ? 'none' : ''; if (frac != null) bar.firstChild.style.width = `${Math.round(frac * 100)}%`; },
    done() { veil.hidden = true; } };
  return api;
}
function colourButton(onToggle, title) {
  const b = h('button', { class: 'btn', 'aria-pressed': 'true', title: title || 'Show or hide the colour segmentation in this view', html: `${ICON.colour}<span>Colour</span>` });
  b.addEventListener('click', () => onToggle(b.getAttribute('aria-pressed') !== 'true'));
  return b;
}
const COLOURED = [];   // every view that owns a colour toggle (B to G)
function anyColour() { return COLOURED.some((p) => p.colourOn() && !p.colourUnavailable()); }
function syncAllColour() { const on = anyColour(), b = $('#allColour'); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Hide all colour' : 'Show colour in all views'; }

function slicePanel(id, title, cap, space, o) {
  const p = panel(id, title, cap);
  const view = new SliceView(p.body, space, o); view.panel = p; p.view = view;
  p.body.append(p.veil);
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Plane' });
  for (const k of ['ax', 'cor', 'sag']) seg.append(h('button', { 'data-plane': k, text: PLANES[k], onclick: () => setPlane(view, k) }));
  const play = h('button', { class: 'btn icon', title: 'Play or pause the cine (Space)', onclick: () => togglePlay(view) });
  const speed = h('select', { 'aria-label': 'Cine speed', title: 'Cine speed in slices per second' });
  for (const s of [8, 15, 24, 30, 45, 60]) speed.append(h('option', { value: s, text: `${s} /s`, selected: s === 24 }));
  speed.addEventListener('change', () => { view.speed = Number(speed.value); if (S.linkAB && (view === UI.A.view || view === UI.B.view)) { UI.A.view.speed = UI.B.view.speed = view.speed; UI.A.sync(); UI.B.sync(); } });
  p.tools.append(seg, play, speed);
  if (o.overlay) {
    p.colourBtn = colourButton((on) => p.setColour(on));
    p.tools.append(p.colourBtn);
    p.setColour = (on) => { view.colour = on; view.dirty = true; p.sync(); syncAllColour(); };
    p.colourOn = () => view.colour;
    p.colourUnavailable = () => !!(space.vol && !space.vol.lab);
    COLOURED.push(p);
  }
  p.sync = () => {
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.plane === view.plane));
    play.innerHTML = view.playing ? ICON.pause : ICON.play; play.setAttribute('aria-label', view.playing ? 'Pause cine' : 'Play cine');
    play.setAttribute('aria-pressed', String(view.playing));
    speed.value = String(view.speed);
    if (p.colourBtn) {
      const na = p.colourUnavailable();
      p.colourBtn.disabled = na; p.colourBtn.setAttribute('aria-pressed', String(view.colour && !na));
      p.colourBtn.title = na ? 'This reference has no label set, so there is no colour to show' : 'Show or hide the colour segmentation in this view (C)';
    }
  };
  p.sync();
  return p;
}
function linked(view) { return S.linkAB && UI.A && UI.B && (view === UI.A.view || view === UI.B.view); }
function setPlane(view, plane) {
  if (view.o.mini) return;
  view.plane = plane; view.zoom = 1; view.dirty = true;
  if (linked(view)) { UI.A.view.plane = UI.B.view.plane = plane; UI.A.view.dirty = UI.B.view.dirty = true; }
  syncMini(); UI.A.sync(); UI.B.sync(); UI.C.sync();
  if (D.ready) D.updatePlane();
}
function togglePlay(view) {
  if (view.o.mini) return;
  view.playing = !view.playing;
  if (linked(view)) UI.A.view.playing = UI.B.view.playing = view.playing;
  UI.A.sync(); UI.B.sync(); UI.C.sync();
}
function syncMini() {
  if (!UI.E) return;
  const others = ['ax', 'cor', 'sag'].filter((k) => k !== UI.A.view.plane);
  UI.E.views[0].plane = others[0]; UI.E.views[1].plane = others[1];
  UI.E.views[0].dirty = UI.E.views[1].dirty = true;
}

/* ------------------------------------------------------------------ curved reformat (panel F) */
const CPR = {
  dirty: false, colour: true, vessel: 0, path: null, buf: null, fit: null, canvas: null, ctx: null, halfMm: 70, px: 0.75,
  build() {
    const vol = P.vol; this.path = null;
    if (!vol || !vol.lab || !this.vessel) return;
    const [nx, ny, nz] = vol.dims, lab = vol.lab, nxy = nx * ny, id = this.vessel, RAD = 16;
    let pts = [], px = -1, py = -1;
    for (let z = 0; z < nz; z++) {
      let x0 = 0, x1 = nx, y0 = 0, y1 = ny;
      if (px >= 0) { x0 = Math.max(0, Math.floor(px - RAD)); x1 = Math.min(nx, Math.ceil(px + RAD)); y0 = Math.max(0, Math.floor(py - RAD)); y1 = Math.min(ny, Math.ceil(py + RAD)); }
      let sx = 0, sy = 0, n = 0; const o = z * nxy;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (lab[o + y * nx + x] === id) { sx += x; sy += y; n++; }
      if (n < 5) { if (pts.length > 12) break; pts = []; px = -1; continue; }
      px = sx / n; py = sy / n; pts.push([px, py, z, n]);
    }
    if (pts.length < 12) return;
    const sm = pts.map((_, i) => {
      let ax = 0, ay = 0, c = 0;
      for (let j = Math.max(0, i - 5); j <= Math.min(pts.length - 1, i + 5); j++) { ax += pts[j][0]; ay += pts[j][1]; c++; }
      return [ax / c, ay / c, pts[i][2], pts[i][3]];
    });
    this.path = sm;
  },
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect(), d = DPR();
    this.canvas.width = Math.max(1, Math.round(r.width * d)); this.canvas.height = Math.max(1, Math.round(r.height * d)); this.dirty = true;
  },
  render() {
    // Drawn lying down: the vessel runs left (superior) to right (inferior), so it fills a wide, low panel.
    this.dirty = false;
    const cv = this.canvas, ctx = this.ctx; if (!cv) return;
    const cw = cv.width, ch = cv.height, d = DPR();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    const vol = P.vol, path = this.path;
    if (!vol || !path) { this.fit = null; return; }
    const [nx, ny] = vol.dims, [sx, , sz] = vol.sp, nxy = nx * ny, hu = vol.hu, lab = vol.lab;
    const W = path.length, H = Math.round((this.halfMm * 2) / this.px);
    if (!this.buf || this.buf.w !== W || this.buf.h !== H) {
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const c2 = canvas.getContext('2d'), img = c2.createImageData(W, H);
      this.buf = { w: W, h: H, canvas, ctx: c2, img, d32: new Uint32Array(img.data.buffer), lab: new Uint16Array(W * H) };
    }
    const b = this.buf, a0 = S.opacity, showCol = this.colour, sel = this.vessel;
    for (let c = 0; c < W; c++) {
      const pt = path[W - 1 - c], yi = clamp(Math.round(pt[1]), 0, ny - 1), o = pt[2] * nxy + yi * nx;
      for (let r = 0; r < H; r++) {
        const k = r * W + c, xf = pt[0] + ((H / 2 - 0.5 - r) * this.px) / sx;
        let G0 = 0, L = 0;
        if (xf >= 0 && xf < nx - 1) {
          const x0 = xf | 0, t = xf - x0, v = hu[o + x0] + (hu[o + x0 + 1] - hu[o + x0]) * t;
          let q = (v + 1024) | 0; q = q < 0 ? 0 : q > 4095 ? 4095 : q; G0 = GRAY[q];
          L = lab[o + (t < 0.5 ? x0 : x0 + 1)]; if (!VIS[L]) L = 0;
        }
        b.lab[k] = L;
        let R1 = G0, G1 = G0, B1 = G0;
        if (L && showCol && PAINT[L]) { const a = L === sel ? Math.min(0.9, a0 + 0.15) : a0; R1 = G0 + (COL[L * 3] - G0) * a; G1 = G0 + (COL[L * 3 + 1] - G0) * a; B1 = G0 + (COL[L * 3 + 2] - G0) * a; }
        b.d32[k] = 0xff000000 | (B1 << 16) | (G1 << 8) | R1;
      }
    }
    b.ctx.putImageData(b.img, 0, 0);
    const mmW = W * sz, mmH = H * this.px, sc = Math.min((cw - 12) / mmW, (ch - 12) / mmH);
    const dw = mmW * sc, dh = mmH * sc, dx = (cw - dw) / 2, dy = (ch - dh) / 2;
    this.fit = { dx, dy, dw, dh };
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(b.canvas, dx, dy, dw, dh);
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.setLineDash([4 * d, 5 * d]); ctx.lineWidth = d;
    ctx.beginPath(); ctx.moveTo(dx, dy + dh / 2); ctx.lineTo(dx + dw, dy + dh / 2); ctx.stroke(); ctx.setLineDash([]);
    const z = P.cross[2], top = path[W - 1][2];
    if (z >= path[0][2] && z <= top) {
      const x = dx + ((top - z + 0.5) / W) * dw;
      ctx.strokeStyle = 'rgba(96,165,250,.9)'; ctx.beginPath(); ctx.moveTo(x, dy); ctx.lineTo(x, dy + dh); ctx.stroke();
    }
    ctx.font = `600 ${11 * d}px Inter, system-ui, sans-serif`; ctx.fillStyle = 'rgba(244,183,64,.95)'; ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3 * d;
    ctx.textAlign = 'left'; ctx.fillText('S', dx + 5 * d, dy + dh / 2 - 9 * d); ctx.textAlign = 'right'; ctx.fillText('I', dx + dw - 5 * d, dy + dh / 2 - 9 * d);
    ctx.textAlign = 'center'; ctx.fillText('L', dx + dw / 2, dy + 9 * d); ctx.fillText('R', dx + dw / 2, dy + dh - 9 * d);
    ctx.shadowBlur = 0;
  },
  rowAt(e) {
    const f = this.fit; if (!f) return null;
    const rc = this.canvas.getBoundingClientRect(), d = this.canvas.width / rc.width;
    const x = (e.clientX - rc.left) * d, y = (e.clientY - rc.top) * d;
    if (x < f.dx || x > f.dx + f.dw || y < f.dy || y > f.dy + f.dh) return null;
    const W = this.path.length, c = clamp(Math.floor(((x - f.dx) / f.dw) * W), 0, W - 1), r = clamp(Math.floor(((y - f.dy) / f.dh) * this.buf.h), 0, this.buf.h - 1);
    return { pt: this.path[W - 1 - c], L: this.buf.lab[r * W + c] };
  },
};

/* ------------------------------------------------------------------ 3D anatomy (panel D, three.js) */
const D = {
  ready: false, needs: false, cost: 0, slow: 0, defer: false, drew: false, colour: true, ghost: false, plane: true, skin: true, objs: new Map(), hover: 0,
  init(host) {
    if (this.inited) return;
    this.inited = true;
    const canvas = h('canvas', { 'aria-label': '3D anatomy' }); host.prepend(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(DPR()); renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.3;
    const camera = new THREE.PerspectiveCamera(28, 1, 10, 6000);
    const key = new THREE.DirectionalLight(0xfff3e4, 2.0); key.position.set(520, 620, 300);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 1.2; key.shadow.radius = 5;
    Object.assign(key.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 100, far: 4000 });
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.7); rim.position.set(-600, 200, -500);
    camera.add(key, rim); scene.add(camera);
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a120c, 0.22));
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.12; controls.rotateSpeed = 0.9; controls.zoomSpeed = 0.9;
    controls.addEventListener('change', () => { this.needs = true; });
    const group = new THREE.Group(); scene.add(group);
    // Ambient occlusion gives the rib cage and bowel loops their depth. It is skipped if the graphics card cannot afford it.
    this.composer = null; this.ao = false;
    try {
      const { EffectComposer, RenderPass, GTAOPass, OutputPass } = window.ZKLIB;
      const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { samples: 4, type: THREE.HalfFloatType }));
      composer.addPass(new RenderPass(scene, camera));
      const gtao = new GTAOPass(scene, camera, 4, 4);
      gtao.updateGtaoMaterial({ radius: 16, distanceExponent: 1.2, thickness: 1.2, scale: 1.3, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1.5, rings: 2, samples: 16 });
      gtao.blendIntensity = 0.95;
      const inner = gtao.render.bind(gtao);
      gtao.render = (...args) => {           // the occlusion pre-pass must see solid anatomy only
        const hidden = [];
        scene.traverse((o) => { if (o.visible && o.isMesh && (o.material.transparent || o.userData.overlay)) { o.visible = false; hidden.push(o); } });
        inner(...args);
        for (const o of hidden) o.visible = true;
      };
      composer.addPass(gtao); composer.addPass(new OutputPass());
      scene.background = new THREE.Color(0x0a0d14);
      this.composer = composer; this.ao = true;
    } catch (e) { console.warn('Ambient occlusion unavailable', e); }
    Object.assign(this, { host, canvas, renderer, scene, camera, controls, group, ray: new THREE.Raycaster(), ptr: new THREE.Vector2() });
    // A software renderer cannot afford occlusion, live 3D during cine, or high-quality ray casting.
    try {
      const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      this.software = /swiftshader|llvmpipe|software|basic render/i.test(name);
      if (this.software) { this.ao = false; this.defer = true; renderer.shadowMap.enabled = false; }
    } catch (e) { this.software = false; }
    new ResizeObserver(() => this.resize()).observe(host);
    let downAt = null;
    canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointermove', (e) => { if (e.buttons) { tip.hidden = true; return; } this.pick(e, false); });
    canvas.addEventListener('pointerleave', () => { tip.hidden = true; this.setHover(0); setHover(0); });
    canvas.addEventListener('click', (e) => { if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 4) this.pick(e, true); });
    this.resize();
  },
  draw() { if (this.composer && this.ao) this.composer.render(); else this.renderer.render(this.scene, this.camera); },
  resize() {
    const r = this.host.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
    this.renderer.setPixelRatio(DPR()); this.renderer.setSize(r.width, r.height, false);
    if (this.composer) { this.composer.setPixelRatio(DPR()); this.composer.setSize(r.width, r.height); }
    this.camera.aspect = r.width / r.height; this.camera.updateProjectionMatrix(); this.needs = true;
  },
  material(id) {
    const grp = GKEY[id] || '';
    const col = new THREE.Color().setRGB(COL3[id * 3] / 255, COL3[id * 3 + 1] / 255, COL3[id * 3 + 2] / 255, THREE.SRGBColorSpace);
    const p = grp === 'skeleton' ? { roughness: 0.62, clearcoat: 0.05 } : (grp === 'arteries' || grp === 'veins') ? { roughness: 0.3, clearcoat: 0.55 }
      : grp === 'muscles' ? { roughness: 0.52, clearcoat: 0.18 } : grp === 'airway' ? { roughness: 0.6, clearcoat: 0.1 } : { roughness: 0.38, clearcoat: 0.4 };
    const m = new THREE.MeshPhysicalMaterial({ color: col, metalness: 0, clearcoatRoughness: 0.35, ...p });
    m.userData.base = col.clone();
    return m;
  },
  setVolume(vol) {
    const [nx, ny, nz] = vol.dims, [sx, sy, sz] = vol.sp;
    this.ext = [nx * sx, ny * sy, nz * sz]; this.centre = [this.ext[0] / 2, this.ext[1] / 2, this.ext[2] / 2];
    const mat = new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const mk = (w, hh) => { const g = new THREE.PlaneGeometry(w, hh); const m = new THREE.Mesh(g, mat); m.userData.overlay = true; const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x60a5fa })); m.add(e); m.renderOrder = 5; this.scene.add(m); return m; };
    this.quads = { ax: mk(this.ext[0], this.ext[1]), cor: mk(this.ext[0], this.ext[2]), sag: mk(this.ext[1], this.ext[2]) };
    this.quads.ax.rotation.x = -Math.PI / 2; this.quads.sag.rotation.y = Math.PI / 2;
    this.view('A'); this.updatePlane(); this.ready = true;
  },
  clear() {
    // Another study: every surface and the slice planes of the last one go, with their graphics memory.
    if (!this.inited) return;
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.objs.clear(); this.skinObj = null; this.hover = 0;
    if (this.quads) { for (const q of Object.values(this.quads)) { this.scene.remove(q); q.geometry.dispose(); } this.quads = null; }
    this.ready = false; this.needs = true;
  },
  toScene(x, y, z) { return [x - this.centre[0], z - this.centre[2], -(y - this.centre[1])]; },
  add(id, mesh) {
    const n = mesh.pos.length / 3, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), c = this.centre;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = mesh.pos[i * 3] - c[0]; pos[i * 3 + 1] = mesh.pos[i * 3 + 2] - c[2]; pos[i * 3 + 2] = -(mesh.pos[i * 3 + 1] - c[1]);
      nrm[i * 3] = mesh.nrm[i * 3]; nrm[i * 3 + 1] = mesh.nrm[i * 3 + 2]; nrm[i * 3 + 2] = -mesh.nrm[i * 3 + 1];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.idx, 1)); geo.computeBoundingSphere();
    let obj;
    if (id === BODY_ID) {
      obj = new THREE.Mesh(geo, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide,
        uniforms: { tint: { value: new THREE.Color(0.62, 0.72, 0.9) } },
        vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'uniform vec3 tint; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4); gl_FragColor = vec4(tint, 0.025 + 0.42 * f); }' }));
      obj.renderOrder = 10; obj.visible = this.skin; this.skinObj = obj;
    } else {
      obj = new THREE.Mesh(geo, this.material(id)); obj.userData.id = id; obj.visible = !!VIS[id]; obj.castShadow = true; obj.receiveShadow = true; this.objs.set(id, obj);
    }
    this.group.add(obj); this.needs = true;
  },
  restyle() {
    const sel = S.selected, ghost = this.ghost && sel > 0;
    for (const [id, o] of this.objs) {
      const m = o.material;
      o.visible = !!VIS[id];
      if (this.colour) m.color.copy(m.userData.base); else m.color.setRGB(0.80, 0.78, 0.73, THREE.SRGBColorSpace);
      const isSel = !!HIT[id], isHov = id === this.hover;
      m.emissive.setRGB(isSel ? 0.05 : isHov ? 0.09 : 0, isSel ? 0.16 : isHov ? 0.09 : 0, isSel ? 0.45 : isHov ? 0.09 : 0);
      const faded = ghost && !isSel;
      if (m.transparent !== faded) { m.transparent = faded; m.depthWrite = !faded; m.needsUpdate = true; }
      m.opacity = faded ? 0.1 : 1; o.renderOrder = faded ? 8 : 0; o.castShadow = !faded;
    }
    if (this.skinObj) this.skinObj.visible = this.skin;
    this.needs = true;
  },
  setHover(id) { if (id !== this.hover) { this.hover = id; this.restyle(); } },
  pick(e, click) {
    const rc = this.canvas.getBoundingClientRect();
    this.ptr.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
    const list = []; for (const o of this.objs.values()) if (o.visible && !o.material.transparent) list.push(o);
    const hit = this.ray.intersectObjects(list, false)[0], id = hit ? hit.object.userData.id : 0;
    if (click) { if (id) select(id, true); return; }
    this.setHover(id);
    if (id) { showTip(e.clientX, e.clientY, id, 'AI segmentation, not reviewed'); setHover(id); } else { tip.hidden = true; setHover(0); }
  },
  view(k) {
    const half = Math.tan((this.camera.fov * Math.PI) / 360), tall = k === 'S' || k === 'I' ? this.ext[1] : this.ext[2];
    const dist = Math.max(tall / 2 / half, this.ext[0] / 2 / (half * Math.max(0.2, this.camera.aspect))) * 1.22;
    const dirs = { A: [0, 0, 1], P: [0, 0, -1], L: [1, 0, 0], R: [-1, 0, 0], S: [0, 1, 0.001], I: [0, -1, 0.001] }[k];
    this.camera.position.set(dirs[0] * dist, dirs[1] * dist, dirs[2] * dist);
    this.camera.up.set(0, 1, 0); if (k === 'S') this.camera.up.set(0, 0, -1); if (k === 'I') this.camera.up.set(0, 0, 1);
    this.controls.target.set(0, 0, 0); this.camera.lookAt(0, 0, 0); this.controls.update(); this.needs = true;
  },
  updatePlane() {
    if (!this.quads) return;
    const pl = UI.A.view.plane, vol = P.vol, c = P.cross;
    for (const k of ['ax', 'cor', 'sag']) this.quads[k].visible = this.plane && k === pl;
    const s = this.toScene(c[0] * vol.sp[0], c[1] * vol.sp[1], c[2] * vol.sp[2]);
    this.quads.ax.position.set(0, s[1], 0); this.quads.cor.position.set(0, 0, s[2]); this.quads.sag.position.set(s[0], 0, 0);
    this.needs = true;
  },
};

/* ------------------------------------------------------------------ volume rendering (panel G, vtk.js) */
const VR = {
  bone: { name: 'Bone', op: [[-1024, 0], [150, 0], [300, 0.45], [800, 0.85], [3071, 0.9]], col: [[-1024, 0, 0, 0], [150, 0.55, 0.3, 0.2], [300, 0.93, 0.8, 0.6], [900, 1, 0.96, 0.88], [3071, 1, 1, 1]] },
  vessels: { name: 'Vessels and bone', op: [[-1024, 0], [110, 0], [170, 0.3], [260, 0.62], [600, 0.85], [3071, 0.9]], col: [[-1024, 0, 0, 0], [110, 0.5, 0.14, 0.1], [180, 0.84, 0.26, 0.18], [300, 0.95, 0.76, 0.56], [700, 1, 0.96, 0.9], [3071, 1, 1, 1]] },
  muscle: { name: 'Muscle and bone', op: [[-1024, 0], [-20, 0], [40, 0.12], [120, 0.3], [300, 0.7], [3071, 0.9]], col: [[-1024, 0, 0, 0], [-20, 0.45, 0.16, 0.12], [60, 0.72, 0.28, 0.2], [200, 0.92, 0.66, 0.5], [500, 1, 0.95, 0.88], [3071, 1, 1, 1]] },
  skin: { name: 'Skin', op: [[-1024, 0], [-520, 0], [-300, 0.5], [0, 0.85], [3071, 0.95]], col: [[-1024, 0, 0, 0], [-520, 0.6, 0.38, 0.3], [-250, 0.9, 0.68, 0.56], [100, 0.95, 0.76, 0.66], [600, 1, 0.96, 0.9], [3071, 1, 1, 1]] },
  lungs: { name: 'Lungs and airways', op: [[-1024, 0], [-980, 0], [-900, 0.12], [-700, 0.2], [-500, 0.04], [-300, 0], [200, 0], [400, 0.5], [3071, 0.8]], col: [[-1024, 0.2, 0.5, 0.8], [-850, 0.45, 0.72, 0.95], [-600, 0.85, 0.6, 0.6], [200, 0.9, 0.8, 0.62], [3071, 1, 1, 1]] },
};
// MR has no unit: values are scaled so that 0 .. the 99.5th percentile spans 2000 steps above -1024.
const VR_MR = {
  tissue: { name: 'Soft tissue', op: [[-1024, 0], [-820, 0], [-560, 0.07], [0, 0.3], [800, 0.6], [3071, 0.8]], col: [[-1024, 0, 0, 0], [-700, 0.35, 0.2, 0.16], [-200, 0.72, 0.5, 0.4], [400, 0.92, 0.8, 0.7], [1200, 1, 0.97, 0.92], [3071, 1, 1, 1]] },
  bright: { name: 'Bright signal', op: [[-1024, 0], [0, 0], [400, 0.25], [1000, 0.7], [3071, 0.9]], col: [[-1024, 0, 0, 0], [0, 0.5, 0.2, 0.15], [600, 0.95, 0.75, 0.5], [1400, 1, 0.97, 0.9], [3071, 1, 1, 1]] },
  surface: { name: 'Body surface', op: [[-1024, 0], [-900, 0], [-780, 0.6], [3071, 0.95]], col: [[-1024, 0, 0, 0], [-900, 0.6, 0.4, 0.32], [-400, 0.9, 0.7, 0.58], [600, 0.96, 0.82, 0.72], [3071, 1, 1, 1]] },
};
const G = {
  table: VR,
  dispose() {
    // The size observer of the last study must go first: left attached, it fires on the emptied host and draws into the deleted window.
    if (this.sizeObs) { this.sizeObs.disconnect(); this.sizeObs = null; }
    if (this.grw) { try { this.grw.delete(); } catch (e) { /* already gone */ } }
    this.actors.clear(); this.grw = null; this.ready = false;
    if (this.host) this.host.replaceChildren();
  },
  ready: false, colour: false, preset: 'vessels', actors: new Map(), quality: 'high',
  init(host, vol) {
    const grw = vtk.vtkGenericRenderWindow.newInstance({ background: [0.015, 0.02, 0.035], listenWindowResize: false });
    grw.setContainer(host); grw.resize();
    const ren = grw.getRenderer(), rw = grw.getRenderWindow();
    const [nx, ny, nz] = vol.dims, [sx, sy, sz] = vol.sp;
    const img = vtk.vtkImageData.newInstance(); img.setDimensions(nx, ny, nz); img.setSpacing(sx, sy, sz); img.setOrigin(0, 0, 0);
    img.getPointData().setScalars(vtk.vtkDataArray.newInstance({ name: 'HU', numberOfComponents: 1, values: vol.hu }));
    const mapper = vtk.vtkVolumeMapper.newInstance(); mapper.setInputData(img); mapper.setSampleDistance(0.8); mapper.setMaximumSamplesPerRay(3000);
    const actor = vtk.vtkVolume.newInstance(); actor.setMapper(mapper);
    const ctf = vtk.vtkColorTransferFunction.newInstance(), pwf = vtk.vtkPiecewiseFunction.newInstance(), prop = actor.getProperty();
    prop.setRGBTransferFunction(0, ctf); prop.setScalarOpacity(0, pwf); prop.setInterpolationTypeToLinear();
    prop.setShade(true); prop.setScalarOpacityUnitDistance(0, 1.6);
    const cut = vtk.vtkPlane.newInstance({ origin: [0, 0, 0], normal: [0, 1, 0] }); mapper.addClippingPlane(cut);
    ren.addVolume(actor);
    const cam = ren.getActiveCamera(), c = [(nx * sx) / 2, (ny * sy) / 2, (nz * sz) / 2];
    cam.setFocalPoint(...c); cam.setPosition(c[0], c[1] - 1500, c[2]); cam.setViewUp(0, 0, 1); ren.resetCamera(); cam.zoom(1.2); ren.resetCameraClippingRange();
    Object.assign(this, { host, grw, ren, rw, mapper, actor, prop, ctf, pwf, cut, ext: [nx * sx, ny * sy, nz * sz] });
    this.applyQuality(); this.applyPreset(this.preset, false);
    this.sizeObs = new ResizeObserver(() => { if (this.grw !== grw) return; const r = host.getBoundingClientRect(); if (r.width > 2 && r.height > 2) { grw.resize(); rw.render(); } }); this.sizeObs.observe(host);
    const t0 = performance.now(); rw.render(); const first = performance.now() - t0;
    this.ready = true;
    return first;
  },
  applyQuality() {
    const hi = this.quality === 'high', p = this.prop;
    p.setAmbient(hi ? 0.32 : 0.22); p.setDiffuse(0.78); p.setSpecular(0.28); p.setSpecularPower(14);
    try { p.setLocalAmbientOcclusion(hi); if (hi) { p.setLAOKernelSize(8); p.setLAOKernelRadius(5); } } catch (e) { /* older builds have no ambient occlusion */ }
    this.mapper.setSampleDistance(hi ? 0.8 : this.quality === 'fast' ? 2.4 : 1.2);
  },
  applyPreset(k, render = true) {
    const p = this.table[k]; this.preset = k;
    this.ctf.removeAllPoints(); for (const [x, r, g, b] of p.col) this.ctf.addRGBPoint(x, r, g, b);
    this.pwf.removeAllPoints(); for (const [x, a] of p.op) this.pwf.addPoint(x, a);
    if (render) this.rw.render();
  },
  setCut(mm) { this.cut.setOrigin(0, mm, 0); this.rw.render(); },
  view(k) {
    const cam = this.ren.getActiveCamera(), e = this.ext, c = [e[0] / 2, e[1] / 2, e[2] / 2];
    const dir = { A: [0, -1, 0], P: [0, 1, 0], L: [1, 0, 0], R: [-1, 0, 0] }[k];
    cam.setFocalPoint(...c); cam.setPosition(c[0] + dir[0] * 1500, c[1] + dir[1] * 1500, c[2]); cam.setViewUp(0, 0, 1);
    this.ren.resetCamera(); cam.zoom(1.2); this.ren.resetCameraClippingRange(); this.rw.render();
  },
  syncActors() {
    if (!this.ready) return;
    if (this.colour) {
      for (const [id, m] of MESH) {
        if (id === BODY_ID || (this.table === VR && GKEY[id] === 'skeleton') || this.actors.has(id)) continue;
        const pd = vtk.vtkPolyData.newInstance();
        pd.getPoints().setData(m.pos, 3);
        const n = m.idx.length / 3, cells = new Uint32Array(n * 4);
        for (let i = 0; i < n; i++) { cells[i * 4] = 3; cells[i * 4 + 1] = m.idx[i * 3]; cells[i * 4 + 2] = m.idx[i * 3 + 1]; cells[i * 4 + 3] = m.idx[i * 3 + 2]; }
        pd.getPolys().setData(cells);
        pd.getPointData().setNormals(vtk.vtkDataArray.newInstance({ name: 'Normals', numberOfComponents: 3, values: m.nrm }));
        const mp = vtk.vtkMapper.newInstance(); mp.setInputData(pd); mp.setScalarVisibility(false); mp.addClippingPlane(this.cut);
        const a = vtk.vtkActor.newInstance(); a.setMapper(mp);
        const pr = a.getProperty(); pr.setColor(COL3[id * 3] / 255, COL3[id * 3 + 1] / 255, COL3[id * 3 + 2] / 255);
        pr.setAmbient(0.18); pr.setDiffuse(0.82); pr.setSpecular(0.35); pr.setSpecularPower(24);
        this.ren.addActor(a); this.actors.set(id, a);
      }
    }
    for (const [id, a] of this.actors) a.setVisibility(this.colour && !!VIS[id]);
    this.rw.render();
  },
};

/* ------------------------------------------------------------------ 3D: smooth motion, explode and labels (panels D and G)
   One rule for both panels: while the view moves it is drawn cheaply and the cost adapts to the measured frame time; when it stops,
   one full-quality frame is drawn, then an ID pass records which structure is visible at every pixel. Hover, click, outlines and
   label anchors read that buffer, so pointing at a structure never redraws the 3D scene. */

const ID = { rt: null, mats: new Map() };
function idMaterial(id) {
  let m = ID.mats.get(id);
  if (!m) {
    // Exact bytes: no lighting, no tone mapping, no colour conversion. Blue = 1 marks "a structure is here".
    m = new THREE.ShaderMaterial({
      uniforms: { c: { value: new THREE.Vector3((id & 255) / 255, (id >> 8) / 255, 1 / 255) } },
      vertexShader: '#include <clipping_planes_pars_vertex>\nvoid main(){ vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;\n#include <clipping_planes_vertex>\n}',
      fragmentShader: 'uniform vec3 c;\n#include <clipping_planes_pars_fragment>\nvoid main(){\n#include <clipping_planes_fragment>\ngl_FragColor = vec4(c, 1.0); }',
      side: THREE.DoubleSide, clipping: true,
    });
    ID.mats.set(id, m);
  }
  return m;
}
// Renders the surfaces of panel D's scene with one flat colour per structure and reads them back.
// include(id, obj) chooses the structures, offset(id) moves them (exploded views), clip is an optional clipping plane.
// within(result, hitAt) runs before the scene is restored; hitAt(id, px, py) gives the 3-D surface point under that pixel.
function idPass(camera, w, h, include, offset, clip, within) {
  const r = D.renderer, sc = D.scene;
  w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
  if (!ID.rt || ID.rt.width !== w || ID.rt.height !== h) { if (ID.rt) ID.rt.dispose(); ID.rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true }); }
  const saved = [];
  for (const [id, o] of D.objs) {
    saved.push([o, o.material, o.visible, o.position.x, o.position.y, o.position.z]);
    const on = include(id, o); o.visible = on;
    if (!on) continue;
    const m = idMaterial(id); m.clippingPlanes = clip ? [clip] : null; o.material = m;
    if (offset) { const v = offset(id); o.position.set(v ? v[0] : 0, v ? v[1] : 0, v ? v[2] : 0); }
  }
  // Anything that is not a structure (the translucent body outline, the slice planes) would blend over the ID colours: hidden for the pass.
  const others = [], mine = new Set(D.objs.values());
  for (const o of sc.children) if (o !== D.group && o !== D.camera && o !== camera && o.visible) { o.visible = false; others.push(o); }
  for (const o of D.group.children) if (!mine.has(o) && o.visible) { o.visible = false; others.push(o); }
  const bg = sc.background, prevRT = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(), sm = r.shadowMap.autoUpdate;
  sc.background = null; r.shadowMap.autoUpdate = false; r.localClippingEnabled = true;
  const px = new Uint8Array(w * h * 4);
  let result = null;
  try {
    r.setRenderTarget(ID.rt); r.setClearColor(0x000000, 0); r.clear(); r.render(sc, camera);
    r.readRenderTargetPixels(ID.rt, 0, 0, w, h, px);
    const n = VIS.length, ids = new Uint16Array(w * h), cnt = new Uint32Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4, dst = y * w;
      for (let x = 0; x < w; x++) {
        const k = src + x * 4;
        if (px[k + 2] !== 1 || px[k + 3] !== 255) continue;
        const id = px[k] | (px[k + 1] << 8); if (id >= n) continue;
        ids[dst + x] = id; cnt[id]++; sx[id] += x; sy[id] += y;
      }
    }
    // The anchor of a structure is its visible pixel nearest the centre of its visible area: always on the structure, never beside it.
    const best = new Int32Array(n).fill(-1), bd = new Float64Array(n).fill(Infinity);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]; if (!id) continue;
      const x = i % w, y = (i / w) | 0, dx = x - sx[id] / cnt[id], dy = y - sy[id] / cnt[id], d = dx * dx + dy * dy;
      if (d < bd[id]) { bd[id] = d; best[id] = i; }
    }
    result = { w, h, ids, cnt, best };
    const ray = new THREE.Raycaster(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    const hitAt = (id, x, y) => {
      const o = D.objs.get(id); if (!o) return null;
      const nx = ((x + 0.5) / w) * 2 - 1, ny = -(((y + 0.5) / h) * 2 - 1);
      p0.set(nx, ny, -1).applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld);
      p1.set(nx, ny, 1).applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld);
      ray.set(p0, p1.sub(p0).normalize());
      const hit = ray.intersectObject(o, false)[0];
      return hit ? hit.point.clone() : null;
    };
    if (within) within(result, hitAt);
  } finally {
    r.setRenderTarget(prevRT); r.setClearColor(cc, ca); r.shadowMap.autoUpdate = sm; sc.background = bg;
    for (const [o, m, v, x, y, z] of saved) { o.material = m; o.visible = v; o.position.set(x, y, z); }
    for (const o of others) o.visible = true;
  }
  return result;
}

/* ---- explode: one set of displacement vectors per study and mode, in patient millimetres, shared by D and G */
const EXPLODE = { key: '', vec: new Map() };
const EXPLODE_TEXT = { body: 'Whole body', parts: 'Within each organ' };
function explodeVectors(mode) {
  const key = `${S.open}:${mode}`;
  if (EXPLODE.key === key) return EXPLODE.vec;
  const vol = P.vol, vec = new Map(); EXPLODE.key = key; EXPLODE.vec = vec;
  if (!vol || !vol.lab) return vec;
  const { sum, cnt } = anchors(vol), [sx, sy, sz] = vol.sp;
  const centre = (ids) => { let x = 0, y = 0, z = 0, c = 0; for (const k of ids) { c += cnt[k]; x += sum[k * 3]; y += sum[k * 3 + 1]; z += sum[k * 3 + 2]; } return c ? [(x / c) * sx, (y / c) * sy, (z / c) * sz] : null; };
  const own = [...S.present].filter((id) => !ENTRY[id].region);
  const body = centre(own);
  for (const id of own) {
    const c = centre([id]); if (!c) continue;
    let from = body, gain = 0.9, push = 35;
    if (mode === 'parts') {
      const p = PARENT[id];
      if (!p || !S.rows.has(p)) { vec.set(id, [0, 0, 0]); continue; }
      from = centre([p, ...descendants(p)].filter((k) => S.present.has(k))) || c; gain = 1.3; push = 20;
    }
    const d = [c[0] - from[0], c[1] - from[1], c[2] - from[2]], len = Math.hypot(d[0], d[1], d[2]) || 1;
    vec.set(id, [d[0] * gain + (d[0] / len) * push, d[1] * gain + (d[1] / len) * push, d[2] * gain + (d[2] / len) * push]);
  }
  return vec;
}
const toThreeVec = (v, f) => [v[0] * f, v[2] * f, -v[1] * f];           // patient mm (x left, y posterior, z superior) -> panel D's scene

/* ---- labels: names in two columns at the panel edges, each joined by a leader line to a visible point of its structure */
const SVGNS = 'http://www.w3.org/2000/svg';
let MEASURE = null;
function textWidth(t) {
  if (!MEASURE) { MEASURE = document.createElement('canvas').getContext('2d'); MEASURE.font = `500 11px ${getComputedStyle(document.body).getPropertyValue('--font-ui')}`; }
  return MEASURE.measureText(t).width;
}
class Labels {
  constructor(body, panelKey) {
    this.panelKey = panelKey; this.mode = 'fit'; this.items = [];
    this.layer = h('div', { class: 'lbl-layer', 'aria-hidden': 'false' });
    this.outline = h('canvas', { class: 'lbl-outline' });
    this.svg = document.createElementNS(SVGNS, 'svg'); this.svg.setAttribute('class', 'lbl-lines');
    this.layer.append(this.outline, this.svg); body.append(this.layer);
  }
  clear() { this.items = []; this.svg.replaceChildren(); for (const el of [...this.layer.querySelectorAll('.lbl')]) el.remove(); this.clearOutline(); }
  clearOutline() { const c = this.outline; if (c.width) c.getContext('2d').clearRect(0, 0, c.width, c.height); }
  // cands: [{ id, x, y, p (3-D point), weight }]. Pinned (selected) structures first, then the largest visible ones, as many as fit.
  set(cands, W, H) {
    this.clear(); if (this.mode === 'off' || !cands.length) return;
    const top = 32, bottom = H - 6, lh = 15, cap = Math.max(1, Math.floor((bottom - top) / lh)), maxW = Math.max(60, W * 0.3);
    cands.sort((a, b) => (HIT[b.id] - HIT[a.id]) || (b.weight - a.weight));
    const side = { L: [], R: [] };
    for (const c of cands) {
      if (this.mode === 'sel' && !HIT[c.id]) continue;
      const pref = c.x < W / 2 ? 'L' : 'R', alt = pref === 'L' ? 'R' : 'L';
      const s = side[pref].length < cap ? pref : side[alt].length < cap ? alt : null;
      if (s) side[s].push(c);
      if (side.L.length >= cap && side.R.length >= cap) break;
    }
    for (const s of ['L', 'R']) {
      const list = side[s].sort((a, b) => a.y - b.y);
      for (let i = 0; i < list.length; i++) list[i].ly = Math.min(Math.max(list[i].y, top + lh / 2), bottom - lh / 2);
      for (let i = 1; i < list.length; i++) list[i].ly = Math.max(list[i].ly, list[i - 1].ly + lh);
      for (let i = list.length - 1; i >= 0; i--) { const lim = i === list.length - 1 ? bottom - lh / 2 : list[i + 1].ly - lh; list[i].ly = Math.min(list[i].ly, lim); }
      for (const c of list) {
        const t = term(c.id), name = t.text, w = Math.min(maxW, textWidth(name) + (t.missing ? 18 : 0) + 6);
        const el = h('button', { class: 'lbl', dir: 'auto', title: [name, ENTRY[c.id].en !== name ? ENTRY[c.id].en : null, 'AI segmentation, not reviewed'].filter(Boolean).join(' · '),
          style: `top:${c.ly - lh / 2}px;${s === 'L' ? `left:6px` : `right:6px`};max-width:${maxW}px` },
          h('span', { class: 'sw', style: `background:rgb(${COL3[c.id * 3]},${COL3[c.id * 3 + 1]},${COL3[c.id * 3 + 2]})` }), h('span', { class: 'tx', text: name }), t.missing ? h('span', { class: 'en', text: 'EN' }) : null);
        el.addEventListener('click', () => select(c.id, true));
        el.addEventListener('pointerenter', () => { setHover(c.id); this.onHover && this.onHover(c.id); });
        el.addEventListener('pointerleave', () => { setHover(0); this.onHover && this.onHover(0); });
        this.layer.append(el);
        const line = document.createElementNS(SVGNS, 'polyline'), dot = document.createElementNS(SVGNS, 'circle');
        dot.setAttribute('r', '2.6'); dot.setAttribute('fill', `rgb(${COL3[c.id * 3]},${COL3[c.id * 3 + 1]},${COL3[c.id * 3 + 2]})`);
        this.svg.append(line, dot);
        this.items.push({ ...c, side: s, ex: s === 'L' ? 6 + w + 2 : W - 6 - w - 2, el, line, dot });
      }
    }
    this.restyle(); this.draw();
  }
  draw() {
    for (const it of this.items) {
      const ok = it.x != null && Number.isFinite(it.x);
      it.line.style.display = it.dot.style.display = ok ? '' : 'none'; if (!ok) continue;
      const stub = it.side === 'L' ? it.ex + 8 : it.ex - 8;
      it.line.setAttribute('points', `${it.ex},${it.ly} ${stub},${it.ly} ${it.x},${it.y}`);
      it.dot.setAttribute('cx', it.x); it.dot.setAttribute('cy', it.y);
    }
  }
  // While the view moves the names stay where they are and the leader lines follow their points.
  move(project) { for (const it of this.items) { const s = it.p ? project(it) : null; it.x = s ? s[0] : NaN; it.y = s ? s[1] : NaN; } this.draw(); }
  restyle(hover = 0) {
    for (const it of this.items) { it.el.dataset.sel = String(!!HIT[it.id]); it.el.dataset.hover = String(it.id === hover); it.line.dataset.sel = String(!!HIT[it.id] || it.id === hover); }
  }
  // Outlines the hovered structure (white) and the selected one (blue) from the ID buffer: no 3-D redraw.
  drawOutline(map, hover) {
    const c = this.outline;
    if (!map) { this.clearOutline(); return; }
    if (c.width !== map.w || c.height !== map.h) { c.width = map.w; c.height = map.h; }
    const g = c.getContext('2d'), img = g.createImageData(map.w, map.h), d = img.data, ids = map.ids, w = map.w, h = map.h;
    let any = false;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, id = ids[i]; if (!id || !(id === hover || HIT[id])) continue;
      if (ids[i - 1] === id && ids[i + 1] === id && ids[i - w] === id && ids[i + w] === id) continue;
      const k = i * 4; any = true;
      if (id === hover) { d[k] = 255; d[k + 1] = 255; d[k + 2] = 255; d[k + 3] = 255; } else { d[k] = 96; d[k + 1] = 165; d[k + 2] = 250; d[k + 3] = 255; }
    }
    g.putImageData(img, 0, 0); if (!any) g.clearRect(0, 0, w, h);
  }
}
// Only the structures that will actually get a name are raycast for their 3-D point.
function labelCandidatesLazy(map, include) {
  const out = [];
  for (let id = 1; id < map.cnt.length; id++) { const n = map.cnt[id]; if (n && (n >= 30 || HIT[id]) && include(id)) { const b = map.best[id]; out.push({ id, px: b % map.w, py: (b / map.w) | 0, weight: n }); } }
  return out;
}

/* ---- panel D (three.js) */
Object.assign(D, {
  lastMotion: -1e9, inMotion: false, scale: 1, ema: 16, prevDraw: 0, settle: 0, triBudget: Infinity, cut: new Set(), order: [],
  ex: { cur: 0, target: 0, mode: 'body', anim: false, baseDist: 0 }, idMap: null, idFresh: false, hoverId: 0, restToken: 0, labels: null,
});
{
  const init0 = D.init, draw0 = D.draw, clear0 = D.clear, restyle0 = D.restyle, plane0 = D.updatePlane, resize0 = D.resize, add0 = D.add, view0 = D.view;
  D.init = function (host) {
    const first = !this.inited; init0.call(this, host);
    if (!first) return;
    this.scale = this.software ? 0.5 : 1;
    this.controls.addEventListener('change', () => { this.lastMotion = performance.now(); });
    this.labels = new Labels(host, 'D');
    this.labels.onHover = (id) => { this.hoverId = id; this.labels.drawOutline(this.idFresh ? this.idMap : null, id); this.labels.restyle(id); };
    // Hover and click go through D.pick (replaced below): it reads the ID buffer, so pointing never redraws the scene.
    this.renderer.localClippingEnabled = true;
    // Leaving the panel clears the hover outline as well as the name.
    this.canvas.addEventListener('pointerleave', () => this.setHover3(0));
  };
  D.idAt = function (e) {
    const rc = this.canvas.getBoundingClientRect();
    if (this.idFresh && this.idMap) {
      const m = this.idMap, x = Math.floor(((e.clientX - rc.left) / rc.width) * m.w), y = Math.floor(((e.clientY - rc.top) / rc.height) * m.h);
      return x >= 0 && y >= 0 && x < m.w && y < m.h ? m.ids[y * m.w + x] : 0;
    }
    this.ptr.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
    const list = []; for (const o of this.objs.values()) if (o.visible && !o.material.transparent) list.push(o);
    const hit = this.ray.intersectObjects(list, false)[0];
    return hit ? hit.object.userData.id : 0;
  };
  D.setHover3 = function (id) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    if (this.idFresh) this.labels.drawOutline(this.idMap, id);
    this.labels.restyle(id);
  };
  D.pick = function (e, click) { const id = this.idAt(e); if (click) { if (id) select(id, true); return; } this.setHover3(id); if (id) { showTip(e.clientX, e.clientY, id, 'AI segmentation, not reviewed'); setHover(id); } else { tip.hidden = true; setHover(0); } };
  // Called every animation frame by the main loop, before the scene is drawn.
  D.tick = function (now, dt) {
    const ex = this.ex;
    if (ex.anim) {
      const k = 1 - Math.exp(-dt * 9);
      ex.cur += (ex.target - ex.cur) * k;
      if (Math.abs(ex.target - ex.cur) < 0.002) { ex.cur = ex.target; ex.anim = false; }
      this.applyExplode(); this.lastMotion = now; this.needs = true;
      if (ex.dist) { const c = this.controls, dir = this.camera.position.clone().sub(c.target), d = dir.length(); const nd = d + (ex.dist - d) * k; this.camera.position.copy(c.target).add(dir.multiplyScalar(nd / d)); }
    }
    if (this.inMotion && now - this.lastMotion > 150) this.needs = true;      // the full-quality frame after the view stops
  };
  D.applyScale = function (s) {
    const pr = DPR() * s; if (Math.abs(this.renderer.getPixelRatio() - pr) < 0.01) return;
    const r = this.host.getBoundingClientRect(); this.renderer.setPixelRatio(pr); this.renderer.setSize(r.width, r.height, false);
  };
  // Keeps a moving view near 30 frames a second: first by drawing fewer pixels, then, if still slow, by leaving the smallest structures
  // out until the view stops. Both are restored for the still frame.
  D.adapt = function (now) {
    const dt = now - this.prevDraw; this.prevDraw = now;
    if (dt > 0 && dt < 400) this.ema = this.ema * 0.7 + dt * 0.3;
    if (++this.settle < 3) return; this.settle = 0;
    if (this.ema > 40) {
      if (this.scale > 0.36) { this.scale = Math.max(0.35, this.scale * 0.8); this.applyScale(this.scale); }
      else { let vis = 0; for (const o of this.objs.values()) if (o.visible) vis += o.geometry.index.count / 3; this.triBudget = Math.max(20000, vis * 0.6); this.applyDetail(); }
    } else if (this.ema < 22) {
      if (this.triBudget < Infinity) { this.triBudget *= 1.3; if (this.triBudget > 3e7) this.triBudget = Infinity; this.applyDetail(); }
      else if (this.scale < 1) { this.scale = Math.min(1, this.scale * 1.12); this.applyScale(this.scale); }
    }
  };
  D.applyDetail = function () {
    for (const o of this.cut) o.visible = true; this.cut.clear();
    if (this.triBudget === Infinity) return;
    if (!this.order.length) this.order = [...this.objs.values()].sort((a, b) => b.geometry.boundingSphere.radius - a.geometry.boundingSphere.radius);
    let used = 0;
    for (const o of this.order) { if (!o.visible) continue; const t = o.geometry.index.count / 3; if (used + t > this.triBudget) { o.visible = false; this.cut.add(o); } else used += t; }
  };
  D.draw = function () {
    // Moving means the camera changed since the last frame drawn, whatever that frame cost: on a slow computer frames are far apart, and
    // a clock-only test would call every one of them still and draw them all at full detail.
    this.camera.updateMatrixWorld();
    const now = performance.now(), m = this.camera.matrixWorld.elements, prev = this.lastCam || (this.lastCam = new Float64Array(16));
    let changed = false; for (let i = 0; i < 16; i++) if (Math.abs(m[i] - prev[i]) > 1e-7) { changed = true; break; }
    if (changed) { prev.set(m); this.lastMotion = now; }
    const moving = changed || now - this.lastMotion < 150 || this.ex.anim;
    if (moving) {
      if (!this.inMotion) {
        this.inMotion = true; this.idFresh = false; this.prevDraw = 0; this.settle = 0;
        this.labels.clearOutline(); this.renderer.shadowMap.autoUpdate = false; this.useLight(true); this.applyScale(this.scale); this.applyDetail(); tip.hidden = true;
      }
      this.adapt(now);
      this.renderer.render(this.scene, this.camera);
      this.moveLabels();
      return;
    }
    if (this.inMotion) {
      this.inMotion = false; this.useLight(false); for (const o of this.cut) o.visible = true; this.cut.clear();
      this.applyScale(1); this.renderer.shadowMap.autoUpdate = true; this.renderer.shadowMap.needsUpdate = true;
    }
    draw0.call(this);
    this.scheduleRest();
  };
  D.scheduleRest = function () {
    const token = ++this.restToken;
    setTimeout(() => { if (token === this.restToken && !this.inMotion && this.ready) this.rest(); }, 40);
  };
  D.moveLabels = function () {
    if (!this.labels.items.length) return;
    const r = this.host.getBoundingClientRect(), v = new THREE.Vector3(), cur = this.ex.cur;
    this.labels.move((it) => {
      const off = toThreeVec(explodeVectors(this.ex.mode).get(it.id) || [0, 0, 0], cur - it.f);
      v.set(it.p.x + off[0], it.p.y + off[1], it.p.z + off[2]).project(this.camera);
      return v.z > 1 ? null : [((v.x + 1) / 2) * r.width, ((1 - v.y) / 2) * r.height];
    });
  };
  // The view is still: record the visible structures, place the names, outline hover and selection.
  D.rest = function () {
    if (!this.objs.size) { this.labels.clear(); this.idFresh = false; return; }
    const r = this.host.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return;
    const w = Math.min(r.width, 1200), h = Math.round((r.height * w) / r.width), f = this.ex.cur;
    idPass(this.camera, w, h, (id, o) => o.visible && !o.material.transparent, null, null, (map, hitAt) => {
      map.sx = r.width / w; map.sy = r.height / h;
      this.idMap = map; this.idFresh = true;          // names appear only under the pointer (hover), read from this buffer
    });
    this.labels.drawOutline(this.idMap, this.hoverId); this.labels.restyle(this.hoverId);
  };
  D.clear = function () {
    // Both versions of every surface leave the graphics card: the one in use is freed by clear0, the other here.
    if (this.inited) for (const o of [...this.objs.values(), this.skinObj]) { if (!o) continue; for (const g of [o.userData.light, o.userData.full]) if (g && g !== o.geometry) g.dispose(); }
    this.lightCount = 0;
    clear0.call(this);
    if (!this.inited) return;
    this.cut.clear(); this.order = []; this.idFresh = false; this.idMap = null; this.hoverId = 0; this.triBudget = Infinity;
    this.ex.cur = 0; this.ex.target = 0; this.ex.anim = false; this.ex.dist = 0; this.ex.baseDist = 0; EXPLODE.key = '';
    if (this.labels) this.labels.clear();
    if (UI.D && UI.D.exRange) { UI.D.exRange.value = 0; UI.D.syncExplode(); }
  };
  D.add = function (id, mesh) { add0.call(this, id, mesh); this.order = []; const o = id === BODY_ID ? this.skinObj : this.objs.get(id); if (o) o.userData.full = o.geometry; };
  // Same structures and ids as the full surfaces, about a ninth of the triangles, in the same scene coordinates.
  D.addLight = function (lo) {
    const c = this.centre; let n = 0;
    for (const [id, m] of lo) {
      const o = id === BODY_ID ? this.skinObj : this.objs.get(id); if (!o) continue;
      const k = m.pos.length / 3, pos = new Float32Array(k * 3), nrm = new Float32Array(k * 3);
      for (let i = 0; i < k; i++) {
        pos[i * 3] = m.pos[i * 3] - c[0]; pos[i * 3 + 1] = m.pos[i * 3 + 2] - c[2]; pos[i * 3 + 2] = -(m.pos[i * 3 + 1] - c[1]);
        nrm[i * 3] = m.nrm[i * 3]; nrm[i * 3 + 1] = m.nrm[i * 3 + 2]; nrm[i * 3 + 2] = -m.nrm[i * 3 + 1];
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setIndex(new THREE.BufferAttribute(m.idx, 1)); g.boundingSphere = o.userData.full.boundingSphere;   // same extent: explode fitting is unchanged
      o.userData.light = g; n++;
      if (this.inMotion) o.geometry = g;
    }
    this.lightCount = n;
  };
  D.useLight = function (on) {
    for (const o of [...this.objs.values(), this.skinObj]) { if (!o || !o.userData.light) continue; const g = on ? o.userData.light : o.userData.full; if (o.geometry !== g) o.geometry = g; }
  };
  D.resize = function () { resize0.call(this); this.idFresh = false; if (this.labels) this.labels.clear(); };
  D.restyle = function () {
    restyle0.call(this);
    if (this.ex.cur > 0.01 && this.skinObj) this.skinObj.visible = false;
    for (const o of this.cut) o.visible = false;
  };
  D.updatePlane = function () { plane0.call(this); if (this.quads && this.ex.cur > 0.01) for (const q of Object.values(this.quads)) q.visible = false; };
  D.view = function (k) {
    view0.call(this, k);
    if (this.ex.cur > 0.01) { this.fitExplode(this.ex.cur); const c = this.controls, dir = this.camera.position.clone().sub(c.target).normalize(); this.camera.position.copy(c.target).add(dir.multiplyScalar(this.ex.dist)); c.update(); }
  };
  D.applyExplode = function () {
    const vec = explodeVectors(this.ex.mode), f = this.ex.cur;
    for (const [id, o] of this.objs) { const v = vec.get(id); if (v) { const t = toThreeVec(v, f); o.position.set(t[0], t[1], t[2]); } else o.position.set(0, 0, 0); }
    const on = f > 0.01;
    if (this.skinObj) this.skinObj.visible = !on && this.skin;
    if (this.quads) { if (on) for (const q of Object.values(this.quads)) q.visible = false; else plane0.call(this); }
  };
  // The camera backs off just enough to keep the exploded structures in view, and returns to where it was when the explode is undone.
  D.fitExplode = function (f) {
    const vec = explodeVectors(this.ex.mode); let R = 0;
    for (const [id, o] of this.objs) { const v = vec.get(id) || [0, 0, 0], t = toThreeVec(v, f), c = o.geometry.boundingSphere.center; R = Math.max(R, Math.hypot(c.x + t[0], c.y + t[1], c.z + t[2]) + o.geometry.boundingSphere.radius); }
    const need = (R / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.02 / Math.min(1, Math.max(0.4, this.camera.aspect));
    this.ex.dist = Math.max(this.ex.baseDist, need);
  };
  D.setExplode = function (f, mode) {
    const ex = this.ex;
    if (mode && mode !== ex.mode) { ex.mode = mode; }
    if (!ex.baseDist || (ex.cur < 0.01 && ex.target < 0.01)) ex.baseDist = this.camera.position.distanceTo(this.controls.target);
    ex.target = f; ex.anim = true;
    if (f > 0.01) this.fitExplode(f); else ex.dist = ex.baseDist;
    this.needs = true;
  };
}

/* ---- panel G (vtk.js) */
// Every segmented tissue, for exploded pieces: inside a piece only that structure's own voxels remain, so nothing else needs hiding.
VR.tissue = { name: 'All tissue', op: [[-1024, 0], [-260, 0], [-120, 0.2], [40, 0.5], [250, 0.7], [3071, 0.9]], col: [[-1024, 0, 0, 0], [-260, 0.55, 0.42, 0.3], [-60, 0.8, 0.58, 0.44], [60, 0.78, 0.3, 0.24], [300, 0.95, 0.85, 0.7], [900, 1, 0.97, 0.9], [3071, 1, 1, 1]] };
const G_LABEL_GROUPS = {                 // what each preset actually renders; names are given only to those structures
  bone: ['skeleton'], vessels: ['arteries', 'veins', 'heart', 'skeleton'], muscle: ['muscles', 'skeleton'], skin: [], lungs: ['airway'],
  tissue: null, bright: null, surface: [],
};
Object.assign(G, { ex: { cur: 0, target: 0, mode: 'body', anim: false, pieces: null, building: null, baseDist: 0, dist: 0 }, idMap: null, idFresh: false, hoverId: 0, labels: null, restToken: 0, moving: false, cutMm: 0 });
{
  const init0 = G.init, dispose0 = G.dispose, preset0 = G.applyPreset, view0 = G.view, cut0 = G.setCut, sync0 = G.syncActors, quality0 = G.applyQuality;
  G.init = function (host, vol) {
    const first = init0.call(this, host, vol);
    const it = this.grw.getInteractor();
    // vtk.js renders a smaller image and takes fewer samples per ray while the view moves, aiming at the desired rate.
    try { it.setDesiredUpdateRate(30); } catch (e) { /* older vtk.js */ }
    try { this.mapper.setInteractionSampleDistanceFactor(D.software ? 4 : 2); this.mapper.setAutoAdjustSampleDistances(true); } catch (e) { /* older vtk.js */ }
    try { this.mapper.setInitialInteractionScale(D.software ? 16 : 3); } catch (e) { /* older vtk.js */ }
    it.onStartAnimation(() => this.motionStart());
    it.onAnimation(() => {
      this.moveLabels();
      const ex = this.ex, now = performance.now();
      if (ex.cur > 0.01 && ex.pieces && !ex.proxyOn) {
        const dt = now - (this.lastAnim || now); this.lastAnim = now;
        if (dt > 0 && dt < 3000) { this.animEma = this.animEma ? this.animEma * 0.6 + dt * 0.4 : dt; if (++this.animN >= 3 && this.animEma > 45) { this.slowPieces = true; this.useProxies(true); UI.G.syncExplode(); } }
      }
    });
    it.onEndAnimation(() => this.motionEnd());
    const body = host.parentElement;
    if (!this.labels) {
      this.labels = new Labels(body, 'G');
      this.labels.onHover = (id) => { this.hoverId = id; this.labels.drawOutline(this.idFresh ? this.idMap : null, id); this.labels.restyle(id); };
    }
    const canvas = host.querySelector('canvas');
    let downAt = null, pending = null, raf = 0;
    canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) return; pending = e;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pending && this.idFresh) this.hover(pending); pending = null; });
    });
    canvas.addEventListener('pointerleave', () => { pending = null; tip.hidden = true; this.setHoverG(0); setHover(0); });
    canvas.addEventListener('click', (e) => { if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 4 && this.idFresh) { const id = this.idAt(e); if (id) select(id, true); } });
    if (!this.labelObs) { this.labelObs = new ResizeObserver(() => { if (!this.ready) return; this.idFresh = false; if (this.labels) this.labels.clear(); this.scheduleRest(); }); }
    this.labelObs.disconnect(); this.labelObs.observe(host);
    this.idFresh = false; this.scheduleRest();
    return first;
  };
  G.motionStart = function () { this.lastAnim = 0; this.animEma = 0; this.animN = 0; if (this.slowPieces && this.ex.cur > 0.01 && this.ex.pieces) this.useProxies(true); this.moving = true; this.idFresh = false; tip.hidden = true; if (this.labels) this.labels.clearOutline(); };
  G.motionEnd = function () { this.moving = false; if (this.ex.proxyOn) this.useProxies(false); this.rw.render(); this.scheduleRest(); };
  G.idAt = function (e) {
    const m = this.idMap, rc = this.host.getBoundingClientRect(); if (!m) return 0;
    const x = Math.floor(((e.clientX - rc.left) / rc.width) * m.w), y = Math.floor(((e.clientY - rc.top) / rc.height) * m.h);
    return x >= 0 && y >= 0 && x < m.w && y < m.h ? m.ids[y * m.w + x] : 0;
  };
  G.setHoverG = function (id) { if (id === this.hoverId) return; this.hoverId = id; if (this.labels) { this.labels.drawOutline(this.idFresh ? this.idMap : null, id); this.labels.restyle(id); } };
  G.hover = function (e) { const id = this.idAt(e); this.setHoverG(id); if (id) { showTip(e.clientX, e.clientY, id, this.ex.cur > 0.01 ? 'Exploded piece of the patient volume, model output' : 'Segmented structure in this view, model output'); setHover(id); } else { tip.hidden = true; setHover(0); } };
  G.labelGroups = function () {
    if (this.colour) return null;                                  // every coloured surface is on screen
    return G_LABEL_GROUPS[this.preset] === undefined ? null : G_LABEL_GROUPS[this.preset];
  };
  // A three.js camera that sees exactly what vtk.js shows. The matrix order is checked against vtk.js's own projection, not assumed.
  G.threeCamera = function (w, h) {
    const cam = this.ren.getActiveCamera(), aspect = w / h;
    this.ren.resetCameraClippingRange();
    const V = cam.getViewMatrix(), Pm = cam.getProjectionMatrix(aspect, -1, 1), cx = this.ext[0] / 2, cy = this.ext[1] / 2, cz = this.ext[2] / 2;
    const M = new THREE.Matrix4().set(1, 0, 0, -cx, 0, 0, 1, -cz, 0, -1, 0, cy, 0, 0, 0, 1), Minv = M.clone().invert();
    const probe = [cx * 0.6, cy * 1.3, cz * 0.8], want = this.ren.worldToNormalizedDisplay(probe[0], probe[1], probe[2], aspect);
    for (const rowMajor of [true, false]) {
      const v = rowMajor ? new THREE.Matrix4().set(...V) : new THREE.Matrix4().fromArray(V), p = rowMajor ? new THREE.Matrix4().set(...Pm) : new THREE.Matrix4().fromArray(Pm);
      const ndc = new THREE.Vector4(probe[0], probe[1], probe[2], 1).applyMatrix4(v).applyMatrix4(p);
      const nx = (ndc.x / ndc.w + 1) / 2, ny = (ndc.y / ndc.w + 1) / 2;
      if (Math.abs(nx - want[0]) < 1e-3 && Math.abs(ny - want[1]) < 1e-3) {
        const c = new THREE.Camera(); c.matrixAutoUpdate = false; c.matrixWorldAutoUpdate = false;
        c.projectionMatrix.copy(p); c.projectionMatrixInverse.copy(p).invert();
        c.matrixWorldInverse.multiplyMatrices(v, Minv); c.matrixWorld.copy(c.matrixWorldInverse).invert();
        c.toVtk = (q) => [q.x + cx, cy - q.z, q.y + cz];
        return c;
      }
    }
    return null;                          // no consistent projection: no labels rather than misplaced ones
  };
  G.scheduleRest = function () { const t = ++this.restToken; setTimeout(() => { if (t === this.restToken && this.ready && !this.moving && !this.ex.anim) this.rest(); }, 60); };
  G.rest = function () {
    if (!this.labels || !D.objs.size) { if (this.labels) this.labels.clear(); this.idFresh = false; return; }
    const r = this.host.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return;
    const w = Math.min(r.width, 1200), h = Math.round((r.height * w) / r.width), cam = this.threeCamera(w, h);
    if (!cam) { this.labels.clear(); this.idFresh = false; return; }
    const groups = this.labelGroups(), f = this.ex.cur, vec = explodeVectors(this.ex.mode), pieces = this.ex.pieces;
    const include = (id) => !!VIS[id] && !ENTRY[id].region && (!groups || groups.includes(GKEY[id])) && (f < 0.01 || !pieces || pieces.has(id));
    const off = f > 0.01 ? (id) => toThreeVec(vec.get(id) || [0, 0, 0], f) : null;
    const clip = f < 0.01 && this.cutMm > 0 ? new THREE.Plane(new THREE.Vector3(0, 0, -1), this.ext[1] / 2 - this.cutMm) : null;
    idPass(cam, w, h, (id) => include(id), off, clip, (map, hitAt) => {
      map.sx = r.width / w; map.sy = r.height / h; this.idMap = map; this.idFresh = true;   // names only under the pointer
    });
    this.labels.drawOutline(this.idMap, this.hoverId); this.labels.restyle(this.hoverId);
  };
  G.moveLabels = function () {
    if (!this.labels || !this.labels.items.length) return;
    const r = this.host.getBoundingClientRect(), aspect = r.width / r.height, vec = explodeVectors(this.ex.mode), f = this.ex.cur;
    this.labels.move((it) => {
      const v = vec.get(it.id) || [0, 0, 0], q = this.ren.worldToNormalizedDisplay(it.p[0] + v[0] * f, it.p[1] + v[1] * f, it.p[2] + v[2] * f, aspect);
      return q[2] > 1 || q[2] < -1 ? null : [q[0] * r.width, (1 - q[1]) * r.height];
    });
  };
  G.dispose = function () {
    this.restToken++; this.moving = false;
    if (this.ex.raf) cancelAnimationFrame(this.ex.raf);
    Object.assign(this.ex, { cur: 0, target: 0, anim: false, pieces: null, building: null, baseDist: 0, dist: 0, raf: 0, prevPreset: null, proxies: null, proxyOn: false });
    this.idFresh = false; this.idMap = null; this.hoverId = 0;
    if (this.labels) this.labels.clear();
    if (UI.G && UI.G.exRange) { UI.G.exRange.value = 0; UI.G.syncExplode(); }
    dispose0.call(this);
  };
  G.applyPreset = function (k, render = true) { preset0.call(this, k, render); if (this.labels) this.scheduleRest(); };
  G.choosePreset = function (k) { this.ex.prevPreset = null; this.applyPreset(k); UI.G.syncExplode(); };
  G.view = function (k) { view0.call(this, k); if (this.ex.cur > 0.01) { this.fitExplode(this.ex.cur, true); this.rw.render(); } this.scheduleRest(); };
  G.setCut = function (mm) { this.cutMm = mm; cut0.call(this, mm); this.idFresh = false; if (this.labels) this.labels.clearOutline(); this.scheduleRest(); };
  G.syncActors = function () { sync0.call(this); if (this.ready && this.labels) this.scheduleRest(); };
  G.applyQuality = function () { quality0.call(this); for (const p of this.ex.pieces ? this.ex.pieces.values() : []) p.mapper.setSampleDistance(this.mapper.getSampleDistance()); };

  // Exploded volume: every segmented structure becomes its own small volume, holding the patient's own voxel values inside its mask and
  // nothing outside, and is moved apart. Unsegmented voxels (fat, skin, air) are not part of any piece.
  G.buildPieces = async function (token) {
    const vol = P.vol; if (!vol || !vol.lab) return null;
    const [nx, ny, nz] = vol.dims, lab = vol.lab, hu = vol.hu, n = VIS.length;
    const lo = new Int32Array(n * 3).fill(2 ** 30), hi = new Int32Array(n * 3).fill(-1), vsum = new Float64Array(n), vcnt = new Uint32Array(n);
    for (let z = 0; z < nz; z++) {
      for (let y = 0, i = z * nx * ny; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
        const L = lab[i]; if (!L) continue; const k = L * 3; vsum[L] += hu[i]; vcnt[L]++;
        if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; if (y < lo[k + 1]) lo[k + 1] = y; if (y > hi[k + 1]) hi[k + 1] = y; if (z < lo[k + 2]) lo[k + 2] = z; if (z > hi[k + 2]) hi[k + 2] = z;
      }
      if (z % 24 === 23) { await new Promise((res) => setTimeout(res, 0)); if (token !== S.open) return null; }
    }
    const ids = [...S.present].filter((id) => !ENTRY[id].region && hi[id * 3] >= 0);
    let total = 0; for (const id of ids) total += (hi[id * 3] - lo[id * 3] + 1) * (hi[id * 3 + 1] - lo[id * 3 + 1] + 1) * (hi[id * 3 + 2] - lo[id * 3 + 2] + 1);
    // A memory budget for the graphics card: the finest axes are thinned first until the pieces fit.
    const budget = 12e6, st = [1, 1, 1];
    while (total / (st[0] * st[1] * st[2]) > budget) { let a = 0; for (let k = 1; k < 3; k++) if (vol.sp[k] * st[k] < vol.sp[a] * st[a]) a = k; st[a]++; }
    const pieces = new Map(); let done = 0;
    for (const id of ids) {
      const k = id * 3, bx = Math.floor((hi[k] - lo[k]) / st[0]) + 3, by = Math.floor((hi[k + 1] - lo[k + 1]) / st[1]) + 3, bz = Math.floor((hi[k + 2] - lo[k + 2]) / st[2]) + 3;
      const data = new Int16Array(bx * by * bz).fill(-1024);
      for (let z = 1; z < bz - 1; z++) { const sz = lo[k + 2] + (z - 1) * st[2]; if (sz > hi[k + 2]) break;
        for (let y = 1; y < by - 1; y++) { const sy = lo[k + 1] + (y - 1) * st[1]; if (sy > hi[k + 1]) break;
          let si = sz * nx * ny + sy * nx + lo[k], di = z * bx * by + y * bx + 1;
          for (let x = 1; x < bx - 1; x++, si += st[0], di++) { if (lo[k] + (x - 1) * st[0] > hi[k]) break; if (lab[si] === id) data[di] = hu[si]; } } }
      const img = vtk.vtkImageData.newInstance();
      img.setDimensions(bx, by, bz); img.setSpacing(vol.sp[0] * st[0], vol.sp[1] * st[1], vol.sp[2] * st[2]);
      img.setOrigin((lo[k] - st[0]) * vol.sp[0], (lo[k + 1] - st[1]) * vol.sp[1], (lo[k + 2] - st[2]) * vol.sp[2]);
      img.getPointData().setScalars(vtk.vtkDataArray.newInstance({ name: 'v', numberOfComponents: 1, values: data }));
      const mapper = vtk.vtkVolumeMapper.newInstance(); mapper.setInputData(img); mapper.setSampleDistance(this.mapper.getSampleDistance()); mapper.setMaximumSamplesPerRay(1500);
      try { mapper.setInteractionSampleDistanceFactor(D.software ? 4 : 2); } catch (e) { /* older vtk.js */ }
      const actor = vtk.vtkVolume.newInstance(); actor.setMapper(mapper); actor.setProperty(this.prop); actor.setVisibility(false);
      this.ren.addVolume(actor); pieces.set(id, { actor, mapper });
      if (++done % 8 === 0) { UI.G.setCap(`Preparing the exploded volume: ${done} of ${ids.length} structures`); await new Promise((res) => setTimeout(res, 0)); if (token !== S.open || !this.ready) return null; }
    }
    pieces.stride = st;
    pieces.mean = new Map(ids.map((id) => [id, vsum[id] / vcnt[id]]));
    return pieces;
  };
  G.applyExplode = function () {
    const f = this.ex.cur, on = f > 0.01, pieces = this.ex.pieces, vec = explodeVectors(this.ex.mode), stand = this.ex.proxyOn && this.ex.proxies;
    this.actor.setVisibility(!on || !pieces);
    for (const [id, a] of this.actors) a.setVisibility(!on && this.colour && !!VIS[id]);
    if (pieces) for (const [id, p] of pieces) {
      const v = vec.get(id) || [0, 0, 0], show = on && !!VIS[id];
      p.actor.setVisibility(show && !stand); p.actor.setPosition(v[0] * f, v[1] * f, v[2] * f);
      const s = stand && this.ex.proxies.get(id); if (s) { s.setVisibility(show); s.setPosition(v[0] * f, v[1] * f, v[2] * f); }
    }
    if (this.ex.proxies && !stand) for (const s of this.ex.proxies.values()) s.setVisibility(false);
  };
  // Stand-ins for the exploded pieces while the view moves on a computer too slow to turn them all smoothly: each piece's light surface,
  // tinted with the colour the current volume colour scale gives that structure's mean value. The volume pieces return when the view stops.
  G.buildProxies = function () {
    const pieces = this.ex.pieces, proxies = new Map(); if (!pieces) return proxies;
    for (const id of pieces.keys()) {
      const m = MESH_LO.get(id) || MESH.get(id); if (!m) continue;
      const pd = vtk.vtkPolyData.newInstance(); pd.getPoints().setData(m.pos, 3);
      const nt = m.idx.length / 3, cells = new Uint32Array(nt * 4);
      for (let i = 0; i < nt; i++) { cells[i * 4] = 3; cells[i * 4 + 1] = m.idx[i * 3]; cells[i * 4 + 2] = m.idx[i * 3 + 1]; cells[i * 4 + 3] = m.idx[i * 3 + 2]; }
      pd.getPolys().setData(cells); pd.getPointData().setNormals(vtk.vtkDataArray.newInstance({ name: 'Normals', numberOfComponents: 3, values: m.nrm }));
      const mp = vtk.vtkMapper.newInstance(); mp.setInputData(pd); mp.setScalarVisibility(false);
      const a = vtk.vtkActor.newInstance(); a.setMapper(mp); a.setVisibility(false);
      const pr = a.getProperty(); pr.setAmbient(0.22); pr.setDiffuse(0.8); pr.setSpecular(0.25); pr.setSpecularPower(16);
      this.ren.addActor(a); proxies.set(id, a);
    }
    return proxies;
  };
  G.tintProxies = function () {
    const rgb = [0, 0, 0], mean = this.ex.pieces && this.ex.pieces.mean;
    for (const [id, a] of this.ex.proxies) { this.ctf.getColor(mean ? mean.get(id) : 0, rgb); a.getProperty().setColor(rgb[0], rgb[1], rgb[2]); }
  };
  G.useProxies = function (on) {
    if (on && !this.ex.proxies) this.ex.proxies = this.buildProxies();
    if (on) this.tintProxies();
    this.ex.proxyOn = on; this.applyExplode();
  };
  G.fitExplode = function (f, jump) {
    const vec = explodeVectors(this.ex.mode), c = [this.ext[0] / 2, this.ext[1] / 2, this.ext[2] / 2]; let R = Math.hypot(...c);
    for (const v of vec.values()) R = Math.max(R, Math.hypot(...c) + Math.hypot(v[0] * f, v[1] * f, v[2] * f));
    const cam = this.ren.getActiveCamera(), need = R / Math.sin((cam.getViewAngle() * Math.PI) / 360) / Math.min(1, Math.max(0.4, this.host.clientWidth / Math.max(1, this.host.clientHeight)));
    this.ex.dist = Math.max(this.ex.baseDist, need);
    if (jump) { const fp = cam.getFocalPoint(), dop = cam.getDirectionOfProjection(); cam.setPosition(fp[0] - dop[0] * this.ex.dist, fp[1] - dop[1] * this.ex.dist, fp[2] - dop[2] * this.ex.dist); this.ren.resetCameraClippingRange(); }
  };
  G.setExplode = async function (f, mode) {
    const ex = this.ex; if (!this.ready) return;
    if (mode) ex.mode = mode;
    if (f > 0.01 && !ex.pieces) {
      if (!P.vol || !P.vol.lab) return;
      if (!ex.building) { const token = S.open; ex.building = this.buildPieces(token).then((p) => { if (token === S.open && this.ready) ex.pieces = p; ex.building = null; return p; }); }
      UI.G.setCap('Preparing the exploded volume'); await ex.building; if (!ex.pieces) return;
    }
    const cam = this.ren.getActiveCamera();
    if (ex.cur < 0.01 && ex.target < 0.01) ex.baseDist = cam.getDistance();
    // A CT preset that hides soft tissue would hide most pieces: while exploded the volume uses All tissue, and the reader's preset returns after.
    if (f > 0.01 && this.table === VR && this.preset !== 'tissue' && !ex.prevPreset) { ex.prevPreset = this.preset; this.applyPreset('tissue', false); UI.G.setPresets(); }
    if (f <= 0.01 && ex.prevPreset) { const k = ex.prevPreset; ex.prevPreset = null; this.applyPreset(k, false); UI.G.setPresets(); }
    ex.target = f; if (f > 0.01) this.fitExplode(f, false); else ex.dist = ex.baseDist;
    if (!ex.anim) {
      ex.anim = true; this.idFresh = false; if (this.labels) this.labels.clearOutline();
      const it = this.grw.getInteractor(); it.requestAnimation(this);      // interactive quality while the pieces move
      let last = performance.now();
      const step = (now) => {
        if (!this.ready) return;
        const dt = Math.min(0.1, (now - last) / 1000), k = 1 - Math.exp(-dt * 9); last = now;
        ex.cur += (ex.target - ex.cur) * k; if (Math.abs(ex.target - ex.cur) < 0.002) ex.cur = ex.target;
        const fp = cam.getFocalPoint(), dop = cam.getDirectionOfProjection(), d = cam.getDistance(), nd = ex.dist ? d + (ex.dist - d) * k : d;
        cam.setPosition(fp[0] - dop[0] * nd, fp[1] - dop[1] * nd, fp[2] - dop[2] * nd); this.ren.resetCameraClippingRange();
        this.applyExplode(); this.moveLabels();
        if (ex.cur !== ex.target) { ex.raf = requestAnimationFrame(step); return; }
        ex.anim = false; ex.raf = 0; try { it.cancelAnimation(this); } catch (e) { /* already stopped */ }
        if (ex.proxyOn) this.useProxies(false);
        UI.G.syncExplode(); this.rw.render(); this.scheduleRest();
      };
      ex.raf = requestAnimationFrame(step);
    }
  };
}
function relabel3d() { if (D.ready && D.inited) D.scheduleRest(); if (G.ready) G.scheduleRest(); }

/* ---- controls for D and G: explode amount and mode, labels */
function explodeControls(p, target) {
  const range = h('input', { type: 'range', min: 0, max: 100, value: 0, 'aria-label': 'Explode', title: 'Move the structures apart. Positions in an exploded view are for display, not anatomical.' });
  const mode = h('select', { 'aria-label': 'Explode mode', title: 'Whole body: every structure moves away from the centre of the body. Within each organ: only the parts of an organ (liver segments, lung lobes, vertebrae) move apart.' },
    ...Object.entries(EXPLODE_TEXT).map(([k, v]) => h('option', { value: k, text: v })));
  let t = 0;
  range.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => target.setExplode(Number(range.value) / 100, mode.value), 16); p.syncExplode(); });
  mode.addEventListener('change', () => target.setExplode(Number(range.value) / 100, mode.value));
  p.exRange = range; p.exMode = mode;
  const base = { cap: null };
  p.syncExplode = () => {
    const on = Number(range.value) > 0;
    if (on && base.cap === null) base.cap = p.capEl.textContent;
    if (on) p.setCap(`Exploded for display (${EXPLODE_TEXT[mode.value].toLowerCase()}): structures are moved apart; their positions are not anatomical.${target === G ? ` Only segmented voxels are shown${G.ex.prevPreset ? ', with the All tissue preset' : ''}.${G.slowPieces ? ' This computer cannot turn every piece smoothly, so while the view moves each piece is drawn as its surface; the volume returns when it stops.' : ''}` : ''}`);
    else if (base.cap !== null) { p.setCap(base.cap); base.cap = null; }
    if (p.cut) { p.cut.disabled = on; p.cut.title = on ? 'The cut applies to the whole volume, not to an exploded one' : ''; }
  };
  p.tools.append(h('label', { class: 'field ex' }, 'Explode', range), mode);
}


/* ------------------------------------------------------------------ structures */
function initRegistry(reg) {
  const n = reg.structures.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  COL = new Uint8Array(n * 3); COL3 = new Uint8Array(n * 3); VIS = new Uint8Array(n); PAINT = new Uint8Array(n); HIT = new Uint8Array(n);
  const gname = Object.fromEntries(reg.groups.map((g) => [g.key, g.en]));
  S.idOf = new Map(reg.structures.map((s) => [s.key, s.id]));
  for (const s of reg.structures) {
    const i = s.id; ENTRY[i] = s; KEY[i] = s.key; GKEY[i] = s.group; GROUP[i] = gname[s.group] || s.group;
    COL3.set(s.tone, i * 3);
    // On a grey image a dark tone disappears, so the overlay uses the same hue lifted to a readable brightness.
    const peak = Math.max(s.tone[0], s.tone[1], s.tone[2], 1), k = peak < 184 ? 184 / peak : 1;
    COL[i * 3] = Math.min(255, s.tone[0] * k); COL[i * 3 + 1] = Math.min(255, s.tone[1] * k); COL[i * 3 + 2] = Math.min(255, s.tone[2] * k);
    PAINT[i] = s.region ? 0 : 1;          // containers are named under the pointer but never filled with colour
    PARENT[i] = 0;
  }
  for (const s of reg.structures) PARENT[s.id] = s.parent ? (S.idOf.get(s.parent) || 0) : 0;
}
function applyLanguage() {
  for (const s of S.meta.registry.structures) NAME[s.id] = term(s.id).text;
  document.documentElement.lang = S.lang;
}
function setStructures(list) {
  VIS.fill(0); HIT.fill(0); ML.length = 0; S.selected = 0;
  S.present = new Set(); S.kids = new Map(); S.task = new Map(); S.total = new Map();
  for (const s of list) { if (!ENTRY[s.id]) continue; VIS[s.id] = 1; ML[s.id] = s.ml; S.present.add(s.id); S.task.set(s.id, s.task); }
  // A parent whose voxels were all given to finer structures (the liver, once its segments are known) is still listed, as the sum of its parts.
  const rows = new Set(S.present);
  for (const id of S.present) for (let p = PARENT[id]; p; p = PARENT[p]) rows.add(p);
  for (const id of rows) { const p = PARENT[id]; if (p && rows.has(p)) { if (!S.kids.has(p)) S.kids.set(p, []); S.kids.get(p).push(id); } }
  for (const list2 of S.kids.values()) list2.sort((a, b) => a - b);
  const tot = (id) => { if (S.total.has(id)) return S.total.get(id); let v = ML[id] || 0; for (const k of S.kids.get(id) || []) v += tot(k); S.total.set(id, v); return v; };
  for (const id of rows) { tot(id); VIS[id] = 1; }
  S.rows = rows;
}
function descendants(id, out = []) { for (const k of S.kids.get(id) || []) { out.push(k); descendants(k, out); } return out; }

const ROWS = new Map();
function buildTree() {
  const tree = $('#tree'); tree.replaceChildren(); ROWS.clear();
  if (!S.rows.size) return;
  const open = S.treeOpen || (S.treeOpen = new Map());
  for (const g of S.meta.registry.groups) {
    const tops = [...S.rows].filter((id) => GKEY[id] === g.key && !(PARENT[id] && S.rows.has(PARENT[id]))).sort((a, b) => a - b);
    if (!tops.length) continue;
    const all = []; for (const id of tops) { all.push(id, ...descendants(id)); }
    const gcb = h('input', { type: 'checkbox', checked: all.some((id) => VIS[id]), 'aria-label': `Show ${g.en}` });
    const rows = h('div', { class: 'rows' });
    const head = h('button', {}, h('span', { html: ICON.caret }), gcb, h('span', { text: g.en }), h('span', { class: 'count num', text: String(all.length) }));
    const open0 = open.has(g.key) ? open.get(g.key) : !['skeleton', 'muscles', 'regions'].includes(g.key);
    const grp = h('div', { class: 'grp', 'data-open': String(open0) }, head, rows); head.setAttribute('aria-expanded', String(open0));
    head.addEventListener('click', (e) => { if (e.target === gcb) return; const o = grp.dataset.open !== 'true'; grp.dataset.open = String(o); open.set(g.key, o); head.setAttribute('aria-expanded', String(o)); });
    gcb.addEventListener('change', () => { for (const id of all) { VIS[id] = gcb.checked ? 1 : 0; ROWS.get(id).cb.checked = gcb.checked; } visibilityChanged(); });
    const add = (id, depth) => {
      const t = term(id), e = ENTRY[id], own = S.present.has(id), ml = S.total.get(id) || 0;
      const cb = h('input', { type: 'checkbox', checked: !!VIS[id], 'aria-label': `Show ${t.text}` });
      cb.addEventListener('change', () => { for (const k of [id, ...descendants(id)]) { VIS[k] = cb.checked ? 1 : 0; const r = ROWS.get(k); if (r) r.cb.checked = cb.checked; } gcb.checked = all.some((x) => VIS[x]); visibilityChanged(); });
      const search = [t.text, e.en, e.latin || '', e.key.replace(/_/g, ' ')].join(' | ').toLowerCase();
      const row = h('div', { class: 'row', 'data-search': search, style: `--depth:${depth}` }, cb, h('span', { class: 'sw', style: `background:rgb(${e.tone.join(',')})` }),
        h('button', { class: own ? null : 'virt', dir: 'auto', text: t.text, title: [e.en, e.latin, own ? null : 'Shown as the sum of its parts'].filter(Boolean).join(' · '), onclick: () => select(id, true) }),
        t.missing ? h('span', { class: 'flag', text: 'EN', title: `No ${langName()} name on record for this structure. The canonical English name is shown; nothing is machine-translated.` }) : null,
        h('span', { class: 'ml num', text: `${fmt(ml, ml < 10 ? 1 : 0)} ml` }));
      rows.append(row); ROWS.set(id, { row, cb, grp, head });
      if (id === S.selected) row.dataset.selected = 'true';
      for (const k of S.kids.get(id) || []) add(k, depth + 1);
    };
    for (const id of tops) add(id, 0);
    tree.append(grp);
  }
  filterTree();
}
function filterTree() {
  const q = $('#structSearch').value.trim().toLowerCase();
  for (const grp of $('#tree').children) {
    if (grp.id === 'treeNote') continue;
    let any = false;
    for (const row of grp.querySelectorAll('.row')) { const ok = !q || row.dataset.search.includes(q); row.style.display = ok ? '' : 'none'; any = any || ok; }
    grp.style.display = any ? '' : 'none'; if (q) grp.dataset.open = 'true';
  }
  // A structure this build can name but this study does not hold is said to be absent from the study, never given a position.
  let note = $('#treeNote'); if (note) note.remove();
  if (q.length < 3 || !S.study) return;
  const absent = [];
  for (const e of S.meta.registry.structures) {
    if (S.rows.has(e.id)) continue;
    const hay = [term(e.id).text, e.en, e.latin || '', e.key.replace(/_/g, ' ')].join(' | ').toLowerCase();
    if (hay.includes(q)) absent.push(term(e.id).text);
  }
  if (!absent.length) return;
  const seg = S.study.segmentation;
  note = h('div', { id: 'treeNote', class: 'treenote', dir: 'auto' },
    h('b', { text: seg ? 'Not found in this study' : 'This study is not segmented' }),
    h('span', { text: `${absent.slice(0, 6).join(', ')}${absent.length > 6 ? ` and ${absent.length - 6} more` : ''}. ${seg ? 'Outside the scanned region, not run at this level, or not found by the model. No position is shown for a structure that was not found.' : ''}` }));
  $('#tree').append(note);
}
function visibilityChanged() { markAll(); if (D.ready) D.restyle(); if (D.ex.cur > 0.01 && D.ready) D.applyExplode(); if (G.ready && G.ex.cur > 0.01) G.applyExplode(); G.syncActors(); relabel3d(); }

// Where a structure is, in a volume's own voxels: the voxel of the structure nearest its centroid. Never a guessed position.
function anchors(vol) {
  if (vol.anchor) return vol.anchor;
  const { dims: [nx, ny, nz], lab } = vol, n = VIS.length, sum = new Float64Array(n * 3), cnt = new Uint32Array(n);
  let i = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) { const L = lab[i]; if (L && L < n) { sum[L * 3] += x; sum[L * 3 + 1] += y; sum[L * 3 + 2] += z; cnt[L]++; } }
  vol.anchor = { sum, cnt }; return vol.anchor;
}
function anchorOf(vol, id) {
  if (!vol || !vol.lab || !id) return null;
  const { sum, cnt } = anchors(vol), ids = [id, ...descendants(id)], inSet = new Uint8Array(VIS.length);
  let sx = 0, sy = 0, sz = 0, c = 0;
  for (const k of ids) { inSet[k] = 1; c += cnt[k]; sx += sum[k * 3]; sy += sum[k * 3 + 1]; sz += sum[k * 3 + 2]; }
  if (!c) return null;
  const { dims: [nx, ny, nz], lab } = vol, cx = sx / c, cy = sy / c, cz = Math.round(sz / c);
  let best = null, bd = Infinity;
  for (let dz = 0; dz < nz && !best; dz++) for (const z of dz ? [cz - dz, cz + dz] : [cz]) {
    if (z < 0 || z >= nz) continue;
    const o = z * nx * ny;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (inSet[lab[o + y * nx + x]]) { const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < bd) { bd = d; best = [x, y, z]; } }
  }
  return best;
}
function refAnchor(id) {           // the reference holds coarser structures: fall back to the nearest ancestor it has
  if (!R.vol || !R.vol.lab) return null;
  for (let k = id; k; k = PARENT[k]) { const a = anchorOf(R.vol, k); if (a) return a; }
  return null;
}
const SOURCE_TEXT = { en: 'Canonical English name', zk: 'Name: ZeekaRad term base, source-attested', wd: 'Name: Wikidata (CC0), community' };
function select(id, go) {
  S.selected = S.selected === id && !go ? 0 : id;
  HIT.fill(0);
  if (S.selected) { HIT[S.selected] = 1; for (const k of descendants(S.selected)) HIT[k] = 1; }
  for (const [i, r] of ROWS) r.row.dataset.selected = String(i === S.selected);
  const card = $('#card');
  if (S.selected) {
    const r = ROWS.get(id), e = ENTRY[id], t = term(id), ml = S.total.get(id) || 0, own = S.present.has(id), kids = descendants(id).length;
    if (r) { r.grp.dataset.open = 'true'; r.head.setAttribute('aria-expanded', 'true'); r.row.scrollIntoView({ block: 'nearest' }); }
    const seg = S.study && S.study.segmentation;
    card.replaceChildren(...[
      h('div', { class: 'name', dir: 'auto', text: t.text }),
      S.lang !== 'en' && !t.missing ? h('div', { class: 'alt', text: e.en }) : null,
      e.latin ? h('div', { class: 'latin', text: e.latin }) : null,
      h('div', { class: 'meta', text: `${GROUP[id]}  ·  about ${fmt(ml, ml < 10 ? 1 : 0)} ml by voxel count${kids ? `  ·  ${kids} part${kids > 1 ? 's' : ''}` : ''}${PARENT[id] && NAME[PARENT[id]] ? `  ·  part of ${NAME[PARENT[id]]}` : ''}` }),
      h('div', { class: 'chips' },
        h('span', { class: 'warn', title: 'Computed from this patient\'s images by a model. A reviewed result would say so here.', text: 'Patient-derived · automated' }),
        h('span', { class: 'warn', text: 'Unreviewed' }),
        h('span', { title: 'On the study\'s own grid; no registration is involved.', text: 'Native geometry' }),
        seg ? h('span', { title: `${seg.model.name} ${seg.model.version}`, text: own ? `task ${S.task.get(id)}` : 'sum of its parts' }) : null,
        t.missing ? h('span', { class: 'warn', text: `No ${langName()} name on record` }) : h('span', { title: t.note || (e.wikidata ? `Wikidata ${e.wikidata}${e.ta98 ? ', TA98 ' + e.ta98 : ''}` : ''), text: SOURCE_TEXT[t.source] || '' })),
      h('div', {}, h('button', { class: 'btn', text: 'Go to this structure', onclick: () => select(id, true) }))].filter(Boolean));
    if (go) {
      const a = anchorOf(P.vol, id); if (a) P.cross = a;
      const b = refAnchor(id); if (b) R.cross = b;
    }
  } else card.replaceChildren(h('div', { class: 'meta', text: S.rows.size ? 'Hover a structure in panel B to read its name. Click it to select it in every view.' : 'This study has no segmentation to name structures from.' }));
  mark(P); mark(R);
  if (D.ready) D.restyle();
  relabel3d();
}


/* ------------------------------------------------------------------ meshes */
function decodeMeshes(bytes, into = MESH) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl))), base = 4 + hl;
  for (const e of head.meshes) {
    const q = new Uint16Array(bytes.buffer.slice(bytes.byteOffset + base + e.pos, bytes.byteOffset + base + e.pos + e.verts * 6));
    const pos = new Float32Array(e.verts * 3);
    for (let i = 0; i < e.verts; i++) for (let a = 0; a < 3; a++) pos[i * 3 + a] = e.min[a] + (q[i * 3 + a] / 65535) * (e.max[a] - e.min[a]);
    const ib = bytes.buffer.slice(bytes.byteOffset + base + e.idx, bytes.byteOffset + base + e.idx + e.tris * 3 * (e.idx16 ? 2 : 4));
    const idx = e.idx16 ? Uint32Array.from(new Uint16Array(ib)) : new Uint32Array(ib);
    const nrm = new Float32Array(e.verts * 3);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz; nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz; nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1; nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
    into.set(e.id, { pos, idx, nrm, tris: e.tris });
  }
}

/* ------------------------------------------------------------------ reference sources (panel C): another body, never registered to the patient */
const REF = { index: null, ct: null, cadaver: null, loading: false, kind: 'labelled-ct' };
let RVIS = new Uint8Array(1);
async function loadLabelledCt(p, meta) {
  const n = meta.dims[0] * meta.dims[1] * meta.dims[2];
  const ct = await fetchBytes('/api/reference/labelled-ct/volume.i16.gz', n * 2, (f) => p.wait('Loading reference CT', `${Math.round(f * 100)} %`, f));
  const lab = await fetchBytes('/api/reference/labelled-ct/labels.u16.gz', n * 2);
  RVIS = new Uint8Array(VIS.length); for (const s of meta.structures) RVIS[s.id] = 1;
  return { dims: meta.dims, sp: meta.spacing, hu: new Int16Array(ct.buffer), lab: new Uint16Array(lab.buffer), unit: 'HU', scale: 1, offset: 0, meta };
}
async function loadCadaver(p, meta) {
  const [W, H, N] = meta.dims, per = meta.cols * meta.rows, rgb = new Uint8Array(W * H * N * 3);
  const cv = document.createElement('canvas'); cv.width = W * meta.cols; cv.height = H * meta.rows;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  for (let s = 0; s < meta.sheets; s++) {
    p.wait('Loading cadaver cryosections', `Sheet ${s + 1} of ${meta.sheets}`, s / meta.sheets);
    const res = await fetch(`/api/reference/cadaver/sheet-${String(s).padStart(2, '0')}.jpg`);
    if (!res.ok) throw new Error(`cadaver sheet ${s} returned HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    cx.drawImage(bmp, 0, 0); bmp.close();
    const count = Math.min(per, N - s * per);
    for (let n = 0; n < count; n++) {
      const d = cx.getImageData((n % meta.cols) * W, Math.floor(n / meta.cols) * H, W, H).data;
      let o = (s * per + n) * W * H * 3;
      for (let i = 0; i < d.length; i += 4) { rgb[o++] = d[i]; rgb[o++] = d[i + 1]; rgb[o++] = d[i + 2]; }
    }
  }
  return { dims: meta.dims, sp: meta.spacing, rgb, lab: null, hu: null, meta };
}
async function setReference(kind) {
  const p = UI.C; if (REF.loading) return;
  REF.loading = true;
  try {
    if (!REF.index) REF.index = await api('/api/reference');
    const meta = REF.index[kind];
    if (!meta) throw new Error('This reference is not installed (reference/ folder).');
    if (kind === 'cadaver' && !REF.cadaver) REF.cadaver = await loadCadaver(p, meta);
    if (kind === 'labelled-ct' && !REF.ct) REF.ct = await loadLabelledCt(p, meta);
    const vol = kind === 'cadaver' ? REF.cadaver : REF.ct;
    REF.kind = kind; R.vol = vol; R.dir = [1, 1, 1];
    R.cross = [vol.dims[0] / 2, vol.dims[1] / 2, Math.round(vol.dims[2] * (kind === 'cadaver' ? 0.62 : 0.52))];
    if (S.selected) { const b = refAnchor(S.selected); if (b) R.cross = b; }
    refCaption(); p.done(); p.sync(); syncAllColour(); mark(R);
  } catch (e) { p.wait('Reference could not be loaded', String(e.message || e)); }
  finally { REF.loading = false; }
}
function refCaption() {
  const p = UI.C; if (!R.vol) return;
  let text = REF.kind === 'cadaver' ? 'Visible Human male cryosections, courtesy of the U.S. National Library of Medicine. Another body, not registered to the patient.'
    : 'Labelled CT of another subject (independent reference). Not registered to the patient; it scrolls on its own.';
  if (S.study && REF.kind === 'labelled-ct' && REF.ct) {
    const have = new Set(REF.ct.meta.structures.map((s) => s.id)); let shared = 0;
    for (const id of S.present) if (have.has(id)) shared++;
    text += shared >= 3 ? ` ${shared} structures of this study are labelled here too: selecting one moves the reference to it.` : ' It covers neck to pelvis and shares no labelled region with this study.';
    if (S.study.modality !== 'CT') text += ` The study is ${S.study.modality}; this reference is CT.`;
  }
  p.setCap(text);
}


/* ------------------------------------------------------------------ build the interface */
const WINDOWS = {
  CT: [['Soft tissue', 40, 400], ['Mediastinum', 50, 350], ['Liver', 60, 160], ['Lung', -600, 1500], ['Bone', 400, 1800], ['Brain', 40, 80]],
  OTHER: [['Standard', -24, 2000], ['Brighter', -324, 1400], ['Darker', 276, 2600], ['High contrast', -224, 1200]],
};
function setWindows(modality) {
  const sel = $('#winSel'), list = modality === 'CT' ? WINDOWS.CT : WINDOWS.OTHER;
  sel.replaceChildren(...list.map(([name, c, w]) => h('option', { value: `${c},${w}`, text: name })));
  setWindow(list[0][1], list[0][2]);
}
function buildUI() {
  UI.A = slicePanel('A', 'Patient', 'Original images. No overlay is ever drawn here.', P, { plane: 'ax', cross: true, label: 'Patient images' });
  UI.B = slicePanel('B', 'Segmentation and Labels', 'Hover a structure to read its name. Click to select it.', P, { plane: 'ax', overlay: true, hover: true, select: true, label: 'Segmentation and labels' });
  UI.C = slicePanel('C', 'Reference', 'Loading', R, { plane: 'ax', overlay: true, hover: true, label: 'Reference anatomy' });
  const src = h('select', { 'aria-label': 'Reference source', title: 'Reference source' }, h('option', { value: 'labelled-ct', text: 'Labelled CT' }), h('option', { value: 'cadaver', text: 'Cadaver cryosections' }));
  src.addEventListener('change', () => setReference(src.value)); UI.C.tools.prepend(src);

  // D
  const d = panel('D', '3D Anatomy', 'Surfaces built from the patient segmentation. Hover a structure to read its name; click selects it. Drag to rotate, wheel to zoom.'); UI.D = d;
  d.colourBtn = colourButton((on) => d.setColour(on), 'Colour the structures, or show them as one plain model');
  d.setColour = (on) => { D.colour = on; d.colourBtn.setAttribute('aria-pressed', String(on)); if (D.ready) D.restyle(); syncAllColour(); };
  d.colourOn = () => D.colour; d.colourUnavailable = () => false; COLOURED.push(d);
  const tog = (label, key, title) => { const b = h('button', { class: 'btn', 'aria-pressed': String(D[key]), title, text: label }); b.addEventListener('click', () => { D[key] = !D[key]; b.setAttribute('aria-pressed', String(D[key])); if (D.ready) { D.restyle(); D.updatePlane(); } }); return b; };
  d.tools.append(d.colourBtn, tog('Body outline', 'skin', 'Show the body surface, taken from the images by a threshold'), tog('Slice plane', 'plane', "Show panel A's slice in the 3D view"), tog('Isolate selected', 'ghost', 'Fade every structure except the selected one and its parts'));
  const vb = h('div', { class: 'viewbtns' }); for (const k of ['A', 'P', 'L', 'R', 'S', 'I']) vb.append(h('button', { text: k, title: `View from ${{ A: 'anterior', P: 'posterior', L: 'patient left', R: 'patient right', S: 'superior', I: 'inferior' }[k]}`, onclick: () => D.ready && D.view(k) }));
  d.body.append(vb);
  explodeControls(d, D);

  // E
  const e = panel('E', 'MPR', 'The two planes orthogonal to panel A, at the same point. Click to move the crosshair.'); UI.E = e;
  e.body.classList.add('split'); const e1 = h('div'), e2 = h('div'); e.body.prepend(e1, e2);
  e.views = [new SliceView(e1, P, { plane: 'cor', mini: true, cross: true, overlay: true }), new SliceView(e2, P, { plane: 'sag', mini: true, cross: true, overlay: true })];
  e.colourBtn = colourButton((on) => e.setColour(on));
  e.setColour = (on) => { for (const v of e.views) { v.colour = on; v.dirty = true; } e.colourBtn.setAttribute('aria-pressed', String(on)); syncAllColour(); };
  e.colourOn = () => e.views[0].colour; e.colourUnavailable = () => !!(P.vol && !P.vol.lab); COLOURED.push(e);
  e.tools.append(e.colourBtn);

  // F
  const f = panel('F', 'Curved Planar Reformat', 'Straightened along the centreline found in the segmentation, shown lying down. Click a level to go there.'); UI.F = f;
  CPR.canvas = h('canvas', { 'aria-label': 'Curved planar reformat' }); f.body.prepend(CPR.canvas); CPR.ctx = CPR.canvas.getContext('2d', { alpha: false });
  new ResizeObserver(() => CPR.resize()).observe(f.body);
  const ves = h('select', { 'aria-label': 'Structure to follow', title: 'The tubular structure whose centreline is followed' });
  ves.addEventListener('change', () => { CPR.vessel = Number(ves.value); CPR.build(); f.note(); CPR.dirty = true; });
  f.colourBtn = colourButton((on) => f.setColour(on));
  f.setColour = (on) => { CPR.colour = on; CPR.dirty = true; f.colourBtn.setAttribute('aria-pressed', String(on)); syncAllColour(); };
  f.colourOn = () => CPR.colour; f.colourUnavailable = () => !!(P.vol && !P.vol.lab); COLOURED.push(f);
  f.tools.append(ves, f.colourBtn);
  const fnote = h('div', { class: 'note' }); f.body.append(fnote);
  f.note = () => { fnote.textContent = CPR.path ? '' : P.vol && P.vol.lab ? (CPR.vessel ? 'The segmentation holds no usable centreline for this structure.' : 'This study holds no long tubular structure to follow.') : ''; };
  // Structures that run mostly head to foot, so a centreline can be traced slice by slice. Only those the study holds are offered.
  f.setVessels = () => {
    const keys = ['aorta', 'inferior_vena_cava', 'spinal_cord', 'trachea', 'esophagus', 'internal_carotid_artery_left', 'internal_carotid_artery_right', 'common_carotid_artery_left', 'common_carotid_artery_right', 'internal_jugular_vein_left', 'internal_jugular_vein_right'];
    const ids = keys.map((k) => S.idOf.get(k)).filter((id) => id && S.present.has(id));
    ves.replaceChildren(...ids.map((id) => h('option', { value: id, text: NAME[id] })));
    CPR.vessel = 0; CPR.path = null;
    for (const id of ids) { CPR.vessel = id; CPR.build(); if (CPR.path) break; }
    if (CPR.vessel) ves.value = String(CPR.vessel);
    f.note(); CPR.dirty = true;
  };
  CPR.canvas.addEventListener('click', (ev) => { const r = CPR.rowAt(ev); if (r) { P.cross = [r.pt[0], r.pt[1], r.pt[2]]; mark(P); } });
  CPR.canvas.addEventListener('pointermove', (ev) => { const r = CPR.rowAt(ev); if (r && r.L && CPR.colour) { showTip(ev.clientX, ev.clientY, r.L, 'AI segmentation, not reviewed'); setHover(r.L); } else { tip.hidden = true; setHover(0); } });
  CPR.canvas.addEventListener('pointerleave', () => { tip.hidden = true; setHover(0); });

  // G
  const g = panel('G', 'Volume Rendering', 'Shaded ray casting of the patient images with vtk.js. Hover a structure to read its name; click selects it. Drag to rotate, wheel to zoom.'); UI.G = g;
  const host = h('div', { class: 'host' }); g.body.prepend(host); g.host = host;
  const pre = h('select', { 'aria-label': 'Rendering preset' });
  pre.addEventListener('change', () => G.ready && G.choosePreset(pre.value));
  g.setPresets = () => { pre.replaceChildren(...Object.entries(G.table).map(([k, v]) => h('option', { value: k, text: v.name, selected: k === G.preset }))); };
  g.colourBtn = colourButton((on) => g.setColour(on), 'Show the segmented structures in colour inside the volume');
  g.colourBtn.setAttribute('aria-pressed', 'false');
  g.setColour = (on) => { G.colour = on; g.colourBtn.setAttribute('aria-pressed', String(on)); G.syncActors(); syncAllColour(); };
  g.colourOn = () => G.colour; g.colourUnavailable = () => !MESH.size; COLOURED.push(g);
  const cut = h('input', { type: 'range', min: 0, max: 100, value: 0, id: 'cutRange' });
  cut.addEventListener('input', () => G.ready && G.setCut((Number(cut.value) / 100) * G.ext[1]));
  g.cut = cut;
  const qual = h('select', { 'aria-label': 'Rendering quality', id: 'qualSel' }, h('option', { value: 'high', text: 'High quality' }), h('option', { value: 'std', text: 'Standard' }), h('option', { value: 'fast', text: 'Fast' }));
  qual.addEventListener('change', () => { G.quality = qual.value; if (G.ready) { G.applyQuality(); G.rw.render(); } });
  g.qual = qual;
  g.tools.append(pre, g.colourBtn, h('label', { class: 'field', for: 'cutRange' }, 'Cut from front', cut), qual);
  const gv = h('div', { class: 'viewbtns' }); for (const k of ['A', 'P', 'L', 'R']) gv.append(h('button', { text: k, onclick: () => G.ready && G.view(k) }));
  g.body.append(gv);
  explodeControls(g, G);

  // top bar
  $('#winSel').addEventListener('change', (ev) => { const [c, w] = ev.target.value.split(',').map(Number); setWindow(c, w); });
  $('#opRange').addEventListener('input', (ev) => { S.opacity = Number(ev.target.value) / 100; markAll(); });
  // One action hides every anatomy overlay, whichever views had one on; with none showing, the same button shows them in every view.
  $('#allColour').addEventListener('click', () => { const on = !anyColour(); for (const p of COLOURED) if (!p.colourUnavailable()) p.setColour(on); syncAllColour(); });
  $('#linkAB').addEventListener('click', () => {
    S.linkAB = !S.linkAB; $('#linkAB').setAttribute('aria-pressed', String(S.linkAB));
    if (S.linkAB) { UI.B.view.plane = UI.A.view.plane; UI.B.view.playing = UI.A.view.playing; UI.B.view.speed = UI.A.view.speed; UI.B.view.dirty = true; UI.B.sync(); }
  });
  $('#aboutBtn').addEventListener('click', () => $('#about').showModal());
  $('#aboutClose').addEventListener('click', () => $('#about').close());
  $('#structSearch').addEventListener('input', filterTree);
  const lang = $('#langSel');
  lang.replaceChildren(...S.meta.registry.locales.map((l) => h('option', { value: l.code, text: l.name, selected: l.code === S.lang })));
  lang.addEventListener('change', () => {
    // Names only: the study, the slice position, the selection and the 3D view all stay as they are.
    S.lang = lang.value; try { localStorage.setItem('zk.anatomy.lang', S.lang); } catch (e) { /* not stored */ }
    applyLanguage(); buildTree(); tip.hidden = true; relabel3d();
    const cur = S.selected; S.selected = 0; if (cur) select(cur, false);
    if (UI.F.setVessels && P.vol && P.vol.lab) { const keep = CPR.vessel; UI.F.setVessels(); if (keep) { CPR.vessel = keep; CPR.build(); UI.F.tools.querySelector('select').value = String(keep); UI.F.note(); } }
  });
  syncAllColour();
}

/* ------------------------------------------------------------------ studies, segmentation state, upload */
const ACTIVE = ['QUEUED', 'VALIDATING', 'RUNNING', 'QC_PENDING'];
const LEVEL_TEXT = { quick: 'Quick: main structures at 3 mm', standard: 'Standard: main structures, full resolution', extended: 'Extended: main and fine structures' };
async function renderStudies() {
  try { S.studies = (await api('/api/studies')).studies; } catch (e) { S.studies = S.studies || []; }
  const box = $('#studies'), cur = S.study ? S.study.id : S.opening;
  box.replaceChildren(...S.studies.map((s) => {
    const active = s.job && ACTIVE.includes(s.job.state);
    const st = s.segmented ? `${s.structures}` : active ? 'working' : s.job && s.job.state === 'FAILED' ? 'failed' : '—';
    return h('div', { class: 'study', 'aria-current': String(s.id === cur), title: `${s.title}\n${s.description || ''}\n${s.dims.join(' × ')} voxels at ${s.spacing.map((v) => fmt(v, 2)).join(' × ')} mm`, onclick: () => openStudy(s.id) },
      h('span', { class: 'mod', text: s.modality || '?' }),
      h('button', { class: 'ti', text: s.title }),
      h('span', { class: 'st num', title: s.segmented ? `${s.structures} structures segmented` : 'Not segmented', text: st }),
      s.readOnly ? null : h('button', { class: 'del', title: 'Delete this uploaded study from this computer', 'aria-label': `Delete ${s.title}`, text: '✕', onclick: async (ev) => {
        ev.stopPropagation();
        if (!window.confirm(`Delete "${s.title}" and its segmentation from this computer?`)) return;
        try { await api(`/api/studies/${s.id}`, { method: 'DELETE' }); } catch (e) { window.alert(e.message); }
        await renderStudies();
        if (S.study && S.study.id === s.id && S.studies.length) openStudy(S.studies[0].id);
      } }));
  }));
  if (!S.studies.length) box.append(h('div', { class: 'segbox', text: 'No study yet. Upload one.' }));
}
function segReason(study) {
  const job = study.job, eng = S.meta.engine;
  if (job && ACTIVE.includes(job.state)) { const done = (job.tasks || []).filter((t) => t.state === 'done').length; return { title: 'Segmenting this study', text: `${job.message || job.state}. ${done} task${done === 1 ? '' : 's'} finished. The images are usable meanwhile.` }; }
  if (!S.meta.segmentable.includes(study.modality)) return { title: `No model reads ${study.modality || 'this'} images`, text: 'CT and MR volumes are segmented. The images, planes, cine and volume rendering still work.' };
  if (job && job.state === 'FAILED') return { title: 'Segmentation failed', text: job.message || 'The job stopped.' };
  if (job && job.state === 'CANCELLED') return { title: 'Segmentation was cancelled', text: 'Start it again from the Segmentation box.' };
  if (job && job.state === 'UNSUPPORTED') return { title: 'Not supported', text: job.message };
  if (!eng.available) return { title: 'Segmentation engine not installed', text: eng.reason };
  return { title: 'Not segmented yet', text: 'Start it from the Segmentation box on the left.' };
}
function renderSeg() {
  const box = $('#segbox'), study = S.study; box.replaceChildren();
  if (!study) return;
  const seg = study.segmentation, job = study.job, eng = S.meta.engine, active = job && ACTIVE.includes(job.state);
  const dot = active ? 'run' : seg ? 'ok' : job && job.state === 'FAILED' ? 'bad' : 'warn';
  const state = active ? `${job.state.replace('_', ' ').toLowerCase()}: ${job.message || ''}` : seg ? `Ready: ${seg.structures.length} structures, ${seg.level} level` : segReason(study).title;
  box.append(h('div', { class: 'line' }, h('span', { class: `dot ${dot}` }), h('span', { class: 'state', text: state })));
  $('#chipSeg').className = `chip${seg && !active ? '' : ' warn'}`;
  $('#chipSeg span').textContent = active ? 'Segmentation: running' : seg ? `Segmentation: automatic, ${seg.structures.length} structures, unreviewed` : `Segmentation: ${segReason(study).title.toLowerCase()}`;
  $('#chipSeg').title = seg ? `${seg.model.name} ${seg.model.version}, base task ${seg.model.base}, ${seg.tasks.length} task(s), ${fmt(seg.seconds || 0)} s on ${seg.device}. Model output; no clinician has reviewed it.` : segReason(study).text;
  const tasks = active || !seg ? (job && job.tasks) || [] : seg.tasks;
  if (tasks.length) box.append(h('ul', {}, ...tasks.map((t) => h('li', { 'data-state': t.state, title: t.reason || (t.found ? `${t.found.length} structures found` : '') },
    h('span', { text: t.task + (t.fast ? ' (3 mm)' : '') }), h('span', { text: t.state === 'done' ? (t.cached ? 'kept' : `${fmt(t.seconds || 0)} s`) : t.state }), h('span', { text: t.found ? String(t.found.length) : '' })))));
  if (study.readOnly) { box.append(h('div', { text: 'Bundled sample: segmented once on the build machine, with the same code as an upload.' })); return; }
  const can = S.meta.segmentable.includes(study.modality) && eng.available;
  if (active) box.append(h('div', { class: 'line' }, h('button', { class: 'btn', text: 'Cancel', onclick: async () => { try { await api(`/api/studies/${study.id}/cancel`, { method: 'POST' }); } catch (e) { window.alert(e.message); } } })));
  else {
    const lvl = h('select', { 'aria-label': 'Segmentation level' }, ...S.meta.levels.map((k) => h('option', { value: k, text: LEVEL_TEXT[k] || k, selected: k === ((seg && seg.level) || S.meta.defaultLevel) })));
    const go = h('button', { class: 'btn', disabled: !can, title: can ? 'Runs on this computer' : segReason(study).text, text: seg ? 'Segment again' : 'Segment now', onclick: async () => {
      try { const r = await api(`/api/studies/${study.id}/segment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: lvl.value }) }); study.job = r.job; renderSeg(); startPoll(S.open); if (!study.segmentation) showSegState(); }
      catch (e) { window.alert(e.message); }
    } });
    box.append(h('div', { class: 'line' }, lvl, go));
    if (!can) box.append(h('div', { text: segReason(study).text }));
  }
}
function showSegState() {
  const why = segReason(S.study);
  for (const p of [UI.B, UI.F, UI.D]) p.wait(why.title, why.text);
  $('#railSub').textContent = why.title;
}
let POLL = 0;
function stopPoll() { if (POLL) { clearInterval(POLL); POLL = 0; } }
function startPoll(token) {
  stopPoll();
  POLL = setInterval(async () => {
    if (token !== S.open || !S.study) { stopPoll(); return; }
    let fresh; try { fresh = await api(`/api/studies/${S.study.id}`); } catch (e) { return; }
    if (token !== S.open) return;
    const before = S.study.segmentation ? S.study.segmentation.revision : null;
    S.study.job = fresh.job; renderSeg();
    const active = fresh.job && ACTIVE.includes(fresh.job.state);
    if (!S.study.segmentation && active) showSegState();
    if (active) return;
    stopPoll(); S.study = fresh; renderStudies();
    if (fresh.segmentation && fresh.segmentation.revision !== before) {
      // A new result replaces the old one everywhere: no surface of the previous revision stays in either 3-D view.
      MESH.clear(); MESH_LO.clear(); D.clear(); D.setVolume(P.vol); G.dispose(); startVolumeRendering(token); await showSegmentation(token);
    }
    else { renderSeg(); if (!fresh.segmentation) showSegState(); }
  }, 2500);
}
function initUpload() {
  const dlg = $('#uploadDlg'), lvl = $('#upLevel'), eng = S.meta.engine, res = $('#upResult'), bar = $('#upProgress');
  lvl.replaceChildren(...S.meta.levels.map((k) => h('option', { value: k, text: LEVEL_TEXT[k] || k, selected: k === S.meta.defaultLevel })));
  $('#upEngine').textContent = eng.available
    ? `Segmentation starts by itself after the upload (TotalSegmentator ${eng.version}, ${eng.device === 'gpu' ? 'on the graphics card' : 'on the processor: expect minutes, not seconds'}).`
    : `The study will open without labels. ${eng.reason}`;
  if (S.meta.storageNote) $('#upEngine').textContent += ` ${S.meta.storageNote}`;
  $('#uploadBtn').addEventListener('click', () => { res.replaceChildren(); bar.hidden = true; dlg.showModal(); });
  $('#upClose').addEventListener('click', () => dlg.close());
  $('#uploadForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const files = [...$('#upFiles').files, ...$('#upFolder').files];
    if (!files.length) { res.replaceChildren(h('div', { class: 'no', text: 'Choose files, a zip or a folder first.' })); return; }
    const total = files.reduce((a, f) => a + f.size, 0);
    if (total > S.meta.maxUploadBytes) { res.replaceChildren(h('div', { class: 'no', text: `These files are ${fmt(total / 1048576)} MB; the limit is ${fmt(S.meta.maxUploadBytes / 1048576)} MB (ZK_ANATOMY_MAX_UPLOAD_MB).` })); return; }
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    form.append('level', lvl.value); form.append('modality', $('#upModality').value);
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/studies');
    bar.hidden = false; bar.value = 0; $('#upSend').disabled = true;
    res.replaceChildren(h('div', { text: `Sending ${files.length} file${files.length > 1 ? 's' : ''}, ${fmt(total / 1048576, 1)} MB` }));
    xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) { bar.value = e.loaded / e.total; if (e.loaded === e.total) res.replaceChildren(h('div', { text: 'Reading the series and checking their geometry' })); } });
    xhr.addEventListener('loadend', async () => {
      $('#upSend').disabled = false; bar.hidden = true;
      let body = null; try { body = JSON.parse(xhr.responseText); } catch (e) { /* no JSON */ }
      if (!body) {                 // not the workstation's answer: a proxy, a size limit or a restart. Show its own words.
        const said = (xhr.responseText || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
        const why = xhr.status === 0 ? 'No answer from the server: the connection closed (the upload may be too large for the host, or the server restarted).'
          : xhr.status === 413 ? 'The upload is larger than the host accepts.' : xhr.status === 502 || xhr.status === 503 ? 'The server stopped or restarted while reading the upload (often: not enough memory for this study).' : '';
        res.replaceChildren(h('div', { class: 'no', text: `The upload failed (HTTP ${xhr.status || 'no response'}). ${why} ${said ? `Server said: ${said}` : ''}`.trim() }));
        return;
      }
      if (body.error) { res.replaceChildren(h('div', { class: 'no', text: body.error.message })); return; }
      res.replaceChildren(
        ...body.created.map((s) => h('div', { class: 'ok', text: `Added: ${s.title} (${s.modality}, ${s.dims.join(' × ')})` })),
        ...body.refused.map((r) => h('div', { class: 'no', text: `Not added: ${r.title}. ${r.reason}` })));
      $('#upFiles').value = ''; $('#upFolder').value = '';
      await renderStudies();
      if (body.created.length) openStudy(body.created[0].id);
    });
    xhr.send(form);
  });
}
function fillAbout() {
  const reg = S.meta.registry, eng = S.meta.engine, n = reg.coverage.structures;
  $('#abCoverage').replaceChildren(h('tr', {}, h('th', { text: 'Language' }), h('th', { text: 'Structures with a name on record' })),
    h('tr', {}, h('td', { text: 'English (canonical)' }), h('td', { class: 'num', text: `${n} of ${n}` })),
    ...reg.locales.filter((l) => l.code !== 'en').map((l) => h('tr', {}, h('td', { text: l.name }), h('td', { class: 'num', text: `${reg.coverage.translated[l.code]} of ${n}` }))));
  $('#abEngine').replaceChildren(
    h('li', { text: eng.available ? `TotalSegmentator ${eng.version} is installed and runs on ${eng.device === 'gpu' ? 'the graphics card' : 'the processor'}.` : `Not installed. ${eng.reason}` }),
    h('li', { text: 'CT is read by the task total, MR by total_mr. At the Extended level the fine-structure tasks for the regions found are added (head and neck, lung vessels, liver segments, trunk muscles, cavities).' }),
    h('li', { text: 'Only total and total_mr are approved in ZeekaRad\'s licence registry. The fine-structure tasks are openly published weights that the registry has not approved; they are here for local evaluation.' }));
}


/* ------------------------------------------------------------------ opening a study */
function studyNotice(study) {
  const notes = [];
  if (study.obliqueDegrees > 3) notes.push(`This series is oblique by ${fmt(study.obliqueDegrees, 1)}°. It is shown on its own acquisition grid, not rotated; the R, L, A, P, S, I letters name the nearest patient axes.`);
  if (study.stride.some((s) => s > 1)) notes.push(`Shown at ${study.spacing.map((v) => fmt(v, 2)).join(' × ')} mm (blocks of ${study.stride.join(' × ')} voxels averaged) to fit the browser. The model reads the full ${study.sourceSpacing.map((v) => fmt(v, 2)).join(' × ')} mm volume.`);
  if (study.facts.modalitySource && study.facts.modalitySource.startsWith('assumed')) notes.push(`Modality ${study.modality} was ${study.facts.modalitySource}.`);
  const el = $('#notice'); el.hidden = !notes.length; el.textContent = notes.join('  ');
}
async function showSegmentation(token) {
  const study = S.study, { B, D: dP, F } = UI, stale = () => token !== S.open;
  renderSeg();
  const seg = study.segmentation;
  if (!seg) {
    setStructures([]); buildTree(); select(0, false); showSegState();
    for (const p of COLOURED) if (p.sync) p.sync();
    syncAllColour();
    if (study.job && ACTIVE.includes(study.job.state)) startPoll(token);
    return;
  }
  const n = study.dims[0] * study.dims[1] * study.dims[2];
  try {
    for (const p of [B, F]) p.wait('Loading the segmentation', '');
    const bytes = await fetchBytes(`/api/studies/${study.id}/labels?rev=${seg.revision}`, n * 2);
    if (stale()) return;
    P.vol.lab = new Uint16Array(bytes.buffer); P.vol.anchor = null;
    S.model = `${seg.model.name} ${seg.model.version}`;
    setStructures(seg.structures); buildTree(); select(0, false);
    $('#railSub').textContent = `${S.present.size} structures, segmented automatically by ${S.model}`;
    let best = 0, most = 0;                      // open where there is most to see
    for (const s of seg.structures) if (PAINT[s.id] && s.voxels > most) { most = s.voxels; best = s.id; }
    const a = anchorOf(P.vol, best); if (a) P.cross = a;
    F.setVessels(); B.done(); F.done(); B.sync(); mark(P); syncAllColour();
  } catch (e) {
    if (stale()) return;
    for (const p of [B, F]) p.wait('The segmentation could not be loaded', String(e.message || e));
    console.error(e); return;
  }
  try {
    if (!seg.meshes || seg.meshes.unavailable) { dP.wait('3D surfaces are not available', (seg.meshes && seg.meshes.unavailable) || ''); return; }
    dP.wait('Loading surfaces', '', 0);
    const mb = await fetchBytes(`/api/studies/${study.id}/meshes?rev=${seg.revision}`, seg.meshes.bytes, (f) => { if (!stale()) dP.wait('Loading surfaces', `${Math.round(f * 100)} %`, f); });
    if (stale()) return;
    decodeMeshes(mb);
    let tris = 0; for (const [id, m] of MESH) { D.add(id, m); tris += m.tris; }
    D.restyle(); dP.done(); relabel3d();          // both 3-D views can name structures once the surfaces exist
    dP.setCap(`${seg.meshes.surfaces} surfaces, ${fmt(tris)} triangles, built from the patient segmentation. Model output, unreviewed.`);
    syncAllColour(); if (G.ready && G.colour) G.syncActors();
    // The light surfaces, drawn only while a 3D view moves, come after: the full ones are already on screen.
    if (seg.meshes.light) {
      fetchBytes(`/api/studies/${study.id}/meshes?lod=low&rev=${seg.revision}`, seg.meshes.light.bytes, () => {}).then((lb) => {
        if (stale()) return; MESH_LO.clear(); decodeMeshes(lb, MESH_LO); D.addLight(MESH_LO);
      }).catch((e) => console.warn('light surfaces not loaded; the full ones are used while moving', e));
    }
  } catch (e) { if (!stale()) { dP.wait('3D anatomy could not start', String(e.message || e)); console.error(e); } }
}
async function startVolumeRendering(token) {
  const gP = UI.G;
  try {
    gP.wait('Preparing volume rendering', 'Sending the images to the graphics card');
    await new Promise((r) => setTimeout(r, 60));
    if (token !== S.open) return;
    const ct = S.study.modality === 'CT';
    G.table = ct ? VR : VR_MR; G.preset = ct ? 'vessels' : 'tissue'; gP.setPresets(); gP.cut.value = 0;
    if (D.software) { G.quality = 'fast'; gP.qual.value = 'fast'; }
    const first = G.init(gP.host, P.vol);
    if (!D.software && first > 900) { G.quality = 'std'; gP.qual.value = 'std'; G.applyQuality(); G.rw.render(); }
    gP.setCap(G.quality !== 'high' ? 'This device draws 3D in software or slowly, so quality starts lower. Raise it with the quality menu.' : `Shaded ray casting of the patient ${S.study.modality} with vtk.js. Drag to rotate, wheel to zoom.`);
    gP.done(); if (G.colour) G.syncActors();
  } catch (e) { gP.wait('Volume rendering could not start', String(e.message || e)); console.error(e); }
}
async function openStudy(id) {
  const token = ++S.open;                        // whatever still arrives for a study opened earlier is dropped when it lands
  const stale = () => token !== S.open;
  const { A, B, D: dP, E, F, G: gP } = UI;
  stopPoll(); S.opening = id; tip.hidden = true;
  for (const v of P.views) v.playing = false;
  S.study = null; P.vol = null; MESH.clear(); MESH_LO.clear(); D.clear(); G.dispose(); CPR.path = null; CPR.vessel = 0; CPR.dirty = true;
  setStructures([]); buildTree(); select(0, false); mark(P);
  for (const p of [A, B, E, F]) p.wait('Loading the study', '', 0);
  dP.wait('Waiting for the study', ''); gP.wait('Waiting for the study', '');
  for (const p of [A, B]) p.sync();
  renderStudies();
  let study;
  try { study = await api(`/api/studies/${id}`); }
  catch (e) { if (!stale()) for (const p of [A, B, E, F]) p.wait('The study could not be opened', String(e.message || e)); return; }
  if (stale()) return;
  S.study = study;
  try { history.replaceState(null, '', `#study=${id}`); } catch (e) { /* no history */ }
  const mod = study.modality || 'Image';
  A.setTitle(`${mod} Patient`); B.setTitle(`${mod} Segmentation and Labels`);
  $('#chipStudy span').textContent = `${study.title}: ${study.dims.join(' × ')} at ${study.spacing.map((v) => fmt(v, 2)).join(' × ')} mm`;
  $('#chipStudy').title = [study.facts.dataset && `${study.facts.dataset}, ${study.facts.subject || ''}, ${study.facts.licence || ''}`, study.facts.description, study.origin === 'upload' ? 'Uploaded to this computer' : 'Bundled sample'].filter(Boolean).join('\n');
  studyNotice(study); setWindows(study.modality); renderSeg(); renderStudies();
  const n = study.dims[0] * study.dims[1] * study.dims[2];
  try {
    const bytes = await fetchBytes(`/api/studies/${id}/volume`, n * 2, (f) => { if (!stale()) for (const p of [A, B, E, F]) p.wait(`Loading ${mod} images`, `${Math.round(f * 100)} %`, f); });
    if (stale()) return;
    P.vol = { dims: study.dims, sp: study.spacing, hu: new Int16Array(bytes.buffer), lab: null, unit: study.values.unit, scale: study.values.scale, offset: study.values.offset };
    P.cross = [study.dims[0] / 2, study.dims[1] / 2, Math.round(study.dims[2] / 2)]; P.dir = [1, 1, 1];
    A.done(); E.done(); syncMini(); mark(P);
  } catch (e) {
    if (!stale()) for (const p of [A, B, E, F]) p.wait('The images could not be loaded', String(e.message || e));
    console.error(e); return;
  }
  try { D.init(dP.body); D.setVolume(P.vol); } catch (e) { dP.wait('3D anatomy could not start', String(e.message || e)); console.error(e); }
  startVolumeRendering(token);
  await showSegmentation(token);
  if (!stale()) refCaption();
}

/* ------------------------------------------------------------------ start */
async function main() {
  try { S.meta = await api('/api/meta'); }
  catch (e) { document.body.append(h('div', { class: 'notice', text: `The workstation could not start: ${e.message}` })); return; }
  if (!S.meta.registry.locales.some((l) => l.code === S.lang)) S.lang = 'en';
  initRegistry(S.meta.registry); applyLanguage();
  buildUI(); initUpload(); fillAbout(); setWindows('CT'); select(0, false); requestAnimationFrame(frame);
  UI.C.wait('Loading reference', '');
  await renderStudies();
  setReference('labelled-ct');
  const wanted = (location.hash.match(/study=([a-z0-9-]+)/) || [])[1];
  const first = S.studies.find((s) => s.id === wanted) || S.studies[0];
  if (first) await openStudy(first.id);
  else for (const p of [UI.A, UI.B, UI.D, UI.E, UI.F, UI.G]) p.wait('No study yet', 'Upload a DICOM series or a NIfTI volume with the Upload button.');
  window.ZKAPP = { P, R, D, G, UI, CPR, MESH, S, PARENT, term, select, openStudy, THREE, idMaterial, idPass };
}
main();
})();
