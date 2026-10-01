// Phase 4: program editor and executor. Programs run in the browser and only send motor frames,
// like the official app; tones and songs play from the phone.

import { sleep, loadJSON, saveJSON } from './util.js';

const STORE = { current: 'cb10.program', saved: 'cb10.programs' };
const MAX_DEPTH = 2; // a repeat may contain one more repeat

export const STEP_TYPES = {
  run: 'Run motor',
  wait: 'Wait',
  repeat: 'Repeat',
  tone: 'Play tone',
  song: 'Play song',
  stop: 'Stop all',
};

// ---------- notes and songs ----------

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteFrequency(name) {
  const m = /^([A-G])(#|b)?([0-8])$/.exec(String(name).trim());
  if (!m) throw new Error(`Unknown note: ${name}`);
  const semis = SEMITONES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const n = (Number(m[3]) - 4) * 12 + semis - 9; // semitones from A4
  return 440 * 2 ** (n / 12);
}

export const NOTES = [];
for (let o = 3; o <= 7; o++) for (const n of ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']) NOTES.push(n + o);

// [note or null for a rest, beats]
export const SONGS = {
  1: { name: 'Twinkle Twinkle', beat: 0.35, notes: [['C5', 1], ['C5', 1], ['G5', 1], ['G5', 1], ['A5', 1], ['A5', 1], ['G5', 2], ['F5', 1], ['F5', 1], ['E5', 1], ['E5', 1], ['D5', 1], ['D5', 1], ['C5', 2]] },
  2: { name: 'Ode to Joy', beat: 0.3, notes: [['E5', 1], ['E5', 1], ['F5', 1], ['G5', 1], ['G5', 1], ['F5', 1], ['E5', 1], ['D5', 1], ['C5', 1], ['C5', 1], ['D5', 1], ['E5', 1], ['E5', 1.5], ['D5', 0.5], ['D5', 2]] },
  3: { name: 'Mary Had a Little Lamb', beat: 0.3, notes: [['E5', 1], ['D5', 1], ['C5', 1], ['D5', 1], ['E5', 1], ['E5', 1], ['E5', 2], ['D5', 1], ['D5', 1], ['D5', 2], ['E5', 1], ['G5', 1], ['G5', 2]] },
  4: { name: 'Fanfare', beat: 0.18, notes: [['C5', 1], ['E5', 1], ['G5', 1], ['C6', 3], [null, 1], ['G5', 1], ['C6', 4]] },
};

function createAudio() {
  let ctx = null;
  const active = new Set();
  return {
    // Must be called from a user gesture so the AudioContext may start.
    unlock() {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    },
    async tone(note, seconds, signal) {
      this.unlock();
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = noteFrequency(note);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      gain.gain.setValueAtTime(0.25, t + Math.max(0.02, seconds - 0.03));
      gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      active.add(osc);
      try {
        await sleep(seconds * 1000, signal);
      } finally {
        try { osc.stop(); } catch { /* already stopped */ }
        active.delete(osc);
      }
    },
    async song(id, signal) {
      const song = SONGS[id];
      for (const [note, beats] of song.notes) {
        if (note) await this.tone(note, beats * song.beat * 0.9, signal);
        await sleep(note ? beats * song.beat * 0.1 * 1000 : beats * song.beat * 1000, signal);
      }
    },
    stopAll() {
      for (const osc of active) try { osc.stop(); } catch { /* already stopped */ }
      active.clear();
    },
  };
}

// ---------- model ----------

let nextId = 0;
const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Number(v))) : def);

export function makeStep(type) {
  return normalizeStep({ type });
}

// Accepts untrusted input (imports, storage) and returns a valid step or null.
export function normalizeStep(s, depth = 0) {
  if (!s || typeof s !== 'object' || !(s.type in STEP_TYPES)) return null;
  const id = `s${++nextId}`;
  switch (s.type) {
    case 'run':
      return {
        id, type: 'run',
        motor: ['A', 'B', 'both'].includes(s.motor) ? s.motor : 'A',
        speed: Math.round(num(s.speed, -100, 100, 50)),
        duration: num(s.duration, 0, 60, 1),
        delay: num(s.delay, 0, 60, 0),
      };
    case 'wait':
      return { id, type: 'wait', seconds: num(s.seconds, 0, 60, 1) };
    case 'repeat': {
      if (depth >= MAX_DEPTH) return null;
      const steps = Array.isArray(s.steps) ? s.steps.map(c => normalizeStep(c, depth + 1)).filter(Boolean) : [];
      return { id, type: 'repeat', times: Math.round(num(s.times, 1, 99, 2)), steps };
    }
    case 'tone':
      return { id, type: 'tone', note: NOTES.includes(s.note) ? s.note : 'A5', duration: num(s.duration, 0.05, 10, 0.5) };
    case 'song':
      return { id, type: 'song', song: String(s.song) in SONGS ? Number(s.song) : 1 };
    default:
      return { id, type: 'stop' };
  }
}

export function normalizeProgram(p) {
  const steps = Array.isArray(p?.steps) ? p.steps : Array.isArray(p) ? p : [];
  return { loop: p?.loop === true, steps: steps.map(s => normalizeStep(s)).filter(Boolean) };
}

const strip = steps => steps.map(({ id, ...rest }) => (rest.type === 'repeat' ? { ...rest, steps: strip(rest.steps) } : rest));
export const serialize = program => ({ version: 1, loop: !!program.loop, steps: strip(program.steps) });

// ---------- executor ----------

export async function runSteps(steps, { motors, audio, signal, onStep }) {
  for (const s of steps) {
    signal.throwIfAborted();
    onStep(s.id);
    switch (s.type) {
      case 'run': {
        const keys = s.motor === 'both' ? ['A', 'B'] : [s.motor];
        motors.set(Object.fromEntries(keys.map(k => [k, s.speed])));
        await sleep(s.duration * 1000, signal);
        motors.set(Object.fromEntries(keys.map(k => [k, 0])));
        await sleep(s.delay * 1000, signal);
        break;
      }
      case 'wait':
        await sleep(s.seconds * 1000, signal);
        break;
      case 'repeat':
        for (let i = 0; i < s.times; i++) {
          await runSteps(s.steps, { motors, audio, signal, onStep });
          onStep(s.id);
        }
        break;
      case 'tone':
        await audio.tone(s.note, s.duration, signal);
        break;
      case 'song':
        await audio.song(s.song, signal);
        break;
      case 'stop':
        motors.set({ A: 0, B: 0 });
        break;
    }
  }
}

// ---------- UI ----------

const $ = id => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

const ICONS = {
  run: '<path d="M12 1.5a10.5 10.5 0 1 0 0 21 10.5 10.5 0 0 0 0-21zm0 3a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15z"/><path d="M10.8 4h2.4v16h-2.4zM4 10.8h16v2.4H4z"/><circle cx="12" cy="12" r="3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
  wait: '<path d="M5 2h14v2.5h-1.5v2.2c0 1.8-1.4 3.6-3.6 5.3 2.2 1.7 3.6 3.5 3.6 5.3v2.2H19V22H5v-2.5h1.5v-2.2c0-1.8 1.4-3.6 3.6-5.3C7.9 10.3 6.5 8.5 6.5 6.7V4.5H5zm4 2.5v2.2c0 .5.4 1.4 1.6 2.3h2.8c1.2-.9 1.6-1.8 1.6-2.3V4.5zm3 9.3c-1.9 1.4-3 2.6-3 3.5v2.2h6v-2.2c0-.9-1.1-2.1-3-3.5z"/>',
  time: '<path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm1.2 4v5.1l3.6 2.2-1.2 2-4.8-2.9V6.5z"/>',
  speed: '<path d="M12 4C6.5 4 2 8.5 2 14c0 1.9.5 3.6 1.4 5.1l2.1-1.2A7.6 7.6 0 0 1 4.4 14a7.6 7.6 0 0 1 15.2 0c0 1.4-.4 2.7-1.1 3.9l2.1 1.2c.9-1.5 1.4-3.2 1.4-5.1 0-5.5-4.5-10-10-10zm4.6 4.7-4.1 3.8a2 2 0 1 0 1.3 1.4z"/>',
  loop: '<path d="M7 7.5a4.5 4.5 0 1 0 0 9c1.8 0 3-1.1 5-4.5 2-3.4 3.2-4.5 5-4.5a4.5 4.5 0 1 1 0 9c-1.8 0-3-1.1-5-4.5-2-3.4-3.2-4.5-5-4.5z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  repeat: '<path d="M7 7h9V4l5 4.5-5 4.5v-3H8v3H5V9a2 2 0 0 1 2-2zm10 10H8v3l-5-4.5L8 11v3h8v-3h3v4a2 2 0 0 1-2 2z"/>',
  tone: '<path d="M10 3h9v4h-6v10a4 4 0 1 1-3-3.9z"/>',
  song: '<path d="M8 4l12-2v13a3.5 3.5 0 1 1-2.5-3.4V6.3L10 7.6V17a3.5 3.5 0 1 1-2-3.2z"/>',
  flag: '<path d="M5 2h2v20H5zM8 3h11l-2.5 4L19 11H8z"/>',
};
const icon = (name, cls = '') => h('span', { class: `bicon-wrap ${cls}`, 'aria-hidden': 'true', html: `<svg class="bicon" viewBox="0 0 24 24">${ICONS[name]}</svg>` });

const CATEGORY = { run: 'motion', stop: 'motion', wait: 'control', repeat: 'control', tone: 'sound', song: 'sound' };
const PALETTE = [['run', 'motor'], ['stop', 'stop motors'], ['wait', 'wait'], ['repeat', 'repeat'], ['tone', 'note'], ['song', 'song']];

// kids: blocks show pictures instead of words (the words stay as aria-labels).
export function createProgramEditor(ble, motors, { kids = false } = {}) {
  const audio = createAudio();
  let program = normalizeProgram(loadJSON(STORE.current, null) || { steps: [makeStep('run'), makeStep('tone')] });
  let ctl = null;
  let wakeLock = null;
  let selectedId = null;
  let staleLook = false;
  const scriptEl = $('progSteps');

  const save = () => saveJSON(STORE.current, serialize(program));

  function locate(id, list = program.steps, depth = 0) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { list, index: i, depth, step: list[i] };
      if (list[i].type === 'repeat') {
        const found = locate(id, list[i].steps, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  // ----- inline fields -----

  function numField(step, key, { min, max, inc = 1, label }) {
    return h('input', {
      type: 'number', min: String(min), max: String(max), step: String(inc), inputmode: 'decimal',
      value: String(step[key]), 'aria-label': label,
      onchange: ev => {
        step[key] = num(ev.target.value, min, max, step[key]);
        ev.target.value = step[key];
        save();
      },
    });
  }

  function selField(value, options, label, onChange) {
    const el = h('select', { 'aria-label': label, onchange: ev => { onChange(ev.target.value); save(); } },
      options.map(([v, t]) => h('option', { value: String(v) }, t)));
    el.value = String(value);
    return el;
  }

  // A word between the fields, or in the kids' look a small picture (or nothing).
  const word = (text, pic) => (kids ? pic && icon(pic, 'unit') : text);

  function runFields(s) {
    const mag = { value: Math.abs(s.speed) };
    const dirs = kids ? [['fwd', '\u2191'], ['back', '\u2193']] : [['fwd', 'forward'], ['back', 'backward']];
    const dir = selField(s.speed < 0 ? 'back' : 'fwd', dirs, 'Direction', v => {
      s.speed = (v === 'back' ? -1 : 1) * Math.abs(s.speed);
    });
    const speed = h('input', {
      type: 'number', min: '0', max: '100', step: '10', inputmode: 'numeric', value: String(mag.value), 'aria-label': 'Speed',
      onchange: ev => {
        const v = Math.round(num(ev.target.value, 0, 100, Math.abs(s.speed)));
        ev.target.value = v;
        s.speed = (dir.value === 'back' ? -1 : 1) * v;
        save();
      },
    });
    return [
      word('motor'),
      selField(s.motor, [['A', 'A'], ['B', 'B'], ['both', 'A+B']], 'Motor', v => { s.motor = v; }),
      dir, word('speed', 'speed'), speed, word('for', 'time'), numField(s, 'duration', { min: 0, max: 60, inc: 0.5, label: 'Seconds' }), word('sec'),
    ];
  }

  function blockBody(s) {
    const secs = (key, max, inc) => numField(s, key, { min: key === 'seconds' ? 0 : 0.05, max, inc, label: 'Seconds' });
    switch (s.type) {
      case 'run': return runFields(s);
      case 'stop': return [word('stop motors')];
      case 'wait': return [word('wait'), secs('seconds', 60, 0.5), word('sec')];
      case 'repeat': return [word('repeat'), numField(s, 'times', { min: 1, max: 99, label: 'Times' }), kids ? '\u00d7' : 'times'];
      case 'tone': return [word('play note'), selField(s.note, NOTES.map(n => [n, n]), 'Note', v => { s.note = v; }), word('for', 'time'), secs('duration', 10, 0.25), word('sec')];
      case 'song': return [word('play song'), selField(s.song, Object.entries(SONGS).map(([k, v]) => [k, v.name]), 'Song', v => { s.song = Number(v); })];
      default: return [];
    }
  }

  // ----- blocks -----

  function blockEl(s, depth) {
    const cat = `cat-${CATEGORY[s.type]}`;
    const head = h('div', { class: `block ${cat}${s.type === 'repeat' ? ' c-head' : ''}`, 'aria-label': STEP_TYPES[s.type] }, icon(s.type), blockBody(s));
    const wrap = h('div', { class: 'bwrap', 'data-id': s.id });
    const grab = e => startPending(e, { kind: 'move', id: s.id });
    if (s.type === 'repeat') {
      const body = h('div', { class: `c-body ${cat}`, 'data-list': s.id },
        s.steps.length ? s.steps.map(c => blockEl(c, depth + 1)) : h('div', { class: 'empty' }, kids ? '\u2193' : 'Drop blocks in here'));
      const foot = h('div', { class: `c-foot ${cat}` });
      wrap.append(h('div', { class: 'c-block' }, head, body, foot));
      // Tapping anywhere on the repeat (its arm, foot or empty inside) selects it.
      body.addEventListener('click', e => {
        // Only taps on this repeat's own inside: the event also bubbles through outer repeats.
        if (e.target.closest('.c-body') === body && (e.target === body || e.target.classList.contains('empty'))) select(s.id);
      });
      foot.addEventListener('click', () => select(s.id));
      foot.addEventListener('pointerdown', grab);
    } else {
      wrap.append(head);
    }
    head.addEventListener('pointerdown', grab);
    head.addEventListener('click', () => select(s.id));
    head.addEventListener('focusin', () => select(s.id));
    if (s.id === selectedId) wrap.classList.add('selected');
    return wrap;
  }

  function toolbar() {
    const act = fn => () => { if (!ctl) fn(); };
    const runThis = () => {
      const at = locate(selectedId);
      if (at) run([at.step]);
    };
    return h('div', { class: 'toolbar' },
      h('button', { type: 'button', class: 'key key-green', 'aria-label': 'Run just this block', onclick: act(runThis), html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>' }),
      h('button', { type: 'button', class: 'key', 'aria-label': 'Move up', onclick: act(() => move(-1)) }, '↑'),
      h('button', { type: 'button', class: 'key', 'aria-label': 'Move down', onclick: act(() => move(1)) }, '↓'),
      h('button', { type: 'button', class: 'key', 'aria-label': 'Duplicate', onclick: act(duplicate) }, '⧉'),
      h('button', { type: 'button', class: 'key', 'aria-label': 'Delete', onclick: act(remove) }, '✕'),
    );
  }

  // Selecting only moves the highlight and toolbar, so a tapped input keeps its focus.
  function select(id) {
    if (ctl || id === selectedId) return;
    selectedId = id;
    scriptEl.querySelector('.bwrap.selected')?.classList.remove('selected');
    scriptEl.querySelector('.toolbar')?.remove();
    const wrap = id && scriptEl.querySelector(`.bwrap[data-id="${id}"]`);
    if (!wrap) return;
    wrap.classList.add('selected');
    const bar = toolbar();
    wrap.append(bar);
    // The bubble may stick out past the program area, but not off the screen.
    const over = bar.getBoundingClientRect().right - (document.documentElement.clientWidth - 4);
    if (over > 0) bar.style.setProperty('--nudge', `${-over}px`);
  }

  function hat() {
    return h('div', { class: 'block hat cat-event' }, icon('flag'), word('when'), h('span', { class: 'flag-chip', 'aria-label': 'Run' }, '▶'), word('is tapped'),
      program.loop && h('span', { class: 'loop-chip', 'aria-label': 'over and over' }, icon('loop'), word('forever')));
  }

  function render() {
    const keep = selectedId;
    selectedId = null;
    scriptEl.replaceChildren(
      hat(),
      h('div', { class: 'stack', 'data-list': 'root' },
        program.steps.length ? program.steps.map(s => blockEl(s, 0)) : h('p', { class: 'hint' }, 'Drag a coloured block here, or tap one above.')),
    );
    if (keep && locate(keep)) select(keep);
  }

  function changed() {
    save();
    render();
    $('progLoop').setAttribute('aria-pressed', String(program.loop));
  }

  function move(d) {
    const at = locate(selectedId);
    if (!at) return;
    const j = at.index + d;
    if (j < 0 || j >= at.list.length) return;
    [at.list[at.index], at.list[j]] = [at.list[j], at.list[at.index]];
    changed();
  }

  function remove() {
    const at = locate(selectedId);
    if (!at) return;
    at.list.splice(at.index, 1);
    selectedId = null;
    changed();
  }

  function duplicate() {
    const at = locate(selectedId);
    if (!at) return;
    const copy = normalizeStep(serialize({ steps: [at.step] }).steps[0], at.depth);
    if (!copy) return;
    at.list.splice(at.index + 1, 0, copy);
    selectedId = copy.id;
    changed();
  }

  // New blocks go inside a selected repeat, after any other selected block, or at the end.
  function add(type) {
    if (ctl) return;
    const at = selectedId ? locate(selectedId) : null;
    let list = program.steps;
    let index = list.length;
    let depth = 0;
    if (at?.step.type === 'repeat' && at.depth + 1 < MAX_DEPTH + (type === 'repeat' ? 0 : 1)) {
      list = at.step.steps;
      index = list.length;
      depth = at.depth + 1;
    } else if (at) {
      ({ list, depth } = at);
      index = at.index + 1;
    }
    const step = normalizeStep({ type }, depth);
    if (!step) return; // a repeat nested too deep
    list.splice(index, 0, step);
    selectedId = step.id;
    changed();
    scriptEl.querySelector(`.bwrap[data-id="${step.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderPalette() {
    $('palette').replaceChildren(...PALETTE.map(([type, label]) => {
      const btn = h('button', {
        type: 'button', class: `pblock cat-${CATEGORY[type]}`, 'aria-label': `Add ${label} block`, title: label, onclick: () => add(type),
      }, icon(type), word(label));
      btn.addEventListener('pointerdown', e => startPending(e, { kind: 'new', type, el: btn }));
      return btn;
    }));
  }

  // ----- drag and drop -----
  // Mouse: drag after a few pixels. Touch on the script: press and hold, so a swipe still scrolls.
  // Touch on the palette drags right away (the palette is touch-action: none).
  const LONG_PRESS_MS = 220;
  const SLOP = 6;
  let pending = null;
  let drag = null;
  let suppressClick = false;

  const depthOf = step => (step.type === 'repeat' ? 1 + Math.max(0, ...step.steps.map(depthOf)) : 0);
  const inside = (r, x, y, pad = 0) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

  function listFor(el) {
    if (el.dataset.list === 'root') return { list: program.steps, depth: 0 };
    const at = locate(el.dataset.list);
    return at && { list: at.step.steps, depth: at.depth + 1 };
  }

  function startPending(e, info) {
    if (ctl || drag || e.button > 0 || e.target.closest('input, select, .toolbar')) return;
    const touchHold = e.pointerType !== 'mouse' && info.kind === 'move';
    pending = { ...info, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touchHold };
    if (touchHold) pending.timer = setTimeout(() => begin(pending.x, pending.y), LONG_PRESS_MS);
  }

  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function begin(x, y) {
    const p = pending;
    cancelPending();
    if (!p || ctl) return;
    const at = p.kind === 'move' ? locate(p.id) : null;
    if (p.kind === 'move' && !at) return;
    const step = at ? at.step : makeStep(p.type);
    const source = at ? scriptEl.querySelector(`.bwrap[data-id="${p.id}"]`) : null;
    const rect = (source ?? p.el).getBoundingClientRect();
    // Hide (not remove) the toolbar: removing it would shift the blocks below under the pointer.
    document.body.classList.add('block-dragging');
    const ghost = h('div', { class: 'ghost', 'aria-hidden': 'true' }, at ? source.cloneNode(true) : blockEl(step, 0));
    ghost.style.width = `${Math.min(Math.max(rect.width, 220), 340)}px`;
    document.body.append(ghost);
    source?.classList.add('dragging');
    const slot = h('div', { class: `drop-line cat-${CATEGORY[step.type]}-slot`, 'aria-hidden': 'true', hidden: true });
    document.body.append(slot);
    drag = {
      kind: p.kind, step, source, ghost, depth: depthOf(step), target: null, slot, x, y,
      dx: at ? Math.min(x - rect.left, 60) : 30, dy: at ? Math.min(y - rect.top, 26) : 24,
    };
    $('palette').classList.toggle('trash', p.kind === 'move');
    navigator.vibrate?.(8);
    moveTo(x, y);
    requestAnimationFrame(autoScroll);
  }

  function findTarget(x, y) {
    const lists = [...scriptEl.querySelectorAll('[data-list]')].filter(el => !drag.source?.contains(el));
    let best = null;
    for (const el of lists) {
      const r = el.getBoundingClientRect();
      // A repeat's bottom bar counts as its inside: dropping just under its last block means "in here".
      const bottom = r.bottom + (el.dataset.list === 'root' ? 10 : 18);
      if (x >= r.left - 10 && x <= r.right + 10 && y >= r.top - 10 && y <= bottom) best = el; // later = deeper
    }
    const root = scriptEl.querySelector('[data-list="root"]');
    if (!best && root) {
      const r = root.getBoundingClientRect();
      if (x >= r.left - 40 && x <= r.right + 40 && y >= r.top - 70) best = root;
    }
    if (!best) return null;
    const info = listFor(best);
    if (!info || info.depth + drag.depth > MAX_DEPTH) return null;
    const kids = [...best.children].filter(c => c.classList.contains('bwrap') && c !== drag.source);
    let index = kids.length;
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (y < r.top + Math.min(r.height / 2, 28)) { index = i; break; }
    }
    return { el: best, index, kids };
  }

  // The insertion marker floats above the script instead of opening a gap, so the layout never
  // shifts under the finger and what you see is where the block lands.
  function placeSlot(t) {
    drag.target = t;
    scriptEl.querySelector('.drop-into')?.classList.remove('drop-into');
    if (!t || t.trash) {
      drag.slot.hidden = true;
      return;
    }
    const lr = t.el.getBoundingClientRect();
    let y;
    if (t.index < t.kids.length) y = t.kids[t.index].getBoundingClientRect().top - 5;
    else if (t.kids.length) y = t.kids.at(-1).getBoundingClientRect().bottom + 1;
    else y = lr.top + 2;
    if (!t.kids.length && t.el.dataset.list !== 'root') t.el.classList.add('drop-into');
    Object.assign(drag.slot.style, { left: `${lr.left}px`, top: `${y}px`, width: `${Math.max(lr.width, 120)}px` });
    drag.slot.hidden = false;
  }

  function moveTo(x, y) {
    drag.x = x;
    drag.y = y;
    drag.ghost.style.transform = `translate(${x - drag.dx}px, ${y - drag.dy}px) rotate(1.5deg)`;
    const overTrash = drag.kind === 'move' && inside($('palette').getBoundingClientRect(), x, y, 8);
    $('palette').classList.toggle('trash-hot', overTrash);
    placeSlot(overTrash ? { trash: true } : findTarget(x, y));
  }

  // Scroll only when the finger is pushed against the top bar or the bottom edge, so holding a
  // block over the lower part of the script never moves the drop target away.
  function autoScroll() {
    if (!drag) return;
    const top = document.querySelector('.bar').getBoundingClientRect().bottom + 16;
    const bottom = innerHeight - 40;
    const v = drag.y < top ? -Math.ceil((top - drag.y) / 4) : drag.y > bottom ? Math.ceil((drag.y - bottom) / 4) : 0;
    if (v) {
      scrollBy(0, v);
      moveTo(drag.x, drag.y);
    }
    requestAnimationFrame(autoScroll);
  }

  function finish(dropped) {
    cancelPending();
    if (!drag) return;
    const { target, kind, step } = drag;
    drag.ghost.remove();
    drag.slot.remove();
    scriptEl.querySelector('.drop-into')?.classList.remove('drop-into');
    drag.source?.classList.remove('dragging');
    $('palette').classList.remove('trash', 'trash-hot');
    document.body.classList.remove('block-dragging');
    drag = null;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    if (!dropped || !target) return;
    if (kind === 'move') {
      const at = locate(step.id);
      if (!at) return;
      const dest = target.trash ? null : listFor(target.el); // resolve before removing from the source
      at.list.splice(at.index, 1); // the target index already ignores the dragged block
      if (dest) dest.list.splice(target.index, 0, step);
      selectedId = dest ? step.id : null;
    } else if (!target.trash) {
      listFor(target.el).list.splice(target.index, 0, step);
      selectedId = step.id;
    }
    changed();
  }

  document.addEventListener('pointermove', e => {
    if (drag) {
      e.preventDefault();
      moveTo(e.clientX, e.clientY);
      return;
    }
    if (!pending || e.pointerId !== pending.pointerId) return;
    const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (pending.touchHold) {
      if (dist > 10) cancelPending(); // a swipe: let the page scroll
    } else if (dist > SLOP) {
      begin(e.clientX, e.clientY);
    }
  }, { passive: false });
  // Once a touch drag has started, keep the browser from turning the gesture into a scroll.
  document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener('pointerup', () => finish(true));
  document.addEventListener('pointercancel', () => finish(false));
  document.addEventListener('click', e => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  document.addEventListener('contextmenu', e => { if (drag || pending?.touchHold) e.preventDefault(); });

  // ----- running -----

  function highlight(id) {
    for (const el of scriptEl.querySelectorAll('.bwrap.running')) el.classList.remove('running');
    if (id) scriptEl.querySelector(`.bwrap[data-id="${id}"]`)?.classList.add('running');
  }

  function setRunning(running, status) {
    $('progRun').disabled = running;
    $('progEditor').disabled = running;
    for (const b of $('palette').children) b.disabled = running;
    $('progStatus').textContent = status;
  }

  // Stays usable during a run: switching it off lets the current round finish, then the run ends.
  function renderLoop() {
    $('progLoop').setAttribute('aria-pressed', String(program.loop));
    scriptEl.firstElementChild?.replaceWith(hat());
  }
  $('progLoop').addEventListener('click', () => {
    program.loop = !program.loop;
    save();
    renderLoop();
  });

  async function requestWakeLock() {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      wakeLock = null; // not granted (battery saver, unsupported); the run continues
    }
  }

  // Runs the whole program, or just the given steps (one block, or a repeat with its contents).
  async function run(steps = program.steps) {
    if (ctl) return;
    audio.unlock();
    const single = steps !== program.steps;
    if (!single) select(null);
    ctl = new AbortController();
    const { signal } = ctl;
    const what = kids ? '▶' : single ? 'Running one block' : 'Running';
    const noHub = ble.state === 'connected' ? '' : kids ? ' (no hub)' : ' (no hub: motors stay still)';
    const looping = () => !single && program.loop && program.steps.length > 0;
    setRunning(true, `${what}${kids ? '' : '…'}${noHub}`);
    await requestWakeLock();
    let status = kids ? '✓' : 'Done!';
    try {
      for (let round = 1; ; round++) {
        if (round > 1) $('progStatus').textContent = `${what}${kids ? ' ' : ' · round '}${round}${noHub}`;
        const t0 = performance.now();
        await runSteps(steps, { motors, audio, signal, onStep: highlight });
        if (!looping()) break;
        // A program without any waits would otherwise spin as fast as it can.
        await sleep(Math.max(0, 250 - (performance.now() - t0)), signal);
      }
      motors.set({ A: 0, B: 0 });
    } catch (e) {
      status = signal.aborted ? (kids ? '■' : 'Stopped') : `Oops: ${e.message}`;
      if (!signal.aborted) motors.stopAll('program error');
    } finally {
      ctl = null;
      audio.stopAll();
      highlight(null);
      wakeLock?.release().catch(() => {});
      wakeLock = null;
      if (staleLook) rerender();
      setRunning(false, status);
    }
  }

  // Halts the sequence without sending anything (the top-bar STOP then stops the motors);
  // safe to call when nothing is running.
  function abort(reason) {
    if (!ctl) return;
    ctl.abort(new Error(reason));
    audio.stopAll();
  }

  // ----- my programs -----

  const saved = () => loadJSON(STORE.saved, {}) || {};

  function renderSaved() {
    const all = saved();
    const names = Object.keys(all).sort();
    $('progSavedList').replaceChildren(...(names.length
      ? names.map(n => h('span', { class: 'saved-item' },
        h('button', { type: 'button', 'aria-label': `Open ${n}`, onclick: () => load(n) }, n),
        h('button', { type: 'button', 'aria-label': `Delete ${n}`, onclick: () => del(n) }, '✕')))
      : [h('span', { class: 'hint' }, 'Nothing saved yet.')]));
  }

  function load(name) {
    const p = saved()[name];
    if (!p || ctl) return;
    program = normalizeProgram(p);
    $('progName').value = name;
    selectedId = null;
    changed();
  }

  function del(name) {
    const all = saved();
    if (!all[name] || !confirm(`Delete "${name}"?`)) return;
    delete all[name];
    saveJSON(STORE.saved, all);
    renderSaved();
  }

  $('progSave').addEventListener('click', () => {
    const name = $('progName').value.trim();
    if (!name) return $('progName').focus();
    const all = saved();
    if (all[name] && !confirm(`Replace "${name}"?`)) return;
    all[name] = serialize(program);
    saveJSON(STORE.saved, all);
    renderSaved();
  });
  $('progNew').addEventListener('click', () => {
    if (ctl || (program.steps.length && !confirm('Start a new empty program?'))) return;
    program = { loop: false, steps: [] };
    selectedId = null;
    $('progName').value = '';
    changed();
  });
  $('progExport').addEventListener('click', () => {
    const name = ($('progName').value.trim() || 'program').replace(/[^\w-]+/g, '_');
    const url = URL.createObjectURL(new Blob([JSON.stringify(serialize(program), null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `cb10-${name}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('progImport').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file || ctl) return;
    try {
      program = normalizeProgram(JSON.parse(await file.text()));
      $('progName').value = file.name.replace(/\.json$/i, '').replace(/^cb10-/, '');
      selectedId = null;
      changed();
    } catch (e) {
      $('progStatus').textContent = `Couldn't open that file: ${e.message}`;
    }
  });

  $('progRun').addEventListener('click', () => run());

  // Re-renders without losing the program; a run in progress keeps its look (and highlight) until it ends.
  function setKids(on) {
    kids = !!on;
    if (ctl) staleLook = true;
    else rerender();
  }
  function rerender() {
    staleLook = false;
    renderPalette();
    render();
  }

  renderPalette();
  render();
  renderLoop();
  renderSaved();
  setRunning(false, '');
  return { abort, setKids, get running() { return !!ctl; } };
}
