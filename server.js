'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rides.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'TaxiBookingApp/1.0 (self-hosted)';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const ACTIVE = ['accepted', 'arrived', 'in_progress'];

// ---------- storage ----------
let rides = [];
try { rides = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { rides = []; }
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rides, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- state ----------
const driver = { online: false, lat: null, lng: null, ts: 0 };
const sessions = new Set();
const hits = new Map();
const cache = new Map();

function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20_000) { reject(Object.assign(new Error('Za duże żądanie'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Niepoprawny JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const isDriver = (req) => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return Boolean(m && sessions.has(m[1])); };
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const point = (p) => {
  if (!p || typeof p !== 'object') return null;
  const lat = num(p.lat), lng = num(p.lng);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
  return { lat, lng, label: str(p.label, 200) };
};

function haversineKm(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

async function fetchJson(url, ttlMs = 0) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pl' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('upstream ' + r.status);
  const v = await r.json();
  if (ttlMs) { cache.set(url, { t: Date.now(), v }); if (cache.size > 500) cache.delete(cache.keys().next().value); }
  return v;
}

async function route(from, to) {
  try {
    const d = await fetchJson(`https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=simplified&geometries=geojson`, 600_000);
    const r = d.routes && d.routes[0];
    if (r) return { distanceKm: r.distance / 1000, durationMin: r.duration / 60, line: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]) };
  } catch { /* fallback poniżej */ }
  const km = haversineKm(from, to) * 1.3;
  return { distanceKm: km, durationMin: (km / 35) * 60, line: [[from.lat, from.lng], [to.lat, to.lng]], approx: true };
}

function priceFor(km) {
  const t = config.tariff;
  return Math.max(t.minFare, Math.round(t.baseFare + t.perKm * km));
}

async function quote(from, to) {
  const r = await route(from, to);
  return { distanceKm: Math.round(r.distanceKm * 10) / 10, durationMin: Math.max(1, Math.round(r.durationMin)), price: priceFor(r.distanceKm), line: r.line, approx: Boolean(r.approx) };
}

const driverFresh = () => driver.online && Date.now() - driver.ts < 60_000;

function clientView(r) {
  const withDriver = ACTIVE.includes(r.status);
  return {
    id: r.id, code: r.code, status: r.status, pickup: r.pickup, destination: r.destination, when: r.when,
    passengers: r.passengers, distanceKm: r.distanceKm, durationMin: r.durationMin,
    price: r.finalPrice ?? r.price, finalPrice: r.finalPrice ?? null, createdAt: r.createdAt,
    driver: withDriver ? { ...config.driver, phone: config.phone, lat: driver.lat, lng: driver.lng, ts: driver.ts } : null,
    driverOnline: driverFresh(),
  };
}

function normalizeWhen(w) {
  if (w === 'now' || w === undefined) return { value: 'now' };
  const t = Date.parse(w);
  if (Number.isNaN(t)) return { error: 'Podaj poprawną datę i godzinę.' };
  if (t < Date.now() - 5 * 60_000) return { error: 'Termin nie może być w przeszłości.' };
  if (t > Date.now() + 90 * 86_400_000) return { error: 'Zamówienia przyjmuję maksymalnie 90 dni naprzód.' };
  return { value: new Date(t).toISOString() };
}

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(5), (b) => alphabet[b % alphabet.length]).join(''); } while (rides.some((r) => r.code === code));
  return code;
}

const touch = (r) => { r.updatedAt = new Date().toISOString(); save(); };

// ---------- API ----------
async function handleApi(req, res, url) {
  const { pathname, searchParams: q } = url;
  const ip = req.socket.remoteAddress || 'unknown';
  const method = req.method;

  if (method === 'GET' && pathname === '/api/config') {
    return send(res, 200, { businessName: config.businessName, phone: config.phone, mapCenter: config.mapCenter, driver: config.driver, tariff: config.tariff, maxPassengers: config.maxPassengers, driverOnline: driverFresh() });
  }

  if (method === 'GET' && pathname === '/api/geocode') {
    if (rateLimited('geo:' + ip, 40, 60_000)) return send(res, 429, { error: 'Zbyt wiele zapytań.' });
    const text = str(q.get('q') || '', 120);
    if (text.length < 3) return send(res, 200, []);
    try {
      const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=${config.country}&q=${encodeURIComponent(text)}`;
      const d = await fetchJson(u, 3_600_000);
      return send(res, 200, d.map((x) => ({ label: x.display_name, lat: Number(x.lat), lng: Number(x.lon) })));
    } catch { return send(res, 502, { error: 'Wyszukiwarka adresów chwilowo niedostępna.' }); }
  }

  if (method === 'GET' && pathname === '/api/reverse') {
    if (rateLimited('rev:' + ip, 30, 60_000)) return send(res, 429, { error: 'Zbyt wiele zapytań.' });
    const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
    if (!point({ lat, lng })) return send(res, 400, { error: 'Złe współrzędne.' });
    try {
      const d = await fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`, 3_600_000);
      const a = d.address || {};
      const street = [a.road, a.house_number].filter(Boolean).join(' ');
      return send(res, 200, { label: [street, a.city || a.town || a.village].filter(Boolean).join(', ') || d.display_name || 'Moja lokalizacja' });
    } catch { return send(res, 200, { label: 'Moja lokalizacja' }); }
  }

  if (method === 'POST' && pathname === '/api/quote') {
    if (rateLimited('quote:' + ip, 40, 60_000)) return send(res, 429, { error: 'Zbyt wiele zapytań.' });
    const b = await readJson(req);
    const from = point(b.from), to = point(b.to);
    if (!from || !to) return send(res, 400, { error: 'Wybierz adres odbioru i adres docelowy.' });
    return send(res, 200, await quote(from, to));
  }

  if (method === 'POST' && pathname === '/api/rides') {
    if (rateLimited('ride:' + ip, 6, 10 * 60_000)) return send(res, 429, { error: 'Zbyt wiele zamówień. Zadzwoń do mnie.' });
    const b = await readJson(req);
    const pickup = point(b.pickup), destination = point(b.destination);
    const name = str(b.name, 80), phone = str(b.phone, 20), notes = str(b.notes, 300);
    const passengers = Number(b.passengers);
    if (!pickup || !destination) return send(res, 400, { error: 'Wybierz adres odbioru i adres docelowy.' });
    if (name.length < 2) return send(res, 400, { error: 'Podaj imię.' });
    if (!/^\+?[0-9 ()-]{7,20}$/.test(phone)) return send(res, 400, { error: 'Podaj poprawny numer telefonu.' });
    if (!Number.isInteger(passengers) || passengers < 1 || passengers > config.maxPassengers) return send(res, 400, { error: `Liczba pasażerów: 1–${config.maxPassengers}.` });
    const when = normalizeWhen(b.when);
    if (when.error) return send(res, 400, { error: when.error });
    if (rides.some((r) => r.phone === phone && ['searching', ...ACTIVE].includes(r.status))) {
      return send(res, 409, { error: 'Masz już aktywne zamówienie.' });
    }
    const qt = await quote(pickup, destination);
    const ride = {
      id: crypto.randomUUID(), token: crypto.randomBytes(16).toString('hex'), code: newCode(), status: 'searching',
      name, phone, pickup, destination, when: when.value, passengers, notes,
      distanceKm: qt.distanceKm, durationMin: qt.durationMin, price: qt.price, finalPrice: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    rides.push(ride); save();
    return send(res, 201, { ...clientView(ride), token: ride.token });
  }

  let m = /^\/api\/rides\/([0-9a-f-]{36})(\/cancel)?$/.exec(pathname);
  if (m) {
    const ride = rides.find((r) => r.id === m[1]);
    const token = Buffer.from(String(q.get('token') || ''));
    const ok = ride && Buffer.from(ride.token).length === token.length && crypto.timingSafeEqual(Buffer.from(ride.token), token);
    if (!ok) return send(res, 404, { error: 'Nie znaleziono zamówienia.' });
    if (method === 'GET' && !m[2]) return send(res, 200, clientView(ride));
    if (method === 'POST' && m[2]) {
      if (!['searching', 'accepted', 'arrived'].includes(ride.status)) return send(res, 409, { error: 'Tego zamówienia nie można już anulować.' });
      ride.status = 'cancelled'; ride.cancelledBy = 'client'; touch(ride);
      return send(res, 200, clientView(ride));
    }
  }

  if (method === 'POST' && pathname === '/api/driver/login') {
    if (rateLimited('login:' + ip, 8, 10 * 60_000)) return send(res, 429, { error: 'Zbyt wiele prób logowania.' });
    const { password } = await readJson(req);
    const a = Buffer.from(String(password || '')), b = Buffer.from(ADMIN_PASSWORD);
    if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'Błędne hasło.' });
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    return send(res, 200, { token });
  }

  if (pathname.startsWith('/api/driver/')) {
    if (!isDriver(req)) return send(res, 401, { error: 'Brak autoryzacji.' });

    if (method === 'GET' && pathname === '/api/driver/state') {
      const today = new Date().toDateString();
      const done = rides.filter((r) => r.status === 'completed' && new Date(r.updatedAt).toDateString() === today);
      const byWhen = (a, b) => (a.when === 'now' ? 0 : Date.parse(a.when)) - (b.when === 'now' ? 0 : Date.parse(b.when));
      const rank = { in_progress: 0, arrived: 1, accepted: 2 };
      const active = rides.filter((r) => ACTIVE.includes(r.status)).sort((a, b) => rank[a.status] - rank[b.status] || byWhen(a, b));
      return send(res, 200, {
        online: driver.online,
        pending: rides.filter((r) => r.status === 'searching').sort(byWhen),
        active: active[0] || null,
        upcoming: active.slice(1),
        today: { count: done.length, total: done.reduce((s, r) => s + (r.finalPrice ?? r.price), 0) },
        history: rides.filter((r) => ['completed', 'cancelled', 'rejected'].includes(r.status)).slice(-20).reverse(),
      });
    }

    if (method === 'POST' && pathname === '/api/driver/presence') {
      const b = await readJson(req);
      if (b.online !== undefined) driver.online = Boolean(b.online);
      const p = point(b);
      if (p) { driver.lat = p.lat; driver.lng = p.lng; }
      driver.ts = Date.now();
      return send(res, 200, { online: driver.online });
    }

    m = /^\/api\/driver\/rides\/([0-9a-f-]{36})$/.exec(pathname);
    if (m && method === 'POST') {
      const ride = rides.find((r) => r.id === m[1]);
      if (!ride) return send(res, 404, { error: 'Nie znaleziono zamówienia.' });
      const b = await readJson(req);
      const flow = { accept: ['searching', 'accepted'], reject: ['searching', 'rejected'], arrived: ['accepted', 'arrived'], start: ['arrived', 'in_progress'], complete: ['in_progress', 'completed'], cancel: ['accepted', 'cancelled'] };
      const step = flow[b.action];
      if (!step) return send(res, 400, { error: 'Nieznana akcja.' });
      const allowed = b.action === 'cancel' ? ['accepted', 'arrived', 'in_progress'] : [step[0]];
      if (b.action === 'start') allowed.push('accepted');
      if (!allowed.includes(ride.status)) return send(res, 409, { error: 'Ta akcja nie jest teraz możliwa.' });
      if (b.action === 'accept' && rides.some((r) => r.id !== ride.id && ['arrived', 'in_progress'].includes(r.status))) {
        return send(res, 409, { error: 'Najpierw dokończ trwający kurs.' });
      }
      if (b.action === 'complete' && b.finalPrice !== undefined) {
        const p = Number(b.finalPrice);
        if (!Number.isFinite(p) || p < 0 || p > 100000) return send(res, 400, { error: 'Niepoprawna cena.' });
        ride.finalPrice = Math.round(p * 100) / 100;
      }
      ride.status = step[1];
      if (b.action === 'cancel') ride.cancelledBy = 'driver';
      touch(ride);
      return send(res, 200, ride);
    }
  }

  return send(res, 404, { error: 'Nie znaleziono.' });
}

// ---------- static ----------
const CSP = "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'";
const PAGES = { '/': '/index.html', '/driver': '/driver.html', '/admin': '/driver.html' };

function serveStatic(req, res, url) {
  const rel = PAGES[url.pathname] || decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Nie znaleziono');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
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
  if (!ADMIN_PASSWORD) console.warn('UWAGA: ustaw ADMIN_PASSWORD, bez tego aplikacja kierowcy jest niedostępna.');
  server.listen(PORT, () => console.log(`Klient: http://localhost:${PORT}   Kierowca: http://localhost:${PORT}/driver`));
}

module.exports = server;
