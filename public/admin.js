'use strict';
const $ = (id) => document.getElementById(id);
const STATUS = { new: 'Nowe', confirmed: 'Potwierdzone', completed: 'Zrealizowane', rejected: 'Odrzucone', cancelled: 'Anulowane' };
const FILTERS = [['active', 'Do obsługi'], ['all', 'Wszystkie'], ...Object.entries(STATUS)];
let token = '';
try { token = sessionStorage.getItem('adminToken') || ''; } catch {}
let orders = [];
let filter = 'active';
let currency = 'zł';
let editing = false;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) logout();
  if (!res.ok) throw new Error(data.error || 'Błąd');
  return data;
}

function logout() {
  token = '';
  try { sessionStorage.removeItem('adminToken'); } catch {}
  $('panel').classList.add('hidden');
  $('logout').classList.add('hidden');
  $('loginCard').classList.remove('hidden');
}

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

function fmtWhen(w) {
  return w === 'now' ? 'Jak najszybciej' : new Date(w).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
}

function card(o) {
  const price = el('input', { type: 'number', min: '0', step: '0.5', placeholder: `Cena (${currency})`, value: o.price ?? '', ariaLabel: 'Cena' });
  const note = el('input', { className: 'note', maxLength: 300, placeholder: 'Wiadomość do klienta', value: o.driverNote || '', ariaLabel: 'Wiadomość do klienta' });
  [price, note].forEach((i) => { i.addEventListener('focus', () => (editing = true)); i.addEventListener('blur', () => (editing = false)); });
  const act = (label, status, cls = '') => {
    const b = el('button', { type: 'button', className: cls, textContent: label });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('/api/admin/orders/' + o.id, { method: 'PATCH', body: JSON.stringify({ status, price: price.value, driverNote: note.value }) });
        editing = false; await load();
      } catch (e) { alert(e.message); b.disabled = false; }
    });
    return b;
  };
  const actions = el('div', { className: 'actions' }, price, note);
  if (o.status === 'new') actions.append(act('Potwierdź', 'confirmed', 'good'), act('Odrzuć', 'rejected', 'danger'));
  else if (o.status === 'confirmed') actions.append(act('Zrealizowane', 'completed', 'good'), act('Zapisz', 'confirmed', 'ghost'), act('Anuluj', 'cancelled', 'danger'));
  else actions.append(act('Zapisz', o.status, 'ghost'));

  const tel = el('a', { href: 'tel:' + o.phone.replace(/[^+\d]/g, ''), textContent: o.phone });
  return el('article', { className: 'card order' },
    el('div', { className: 'head' },
      el('strong', { textContent: `#${o.code} · ${fmtWhen(o.when)}` }),
      el('span', { className: 'badge ' + o.status, textContent: STATUS[o.status] })),
    el('div', { className: 'route', textContent: `${o.pickup} → ${o.destination}` }),
    el('div', { className: 'meta' }, `${o.name}, `, tel, ` · ${o.passengers} os.`),
    ...(o.notes ? [el('div', { className: 'meta', textContent: 'Uwagi: ' + o.notes })] : []),
    actions);
}

function render() {
  const list = $('list');
  const shown = orders.filter((o) => filter === 'all' || (filter === 'active' ? ['new', 'confirmed'].includes(o.status) : o.status === filter));
  if (filter === 'active') shown.sort((a, b) => (a.when === 'now' ? 0 : Date.parse(a.when)) - (b.when === 'now' ? 0 : Date.parse(b.when)));
  list.replaceChildren(...(shown.length ? shown.map(card) : [el('p', { className: 'hint', textContent: 'Brak zamówień.' })]));
  const f = $('filters');
  f.replaceChildren(...FILTERS.map(([k, label]) => {
    const n = k === 'all' ? orders.length : k === 'active' ? orders.filter((o) => ['new', 'confirmed'].includes(o.status)).length : orders.filter((o) => o.status === k).length;
    const b = el('button', { type: 'button', className: 'ghost', textContent: `${label} (${n})` });
    b.setAttribute('aria-pressed', String(k === filter));
    b.addEventListener('click', () => { filter = k; render(); });
    return b;
  }));
}

async function load() {
  orders = await api('/api/admin/orders');
  render();
}

async function enter() {
  $('loginCard').classList.add('hidden');
  $('panel').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  try { currency = (await (await fetch('/api/config')).json()).tariff.currency; } catch {}
  await load();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginErr');
  err.classList.add('hidden');
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    token = d.token;
    try { sessionStorage.setItem('adminToken', token); } catch {}
    $('pw').value = '';
    await enter();
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
});
$('logout').addEventListener('click', logout);

setInterval(() => { if (token && !editing && !document.hidden) load().catch(() => {}); }, 15000);
if (token) enter().catch(logout);
