/* ============================================================
   UNICA — заявки и контрагенты. SPA, vanilla JS, hash-роутинг.
   ============================================================ */

/* ---------- constants & helpers ---------- */
const STATUS_LABELS = {
  new: 'Новая', confirmed: 'Подтверждена', shipped: 'Отгружена',
  done: 'Завершена', cancelled: 'Отменена',
};
const STATUS_ORDER = ['new', 'confirmed', 'shipped', 'done', 'cancelled'];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtPrice(p) {
  if (p === null || p === undefined || p === '') return '—';
  return Number(p).toLocaleString('ru-RU').replace(/,/g, ' ');
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function pluralItems(n) {
  const n10 = n % 10, n100 = n % 100;
  if (n100 >= 11 && n100 <= 14) return 'товаров';
  if (n10 === 1) return 'товар';
  if (n10 >= 2 && n10 <= 4) return 'товара';
  return 'товаров';
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- API layer ---------- */
const Api = {
  token: localStorage.getItem('unica_token') || null,

  headers(json = true) {
    const h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h['Authorization'] = 'Bearer ' + this.token;
    return h;
  },

  async req(method, path, body, isForm = false) {
    const opts = { method, headers: this.headers(!isForm) };
    if (body !== undefined) opts.body = isForm ? body : JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    if (res.status === 401) {
      Auth.logout();
      throw new Error('unauthorized');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'request_failed');
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  },

  get(path) { return this.req('GET', path); },
  post(path, body, isForm) { return this.req('POST', path, body, isForm); },
  patch(path, body, isForm) { return this.req('PATCH', path, body, isForm); },
  del(path) { return this.req('DELETE', path); },
};

/* ---------- auth ---------- */
const Auth = {
  user: null,

  async init() {
    if (!Api.token) return false;
    try {
      this.user = await Api.get('/auth/me');
      return true;
    } catch (e) {
      this.logout();
      return false;
    }
  },

  async login(login, password) {
    const data = await Api.post('/auth/login', { login, password });
    Api.token = data.token;
    localStorage.setItem('unica_token', data.token);
    this.user = data.user;
  },

  logout() {
    Api.token = null;
    this.user = null;
    localStorage.removeItem('unica_token');
    Cart.clear(true);
    showAuthScreen();
  },

  isAdmin() { return this.user && this.user.role === 'admin'; },
};

/* ---------- cart (draft order, per browser session) ---------- */
const Cart = {
  items: [],

  load() {
    try {
      const raw = localStorage.getItem('unica_cart');
      this.items = raw ? JSON.parse(raw) : [];
    } catch (e) { this.items = []; }
  },
  save() {
    try { localStorage.setItem('unica_cart', JSON.stringify(this.items)); } catch (e) {}
  },
  clear(silent) {
    this.items = [];
    this.save();
    if (!silent) render();
  },
  find(productId) { return this.items.find(i => i.product_id === productId); },
  add(product) {
    const existing = this.find(product.id);
    if (existing) existing.qty += 1;
    else this.items.push({ product_id: product.id, name: product.name, price: product.price, photo: product.photo, qty: 1 });
    this.save();
  },
  setQty(productId, qty) {
    const it = this.find(productId);
    if (!it) return;
    if (qty <= 0) { this.items = this.items.filter(i => i.product_id !== productId); }
    else { it.qty = qty; }
    this.save();
  },
  remove(productId) {
    this.items = this.items.filter(i => i.product_id !== productId);
    this.save();
  },
  count() { return this.items.reduce((s, i) => s + i.qty, 0); },
  total() { return this.items.reduce((s, i) => s + (i.price || 0) * i.qty, 0); },
};

/* ---------- global catalog cache ---------- */
let CATEGORIES = [];
let PRODUCTS_CACHE = {}; // categoryId -> products[]

async function loadCategories() {
  CATEGORIES = await Api.get('/categories');
}
async function loadProducts(categoryId) {
  if (PRODUCTS_CACHE[categoryId]) return PRODUCTS_CACHE[categoryId];
  const rows = await Api.get('/products?category_id=' + categoryId);
  PRODUCTS_CACHE[categoryId] = rows;
  return rows;
}
function invalidateProductCache() { PRODUCTS_CACHE = {}; }

/* ---------- router ---------- */
let currentRoute = { name: 'home' };

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { parts, query };
}

async function router() {
  if (!Auth.user) { showAuthScreen(); return; }
  showAppScreen();

  const { parts, query } = parseHash();
  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty-state">Загрузка…</div>';

  try {
    if (parts.length === 0) {
      currentRoute = { name: 'home' };
      await viewHome();
    } else if (parts[0] === 'category' && parts[1]) {
      currentRoute = { name: 'category', id: Number(parts[1]) };
      await viewCategory(Number(parts[1]));
    } else if (parts[0] === 'search') {
      currentRoute = { name: 'search', q: query.q || '' };
      await viewSearch(query.q || '');
    } else if (parts[0] === 'cart') {
      currentRoute = { name: 'cart' };
      await viewCart();
    } else if (parts[0] === 'contractors') {
      currentRoute = { name: 'contractors' };
      await viewContractors();
    } else if (parts[0] === 'orders' && parts[1]) {
      currentRoute = { name: 'order-detail', id: Number(parts[1]) };
      await viewOrderDetail(Number(parts[1]));
    } else if (parts[0] === 'orders') {
      currentRoute = { name: 'orders' };
      await viewOrders(query);
    } else if (parts[0] === 'admin') {
      if (!Auth.isAdmin()) { navigate('#/'); return; }
      currentRoute = { name: 'admin', tab: parts[1] || 'catalog' };
      await viewAdmin(parts[1] || 'catalog');
    } else {
      currentRoute = { name: 'home' };
      await viewHome();
    }
  } catch (e) {
    if (e.message !== 'unauthorized') {
      app.innerHTML = `<div class="empty-state">${notFoundIcon()}<div>Не удалось загрузить страницу</div></div>`;
      console.error(e);
    }
  }

  renderNav();
  window.scrollTo({ top: 0 });
}

function navigate(hash) { location.hash = hash; }
window.addEventListener('hashchange', router);

/* ============================================================
   VIEWS
   ============================================================ */

/* ---- home: category grid ---- */
async function viewHome() {
  if (CATEGORIES.length === 0) await loadCategories();
  const app = document.getElementById('app');

  let html = `<h1 class="page-title">Продукция</h1><p class="page-sub">Выберите раздел, чтобы посмотреть товары и добавить их в заявку</p>`;
  html += `<div class="cat-grid">`;
  for (const cat of CATEGORIES) {
    html += `<a class="cat-card" href="#/category/${cat.id}">
      ${iconSvg(cat.icon, 'cat-icon')}
      <h3>${esc(cat.name)}</h3>
      <p>${cat.product_count ?? ''} </p>
    </a>`;
  }
  html += `</div>`;
  app.innerHTML = html;

  // fetch counts lazily (non-blocking) if backend doesn't include them
  Promise.all(CATEGORIES.map(c => loadProducts(c.id))).then(() => {
    document.querySelectorAll('.cat-card p').forEach((el, idx) => {
      const cat = CATEGORIES[idx];
      const n = (PRODUCTS_CACHE[cat.id] || []).length;
      el.textContent = `${n} ${pluralItems(n)}`;
    });
  });
}

/* ---- category: product grid ---- */
async function viewCategory(catId) {
  const cat = CATEGORIES.find(c => c.id === catId) || (await ensureCategories(), CATEGORIES.find(c => c.id === catId));
  const products = await loadProducts(catId);
  const app = document.getElementById('app');

  let html = `<button class="btn small" onclick="navigate('#/')" style="margin-bottom:16px;">${backIcon()} Все разделы</button>`;
  html += `<h1 class="page-title">${cat ? esc(cat.name) : 'Раздел'}</h1><p class="page-sub">${products.length} ${pluralItems(products.length)}</p>`;
  html += renderProductGrid(products);
  app.innerHTML = html;
}

async function ensureCategories() { if (CATEGORIES.length === 0) await loadCategories(); }

/* ---- search ---- */
async function viewSearch(q) {
  const app = document.getElementById('app');
  if (!q.trim()) { await viewHome(); return; }
  const products = await Api.get('/products?q=' + encodeURIComponent(q));
  let html = `<h1 class="page-title">Поиск: «${esc(q)}»</h1><p class="page-sub">${products.length} ${pluralItems(products.length)}</p>`;
  html += renderProductGrid(products);
  app.innerHTML = html;
}

function renderProductGrid(products) {
  if (products.length === 0) return `<div class="empty-state">${boxIcon()}<div>Товары не найдены</div></div>`;
  let html = `<div class="prod-grid">`;
  for (const p of products) {
    const inCart = Cart.find(p.id);
    const qty = inCart ? inCart.qty : 0;
    html += `<div class="prod-card">
      <div class="prod-photo">${p.photo ? `<img src="${p.photo}" alt="">` : photoPlaceholder()}</div>
      <div class="prod-body">
        <h4 class="prod-name">${esc(p.name)}</h4>
        <div class="prod-price">${fmtPrice(p.price)}<small>сом</small></div>
        <div class="prod-add" id="add-${p.id}">
          ${qty > 0 ? qtyStepperHtml(p, qty) : `<button class="add-cart-btn" onclick='addToCart(${JSON.stringify(p)})'>${cartIcon()} В заявку</button>`}
        </div>
      </div>
    </div>`;
  }
  html += `</div>`;
  return html;
}
function qtyStepperHtml(p, qty) {
  return `<div class="qty-stepper">
      <button onclick="changeCartQty(${p.id}, ${qty - 1})">−</button>
      <input type="number" inputmode="numeric" pattern="[0-9]*" class="qty-input" value="${qty}"
        onchange="changeCartQty(${p.id}, parseInt(this.value)||0)" onclick="this.select()">
      <button onclick="changeCartQty(${p.id}, ${qty + 1})">+</button>
    </div>
    <div class="add-cart-btn in-cart" style="flex:1;text-align:center;">В заявке</div>`;
}
function addToCart(product) {
  Cart.add(product);
  refreshProductCardAdd(product.id);
  updateCartBadge();
  showToast(`«${product.name}» добавлен в заявку`);
}
function changeCartQty(productId, qty) {
  Cart.setQty(productId, qty);
  refreshProductCardAdd(productId, qty <= 0 ? null : undefined);
  updateCartBadge();
  if (currentRoute.name === 'cart') renderCartView();
}
function refreshProductCardAdd(productId) {
  const el = document.getElementById('add-' + productId);
  if (!el) return;
  const item = Cart.find(productId);
  if (!item) {
    // need original product data to rebuild the button — find it from cache
    const allProducts = Object.values(PRODUCTS_CACHE).flat();
    const p = allProducts.find(x => x.id === productId);
    el.innerHTML = p ? `<button class="add-cart-btn" onclick='addToCart(${JSON.stringify(p)})'>${cartIcon()} В заявку</button>` : '';
  } else {
    el.innerHTML = qtyStepperHtml({ id: productId }, item.qty);
  }
}

/* ---- cart / draft order ---- */
async function viewCart() {
  const app = document.getElementById('app');
  app.innerHTML = `<div id="cartViewRoot"></div>`;
  renderCartView();
}
function renderCartView() {
  const root = document.getElementById('cartViewRoot');
  if (!root) return;
  let html = `<h1 class="page-title">Текущая заявка</h1>`;
  if (Cart.items.length === 0) {
    html += `<div class="empty-state">${cartIcon()}<div>В заявке пока нет товаров.<br>Перейдите в каталог, чтобы добавить их.</div></div>`;
    html += `<button class="btn primary" onclick="navigate('#/')" style="margin-top:14px;">В каталог</button>`;
    root.innerHTML = html;
    return;
  }
  html += `<div class="cart-list">`;
  for (const it of Cart.items) {
    html += `<div class="cart-item">
      <div class="cart-item-photo">${it.photo ? `<img src="${it.photo}">` : photoPlaceholder()}</div>
      <div class="cart-item-body">
        <p class="cart-item-name">${esc(it.name)}</p>
        <div class="cart-item-price">${fmtPrice(it.price)} сом × ${it.qty} = <b>${fmtPrice((it.price || 0) * it.qty)} сом</b></div>
      </div>
      <div class="qty-stepper">
        <button onclick="changeCartQty(${it.product_id}, ${it.qty - 1})">−</button>
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="qty-input" value="${it.qty}"
          onchange="changeCartQty(${it.product_id}, parseInt(this.value)||0)" onclick="this.select()">
        <button onclick="changeCartQty(${it.product_id}, ${it.qty + 1})">+</button>
      </div>
      <button class="icon-btn danger" onclick="changeCartQty(${it.product_id}, 0)">${trashIcon()}</button>
    </div>`;
  }
  html += `</div>`;
  html += `<div class="cart-summary"><span>Итого, ${Cart.count()} ${pluralItems(Cart.count())}</span><span class="total">${fmtPrice(Cart.total())} сом</span></div>`;
  html += `<button class="btn primary block" onclick="openSubmitOrderModal()">Оформить заявку</button>`;
  root.innerHTML = html;
}
function updateCartBadge() {
  const badge = document.querySelector('.bottom-nav .badge[data-nav="cart"], .main-nav .badge[data-nav="cart"]');
  const count = Cart.count();
  document.querySelectorAll('[data-cart-badge]').forEach(el => {
    el.setAttribute('data-count', count);
    el.style.display = count > 0 ? '' : 'none';
  });
}

/* ---- submit order modal: pick / create contractor ---- */
async function openSubmitOrderModal() {
  if (Cart.items.length === 0) return;
  const contractors = await Api.get('/contractors');
  const options = contractors.map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? ' — ' + esc(c.phone) : ''}</option>`).join('');
  renderModal(`
    <h3>Оформление заявки</h3>
    <div class="field">
      <label>Контрагент</label>
      <select id="orderContractorSelect">
        <option value="">— Выберите контрагента —</option>
        ${options}
      </select>
    </div>
    <button class="btn small" onclick="openContractorFormModal(null, true)" style="margin-bottom:15px;">${plusIcon()} Новый контрагент</button>
    <div class="field">
      <label>Комментарий (необязательно)</label>
      <textarea id="orderNote" placeholder="Например: доставка до склада, срочно и т.д."></textarea>
    </div>
    <div class="field" style="background:var(--gray-bg);border-radius:8px;padding:12px 14px;">
      <div style="font-size:13px;color:var(--text-mute);margin-bottom:4px;">${Cart.count()} ${pluralItems(Cart.count())}</div>
      <div style="font-size:18px;font-weight:800;color:var(--navy);">${fmtPrice(Cart.total())} сом</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn primary" onclick="submitOrder()">Отправить заявку</button>
    </div>
  `);
}
async function submitOrder() {
  const contractorId = document.getElementById('orderContractorSelect').value;
  const note = document.getElementById('orderNote').value.trim();
  if (!contractorId) { showToast('Выберите контрагента', true); return; }

  const items = Cart.items.map(it => ({ product_id: it.product_id, product_name: it.name, price: it.price, qty: it.qty }));
  try {
    const order = await Api.post('/orders', { contractor_id: Number(contractorId), note: note || null, items });
    Cart.clear(true);
    closeModal();
    updateCartBadge();
    showToast('Заявка №' + order.id + ' оформлена');
    navigate('#/orders/' + order.id);
  } catch (e) {
    showToast('Не удалось оформить заявку', true);
  }
}

/* ---- contractors ---- */
async function viewContractors(searchQuery) {
  const app = document.getElementById('app');
  const q = searchQuery !== undefined ? searchQuery : '';
  app.innerHTML = `
    <h1 class="page-title">Контрагенты</h1>
    <p class="page-sub">Клиенты и партнёры, на которых оформляются заявки</p>
    <div class="page-toolbar">
      <input type="text" class="search-input" id="contractorSearch" placeholder="Поиск по названию, телефону, e-mail..." value="${esc(q)}" oninput="onContractorSearch(this.value)">
      <button class="btn primary" onclick="openContractorFormModal(null)">${plusIcon()} Добавить</button>
    </div>
    <div id="contractorListRoot"></div>
  `;
  document.getElementById('contractorSearch').focus();
  await loadContractorList(q);
}
const onContractorSearch = debounce((val) => loadContractorList(val), 300);

async function loadContractorList(q) {
  const rows = await Api.get('/contractors' + (q ? '?q=' + encodeURIComponent(q) : ''));
  const root = document.getElementById('contractorListRoot');
  if (!root) return;
  if (rows.length === 0) {
    root.innerHTML = `<div class="empty-state">${usersIcon()}<div>Контрагенты не найдены</div></div>`;
    return;
  }
  let html = '';
  for (const c of rows) {
    html += `<div class="list-row">
      <div class="lr-main">
        <p class="lr-title">${esc(c.name)}</p>
        <p class="lr-sub">${[c.contact_person, c.phone, c.email].filter(Boolean).map(esc).join(' · ') || 'нет контактных данных'}</p>
      </div>
      <div class="lr-actions">
        <button class="icon-btn" onclick='openContractorFormModal(${c.id})' title="Изменить">${editIcon()}</button>
        <button class="icon-btn danger" onclick="confirmDeleteContractor(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}')" title="Удалить">${trashIcon()}</button>
      </div>
    </div>`;
  }
  root.innerHTML = html;
}

function openContractorFormModal(id, thenSelectInOrderModal) {
  (async () => {
    const editing = id ? await Api.get('/contractors/' + id) : null;
    renderModal(`
      <h3>${editing ? 'Изменить контрагента' : 'Новый контрагент'}</h3>
      <div class="field"><label>Название организации *</label><input type="text" id="cName" value="${editing ? esc(editing.name) : ''}" placeholder="ООО «Компания»"></div>
      <div class="field"><label>Контактное лицо</label><input type="text" id="cContact" value="${editing ? esc(editing.contact_person || '') : ''}" placeholder="Имя Фамилия"></div>
      <div class="field"><label>Телефон</label><input type="tel" id="cPhone" value="${editing ? esc(editing.phone || '') : ''}" placeholder="+996 700 000 000"></div>
      <div class="field"><label>E-mail</label><input type="email" id="cEmail" value="${editing ? esc(editing.email || '') : ''}" placeholder="mail@example.com"></div>
      <div class="field"><label>Адрес</label><input type="text" id="cAddress" value="${editing ? esc(editing.address || '') : ''}" placeholder="Город, улица, дом"></div>
      <div class="field"><label>Заметка</label><textarea id="cNote" placeholder="Дополнительная информация">${editing ? esc(editing.note || '') : ''}</textarea></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Отмена</button>
        <button class="btn primary" onclick="saveContractor(${id || 'null'}, ${!!thenSelectInOrderModal})">Сохранить</button>
      </div>
    `);
  })();
}

async function saveContractor(id, thenSelectInOrderModal) {
  const payload = {
    name: document.getElementById('cName').value.trim(),
    contact_person: document.getElementById('cContact').value.trim() || null,
    phone: document.getElementById('cPhone').value.trim() || null,
    email: document.getElementById('cEmail').value.trim() || null,
    address: document.getElementById('cAddress').value.trim() || null,
    note: document.getElementById('cNote').value.trim() || null,
  };
  if (!payload.name) { showToast('Укажите название организации', true); return; }

  try {
    let saved;
    if (id) saved = await Api.patch('/contractors/' + id, payload);
    else saved = await Api.post('/contractors', payload);

    if (thenSelectInOrderModal) {
      await openSubmitOrderModal();
      setTimeout(() => {
        const sel = document.getElementById('orderContractorSelect');
        if (sel) {
          const opt = document.createElement('option');
          opt.value = saved.id; opt.textContent = saved.name;
          sel.appendChild(opt);
          sel.value = saved.id;
        }
      }, 30);
    } else {
      closeModal();
      if (currentRoute.name === 'contractors') loadContractorList(document.getElementById('contractorSearch')?.value || '');
      showToast('Контрагент сохранён');
    }
  } catch (e) {
    showToast('Не удалось сохранить контрагента', true);
  }
}

function confirmDeleteContractor(id, name) {
  renderModal(`
    <h3>Удалить контрагента?</h3>
    <p style="color:var(--text-mute);font-size:14px;line-height:1.5;">«${esc(name)}» будет удалён безвозвратно.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn danger" onclick="deleteContractor(${id})">Удалить</button>
    </div>
  `);
}
async function deleteContractor(id) {
  try {
    await Api.del('/contractors/' + id);
    closeModal();
    loadContractorList(document.getElementById('contractorSearch')?.value || '');
    showToast('Контрагент удалён');
  } catch (e) {
    if (e.data && e.data.error === 'has_orders') {
      showToast(e.data.message, true, 5000);
    } else {
      showToast('Не удалось удалить контрагента', true);
    }
    closeModal();
  }
}

/* ---- orders ---- */
async function viewOrders(query) {
  const app = document.getElementById('app');
  const status = query.status || '';
  app.innerHTML = `
    <h1 class="page-title">Заявки</h1>
    <p class="page-sub">Все оформленные заявки от контрагентов</p>
    <div class="page-toolbar">
      <select class="search-input" id="orderStatusFilter" style="flex:0 0 200px;" onchange="navigate('#/orders' + (this.value ? '?status='+this.value : ''))">
        <option value="">Все статусы</option>
        ${STATUS_ORDER.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
      </select>
    </div>
    <div id="orderListRoot"></div>
  `;
  const rows = await Api.get('/orders' + (status ? '?status=' + status : ''));
  const root = document.getElementById('orderListRoot');
  if (rows.length === 0) {
    root.innerHTML = `<div class="empty-state">${boxIcon()}<div>Заявок пока нет</div></div>`;
    return;
  }
  let html = '';
  for (const o of rows) {
    html += `<a class="list-row" href="#/orders/${o.id}" style="text-decoration:none;">
      <div class="lr-main">
        <p class="lr-title">Заявка №${o.id} — ${esc(o.contractor_name)}</p>
        <p class="lr-sub">${fmtDate(o.created_at)} · ${o.items.length} ${pluralItems(o.items.length)} · ${fmtPrice(o.total)} сом</p>
      </div>
      <span class="status-badge status-${o.status}">${STATUS_LABELS[o.status]}</span>
    </a>`;
  }
  root.innerHTML = html;
}

async function viewOrderDetail(id) {
  const app = document.getElementById('app');
  const o = await Api.get('/orders/' + id);
  let html = `<button class="btn small" onclick="navigate('#/orders')" style="margin-bottom:16px;">${backIcon()} Все заявки</button>`;
  html += `<h1 class="page-title">Заявка №${o.id}</h1>`;
  html += `<p class="page-sub">${fmtDate(o.created_at)} · оформил(а): ${esc(o.created_by_name || '—')}</p>`;

  html += `<div class="field"><label>Статус</label>
    <select id="orderStatusSelect" onchange="updateOrderStatus(${o.id}, this.value)">
      ${STATUS_ORDER.map(s => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
    </select>
  </div>`;

  html += `<div class="field"><label>Контрагент</label>
    <div class="list-row" style="margin:0;">
      <div class="lr-main">
        <p class="lr-title">${esc(o.contractor_name)}</p>
        <p class="lr-sub">${esc(o.contractor_phone || 'телефон не указан')}</p>
      </div>
    </div>
  </div>`;

  if (o.note) html += `<div class="field"><label>Комментарий</label><p style="font-size:14px;color:var(--text);">${esc(o.note)}</p></div>`;

  html += `<div class="field"><label>Состав заявки</label><div class="cart-list">`;
  for (const it of o.items) {
    html += `<div class="cart-item">
      <div class="cart-item-body">
        <p class="cart-item-name">${esc(it.product_name)}</p>
        <div class="cart-item-price">${fmtPrice(it.price)} сом × ${it.qty} = <b>${fmtPrice((it.price || 0) * it.qty)} сом</b></div>
      </div>
    </div>`;
  }
  html += `</div></div>`;
  html += `<div class="cart-summary"><span>Итого</span><span class="total">${fmtPrice(o.total)} сом</span></div>`;

  if (Auth.isAdmin()) {
    html += `<button class="btn danger" onclick="confirmDeleteOrder(${o.id})" style="margin-top:20px;">${trashIcon()} Удалить заявку</button>`;
  }

  app.innerHTML = html;
}
async function updateOrderStatus(id, status) {
  try {
    await Api.patch('/orders/' + id, { status });
    showToast('Статус обновлён');
  } catch (e) {
    showToast('Не удалось обновить статус', true);
  }
}
function confirmDeleteOrder(id) {
  renderModal(`
    <h3>Удалить заявку №${id}?</h3>
    <p style="color:var(--text-mute);font-size:14px;">Это действие необратимо.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn danger" onclick="deleteOrder(${id})">Удалить</button>
    </div>
  `);
}
async function deleteOrder(id) {
  await Api.del('/orders/' + id);
  closeModal();
  navigate('#/orders');
  showToast('Заявка удалена');
}

/* ---- admin ---- */
async function viewAdmin(tab) {
  const app = document.getElementById('app');
  let html = `<h1 class="page-title">Администрирование</h1>`;
  html += `<div class="page-toolbar">
    <button class="btn ${tab === 'catalog' ? 'primary' : ''}" onclick="navigate('#/admin/catalog')">Каталог</button>
    <button class="btn ${tab === 'users' ? 'primary' : ''}" onclick="navigate('#/admin/users')">Пользователи</button>
  </div>
  <div id="adminTabRoot"></div>`;
  app.innerHTML = html;

  if (tab === 'users') await renderAdminUsers();
  else await renderAdminCatalog();
}

/* -- admin: catalog -- */
async function renderAdminCatalog() {
  await ensureCategories();
  const root = document.getElementById('adminTabRoot');
  let html = `<div class="admin-toolbar">
    <button class="btn primary" onclick="openCategoryFormModal(null)">${plusIcon()} Новый раздел</button>
  </div>`;
  for (const cat of CATEGORIES) {
    const products = await loadProducts(cat.id);
    html += `<div style="margin-bottom:28px;">
      <div class="list-row" style="background:var(--gray-bg);border:none;">
        <div class="lr-main">
          <p class="lr-title">${iconSvg(cat.icon, 'cat-icon').replace('cat-icon','cat-icon-sm')} ${esc(cat.name)}</p>
          <p class="lr-sub">${products.length} ${pluralItems(products.length)}</p>
        </div>
        <div class="lr-actions">
          <button class="btn small" onclick="openProductFormModal(null, ${cat.id})">${plusIcon()} Товар</button>
          <button class="icon-btn" onclick="openCategoryFormModal(${cat.id})">${editIcon()}</button>
          <button class="icon-btn danger" onclick="confirmDeleteCategory(${cat.id}, '${esc(cat.name).replace(/'/g, "\\'")}')">${trashIcon()}</button>
        </div>
      </div>`;
    for (const p of products) {
      html += `<div class="list-row" style="margin-left:16px;">
        <div class="cart-item-photo" style="margin-right:12px;">${p.photo ? `<img src="${p.photo}">` : photoPlaceholder()}</div>
        <div class="lr-main">
          <p class="lr-title" style="font-size:13.5px;">${esc(p.name)}</p>
          <p class="lr-sub">${fmtPrice(p.price)} сом</p>
        </div>
        <div class="lr-actions">
          <button class="icon-btn" onclick="openProductFormModal(${p.id}, ${cat.id})">${editIcon()}</button>
          <button class="icon-btn danger" onclick="confirmDeleteProduct(${p.id}, ${cat.id})">${trashIcon()}</button>
        </div>
      </div>`;
    }
    html += `</div>`;
  }
  root.innerHTML = html;
}

function openCategoryFormModal(id) {
  const editing = id ? CATEGORIES.find(c => c.id === id) : null;
  const iconGrid = ICON_CHOICES.map(key =>
    `<button type="button" class="icon-choice ${editing && editing.icon === key ? 'selected' : ''}" data-icon="${key}" onclick="selectIconChoice('${key}')">${iconSvg(key)}</button>`
  ).join('');
  renderModal(`
    <h3>${editing ? 'Изменить раздел' : 'Новый раздел'}</h3>
    <div class="field"><label>Название</label><input type="text" id="catName" value="${editing ? esc(editing.name) : ''}" placeholder="Например: Клеи для плитки"></div>
    <div class="field"><label>Иконка</label><div class="icon-grid" id="iconGrid">${iconGrid}</div></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn primary" onclick="saveCategory(${id || 'null'})">Сохранить</button>
    </div>
  `);
  window.__pendingIcon = editing ? editing.icon : ICON_CHOICES[0];
}
function selectIconChoice(key) {
  window.__pendingIcon = key;
  document.querySelectorAll('#iconGrid .icon-choice').forEach(el => {
    el.classList.toggle('selected', el.getAttribute('data-icon') === key);
  });
}
async function saveCategory(id) {
  const name = document.getElementById('catName').value.trim();
  if (!name) { showToast('Укажите название раздела', true); return; }
  const icon = window.__pendingIcon || ICON_CHOICES[0];
  try {
    if (id) await Api.patch('/categories/' + id, { name, icon });
    else await Api.post('/categories', { name, icon });
    closeModal();
    await loadCategories();
    await renderAdminCatalog();
    showToast('Раздел сохранён');
  } catch (e) {
    showToast('Не удалось сохранить раздел', true);
  }
}
function confirmDeleteCategory(id, name) {
  renderModal(`
    <h3>Удалить раздел?</h3>
    <p style="color:var(--text-mute);font-size:14px;line-height:1.5;">«${esc(name)}» и все товары в нём будут удалены безвозвратно.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn danger" onclick="deleteCategory(${id})">Удалить</button>
    </div>
  `);
}
async function deleteCategory(id) {
  await Api.del('/categories/' + id);
  closeModal();
  invalidateProductCache();
  await loadCategories();
  await renderAdminCatalog();
  showToast('Раздел удалён');
}

function openProductFormModal(id, categoryId) {
  (async () => {
    let editing = null;
    if (id) {
      const products = await loadProducts(categoryId);
      editing = products.find(p => p.id === id);
    }
    const catOptions = CATEGORIES.map(c => `<option value="${c.id}" ${(editing ? editing.category_id : categoryId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    renderModal(`
      <h3>${editing ? 'Изменить товар' : 'Новый товар'}</h3>
      <div class="field"><label>Фото</label>
        <div class="photo-upload">
          <div class="photo-preview" id="photoPreview">${editing && editing.photo ? `<img src="${editing.photo}">` : photoPlaceholder()}</div>
          <input type="file" accept="image/*" id="photoInput">
        </div>
      </div>
      <div class="field"><label>Раздел</label><select id="fCategory">${catOptions}</select></div>
      <div class="field"><label>Наименование</label><input type="text" id="fName" value="${editing ? esc(editing.name) : ''}" placeholder="Название товара"></div>
      <div class="field"><label>Цена, сом</label><input type="number" id="fPrice" value="${editing ? (editing.price ?? '') : ''}" placeholder="0"></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Отмена</button>
        <button class="btn primary" onclick="saveProduct(${editing ? editing.id : 'null'}, ${editing ? editing.category_id : categoryId})">Сохранить</button>
      </div>
    `);
    document.getElementById('photoInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => { document.getElementById('photoPreview').innerHTML = `<img src="${ev.target.result}">`; };
      reader.readAsDataURL(file);
    });
  })();
}
async function saveProduct(id, oldCategoryId) {
  const name = document.getElementById('fName').value.trim();
  const price = document.getElementById('fPrice').value;
  const categoryId = document.getElementById('fCategory').value;
  const photoFile = document.getElementById('photoInput').files[0];
  if (!name) { showToast('Укажите наименование товара', true); return; }

  const form = new FormData();
  form.append('name', name);
  form.append('price', price);
  form.append('category_id', categoryId);
  if (photoFile) form.append('photo', photoFile);

  try {
    if (id) await Api.patch('/products/' + id, form, true);
    else await Api.post('/products', form, true);
    closeModal();
    invalidateProductCache();
    await renderAdminCatalog();
    showToast('Товар сохранён');
  } catch (e) {
    showToast('Не удалось сохранить товар', true);
  }
}
function confirmDeleteProduct(id, categoryId) {
  renderModal(`
    <h3>Удалить товар?</h3>
    <p style="color:var(--text-mute);font-size:14px;">Товар будет удалён безвозвратно.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn danger" onclick="deleteProduct(${id})">Удалить</button>
    </div>
  `);
}
async function deleteProduct(id) {
  await Api.del('/products/' + id);
  closeModal();
  invalidateProductCache();
  await renderAdminCatalog();
  showToast('Товар удалён');
}

/* -- admin: users -- */
async function renderAdminUsers() {
  const root = document.getElementById('adminTabRoot');
  const users = await Api.get('/auth/users');
  let html = `<div class="admin-toolbar"><button class="btn primary" onclick="openUserFormModal(null)">${plusIcon()} Новый пользователь</button></div>`;
  for (const u of users) {
    html += `<div class="list-row">
      <div class="lr-main">
        <p class="lr-title">${esc(u.name)} ${!u.active ? '<span style="color:var(--red);font-weight:600;">(отключён)</span>' : ''}</p>
        <p class="lr-sub">${esc(u.login)} · ${u.role === 'admin' ? 'Администратор' : 'Менеджер'}</p>
      </div>
      <div class="lr-actions">
        <button class="icon-btn" onclick="openUserFormModal(${u.id})">${editIcon()}</button>
        ${u.id !== Auth.user.id ? `<button class="icon-btn danger" onclick="confirmDeleteUser(${u.id}, '${esc(u.name).replace(/'/g, "\\'")}')">${trashIcon()}</button>` : ''}
      </div>
    </div>`;
  }
  root.innerHTML = html;
}
function openUserFormModal(id) {
  (async () => {
    const editing = id ? (await Api.get('/auth/users')).find(u => u.id === id) : null;
    renderModal(`
      <h3>${editing ? 'Изменить пользователя' : 'Новый пользователь'}</h3>
      <div class="field"><label>Имя</label><input type="text" id="uName" value="${editing ? esc(editing.name) : ''}" placeholder="Имя Фамилия"></div>
      <div class="field"><label>Логин</label><input type="text" id="uLogin" value="${editing ? esc(editing.login) : ''}" ${editing ? 'disabled' : ''} placeholder="login"></div>
      <div class="field"><label>${editing ? 'Новый пароль (необязательно)' : 'Пароль'}</label><input type="text" id="uPassword" placeholder="${editing ? 'Оставьте пустым, чтобы не менять' : 'Пароль'}"></div>
      <div class="field"><label>Роль</label>
        <select id="uRole">
          <option value="manager" ${editing && editing.role === 'manager' ? 'selected' : ''}>Менеджер</option>
          <option value="admin" ${editing && editing.role === 'admin' ? 'selected' : ''}>Администратор</option>
        </select>
      </div>
      ${editing ? `<div class="field"><label><input type="checkbox" id="uActive" ${editing.active ? 'checked' : ''} style="width:auto;margin-right:8px;">Активен</label></div>` : ''}
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Отмена</button>
        <button class="btn primary" onclick="saveUser(${id || 'null'})">Сохранить</button>
      </div>
    `);
  })();
}
async function saveUser(id) {
  const name = document.getElementById('uName').value.trim();
  const login = document.getElementById('uLogin').value.trim();
  const password = document.getElementById('uPassword').value;
  const role = document.getElementById('uRole').value;
  if (!name || !login) { showToast('Заполните имя и логин', true); return; }

  try {
    if (id) {
      const payload = { name, role };
      const activeEl = document.getElementById('uActive');
      if (activeEl) payload.active = activeEl.checked ? 1 : 0;
      if (password) payload.password = password;
      await Api.patch('/auth/users/' + id, payload);
    } else {
      if (!password) { showToast('Укажите пароль', true); return; }
      await Api.post('/auth/users', { name, login, password, role });
    }
    closeModal();
    await renderAdminUsers();
    showToast('Пользователь сохранён');
  } catch (e) {
    if (e.data && e.data.error === 'login_taken') showToast('Такой логин уже занят', true);
    else showToast('Не удалось сохранить пользователя', true);
  }
}
function confirmDeleteUser(id, name) {
  renderModal(`
    <h3>Удалить пользователя?</h3>
    <p style="color:var(--text-mute);font-size:14px;">«${esc(name)}» больше не сможет войти в систему.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn danger" onclick="deleteUser(${id})">Удалить</button>
    </div>
  `);
}
async function deleteUser(id) {
  await Api.del('/auth/users/' + id);
  closeModal();
  await renderAdminUsers();
  showToast('Пользователь удалён');
}

/* ============================================================
   NAV / SHELL / MODAL / TOAST
   ============================================================ */

function renderNav() {
  const cartCount = Cart.count();
  const items = [
    { key: 'home', label: 'Каталог', hash: '#/', icon: homeIcon, match: r => r.name === 'home' || r.name === 'category' || r.name === 'search' },
    { key: 'cart', label: 'Заявка', hash: '#/cart', icon: cartIcon, match: r => r.name === 'cart', badge: cartCount },
    { key: 'contractors', label: 'Контрагенты', hash: '#/contractors', icon: usersIcon, match: r => r.name === 'contractors' },
    { key: 'orders', label: 'Заявки', hash: '#/orders', icon: listIcon, match: r => r.name === 'orders' || r.name === 'order-detail' },
  ];
  if (Auth.isAdmin()) items.push({ key: 'admin', label: 'Админ', hash: '#/admin', icon: adminIcon, match: r => r.name === 'admin' });

  const navHtml = items.map(it => {
    const active = it.match(currentRoute);
    const badge = it.badge > 0 ? ` <span class="badge" data-cart-badge data-count="${it.badge}"></span>` : '';
    return `<button class="${active ? 'active' : ''}" onclick="navigate('${it.hash}')">${it.icon()}${badge}<span>${it.label}</span></button>`;
  }).join('');

  document.getElementById('mainNav').innerHTML = items.map(it => {
    const active = it.match(currentRoute);
    return `<button class="${active ? 'active' : ''}" onclick="navigate('${it.hash}')">${it.label}${it.badge > 0 ? ' · ' + it.badge : ''}</button>`;
  }).join('');

  document.getElementById('bottomNav').innerHTML = `<div class="bottom-nav-inner">${navHtml}</div>`;
  updateCartBadge();
}

function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = `
    <div class="um-header">
      <div class="um-name">${esc(Auth.user.name)}</div>
      <div class="um-role">${Auth.user.role === 'admin' ? 'Администратор' : 'Менеджер'}</div>
    </div>
    <button onclick="openChangePasswordModal()">Сменить пароль</button>
    <button class="danger" onclick="Auth.logout()">Выйти</button>
  `;
  menu.hidden = false;
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('userMenu');
  if (!menu || menu.hidden) return;
  if (!menu.contains(e.target) && !e.target.closest('.icon-btn-lg')) menu.hidden = true;
});

function openChangePasswordModal() {
  document.getElementById('userMenu').hidden = true;
  renderModal(`
    <h3>Смена пароля</h3>
    <div class="field"><label>Текущий пароль</label><input type="password" id="curPass"></div>
    <div class="field"><label>Новый пароль</label><input type="password" id="newPass"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn primary" onclick="doChangePassword()">Сохранить</button>
    </div>
  `);
}
async function doChangePassword() {
  const currentPassword = document.getElementById('curPass').value;
  const newPassword = document.getElementById('newPass').value;
  try {
    await Api.post('/auth/change-password', { currentPassword, newPassword });
    closeModal();
    showToast('Пароль изменён');
  } catch (e) {
    showToast('Не удалось сменить пароль — проверьте текущий пароль', true);
  }
}

function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }
function renderModal(inner) {
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal">${inner}</div>
    </div>`;
}
function showToast(msg, isErr, duration) {
  const root = document.getElementById('toastRoot');
  root.innerHTML = `<div class="toast ${isErr ? 'err' : ''}">${isErr ? warnIcon() : checkIcon()}${esc(msg)}</div>`;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { root.innerHTML = ''; }, duration || 3000);
}

/* ---- icons ---- */
function photoPlaceholder() { return `<svg viewBox="0 0 64 64"><rect x="6" y="14" width="52" height="38" rx="3"/><circle cx="22" cy="28" r="5"/><path d="M6 44 L22 32 L34 40 L44 30 L58 42"/></svg>`; }
function editIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`; }
function trashIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/></svg>`; }
function plusIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`; }
function backIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18 L9 12 L15 6"/></svg>`; }
function cartIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.5 3h2l2.7 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21.5 7H6"/></svg>`; }
function homeIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`; }
function usersIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.6 3-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="18" cy="9" r="2.6"/><path d="M15.5 14.3c2.6.4 4.8 2.3 5 5.7"/></svg>`; }
function listIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/></svg>`; }
function adminIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z"/></svg>`; }
function boxIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>`; }
function notFoundIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`; }
function checkIcon() { return `<svg viewBox="0 0 24 24"><path d="M20 6 L9 17 L4 12"/></svg>`; }
function warnIcon() { return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8 L12 13"/><circle cx="12" cy="16" r="0.6" fill="#fff"/></svg>`; }

/* ============================================================
   SCREEN SWITCHING & BOOT
   ============================================================ */

function showAuthScreen() {
  document.getElementById('authScreen').hidden = false;
  document.getElementById('appRoot').hidden = true;
  setTimeout(() => document.getElementById('loginInput')?.focus(), 30);
}
function showAppScreen() {
  document.getElementById('authScreen').hidden = true;
  document.getElementById('appRoot').hidden = false;
  document.getElementById('userChip').textContent = Auth.user ? Auth.user.name : '';
}

async function doLogin() {
  const login = document.getElementById('loginInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const errEl = document.getElementById('authError');
  errEl.hidden = true;
  if (!login || !password) { errEl.textContent = 'Введите логин и пароль'; errEl.hidden = false; return; }
  try {
    await Auth.login(login, password);
    Cart.load();
    router();
  } catch (e) {
    errEl.textContent = 'Неверный логин или пароль';
    errEl.hidden = false;
  }
}

async function boot() {
  Cart.load();
  const ok = await Auth.init();
  if (ok) {
    await loadCategories();
    router();
  } else {
    showAuthScreen();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
