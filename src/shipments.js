// Opérations sur les colis, partagées par le site, l'appli livreur, l'agence et le back office.
import { db, tx, setting } from './db.js';
import {
  quote, newTracking, newOtp, checkOtp, addEvent, canMove, fail, shelfFor,
  SIZES, MOBILE, STATUS_LABELS, publicUrl
} from './logic.js';
import { normPhone } from './auth.js';
import { notifyShipment, isEmail } from './notify.js';

const email = (v) => (isEmail(v) ? String(v).trim().toLowerCase().slice(0, 120) : null);

const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const int = (v) => Math.max(0, Math.round(Number(v) || 0));

export const getByTracking = (t) => db.prepare('SELECT * FROM shipments WHERE tracking = ?').get(String(t || '').trim().toUpperCase());
export const mustGet = (t) => getByTracking(t) || fail(404, 'Colis introuvable');

/**
 * Crée un envoi. `actor` = utilisateur connecté. `ctx.agency` = créé au comptoir d'une agence.
 * pay_method : compte (facturé au commerçant) | cod (le destinataire paie le port)
 *              | cash, mpesa, orange, airtel (payé tout de suite, au comptoir).
 */
export async function createShipment(input, actor, ctx = {}) {
  const d = {
    sender_name: str(input.sender_name), sender_phone: normPhone(input.sender_phone),
    from_commune: str(input.from_commune), from_landmark: str(input.from_landmark, 300),
    from_lat: num(input.from_lat), from_lng: num(input.from_lng),
    recipient_name: str(input.recipient_name), recipient_phone: normPhone(input.recipient_phone),
    recipient_email: email(input.recipient_email), sender_email: email(input.sender_email),
    to_commune: str(input.to_commune), to_landmark: str(input.to_landmark, 300),
    to_lat: num(input.to_lat), to_lng: num(input.to_lng),
    size: str(input.size), weight_kg: num(input.weight_kg), description: str(input.description, 300),
    declared_value_fc: int(input.declared_value_fc), insured: input.insured ? 1 : 0, express: input.express ? 1 : 0,
    cod_amount_fc: int(input.cod_amount_fc), pay_method: str(input.pay_method) || 'cod',
    pickup_agency_id: num(input.pickup_agency_id)
  };

  // Un commerçant envoie toujours depuis sa boutique.
  if (actor.role === 'commercant') {
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(actor.merchant_id);
    if (!m || m.status !== 'actif') fail(403, 'Votre compte commerçant n’est pas encore validé');
    Object.assign(d, {
      sender_name: m.name, sender_phone: m.phone, sender_email: m.email || null, from_commune: m.commune, from_landmark: m.landmark,
      from_lat: m.lat, from_lng: m.lng
    });
    if (!['compte', 'cod'].includes(d.pay_method)) fail(400, 'Paiement : « compte » ou « cod » pour un commerçant');
    d.merchant_id = m.id;
  } else {
    d.merchant_id = num(input.merchant_id);
    if (d.cod_amount_fc > 0 && !d.merchant_id) fail(400, 'L’encaissement de marchandise est réservé aux commerçants');
  }
  if (ctx.agency) {
    d.agency_id = ctx.agency.id;
    if (!d.from_commune) d.from_commune = ctx.agency.commune;
    if (!d.from_landmark) d.from_landmark = ctx.agency.name;
    if (d.from_lat == null) { d.from_lat = ctx.agency.lat; d.from_lng = ctx.agency.lng; }
    if (d.pay_method === 'compte') fail(400, 'Au comptoir : payé tout de suite ou payé à la livraison');
  } else if (['cash', ...MOBILE].includes(d.pay_method) && actor.role !== 'admin') {
    fail(400, 'Ce mode de paiement se fait au comptoir d’une agence');
  }

  for (const [k, label] of [['sender_name', 'Nom de l’expéditeur'], ['sender_phone', 'Téléphone de l’expéditeur'],
    ['recipient_name', 'Nom du destinataire'], ['recipient_phone', 'Téléphone du destinataire'], ['to_commune', 'Commune d’arrivée']]) {
    if (!d[k]) fail(400, `${label} obligatoire`);
  }
  if (!d.pickup_agency_id && !d.to_landmark) fail(400, 'Le repère du destinataire est obligatoire');
  if (!d.pickup_agency_id && (d.to_lat == null || d.to_lng == null)) fail(400, 'Placez le point de livraison sur la carte');
  if (!SIZES.includes(d.size)) fail(400, 'Taille de colis invalide');
  if (d.pickup_agency_id && !db.prepare('SELECT 1 FROM agencies WHERE id = ? AND active = 1').get(d.pickup_agency_id)) fail(400, 'Agence de retrait inconnue');

  const q = quote(d);
  const tracking = newTracking();
  const { otp, hash } = newOtp(tracking);
  const paidNow = ['cash', ...MOBILE].includes(d.pay_method);

  const id = tx(() => {
    const r = db.prepare(`INSERT INTO shipments (tracking, merchant_id, agency_id, pickup_agency_id, sender_name, sender_phone,
      from_commune, from_landmark, from_lat, from_lng, recipient_name, recipient_phone, recipient_email, sender_email, to_commune, to_landmark, to_lat, to_lng,
      size, weight_kg, description, declared_value_fc, insured, express, zone, price_fc, pay_method, shipping_paid, cod_amount_fc,
      status, otp_hash)
      VALUES (@tracking, @merchant_id, @agency_id, @pickup_agency_id, @sender_name, @sender_phone, @from_commune, @from_landmark,
      @from_lat, @from_lng, @recipient_name, @recipient_phone, @recipient_email, @sender_email, @to_commune, @to_landmark, @to_lat, @to_lng, @size, @weight_kg,
      @description, @declared_value_fc, @insured, @express, @zone, @price_fc, @pay_method, @shipping_paid, @cod_amount_fc,
      'cree', @otp_hash)`).run({
      ...d, agency_id: d.agency_id ?? null, merchant_id: d.merchant_id ?? null, tracking, zone: q.zone,
      price_fc: q.price_fc, shipping_paid: paidNow ? 1 : 0, otp_hash: hash
    });
    const sid = r.lastInsertRowid;
    addEvent(sid, 'cree', actor.id, ctx.agency ? `Créé au comptoir : ${ctx.agency.name}` : null);
    if (ctx.agency) {
      db.prepare("UPDATE shipments SET status = 'en_agence' WHERE id = ?").run(sid);
      addEvent(sid, 'en_agence', actor.id, ctx.agency.name);
      if (paidNow) {
        db.prepare(`INSERT INTO cash (holder_type, holder_id, shipment_id, kind, method, amount_fc)
          VALUES ('agence', ?, ?, 'port', ?, ?)`).run(ctx.agency.id, sid, d.pay_method, q.price_fc);
      }
    }
    return sid;
  })();

  await notifyShipment(db.prepare('SELECT * FROM shipments WHERE id = ?').get(id), 'cree', { otp }).catch((e) => console.error('Notification', e.message));

  return { ...db.prepare('SELECT * FROM shipments WHERE id = ?').get(id), quote: q, otp_demo: process.env.SHOW_OTP === '1' ? otp : undefined };
}

export function move(s, to, actor, { note = null, lat = null, lng = null, patch = {} } = {}) {
  if (!canMove(s.status, to)) fail(409, `Impossible : le colis est « ${STATUS_LABELS[s.status]} »`);
  const sets = Object.keys(patch).map((k) => `${k} = @${k}`);
  db.prepare(`UPDATE shipments SET status = @to${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = @id`).run({ ...patch, to, id: s.id });
  addEvent(s.id, to, actor?.id, note, lat, lng);
  const fresh = db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id);
  // Prévient automatiquement le client et le vendeur, après la fin de la transaction.
  setImmediate(() => notifyShipment(fresh, to, { note }).catch((e) => console.error('Notification', e.message)));
  return fresh;
}

// Scan au dépôt : le colis reçoit son étagère.
export function depotScan(s, actor) {
  if (s.status === 'au_depot') return { ...s, already: true };
  return move(s, 'au_depot', actor, { patch: { shelf: shelfFor(s), driver_id: null }, note: 'Scanné au dépôt' });
}

// Réception d'un colis « à retirer » dans l'agence choisie par le client.
export function agencyReceive(s, actor, agency) {
  if (s.pickup_agency_id !== agency.id) fail(409, 'Ce colis doit être retiré dans une autre agence');
  return move(s, 'disponible_agence', actor, { note: agency.name, patch: { agency_id: agency.id } });
}

// Ce que le destinataire doit payer à la remise.
export function amountDue(s) {
  const port = s.pay_method === 'cod' && !s.shipping_paid ? s.price_fc : 0;
  return { port, marchandise: s.cod_amount_fc || 0, total: port + (s.cod_amount_fc || 0) };
}

/** Remise au destinataire : par un livreur (livre) ou au comptoir (retire). */
export function handOver(s, actor, { otp, method, photo = null, lat = null, lng = null, holder }) {
  if (!checkOtp(s, otp)) fail(400, 'Code de livraison incorrect');
  const due = amountDue(s);
  if (due.total > 0 && !['cash', ...MOBILE].includes(method)) fail(400, 'Indiquez comment le client a payé');
  const to = holder.type === 'agence' ? 'retire' : 'livre';
  return tx(() => {
    const ins = db.prepare(`INSERT INTO cash (holder_type, holder_id, shipment_id, kind, method, amount_fc) VALUES (?, ?, ?, ?, ?, ?)`);
    if (due.port) ins.run(holder.type, holder.id, s.id, 'port', method, due.port);
    if (due.marchandise) {
      ins.run(holder.type, holder.id, s.id, 'marchandise', method, due.marchandise);
      db.prepare(`INSERT INTO payouts (merchant_id, amount_fc, shipment_ids) VALUES (?, ?, ?)`).run(s.merchant_id, due.marchandise, String(s.id));
    }
    return move(s, to, actor, {
      lat, lng, note: due.total ? `Encaissé ${due.total} FC (${method})` : null,
      patch: { delivered_at: new Date().toISOString(), ...(due.port ? { shipping_paid: 1 } : {}), ...(photo ? { photo } : {}) }
    });
  })();
}

export function failDelivery(s, actor, reason, lat, lng) {
  if (!reason) fail(400, 'Indiquez la raison de l’échec');
  return move(s, 'echec', actor, { note: reason, lat, lng, patch: { attempts: s.attempts + 1 } });
}

// Vue publique du suivi : sans téléphone, sans adresse exacte, sans code.
export function publicTrack(s) {
  const events = db.prepare('SELECT status, note, created_at FROM events WHERE shipment_id = ? ORDER BY id').all(s.id)
    .map((e) => ({ status: e.status, label: STATUS_LABELS[e.status] || e.status, at: e.created_at }));
  let driver = null;
  if (s.status === 'en_livraison' && s.driver_id) {
    const u = db.prepare('SELECT name, last_lat, last_lng, last_seen FROM users WHERE id = ?').get(s.driver_id);
    if (u) driver = { name: u.name.split(' ')[0], lat: u.last_lat, lng: u.last_lng, seen: u.last_seen };
  }
  const pickup = s.pickup_agency_id ? db.prepare('SELECT name, address, commune FROM agencies WHERE id = ?').get(s.pickup_agency_id) : null;
  return {
    tracking: s.tracking, status: s.status, label: STATUS_LABELS[s.status], from_commune: s.from_commune, to_commune: s.to_commune,
    to_lat: s.status === 'en_livraison' ? s.to_lat : null, to_lng: s.status === 'en_livraison' ? s.to_lng : null,
    sender: s.sender_name, express: !!s.express, due_fc: amountDue(s).total, events, driver, pickup_agency: pickup
  };
}
