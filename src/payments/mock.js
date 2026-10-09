import { randomBytes } from 'node:crypto';

// Proveedor de pagos simulado: aprueba todo al instante. Sirve para desarrollo y
// demos. Un proveedor real (Mercado Pago, Stripe, Conekta, SPEI...) debe exponer
// la misma interfaz:
//   charge({ orderId, amountCents, description }) -> { status: 'approved' | 'rejected', ref }
//   refund({ orderId, amountCents, chargeRef })   -> { status: 'approved' | 'rejected', ref }
export class MockPaymentProvider {
  name = 'mock';

  constructor({ delayMs = 0 } = {}) {
    this.delayMs = delayMs;
  }

  async charge({ amountCents }) {
    await this.#wait();
    if (!(amountCents > 0)) return { status: 'rejected', ref: null };
    return { status: 'approved', ref: `mock_ch_${randomBytes(8).toString('hex')}` };
  }

  async refund({ amountCents }) {
    await this.#wait();
    if (!(amountCents > 0)) return { status: 'rejected', ref: null };
    return { status: 'approved', ref: `mock_rf_${randomBytes(8).toString('hex')}` };
  }

  #wait() {
    return this.delayMs ? new Promise((r) => setTimeout(r, this.delayMs)) : Promise.resolve();
  }
}
