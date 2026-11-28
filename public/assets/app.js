// Outils partagés par toutes les pages.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fc = (n) => `${Number(n || 0).toLocaleString('fr-FR')} FC`;
export const when = (s) => {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
export const PAY = { mpesa: 'M-Pesa', orange: 'Orange Money', airtel: 'Airtel Money', cash: 'Espèces au comptoir', cod: 'Payé à la livraison (ancien)', compte: 'Sur compte (facture)' };
export const PAY_STATE = { paye: 'Payé', en_attente: 'Paiement en attente', compte: 'Sur compte' };

export async function api(url, { method = 'GET', body, form } = {}) {
  const res = await fetch(url, {
    method,
    headers: body && !form ? { 'content-type': 'application/json' } : {},
    body: form || (body ? JSON.stringify(body) : undefined),
    credentials: 'same-origin'
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || 'Erreur'), { status: res.status });
  return data;
}

let toastTimer;
export function toast(msg, isError = false) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.toggle('err', isError); t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
// Exécute une action avec message d'erreur automatique.
export const run = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

export const badge = (status, label) => `<span class="badge b-${esc(status)}">${esc(label || status)}</span>`;

export function pills(container, options, value, onChange) {
  container.innerHTML = options.map(([v, l]) => `<button type="button" class="pill" data-v="${esc(v)}" aria-pressed="${v === value}">${esc(l)}</button>`).join('');
  container.onclick = (e) => {
    const b = e.target.closest('.pill'); if (!b) return;
    $$('.pill', container).forEach((x) => x.setAttribute('aria-pressed', x === b));
    onChange(b.dataset.v);
  };
}

export function fillCommunes(select, communes, placeholder = 'Choisir la commune') {
  select.innerHTML = `<option value="">${placeholder}</option>` + communes.map((c) => `<option>${esc(c.name)}</option>`).join('');
}

// Carte OpenStreetMap avec un point déplaçable (choix de l'adresse exacte).
export const KIN = [-4.325, 15.322];
export function mapPicker(el, onPick, start) {
  const map = L.map(el).setView(start || KIN, start ? 16 : 12);
  addTiles(map);
  let marker = null;
  const set = (lat, lng, zoom) => {
    if (!marker) {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); onPick(p.lat, p.lng); });
    } else marker.setLatLng([lat, lng]);
    if (zoom) map.setView([lat, lng], zoom);
    onPick(lat, lng);
  };
  map.on('click', (e) => set(e.latlng.lat, e.latlng.lng));
  if (start) set(start[0], start[1]);
  return {
    map, set,
    locate: () => new Promise((ok, ko) => {
      if (!navigator.geolocation) return ko(new Error('GPS non disponible sur cet appareil'));
      navigator.geolocation.getCurrentPosition((p) => { set(p.coords.latitude, p.coords.longitude, 17); ok(); },
        () => ko(new Error('Position GPS refusée ou introuvable')), { enableHighAccuracy: true, timeout: 15000 });
    })
  };
}

// Connexion : affiche le formulaire si nécessaire, renvoie l'utilisateur.
export async function requireLogin(roles, onReady) {
  const box = $('#login'); const app = $('#app');
  const show = (u) => { box.classList.add('hidden'); app.classList.remove('hidden'); onReady(u); };
  try {
    const { user } = await api('/api/me');
    if (roles.includes(user.role)) return show(user);
  } catch { /* pas connecté */ }
  box.classList.remove('hidden'); app.classList.add('hidden');
  $('form', box).onsubmit = run(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { user } = await api('/api/login', { method: 'POST', body: { phone: f.get('phone'), password: f.get('password') } });
    if (!roles.includes(user.role)) { await api('/api/logout', { method: 'POST' }); throw new Error('Ce compte n’a pas accès à cet espace'); }
    show(user);
  });
}
export const logout = run(async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });

export const loginHtml = (title) => `<div id="login" class="narrow hidden"><div class="card stack" style="margin-top:40px">
<h1>${esc(title)}</h1><form class="stack"><label class="f">Téléphone<input name="phone" type="tel" autocomplete="username" required></label>
<label class="f">Mot de passe<input name="password" type="password" autocomplete="current-password" required></label>
<button class="blue" type="submit">Se connecter</button></form></div></div>`;

// ---------- Carte « où sont les colis » (aide pour organiser les livreurs, sans effet sur le prix) ----------
export const HEAT = ['rgba(168,154,136,.18)', '#A87BEA', '#7B2FD0'];
export function heatMap(el, { refresh = 60000, onData } = {}) {
  const map = L.map(el, { zoomControl: true }).setView([-4.36, 15.33], 11);
  addTiles(map);
  const layer = L.layerGroup().addTo(map);
  const load = async () => {
    const d = await api('/api/heatmap');
    layer.clearLayers();
    for (const c of d.communes) {
      L.circle([c.lat, c.lng], {
        radius: c.level ? 1600 + c.level * 500 : 1300, stroke: c.level > 0, color: HEAT[c.level], weight: 2,
        fillColor: HEAT[c.level], fillOpacity: c.level ? 0.45 + c.level * 0.12 : 0.35
      }).addTo(layer).bindTooltip(`<strong>${esc(c.name)}</strong><br>${c.demand} colis · ${c.drivers} livreur(s)`);
      if (c.demand) L.marker([c.lat, c.lng], { interactive: false, icon: L.divIcon({ className: 'heat-label', html: String(c.demand), iconSize: [32, 20], iconAnchor: [16, 10] }) }).addTo(layer);
    }
    onData?.(d);
    return d;
  };
  load().catch(() => {});
  const t = refresh ? setInterval(() => load().catch(() => {}), refresh) : null;
  return { map, load, stop: () => clearInterval(t) };
}
export function heatLegend(d) {
  const busy = d.communes.filter((c) => c.level).sort((a, b) => b.level - a.level || b.demand - a.demand);
  return `<div class="heat-legend"><span><i style="background:${HEAT[0]}"></i>Calme</span><span><i style="background:${HEAT[1]}"></i>Chargé</span><span><i style="background:${HEAT[2]}"></i>Très chargé</span></div>
    <div class="small muted">${busy.length ? 'Envoyer des livreurs vers : ' + busy.slice(0, 4).map((c) => `<strong style="color:#F5EDE2">${esc(c.name)}</strong> (${c.demand} colis)`).join(', ') : 'Aucune commune chargée pour l’instant.'}</div>`;
}

/** Devis détaillé, ligne par ligne (les lignes sans montant sont des informations). */
export function quoteLines(q) {
  return q.lines.map((l) => l.fc == null
    ? `<div class="spread small muted"><span>${esc(l.label)}</span><span></span></div>`
    : `<div class="spread"><span>${esc(l.label)}</span><span>${fc(l.fc)}</span></div>`).join('');
}

// ---------- Fond de carte ----------
// Tuiles CARTO (Positron, rendu clair) : les serveurs bénévoles d'OpenStreetMap refusent les applis (erreur 403).
// La clé gratuite CARTO se règle dans Back office › Tarifs et réglages (gratuit jusqu'à 1 million de tuiles par mois).
let tileCfg;
export function addTiles(map, { dark = false } = {}) {
  tileCfg ??= api('/api/config').then((c) => c.map).catch(() => null);
  tileCfg.then((m) => {
    const key = m?.carto_key, style = dark ? 'dark_all' : 'light_all';
    const url = key
      ? `https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`
      : `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
    L.tileLayer(url, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>' }).addTo(map);
  });
}
