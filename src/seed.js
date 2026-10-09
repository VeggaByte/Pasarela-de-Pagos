import { newToken } from './orders.js';

// Menú y mesas de ejemplo. Edítalos o reemplázalos con los de tu cafetería.
export const SAMPLE_MENU = [
  { name: 'Espresso', category: 'Café', price: 35, description: 'Shot doble' },
  { name: 'Americano', category: 'Café', price: 40, description: '12 oz' },
  { name: 'Capuchino', category: 'Café', price: 55, description: '12 oz, leche entera o deslactosada' },
  { name: 'Latte', category: 'Café', price: 58, description: '12 oz' },
  { name: 'Chai latte', category: 'Otras bebidas', price: 60, description: 'Especiado, caliente o frío' },
  { name: 'Chocolate caliente', category: 'Otras bebidas', price: 55, description: '' },
  { name: 'Jugo de naranja', category: 'Otras bebidas', price: 45, description: 'Natural, 350 ml' },
  { name: 'Croissant', category: 'Panadería', price: 38, description: 'Mantequilla' },
  { name: 'Concha', category: 'Panadería', price: 25, description: 'Vainilla o chocolate' },
  { name: 'Chilaquiles', category: 'Desayunos', price: 115, description: 'Verdes o rojos, con pollo o huevo' },
  { name: 'Molletes', category: 'Desayunos', price: 95, description: 'Con pico de gallo' },
  { name: 'Sándwich de pavo', category: 'Desayunos', price: 105, description: 'Pan de masa madre' },
];

export function seedIfEmpty(db, { tables = 10 } = {}) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM tables').get();
  if (n > 0) return false;

  const insertTable = db.prepare('INSERT INTO tables (name, token) VALUES (?, ?)');
  for (let i = 1; i <= tables; i++) insertTable.run(`Mesa ${i}`, newToken(9));

  const insertItem = db.prepare(
    `INSERT INTO menu_items (name, description, category, price_cents, sort_order) VALUES (?, ?, ?, ?, ?)`,
  );
  SAMPLE_MENU.forEach((item, i) =>
    insertItem.run(item.name, item.description, item.category, Math.round(item.price * 100), i),
  );
  return true;
}
