// Entry point: feature detection, views, connection flow, settings and safety hooks.

import { Ble } from './ble.js';
import { createProbe } from './probe.js';
import { createMotors, createControlPanel } from './control.js';
import { createProgramEditor } from './program.js';
import { createMockBluetooth } from './mock.js';
import { PROTOCOL } from './protocol.js';
import { canonicalUUID, sleep, loadJSON, saveJSON } from './util.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const mock = params.get('mock') === '1';

function showUnsupported(title, html) {
  $('unsupportedTitle').textContent = title;
  $('unsupportedText').innerHTML = html;
  $('unsupported').hidden = false;
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error('Timed out'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Chrome can only connect to a remembered device after it has seen it advertising.
function waitForAdvertisement(device, ms) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => { ac.abort(); reject(new Error('Hub not seen')); }, ms);
    device.addEventListener('advertisementreceived', () => { clearTimeout(timer); ac.abort(); resolve(); }, { once: true });
    device.watchAdvertisements({ signal: ac.signal }).catch(e => { clearTimeout(timer); reject(e); });
  });
}

function init() {
  if (!mock && !window.isSecureContext) {
    showUnsupported('This page needs a secure address',
      `<p>Bluetooth only works on <code>https://</code> pages or on <code>http://localhost</code>.
      Run <code>python3 -m http.server 8000</code> in the project folder and open <code>http://localhost:8000</code>.
      A LAN address like <code>http://192.168.x.x</code> does not count.</p>`);
    return;
  }
  if (!mock && !navigator.bluetooth) {
    showUnsupported("This browser can't talk to the hub",
      `<p>Open this page in <strong>Chrome</strong> or <strong>Edge</strong> on Android, Windows, Mac or a Chromebook.
      Safari, Firefox and iPhone/iPad browsers don't have Bluetooth for web pages.</p>
      <p>On iPhone or iPad, the <strong>Bluefy</strong> browser app may work.</p>`);
    return;
  }

  const bluetooth = mock ? createMockBluetooth({ known: params.get('known') === '1' }) : navigator.bluetooth;
  const ble = new Ble(bluetooth);
  const settings = {
    namePrefix: PROTOCOL.namePrefix, acceptAll: false, extraServices: '', maxWps: 20, autoReconnect: true,
    ...loadJSON('cb10.settings', {}),
  };
  const saveSettings = () => saveJSON('cb10.settings', settings);

  let retrying = false;
  let searching = false;
  let forcePicker = false;
  let toastTimer;

  function showError(e) {
    if (retrying) return; // reconnect attempts report their own outcome
    const t = $('lastError');
    t.textContent = e.message || String(e);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 7000);
  }
  $('lastError').addEventListener('click', () => { $('lastError').hidden = true; });

  const probe = createProbe(ble, { mock, onError: showError });
  const motors = createMotors(ble);
  let look = loadJSON('cb10.look', 'kids') === 'adult' ? 'adult' : 'kids';
  document.documentElement.dataset.look = look;
  const program = createProgramEditor(ble, motors, { kids: look === 'kids' });
  function renderLook() {
    for (const b of $('lookButtons').children) b.setAttribute('aria-pressed', String(b.dataset.look === look));
  }
  for (const b of $('lookButtons').children) {
    b.addEventListener('click', () => {
      look = b.dataset.look;
      saveJSON('cb10.look', look);
      document.documentElement.dataset.look = look;
      program.setKids(look === 'kids');
      renderLook();
    });
  }
  renderLook();
  ble.addEventListener('error', ev => showError(ev.detail));

  // ---------- views ----------
  // Drive and Code are the kids' modes; Settings and the probe are for grown-ups and are never
  // remembered as the start screen.
  const VIEWS = ['Drive', 'Code', 'Settings', 'Probe'];
  const MODES = ['Drive', 'Code'];
  let mode = loadJSON('cb10.view', 'Drive');
  if (!MODES.includes(mode)) mode = 'Drive';
  let view = mode;
  function showView(name) {
    view = VIEWS.includes(name) ? name : 'Drive';
    if (MODES.includes(view)) {
      mode = view;
      saveJSON('cb10.view', mode);
    }
    for (const v of VIEWS) $(`view${v}`).hidden = v !== view;
    for (const m of MODES) $(`nav${m}`).setAttribute('aria-selected', String(m === view));
    $('navSettings').setAttribute('aria-pressed', String(!MODES.includes(view)));
    scrollTo(0, 0);
  }
  for (const m of MODES) $(`nav${m}`).addEventListener('click', () => showView(m));
  $('settingsDone').addEventListener('click', () => showView(mode));
  $('openProbe').addEventListener('click', () => showView('Probe'));
  $('closeProbe').addEventListener('click', () => showView('Settings'));
  showView(view);

  // Settings open only after a press-and-hold, so a child tapping around never lands there.
  // Keyboard activation (Enter/Space, click.detail === 0) opens directly for adults on a desktop.
  const HOLD_MS = 1500;
  const gear = $('navSettings');
  let holdTimer = null;
  gear.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    gear.classList.remove('holding');
  };
  gear.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!MODES.includes(view)) return showView(mode); // already in settings: a tap goes back
    gear.classList.add('holding');
    holdTimer = setTimeout(() => {
      cancelHold();
      showView('Settings');
    }, HOLD_MS);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    gear.addEventListener(ev, () => {
      if (!holdTimer) return;
      cancelHold();
      if (ev === 'pointerup') showError(new Error('Settings are for grown-ups: press and hold the gear.'));
    });
  }
  gear.addEventListener('click', e => { if (e.detail === 0) showView(MODES.includes(view) ? 'Settings' : mode); });
  gear.addEventListener('contextmenu', e => e.preventDefault());
  const control = createControlPanel(ble, motors, { isActive: () => view === 'Drive' });

  // One stop for everything: halt the program and sweep first (they send nothing), then stop the
  // motors on every channel, then the optional custom stop packet from the probe.
  async function stopEverything(reason) {
    program.abort(reason);
    probe.halt();
    control.releaseAll();
    await motors.stopAll(reason);
    await probe.sendStopPacket(reason, { quiet: true });
  }
  $('panicBtn').addEventListener('click', () => stopEverything('button'));

  // ---------- fullscreen ----------
  // Diagonal arrows: pointing out to the corners (enter) or in to the centre (leave).
  const ICON_EXPAND = $('fullscreenBtn').innerHTML;
  const ICON_SHRINK = ICON_EXPAND.replace(/d="[^"]+"/, 'd="M20 4l-6 6M14 5v5h5M4 20l6-6M5 14h5v5"');
  if (document.documentElement.requestFullscreen) {
    const fsBtn = $('fullscreenBtn');
    const sync = () => {
      const on = !!document.fullscreenElement;
      fsBtn.setAttribute('aria-pressed', String(on));
      fsBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
      fsBtn.innerHTML = on ? ICON_SHRINK : ICON_EXPAND;
    };
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', () => {
      const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      p.catch(() => showError(new Error("This browser won't go full screen here.")));
    });
    document.addEventListener('fullscreenchange', sync);
    sync();
  }

  if (mock) {
    $('mockBanner').hidden = false;
    document.title = 'Pretend hub · CB10';
    $('mockDrop').addEventListener('click', () => bluetooth.mock.drop());
    const dev = bluetooth.mock.device;
    const fmt = b => (b === 0x80 ? '0' : `0x${b.toString(16).toUpperCase()}`);
    const showHub = m => { $('mockHub').textContent = `ch ${dev.channel} · A ${fmt(m.A)} · B ${fmt(m.B)}`; };
    dev.addEventListener('motors', ev => showHub(ev.detail));
    showHub(dev.motors);
  }

  // ---------- connection ----------
  const hubName = () => (ble.device?.name || 'hub').replace(/\s+/g, '');

  function renderState() {
    const s = ble.state;
    const btn = $('connectBtn');
    const busy = s === 'connecting' || searching || retrying;
    btn.dataset.state = s === 'connected' ? s : busy ? 'connecting' : s;
    let label;
    if (s === 'connected') label = `Ready · ch ${motors.cfg.channel}`;
    else if (busy) label = retrying ? 'Reconnecting…' : searching ? 'Searching…' : 'Connecting…';
    else label = ble.device && !forcePicker ? 'Tap to connect' : 'Connect';
    $('connLabel').textContent = label;
    btn.setAttribute('aria-label', s === 'connected' ? `Connected to ${hubName()}, channel ${motors.cfg.channel}` : label);
    $('connectCard').hidden = s === 'connected' || busy;
    $('reconnectBtn').disabled = s !== 'disconnected' || !ble.device;
    $('disconnectBtn').disabled = s !== 'connected';
    $('pickBtn').disabled = s === 'connecting';
    $('deviceName').textContent = s === 'connected'
      ? `${ble.device.name || ble.device.id} · channel ${motors.cfg.channel}`
      : ble.device ? `${ble.device.name || 'Hub'} (not connected)` : 'No hub yet';
  }
  ble.addEventListener('state', renderState);
  motors.on('change', renderState);

  function optionalServices() {
    const extra = settings.extraServices.split(/[\s,;]+/).filter(Boolean).map(canonicalUUID);
    return [...new Set([...PROTOCOL.optionalServices, ...extra])];
  }

  // Opens the browser's device picker. Must run straight from a click (user activation).
  function pick() {
    let services;
    try {
      services = optionalServices();
    } catch (e) {
      showError(e);
      return;
    }
    ble.connect({ namePrefix: settings.namePrefix || PROTOCOL.namePrefix, acceptAll: settings.acceptAll, optionalServices: services })
      .then(() => { forcePicker = false; })
      .catch(e => { if (!/picker cancelled/.test(e.message)) showError(e); })
      .finally(renderState);
  }

  async function quickReconnect(ms = 10000) {
    await withTimeout(ble.reconnect(), ms, () => ble.device?.gatt?.disconnect());
  }

  // One button: known hub → reconnect without the picker; otherwise (or after a failed try) the picker.
  async function connectTap() {
    if (ble.state === 'connected') {
      showError(new Error(`Connected to ${ble.device?.name || 'the hub'} on channel ${motors.cfg.channel}.`));
      return;
    }
    if (ble.state === 'connecting' || searching || retrying) return;
    if (ble.device && !forcePicker) {
      try {
        await quickReconnect();
      } catch {
        forcePicker = true;
        showError(new Error("Couldn't reach the hub. Is it switched on? Tap Connect to search again."));
        renderState();
      }
      return;
    }
    pick();
  }
  $('connectBtn').addEventListener('click', connectTap);
  $('connectBig').addEventListener('click', connectTap);
  $('pickBtn').addEventListener('click', pick);
  $('reconnectBtn').addEventListener('click', () => quickReconnect().catch(showError));
  $('disconnectBtn').addEventListener('click', async () => {
    await Promise.race([stopEverything('disconnect'), sleep(800)]);
    ble.disconnect();
  });

  ble.addEventListener('disconnected', async ev => {
    program.abort('disconnected');
    probe.halt();
    control.releaseAll();
    if (ev.detail.user) return;
    if (!settings.autoReconnect) {
      showError(new Error('Lost the hub. Tap Connect to try again.'));
      return;
    }
    retrying = true;
    renderState();
    for (const wait of [500, 1500, 4000]) {
      await sleep(wait);
      if (ble.state !== 'disconnected') break;
      try {
        await quickReconnect(8000);
        break;
      } catch {
        // next attempt
      }
    }
    retrying = false;
    renderState();
    if (ble.state !== 'connected') showError(new Error('Lost the hub. Tap Connect to try again.'));
  });

  // A hub this browser already has permission for can connect without any tap.
  async function autoConnect() {
    if (!bluetooth.getDevices) return;
    let devices = [];
    try {
      devices = await bluetooth.getDevices();
    } catch {
      return;
    }
    const prefix = settings.namePrefix || PROTOCOL.namePrefix;
    const device = devices.find(d => (d.name || '').startsWith(prefix));
    if (!device || ble.state !== 'disconnected') return;
    ble.useDevice(device);
    searching = true;
    renderState();
    try {
      if (device.watchAdvertisements) await waitForAdvertisement(device, 8000).catch(() => {});
      searching = false;
      await quickReconnect(10000);
    } catch {
      // stays "Tap to connect"
    } finally {
      searching = false;
      renderState();
    }
  }

  // ---------- settings ----------
  $('namePrefix').value = settings.namePrefix;
  $('namePrefix').addEventListener('change', () => { settings.namePrefix = $('namePrefix').value.trim(); saveSettings(); });
  $('acceptAll').checked = settings.acceptAll;
  $('acceptAll').addEventListener('change', () => { settings.acceptAll = $('acceptAll').checked; saveSettings(); });
  $('autoReconnect').checked = settings.autoReconnect;
  $('autoReconnect').addEventListener('change', () => { settings.autoReconnect = $('autoReconnect').checked; saveSettings(); });
  $('extraServices').value = settings.extraServices;
  $('extraServices').addEventListener('change', () => {
    settings.extraServices = $('extraServices').value.trim();
    saveSettings();
    try {
      optionalServices();
    } catch (e) {
      showError(e);
    }
  });

  ble.maxWritesPerSecond = settings.maxWps;
  $('maxWps').value = settings.maxWps;
  $('maxWps').addEventListener('change', () => {
    settings.maxWps = Math.min(50, Math.max(1, parseInt($('maxWps').value, 10) || 20));
    $('maxWps').value = settings.maxWps;
    ble.maxWritesPerSecond = settings.maxWps;
    saveSettings();
  });
  // Deliberately not persisted: the guard is back on after every reload.
  $('allowGA').addEventListener('change', () => {
    const el = $('allowGA');
    if (el.checked && !confirm('Writing Device Name/Appearance can rename or confuse the hub. Allow writes to 0x1800?')) el.checked = false;
    ble.allowGenericAccessWrites = el.checked;
    probe.refresh();
  });

  const avail = $('availability');
  bluetooth.getAvailability?.().then(ok => {
    avail.textContent = ok ? '' : 'Bluetooth seems to be off. Turn it on (and Location on Android).';
  }, () => {});
  bluetooth.addEventListener?.('availabilitychanged', ev => {
    avail.textContent = ev.value === false ? 'Bluetooth was turned off.' : '';
  });

  // ---------- safety ----------
  // Background tabs get throttled, so stop everything rather than leave motors running unattended.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopEverything('page hidden');
  });
  window.addEventListener('pagehide', () => stopEverything('page unload'));

  // ---------- install as an app ----------
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let installEvent = null;
  function renderApp() {
    $('appCard').hidden = false;
    $('installBtn').hidden = !installEvent;
    $('appText').textContent = standalone
      ? 'Running as an installed app. It also opens without internet.'
      : installEvent
        ? 'Put CB10 on your home screen. It opens like an app and works without internet.'
        : "To install, use your browser's menu (\u22ee) \u2192 Install app / Add to Home screen.";
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installEvent = e;
    renderApp();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    renderApp();
  });
  $('installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
    renderApp();
  });
  renderApp();

  renderState();
  autoConnect();
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {}); // offline support is optional
}

init();
