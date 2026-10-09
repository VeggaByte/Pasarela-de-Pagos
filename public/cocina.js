import { el, money, api, storage, formatCountdown, syncClock, serverNow } from './common.js';

const PIN_KEY = 'cocina:pin';
const $ = (id) => document.getElementById(id);

const orders = new Map(); // id -> order
const flashing = new Set(); // ids recién llegados o modificados
let pin = storage.get(PIN_KEY);
let audio = null;

const staffHeaders = () => ({ 'X-Staff-Pin': pin });

// ---------- Sonido ----------
// Los navegadores sólo permiten audio después de una interacción del usuario.
$('sound').addEventListener('click', () => {
  audio = new AudioContext();
  beep();
  $('sound').textContent = '🔔 Sonido activo';
  $('sound').disabled = true;
});

function beep() {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.25, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.6);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.6);
}

// ---------- Render ----------

function minutesAgo(ts) {
  const min = Math.floor((serverNow() - ts) / 60000);
  return min < 1 ? 'hace un momento' : `hace ${min} min`;
}

function ticket(order) {
  const actions = {
    received: el('button', { class: 'btn btn-primary btn-block', onclick: () => act(order.id, 'lock') }, 'Sin cambios — preparar'),
    preparing: el('button', { class: 'btn btn-primary btn-block', onclick: () => act(order.id, 'ready') }, 'Marcar lista'),
    ready: el('button', { class: 'btn btn-block', onclick: () => act(order.id, 'delivered') }, 'Entregada'),
  };
  const editable = order.status === 'received' && order.editable;

  return el('article', { class: `card ticket${editable ? ' editable' : ''}${flashing.has(order.id) ? ' flash' : ''}` },
    el('div', { class: 'ticket-head' },
      el('h3', {}, order.table.name),
      el('span', { class: 'small muted' }, `#${order.id} · ${minutesAgo(order.paidAt)}`),
    ),
    el('div', {},
      order.modifiedCount > 0 ? el('span', { class: 'badge badge-danger' }, 'Modificada') : null,
      ' ',
      editable
        ? el('span', { class: 'small' }, 'Editable por el cliente: ', el('span', { class: 'countdown', 'data-until': order.editableUntil }, ''))
        : null,
      order.status === 'preparing' && order.lockedBy === 'timeout'
        ? el('span', { class: 'small muted' }, 'Bloqueada por tiempo')
        : null,
    ),
    el('ul', {},
      order.items.map((i) =>
        el('li', {}, el('strong', {}, `${i.quantity} × `), i.name, i.notes ? el('span', { class: 'note' }, `“${i.notes}”`) : null),
      ),
    ),
    el('p', { class: 'small muted' }, `Total ${money(order.totalCents)}`),
    actions[order.status],
  );
}

function render() {
  const groups = { received: [], preparing: [], ready: [] };
  for (const o of [...orders.values()].sort((a, b) => a.paidAt - b.paidAt)) groups[o.status]?.push(o);
  for (const [status, list] of Object.entries(groups)) {
    $(`col-${status}`).replaceChildren(...list.map(ticket));
    $(`count-${status}`).textContent = list.length;
  }
  tick();
}

function tick() {
  for (const node of document.querySelectorAll('[data-until]')) {
    node.textContent = formatCountdown(Number(node.dataset.until) - serverNow());
  }
}

// ---------- Datos ----------

function applyOrder(order, { notify = false } = {}) {
  if (['received', 'preparing', 'ready'].includes(order.status)) orders.set(order.id, order);
  else orders.delete(order.id);
  if (notify) {
    flashing.add(order.id);
    setTimeout(() => {
      flashing.delete(order.id);
    }, 3000);
    beep();
  }
  render();
}

async function loadOrders() {
  const data = await api('/api/kitchen/orders', { headers: staffHeaders() });
  syncClock(data.serverNow);
  orders.clear();
  for (const o of data.orders) orders.set(o.id, o);
  render();
}

async function act(id, action) {
  try {
    const path = action === 'lock' ? `/api/kitchen/orders/${id}/lock` : `/api/kitchen/orders/${id}/status`;
    const body = action === 'lock' ? undefined : { status: action };
    const { order } = await api(path, { method: 'POST', headers: staffHeaders(), body });
    applyOrder(order);
  } catch (err) {
    alert(err.message);
    loadOrders().catch(() => {});
  }
}

function connect() {
  const source = new EventSource(`/api/kitchen/events?pin=${encodeURIComponent(pin)}`);
  source.addEventListener('open', () => {
    $('conn').textContent = '● En vivo';
    loadOrders().catch(() => {}); // por si se perdieron eventos mientras no había conexión
  });
  source.addEventListener('error', () => {
    $('conn').textContent = 'Reconectando…';
  });
  source.addEventListener('order.paid', (e) => applyOrder(JSON.parse(e.data), { notify: true }));
  source.addEventListener('order.modified', (e) => applyOrder(JSON.parse(e.data), { notify: true }));
  source.addEventListener('order.cancelled', (e) => applyOrder(JSON.parse(e.data), { notify: true }));
  for (const type of ['order.locked', 'order.ready', 'order.delivered']) {
    source.addEventListener(type, (e) => applyOrder(JSON.parse(e.data)));
  }
}

async function start() {
  try {
    await loadOrders();
  } catch (err) {
    if (err.status === 401) {
      storage.remove(PIN_KEY);
      $('pin-error').textContent = 'PIN incorrecto';
      $('pin-error').classList.remove('hidden');
      return;
    }
    throw err;
  }
  storage.set(PIN_KEY, pin);
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  connect();
  setInterval(() => {
    // La ventana de edición vence en el servidor; aquí sólo actualizamos los contadores
    // y el texto "hace X min".
    for (const o of orders.values()) if (o.status === 'received' && o.editable && o.editableUntil <= serverNow()) o.editable = false;
    render();
  }, 1000);
}

$('pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  pin = $('pin').value;
  start();
});

if (pin) start();
