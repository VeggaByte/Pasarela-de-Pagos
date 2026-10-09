// Notificaciones en tiempo real con Server-Sent Events (no requiere WebSockets).
// Cocina recibe todos los eventos; cada cliente sólo los de su orden.
export class RealtimeHub {
  constructor(events) {
    this.kitchen = new Set();
    this.customers = new Map(); // orderId -> Set<res>
    events.on('order', (event) => this.#dispatch(event));
    this.heartbeat = setInterval(() => this.#ping(), 25_000);
    this.heartbeat.unref();
  }

  addKitchen(req, res) {
    this.#open(res);
    this.kitchen.add(res);
    req.on('close', () => this.kitchen.delete(res));
  }

  addCustomer(orderId, req, res) {
    this.#open(res);
    if (!this.customers.has(orderId)) this.customers.set(orderId, new Set());
    const set = this.customers.get(orderId);
    set.add(res);
    req.on('close', () => {
      set.delete(res);
      if (set.size === 0) this.customers.delete(orderId);
    });
  }

  close() {
    clearInterval(this.heartbeat);
    for (const res of this.kitchen) res.end();
    for (const set of this.customers.values()) for (const res of set) res.end();
  }

  #open(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
  }

  #dispatch({ type, order }) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(order)}\n\n`;
    for (const res of this.kitchen) res.write(payload);
    for (const res of this.customers.get(order.id) ?? []) res.write(payload);
  }

  #ping() {
    for (const res of this.kitchen) res.write(': ping\n\n');
    for (const set of this.customers.values()) for (const res of set) res.write(': ping\n\n');
  }
}
