// Règles métier : prix, numéros de suivi, codes de livraison, statuts, SMS, argent.
import crypto from 'node:crypto';
import { db, setting } from './db.js';
import { deliveryPrice } from './pricing.js';

export const SIZES = ['petit', 'moyen', 'grand'];
export const PAY_METHODS = ['mpesa', 'orange', 'airtel', 'cash', 'compte'];
export const MOBILE = ['mpesa', 'orange', 'airtel'];

export const STATUS_LABELS = {
  cree: 'Envoi créé', ramasse: 'Colis ramassé', en_agence: 'Déposé en agence', au_depot: 'Trié au dépôt',
  en_livraison: 'En livraison', livre: 'Livré', echec: 'Échec de livraison', retour: 'Retourné à l’expéditeur',
  disponible_agence: 'Disponible en agence', retire: 'Retiré en agence', annule: 'Annulé'
};

// Qui peut faire passer un colis d'un statut à l'autre.
const FLOW = {
  cree: ['ramasse', 'en_agence', 'au_depot', 'annule'],
  ramasse: ['au_depot', 'en_livraison'],
  en_agence: ['ramasse', 'au_depot', 'disponible_agence'],
  au_depot: ['en_livraison', 'disponible_agence', 'retour'],
  en_livraison: ['livre', 'echec', 'disponible_agence'],
  echec: ['au_depot', 'en_livraison', 'retour'],
  disponible_agence: ['retire', 'retour'],
  livre: [], retire: [], retour: [], annule: []
};
export const canMove = (from, to) => (FLOW[from] || []).includes(to);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export function zoneBetween(fromCommune, toCommune) {
  if (!fromCommune || !toCommune) fail(400, 'Commune de départ et d’arrivée obligatoires');
  const a = db.prepare('SELECT secteur FROM communes WHERE name = ?').get(fromCommune);
  const b = db.prepare('SELECT secteur FROM communes WHERE name = ?').get(toCommune);
  if (!a || !b) fail(400, 'Commune inconnue');
  if (fromCommune === toCommune) return 1;
  return a.secteur === b.secteur ? 2 : 3;
}

export function quote(d) {
  const { from_commune, to_commune, size, express = false, insured = false } = d;
  const declared_value_fc = Number(d.declared_value_fc) || 0, cod_amount_fc = Number(d.cod_amount_fc) || 0;
  if (!SIZES.includes(size)) fail(400, 'Taille de colis invalide');
  const zone = zoneBetween(from_commune, to_commune); // sert au tri au dépôt, pas au prix
  const p = deliveryPrice(d);
  const lines = [...p.lines];
  if (express) lines.push({ label: 'Express (moins de 2 h)', fc: Number(setting('express_supplement_fc', 0)) });
  if (insured && declared_value_fc > 0) lines.push({ label: 'Assurance', fc: Math.ceil(declared_value_fc * Number(setting('insurance_pct', 0)) / 100) });
  const price_fc = lines.reduce((s, l) => s + (l.fc || 0), 0);
  return { zone, lines, price_fc, distance_km: p.distance_km, minutes: p.minutes, rush: p.rush };
}

export function newTracking() {
  const d = new Date();
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  for (;;) {
    const t = `FX-${mmdd}-${String(crypto.randomInt(0, 1e6)).padStart(6, '0')}`;
    if (!db.prepare('SELECT 1 FROM shipments WHERE tracking = ?').get(t)) return t;
  }
}

const otpHash = (tracking, otp) => crypto.createHash('sha256').update(`${tracking}:${otp}`).digest('hex');
export function newOtp(tracking) {
  const otp = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  return { otp, hash: otpHash(tracking, otp) };
}
export const checkOtp = (s, otp) => !!s.otp_hash && otpHash(s.tracking, String(otp || '').trim()) === s.otp_hash;

// SMS et e-mails : voir notify.js.
export { sendSms } from './notify.js';

export function addEvent(shipmentId, status, userId, note = null, lat = null, lng = null) {
  db.prepare('INSERT INTO events (shipment_id, status, note, user_id, lat, lng) VALUES (?, ?, ?, ?, ?, ?)')
    .run(shipmentId, status, note, userId ?? null, lat ?? null, lng ?? null);
}

export function shelfFor(s) {
  if (s.pickup_agency_id) {
    const a = db.prepare('SELECT name FROM agencies WHERE id = ?').get(s.pickup_agency_id);
    return `RETRAIT · ${String(a?.name || '?').toUpperCase()}`;
  }
  const c = db.prepare('SELECT secteur FROM communes WHERE name = ?').get(s.to_commune);
  return `${(c?.secteur || '?').toUpperCase()} · ${String(s.to_commune || '').toUpperCase()}`;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const publicUrl = () => process.env.PUBLIC_URL || 'http://localhost:3000';
