import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { OrderService, STATUS } from '../src/orders.js';
import { MockPaymentProvider } from '../src/payments/mock.js';

const WINDOW = 120_000;
let clock;
let db;
let service;
let tableToken;
let menu; // name -> id
let events;

function setup(payments = new MockPaymentProvider()) {
  clock = 1_000_000;
  db = openDatabase(':memory:');
  db.prepare("INSERT INTO tables (name, token) VALUES ('Mesa 1', 'tok-mesa-1')").run();
  const insert = db.prepare('INSERT INTO menu_items (name, price_cents, available) VALUES (?, ?, ?)');
  insert.run('Café', 4000, 1);
  insert.run('Pan', 2500, 1);
  insert.run('Agotado', 1000, 0);
  menu = Object.fromEntries(db.prepare('SELECT name, id FROM menu_items').all().map((r) => [r.name, r.id]));
  tableToken = 'tok-mesa-1';
  service = new OrderService({ db, payments, editWindowMs: WINDOW, now: () => clock });
  events = [];
  service.events.on('order', (e) => events.push(e.type));
}

beforeEach(() => setup());

async function paidOrder(items = [{ menuItemId: menu['Café'], quantity: 2 }]) {
  const { order, accessToken } = service.createOrder({ tableToken, items });
  const paid = await service.payOrder(order.id, accessToken);
  return { order: paid, token: accessToken };
}

const payments = (orderId) =>
  db.prepare('SELECT kind, amount_cents AS amount, status FROM payments WHERE order_id = ? ORDER BY id').all(orderId);

test('el servidor calcula el precio, no el cliente', () => {
  const { order } = service.createOrder({
    tableToken,
    items: [{ menuItemId: menu['Café'], quantity: 2, priceCents: 1 }],
  });
  assert.equal(order.totalCents, 8000);
  assert.equal(order.status, STATUS.PENDING_PAYMENT);
});

test('rechaza productos no disponibles, cantidades inválidas y mesas inexistentes', () => {
  assert.throws(() => service.createOrder({ tableToken, items: [{ menuItemId: menu['Agotado'], quantity: 1 }] }), { code: 'item_unavailable' });
  assert.throws(() => service.createOrder({ tableToken, items: [{ menuItemId: menu['Café'], quantity: 0 }] }), { code: 'invalid_quantity' });
  assert.throws(() => service.createOrder({ tableToken, items: [{ menuItemId: menu['Café'], quantity: 1.5 }] }), { code: 'invalid_quantity' });
  assert.throws(() => service.createOrder({ tableToken, items: [] }), { code: 'empty_order' });
  assert.throws(() => service.createOrder({ tableToken: 'nope', items: [{ menuItemId: menu['Café'], quantity: 1 }] }), { code: 'table_not_found' });
});

test('al pagar la orden pasa a cocina con ventana de cambios', async () => {
  const { order } = await paidOrder();
  assert.equal(order.status, STATUS.RECEIVED);
  assert.equal(order.paidCents, 8000);
  assert.equal(order.editableUntil, clock + WINDOW);
  assert.equal(order.editable, true);
  assert.deepEqual(events, ['order.paid']);
  assert.deepEqual(service.listKitchenOrders().map((o) => o.id), [order.id]);
});

test('las órdenes sin pagar no aparecen en cocina', () => {
  service.createOrder({ tableToken, items: [{ menuItemId: menu['Café'], quantity: 1 }] });
  assert.equal(service.listKitchenOrders().length, 0);
});

test('no se puede pagar dos veces', async () => {
  const { order, token } = await paidOrder();
  await assert.rejects(service.payOrder(order.id, token), { code: 'already_paid' });
  assert.equal(payments(order.id).length, 1);
});

test('un token incorrecto no da acceso a la orden', async () => {
  const { order } = await paidOrder();
  assert.throws(() => service.authorize(order.id, 'otro'), { code: 'order_not_found' });
  await assert.rejects(service.cancelOrder(order.id, 'otro'), { code: 'order_not_found' });
});

test('modificar dentro de la ventana cobra la diferencia cuando sube', async () => {
  const { order, token } = await paidOrder();
  clock += 30_000;
  const res = await service.modifyOrder(order.id, token, [
    { menuItemId: menu['Café'], quantity: 2 },
    { menuItemId: menu['Pan'], quantity: 1, notes: 'calientito' },
  ]);
  assert.equal(res.chargedCents, 2500);
  assert.equal(res.order.totalCents, 10500);
  assert.equal(res.order.paidCents, 10500);
  assert.equal(res.order.modifiedCount, 1);
  assert.equal(res.order.items[1].notes, 'calientito');
  assert.deepEqual(payments(order.id).map((p) => [p.kind, p.amount]), [['charge', 8000], ['charge', 2500]]);
  assert.deepEqual(events, ['order.paid', 'order.modified']);
});

test('modificar reembolsa la diferencia cuando baja, repartida entre cobros', async () => {
  const { order, token } = await paidOrder([{ menuItemId: menu['Café'], quantity: 1 }]); // 4000
  await service.modifyOrder(order.id, token, [{ menuItemId: menu['Café'], quantity: 3 }]); // +8000
  const res = await service.modifyOrder(order.id, token, [{ menuItemId: menu['Pan'], quantity: 1 }]); // 2500

  assert.equal(res.refundedCents, 9500);
  assert.equal(res.order.paidCents, 2500);
  assert.deepEqual(
    payments(order.id).map((p) => [p.kind, p.amount]),
    [['charge', 4000], ['charge', 8000], ['refund', 8000], ['refund', 1500]],
  );
});

test('no se puede modificar después de la ventana de cambios', async () => {
  const { order, token } = await paidOrder();
  clock += WINDOW;
  await assert.rejects(
    service.modifyOrder(order.id, token, [{ menuItemId: menu['Pan'], quantity: 1 }]),
    { code: 'edit_window_closed' },
  );
});

test('cuando cocina marca "sin cambios" ya no se puede modificar ni cancelar', async () => {
  const { order, token } = await paidOrder();
  const locked = service.lockOrder(order.id, 'kitchen');
  assert.equal(locked.status, STATUS.PREPARING);
  assert.equal(locked.lockedBy, 'kitchen');
  assert.equal(locked.editable, false);
  await assert.rejects(service.modifyOrder(order.id, token, [{ menuItemId: menu['Pan'], quantity: 1 }]), { code: 'order_locked' });
  await assert.rejects(service.cancelOrder(order.id, token), { code: 'order_locked' });
  // Bloquear de nuevo es inofensivo.
  assert.equal(service.lockOrder(order.id).status, STATUS.PREPARING);
});

test('el barrido bloquea las órdenes cuya ventana expiró', async () => {
  const { order: a } = await paidOrder();
  clock += 60_000;
  const { order: b } = await paidOrder();

  clock = a.editableUntil - 1;
  assert.equal(service.lockExpired(), 0);
  clock = a.editableUntil;
  assert.equal(service.lockExpired(), 1);

  assert.equal(service.getOrder(a.id).status, STATUS.PREPARING);
  assert.equal(service.getOrder(a.id).lockedBy, 'timeout');
  assert.equal(service.getOrder(b.id).status, STATUS.RECEIVED);
});

test('si cocina bloquea mientras se cobra la diferencia, el cobro se reembolsa', async () => {
  let release;
  const slow = new MockPaymentProvider();
  const realCharge = slow.charge.bind(slow);
  setup(slow);
  const { order, token } = await paidOrder();

  slow.charge = async (args) => {
    await new Promise((r) => { release = r; });
    return realCharge(args);
  };
  const pending = service.modifyOrder(order.id, token, [{ menuItemId: menu['Café'], quantity: 3 }]);
  await new Promise((r) => setImmediate(r));
  service.lockOrder(order.id, 'kitchen');
  release();

  await assert.rejects(pending, { code: 'order_locked' });
  const after = service.getOrder(order.id);
  assert.equal(after.totalCents, 8000);
  assert.equal(after.paidCents, 8000);
  assert.equal(after.items[0].quantity, 2);
  assert.deepEqual(
    payments(order.id).map((p) => [p.kind, p.amount]),
    [['charge', 8000], ['charge', 4000], ['refund', 4000]],
  );
});

test('el barrido no bloquea una orden mientras se está cobrando un cambio', async () => {
  let release;
  const slow = new MockPaymentProvider();
  const realCharge = slow.charge.bind(slow);
  setup(slow);
  const { order, token } = await paidOrder();

  slow.charge = async (args) => {
    await new Promise((r) => { release = r; });
    return realCharge(args);
  };
  clock = order.editableUntil - 1000;
  const pending = service.modifyOrder(order.id, token, [{ menuItemId: menu['Café'], quantity: 3 }]);
  await new Promise((r) => setImmediate(r));
  clock = order.editableUntil + 500; // el tiempo vence mientras el banco responde
  assert.equal(service.lockExpired(), 0);
  release();

  const res = await pending;
  assert.equal(res.order.totalCents, 12000);
  assert.equal(service.lockExpired(), 1);
});

test('dos cambios simultáneos: el segundo se rechaza', async () => {
  const { order, token } = await paidOrder();
  const items = [{ menuItemId: menu['Café'], quantity: 3 }];
  const [first, second] = await Promise.allSettled([
    service.modifyOrder(order.id, token, items),
    service.modifyOrder(order.id, token, items),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'busy');
  assert.equal(payments(order.id).filter((p) => p.kind === 'charge').length, 2);
});

test('si el cobro de la diferencia es rechazado la orden no cambia', async () => {
  const { order, token } = await paidOrder();
  service.payments.charge = async () => ({ status: 'rejected', ref: null });
  await assert.rejects(service.modifyOrder(order.id, token, [{ menuItemId: menu['Café'], quantity: 5 }]), { code: 'payment_rejected' });
  assert.equal(service.getOrder(order.id).totalCents, 8000);
});

test('cancelar dentro de la ventana reembolsa todo', async () => {
  const { order, token } = await paidOrder();
  const res = await service.cancelOrder(order.id, token);
  assert.equal(res.order.status, STATUS.CANCELLED);
  assert.equal(res.refundedCents, 8000);
  assert.equal(res.order.paidCents, 0);
  assert.equal(service.listKitchenOrders().length, 0);
  assert.deepEqual(events, ['order.paid', 'order.cancelled']);
});

test('cocina avanza la orden: en preparación → lista → entregada', async () => {
  const { order } = await paidOrder();
  assert.throws(() => service.setKitchenStatus(order.id, STATUS.READY), { code: 'invalid_transition' });
  service.lockOrder(order.id);
  assert.equal(service.setKitchenStatus(order.id, STATUS.READY).status, STATUS.READY);
  assert.equal(service.setKitchenStatus(order.id, STATUS.DELIVERED).status, STATUS.DELIVERED);
  assert.equal(service.listKitchenOrders().length, 0);
  assert.throws(() => service.setKitchenStatus(order.id, STATUS.CANCELLED), { code: 'invalid_status' });
});

test('una orden pendiente de pago se puede modificar sin cobros', async () => {
  const { order, accessToken } = service.createOrder({ tableToken, items: [{ menuItemId: menu['Café'], quantity: 1 }] });
  const res = await service.modifyOrder(order.id, accessToken, [{ menuItemId: menu['Pan'], quantity: 2 }]);
  assert.equal(res.order.totalCents, 5000);
  assert.equal(res.order.status, STATUS.PENDING_PAYMENT);
  assert.equal(payments(order.id).length, 0);
  const paid = await service.payOrder(order.id, accessToken);
  assert.equal(paid.paidCents, 5000);
});
