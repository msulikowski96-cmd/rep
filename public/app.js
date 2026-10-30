'use strict';
const $ = (id) => document.getElementById(id);
const STATUS = {
  new: 'Oczekuje na potwierdzenie',
  confirmed: 'Potwierdzone – kierowca jedzie do Ciebie',
  completed: 'Zrealizowane',
  rejected: 'Odrzucone',
  cancelled: 'Anulowane',
};

function fmtWhen(w) {
  return w === 'now' ? 'Jak najszybciej' : new Date(w).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
}

function show(el, text) {
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Coś poszło nie tak.');
  return data;
}

function row(dl, k, v) {
  const dt = document.createElement('dt'); dt.textContent = k;
  const dd = document.createElement('dd'); dd.textContent = v;
  dl.append(dt, dd);
}

function renderStatus(o, currency) {
  const box = $('lookupResult');
  box.replaceChildren();
  const badge = document.createElement('span');
  badge.className = 'badge ' + o.status;
  badge.textContent = STATUS[o.status] || o.status;
  const dl = document.createElement('dl');
  row(dl, 'Kod', o.code);
  row(dl, 'Odbiór', o.pickup);
  row(dl, 'Cel', o.destination);
  row(dl, 'Termin', fmtWhen(o.when));
  if (o.price != null) row(dl, 'Cena', `${o.price.toFixed(2)} ${currency}`);
  if (o.driverNote) row(dl, 'Wiadomość', o.driverNote);
  box.append(badge, dl);
  if (['new', 'confirmed'].includes(o.status)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ghost full'; b.textContent = 'Anuluj zamówienie';
    b.addEventListener('click', async () => {
      if (!confirm('Na pewno anulować to zamówienie?')) return;
      try { renderStatus(await api('/api/orders/' + o.code, { method: 'DELETE' }), currency); }
      catch (e) { show($('lookupErr'), e.message); }
    });
    box.append(b);
  }
  box.classList.remove('hidden');
}

(async function init() {
  const cfg = await api('/api/config');
  document.title = `Zamów taxi – ${cfg.businessName}`;
  $('biz').textContent = cfg.businessName;
  $('callBtn').href = 'tel:' + cfg.phone.replace(/[^+\d]/g, '');
  $('callBtn').textContent = '📞 ' + cfg.phone;
  const t = cfg.tariff;
  const tariff = $('tariff');
  const mk = (label, val) => { const s = document.createElement('span'); s.append(label + ': '); const b = document.createElement('b'); b.textContent = val; s.append(b); return s; };
  tariff.append(mk('Opłata startowa', `${t.baseFare} ${t.currency}`), mk('Za km', `${t.perKm} ${t.currency}`));
  const note = document.createElement('p'); note.className = 'hint'; note.textContent = t.note;
  tariff.after(note);
  for (let i = 1; i <= cfg.maxPassengers; i++) $('passengers').add(new Option(String(i), String(i)));

  document.querySelectorAll('input[name=timing]').forEach((r) =>
    r.addEventListener('change', () => $('whenBox').classList.toggle('hidden', r.value !== 'later' || !r.checked)));
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(Date.now() + 30 * 60_000);
  $('when').min = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  $('orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    show($('formErr'), '');
    const later = document.querySelector('input[name=timing]:checked').value === 'later';
    if (later && !$('when').value) return show($('formErr'), 'Wybierz datę i godzinę odbioru.');
    const body = {
      name: $('name').value, phone: $('phone').value, pickup: $('pickup').value,
      destination: $('destination').value, passengers: $('passengers').value, notes: $('notes').value,
      when: later ? new Date($('when').value).toISOString() : 'now',
    };
    $('submitBtn').disabled = true;
    try {
      const o = await api('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      try { localStorage.setItem('lastOrderCode', o.code); } catch {}
      $('doneCode').textContent = o.code;
      $('formCard').classList.add('hidden');
      $('doneCard').classList.remove('hidden');
      $('lookupCode').value = o.code;
      renderStatus(o, cfg.tariff.currency);
      $('doneCard').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      show($('formErr'), err.message);
    } finally {
      $('submitBtn').disabled = false;
    }
  });

  $('againBtn').addEventListener('click', () => {
    $('orderForm').reset();
    $('whenBox').classList.add('hidden');
    $('doneCard').classList.add('hidden');
    $('formCard').classList.remove('hidden');
  });

  async function lookup(code) {
    show($('lookupErr'), '');
    $('lookupResult').classList.add('hidden');
    try { renderStatus(await api('/api/orders/' + encodeURIComponent(code)), cfg.tariff.currency); }
    catch (err) { show($('lookupErr'), err.message); }
  }
  $('lookupForm').addEventListener('submit', (e) => { e.preventDefault(); lookup($('lookupCode').value.trim().toUpperCase()); });

  try {
    const last = localStorage.getItem('lastOrderCode');
    if (last) { $('lookupCode').value = last; lookup(last); }
  } catch {}
})().catch((e) => { const m = $('formErr'); show(m, 'Nie udało się załadować aplikacji: ' + e.message); });
