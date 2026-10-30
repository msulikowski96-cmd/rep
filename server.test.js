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

const j = (p, o = {}) => fetch(base + p, { headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, ...o });
const valid = { name: 'Anna', phone: '600 100 200', pickup: 'Długa 5', destination: 'Dworzec', passengers: 2, when: 'now' };

test('walidacja odrzuca złe dane', async () => {
  const r = await j('/api/orders', { method: 'POST', body: JSON.stringify({ ...valid, phone: 'abc' }) });
  assert.equal(r.status, 400);
});

test('pełny przepływ: zamówienie → panel → status', async () => {
  const created = await (await j('/api/orders', { method: 'POST', body: JSON.stringify(valid) })).json();
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.equal(created.phone, undefined, 'publiczny widok nie zdradza telefonu');

  assert.equal((await j('/api/admin/orders')).status, 401);
  const { token } = await (await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'sekret' }) })).json();
  const auth = { Authorization: 'Bearer ' + token };

  const all = await (await j('/api/admin/orders', { headers: auth })).json();
  assert.equal(all[0].phone, '600 100 200');

  const patched = await (await j('/api/admin/orders/' + all[0].id, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'confirmed', price: 25 }) })).json();
  assert.equal(patched.status, 'confirmed');

  const status = await (await j('/api/orders/' + created.code)).json();
  assert.equal(status.status, 'confirmed');
  assert.equal(status.price, 25);

  const cancelled = await (await j('/api/orders/' + created.code, { method: 'DELETE' })).json();
  assert.equal(cancelled.status, 'cancelled');
});

test('złe hasło i path traversal', async () => {
  assert.equal((await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'x' }) })).status, 401);
  const r = await fetch(base + '/..%2fserver.js');
  assert.notEqual(r.status, 200);
});
