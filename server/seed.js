const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

const seedPath = path.join(__dirname, 'seed_data.json');

function seedCatalog() {
  if (!fs.existsSync(seedPath)) {
    console.log('No seed_data.json found — skipping catalog seed.');
    return;
  }
  const { categories, products } = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

  const catCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  if (catCount > 0) {
    console.log('Categories already exist — skipping catalog seed (delete data/unica.db to reseed).');
    return;
  }

  const insertCat = db.prepare('INSERT INTO categories (name, slug, icon, sort_order) VALUES (?,?,?,?)');
  const slugToId = {};
  const insertCats = db.transaction((cats) => {
    for (const c of cats) {
      const info = insertCat.run(c.name, c.slug, c.icon, c.sort_order);
      slugToId[c.slug] = info.lastInsertRowid;
    }
  });
  insertCats(categories);

  const insertProd = db.prepare('INSERT INTO products (category_id, name, price, photo) VALUES (?,?,?,?)');
  const insertProds = db.transaction((prods) => {
    for (const p of prods) {
      const catId = slugToId[p.category_slug];
      if (!catId) continue;
      insertProd.run(catId, p.name, p.price, p.photo);
    }
  });
  insertProds(products);

  console.log(`Seeded ${categories.length} categories and ${products.length} products.`);
}

function seedAdmin() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) {
    console.log('Users already exist — skipping admin seed.');
    return;
  }
  const login = process.env.SEED_ADMIN_LOGIN || 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD || '123456';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (name, login, password_hash, role) VALUES (?,?,?,?)')
    .run('Администратор', login, hash, 'admin');
  console.log(`Created admin user — login: "${login}", password: "${password}". Change this after first login.`);
}

seedCatalog();
seedAdmin();
console.log('Seed complete.');
