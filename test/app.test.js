import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../src/db.js';
import { OrderService } from '../src/orders.js';
import { MockPaymentProvider } from '../src/payments/mock.js';
import { RealtimeHub } from '../src/realtime.js';
import { createApp } from '../src/app.js';
import { seedIfEmpty } from '../src/seed.js';

let server;
let base;
let hub;
let tableToken;

before(async () => {
  const db = openDatabase(':memory:');
  seedIfEmpty(db, { tables: 2 });
  tableToken = db.prepare('SELECT token FROM tables ORDER BY id LIMIT 1').get().token;
  const events = new EventEmitter();
  const service = new OrderService({ db, payments: new MockPaymentProvider(), events });
  hub = new RealtimeHub(events);
  const app = createApp({ service, hub, staffPin: '9999', baseUrl: 'http://cafe.test' });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  hub.close();
  server.close();
});

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('flujo completo: menú → orden → pago → cambio → cocina', async () => {
  const table = await call(`/api/tables/${tableToken}`);
  assert.equal(table.status, 200);
  assert.equal(table.body.table.name, 'Mesa 1');
  const [first, second] = table.body.menu;

  const created = await call('/api/orders', {
    method: 'POST',
    body: { tableToken, items: [{ menuItemId: first.id, quantity: 1 }] },
  });
  assert.equal(created.status, 201);
  const { order, accessToken } = created.body;
  const auth = { 'X-Order-Token': accessToken };

  const paid = await call(`/api/orders/${order.id}/pay`, { method: 'POST', headers: auth });
  assert.equal(paid.body.order.status, 'received');

  const modified = await call(`/api/orders/${order.id}/items`, {
    method: 'PUT',
    headers: auth,
    body: { items: [{ menuItemId: first.id, quantity: 1 }, { menuItemId: second.id, quantity: 1 }] },
  });
  assert.equal(modified.status, 200);
  assert.equal(modified.body.chargedCents, second.priceCents);

  assert.equal((await call('/api/kitchen/orders')).status, 401);
  assert.equal((await call('/api/kitchen/orders', { headers: { 'X-Staff-Pin': 'mal' } })).status, 401);

  const staff = { 'X-Staff-Pin': '9999' };
  const kitchen = await call('/api/kitchen/orders', { headers: staff });
  assert.deepEqual(kitchen.body.orders.map((o) => o.id), [order.id]);
  assert.equal(kitchen.body.orders[0].access_token, undefined);

  const locked = await call(`/api/kitchen/orders/${order.id}/lock`, { method: 'POST', headers: staff });
  assert.equal(locked.body.order.status, 'preparing');

  const late = await call(`/api/orders/${order.id}/items`, {
    method: 'PUT',
    headers: auth,
    body: { items: [{ menuItemId: first.id, quantity: 5 }] },
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'order_locked');

  const ready = await call(`/api/kitchen/orders/${order.id}/status`, { method: 'POST', headers: staff, body: { status: 'ready' } });
  assert.equal(ready.body.order.status, 'ready');
});

test('errores de entrada devuelven JSON claro', async () => {
  assert.equal((await call('/api/tables/no-existe')).status, 404);
  assert.equal((await call('/api/orders/1', { headers: { 'X-Order-Token': 'x' } })).status, 404);
  const bad = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
});

test('los QR apuntan al menú de cada mesa', async () => {
  const res = await call('/api/admin/tables', { headers: { 'X-Staff-Pin': '9999' } });
  assert.equal(res.body.tables.length, 2);
  assert.equal(res.body.tables[0].url, `http://cafe.test/m/${tableToken}`);
  assert.match(res.body.tables[0].qrSvg, /^<svg/);
});

test('las páginas se sirven', async () => {
  for (const path of [`/m/${tableToken}`, '/cocina', '/admin/qr', '/static/menu.js']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
  }
});
