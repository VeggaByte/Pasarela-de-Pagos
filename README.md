# Órdenes sin contacto para cafetería

El cliente escanea el QR de su mesa, ve el menú, pide y paga desde su celular. La orden
llega a la pantalla de cocina en tiempo real.

## Cómo funciona

```
Cliente escanea QR de la mesa ──► Menú ──► Carrito ──► Paga
                                                        │
                                                        ▼
                         ┌────────────── Cocina recibe la orden (Nuevas)
                         │                 · el cliente puede modificar o cancelar
                         │                 · se cobra / reembolsa la diferencia
                         ▼
   Se bloquea cuando pase lo primero de:
     a) cocina presiona "Sin cambios — preparar"
     b) se acaban los 2 minutos (configurable)
                         │
                         ▼
                 En preparación ──► Lista ──► Entregada
```

- **Cada mesa tiene un QR con un token aleatorio** (`/m/<token>`), no un número
  consecutivo, para que nadie pueda pedir "desde otra mesa" adivinando la URL.
- **Los precios se calculan en el servidor**; lo que mande el celular se ignora.
- **Cada orden tiene su propio token secreto**, guardado sólo en el celular de quien la
  pagó. Sólo ese celular puede modificarla o cancelarla.
- **Modificaciones:** si el total sube, se cobra la diferencia; si baja, se reembolsa.
  Si cocina bloquea la orden mientras se está cobrando la diferencia, el cobro se
  revierte automáticamente.
- **Cancelación:** dentro de la ventana de cambios, con reembolso total.
- **Tiempo real** con Server-Sent Events: cocina ve órdenes nuevas o modificadas al
  instante (con aviso sonoro), y el cliente ve cuándo su orden pasa a preparación o
  queda lista.

## Pantallas

| URL | Quién la usa |
|---|---|
| `/m/<token-de-mesa>` | Cliente (se abre al escanear el QR) |
| `/cocina` | Cocina, en una tablet o pantalla (pide el PIN del personal) |
| `/admin/qr` | Para imprimir los QR de todas las mesas (pide el PIN del personal) |

## Ejecutar

Requiere **Node.js 22.5 o superior** (usa la base SQLite integrada de Node).

```bash
npm install
STAFF_PIN=4821 npm start
```

La primera vez se crea `data/ordenes.db` con un menú de ejemplo y 10 mesas. Luego:

1. Abre `http://localhost:3000/admin/qr`, entra con el PIN y abre el enlace de alguna mesa.
2. En otra pestaña abre `http://localhost:3000/cocina`.
3. Haz una orden desde la mesa y mírala llegar a cocina.

Para probarlo con celulares reales en la misma red WiFi, usa la IP de tu computadora:

```bash
BASE_URL=http://192.168.1.50:3000 STAFF_PIN=4821 npm start
```

### Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `BASE_URL` | `http://localhost:PORT` | URL pública; con ella se generan los QR |
| `STAFF_PIN` | `1234` | PIN para cocina y administración. **Cámbialo.** |
| `EDIT_WINDOW_SECONDS` | `120` | Tiempo que tiene el cliente para hacer cambios después de pagar |
| `DB_PATH` | `data/ordenes.db` | Archivo de la base de datos |

### Tests

```bash
npm test
```

Cubren el flujo completo: cobro y reembolso de diferencias, ventana de cambios, bloqueo
por cocina y por tiempo, condiciones de carrera (cocina bloquea mientras se cobra, doble
clic), tokens inválidos y la API HTTP.

## Estructura

```
src/
  server.js          arranque, configuración y barrido que bloquea órdenes vencidas
  app.js             rutas HTTP (cliente, cocina, admin)
  orders.js          reglas del negocio: órdenes, pagos, ventana de cambios, estados
  payments/mock.js   proveedor de pago simulado (aprueba todo)
  realtime.js        notificaciones en vivo (SSE)
  db.js              esquema SQLite
  seed.js            menú y mesas de ejemplo (se cargan sólo si la base está vacía)
public/              páginas del cliente, cocina y QR (HTML + JS sin frameworks)
test/                pruebas
```

## Pendiente antes de usarlo con clientes reales

1. **Conectar un proveedor de pagos real.** Hoy los pagos son simulados
   (`src/payments/mock.js`). Hay que implementar la misma interfaz (`charge` y `refund`)
   con Mercado Pago, Stripe, Conekta, Clip, etc. Si el proveedor confirma el pago con
   webhook o redirección, la confirmación debe llamar a la lógica que hoy hace `payOrder`.
2. **Panel para editar el menú** (precios, productos agotados, fotos). Por ahora el menú
   se carga desde `src/seed.js` o directamente en la base de datos.
3. **HTTPS y hosting** (Railway, Render, Fly.io, un VPS…). El PIN viaja en cada petición,
   así que sin HTTPS no es seguro.
4. Opcionales: propina, factura (CFDI), ticket impreso en cocina, varias sucursales,
   reportes de ventas, límite de peticiones por IP.
