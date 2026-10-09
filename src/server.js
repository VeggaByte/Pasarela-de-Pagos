import { EventEmitter } from 'node:events';
import { openDatabase } from './db.js';
import { OrderService } from './orders.js';
import { MockPaymentProvider } from './payments/mock.js';
import { RealtimeHub } from './realtime.js';
import { createApp } from './app.js';
import { seedIfEmpty } from './seed.js';

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const DB_PATH = process.env.DB_PATH ?? 'data/ordenes.db';
const EDIT_WINDOW_SECONDS = Number(process.env.EDIT_WINDOW_SECONDS ?? 120);
const STAFF_PIN = process.env.STAFF_PIN ?? '1234';

if (!process.env.STAFF_PIN) {
  console.warn('[aviso] STAFF_PIN no está definido; usando "1234". Cámbialo antes de usarlo en producción.');
}

const db = openDatabase(DB_PATH);
if (seedIfEmpty(db)) console.log('Base de datos inicializada con menú y 10 mesas de ejemplo.');

const events = new EventEmitter();
const service = new OrderService({
  db,
  payments: new MockPaymentProvider({ delayMs: 400 }),
  editWindowMs: EDIT_WINDOW_SECONDS * 1000,
  events,
});
const hub = new RealtimeHub(events);

// Bloquea automáticamente las órdenes cuya ventana de cambios terminó.
setInterval(() => {
  try {
    service.lockExpired();
  } catch (err) {
    console.error('[barrido]', err);
  }
}, 1000).unref();

const app = createApp({ service, hub, staffPin: STAFF_PIN, baseUrl: BASE_URL });
app.listen(PORT, () => {
  console.log(`Servidor listo en ${BASE_URL}`);
  console.log(`  Cocina:     ${BASE_URL}/cocina`);
  console.log(`  QR mesas:   ${BASE_URL}/admin/qr`);
});
