'use strict';
let token = '';
try { token = sessionStorage.getItem('driverToken') || ''; } catch { /* brak */ }
let map, cfg, state = null, online = false;
let watchId = null, pos = null, presenceTimer = null, pollTimer = null, wakeLock = null;
const mk = { me: null, pickup: null, dest: null };
let routeLine = null, routeFor = null, focusId = null, knownPending = new Set(), firstState = true;

const call = (path, opts = {}) => api(path, { token, ...opts }).catch((e) => { if (e.status === 401) logout(); throw e; });
const sheet = () => $('sheet');

function logout() {
  token = ''; try { sessionStorage.removeItem('driverToken'); } catch { /* brak */ }
  clearInterval(pollTimer); setOnline(false, true); $('login').classList.remove('hidden');
}

function marker(key, p, cls) {
  if (mk[key]) { mk[key].remove(); mk[key] = null; }
  if (p) mk[key] = L.marker([p.lat, p.lng], { icon: icon(cls), interactive: false }).addTo(map);
}

// ---------- online / lokalizacja ----------
async function sendPresence() {
  try { await call('/api/driver/presence', { method: 'POST', body: { online, ...(pos || {}) } }); } catch { /* następna próba za 5 s */ }
}
async function setOnline(on, silent) {
  online = on;
  $('toggle').classList.toggle('on', on); $('toggleDot').classList.toggle('on', on);
  $('toggleText').textContent = on ? 'Online' : 'Offline';
  clearInterval(presenceTimer); if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (on) {
    unlockAudio();
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition((p) => {
        pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        $('gpsWarn').classList.add('hidden');
        if (!mk.me) map.setView([pos.lat, pos.lng], 15);
        marker('me', pos, 'me');
      }, () => $('gpsWarn').classList.remove('hidden'), { enableHighAccuracy: true, maximumAge: 5000 });
    } else $('gpsWarn').classList.remove('hidden');
    presenceTimer = setInterval(sendPresence, 5000);
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* nieobsługiwane */ }
  } else { marker('me', null); }
  if (!silent) await sendPresence();
  render();
}

// ---------- widok ----------
function setView(name) { for (const v of ['Idle', 'New', 'Active']) $('v' + v).classList.toggle('hidden', v !== name); }

async function showRoute(r) {
  if (routeFor === r.id) return;
  routeFor = r.id;
  marker('pickup', r.pickup, ''); marker('dest', r.destination, 'dest');
  if (routeLine) { routeLine.remove(); routeLine = null; }
  try {
    const q = await api('/api/quote', { method: 'POST', body: { from: r.pickup, to: r.destination } });
    if (routeFor !== r.id) return;
    routeLine = L.polyline(q.line, { color: '#14171c', weight: 5, opacity: 0.85 }).addTo(map);
  } catch { /* sama para pinezek wystarczy */ }
  const pts = [[r.pickup.lat, r.pickup.lng], [r.destination.lat, r.destination.lng]];
  if (pos) pts.push([pos.lat, pos.lng]);
  fit(map, pts, sheet());
}
function clearRoute() {
  routeFor = null; marker('pickup', null); marker('dest', null);
  if (routeLine) { routeLine.remove(); routeLine = null; }
}

const NEXT = {
  accepted: { label: 'Dojechałem na miejsce', action: 'arrived', sub: 'Jedź po klienta.' },
  arrived: { label: 'Rozpocznij kurs', action: 'start', sub: 'Czekasz na klienta.' },
  in_progress: { label: 'Zakończ kurs', action: 'complete', sub: 'Kurs w toku.' },
};

function render() {
  if (!state) return;
  const pending = state.pending, active = state.active;
  $('stCount').textContent = state.today.count; $('stTotal').textContent = money(state.today.total, cfg.tariff.currency);
  $('histBtn').classList.toggle('hidden', false);

  if (active) {
    setView('Active'); showRoute(active);
    const sched = active.status === 'accepted' && active.when !== 'now';
    $('aTitle').textContent = { accepted: 'Jedź po klienta', arrived: 'Jesteś na miejscu', in_progress: 'Kurs w toku' }[active.status];
    $('aSub').textContent = sched ? `Zaplanowany: ${fmtWhen(active.when)}` : NEXT[active.status].sub;
    $('aAvatar').textContent = active.name.slice(0, 1).toUpperCase(); $('aName').textContent = active.name;
    $('aMeta').textContent = `${active.passengers} os. · ${active.distanceKm} km`;
    $('aPrice').textContent = money(active.price, cfg.tariff.currency);
    $('aPickup').textContent = active.pickup.label; $('aDest').textContent = active.destination.label;
    $('aNotes').textContent = active.notes ? 'Uwagi: ' + active.notes : '';
    $('aCall').href = 'tel:' + active.phone.replace(/[^+\d]/g, '');
    const target = active.status === 'in_progress' ? active.destination : active.pickup;
    $('aNav').href = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${target.lat},${target.lng}`;
    $('stepBtn').textContent = NEXT[active.status].label;
    $('priceBox').classList.toggle('hidden', active.status !== 'in_progress');
    if (active.status === 'in_progress' && !$('finalPrice').value) $('finalPrice').value = active.price;
    $('cancelRide').classList.toggle('hidden', false);
    return;
  }

  if (online && pending.length) {
    const r = pending[0];
    setView('New'); showRoute(r);
    $('nPickup').textContent = r.pickup.label; $('nDest').textContent = r.destination.label;
    const toClient = pos ? ` · do klienta ${(haversineKm(pos, r.pickup) * 1.3).toFixed(1)} km` : '';
    $('nMeta').textContent = `${fmtWhen(r.when)} · ${r.distanceKm} km · ${r.durationMin} min · ${r.passengers} os.${toClient}`;
    $('nPrice').textContent = money(r.price, cfg.tariff.currency);
    $('nWho').textContent = r.name; $('nNotes').textContent = r.notes ? 'Uwagi: ' + r.notes : '';
    $('newMore').textContent = pending.length > 1 ? `+ ${pending.length - 1} kolejne czeka` : '';
    return;
  }

  clearRoute(); setView('Idle');
  $('idleTitle').textContent = online ? 'Czekam na zamówienia…' : 'Jesteś offline';
  $('idleSub').textContent = online ? 'Gdy ktoś zamówi, usłyszysz sygnał.' : (pending.length ? `Masz ${pending.length} oczekujące zamówienia – przejdź online.` : 'Przełącz się na online, aby odbierać zamówienia.');
  $('idleSub').classList.toggle('pulse', online);
  $('upcoming').replaceChildren(...state.upcoming.map((r) => h('div', { className: 'card' }, h('b', { textContent: fmtWhen(r.when) }), h('div', { className: 'small', textContent: `${shortAddr(r.pickup.label)} → ${shortAddr(r.destination.label)}` }))));
  $('hist').replaceChildren(...state.history.map((r) => h('li', {}, h('span', { textContent: `${new Date(r.updatedAt).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })} · ${shortAddr(r.destination.label)}` }), h('b', { textContent: r.status === 'completed' ? money(r.finalPrice ?? r.price) : { cancelled: 'anul.', rejected: 'odrz.' }[r.status] }))));
}

async function poll() {
  try {
    state = await call('/api/driver/state');
    const ids = new Set(state.pending.map((r) => r.id));
    if (online && !firstState && [...ids].some((id) => !knownPending.has(id))) { beep(); document.title = '🔔 Nowe zamówienie!'; setTimeout(() => (document.title = 'Taxi – kierowca'), 8000); }
    knownPending = ids; firstState = false;
    render();
  } catch { /* brak sieci – spróbuję za chwilę */ }
}

async function act(id, action, extra = {}) {
  show($('aErr'), '');
  try { await call('/api/driver/rides/' + id, { method: 'POST', body: { action, ...extra } }); $('finalPrice').value = ''; await poll(); }
  catch (e) { if (state && state.active) show($('aErr'), e.message); else alert(e.message); }
}

// ---------- start ----------
async function enter() {
  $('login').classList.add('hidden');
  cfg = cfg || await api('/api/config');
  map = map || makeMap(cfg.mapCenter);
  firstState = true; await poll();
  clearInterval(pollTimer); pollTimer = setInterval(poll, 3000);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); show($('loginErr'), '');
  try {
    const r = await api('/api/driver/login', { method: 'POST', body: { password: $('pw').value } });
    token = r.token; try { sessionStorage.setItem('driverToken', token); } catch { /* brak */ }
    $('pw').value = ''; await enter();
  } catch (err) { show($('loginErr'), err.message); }
});
$('logout').addEventListener('click', logout);
$('toggle').addEventListener('click', () => setOnline(!online));
$('acceptBtn').addEventListener('click', () => act(state.pending[0].id, 'accept'));
$('rejectBtn').addEventListener('click', () => { if (confirm('Odrzucić to zamówienie?')) act(state.pending[0].id, 'reject'); });
$('stepBtn').addEventListener('click', () => {
  const a = state.active, n = NEXT[a.status];
  act(a.id, n.action, n.action === 'complete' ? { finalPrice: $('finalPrice').value } : {});
});
$('cancelRide').addEventListener('click', () => { if (confirm('Anulować ten kurs?')) act(state.active.id, 'cancel'); });
$('histBtn').addEventListener('click', () => $('hist').classList.toggle('hidden'));
document.addEventListener('visibilitychange', async () => {
  if (online && !document.hidden) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* brak */ } poll(); }
});
if (token) enter().catch(logout);
