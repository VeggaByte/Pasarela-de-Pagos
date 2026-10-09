import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { OrderError, STATUS, safeEqual } from './orders.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp({ service, hub, staffPin, baseUrl }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    next();
  });

  // ---------- Páginas ----------
  app.use('/static', express.static(PUBLIC_DIR));
  app.get('/m/:tableToken', (req, res) => res.sendFile('menu.html', { root: PUBLIC_DIR }));
  app.get('/cocina', (req, res) => res.sendFile('cocina.html', { root: PUBLIC_DIR }));
  app.get('/admin/qr', (req, res) => res.sendFile('qr.html', { root: PUBLIC_DIR }));
  app.get('/', (req, res) => res.redirect('/cocina'));

  // ---------- API del cliente ----------
  const orderToken = (req) => req.get('x-order-token') ?? req.query.token;

  app.get('/api/tables/:tableToken', (req, res) => {
    const table = service.getTableByToken(req.params.tableToken);
    res.json({ table, menu: service.getMenu(), editWindowMs: service.editWindowMs, serverNow: Date.now() });
  });

  app.post('/api/orders', (req, res) => {
    const { order, accessToken } = service.createOrder({
      tableToken: req.body?.tableToken,
      items: req.body?.items,
    });
    res.status(201).json({ order, accessToken, serverNow: Date.now() });
  });

  app.get('/api/orders/:id', (req, res) => {
    res.json({ order: service.authorize(req.params.id, orderToken(req)), serverNow: Date.now() });
  });

  app.post('/api/orders/:id/pay', async (req, res) => {
    const order = await service.payOrder(req.params.id, orderToken(req));
    res.json({ order, serverNow: Date.now() });
  });

  app.put('/api/orders/:id/items', async (req, res) => {
    const result = await service.modifyOrder(req.params.id, orderToken(req), req.body?.items);
    res.json({ ...result, serverNow: Date.now() });
  });

  app.post('/api/orders/:id/cancel', async (req, res) => {
    const result = await service.cancelOrder(req.params.id, orderToken(req));
    res.json({ ...result, serverNow: Date.now() });
  });

  app.get('/api/orders/:id/events', (req, res) => {
    const order = service.authorize(req.params.id, orderToken(req));
    hub.addCustomer(order.id, req, res);
  });

  // ---------- API de personal (cocina / admin) ----------
  const staff = express.Router();
  staff.use((req, res, next) => {
    const pin = req.get('x-staff-pin') ?? req.query.pin;
    if (!safeEqual(pin, staffPin)) return res.status(401).json({ error: 'unauthorized', message: 'PIN incorrecto' });
    next();
  });

  staff.get('/kitchen/orders', (req, res) => {
    res.json({ orders: service.listKitchenOrders(), serverNow: Date.now() });
  });

  staff.get('/kitchen/events', (req, res) => hub.addKitchen(req, res));

  staff.post('/kitchen/orders/:id/lock', (req, res) => {
    res.json({ order: service.lockOrder(req.params.id, 'kitchen'), serverNow: Date.now() });
  });

  staff.post('/kitchen/orders/:id/status', (req, res) => {
    const status = req.body?.status;
    if (![STATUS.READY, STATUS.DELIVERED].includes(status)) {
      throw new OrderError('invalid_status', 'Estado inválido');
    }
    res.json({ order: service.setKitchenStatus(req.params.id, status), serverNow: Date.now() });
  });

  staff.get('/admin/tables', async (req, res) => {
    const tables = service.db.prepare('SELECT id, name, token FROM tables ORDER BY id').all();
    const result = await Promise.all(
      tables.map(async (t) => {
        const url = new URL(`/m/${t.token}`, baseUrl).toString();
        const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return { id: t.id, name: t.name, url, qrSvg };
      }),
    );
    res.json({ tables: result });
  });

  app.use('/api', staff);

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'Ruta no encontrada' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof OrderError) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'JSON inválido' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal', message: 'Error interno' });
  });

  return app;
}
