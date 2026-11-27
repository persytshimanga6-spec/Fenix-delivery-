// Prix « comme Uber » : distance + demande dans la zone + heure de pointe.
// Tout se règle dans Back office › Tarifs. Aucun service payant (pas de Google Maps).
import { db, setting } from './db.js';

const num = (k, d) => { const v = Number(setting(k, d)); return Number.isFinite(v) ? v : Number(d); };
export const SIZE_KM_FACTOR = { petit: 1, moyen: 1.25, grand: 1.6 };

export function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const ok = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && p.lat !== null && p.lng !== null;
const commune = (name) => db.prepare('SELECT name, lat, lng FROM communes WHERE name = ?').get(name);

/** Distance par la route (vol d'oiseau × détour moyen), en km. */
export function roadKm(from, to) {
  return Math.round(km(from, to) * num('road_factor', 1.35) * 10) / 10;
}

/** Point exact si connu, sinon centre de la commune (ou de l'agence de retrait). */
export function points(d) {
  let from = ok({ lat: d.from_lat, lng: d.from_lng }) ? { lat: +d.from_lat, lng: +d.from_lng } : commune(d.from_commune);
  let to = ok({ lat: d.to_lat, lng: d.to_lng }) ? { lat: +d.to_lat, lng: +d.to_lng } : null;
  if (!to && d.pickup_agency_id) {
    const a = db.prepare('SELECT lat, lng FROM agencies WHERE id = ?').get(d.pickup_agency_id);
    if (ok(a)) to = a;
  }
  if (!to) to = commune(d.to_commune);
  return { from: ok(from) ? from : null, to: ok(to) ? to : null };
}

// Heure de Kinshasa (UTC+1).
function kinHour(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kinshasa', hour: 'numeric', hourCycle: 'h23' }).format(now));
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kinshasa', weekday: 'short' }).format(now);
  return { h, weekend: day === 'Sun' };
}

/** Heure de pointe ? « 6-9,16-19 » = de 6 h à 9 h et de 16 h à 19 h (sauf dimanche). */
export function traffic(now = new Date()) {
  const pct = num('traffic_pct', 15);
  const { h, weekend } = kinHour(now);
  const on = !weekend && pct > 0 && String(setting('traffic_hours', '6-9,16-19')).split(',').some((r) => {
    const [a, b] = r.split('-').map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && h >= a && h < b;
  });
  return { on, pct: on ? pct : 0, hours: setting('traffic_hours', '6-9,16-19') };
}

/**
 * Carte des zones occupées : pour chaque commune, colis en attente ÷ livreurs présents.
 * level 0 = calme, 1 = occupé, 2 = très occupé.
 */
export function heatmap() {
  const communes = db.prepare('SELECT name, secteur, lat, lng FROM communes WHERE lat IS NOT NULL').all();
  const demand = Object.fromEntries(db.prepare(`SELECT c, COUNT(*) n FROM (
      SELECT from_commune c FROM shipments WHERE status = 'cree'
      UNION ALL SELECT to_commune FROM shipments WHERE status IN ('au_depot','en_livraison','echec') AND pickup_agency_id IS NULL
      UNION ALL SELECT from_commune FROM shipments WHERE created_at >= datetime('now','-2 hours') AND status != 'cree'
    ) GROUP BY c`).all().map((r) => [r.c, r.n]));
  const drivers = {};
  for (const d of db.prepare(`SELECT last_lat lat, last_lng lng FROM users WHERE role = 'livreur' AND active = 1
      AND last_lat IS NOT NULL AND last_seen >= datetime('now','-30 minutes')`).all()) {
    let best = null, bd = Infinity;
    for (const c of communes) { const x = km(d, c); if (x < bd) { bd = x; best = c.name; } }
    if (best) drivers[best] = (drivers[best] || 0) + 1;
  }
  const busy = num('busy_score', 3), very = num('very_busy_score', 6);
  const pcts = [0, num('busy_pct', 20), num('very_busy_pct', 40)];
  const on = setting('surge_on', '1') === '1';
  return communes.map((c) => {
    const n = demand[c.name] || 0, dr = drivers[c.name] || 0;
    const score = n / Math.max(1, dr);
    const level = !on ? 0 : score >= very ? 2 : score >= busy ? 1 : 0;
    return { name: c.name, secteur: c.secteur, lat: c.lat, lng: c.lng, demand: n, drivers: dr, level, pct: pcts[level] };
  });
}

/** Prix de la livraison seule (sans express, assurance, encaissement). */
export function deliveryPrice(d, zoneRate) {
  const lines = [];
  const mode = setting('pricing_mode', 'distance');
  const { from, to } = points(d);
  const dist = from && to ? roadKm(from, to) : null;
  let base;
  if (mode === 'distance' && dist != null) {
    const start = num(`base_${d.size}_fc`, { petit: 3000, moyen: 4000, grand: 6000 }[d.size]);
    const perKm = Math.ceil((dist * num('km_fc', 700) * SIZE_KM_FACTOR[d.size]) / 500) * 500;
    lines.push({ label: `Prise en charge · ${d.size}`, fc: start });
    lines.push({ label: `Distance ${dist.toLocaleString('fr-FR')} km`, fc: perKm });
    base = start + perKm;
  } else {
    lines.push({ label: `Zone ${d.zone} · ${d.size}`, fc: zoneRate });
    base = zoneRate;
  }
  // Demande dans la commune de ramassage + heure de pointe, plafonné.
  let surge = { pct: 0, level: 0, traffic: false };
  if (setting('surge_on', '1') === '1') {
    const z = heatmap().find((c) => c.name === d.from_commune) || { level: 0, pct: 0 };
    const t = traffic(d.now);
    const pct = Math.min(num('surge_max_pct', 50), z.pct + t.pct);
    surge = { pct, level: z.level, traffic: t.on };
    if (z.pct) lines.push({ label: `${z.level === 2 ? 'Très forte' : 'Forte'} demande à ${d.from_commune} +${z.pct} %`, fc: 0 });
    if (t.on) lines.push({ label: `Heure de pointe (embouteillages) +${t.pct} %`, fc: 0 });
    if (pct) {
      const extra = Math.ceil((base * pct) / 100 / 500) * 500;
      // Une seule ligne d'argent pour le supplément, les lignes du dessus l'expliquent.
      lines.filter((l) => l.fc === 0).forEach((l) => delete l.fc);
      lines.push({ label: `Supplément +${pct} %`, fc: extra });
    }
  }
  return { lines: lines.map((l) => ({ ...l, fc: l.fc ?? null })), distance_km: dist, surge, mode: mode === 'distance' && dist != null ? 'distance' : 'zone' };
}
