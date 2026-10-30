'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'orders.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const STATUSES = ['new', 'confirmed', 'completed', 'rejected', 'cancelled'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- storage ----------
let orders = [];
try {
  orders = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  orders = [];
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function newCode() {
  // bez mylących znaków (0/O, 1/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  } while (orders.some((o) => o.code === code));
  return code;
}

// ---------- helpers ----------
const sessions = new Set();
const hits = new Map();

function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20_000) {
        reject(Object.assign(new Error('Za duże żądanie'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Niepoprawny JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return Boolean(m && sessions.has(m[1]));
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function publicView(o) {
  return {
    code: o.code,
    status: o.status,
    pickup: o.pickup,
    destination: o.destination,
    when: o.when,
    passengers: o.passengers,
    price: o.price,
    driverNote: o.driverNote,
    createdAt: o.createdAt,
  };
}

function validateOrder(b) {
  const o = {
    name: str(b.name, 80),
    phone: str(b.phone, 20),
    pickup: str(b.pickup, 200),
    destination: str(b.destination, 200),
    when: str(b.when, 25),
    passengers: Number(b.passengers),
    notes: str(b.notes, 500),
  };
  if (o.name.length < 2) return { error: 'Podaj imię.' };
  if (!/^\+?[0-9 ()-]{7,20}$/.test(o.phone)) return { error: 'Podaj poprawny numer telefonu.' };
  if (o.pickup.length < 3) return { error: 'Podaj adres odbioru.' };
  if (o.destination.length < 3) return { error: 'Podaj adres docelowy.' };
  if (!Number.isInteger(o.passengers) || o.passengers < 1 || o.passengers > config.maxPassengers) {
    return { error: `Liczba pasażerów: 1–${config.maxPassengers}.` };
  }
  if (o.when === 'now') {
    o.when = 'now';
  } else {
    const t = Date.parse(o.when);
    if (Number.isNaN(t)) return { error: 'Podaj poprawną datę i godzinę.' };
    if (t < Date.now() - 5 * 60_000) return { error: 'Termin nie może być w przeszłości.' };
    if (t > Date.now() + 90 * 86_400_000) return { error: 'Zamówienia przyjmuję maksymalnie 90 dni naprzód.' };
    o.when = new Date(t).toISOString();
  }
  return { value: o };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const { pathname } = url;
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'GET' && pathname === '/api/config') {
    return send(res, 200, config);
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    if (rateLimited('order:' + ip, 5, 10 * 60_000)) {
      return send(res, 429, { error: 'Zbyt wiele zamówień. Spróbuj za chwilę lub zadzwoń.' });
    }
    const { value, error } = validateOrder(await readJson(req));
    if (error) return send(res, 400, { error });
    const order = {
      id: crypto.randomUUID(),
      code: newCode(),
      status: 'new',
      ...value,
      price: null,
      driverNote: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orders.push(order);
    save();
    return send(res, 201, publicView(order));
  }

  let m = /^\/api\/orders\/([A-Za-z0-9]{6})$/.exec(pathname);
  if (m && (req.method === 'GET' || req.method === 'DELETE')) {
    if (rateLimited('lookup:' + ip, 30, 60_000)) return send(res, 429, { error: 'Zbyt wiele prób.' });
    const order = orders.find((o) => o.code === m[1].toUpperCase());
    if (!order) return send(res, 404, { error: 'Nie znaleziono zamówienia o takim kodzie.' });
    if (req.method === 'GET') return send(res, 200, publicView(order));
    if (!['new', 'confirmed'].includes(order.status)) {
      return send(res, 409, { error: 'To zamówienie nie może już zostać anulowane.' });
    }
    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
    save();
    return send(res, 200, publicView(order));
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    if (rateLimited('login:' + ip, 8, 10 * 60_000)) return send(res, 429, { error: 'Zbyt wiele prób logowania.' });
    const { password } = await readJson(req);
    const a = Buffer.from(String(password || ''));
    const b = Buffer.from(ADMIN_PASSWORD);
    if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return send(res, 401, { error: 'Błędne hasło.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    return send(res, 200, { token });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'Brak autoryzacji.' });

    if (req.method === 'GET' && pathname === '/api/admin/orders') {
      return send(res, 200, [...orders].reverse());
    }

    m = /^\/api\/admin\/orders\/([0-9a-f-]{36})$/.exec(pathname);
    if (m && req.method === 'PATCH') {
      const order = orders.find((o) => o.id === m[1]);
      if (!order) return send(res, 404, { error: 'Nie znaleziono zamówienia.' });
      const b = await readJson(req);
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'Niepoprawny status.' });
        order.status = b.status;
      }
      if (b.price !== undefined) {
        if (b.price === null || b.price === '') order.price = null;
        else {
          const p = Number(b.price);
          if (!Number.isFinite(p) || p < 0 || p > 100000) return send(res, 400, { error: 'Niepoprawna cena.' });
          order.price = Math.round(p * 100) / 100;
        }
      }
      if (b.driverNote !== undefined) order.driverNote = str(b.driverNote, 300);
      order.updatedAt = new Date().toISOString();
      save();
      return send(res, 200, order);
    }
  }

  return send(res, 404, { error: 'Nie znaleziono.' });
}

// ---------- static ----------
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Nie znaleziono');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Błąd serwera.' });
    if (!e.status) console.error(e);
  }
});

if (require.main === module) {
  if (!ADMIN_PASSWORD) console.warn('UWAGA: ustaw ADMIN_PASSWORD, bez tego panel kierowcy jest niedostępny.');
  server.listen(PORT, () => console.log(`Taxi: http://localhost:${PORT}  (panel: /admin)`));
}

module.exports = server;
