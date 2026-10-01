// Phase 3: motor controller (shared with the program editor) and the control panel UI.

import { PROTOCOL, MOTORS, CHANNELS, encodeMotors, encodeStop, encodeStopAll, decodeNotification } from './protocol.js';
import { loadJSON, saveJSON, sleep, toHex } from './util.js';

export const CMD_KEY = `${PROTOCOL.services.fff0}/${PROTOCOL.characteristics.fff2}`;
export const REPLY_KEY = `${PROTOCOL.services.fff0}/${PROTOCOL.characteristics.fff1}`;

const STORE = 'cb10.motors';
const clampSpeed = v => Math.max(-100, Math.min(100, Math.round(Number(v) || 0)));
const clampMax = v => (Number.isFinite(v) ? Math.max(10, Math.min(100, Math.round(v))) : 100);
// The measured motor stalls below ~20 % (docs/PROTOCOL.md), so that is the default dead zone.
const clampMin = v => (Number.isFinite(v) ? Math.max(0, Math.min(50, Math.round(v))) : 20);

export function createMotors(ble) {
  const saved = loadJSON(STORE, {}) || {};
  const cfg = {
    channel: CHANNELS.includes(saved.channel) ? saved.channel : 1,
    autoDetect: saved.autoDetect !== false,
    springBack: saved.springBack !== false,
    A: { invert: !!saved.A?.invert, max: clampMax(saved.A?.max), min: clampMin(saved.A?.min) },
    B: { invert: !!saved.B?.invert, max: clampMax(saved.B?.max), min: clampMin(saved.B?.min) },
  };
  const speeds = { A: 0, B: 0 };
  const events = new EventTarget();
  const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));
  const save = () => saveJSON(STORE, cfg);
  const live = () => ble.state === 'connected';

  // Speed actually sent: 1..100 % is spread over dead zone..max, so every non-zero value turns the
  // motor and the top of the range is the user's cap; then the per-motor direction toggle.
  function output(m) {
    const { invert, max, min } = cfg[m];
    const s = speeds[m];
    if (!s) return 0;
    const lo = Math.min(min, max);
    const out = Math.sign(s) * (lo + (Math.abs(s) / 100) * (max - lo));
    return invert ? -out : out;
  }

  function send() {
    if (!live()) return;
    ble.writeLatest('motors', CMD_KEY, encodeMotors({ channel: cfg.channel, A: output('A'), B: output('B') }));
  }

  function set(values) {
    for (const m of MOTORS) if (m in values) speeds[m] = clampSpeed(values[m]);
    emit('change');
    send();
  }

  async function stopAll(reason) {
    speeds.A = 0;
    speeds.B = 0;
    emit('change');
    if (!live()) return;
    ble.clearPending(`STOP ALL (${reason})`);
    // The selected channel first so the frame that matters goes out immediately; then the rest, as the app does.
    for (const [i, f] of encodeStopAll(cfg.channel).entries()) {
      if (i) await sleep(PROTOCOL.minCommandIntervalMs);
      await ble.write(CMD_KEY, f, { note: i ? undefined : `STOP ALL (${reason})` }).catch(() => {});
    }
  }

  function nextReply(ms) {
    return new Promise(resolve => {
      const done = bytes => {
        clearTimeout(timer);
        ble.removeEventListener('value', onValue);
        resolve(bytes);
      };
      const onValue = ev => {
        if (ev.detail.key === REPLY_KEY && ev.detail.dir === 'N') done(ev.detail.bytes);
      };
      const timer = setTimeout(() => done(null), ms);
      ble.addEventListener('value', onValue);
    });
  }

  async function ensureReplies() {
    if (!ble.subscribed.has(REPLY_KEY)) await ble.subscribe(REPLY_KEY);
  }

  // Same as the app's connect routine: a stop frame per channel; the hub answers "ok" only on its own.
  async function detectChannel() {
    if (!live()) throw new Error('Not connected.');
    await ensureReplies();
    for (const ch of CHANNELS) {
      const reply = nextReply(500);
      await ble.write(CMD_KEY, encodeStop(ch), { note: `detect channel ${ch}` });
      const bytes = await reply;
      if (bytes && decodeNotification(bytes).status === 'ok') {
        setChannel(ch);
        ble.info(`Hub answered on channel ${ch}`);
        return ch;
      }
    }
    ble.info('Channel detection: no channel answered');
    return null;
  }

  function setChannel(ch) {
    if (!CHANNELS.includes(ch)) return;
    cfg.channel = ch;
    save();
    emit('change');
  }

  function configure(m, patch) {
    if (patch.invert != null) cfg[m].invert = !!patch.invert;
    if (patch.max != null) cfg[m].max = clampMax(patch.max);
    if (patch.min != null) cfg[m].min = clampMin(patch.min);
    save();
    emit('change');
    send();
  }

  function setOption(name, value) {
    cfg[name] = !!value;
    save();
    emit('change');
  }

  ble.addEventListener('value', ev => {
    if (ev.detail.key === REPLY_KEY) emit('reply', { bytes: ev.detail.bytes, decoded: decodeNotification(ev.detail.bytes) });
  });
  ble.addEventListener('state', ev => {
    if (ev.detail !== 'connected') return;
    ensureReplies()
      .then(() => (cfg.autoDetect ? detectChannel() : stopAll('connect')))
      .catch(() => {});
  });
  ble.addEventListener('disconnected', () => {
    speeds.A = 0;
    speeds.B = 0;
    emit('change');
  });

  return {
    cfg, speeds, output, set, stopAll, detectChannel, setChannel, configure, setOption,
    on: (type, fn) => events.addEventListener(type, fn),
  };
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

const fmt = v => (v > 0 ? `+${v}` : String(v));
const ARROW_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 11h-6v5H9v-5H3z"/></svg>';
const ARROW_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20l9-11h-6V4H9v5H3z"/></svg>';
const PAD = 18; // half the thumb height, so both ends stay reachable

// Big vertical slider, -100 (bottom) … +100 (top), 0 in the middle.
function vslider(label, onValue, onRelease) {
  const fill = h('div', { class: 'vs-fill' });
  const thumb = h('div', { class: 'vs-thumb' });
  const el = h('div', {
    class: 'vs', role: 'slider', tabindex: '0', 'aria-label': label, 'aria-orientation': 'vertical',
    'aria-valuemin': '-100', 'aria-valuemax': '100', 'aria-valuenow': '0',
  }, h('div', { class: 'vs-track' }), fill, h('div', { class: 'vs-zero' }), thumb);
  let dragging = false;

  const fromY = y => {
    const r = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (y - r.top - PAD) / (r.height - 2 * PAD)));
    const v = Math.round(100 - t * 200);
    return Math.abs(v) < 4 ? 0 : v; // small snap to stop around the middle line
  };
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    onValue(fromY(e.clientY));
  });
  el.addEventListener('pointermove', e => { if (dragging) onValue(fromY(e.clientY)); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    onRelease();
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, end);
  el.addEventListener('keydown', e => {
    const cur = Number(el.getAttribute('aria-valuenow'));
    const next = { ArrowUp: cur + 5, ArrowRight: cur + 5, ArrowDown: cur - 5, ArrowLeft: cur - 5, PageUp: cur + 25, PageDown: cur - 25, Home: 100, End: -100, 0: 0, Delete: 0 }[e.key];
    if (next == null) return;
    e.preventDefault();
    onValue(Math.max(-100, Math.min(100, next)));
  });

  function set(v) {
    const pos = (100 - v) / 200; // 0 = top, 1 = bottom
    const span = `(100% - ${2 * PAD}px)`;
    thumb.style.top = `calc(${PAD}px + ${span} * ${pos})`;
    fill.style.top = `calc(${PAD}px + ${span} * ${Math.min(pos, 0.5)})`;
    fill.style.height = `calc(${span} * ${Math.abs(pos - 0.5)})`;
    el.setAttribute('aria-valuenow', String(v));
    el.setAttribute('aria-valuetext', `${fmt(v)} percent`);
  }
  set(0);
  return { el, set };
}

function holdKey(m, dir, motors, holding) {
  const btn = h('button', { type: 'button', class: 'hold', 'aria-label': `Motor ${m} ${dir > 0 ? 'forward' : 'backward'} (hold)`, html: dir > 0 ? ARROW_UP : ARROW_DOWN });
  // No pointer capture, so sliding off the key counts as letting go.
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    holding.add(btn);
    btn.classList.add('active');
    motors.set({ [m]: dir * 100 });
  });
  btn.release = () => {
    if (!holding.delete(btn)) return;
    btn.classList.remove('active');
    motors.set({ [m]: 0 });
  };
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, btn.release);
  btn.addEventListener('contextmenu', e => e.preventDefault());
  return btn;
}

export function createControlPanel(ble, motors, { isActive }) {
  const drive = {};
  const sets = {};
  const holding = new Set();

  for (const m of MOTORS) {
    const readout = h('output', { class: 'display', 'aria-label': `Motor ${m} speed` }, '0');
    const slider = vslider(`Motor ${m} speed`, v => motors.set({ [m]: v }), () => {
      if (motors.cfg.springBack) motors.set({ [m]: 0 });
    });
    const up = holdKey(m, 1, motors, holding);
    const down = holdKey(m, -1, motors, holding);
    drive[m] = {
      el: h('div', { class: 'mcol', 'data-motor': m },
        h('div', { class: 'mhead' }, h('span', { class: 'mbadge', 'aria-hidden': 'true' }, m), readout),
        up, slider.el, down),
      readout, slider, holds: [up, down],
    };

    const invert = h('input', { type: 'checkbox', onchange: e => motors.configure(m, { invert: e.target.checked }) });
    const maxOut = h('output');
    const max = h('input', { type: 'range', min: '10', max: '100', step: '5', oninput: e => motors.configure(m, { max: Number(e.target.value) }) });
    const minOut = h('output');
    const min = h('input', { type: 'range', min: '0', max: '50', step: '1', oninput: e => motors.configure(m, { min: Number(e.target.value) }) });
    sets[m] = { invert, max, maxOut, min, minOut };
    sets[m].el = h('div', { class: 'mset', 'data-motor': m },
      h('h3', {}, h('span', { class: 'mbadge', 'aria-hidden': 'true' }, m), `Motor ${m}`),
      h('label', { class: 'check' }, invert, 'Spin the other way'),
      h('label', {}, h('span', {}, 'Top speed'), max, maxOut),
      h('label', { title: 'Lowest speed at which this motor still turns; the slider starts here' }, h('span', {}, 'Dead zone'), min, minOut),
    );
  }
  $('motorPanels').replaceChildren(...MOTORS.map(m => drive[m].el));
  $('motorSettings').replaceChildren(...MOTORS.map(m => sets[m].el));

  const chButtons = $('channelButtons');
  chButtons.replaceChildren(...CHANNELS.map(ch => h('button', {
    type: 'button', 'aria-pressed': 'false', 'aria-label': `Channel ${ch}`,
    onclick: async () => {
      if (ch === motors.cfg.channel) return;
      await motors.stopAll('channel change');
      motors.setChannel(ch);
    },
  }, String(ch))));

  $('detectChannel').addEventListener('click', () => motors.detectChannel().catch(() => {}));
  $('autoDetect').addEventListener('change', ev => motors.setOption('autoDetect', ev.target.checked));
  $('springBack').addEventListener('change', ev => motors.setOption('springBack', ev.target.checked));
  $('stopAllBtn').addEventListener('click', () => {
    releaseAll();
    motors.stopAll('button');
  });

  function render() {
    const live = ble.state === 'connected';
    for (const m of MOTORS) {
      const v = motors.speeds[m];
      drive[m].readout.textContent = fmt(v);
      drive[m].slider.set(v);
      drive[m].el.classList.toggle('off', !live);
      const c = motors.cfg[m];
      sets[m].invert.checked = c.invert;
      sets[m].max.value = c.max;
      sets[m].maxOut.textContent = `${c.max}%`;
      sets[m].min.value = c.min;
      sets[m].minOut.textContent = `${c.min}%`;
    }
    [...chButtons.children].forEach((b, i) => b.setAttribute('aria-pressed', String(CHANNELS[i] === motors.cfg.channel)));
    $('autoDetect').checked = motors.cfg.autoDetect;
    $('springBack').checked = motors.cfg.springBack;
    $('detectChannel').disabled = !live;
  }

  motors.on('change', render);
  ble.addEventListener('state', render);
  motors.on('reply', ev => {
    const { bytes, decoded } = ev.detail;
    const meaning = decoded.status ? `${decoded.status}${decoded.channel ? `, channel ${decoded.channel}` : ''}` : decoded.valid ? 'valid frame' : 'not a frame';
    $('lastReply').textContent = `${toHex(bytes)}  (${meaning})`;
  });

  function releaseAll() {
    for (const m of MOTORS) drive[m].holds.forEach(b => b.release());
  }

  // Keyboard: W/S motor A, I/K motor B, Space = stop all.
  const KEYS = { w: ['A', 1], s: ['A', -1], i: ['B', 1], k: ['B', -1] };
  // Sliders, checkboxes and buttons keep focus after use but don't take letters, so keys still drive.
  const typing = el => el?.closest?.('textarea, select, [contenteditable], input:not([type=range]):not([type=checkbox]):not([type=button])');
  document.addEventListener('keydown', e => {
    if (!isActive() || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      releaseAll();
      motors.stopAll('space');
      return;
    }
    const k = KEYS[e.key.toLowerCase()];
    if (!k || e.repeat) return;
    motors.set({ [k[0]]: k[1] * 100 });
  });
  document.addEventListener('keyup', e => {
    const k = KEYS[e.key.toLowerCase()];
    if (k && isActive() && !typing(e.target)) motors.set({ [k[0]]: 0 });
  });
  window.addEventListener('blur', releaseAll);

  render();
  return { releaseAll };
}
