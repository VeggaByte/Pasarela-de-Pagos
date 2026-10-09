import { EventEmitter } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { transaction } from './db.js';

export const STATUS = Object.freeze({
  PENDING_PAYMENT: 'pending_payment', // creada, aún sin pagar (cocina no la ve)
  RECEIVED: 'received', // pagada; el cliente todavía puede modificarla o cancelarla
  PREPARING: 'preparing', // bloqueada: cocina confirmó "sin cambios" o se acabó el tiempo
  READY: 'ready',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
});

const KITCHEN_STATUSES = [STATUS.RECEIVED, STATUS.PREPARING, STATUS.READY];
const KITCHEN_TRANSITIONS = {
  [STATUS.READY]: [STATUS.PREPARING],
  [STATUS.DELIVERED]: [STATUS.READY],
};

const MAX_LINES = 50;
const MAX_QUANTITY = 50;
const MAX_NOTES = 200;

export class OrderError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function newToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class OrderService {
  constructor({ db, payments, editWindowMs = 120_000, now = Date.now, events = new EventEmitter() }) {
    this.db = db;
    this.payments = payments;
    this.editWindowMs = editWindowMs;
    this.now = now;
    this.events = events;
    // Órdenes con una operación de pago en curso. Evita dobles cobros por doble clic
    // y que el barrido por tiempo bloquee una orden mientras se cobra la diferencia.
    this.busy = new Set();
  }

  // ---------- Mesas y menú ----------

  getTableByToken(token) {
    const table = this.db.prepare('SELECT id, name FROM tables WHERE token = ?').get(String(token ?? ''));
    if (!table) throw new OrderError('table_not_found', 'Mesa no encontrada', 404);
    return table;
  }

  getMenu() {
    return this.db
      .prepare(
        `SELECT id, name, description, category, price_cents AS priceCents
         FROM menu_items WHERE available = 1 ORDER BY sort_order, id`,
      )
      .all();
  }

  // Calcula precios en el servidor; nunca se confía en el precio que manda el cliente.
  priceItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new OrderError('empty_order', 'La orden no tiene productos');
    }
    if (items.length > MAX_LINES) throw new OrderError('too_many_items', 'Demasiados productos');

    const findItem = this.db.prepare('SELECT id, name, price_cents, available FROM menu_items WHERE id = ?');
    let totalCents = 0;
    const lines = items.map((raw) => {
      const menuItemId = Number(raw?.menuItemId);
      const quantity = Number(raw?.quantity);
      const notes = typeof raw?.notes === 'string' ? raw.notes.trim() : '';
      if (!Number.isInteger(menuItemId)) throw new OrderError('invalid_item', 'Producto inválido');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
        throw new OrderError('invalid_quantity', 'Cantidad inválida');
      }
      if (notes.length > MAX_NOTES) throw new OrderError('notes_too_long', 'La nota es demasiado larga');

      const item = findItem.get(menuItemId);
      if (!item || !item.available) {
        throw new OrderError('item_unavailable', `Producto no disponible (${menuItemId})`, 409);
      }
      totalCents += item.price_cents * quantity;
      return { menuItemId, name: item.name, unitPriceCents: item.price_cents, quantity, notes };
    });

    if (totalCents <= 0) throw new OrderError('invalid_total', 'El total debe ser mayor a cero');
    return { lines, totalCents };
  }

  // ---------- Consultas ----------

  getOrder(orderId) {
    const row = this.db
      .prepare(
        `SELECT o.*, t.name AS table_name FROM orders o JOIN tables t ON t.id = o.table_id WHERE o.id = ?`,
      )
      .get(Number(orderId));
    if (!row) throw new OrderError('order_not_found', 'Orden no encontrada', 404);
    const items = this.db
      .prepare(
        `SELECT menu_item_id AS menuItemId, name, unit_price_cents AS unitPriceCents, quantity, notes
         FROM order_items WHERE order_id = ? ORDER BY id`,
      )
      .all(row.id);
    return this.#serialize(row, items);
  }

  // Devuelve la orden sólo si el token es correcto. Responde 404 en ambos casos para
  // no revelar qué ids existen.
  authorize(orderId, accessToken) {
    const row = this.db.prepare('SELECT access_token FROM orders WHERE id = ?').get(Number(orderId));
    if (!row || !safeEqual(row.access_token, accessToken)) {
      throw new OrderError('order_not_found', 'Orden no encontrada', 404);
    }
    return this.getOrder(orderId);
  }

  listKitchenOrders() {
    const ids = this.db
      .prepare(
        `SELECT id FROM orders WHERE status IN (${KITCHEN_STATUSES.map(() => '?').join(',')})
         ORDER BY paid_at, id`,
      )
      .all(...KITCHEN_STATUSES);
    return ids.map(({ id }) => this.getOrder(id));
  }

  // ---------- Flujo del cliente ----------

  createOrder({ tableToken, items }) {
    const table = this.getTableByToken(tableToken);
    const { lines, totalCents } = this.priceItems(items);
    const accessToken = newToken();
    const now = this.now();

    const orderId = transaction(this.db, () => {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO orders (table_id, access_token, status, total_cents, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(table.id, accessToken, STATUS.PENDING_PAYMENT, totalCents, now, now);
      this.#insertLines(Number(lastInsertRowid), lines);
      return Number(lastInsertRowid);
    });

    return { order: this.getOrder(orderId), accessToken };
  }

  async payOrder(orderId, accessToken) {
    const order = this.authorize(orderId, accessToken);
    return this.#exclusive(order.id, async () => {
      const current = this.getOrder(order.id);
      if (current.status !== STATUS.PENDING_PAYMENT) {
        throw new OrderError('already_paid', 'La orden ya fue pagada', 409);
      }

      const charge = await this.#charge(current.id, current.totalCents, `Orden #${current.id}`);
      if (charge.status !== 'approved') {
        throw new OrderError('payment_rejected', 'El pago fue rechazado', 402);
      }

      const now = this.now();
      this.db
        .prepare(
          `UPDATE orders SET status = ?, paid_cents = ?, paid_at = ?, editable_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(STATUS.RECEIVED, current.totalCents, now, now + this.editWindowMs, now, current.id);

      const paid = this.getOrder(current.id);
      this.#emit('order.paid', paid);
      return paid;
    });
  }

  // Reemplaza los productos de la orden. Si ya estaba pagada, cobra la diferencia
  // (si sube) o la reembolsa (si baja). Sólo se permite dentro de la ventana de cambios
  // y mientras cocina no la haya bloqueado.
  async modifyOrder(orderId, accessToken, items) {
    const order = this.authorize(orderId, accessToken);
    const { lines, totalCents } = this.priceItems(items);

    return this.#exclusive(order.id, async () => {
      const current = this.getOrder(order.id);

      if (current.status === STATUS.PENDING_PAYMENT) {
        transaction(this.db, () => {
          this.#replaceLines(current.id, lines);
          this.db
            .prepare('UPDATE orders SET total_cents = ?, updated_at = ? WHERE id = ?')
            .run(totalCents, this.now(), current.id);
        });
        return { order: this.getOrder(current.id), chargedCents: 0, refundedCents: 0 };
      }

      this.#assertEditable(current);

      const diff = totalCents - current.paidCents;
      let extraCharge = null;
      if (diff > 0) {
        extraCharge = await this.#charge(current.id, diff, `Ajuste orden #${current.id}`);
        if (extraCharge.status !== 'approved') {
          throw new OrderError('payment_rejected', 'No se pudo cobrar la diferencia', 402);
        }
      }

      // Volvemos a revisar: mientras se cobraba, cocina pudo haber bloqueado la orden.
      // El barrido por tiempo no la toca mientras está en this.busy, así que aquí sólo
      // importa el estado.
      try {
        transaction(this.db, () => {
          const { status } = this.db.prepare('SELECT status FROM orders WHERE id = ?').get(current.id);
          if (status !== STATUS.RECEIVED) {
            throw new OrderError('order_locked', 'La cocina ya empezó a preparar tu orden', 409);
          }
          this.#replaceLines(current.id, lines);
          this.db
            .prepare(
              `UPDATE orders SET total_cents = ?, paid_cents = paid_cents + ?,
                 modified_count = modified_count + 1, updated_at = ? WHERE id = ?`,
            )
            .run(totalCents, Math.max(diff, 0), this.now(), current.id);
        });
      } catch (err) {
        // El cobro extra nunca se sumó a paid_cents, así que no se descuenta al revertirlo.
        if (extraCharge) await this.#refund(current.id, diff, { adjustPaid: false });
        throw err;
      }

      const refundedCents = diff < 0 ? await this.#refund(current.id, -diff) : 0;
      const updated = this.getOrder(current.id);
      this.#emit('order.modified', updated);
      return { order: updated, chargedCents: Math.max(diff, 0), refundedCents };
    });
  }

  async cancelOrder(orderId, accessToken) {
    const order = this.authorize(orderId, accessToken);
    return this.#exclusive(order.id, async () => {
      const current = this.getOrder(order.id);
      if (current.status !== STATUS.PENDING_PAYMENT) this.#assertEditable(current);

      const changed = this.db
        .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status IN (?, ?)`)
        .run(STATUS.CANCELLED, this.now(), current.id, STATUS.PENDING_PAYMENT, STATUS.RECEIVED);
      if (changed.changes === 0) {
        throw new OrderError('order_locked', 'La cocina ya empezó a preparar tu orden', 409);
      }

      const refundedCents = current.paidCents > 0 ? await this.#refund(current.id, current.paidCents) : 0;
      const cancelled = this.getOrder(current.id);
      if (current.status === STATUS.RECEIVED) this.#emit('order.cancelled', cancelled);
      return { order: cancelled, refundedCents };
    });
  }

  // ---------- Flujo de cocina ----------

  // Cocina confirma "sin cambios": la orden deja de ser editable.
  lockOrder(orderId, by = 'kitchen') {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE orders SET status = ?, locked_at = ?, locked_by = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(STATUS.PREPARING, now, by, now, Number(orderId), STATUS.RECEIVED);

    const order = this.getOrder(orderId);
    if (result.changes === 0) {
      if (order.status === STATUS.PREPARING) return order; // idempotente
      throw new OrderError('invalid_transition', `No se puede bloquear una orden en estado ${order.status}`, 409);
    }
    this.#emit('order.locked', order);
    return order;
  }

  // Bloquea las órdenes cuya ventana de cambios ya expiró. Se llama periódicamente.
  lockExpired() {
    const expired = this.db
      .prepare('SELECT id FROM orders WHERE status = ? AND editable_until <= ?')
      .all(STATUS.RECEIVED, this.now());
    let count = 0;
    for (const { id } of expired) {
      if (this.busy.has(id)) continue;
      this.lockOrder(id, 'timeout');
      count++;
    }
    return count;
  }

  setKitchenStatus(orderId, nextStatus) {
    const allowedFrom = KITCHEN_TRANSITIONS[nextStatus];
    if (!allowedFrom) throw new OrderError('invalid_status', 'Estado inválido');
    const result = this.db
      .prepare(
        `UPDATE orders SET status = ?, updated_at = ?
         WHERE id = ? AND status IN (${allowedFrom.map(() => '?').join(',')})`,
      )
      .run(nextStatus, this.now(), Number(orderId), ...allowedFrom);

    const order = this.getOrder(orderId);
    if (result.changes === 0) {
      throw new OrderError('invalid_transition', `No se puede pasar de ${order.status} a ${nextStatus}`, 409);
    }
    this.#emit(`order.${nextStatus}`, order);
    return order;
  }

  // ---------- Internos ----------

  #assertEditable(order) {
    if (order.status !== STATUS.RECEIVED) {
      throw new OrderError('order_locked', 'La cocina ya empezó a preparar tu orden', 409);
    }
    if (this.now() >= order.editableUntil) {
      throw new OrderError('edit_window_closed', 'Se terminó el tiempo para hacer cambios', 409);
    }
  }

  async #exclusive(orderId, fn) {
    if (this.busy.has(orderId)) {
      throw new OrderError('busy', 'Ya hay una operación en curso para esta orden', 409);
    }
    this.busy.add(orderId);
    try {
      return await fn();
    } finally {
      this.busy.delete(orderId);
    }
  }

  async #charge(orderId, amountCents, description) {
    const res = await this.payments.charge({ orderId, amountCents, description });
    this.#recordPayment({ orderId, kind: 'charge', amountCents, ref: res.ref, status: res.status });
    return res;
  }

  // Reparte el reembolso entre los cobros aprobados (del más reciente al más antiguo),
  // porque los proveedores reales reembolsan contra un cobro específico.
  // Devuelve el monto efectivamente reembolsado.
  async #refund(orderId, amountCents, { adjustPaid = true } = {}) {
    const charges = this.db
      .prepare(
        `SELECT c.id, c.provider_ref, c.amount_cents - COALESCE(
           (SELECT SUM(r.amount_cents) FROM payments r
            WHERE r.refund_of = c.id AND r.status = 'approved'), 0) AS refundable
         FROM payments c
         WHERE c.order_id = ? AND c.kind = 'charge' AND c.status = 'approved'
         ORDER BY c.id DESC`,
      )
      .all(orderId);

    let remaining = amountCents;
    let refunded = 0;
    for (const charge of charges) {
      if (remaining <= 0) break;
      const amount = Math.min(remaining, charge.refundable);
      if (amount <= 0) continue;
      const res = await this.payments.refund({ orderId, amountCents: amount, chargeRef: charge.provider_ref });
      this.#recordPayment({ orderId, kind: 'refund', amountCents: amount, ref: res.ref, status: res.status, refundOf: charge.id });
      if (res.status === 'approved') {
        refunded += amount;
        remaining -= amount;
      }
    }

    if (refunded > 0 && adjustPaid) {
      this.db
        .prepare('UPDATE orders SET paid_cents = paid_cents - ?, updated_at = ? WHERE id = ?')
        .run(refunded, this.now(), orderId);
    }
    if (remaining > 0) {
      console.error(`[pagos] Reembolso incompleto en orden #${orderId}: faltan ${remaining} centavos`);
    }
    return refunded;
  }

  #recordPayment({ orderId, kind, amountCents, ref, status, refundOf = null }) {
    this.db
      .prepare(
        `INSERT INTO payments (order_id, kind, amount_cents, provider, provider_ref, refund_of, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(orderId, kind, amountCents, this.payments.name, ref ?? null, refundOf, status, this.now());
  }

  #insertLines(orderId, lines) {
    const insert = this.db.prepare(
      `INSERT INTO order_items (order_id, menu_item_id, name, unit_price_cents, quantity, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) insert.run(orderId, l.menuItemId, l.name, l.unitPriceCents, l.quantity, l.notes);
  }

  #replaceLines(orderId, lines) {
    this.db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
    this.#insertLines(orderId, lines);
  }

  #emit(type, order) {
    this.events.emit('order', { type, order });
  }

  #serialize(row, items) {
    return {
      id: row.id,
      table: { id: row.table_id, name: row.table_name },
      status: row.status,
      totalCents: row.total_cents,
      paidCents: row.paid_cents,
      createdAt: row.created_at,
      paidAt: row.paid_at,
      editableUntil: row.editable_until,
      editable: row.status === STATUS.RECEIVED && this.now() < row.editable_until,
      lockedAt: row.locked_at,
      lockedBy: row.locked_by,
      modifiedCount: row.modified_count,
      items,
    };
  }
}
