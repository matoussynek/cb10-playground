// Phase 1 probe console: GATT explorer, live log, hex sender, byte grid, sweeper, panic stop, notes.

import {
  parseHex, toHex, toDec, toAscii, hexByte, formatTime, uuidLabel, keyLabel,
  sweepValues, SWEEP_MAX, parseIntLoose, sleep, loadJSON, saveJSON,
} from './util.js';
import { isGenericAccess } from './ble.js';

const $ = id => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

const STORE = {
  history: 'cb10.hexHistory', grid: 'cb10.grid', panic: 'cb10.panic', notes: 'cb10.notes', targets: 'cb10.targets',
};
const MODES = [['auto', 'Auto (from properties)'], ['with', 'With response'], ['without', 'Without response']];
const PROP_LABEL = {
  read: 'READ', write: 'WRITE', writeWithoutResponse: 'WRITE-NR', notify: 'NOTIFY', indicate: 'INDICATE',
  broadcast: 'BCAST', authenticatedSignedWrites: 'SIGNED', reliableWrite: 'RELIABLE', writableAuxiliaries: 'AUX',
};
const DIR = { W: 'W→', R: 'R←', N: 'N←', I: 'i ', E: '! ' };
const MAX_ENTRIES = 20000;
const MAX_ROWS = 1500;
const HISTORY_MAX = 25;
const WARN_LEN = 20;
const PANIC = Object.assign(new Error('STOP'), { name: 'AbortError' });
const NEW_REPLY = Object.assign(new Error('new reply'), { name: 'AbortError' });

export function createProbe(ble, { mock = false, onError = () => {} } = {}) {
  // Failed BLE operations are already logged and reported through ble's 'error' event.
  const ignore = () => {};
  const allChars = () => ble.services.flatMap(s => s.chars);
  const writable = c => c.props.write || c.props.writeWithoutResponse;
  const locked = key => isGenericAccess(key) && !ble.allowGenericAccessWrites;
  const connected = () => ble.state === 'connected';
  const openSection = id => { $(id).open = true; $(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  // ---------- target pickers (characteristic + write type) ----------
  const targets = loadJSON(STORE.targets, {});
  const pickers = [];

  function picker(name, { persist = true, initial } = {}) {
    const sel = $(name + 'Target');
    const mode = $(name + 'Mode');
    for (const [v, t] of MODES) mode.append(h('option', { value: v }, t));
    const start = initial || targets[name] || {};
    mode.value = start.mode || 'auto';
    sel.dataset.wanted = start.key || '';
    const save = () => {
      if (!persist) return;
      targets[name] = { key: sel.value, mode: mode.value };
      saveJSON(STORE.targets, targets);
    };
    sel.addEventListener('change', () => { sel.dataset.wanted = sel.value; save(); });
    mode.addEventListener('change', save);
    const p = {
      sel, mode,
      get key() { return sel.value; },
      get opts() { return { mode: mode.value }; },
      set(key, m) {
        sel.dataset.wanted = key || '';
        if (m) mode.value = m;
        refreshPicker(p);
        save();
      },
    };
    pickers.push(p);
    refreshPicker(p);
    return p;
  }

  function refreshPicker(p) {
    const want = p.sel.dataset.wanted;
    const list = allChars().filter(writable);
    p.sel.replaceChildren(...list.map(c => h('option', { value: c.key }, keyLabel(c.key) + (locked(c.key) ? ' (locked)' : ''))));
    if (want && !list.some(c => c.key === want)) p.sel.append(h('option', { value: want }, `${keyLabel(want)} (not present)`));
    if (!p.sel.options.length) p.sel.append(h('option', { value: '' }, 'Connect first'));
    p.sel.value = want || list.find(c => !isGenericAccess(c.key))?.key || p.sel.options[0].value;
  }

  // ---------- live log ----------
  const logEl = $('log');
  const filterEl = $('logFilter');
  const pauseBtn = $('logPause');
  const entries = [];
  let paused = false;
  let missed = 0;

  function line(e) {
    const label = e.key ? keyLabel(e.key) + ' ' : '';
    let body = e.text ?? '';
    if (e.bytes) {
      body = `[${e.bytes.length}] ${toHex(e.bytes)} | ${toDec(e.bytes)} | "${toAscii(e.bytes)}"`
        + (e.mode ? ` (${e.mode})` : '') + (e.changed ? ' (changed)' : '') + (e.text ? `  ${e.text}` : '');
    }
    return `${formatTime(e.t)} ${DIR[e.dir]} ${label}${body}`;
  }

  const matches = e => !filterEl.value || (filterEl.value === '#events' ? !e.bytes : e.key === filterEl.value);
  const row = e => h('div', { class: `r d-${e.dir}` }, line(e));

  function appendRow(e) {
    const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
    logEl.append(row(e));
    while (logEl.childElementCount > MAX_ROWS) logEl.firstElementChild.remove();
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }

  function renderLog() {
    logEl.replaceChildren(...entries.filter(matches).slice(-MAX_ROWS).map(row));
    logEl.scrollTop = logEl.scrollHeight;
  }

  function refreshFilter() {
    const want = filterEl.value;
    filterEl.replaceChildren(
      h('option', { value: '' }, 'All'),
      h('option', { value: '#events' }, 'Info & errors only'),
      ...allChars().map(c => h('option', { value: c.key }, keyLabel(c.key))),
    );
    filterEl.value = [...filterEl.options].some(o => o.value === want) ? want : '';
  }

  const lastNotified = new Map();
  ble.addEventListener('log', ev => {
    const e = ev.detail;
    if (e.dir === 'N') {
      const hex = toHex(e.bytes);
      if (lastNotified.has(e.key) && lastNotified.get(e.key) !== hex) e.changed = true;
      lastNotified.set(e.key, hex);
    }
    entries.push(e);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    $('ticker').textContent = line(e);
    if (!matches(e)) return;
    if (paused) {
      missed++;
      pauseBtn.textContent = `Resume (${missed} new)`;
      return;
    }
    appendRow(e);
  });

  filterEl.addEventListener('change', renderLog);
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    missed = 0;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) renderLog();
  });
  $('logClear').addEventListener('click', () => {
    entries.length = 0;
    renderLog();
  });

  const deviceName = () => ble.device?.name || ble.device?.id || 'none';
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  function gattLines() {
    return ble.services.flatMap(s => [
      `  ${uuidLabel(s.uuid)}  ${s.uuid}`,
      ...s.chars.map(c => `    ${uuidLabel(c.uuid)}  ${c.uuid}  [${Object.keys(c.props).filter(k => c.props[k]).map(k => PROP_LABEL[k]).join(' ')}]`),
    ]);
  }

  function exportText() {
    return [
      `CB10 probe log, exported ${new Date().toISOString()}`,
      `Device: ${deviceName()}${mock ? ' (MOCK MODE)' : ''}`,
      `Panic stop: ${panic.hex ? `${panic.hex} -> ${keyLabel(panic.key)} (${panic.mode})` : 'not set'}`,
      '', 'Notes:', $('notes').value || '(none)',
      '', 'GATT:', ...gattLines(),
      '', 'Log:', ...entries.map(line),
    ].join('\n') + '\n';
  }

  function exportJson() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      device: deviceName(),
      mock,
      notes: $('notes').value,
      panic,
      gatt: ble.services,
      log: entries.map(e => ({
        t: Math.round(e.t * 1000) / 1000,
        time: new Date(e.t).toISOString(),
        dir: e.dir,
        key: e.key,
        char: e.key ? keyLabel(e.key) : undefined,
        hex: e.bytes ? toHex(e.bytes) : undefined,
        dec: e.bytes ? Array.from(e.bytes) : undefined,
        ascii: e.bytes ? toAscii(e.bytes) : undefined,
        mode: e.mode,
        changed: e.changed,
        text: e.text,
      })),
    }, null, 2);
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h('textarea', { value: text });
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  $('logCopy').addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    btn.textContent = (await copy(exportText())) ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
  $('logTxt').addEventListener('click', () => download(`cb10-log-${stamp()}.txt`, exportText(), 'text/plain'));
  $('logJson').addEventListener('click', () => download(`cb10-log-${stamp()}.json`, exportJson(), 'application/json'));

  // ---------- GATT explorer ----------
  const treeEl = $('gattTree');
  const valueEls = new Map();
  const lastValues = new Map();
  const fmtVal = b => `[${b.length}] ${toHex(b)} | "${toAscii(b)}"`;

  function charRow(c, live) {
    const p = c.props;
    const sub = ble.subscribed.has(c.key);
    const badges = Object.keys(p).filter(k => p[k]).map(k => h('span', { class: 'prop' }, PROP_LABEL[k]));
    if (writable(c) && locked(c.key)) badges.push(h('span', { class: 'prop lock' }, 'LOCKED'));
    const val = h('div', { class: 'char-val' }, lastValues.has(c.key) ? fmtVal(lastValues.get(c.key)) : '—');
    valueEls.set(c.key, val);
    return h('div', { class: 'char' },
      h('div', { class: 'char-head' }, h('code', {}, uuidLabel(c.uuid)), badges),
      h('div', { class: 'uuid' }, c.uuid),
      val,
      h('div', { class: 'row' },
        h('button', { type: 'button', disabled: !live || !p.read, onclick: () => ble.read(c.key).catch(ignore) }, 'Read'),
        h('button', {
          type: 'button',
          disabled: !live || !(p.notify || p.indicate),
          'aria-pressed': String(sub),
          onclick: () => (sub ? ble.unsubscribe(c.key) : ble.subscribe(c.key)).catch(ignore),
        }, sub ? 'Unsubscribe' : 'Subscribe'),
        h('button', { type: 'button', disabled: !writable(c) || locked(c.key), onclick: () => useInSender(c.key) }, 'Write…'),
      ));
  }

  function renderTree() {
    valueEls.clear();
    const live = connected();
    treeEl.classList.toggle('stale', !live && ble.services.length > 0);
    $('subscribeAllBtn').disabled = !live;
    $('readAllBtn').disabled = !live;
    if (!ble.services.length) {
      treeEl.replaceChildren(h('p', { class: 'hint' }, 'Connect to see services.'));
      return;
    }
    treeEl.replaceChildren(
      live ? '' : h('p', { class: 'hint' }, 'Disconnected: showing the last known services.'),
      ...ble.services.map(s => h('div', { class: 'svc' },
        h('div', { class: 'svc-head' }, 'Service ', uuidLabel(s.uuid)),
        h('div', { class: 'uuid' }, s.uuid),
        s.chars.length ? s.chars.map(c => charRow(c, live)) : h('p', { class: 'hint' }, 'No characteristics.'),
      )),
    );
  }

  ble.addEventListener('value', ev => {
    const { key, bytes } = ev.detail;
    lastValues.set(key, bytes);
    const el = valueEls.get(key);
    if (el) el.textContent = fmtVal(bytes);
  });
  ble.addEventListener('gatt', () => {
    pickers.forEach(refreshPicker);
    refreshFilter();
    renderTree();
  });
  ble.addEventListener('state', renderTree);
  ble.addEventListener('subscriptions', renderTree);

  $('subscribeAllBtn').addEventListener('click', async () => {
    const n = await ble.subscribeAll();
    ble.info(`Subscribe all: ${n} new subscription(s)`);
  });
  $('readAllBtn').addEventListener('click', async () => {
    for (const c of allChars().filter(c => c.props.read)) await ble.read(c.key).catch(ignore);
  });

  // ---------- hex sender ----------
  const sendP = picker('send');
  const hexIn = $('sendHex');
  let history = loadJSON(STORE.history, []);

  function useInSender(key) {
    sendP.set(key);
    openSection('secSender');
    hexIn.focus({ preventScroll: true });
  }

  function preview() {
    try {
      const b = parseHex(hexIn.value);
      $('sendPreview').textContent = b.length
        ? `${b.length} byte${b.length > 1 ? 's' : ''}: ${toHex(b)}${b.length > WARN_LEN ? '  (over 20 bytes!)' : ''}`
        : '';
    } catch (e) {
      $('sendPreview').textContent = e.message;
    }
  }

  async function send(hex, key, opts) {
    let bytes;
    try {
      bytes = parseHex(hex);
      if (!bytes.length) throw new Error('Nothing to send: enter some hex bytes.');
    } catch (e) {
      onError(e);
      return;
    }
    if (bytes.length > WARN_LEN && !confirm(`${bytes.length} bytes is longer than 20. Send anyway?`)) return;
    try {
      await ble.write(key, bytes, opts);
      addHistory({ hex: toHex(bytes), key, mode: opts.mode });
    } catch {
      // reported via ble 'error'
    }
  }

  function addHistory(item) {
    history = [item, ...history.filter(x => !(x.hex === item.hex && x.key === item.key && x.mode === item.mode))]
      .slice(0, HISTORY_MAX);
    saveJSON(STORE.history, history);
    renderHistory();
  }

  function renderHistory() {
    const ul = $('history');
    if (!history.length) {
      ul.replaceChildren(h('li', { class: 'hint' }, 'Nothing sent yet.'));
      return;
    }
    ul.replaceChildren(...history.map(item => h('li', {},
      h('button', {
        type: 'button',
        class: 'resend',
        title: `Resend to ${keyLabel(item.key)} (${item.mode})`,
        onclick: () => send(item.hex, item.key, { mode: item.mode }),
      }, item.hex, ' ', h('span', { class: 'tgt' }, `→ ${keyLabel(item.key)}${item.mode !== 'auto' ? ' ' + item.mode : ''}`)),
      h('button', {
        type: 'button',
        class: 'btn-small',
        'aria-label': `Edit ${item.hex}`,
        onclick: () => { hexIn.value = item.hex; sendP.set(item.key, item.mode); preview(); hexIn.focus(); },
      }, 'Edit'),
    )));
  }

  hexIn.addEventListener('input', preview);
  hexIn.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') send(hexIn.value, sendP.key, sendP.opts);
  });
  $('sendBtn').addEventListener('click', () => send(hexIn.value, sendP.key, sendP.opts));
  $('clearHistory').addEventListener('click', () => {
    history = [];
    saveJSON(STORE.history, history);
    renderHistory();
  });
  $('sendToGrid').addEventListener('click', () => {
    try {
      setGrid(parseHex(hexIn.value));
      gridP.set(sendP.key, sendP.mode.value);
      openSection('secGrid');
    } catch (e) {
      onError(e);
    }
  });

  // ---------- byte grid ----------
  const gridP = picker('grid');
  const cellsEl = $('gridCells');
  let grid = loadJSON(STORE.grid, null);
  if (!Array.isArray(grid) || !grid.length || grid.length > 20 || grid.some(v => !Number.isInteger(v) || v < 0 || v > 255)) {
    grid = [0, 0, 0, 0];
  }

  function gridChanged() {
    saveJSON(STORE.grid, grid);
    $('gridHex').textContent = toHex(grid);
    if ($('gridAuto').checked && connected()) ble.writeLatest('grid', gridP.key, grid, gridP.opts);
  }

  function setGrid(bytes) {
    grid = Array.from(bytes).slice(0, 20);
    if (!grid.length) grid = [0];
    renderGrid();
    gridChanged();
  }

  function cell(i) {
    const input = h('input', {
      type: 'text', maxlength: '2', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
      inputmode: 'text', 'aria-label': `Byte ${i} (hex)`, value: hexByte(grid[i]),
    });
    const dec = h('div', { class: 'dec' }, String(grid[i]));
    const set = (v, reformat = true) => {
      grid[i] = ((v % 256) + 256) % 256;
      if (reformat) input.value = hexByte(grid[i]);
      dec.textContent = grid[i];
      gridChanged();
    };
    input.addEventListener('input', () => {
      if (/^[0-9a-f]{1,2}$/i.test(input.value.trim())) set(parseInt(input.value, 16), false);
    });
    input.addEventListener('blur', () => { input.value = hexByte(grid[i]); });
    input.addEventListener('focus', () => input.select());
    const btn = (label, d) => h('button', { type: 'button', 'aria-label': `Byte ${i} ${label}`, onclick: () => set(grid[i] + d) }, label);
    return h('div', { class: 'cell' },
      h('div', { class: 'idx' }, `#${i}`),
      h('div', { class: 'pm' }, btn('+1', 1), btn('+16', 16)),
      input,
      h('div', { class: 'pm' }, btn('−1', -1), btn('−16', -16)),
      dec,
    );
  }

  function renderGrid() {
    $('gridN').value = grid.length;
    cellsEl.replaceChildren(...grid.map((_, i) => cell(i)));
    $('gridHex').textContent = toHex(grid);
  }

  $('gridN').addEventListener('change', () => {
    const n = Math.min(20, Math.max(1, parseInt($('gridN').value, 10) || 1));
    $('gridN').value = n;
    // Re-rendering on an unchanged length would swallow the tap that blurred this field.
    if (n === grid.length) return;
    setGrid(Array.from({ length: n }, (_, i) => grid[i] ?? 0));
  });
  $('gridSend').addEventListener('click', () => ble.write(gridP.key, grid, gridP.opts).catch(ignore));
  $('gridZero').addEventListener('click', () => setGrid(new Array(grid.length).fill(0)));
  $('gridFromSender').addEventListener('click', () => {
    try {
      setGrid(parseHex(hexIn.value));
    } catch (e) {
      onError(e);
    }
  });
  $('gridToSweep').addEventListener('click', () => {
    $('sweepTemplate').value = toHex(grid);
    sweepP.set(gridP.key, gridP.mode.value);
    updatePlan();
    openSection('secSweep');
  });

  // ---------- byte sweeper ----------
  const sweepP = picker('sweep');
  const sweepInputs = ['sweepTemplate', 'sweepIndex', 'sweepStart', 'sweepEnd', 'sweepStep', 'sweepDelay'];
  let sweepCtl = null;
  $('sweepMax').textContent = SWEEP_MAX;

  function plan() {
    const tpl = parseHex($('sweepTemplate').value);
    if (!tpl.length) throw new Error('Template is empty.');
    if (tpl.length > WARN_LEN) throw new Error('Template is longer than 20 bytes.');
    const index = parseIntLoose($('sweepIndex').value);
    if (!(index >= 0 && index < tpl.length)) throw new Error(`Byte index must be 0-${tpl.length - 1}.`);
    const values = sweepValues(parseIntLoose($('sweepStart').value), parseIntLoose($('sweepEnd').value), parseIntLoose($('sweepStep').value));
    const delay = Number($('sweepDelay').value);
    if (!(delay >= 100)) throw new Error('Delay must be at least 100 ms.');
    return { tpl, index, values, delay };
  }

  function updatePlan() {
    try {
      const p = plan();
      $('sweepPlan').textContent = `${p.values.length} packets, byte #${p.index}: 0x${hexByte(p.values[0])} → 0x${hexByte(p.values.at(-1))}, about ${Math.ceil((p.values.length * p.delay) / 1000)} s`;
    } catch (e) {
      $('sweepPlan').textContent = e.message;
    }
  }

  function progress(done, total, v) {
    $('sweepProgressText').textContent = `Sweep ${done}/${total}${v == null ? '' : `  byte = 0x${hexByte(v)} (${v})`}`;
    $('sweepProgress').value = total ? done / total : 0;
  }

  async function runSweep() {
    if (sweepCtl) return;
    let p;
    try {
      if (!connected()) throw new Error('Not connected.');
      p = plan();
    } catch (e) {
      onError(e);
      return;
    }
    const key = sweepP.key;
    const { mode } = sweepP.opts;
    const msg = `Send ${p.values.length} packets to ${keyLabel(key)}?\n`
      + `Byte #${p.index} from 0x${hexByte(p.values[0])} to 0x${hexByte(p.values.at(-1))}, every ${p.delay} ms.\n`
      + `Template: ${toHex(p.tpl)}`;
    if (!confirm(msg)) return;

    sweepCtl = new AbortController();
    const { signal } = sweepCtl;
    $('sweepBar').hidden = false;
    $('sweepRun').disabled = true;
    const bytes = Uint8Array.from(p.tpl);
    const total = p.values.length;
    let done = 0;
    let outcome = 'finished';
    let lastSent = null;
    let novel = null;
    // Baseline is the last notification seen on each characteristic before the sweep. On one that
    // has never notified, any reply is news. Replies arrive well within the delay, so lastSent is
    // the packet that caused it.
    const firstReply = new Map(lastNotified);
    const onValue = ev => {
      const { key: k, bytes: b, dir } = ev.detail;
      if (dir !== 'N' || !$('sweepStopOnNew').checked || signal.aborted) return;
      const hex = toHex(b);
      if (firstReply.get(k) !== hex) {
        novel = { k, hex, after: lastSent };
        sweepCtl.abort(NEW_REPLY);
      }
    };
    ble.addEventListener('value', onValue);
    ble.info(`Sweep start: byte #${p.index}, ${total} values, ${p.delay} ms, template ${toHex(p.tpl)}`, key);
    progress(0, total);
    try {
      for (const v of p.values) {
        if (signal.aborted) break;
        bytes[p.index] = v;
        lastSent = toHex(bytes);
        await ble.write(key, bytes, { mode, note: `sweep ${done + 1}/${total} #${p.index}=0x${hexByte(v)}` });
        done++;
        progress(done, total, v);
        await sleep(p.delay, signal);
      }
    } catch (e) {
      if (!signal.aborted) outcome = `stopped by error: ${e.message}`;
    }
    ble.removeEventListener('value', onValue);
    if (signal.reason === NEW_REPLY) {
      outcome = `stopped by a new reply on ${keyLabel(novel.k)}: ${novel.hex} (usual: ${firstReply.get(novel.k) ?? 'none, first reply ever'}), probably caused by ${novel.after}`;
    } else if (signal.aborted) {
      outcome = signal.reason === PANIC ? 'stopped by STOP' : 'aborted';
    }
    sweepCtl = null;
    $('sweepBar').hidden = true;
    $('sweepRun').disabled = false;
    ble.info(`Sweep ${outcome} after ${done}/${total} packets`, key);
    // STOP already sent the stop packet itself.
    if ($('sweepStopAfter').checked && signal.reason !== PANIC) await sendStopPacket('sweep end');
  }

  for (const id of sweepInputs) $(id).addEventListener('input', updatePlan);
  $('sweepRun').addEventListener('click', runSweep);
  $('sweepAbort').addEventListener('click', () => {
    sweepCtl?.abort(new Error('aborted'));
    ble.clearPending('Sweep aborted');
  });

  // ---------- panic stop ----------
  let panic = loadJSON(STORE.panic, null) || { hex: '', key: '', mode: 'auto' };
  const panicP = picker('panic', { persist: false, initial: panic });
  $('panicHex').value = panic.hex;

  function renderPanicStatus() {
    $('panicStatus').textContent = panic.hex
      ? `Saved: ${panic.hex} → ${keyLabel(panic.key)} (${panic.mode})`
      : 'No stop packet defined. STOP still aborts sweeps, turns off auto-send and clears the queue.';
  }

  async function sendStopPacket(reason, { quiet = false } = {}) {
    if (!connected()) return;
    if (!panic.hex || !panic.key) {
      if (!quiet) ble.info(`STOP (${reason}): no stop packet defined, queue cleared`);
      return;
    }
    await ble.write(panic.key, parseHex(panic.hex), { mode: panic.mode, note: `STOP (${reason})` }).catch(ignore);
  }

  // Stops probe activity without sending anything.
  function halt() {
    sweepCtl?.abort(PANIC);
    $('gridAuto').checked = false;
  }

  async function panicStop(reason) {
    halt();
    ble.clearPending('Dropped by STOP');
    await sendStopPacket(reason);
  }

  $('panicSave').addEventListener('click', () => {
    try {
      const bytes = parseHex($('panicHex').value);
      if (bytes.length && !panicP.key) throw new Error('Choose a characteristic for the stop packet (connect first).');
      if (bytes.length > WARN_LEN) throw new Error('Stop packet is longer than 20 bytes.');
      panic = bytes.length ? { hex: toHex(bytes), key: panicP.key, mode: panicP.mode.value } : { hex: '', key: '', mode: 'auto' };
      $('panicHex').value = panic.hex;
      saveJSON(STORE.panic, panic);
      renderPanicStatus();
    } catch (e) {
      onError(e);
    }
  });
  $('panicTest').addEventListener('click', () => panicStop('test'));

  // ---------- notes ----------
  const notes = $('notes');
  notes.value = loadJSON(STORE.notes, '');
  notes.addEventListener('input', () => saveJSON(STORE.notes, notes.value));

  renderTree();
  refreshFilter();
  renderHistory();
  renderGrid();
  updatePlan();
  renderPanicStatus();

  return {
    halt,
    sendStopPacket,
    refresh() {
      pickers.forEach(refreshPicker);
      renderTree();
    },
  };
}
