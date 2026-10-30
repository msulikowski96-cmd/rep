'use strict';
const STEPS = { searching: 1, accepted: 2, arrived: 3, in_progress: 4, completed: 4 };
let cfg, map, sheet;
let pickup = null, dest = null, quote = null;
let routeLine = null;
const mk = { pickup: null, dest: null, car: null };
let pollTimer = null, lastStatus = null, current = store('ride');

function setMarker(key, p, cls) {
  if (mk[key]) mk[key].remove();
  mk[key] = p ? L.marker([p.lat, p.lng], { icon: icon(cls), interactive: false }).addTo(map) : null;
}
function setRoute(line) {
  if (routeLine) routeLine.remove();
  routeLine = line ? L.polyline(line, { color: '#14171c', weight: 5, opacity: 0.85 }).addTo(map) : null;
}
function view(name) {
  $('vPlan').classList.toggle('hidden', name !== 'plan');
  $('vRide').classList.toggle('hidden', name !== 'ride');
}

// ---------- planowanie ----------
async function refreshQuote() {
  show($('planErr'), '');
  setMarker('pickup', pickup, '');
  setMarker('dest', dest, 'dest');
  quote = null; setRoute(null);
  $('orderBox').classList.toggle('hidden', !(pickup && dest));
  if (!pickup || !dest) {
    if (pickup) map.setView([pickup.lat, pickup.lng], 15);
    return;
  }
  $('quotePrice').textContent = '…'; $('quoteMeta').textContent = 'Liczę trasę…'; $('orderBtn').disabled = true;
  try {
    quote = await api('/api/quote', { method: 'POST', body: { from: pickup, to: dest } });
    $('quotePrice').textContent = money(quote.price, cfg.tariff.currency);
    $('quoteMeta').textContent = `${quote.distanceKm} km · ok. ${quote.durationMin} min`;
    $('quoteNote').textContent = quote.approx ? 'Trasa przybliżona' : cfg.tariff.note;
    $('orderBtn').textContent = `Zamów taxi · ${money(quote.price, cfg.tariff.currency)}`;
    $('orderBtn').disabled = false;
    setRoute(quote.line);
    fit(map, [[pickup.lat, pickup.lng], [dest.lat, dest.lng]], sheet);
  } catch (e) { show($('planErr'), e.message); }
}

function useGps() {
  if (!navigator.geolocation) return show($('planErr'), 'Ta przeglądarka nie udostępnia lokalizacji.');
  $('pickup').placeholder = 'Szukam lokalizacji…';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    let label = 'Moja lokalizacja';
    try { label = (await api(`/api/reverse?lat=${p.lat}&lng=${p.lng}`)).label; } catch { /* zostaje domyślna */ }
    pickup = { ...p, label }; $('pickup').value = label; $('pickup').placeholder = 'Skąd? (adres odbioru)';
    refreshQuote();
  }, () => { $('pickup').placeholder = 'Skąd? (adres odbioru)'; show($('planErr'), 'Nie mam dostępu do lokalizacji – wpisz adres odbioru.'); }, { enableHighAccuracy: true, timeout: 10000 });
}

async function placeOrder() {
  if (!quote) return;
  const later = $('timing').value === 'later';
  if (later && !$('when').value) return show($('planErr'), 'Wybierz datę i godzinę odbioru.');
  $('orderBtn').disabled = true; show($('planErr'), '');
  const name = $('name').value, phone = $('phone').value;
  try {
    const r = await api('/api/rides', { method: 'POST', body: { pickup, destination: dest, name, phone, passengers: Number($('passengers').value), notes: $('notes').value, when: later ? new Date($('when').value).toISOString() : 'now' } });
    store('profile', { name, phone });
    current = { id: r.id, token: r.token }; store('ride', current);
    lastStatus = null; renderRide(r); startPolling();
  } catch (e) { show($('planErr'), e.message); $('orderBtn').disabled = false; }
}

// ---------- zamówienie w toku ----------
function renderRide(r) {
  view('ride');
  const changed = lastStatus && lastStatus !== r.status;
  lastStatus = r.status;
  if (changed && navigator.vibrate) navigator.vibrate(200);
  const n = STEPS[r.status] || 0;
  [...$('steps').children].forEach((el, i) => el.classList.toggle('on', i < n));
  const sched = r.when !== 'now';
  const T = {
    searching: ['Czekam na kierowcę…', r.driverOnline ? 'Kierowca dostał Twoje zamówienie.' : 'Kierowca jest teraz offline – zamówienie czeka i odpowie po powrocie online.'],
    accepted: [sched ? 'Zamówienie potwierdzone' : 'Kierowca jedzie do Ciebie', sched ? `Odbiór: ${fmtWhen(r.when)}` : ''],
    arrived: ['Kierowca czeka na miejscu', 'Wyjdź do pojazdu.'],
    in_progress: ['W drodze do celu', `Cel: ${shortAddr(r.destination.label)}`],
    completed: ['Dojechaliśmy!', 'Dziękuję za wspólną podróż.'],
    cancelled: ['Zamówienie anulowane', ''],
    rejected: ['Kierowca nie może przyjąć tego kursu', 'Spróbuj ponownie lub zadzwoń.'],
  }[r.status];
  $('rideTitle').textContent = T[0]; $('rideSub').textContent = T[1];
  $('rideSub').classList.toggle('pulse', r.status === 'searching');
  $('rPickup').textContent = r.pickup.label; $('rDest').textContent = r.destination.label;
  $('rMeta').textContent = `${r.distanceKm} km · ${r.passengers} os. · #${r.code}`;
  $('rPrice').textContent = money(r.price, cfg.tariff.currency);

  const d = r.driver;
  $('driverCard').classList.toggle('hidden', !d);
  if (d) {
    $('drvAvatar').textContent = d.name.slice(0, 1).toUpperCase(); $('drvName').textContent = d.name;
    $('drvCar').textContent = d.car; $('drvPlate').textContent = d.plate;
    $('drvCall').href = 'tel:' + d.phone.replace(/[^+\d]/g, '');
    if (d.lat != null) {
      const eta = r.status === 'accepted' && !sched ? Math.max(1, Math.round((haversineKm(d, r.pickup) * 1.3 / 30) * 60)) : null;
      if (eta) $('rideSub').textContent = `Będzie za ok. ${eta} min`;
      if (mk.car) mk.car.setLatLng([d.lat, d.lng]); else mk.car = L.marker([d.lat, d.lng], { icon: icon('car', '🚕'), interactive: false }).addTo(map);
    }
  } else if (mk.car) { mk.car.remove(); mk.car = null; }

  const done = ['completed', 'cancelled', 'rejected'].includes(r.status);
  $('cancelBtn').classList.toggle('hidden', !['searching', 'accepted', 'arrived'].includes(r.status));
  $('againBtn').classList.toggle('hidden', !done);
  setMarker('pickup', r.pickup, ''); setMarker('dest', r.destination, 'dest');
  if (!renderRide.fitted) { fit(map, [[r.pickup.lat, r.pickup.lng], [r.destination.lat, r.destination.lng]], sheet); renderRide.fitted = true; }
  if (done) { clearInterval(pollTimer); store('ride', null); current = null; }
}

async function poll() {
  if (!current) return;
  try { renderRide(await api(`/api/rides/${current.id}?token=${current.token}`)); show($('rideErr'), ''); }
  catch (e) {
    if (e.status === 404) { store('ride', null); current = null; clearInterval(pollTimer); reset(); }
    else show($('rideErr'), 'Brak połączenia – próbuję ponownie…');
  }
}
function startPolling() { clearInterval(pollTimer); renderRide.fitted = false; pollTimer = setInterval(poll, 3000); }

function reset() {
  pickup = dest = quote = null; $('dest').value = '';
  setMarker('pickup', null); setMarker('dest', null); setRoute(null);
  if (mk.car) { mk.car.remove(); mk.car = null; }
  $('orderBox').classList.add('hidden'); view('plan'); lastStatus = null;
  useGps();
}

// ---------- start ----------
(async function init() {
  cfg = await api('/api/config');
  document.title = `Zamów taxi – ${cfg.businessName}`;
  $('biz').textContent = '🚕 ' + cfg.businessName;
  $('callBtn').href = 'tel:' + cfg.phone.replace(/[^+\d]/g, '');
  for (let i = 1; i <= cfg.maxPassengers; i++) $('passengers').add(new Option(String(i), String(i)));
  $('onlineInfo').textContent = cfg.driverOnline ? '🟢 Kierowca jest online' : '⚪ Kierowca jest teraz offline – możesz złożyć zamówienie, odpowie po powrocie.';
  sheet = $('sheet');
  map = makeMap(cfg.mapCenter);

  const p = store('profile'); if (p) { $('name').value = p.name || ''; $('phone').value = p.phone || ''; }
  const pad = (n) => String(n).padStart(2, '0'), d = new Date(Date.now() + 30 * 60_000);
  $('when').min = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('timing').addEventListener('change', () => $('whenBox').classList.toggle('hidden', $('timing').value !== 'later'));

  attachSearch($('pickup'), $('pickupList'), (pt) => { pickup = pt; refreshQuote(); });
  attachSearch($('dest'), $('destList'), (pt) => { dest = pt; refreshQuote(); });
  $('pickup').addEventListener('input', () => { pickup = null; });
  $('dest').addEventListener('input', () => { dest = null; $('orderBox').classList.add('hidden'); });
  $('gpsBtn').addEventListener('click', useGps);
  $('orderBtn').addEventListener('click', placeOrder);
  $('cancelBtn').addEventListener('click', async () => {
    if (!confirm('Na pewno anulować zamówienie?')) return;
    try { renderRide(await api(`/api/rides/${current.id}/cancel?token=${current.token}`, { method: 'POST' })); }
    catch (e) { show($('rideErr'), e.message); }
  });
  $('againBtn').addEventListener('click', reset);

  if (current) { view('ride'); poll(); startPolling(); } else useGps();
})().catch((e) => show($('planErr'), 'Nie udało się załadować aplikacji: ' + e.message));
