import { el, money, api, storage, formatCountdown, syncClock, serverNow } from './common.js';

const tableToken = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const sessionKey = `orden:${tableToken}`;
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);

const state = {
  table: null,
  menu: [],
  cart: [], // [{ menuItemId, name, priceCents, quantity, notes }]
  view: 'menu', // 'menu' | 'cart' | 'status'
  order: null,
  session: null, // { id, token }
  editing: false, // modificando una orden ya pagada
  busy: false,
  lastMessage: null,
  events: null,
};

// ---------- Carrito ----------

const cartTotal = () => state.cart.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
const cartCount = () => state.cart.reduce((sum, l) => sum + l.quantity, 0);
const countOf = (id) => state.cart.filter((l) => l.menuItemId === id).reduce((s, l) => s + l.quantity, 0);

function addItem(item) {
  const line = state.cart.find((l) => l.menuItemId === item.id && !l.notes);
  if (line) line.quantity++;
  else state.cart.push({ menuItemId: item.id, name: item.name, priceCents: item.priceCents, quantity: 1, notes: '' });
  render();
}

function removeItem(id) {
  const idx = state.cart.findLastIndex((l) => l.menuItemId === id);
  if (idx === -1) return;
  changeLine(state.cart[idx], -1);
}

function changeLine(line, delta) {
  line.quantity += delta;
  if (line.quantity <= 0) state.cart.splice(state.cart.indexOf(line), 1);
  render();
}

const cartPayload = () =>
  state.cart.map(({ menuItemId, quantity, notes }) => ({ menuItemId, quantity, notes: notes.trim() }));

// ---------- Mensajes ----------

function showAlert(message, kind = 'error') {
  const box = $('alert');
  box.replaceChildren(message ? el('div', { class: `alert alert-${kind}`, role: 'alert' }, message) : '');
  if (message) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- Vistas ----------

function render() {
  $('title').textContent = state.table ? state.table.name : 'Menú';
  const view = $('view');
  if (state.view === 'menu') view.replaceChildren(renderMenu());
  else if (state.view === 'cart') view.replaceChildren(renderCart());
  else view.replaceChildren(renderStatus());
  renderCartBar();
  tick();
}

function renderMenu() {
  $('subtitle').textContent = state.editing
    ? 'Modificando tu orden'
    : 'Elige lo que quieras y paga desde tu celular.';
  const frag = document.createDocumentFragment();
  if (state.editing) frag.append(editBanner());

  let category = null;
  for (const item of state.menu) {
    if (item.category !== category) {
      category = item.category;
      frag.append(el('h2', { class: 'category' }, category));
    }
    const n = countOf(item.id);
    frag.append(
      el('div', { class: 'card menu-item' },
        el('div', { class: 'info' },
          el('div', {}, el('strong', {}, item.name)),
          item.description ? el('div', { class: 'muted small' }, item.description) : null,
          el('div', { class: 'price' }, money(item.priceCents)),
        ),
        el('div', { class: 'qty' },
          n > 0 ? el('button', { class: 'icon-btn', 'aria-label': `Quitar ${item.name}`, onclick: () => removeItem(item.id) }, '−') : null,
          n > 0 ? el('span', {}, n) : null,
          el('button', { class: 'icon-btn', 'aria-label': `Agregar ${item.name}`, onclick: () => addItem(item) }, '+'),
        ),
      ),
    );
  }
  return frag;
}

function renderCartBar() {
  const bar = $('cart-bar');
  const show = state.view === 'menu' && (state.cart.length > 0 || state.editing);
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  const label = state.editing
    ? `Revisar cambios · ${money(cartTotal())}`
    : `Ver orden · ${cartCount()} · ${money(cartTotal())}`;
  bar.replaceChildren(el('button', { class: 'btn btn-primary btn-block', onclick: () => go('cart') }, label));
}

function editBanner() {
  return el('div', { class: 'alert alert-info' },
    'Puedes modificar tu orden durante ',
    el('strong', { 'data-countdown': '' }, ''),
    '. Al guardar se cobra o reembolsa la diferencia.',
  );
}

function renderCart() {
  $('subtitle').textContent = state.editing ? 'Revisa los cambios' : 'Tu orden';
  const frag = document.createDocumentFragment();
  if (state.editing) frag.append(editBanner());

  if (state.cart.length === 0) {
    frag.append(el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Tu orden está vacía.')));
  } else {
    frag.append(
      el('div', { class: 'card' },
        state.cart.map((line) =>
          el('div', { class: 'line' },
            el('div', { class: 'line-top' },
              el('div', {}, el('strong', {}, line.name), el('div', { class: 'muted small' }, money(line.priceCents * line.quantity))),
              el('div', { class: 'qty' },
                el('button', { class: 'icon-btn', 'aria-label': 'Menos', onclick: () => changeLine(line, -1) }, '−'),
                el('span', {}, line.quantity),
                el('button', { class: 'icon-btn', 'aria-label': 'Más', onclick: () => changeLine(line, 1) }, '+'),
              ),
            ),
            el('textarea', {
              placeholder: 'Notas (ej. sin azúcar)',
              maxlength: '200',
              rows: '1',
              oninput: (e) => { line.notes = e.target.value; },
            }, line.notes),
          ),
        ),
      ),
    );
  }

  const total = cartTotal();
  frag.append(el('div', { class: 'totals' }, el('span', {}, 'Total'), el('span', {}, money(total))));

  if (state.editing) {
    const diff = total - state.order.paidCents;
    frag.append(
      el('p', { class: 'muted' },
        diff > 0 ? `Se cobrará ${money(diff)} adicional.`
          : diff < 0 ? `Se te reembolsarán ${money(-diff)}.`
            : 'El total no cambia.'),
    );
  }

  const canSubmit = state.cart.length > 0 && !state.busy;
  frag.append(
    el('div', { class: 'actions' },
      el('button', { class: 'btn', onclick: () => go('menu') }, 'Agregar más'),
      state.editing
        ? el('button', { class: 'btn btn-primary', disabled: !canSubmit, onclick: saveChanges }, state.busy ? 'Guardando…' : 'Guardar cambios')
        : el('button', { class: 'btn btn-primary', disabled: !canSubmit, onclick: pay }, state.busy ? 'Procesando pago…' : `Pagar ${money(total)}`),
    ),
  );
  if (state.editing) {
    frag.append(el('p', {}, el('button', { class: 'btn btn-block mt', onclick: discardChanges }, 'Descartar cambios')));
  }
  return frag;
}

function renderStatus() {
  const o = state.order;
  $('subtitle').textContent = `Orden #${o.id}`;
  const frag = document.createDocumentFragment();
  const hero = el('div', { class: 'card status-hero' });

  if (o.status === 'received' && o.editable) {
    hero.append(
      el('h2', {}, '¡Pago recibido! Tu orden ya está en cocina.'),
      el('div', { class: 'big', 'data-countdown': '' }, ''),
      el('p', { class: 'muted' }, 'para modificar o cancelar tu orden'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn-primary', disabled: state.busy, onclick: startEditing }, 'Modificar'),
        el('button', { class: 'btn btn-danger', disabled: state.busy, onclick: cancelOrder }, 'Cancelar orden'),
      ),
    );
  } else if (o.status === 'received' || o.status === 'preparing') {
    hero.append(el('h2', {}, 'Tu orden se está preparando ☕'), el('p', { class: 'muted' }, 'Te avisamos aquí cuando esté lista.'));
  } else if (o.status === 'ready') {
    hero.append(el('h2', {}, '¡Tu orden está lista! 🎉'), el('p', { class: 'muted' }, 'En un momento te la llevamos a tu mesa.'));
  } else if (o.status === 'delivered') {
    hero.append(el('h2', {}, '¡Buen provecho!'), newOrderButton());
  } else if (o.status === 'cancelled') {
    hero.append(el('h2', {}, 'Orden cancelada'), newOrderButton());
  }
  frag.append(hero);

  frag.append(
    el('div', { class: 'card' },
      el('h2', {}, 'Resumen'),
      o.items.map((i) =>
        el('div', { class: 'line' },
          el('div', { class: 'line-top' },
            el('span', {}, `${i.quantity} × ${i.name}`),
            el('span', {}, money(i.unitPriceCents * i.quantity)),
          ),
          i.notes ? el('div', { class: 'muted small' }, i.notes) : null,
        ),
      ),
      el('div', { class: 'totals' }, el('span', {}, 'Total'), el('span', {}, money(o.totalCents))),
      o.status !== 'cancelled' && o.paidCents > o.totalCents
        ? el('p', { class: 'muted small' }, `Saldo a favor pendiente de reembolso: ${money(o.paidCents - o.totalCents)}`)
        : null,
    ),
  );
  return frag;
}

function newOrderButton() {
  return el('button', { class: 'btn btn-primary', onclick: newOrder }, 'Hacer otra orden');
}

// Actualiza los contadores sin volver a pintar toda la página.
function tick() {
  const o = state.order;
  const nodes = document.querySelectorAll('[data-countdown]');
  if (!o || !o.editableUntil) return;
  const remaining = o.editableUntil - serverNow();
  for (const node of nodes) node.textContent = formatCountdown(remaining);

  if (remaining <= 0 && o.editable) {
    o.editable = false;
    if (state.editing) {
      state.editing = false;
      state.cart = [];
      state.view = 'status';
      showAlert('Se terminó el tiempo para hacer cambios. Tu orden sigue igual.', 'info');
    }
    render();
  }
}

// ---------- Acciones ----------

function go(view) {
  state.view = view;
  showAlert(null);
  render();
  window.scrollTo({ top: 0 });
}

const orderHeaders = () => ({ 'X-Order-Token': state.session.token });

function setOrder(order) {
  state.order = order;
  render();
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await fn();
  } catch (err) {
    showAlert(err.message);
    if (['order_locked', 'edit_window_closed'].includes(err.code)) await reloadOrder(true);
  } finally {
    state.busy = false;
    render();
  }
}

function pay() {
  return withBusy(async () => {
    if (state.session && state.order?.status === 'pending_payment') {
      // Un intento de pago anterior falló: actualizamos la misma orden.
      await api(`/api/orders/${state.session.id}/items`, { method: 'PUT', headers: orderHeaders(), body: { items: cartPayload() } });
    } else {
      const created = await api('/api/orders', { method: 'POST', body: { tableToken, items: cartPayload() } });
      state.session = { id: created.order.id, token: created.accessToken };
      storage.set(sessionKey, state.session);
      state.order = created.order;
    }
    const { order, serverNow: now } = await api(`/api/orders/${state.session.id}/pay`, { method: 'POST', headers: orderHeaders() });
    syncClock(now);
    state.cart = [];
    state.view = 'status';
    setOrder(order);
    connectEvents();
    window.scrollTo({ top: 0 });
  });
}

function startEditing() {
  state.editing = true;
  state.cart = state.order.items.map((i) => ({
    menuItemId: i.menuItemId,
    name: i.name,
    priceCents: i.unitPriceCents,
    quantity: i.quantity,
    notes: i.notes,
  }));
  go('cart');
}

function discardChanges() {
  state.editing = false;
  state.cart = [];
  go('status');
}

function saveChanges() {
  return withBusy(async () => {
    const res = await api(`/api/orders/${state.session.id}/items`, {
      method: 'PUT',
      headers: orderHeaders(),
      body: { items: cartPayload() },
    });
    syncClock(res.serverNow);
    state.editing = false;
    state.cart = [];
    state.view = 'status';
    setOrder(res.order);
    showAlert(
      res.chargedCents > 0 ? `Cambios guardados. Se cobraron ${money(res.chargedCents)} adicionales.`
        : res.refundedCents > 0 ? `Cambios guardados. Se reembolsaron ${money(res.refundedCents)}.`
          : 'Cambios guardados.',
      'ok',
    );
  });
}

function cancelOrder() {
  if (!confirm('¿Seguro que quieres cancelar tu orden? Se te reembolsará el total.')) return;
  return withBusy(async () => {
    const res = await api(`/api/orders/${state.session.id}/cancel`, { method: 'POST', headers: orderHeaders() });
    setOrder(res.order);
    showAlert(`Orden cancelada. Reembolso: ${money(res.refundedCents)}.`, 'ok');
  });
}

function newOrder() {
  storage.remove(sessionKey);
  state.events?.close();
  Object.assign(state, { session: null, order: null, cart: [], editing: false, events: null });
  go('menu');
}

async function reloadOrder(exitEditing = false) {
  if (!state.session) return;
  try {
    const { order, serverNow: now } = await api(`/api/orders/${state.session.id}`, { headers: orderHeaders() });
    syncClock(now);
    if (exitEditing || !order.editable) {
      state.editing = false;
      state.cart = [];
      state.view = 'status';
    }
    setOrder(order);
  } catch {}
}

function connectEvents() {
  state.events?.close();
  const { id, token } = state.session;
  const source = new EventSource(`/api/orders/${id}/events?token=${encodeURIComponent(token)}`);
  const onEvent = (e) => {
    const order = JSON.parse(e.data);
    const wasEditing = state.editing;
    state.order = order;
    if (wasEditing && !order.editable) {
      state.editing = false;
      state.cart = [];
      state.view = 'status';
      showAlert('La cocina ya empezó a preparar tu orden; ya no se pueden hacer cambios.', 'info');
    }
    render();
  };
  for (const type of ['order.paid', 'order.modified', 'order.cancelled', 'order.locked', 'order.ready', 'order.delivered']) {
    source.addEventListener(type, onEvent);
  }
  // Al reconectar puede que nos hayamos perdido eventos.
  source.addEventListener('open', () => reloadOrder());
  state.events = source;
}

// ---------- Inicio ----------

async function init() {
  try {
    const data = await api(`/api/tables/${encodeURIComponent(tableToken)}`);
    syncClock(data.serverNow);
    state.table = data.table;
    state.menu = data.menu;
  } catch (err) {
    $('title').textContent = 'Mesa no encontrada';
    showAlert('Este código QR no es válido. Pide ayuda al personal.');
    return;
  }

  const saved = storage.get(sessionKey);
  if (saved?.id && saved?.token) {
    try {
      const { order, serverNow: now } = await api(`/api/orders/${saved.id}`, { headers: { 'X-Order-Token': saved.token } });
      syncClock(now);
      const finished = ['delivered', 'cancelled'].includes(order.status);
      if (finished && serverNow() - order.createdAt > SESSION_MAX_AGE_MS) {
        storage.remove(sessionKey);
      } else {
        state.session = saved;
        state.order = order;
        if (order.status === 'pending_payment') {
          state.cart = order.items.map((i) => ({ ...i, priceCents: i.unitPriceCents }));
          state.view = 'cart';
        } else {
          state.view = 'status';
          if (!finished) connectEvents();
        }
      }
    } catch {
      storage.remove(sessionKey);
    }
  }
  render();
  setInterval(tick, 1000);
}

init();
