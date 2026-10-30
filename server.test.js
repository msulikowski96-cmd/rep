'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.ADMIN_PASSWORD = 'sekret';
process.env.DATA_FILE = path.join(os.tmpdir(), `taxi-test-${process.pid}.json`);
const server = require('./server');
let base;

before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const j = (p, o = {}) => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } });
const post = (p, body, headers) => j(p, { method: 'POST', body: JSON.stringify(body), headers });
const A = { lat: 52.2297, lng: 21.0122, label: 'Start' };
const B = { lat: 52.2400, lng: 21.0400, label: 'Cel' };
const order = { pickup: A, destination: B, name: 'Anna', phone: '600 100 200', passengers: 2, when: 'now' };

test('walidacja odrzuca złe dane', async () => {
  assert.equal((await post('/api/rides', { ...order, phone: 'abc' })).status, 400);
  assert.equal((await post('/api/rides', { ...order, pickup: { lat: 999, lng: 0 } })).status, 400);
});

test('wycena liczona po stronie serwera', async () => {
  const q = await (await post('/api/quote', { from: A, to: B })).json();
  assert.ok(q.distanceKm > 1 && q.price >= 15 && q.line.length >= 2);
});

test('pełny kurs: zamówienie → kierowca przyjmuje → kończy', async () => {
  const created = await (await post('/api/rides', order)).json();
  assert.equal(created.status, 'searching');
  assert.equal(created.phone, undefined, 'widok klienta nie ujawnia danych z zamówienia');
  const ride = `/api/rides/${created.id}?token=${created.token}`;
  assert.equal((await j(`/api/rides/${created.id}?token=zle`)).status, 404, 'zły token');
  assert.equal((await post('/api/rides', order)).status, 409, 'drugie aktywne zamówienie tego numeru');

  assert.equal((await j('/api/driver/state')).status, 401);
  const { token } = await (await post('/api/driver/login', { password: 'sekret' })).json();
  const auth = { Authorization: 'Bearer ' + token };
  await post('/api/driver/presence', { online: true, lat: 52.23, lng: 21.01 }, auth);

  assert.equal((await j(ride).then((r) => r.json())).driverOnline, true);
  const st = await (await j('/api/driver/state', { headers: auth })).json();
  assert.equal(st.pending[0].phone, '600 100 200');

  const act = (action, extra) => post(`/api/driver/rides/${created.id}`, { action, ...extra }, auth);
  assert.equal((await act('start')).status, 409, 'nie da się pominąć kroków');
  assert.equal((await act('accept')).status, 200);
  const accepted = await (await j(ride)).json();
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.driver.lat, 52.23, 'klient widzi pozycję kierowcy');
  assert.equal((await act('arrived')).status, 200);
  assert.equal((await act('start')).status, 200);
  assert.equal((await act('complete', { finalPrice: 31.5 })).status, 200);
  const done = await (await j(ride)).json();
  assert.equal(done.status, 'completed');
  assert.equal(done.price, 31.5);
  assert.equal(done.driver, null, 'po kursie pozycja kierowcy nie jest już udostępniana');
});

test('klient może anulować, ale nie w trakcie jazdy', async () => {
  const c = await (await post('/api/rides', { ...order, phone: '600 100 201' })).json();
  const r = await post(`/api/rides/${c.id}/cancel?token=${c.token}`, {});
  assert.equal((await r.json()).status, 'cancelled');
  assert.equal((await post(`/api/rides/${c.id}/cancel?token=${c.token}`, {})).status, 409);
});

test('złe hasło i path traversal', async () => {
  assert.equal((await post('/api/driver/login', { password: 'x' })).status, 401);
  assert.notEqual((await fetch(base + '/..%2fserver.js')).status, 200);
});
