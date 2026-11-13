// A canvas: a board people draw on together, in plain DOM like the page
// editor (core.ts), and mounted the same ways (straight into the page in the
// browser, inside the WebView on Android).
//
// The drawing is a shared Yjs document: a list of strokes, each a map of its
// color, width, whether it erases, and its points (a flat list of x, y in
// board units). A stroke's points go into the shared state while it's being
// drawn, a few times a second, so the others watch it appear. Where everyone's
// pen is travels as their awareness state (the same channel as the page
// editor's cursors), drawn over the board as a ring the size of their pen.
import {Awareness, encodeAwarenessUpdate} from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  applyPeers,
  BASE_CSS,
  css,
  EditorColors,
  EditorHandle,
  EditorUser,
  fromB64,
  Peer,
  Snapshot,
  toB64,
} from './core';

/** The board, in board units: drawn at the same place on every screen. */
export const BOARD_W = 1000;
export const BOARD_H = 1400;
/** The theme's text color: dark on a light theme, light on a dark one. */
const INK = 'ink';
export const PALETTE = [
  INK,
  '#e5484d',
  '#f76b15',
  '#ffb224',
  '#30a46c',
  '#0090ff',
  '#8e4ec6',
  '#d6409f',
];
export const SIZES = [3, 6, 12, 24];
/** The eraser is this much wider than the pen at the same size. */
const ERASER_SCALE = 3;
/** How often a stroke being drawn goes out to the others. */
const PUSH_MS = 40;
/** How often where the pen is goes out. */
const POINTER_MS = 50;

const REMOTE = 'remote';
const LOAD = 'load';
const LOCAL = 'local';

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface CanvasOptions {
  el: HTMLElement;
  /** The shared state to start from (b64url); '' or null for a new canvas. */
  y: string | null;
  title: string;
  user: EditorUser;
  readOnly: boolean;
  colors: EditorColors;
  /** The drawing changed; local is false when it was someone else's change. */
  onChange: (markdown: string, local: boolean) => void;
  onTitle?: (title: string) => void;
  onLocalChange?: (update: string) => void;
  onAware?: (aware: string) => void;
}

interface Tool {
  color: string;
  size: number;
  erase: boolean;
}

const icon = (paths: string) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle">${paths}</svg>`;
const PEN_ICON = icon(
  '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
);
const ERASER_ICON = icon(
  '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
);

const CANVAS_CSS = `
.sp-canvas .sp-scroll { overflow:auto; }
.sp-canvas .sp-toolbar { flex-wrap:wrap; row-gap:2px; }
.sp-board { position:relative; width:calc(100% - 24px); max-width:1000px; margin:12px auto 80px; aspect-ratio:${BOARD_W} / ${BOARD_H};
  background:var(--surface); border:1px solid var(--border); border-radius:8px; overflow:hidden; }
@media (max-width:600px) { .sp-board { width:100%; margin:0 auto 60px; border-radius:0; border-left:0; border-right:0; } }
.sp-board canvas { position:absolute; inset:0; width:100%; height:100%; touch-action:none; cursor:crosshair; }
.sp-board.readonly canvas { touch-action:pan-x pan-y; cursor:default; }
.sp-peers { position:absolute; inset:0; pointer-events:none; overflow:hidden; }
.sp-peer { position:absolute; left:0; top:0; transition:transform 90ms linear; will-change:transform; }
.sp-peer-ring { position:absolute; border:2px solid; border-radius:50%; transform:translate(-50%,-50%); box-sizing:border-box; }
.sp-peer-ring.erase { border-style:dashed; }
.sp-peer-dot { position:absolute; width:6px; height:6px; border-radius:3px; transform:translate(-50%,-50%); }
.sp-peer-label { position:absolute; left:9px; top:9px; padding:1px 6px; border-radius:5px; color:#fff; white-space:nowrap;
  font:600 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.sp-toolbar .sp-swatch { min-width:34px; padding:0; }
.sp-swatch span { display:inline-block; width:20px; height:20px; border-radius:10px; vertical-align:middle;
  box-shadow:0 0 0 1px var(--border); }
.sp-toolbar .sp-swatch.on { background:var(--surface-alt); }
.sp-swatch.on span { box-shadow:0 0 0 2px var(--surface), 0 0 0 4px var(--text); }
.sp-toolbar .sp-size { min-width:34px; padding:0; }
.sp-size span { display:inline-block; border-radius:50%; background:currentColor; vertical-align:middle; }
`;

export function mountCanvas(o: CanvasOptions): EditorHandle {
  o.el.innerHTML = '';
  let colors = o.colors;
  let readOnly = o.readOnly;
  const root = document.createElement('div');
  root.className = 'sp-editor sp-canvas';
  const style = document.createElement('style');
  style.textContent = BASE_CSS + CANVAS_CSS + css(colors);
  root.appendChild(style);
  const toolbar = document.createElement('div');
  toolbar.className = 'sp-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  const scroll = document.createElement('div');
  scroll.className = 'sp-scroll';
  const board = document.createElement('div');
  board.className = 'sp-board';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Canvas');
  const peersLayer = document.createElement('div');
  peersLayer.className = 'sp-peers';
  board.appendChild(canvas);
  board.appendChild(peersLayer);
  scroll.appendChild(board);
  root.appendChild(toolbar);
  root.appendChild(scroll);
  o.el.appendChild(root);
  const ctx = canvas.getContext('2d')!;

  // ---- the shared drawing ----

  const ydoc = new Y.Doc();
  if (o.y) Y.applyUpdate(ydoc, fromB64(o.y), LOAD);
  const strokes = ydoc.getArray<Y.Map<unknown>>('strokes');
  const ytitle = ydoc.getText('title');
  if (!o.y && o.title) ydoc.transact(() => ytitle.insert(0, o.title), LOAD);

  ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    const local = origin !== REMOTE && origin !== LOAD;
    if (local) o.onLocalChange?.(toB64(u));
    o.onChange('', local);
  });
  ytitle.observe(ev => {
    if (ev.transaction.origin === REMOTE) o.onTitle?.(ytitle.toString());
  });
  strokes.observeDeep(() => requestDraw());

  // ---- drawing it ----

  let scale = 1; // CSS pixels per board unit
  let dpr = 1;
  let frame = 0;
  // The stroke being drawn here, and its points not yet in the shared state.
  let active: {map: Y.Map<unknown>; pending: number[]} | null = null;

  const inkOf = (c: unknown): string =>
    c === INK
      ? colors.text
      : typeof c === 'string' && HEX.test(c)
      ? c
      : colors.text;
  const widthOf = (w: unknown, erase: boolean): number => {
    const n =
      typeof w === 'number' && isFinite(w) ? Math.min(Math.max(w, 1), 100) : 6;
    return erase ? n * ERASER_SCALE : n;
  };

  const drawStroke = (m: Y.Map<unknown>, extra: number[] | null) => {
    const ys = m.get('p');
    let p: number[] = ys instanceof Y.Array ? (ys.toArray() as number[]) : [];
    if (extra?.length) p = p.concat(extra);
    if (p.length < 2) return;
    const erase = m.get('e') === true;
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = inkOf(m.get('c'));
    const w = widthOf(m.get('w'), erase);
    ctx.lineWidth = w;
    if (p.length < 4) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], w / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Smoothed: a curve through the midpoints between the points.
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length - 2; i += 2) {
      ctx.quadraticCurveTo(
        p[i],
        p[i + 1],
        (p[i] + p[i + 2]) / 2,
        (p[i + 1] + p[i + 3]) / 2,
      );
    }
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
    ctx.stroke();
  };

  const draw = () => {
    frame = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = scale * dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokes.forEach(m => {
      if (m instanceof Y.Map)
        drawStroke(m, active && active.map === m ? active.pending : null);
    });
  };
  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  const resize = () => {
    const r = board.getBoundingClientRect();
    if (!r.width) return;
    dpr = window.devicePixelRatio || 1;
    scale = r.width / BOARD_W;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    draw();
    renderPeers();
  };
  const sizer = new ResizeObserver(resize);
  sizer.observe(board);

  // ---- the tools ----

  const tool: Tool = {color: INK, size: SIZES[1], erase: false};
  const buttons: {el: HTMLButtonElement; on: () => boolean}[] = [];
  const add = (
    html: string,
    title: string,
    run: () => void,
    on: () => boolean,
    cls = '',
  ) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.innerHTML = html;
    el.title = title;
    el.className = cls;
    el.setAttribute('aria-label', title);
    el.addEventListener('mousedown', ev => ev.preventDefault());
    el.addEventListener('click', () => {
      run();
      refresh();
      sendTool();
    });
    toolbar.appendChild(el);
    buttons.push({el, on});
  };
  const sep = () => {
    const s = document.createElement('span');
    s.className = 'sep';
    toolbar.appendChild(s);
  };
  add(
    PEN_ICON,
    'Pen',
    () => (tool.erase = false),
    () => !tool.erase,
  );
  add(
    ERASER_ICON,
    'Eraser',
    () => (tool.erase = true),
    () => tool.erase,
  );
  sep();
  for (const c of PALETTE) {
    add(
      `<span style="background:${c === INK ? 'var(--text)' : c}"></span>`,
      c === INK ? 'Ink' : `Color ${c}`,
      () => {
        tool.color = c;
        tool.erase = false;
      },
      () => !tool.erase && tool.color === c,
      'sp-swatch',
    );
  }
  sep();
  SIZES.forEach((s, i) => {
    const d = 4 + i * 4;
    add(
      `<span style="width:${d}px;height:${d}px"></span>`,
      ['Fine', 'Medium', 'Thick', 'Marker'][i] ?? `Size ${s}`,
      () => (tool.size = s),
      () => tool.size === s,
      'sp-size',
    );
  });
  const refresh = () => {
    for (const b of buttons) b.el.classList.toggle('on', b.on());
  };
  refresh();

  const setEditable = (editable: boolean) => {
    readOnly = !editable;
    toolbar.style.display = editable ? '' : 'none';
    board.classList.toggle('readonly', !editable);
    if (!editable) endStroke();
  };
  setEditable(!readOnly);

  // ---- where everyone's pen is ----

  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField('tab', o.user.tab);
  awareness.setLocalStateField('user', {
    name: o.user.name.slice(0, 60),
    color: o.user.color,
  });
  awareness.on(
    'update',
    (
      {added, updated}: {added: number[]; updated: number[]},
      origin: unknown,
    ) => {
      if (
        origin === 'local' &&
        [...added, ...updated].includes(awareness.clientID)
      )
        o.onAware?.(
          toB64(encodeAwarenessUpdate(awareness, [awareness.clientID])),
        );
    },
  );
  function sendTool() {
    awareness.setLocalStateField('tool', {
      c: tool.color,
      w: tool.size,
      e: tool.erase,
    });
  }
  sendTool();

  let pointer: {x: number; y: number} | null = null;
  let pointerTimer: ReturnType<typeof setTimeout> | null = null;
  const sendPointer = () => {
    pointerTimer = null;
    awareness.setLocalStateField('pointer', pointer);
  };
  const movePointer = (p: {x: number; y: number} | null) => {
    pointer = p;
    if (p === null) {
      if (pointerTimer) clearTimeout(pointerTimer);
      sendPointer();
    } else if (!pointerTimer)
      pointerTimer = setTimeout(sendPointer, POINTER_MS);
  };

  const peerEls = new Map<number, HTMLElement>();
  function renderPeers() {
    const seen = new Set<number>();
    awareness.getStates().forEach((st, id) => {
      if (id === awareness.clientID) return;
      const p = st?.pointer;
      if (
        !p ||
        typeof p.x !== 'number' ||
        typeof p.y !== 'number' ||
        !isFinite(p.x) ||
        !isFinite(p.y)
      )
        return;
      seen.add(id);
      const color = HEX.test(st?.user?.color) ? st.user.color : '#888888';
      const t = st?.tool ?? {};
      const erase = t.e === true;
      const ring = Math.max(widthOf(t.w, erase) * scale, 8);
      let el = peerEls.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'sp-peer';
        el.innerHTML =
          '<div class="sp-peer-ring"></div><div class="sp-peer-dot"></div><div class="sp-peer-label"></div>';
        peersLayer.appendChild(el);
        peerEls.set(id, el);
      }
      const [ringEl, dotEl, labelEl] = Array.from(el.children) as HTMLElement[];
      ringEl.className = 'sp-peer-ring' + (erase ? ' erase' : '');
      ringEl.style.width = ringEl.style.height = `${ring}px`;
      ringEl.style.borderColor = color;
      dotEl.style.background = erase ? color : inkOf(t.c);
      labelEl.style.background = color;
      labelEl.textContent = String(st?.user?.name ?? 'Someone').slice(0, 60);
      el.style.transform = `translate(${p.x * scale}px, ${p.y * scale}px)`;
    });
    for (const [id, el] of peerEls)
      if (!seen.has(id)) {
        el.remove();
        peerEls.delete(id);
      }
  }
  awareness.on('change', renderPeers);

  // ---- drawing with a pointer ----

  const toBoard = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round(
        Math.min(Math.max((e.clientX - r.left) / scale, 0), BOARD_W),
      ),
      y: Math.round(
        Math.min(Math.max((e.clientY - r.top) / scale, 0), BOARD_H),
      ),
    };
  };

  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const pushPending = () => {
    pushTimer = null;
    if (!active || !active.pending.length) return;
    const pts = active.pending;
    active.pending = [];
    const ys = active.map.get('p');
    if (ys instanceof Y.Array) ydoc.transact(() => ys.push(pts), LOCAL);
  };
  const startStroke = (x: number, y: number) => {
    const map = new Y.Map<unknown>();
    const p = new Y.Array<number>();
    p.push([x, y]);
    map.set('c', tool.color);
    map.set('w', tool.size);
    map.set('e', tool.erase);
    map.set('p', p);
    ydoc.transact(() => strokes.push([map]), LOCAL);
    active = {map, pending: []};
  };
  const addPoint = (x: number, y: number) => {
    if (!active) return;
    const pend = active.pending;
    let lx: number, ly: number;
    if (pend.length) {
      lx = pend[pend.length - 2];
      ly = pend[pend.length - 1];
    } else {
      const ys = active.map.get('p') as Y.Array<number>;
      lx = ys.get(ys.length - 2);
      ly = ys.get(ys.length - 1);
    }
    if (Math.abs(x - lx) + Math.abs(y - ly) < 1) return;
    pend.push(x, y);
    requestDraw();
    if (!pushTimer) pushTimer = setTimeout(pushPending, PUSH_MS);
  };
  function endStroke() {
    if (pushTimer) clearTimeout(pushTimer);
    pushPending();
    active = null;
  }

  // Two fingers scroll the board instead of drawing.
  const touches = new Map<number, {x: number; y: number}>();
  let panning = false;
  const center = () => {
    let x = 0;
    let y = 0;
    touches.forEach(t => {
      x += t.x;
      y += t.y;
    });
    return {x: x / touches.size, y: y / touches.size};
  };
  let lastCenter: {x: number; y: number} | null = null;

  canvas.addEventListener('pointerdown', e => {
    if (readOnly) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // not a live pointer (a synthetic event): draw without capture
    }
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (touches.size >= 2) {
        endStroke();
        panning = true;
        lastCenter = center();
        return;
      }
      if (panning) return;
    }
    e.preventDefault();
    const p = toBoard(e);
    startStroke(p.x, p.y);
    movePointer(p);
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (panning && touches.size >= 2 && lastCenter) {
        const c = center();
        scroll.scrollLeft -= c.x - lastCenter.x;
        scroll.scrollTop -= c.y - lastCenter.y;
        lastCenter = c;
        return;
      }
    }
    if (readOnly) return;
    const p = toBoard(e);
    movePointer(p);
    if (!active) return;
    const evs =
      typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ce of evs.length ? evs : [e]) {
      const q = toBoard(ce);
      addPoint(q.x, q.y);
    }
  });
  const up = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) lastCenter = null;
    if (touches.size === 0) panning = false;
    if (active) endStroke();
    if (e.pointerType !== 'mouse') movePointer(null);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', e => {
    if (e.pointerType === 'mouse' && !active) movePointer(null);
  });

  resize();

  return {
    setEditable,
    setColors(c) {
      colors = c;
      style.textContent = BASE_CSS + CANVAS_CSS + css(colors);
      requestDraw();
      renderPeers();
    },
    insertImage() {
      // a canvas has no images
    },
    getMarkdown: () => '',
    applyChanges(updates) {
      for (const u of updates) {
        try {
          Y.applyUpdate(ydoc, fromB64(u), REMOTE);
        } catch {
          // not a Yjs update: skip it
        }
      }
    },
    setPeers: (peers: Peer[]) => applyPeers(awareness, peers),
    setTitle(title) {
      if (title === ytitle.toString()) return;
      ydoc.transact(() => {
        ytitle.delete(0, ytitle.length);
        ytitle.insert(0, title);
      }, 'title');
    },
    snapshot: (): Snapshot => {
      // What's being drawn right now goes in too.
      if (active) pushPending();
      return {
        markdown: '',
        title: ytitle.toString(),
        y: toB64(Y.encodeStateAsUpdate(ydoc)),
      };
    },
    focus() {
      // nothing to focus: drawing starts with a touch
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      if (pushTimer) clearTimeout(pushTimer);
      if (pointerTimer) clearTimeout(pointerTimer);
      sizer.disconnect();
      awareness.destroy();
      ydoc.destroy();
      o.el.innerHTML = '';
    },
  };
}
