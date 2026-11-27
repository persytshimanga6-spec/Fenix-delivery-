// Opérations sur les colis, partagées par le site, l'appli livreur, l'agence et le back office.
import { db, tx, setting } from './db.js';
import {
  quote, newTracking, newOtp, checkOtp, addEvent, canMove, fail, shelfFor,
  SIZES, MOBILE, PAY_METHODS, STATUS_LABELS, publicUrl
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
 * Crée un envoi. `actor` = utilisateur connecté (null pour une réservation sur le site public).
 * `ctx.agency` = créé au comptoir d'une agence. `ctx.public` = réservé en ligne par un client.
 * Le port est TOUJOURS payé avant le départ du colis :
 *   compte                 → facture hebdomadaire du commerçant (payment_status « compte »)
 *   mpesa, orange, airtel  → Mobile Money avec la référence de la transaction
 *   cash                   → espèces au comptoir d'une agence
 * Au comptoir, l'agent encaisse lui-même : le colis est payé tout de suite.
 * Sinon le paiement est « en attente » jusqu'à ce qu'un comptoir ou le siège le confirme ;
 * en attendant, aucun livreur ne peut le prendre et il ne peut pas partir.
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
    cod_amount_fc: int(input.cod_amount_fc), pay_method: str(input.pay_method), payment_ref: str(input.payment_ref, 60),
    pickup_agency_id: num(input.pickup_agency_id)
  };

  const role = actor?.role || 'public';

  // Un commerçant envoie toujours depuis sa boutique.
  if (role === 'commercant') {
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(actor.merchant_id);
    if (!m || m.status !== 'actif') fail(403, 'Votre compte commerçant n’est pas encore validé');
    Object.assign(d, {
      sender_name: m.name, sender_phone: m.phone, sender_email: m.email || null, from_commune: m.commune, from_landmark: m.landmark,
      from_lat: m.lat, from_lng: m.lng
    });
    if (d.cod_amount_fc > 0) {
      // Avec une marchandise : le client paie TOUT avant le départ (livraison + marchandise), par Mobile Money.
      // Il reçoit un lien pour payer ; le commerçant peut aussi entrer la référence si le client a déjà payé.
      if (d.pay_method === 'compte') fail(400, 'Avec une marchandise, le client paie l’envoi et la marchandise avant le départ');
      if (!MOBILE.includes(d.pay_method)) d.pay_method = 'mpesa';
      if (d.payment_ref && d.payment_ref.length < 4) fail(400, 'Référence Mobile Money trop courte');
    } else {
      if (!['compte', ...MOBILE].includes(d.pay_method)) fail(400, 'Paiement : sur votre compte ou par Mobile Money');
      if (MOBILE.includes(d.pay_method) && (!d.payment_ref || d.payment_ref.length < 4)) fail(400, 'Entrez la référence de la transaction Mobile Money');
    }
    d.merchant_id = m.id;
  } else if (ctx.public) {
    d.merchant_id = null;
    if (!PAY_METHODS.includes(d.pay_method)) fail(400, 'Choisissez le moyen de paiement');
    if (MOBILE.includes(d.pay_method) && (!d.payment_ref || d.payment_ref.length < 4)) fail(400, 'Entrez la référence de la transaction Mobile Money');

    if (d.cod_amount_fc > 0) fail(400, 'L’encaissement de marchandise est réservé aux commerçants');
    if (d.pay_method === 'compte') fail(400, 'Paiement par Mobile Money ou en espèces au comptoir');
    if (!d.from_commune) fail(400, 'Commune de départ obligatoire');
    if (d.pay_method !== 'cash' && !d.from_landmark) fail(400, 'Indiquez où le livreur doit ramasser le colis (repère)');
  } else {
    d.merchant_id = num(input.merchant_id);
    if (!PAY_METHODS.includes(d.pay_method)) fail(400, 'Choisissez le moyen de paiement');
    if (MOBILE.includes(d.pay_method) && (!d.payment_ref || d.payment_ref.length < 4)) fail(400, 'Entrez la référence de la transaction Mobile Money');

    if (d.cod_amount_fc > 0 && !d.merchant_id) fail(400, 'L’encaissement de marchandise est réservé aux commerçants');
  }
  if (ctx.agency) {
    d.agency_id = ctx.agency.id;
    if (!d.from_commune) d.from_commune = ctx.agency.commune;
    if (!d.from_landmark) d.from_landmark = ctx.agency.name;
    if (d.from_lat == null) { d.from_lat = ctx.agency.lat; d.from_lng = ctx.agency.lng; }
    if (d.pay_method === 'compte' && !d.merchant_id) fail(400, 'Au comptoir : espèces ou Mobile Money');
    if (d.pay_method === 'compte' && d.cod_amount_fc > 0) fail(400, 'Avec une marchandise, le client paie l’envoi et la marchandise avant le départ');
  } else if (d.pay_method === 'compte' && !d.merchant_id) {
    fail(400, 'Le paiement « sur compte » est réservé aux commerçants');
  }
  if (d.pay_method === 'compte' && !ctx.public && role !== 'commercant'
      && db.prepare("SELECT status FROM merchants WHERE id = ?").get(d.merchant_id)?.status !== 'actif') fail(400, 'Commerçant inconnu ou pas encore validé');

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
  // Le comptoir (ou le siège) encaisse lui-même : payé tout de suite. Ailleurs : en attente de confirmation.
  const payment_status = d.pay_method === 'compte' ? 'compte' : (ctx.agency || role === 'admin') ? 'paye' : 'en_attente';
  const paidNow = payment_status === 'paye';

  const id = tx(() => {
    const r = db.prepare(`INSERT INTO shipments (tracking, merchant_id, agency_id, pickup_agency_id, sender_name, sender_phone,
      from_commune, from_landmark, from_lat, from_lng, recipient_name, recipient_phone, recipient_email, sender_email, to_commune, to_landmark, to_lat, to_lng,
      size, weight_kg, description, declared_value_fc, insured, express, zone, price_fc, pay_method, shipping_paid, cod_amount_fc,
      status, otp_hash, payment_status, payment_ref, paid_at)
      VALUES (@tracking, @merchant_id, @agency_id, @pickup_agency_id, @sender_name, @sender_phone, @from_commune, @from_landmark,
      @from_lat, @from_lng, @recipient_name, @recipient_phone, @recipient_email, @sender_email, @to_commune, @to_landmark, @to_lat, @to_lng, @size, @weight_kg,
      @description, @declared_value_fc, @insured, @express, @zone, @price_fc, @pay_method, @shipping_paid, @cod_amount_fc,
      'cree', @otp_hash, @payment_status, @payment_ref, @paid_at)`).run({
      ...d, agency_id: d.agency_id ?? null, merchant_id: d.merchant_id ?? null, tracking, zone: q.zone,
      price_fc: q.price_fc, shipping_paid: paidNow ? 1 : 0, otp_hash: hash,
      payment_status, paid_at: paidNow ? new Date().toISOString() : null
    });
    const sid = r.lastInsertRowid;
    addEvent(sid, 'cree', actor?.id ?? null, ctx.agency ? `Créé au comptoir : ${ctx.agency.name}` : ctx.public ? 'Réservé en ligne' : null);
    if (ctx.agency) {
      db.prepare("UPDATE shipments SET status = 'en_agence' WHERE id = ?").run(sid);
      addEvent(sid, 'en_agence', actor.id, ctx.agency.name);
      if (paidNow) {
        const ins = db.prepare(`INSERT INTO cash (holder_type, holder_id, shipment_id, kind, method, amount_fc) VALUES ('agence', ?, ?, ?, ?, ?)`);
        ins.run(ctx.agency.id, sid, 'port', d.pay_method, q.price_fc);
        if (d.cod_amount_fc) ins.run(ctx.agency.id, sid, 'marchandise', d.pay_method, d.cod_amount_fc);
      }
    }
    return sid;
  })();

  await notifyShipment(db.prepare('SELECT * FROM shipments WHERE id = ?').get(id), 'cree', { otp }).catch((e) => console.error('Notification', e.message));

  const out = { ...db.prepare('SELECT * FROM shipments WHERE id = ?').get(id), quote: q, otp_demo: process.env.SHOW_OTP === '1' ? otp : undefined };
  // Réservation en ligne : le client voit son code tout de suite, pour le donner au destinataire.
  if (ctx.public) out.otp = otp;
  delete out.otp_hash;
  return out;
}

// Étapes interdites tant que le port n'est pas payé : le colis ne part pas.
const NEEDS_PAYMENT = ['ramasse', 'en_agence', 'au_depot', 'en_livraison', 'disponible_agence'];

export function move(s, to, actor, { note = null, lat = null, lng = null, patch = {} } = {}) {
  if (!canMove(s.status, to)) fail(409, `Impossible : le colis est « ${STATUS_LABELS[s.status]} »`);
  if (s.payment_status === 'en_attente' && NEEDS_PAYMENT.includes(to)) fail(402, `Colis ${s.tracking} non payé : le paiement doit être confirmé avant le départ`);
  const sets = Object.keys(patch).map((k) => `${k} = @${k}`);
  db.prepare(`UPDATE shipments SET status = @to${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = @id`).run({ ...patch, to, id: s.id });
  addEvent(s.id, to, actor?.id, note, lat, lng);
  const fresh = db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id);
  // Prévient automatiquement le client et le vendeur, après la fin de la transaction.
  setImmediate(() => notifyShipment(fresh, to, { note }).catch((e) => console.error('Notification', e.message)));
  return fresh;
}

/**
 * Confirme un paiement en attente (Mobile Money vérifié, ou espèces reçues au comptoir).
 * Au comptoir, l'argent entre dans la caisse de l'agence. `deposit` : le client dépose le colis maintenant.
 */
export function confirmPayment(s, actor, { method, ref, agency = null, deposit = false } = {}) {
  if (s.payment_status !== 'en_attente') fail(409, s.payment_status === 'compte' ? 'Ce colis est facturé sur le compte du commerçant' : 'Ce colis est déjà payé');
  const m = method || s.pay_method;
  if (!['cash', ...MOBILE].includes(m)) fail(400, 'Moyen de paiement invalide');
  if (m === 'cash' && !agency) fail(400, 'Les espèces se confirment au comptoir d’une agence');
  const r = str(ref, 60) || s.payment_ref;
  if (MOBILE.includes(m) && !r) fail(400, 'Référence Mobile Money obligatoire');
  const updated = tx(() => {
    db.prepare(`UPDATE shipments SET payment_status = 'paye', shipping_paid = 1, pay_method = ?, payment_ref = ?, paid_at = ? WHERE id = ?`)
      .run(m, r, new Date().toISOString(), s.id);
    if (agency) {
      const ins = db.prepare(`INSERT INTO cash (holder_type, holder_id, shipment_id, kind, method, amount_fc) VALUES ('agence', ?, ?, ?, ?, ?)`);
      ins.run(agency.id, s.id, 'port', m, s.price_fc);
      if (s.cod_amount_fc) ins.run(agency.id, s.id, 'marchandise', m, s.cod_amount_fc);
    }
    addEvent(s.id, s.status, actor?.id, `Paiement confirmé : ${prepayTotal(s)} FC (${m}${r ? ` · ${r}` : ''})${s.cod_amount_fc ? `, dont marchandise ${s.cod_amount_fc} FC pour le commerçant` : ''}`);
    let fresh = db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id);
    if (agency && deposit && fresh.status === 'cree') {
      fresh = move(fresh, 'en_agence', actor, { note: `Déposé au comptoir : ${agency.name}`, patch: { agency_id: agency.id } });
    }
    return fresh;
  })();
  setImmediate(() => notifyShipment(updated, 'paiement').catch((e) => console.error('Notification', e.message)));
  return updated;
}

/**
 * Le client (destinataire) envoie la référence de son paiement Mobile Money depuis le lien reçu par SMS.
 * Il doit donner son numéro de téléphone. Le paiement reste « en attente » jusqu'à la vérification.
 */
export function submitPayment(s, { phone, method, ref }) {
  const last9 = (p) => normPhone(p).replace(/\D/g, '').slice(-9);
  if (!phone || last9(phone) !== last9(s.recipient_phone)) fail(403, 'Ce numéro ne correspond pas au destinataire du colis');
  if (s.payment_status !== 'en_attente') fail(409, 'Ce colis est déjà payé');
  if (!MOBILE.includes(method)) fail(400, 'Choisissez M-Pesa, Airtel Money ou Orange Money');
  const r = str(ref, 60);
  if (!r || r.length < 4) fail(400, 'Entrez la référence de la transaction');
  db.prepare('UPDATE shipments SET pay_method = ?, payment_ref = ? WHERE id = ?').run(method, r, s.id);
  addEvent(s.id, s.status, null, `Référence de paiement envoyée par le client : ${r}`);
  return db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id);
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

/** Ce que le client paie AVANT le départ : la livraison (sauf facture du commerçant) + la marchandise. */
export function prepayTotal(s) {
  return (s.pay_method === 'compte' ? 0 : s.price_fc) + (s.cod_amount_fc || 0);
}

// Ce que le destinataire doit payer à la remise : rien, tout est payé d'avance (sauf anciens colis).
export function amountDue(s) {
  if (s.payment_status) return { port: 0, marchandise: 0, total: 0 };
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
    } else if (s.cod_amount_fc && s.merchant_id && s.payment_status === 'paye') {
      // Marchandise payée d'avance : à passer en entier sur le compte du commerçant (sous 48 h).
      db.prepare(`INSERT INTO payouts (merchant_id, amount_fc, shipment_ids) VALUES (?, ?, ?)`).run(s.merchant_id, s.cod_amount_fc, String(s.id));
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
    sender: s.sender_name, express: !!s.express, due_fc: amountDue(s).total, events, driver, pickup_agency: pickup,
    payment: s.payment_status === 'en_attente' ? 'en_attente' : 'ok', price_fc: s.payment_status === 'en_attente' ? prepayTotal(s) : undefined
  };
}
