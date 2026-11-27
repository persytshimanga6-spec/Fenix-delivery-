// Prix calculé pour chaque trajet : prise en charge + carburant + temps de trajet.
// Pas de supplément en % : à l'heure de pointe, le trajet est simplement plus long.
// Tous les chiffres se règlent dans Back office › Tarifs et réglages.
import { db, setting } from './db.js';
import { fail } from './logic.js';

const num = (k, d) => { const v = Number(setting(k, d)); return Number.isFinite(v) ? v : Number(d); };
const up100 = (x) => Math.ceil(x / 100) * 100;

export function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const ok = (p) => p && p.lat !== null && p.lng !== null && p.lat !== undefined && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
const commune = (name) => db.prepare('SELECT name, lat, lng FROM communes WHERE name = ?').get(name);

/** Distance par la route (vol d'oiseau × détour moyen), en km, au dixième. */
export function roadKm(from, to) {
  return Math.max(0.5, Math.round(km(from, to) * num('road_factor', 1.35) * 10) / 10);
}

/** Point exact si connu, sinon centre de la commune (ou l'agence de retrait). */
export function points(d) {
  const from = ok({ lat: d.from_lat, lng: d.from_lng }) ? { lat: +d.from_lat, lng: +d.from_lng } : commune(d.from_commune);
  let to = ok({ lat: d.to_lat, lng: d.to_lng }) ? { lat: +d.to_lat, lng: +d.to_lng } : null;
  if (!to && d.pickup_agency_id) {
    const a = db.prepare('SELECT lat, lng FROM agencies WHERE id = ?').get(d.pickup_agency_id);
    if (ok(a)) to = a;
  }
  if (!to) to = commune(d.to_commune);
  return { from: ok(from) ? from : null, to: ok(to) ? to : null };
}

/** Heure de pointe à Kinshasa (UTC+1) ? « 6-9,16-19 », sauf le dimanche. */
export function rushHour(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kinshasa', hour: 'numeric', hourCycle: 'h23' }).format(now));
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kinshasa', weekday: 'short' }).format(now);
  if (day === 'Sun') return false;
  return String(setting('rush_hours', '6-9,16-19')).split(',').some((r) => {
    const [a, b] = r.split('-').map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && h >= a && h < b;
  });
}

/** Prix de la course (sans express ni assurance), ligne par ligne. */
export function deliveryPrice(d) {
  const { from, to } = points(d);
  if (!from || !to) fail(400, 'Position de départ ou d’arrivée inconnue');
  const dist = roadKm(from, to);
  const rush = rushHour(d.now);
  const speed = rush ? num('speed_rush_kmh', 18) : num('speed_normal_kmh', 30);
  const minutes = Math.max(1, Math.round((dist / Math.max(1, speed)) * 60));
  const base = num(`base_${d.size}_fc`, { petit: 3000, moyen: 4000, grand: 6000 }[d.size]);
  const liters = dist * num('fuel_l_per_km', 0.03);
  const fuel = up100(liters * num('fuel_price_fc', 2640));
  const time = up100(minutes * num('minute_fc', 100));
  return {
    distance_km: dist, minutes, rush,
    lines: [
      { label: `Prise en charge · ${d.size}`, fc: base, key: 'base' },
      { label: `Distance : ${dist.toLocaleString('fr-FR')} km`, fc: null, key: 'distance' },
      { label: `Carburant (${liters.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} L)`, fc: fuel, key: 'fuel' },
      { label: `Trafic : environ ${minutes} min${rush ? ' (heure de pointe)' : ''}`, fc: time, key: 'time' }
    ]
  };
}

/**
 * Carte « où sont les colis » pour organiser les livreurs : colis en attente par commune et livreurs présents.
 * level 0 = calme, 1 = chargé, 2 = très chargé. Aucun effet sur le prix.
 */
export function heatmap() {
  const communes = db.prepare('SELECT name, secteur, lat, lng FROM communes WHERE lat IS NOT NULL').all();
  const demand = Object.fromEntries(db.prepare(`SELECT c, COUNT(*) n FROM (
      SELECT from_commune c FROM shipments WHERE status = 'cree' AND COALESCE(payment_status, 'paye') != 'en_attente'
      UNION ALL SELECT to_commune FROM shipments WHERE status IN ('au_depot','en_livraison','echec') AND pickup_agency_id IS NULL
    ) GROUP BY c`).all().map((r) => [r.c, r.n]));
  const drivers = {};
  for (const d of db.prepare(`SELECT last_lat lat, last_lng lng FROM users WHERE role = 'livreur' AND active = 1
      AND last_lat IS NOT NULL AND last_seen >= datetime('now','-30 minutes')`).all()) {
    let best = null, bd = Infinity;
    for (const c of communes) { const x = km(d, c); if (x < bd) { bd = x; best = c.name; } }
    if (best) drivers[best] = (drivers[best] || 0) + 1;
  }
  return communes.map((c) => {
    const n = demand[c.name] || 0, dr = drivers[c.name] || 0;
    const score = n / Math.max(1, dr);
    return { name: c.name, secteur: c.secteur, lat: c.lat, lng: c.lng, demand: n, drivers: dr, level: score >= 6 ? 2 : score >= 3 ? 1 : 0 };
  });
}

/**
 * Devis montré au client : le carburant et le trafic restent dans le calcul, mais ils sont regroupés
 * dans la ligne « Distance » (ce n'est pas la faute du client s'il y a des embouteillages).
 * Les lignes visibles s'additionnent toujours pour donner le total. Le détail complet reste pour le personnel.
 */
export function clientQuote(q) {
  const hidden = q.lines.filter((l) => l.key === 'fuel' || l.key === 'time').reduce((t, l) => t + (l.fc || 0), 0);
  const lines = q.lines.filter((l) => l.key !== 'fuel' && l.key !== 'time')
    .map((l) => (l.key === 'distance' ? { ...l, fc: hidden } : l))
    .map(({ key, ...l }) => l);
  const { minutes, rush, ...rest } = q;
  return { ...rest, lines };
}
