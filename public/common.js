'use strict';
const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};
const fmtWhen = (w) => (w === 'now' ? 'Jak najszybciej' : new Date(w).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }));
const money = (v, cur = 'zł') => `${Number(v).toFixed(v % 1 ? 2 : 0)} ${cur}`;
const shortAddr = (s) => (s || '').split(',').slice(0, 2).join(',').trim();

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Coś poszło nie tak.'), { status: res.status });
  return data;
}

function show(el, text) { el.textContent = text || ''; el.classList.toggle('hidden', !text); }
function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch { return null; } }

function haversineKm(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

// --- mapa ---
function makeMap(center) {
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(center, 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  return map;
}
const icon = (cls, html = '') => L.divIcon({ className: '', html: `<div class="mk ${cls}">${html}</div>`, iconSize: cls === 'car' ? [38, 38] : [18, 18], iconAnchor: cls === 'car' ? [19, 19] : [9, 9] });
function fit(map, points, sheet) {
  if (!points.length) return;
  map.fitBounds(L.latLngBounds(points), { paddingTopLeft: [30, 70], paddingBottomRight: [30, (sheet ? sheet.offsetHeight : 0) + 30], maxZoom: 16 });
}

// --- podpowiedzi adresów ---
function attachSearch(input, list, onPick) {
  let timer, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 3) return list.classList.add('hidden');
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const res = await api('/api/geocode?q=' + encodeURIComponent(text));
        if (mine !== seq) return;
        list.replaceChildren(...res.map((r) => {
          const b = h('button', { type: 'button', textContent: r.label });
          b.addEventListener('click', () => { list.classList.add('hidden'); input.value = shortAddr(r.label); onPick({ lat: r.lat, lng: r.lng, label: shortAddr(r.label) }); });
          return b;
        }));
        if (!res.length) list.replaceChildren(h('button', { type: 'button', disabled: true, textContent: 'Nic nie znaleziono' }));
        list.classList.remove('hidden');
      } catch { list.classList.add('hidden'); }
    }, 450);
  });
  document.addEventListener('click', (e) => { if (!list.contains(e.target) && e.target !== input) list.classList.add('hidden'); });
}

// --- sygnał dźwiękowy ---
let audio;
function unlockAudio() { try { audio = audio || new AudioContext(); if (audio.state === 'suspended') audio.resume(); } catch { /* brak */ } }
function beep(times = 3) {
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  if (!audio) return;
  for (let i = 0; i < times; i++) {
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.35;
    o.frequency.value = i % 2 ? 660 : 880; g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.3);
  }
}
