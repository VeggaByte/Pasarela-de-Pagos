import { el, api, storage } from './common.js';

const $ = (id) => document.getElementById(id);
const PIN_KEY = 'cocina:pin';

async function show(pin) {
  let data;
  try {
    data = await api('/api/admin/tables', { headers: { 'X-Staff-Pin': pin } });
  } catch (err) {
    storage.remove(PIN_KEY);
    $('pin-error').textContent = err.status === 401 ? 'PIN incorrecto' : err.message;
    $('pin-error').classList.remove('hidden');
    return;
  }
  storage.set(PIN_KEY, pin);

  const parser = new DOMParser();
  $('grid').replaceChildren(
    ...data.tables.map((t) => {
      // El SVG lo genera nuestro servidor; se parsea como SVG para no usar innerHTML.
      const svg = parser.parseFromString(t.qrSvg, 'image/svg+xml').documentElement;
      return el('div', { class: 'card qr-card' },
        el('h2', {}, t.name),
        document.importNode(svg, true),
        el('p', {}, 'Escanea para ver el menú y ordenar'),
        el('p', { class: 'small muted url' }, t.url),
      );
    }),
  );
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
}

$('print').addEventListener('click', () => window.print());
$('pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  show($('pin').value);
});

const saved = storage.get(PIN_KEY);
if (saved) show(saved);
