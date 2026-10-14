'use strict';
/* Jannat Fashion Mart API - zero dependencies. Needs Node >= 22.5 (built-in SQLite). */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---- config (.env supported) ----
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const PORT = +process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || (console.warn('WARNING: JWT_SECRET not set - logins reset on every restart'), crypto.randomBytes(32).toString('hex'));
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@jannatfashionmart.com').toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const ORIGIN = process.env.CORS_ORIGIN || '';
const DIVISIONS = ['Dhaka', 'Chattogram', 'Rajshahi', 'Khulna', 'Barishal', 'Sylhet', 'Rangpur', 'Mymensingh'];
const PAYMENTS = ['Cash on Delivery', 'bKash', 'Nagad', 'Rocket', 'Card'], WALLETS = ['bKash', 'Nagad', 'Rocket'];
const STATUSES = ['Pending', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'];

// ---- database ----
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'data.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,pass TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,cat TEXT NOT NULL,price REAL NOT NULL,old REAL NOT NULL DEFAULT 0,img TEXT DEFAULT '📦',rating REAL DEFAULT 4,stock INTEGER NOT NULL DEFAULT 0,sold INTEGER NOT NULL DEFAULT 0,badge TEXT DEFAULT '',descr TEXT DEFAULT '',live INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,uid INTEGER DEFAULT 0,name TEXT,phone TEXT,email TEXT,division TEXT,addr TEXT,pay TEXT,trx TEXT,items TEXT,sub REAL,off REAL,ship REAL,total REAL,status TEXT DEFAULT 'Pending',date TEXT,created TEXT);
CREATE INDEX IF NOT EXISTS ix_orders_phone ON orders(phone); CREATE INDEX IF NOT EXISTS ix_orders_uid ON orders(uid);
CREATE TABLE IF NOT EXISTS coupons(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT UNIQUE NOT NULL,type TEXT NOT NULL,val REAL NOT NULL,minv REAL NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);`);
const q = (sql) => db.prepare(sql);
const DEFAULTS = { ph: '16000', wa: '8801700000000', dh: 80, ds: 120, fq: 2, fa: 999999 };
const getSettings = () => { const s = { ...DEFAULTS }; for (const r of q('SELECT k,v FROM settings').all()) s[r.k] = isNaN(+r.v) ? r.v : +r.v; return s; };
if (!q('SELECT COUNT(*) c FROM products').get().c) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
  const ins = q('INSERT INTO products(name,cat,price,old,img,rating,stock,sold,badge,descr) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (const p of seed) ins.run(p.name, p.cat, p.price, p.old, p.img, p.rating, p.stock, p.sold || 0, p.badge || '', p.desc || '');
  q("INSERT OR IGNORE INTO coupons(code,type,val,minv) VALUES('WELCOME10','pct',10,0),('BD50','flat',50,1000)").run();
}

// ---- auth helpers (scrypt passwords + HS256 JWT) ----
const hashPass = (p) => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const checkPass = (p, h) => { const [s, k] = h.split(':'); const a = Buffer.from(k, 'hex'), b = crypto.scryptSync(p, s, 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const b64 = (x) => Buffer.from(x).toString('base64url');
const sign = (u) => { const b = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64(JSON.stringify({ sub: u.id, exp: Date.now() + 7 * 864e5 })); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const verify = (t) => { try { const [h, p, s] = t.split('.'), e = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url'); if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null; const d = JSON.parse(Buffer.from(p, 'base64url')); return d.exp > Date.now() ? d.sub : null; } catch { return null; } };
const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
if (!q('SELECT 1 FROM users WHERE email=?').get(ADMIN_EMAIL)) q("INSERT INTO users(name,email,pass,role,created) VALUES('Admin',?,?,'admin',?)").run(ADMIN_EMAIL, hashPass(ADMIN_PASS), new Date().toISOString());
if (ADMIN_PASS === 'ChangeMe123!') console.warn('WARNING: default admin password in use - set ADMIN_PASSWORD in .env');

// ---- mappers ----
const P = (r) => ({ id: r.id, name: r.name, cat: r.cat, price: r.price, old: r.old, img: r.img, rating: r.rating, stock: r.stock, sold: r.sold, badge: r.badge, desc: r.descr, on: !!r.live });
const O = (r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, div: r.division, addr: r.addr, pay: r.pay, trx: r.trx, items: JSON.parse(r.items), sub: r.sub, off: r.off, ship: r.ship, total: r.total, status: r.status, date: r.date });
const C = (r) => ({ id: r.id, code: r.code, type: r.type, val: r.val, min: r.minv, on: r.active });

// ---- tiny http toolkit ----
class HttpError extends Error { constructor(s, m) { super(m); this.s = s; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
const hits = new Map();
const limit = (ip, key, max) => { const k = key + ip, now = Date.now(), a = (hits.get(k) || []).filter((t) => now - t < 60000); a.push(now); hits.set(k, a); if (a.length > max) bad('Too many requests, slow down', 429); };
setInterval(() => hits.clear(), 600000).unref();
const readBody = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e5) { no(new HttpError(413, 'Body too large')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new HttpError(400, 'Invalid JSON')); } }); });
const num = (v, name, min = 0) => { const n = Number(v); if (!Number.isFinite(n) || n < min) bad('Invalid ' + name); return n; };
const str = (v, name, min = 1, max = 300) => { v = String(v ?? '').trim(); if (v.length < min || v.length > max) bad('Invalid ' + name); return v; };

function discount(code, sub) {
  const c = q('SELECT * FROM coupons WHERE code=? AND active=1').get(String(code || '').toUpperCase().trim());
  if (!c) bad('Invalid coupon'); if (sub < c.minv) bad('Minimum order ' + c.minv);
  return { code: c.code, off: Math.min(sub, Math.round(c.type === 'pct' ? sub * c.val / 100 : c.val)) };
}
const shipping = (s, div, qty, sub) => qty >= s.fq || sub >= s.fa ? 0 : div === 'Dhaka' ? s.dh : s.ds;

// ---- routes ----
const routes = [];
const route = (m, p, role, fn) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), role, fn });

route('GET', '/api/health', 0, () => ({ ok: true }));
route('GET', '/api/settings', 0, () => getSettings());
route('GET', '/api/products', 0, ({ query }) => {
  const order = { low: 'price ASC', high: 'price DESC', rate: 'rating DESC', pop: 'sold DESC' }[query.sort] || 'sold DESC';
  const w = ['live=1'], a = [];
  if (query.cat && query.cat !== 'All') { w.push('cat=?'); a.push(query.cat); }
  if (query.q) { w.push('name LIKE ?'); a.push('%' + query.q.slice(0, 60) + '%'); }
  return q(`SELECT * FROM products WHERE ${w.join(' AND ')} ORDER BY ${order}`).all(...a).map(P);
});
route('GET', '/api/products/:id', 0, ({ params }) => { const r = q('SELECT * FROM products WHERE id=? AND live=1').get(+params.id); return r ? P(r) : bad('Product not found', 404); });

route('POST', '/api/auth/register', 0, ({ body, ip }) => {
  limit(ip, 'auth', 10);
  const name = str(body.name || 'Customer', 'name', 1, 80), email = str(body.email, 'email', 5, 120).toLowerCase(), pass = str(body.pass, 'password', 6, 100);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Invalid email');
  if (q('SELECT 1 FROM users WHERE email=?').get(email)) bad('Email already registered', 409);
  const r = q("INSERT INTO users(name,email,pass,role,created) VALUES(?,?,?,'user',?)").run(name, email, hashPass(pass), new Date().toISOString());
  const u = q('SELECT * FROM users WHERE id=?').get(Number(r.lastInsertRowid));
  return { token: sign(u), user: pub(u) };
});
route('POST', '/api/auth/login', 0, ({ body, ip }) => {
  limit(ip, 'auth', 10);
  const u = q('SELECT * FROM users WHERE email=?').get(String(body.email || '').toLowerCase());
  if (!u || !checkPass(String(body.pass || ''), u.pass)) bad('Wrong email or password', 401);
  return { token: sign(u), user: pub(u) };
});
route('GET', '/api/auth/me', 'user', ({ user }) => pub(user));

route('POST', '/api/coupons/validate', 0, ({ body }) => discount(body.code, num(body.subtotal, 'subtotal')));

route('POST', '/api/orders', 0, ({ body, user, ip }) => {
  limit(ip, 'order', 10);
  const name = str(body.name, 'name', 2, 80), phone = String(body.phone || '').trim(), addr = str(body.addr, 'address', 8, 300), div = body.div, pay = body.pay;
  if (!/^01[3-9]\d{8}$/.test(phone)) bad('Enter a valid BD mobile number');
  if (!DIVISIONS.includes(div)) bad('Invalid division'); if (!PAYMENTS.includes(pay)) bad('Invalid payment method');
  const trx = WALLETS.includes(pay) ? str(body.trx, 'TrxID', 6, 40) : '';
  const email = String(body.email || '').trim().slice(0, 120);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) bad('Cart is empty');
  const s = getSettings();
  db.exec('BEGIN IMMEDIATE');
  try {
    let sub = 0, qty = 0; const items = [];
    for (const it of body.items) {
      const n = num(it.q, 'quantity', 1); if (!Number.isInteger(n) || n > 20) bad('Invalid quantity');
      const p = q('SELECT * FROM products WHERE id=? AND live=1').get(+it.id);
      if (!p) bad('A product in your cart is no longer available');
      if (p.stock < n) bad(p.name + ' - only ' + p.stock + ' in stock');
      q('UPDATE products SET stock=stock-?,sold=sold+? WHERE id=?').run(n, n, p.id);
      items.push({ id: p.id, name: p.name, price: p.price, q: n }); sub += p.price * n; qty += n;
    }
    const off = body.coupon ? discount(body.coupon, sub).off : 0, ship = shipping(s, div, qty, sub), total = sub - off + ship;
    const r = q('INSERT INTO orders(id,uid,name,phone,email,division,addr,pay,trx,items,sub,off,ship,total,date,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('tmp' + crypto.randomUUID(), user ? user.id : 0, name, phone, email, div, addr, pay, trx, JSON.stringify(items), sub, off, ship, total, new Date().toISOString().slice(0, 10), new Date().toISOString());
    const id = 'BD' + (100000 + Number(r.lastInsertRowid));
    q('UPDATE orders SET id=? WHERE seq=?').run(id, Number(r.lastInsertRowid));
    db.exec('COMMIT');
    return O(q('SELECT * FROM orders WHERE id=?').get(id));
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});
route('GET', '/api/orders/mine', 'user', ({ user }) => q('SELECT * FROM orders WHERE uid=? ORDER BY seq DESC').all(user.id).map(O));
route('GET', '/api/orders/track', 0, ({ query, ip }) => {
  limit(ip, 'track', 15);
  const r = q('SELECT * FROM orders WHERE id=? AND phone=?').get(String(query.id || '').toUpperCase().trim(), String(query.phone || '').trim());
  return r ? O(r) : bad('No order found. Check Order ID and phone.', 404);
});

// ---- admin ----
route('GET', '/api/admin/orders', 'admin', () => q('SELECT * FROM orders ORDER BY seq DESC').all().map(O));
route('PATCH', '/api/admin/orders/:id', 'admin', ({ params, body }) => {
  const o = q('SELECT * FROM orders WHERE id=?').get(params.id); if (!o) bad('Order not found', 404);
  if (!STATUSES.includes(body.status)) bad('Invalid status');
  db.exec('BEGIN');
  try {
    const back = body.status === 'Cancelled' && o.status !== 'Cancelled' ? 1 : o.status === 'Cancelled' && body.status !== 'Cancelled' ? -1 : 0;
    if (back) for (const i of JSON.parse(o.items)) q('UPDATE products SET stock=MAX(0,stock+?),sold=MAX(0,sold-?) WHERE id=?').run(back * i.q, back * i.q, i.id);
    q('UPDATE orders SET status=? WHERE id=?').run(body.status, o.id); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return O(q('SELECT * FROM orders WHERE id=?').get(o.id));
});
route('GET', '/api/admin/products', 'admin', () => q('SELECT * FROM products ORDER BY id DESC').all().map(P));
route('POST', '/api/admin/products', 'admin', ({ body }) => {
  const r = q('INSERT INTO products(name,cat,price,old,img,stock,badge,descr) VALUES(?,?,?,?,?,?,?,?)').run(str(body.name, 'name', 1, 150), str(body.cat, 'category', 1, 40), num(body.price, 'price'), num(body.old ?? body.price, 'old price'), String(body.img || '📦').slice(0, 8), Math.floor(num(body.stock ?? 0, 'stock')), String(body.badge || '').slice(0, 40), String(body.desc || '').slice(0, 2000));
  return P(q('SELECT * FROM products WHERE id=?').get(Number(r.lastInsertRowid)));
});
route('PATCH', '/api/admin/products/:id', 'admin', ({ params, body }) => {
  const p = q('SELECT * FROM products WHERE id=?').get(+params.id); if (!p) bad('Product not found', 404);
  const f = { name: () => str(body.name, 'name', 1, 150), cat: () => str(body.cat, 'category', 1, 40), price: () => num(body.price, 'price'), old: () => num(body.old, 'old price'), stock: () => Math.floor(num(body.stock, 'stock')), img: () => String(body.img).slice(0, 8), badge: () => String(body.badge).slice(0, 40), descr: () => String(body.desc).slice(0, 2000), live: () => (body.on ? 1 : 0) };
  const map = { name: 'name', cat: 'cat', price: 'price', old: 'old', stock: 'stock', img: 'img', badge: 'badge', desc: 'descr', on: 'live' };
  for (const k in map) if (k in body) q(`UPDATE products SET ${map[k]}=? WHERE id=?`).run(f[map[k]](), p.id);
  return P(q('SELECT * FROM products WHERE id=?').get(p.id));
});
route('DELETE', '/api/admin/products/:id', 'admin', ({ params }) => { q('DELETE FROM products WHERE id=?').run(+params.id); return { ok: true }; });
route('GET', '/api/admin/coupons', 'admin', () => q('SELECT * FROM coupons ORDER BY id').all().map(C));
route('POST', '/api/admin/coupons', 'admin', ({ body }) => {
  if (!['pct', 'flat'].includes(body.type)) bad('Invalid type');
  const code = str(body.code, 'code', 2, 30).toUpperCase(); if (q('SELECT 1 FROM coupons WHERE code=?').get(code)) bad('Coupon code exists', 409);
  const r = q('INSERT INTO coupons(code,type,val,minv) VALUES(?,?,?,?)').run(code, body.type, num(body.val, 'value'), num(body.min || 0, 'min'));
  return C(q('SELECT * FROM coupons WHERE id=?').get(Number(r.lastInsertRowid)));
});
route('PATCH', '/api/admin/coupons/:id', 'admin', ({ params, body }) => { q('UPDATE coupons SET active=? WHERE id=?').run(body.on ? 1 : 0, +params.id); return { ok: true }; });
route('DELETE', '/api/admin/coupons/:id', 'admin', ({ params }) => { q('DELETE FROM coupons WHERE id=?').run(+params.id); return { ok: true }; });
route('PUT', '/api/admin/settings', 'admin', ({ body }) => {
  const up = q('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  for (const k of ['ph', 'wa']) if (k in body) up.run(k, str(body[k], k, 3, 30));
  for (const k of ['dh', 'ds', 'fq', 'fa']) if (k in body) up.run(k, String(num(body[k], k)));
  return getSettings();
});
route('GET', '/api/admin/users', 'admin', () => q('SELECT id,name,email,role,created FROM users ORDER BY id DESC').all());

// ---- server ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUB = path.join(__dirname, 'public');
const send = (res, s, d, h = {}) => { const b = typeof d === 'string' ? d : JSON.stringify(d); res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8', ...h }); res.end(b); };

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'");
  if (ORIGIN) { res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS'); if (req.method === 'OPTIONS') return res.writeHead(204).end(); }
  const url = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
  try {
    if (url.pathname.startsWith('/api/')) {
      const rt = routes.find((r) => r.m === req.method && r.re.test(url.pathname));
      if (!rt) return send(res, routes.some((r) => r.re.test(url.pathname)) ? 405 : 404, { error: 'Not found' });
      const m = url.pathname.match(rt.re); let user = null;
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (tok) { const id = verify(tok); if (id) user = q('SELECT * FROM users WHERE id=?').get(id) || null; }
      if (rt.role && !user) bad('Please login', 401);
      if (rt.role === 'admin' && user.role !== 'admin') bad('Admin only', 403);
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, await rt.fn({ params: { ...m.groups }, query: Object.fromEntries(url.searchParams), body, user, ip }), { 'Cache-Control': 'no-store' });
    }
    let f = path.join(PUB, path.normalize(decodeURIComponent(url.pathname)));
    if (!f.startsWith(PUB)) return send(res, 403, { error: 'Forbidden' });
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    if (f.endsWith('index.html')) { const o = process.env.SITE_URL || ((req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host); res.writeHead(200, { 'Content-Type': MIME['.html'] }); return res.end(fs.readFileSync(f, 'utf8').replaceAll('__ORIGIN__', o.replace(/\/$/, ''))); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' }); fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.s, { error: e.message });
    console.error(e); send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => console.log(`Jannat Fashion Mart running on http://localhost:${PORT}  (admin: ${ADMIN_EMAIL})`));
