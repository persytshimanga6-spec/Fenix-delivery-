// Back office (administrateur) : tout voir et tout régler.
import express from 'express';
import { db, tx, setting } from '../db.js';
import { fail, STATUS_LABELS, today, newOtp } from '../logic.js';
import { notifyNewCode, notifyMerchant } from '../notify.js';
import { hash, normPhone } from '../auth.js';
import { createShipment, mustGet, move, depotScan, amountDue, confirmPayment } from '../shipments.js';
import { createDriver, decide } from '../drivers.js';

const r = express.Router();
const int = (v) => Math.round(Number(v) || 0);

r.get('/dashboard', (_req, res) => {
  const c = (sql, ...p) => db.prepare(sql).get(...p).n;
  res.json({
    today: c("SELECT COUNT(*) n FROM shipments WHERE date(created_at) = date('now')"),
    in_delivery: c("SELECT COUNT(*) n FROM shipments WHERE status = 'en_livraison'"),
    delivered_today: c("SELECT COUNT(*) n FROM shipments WHERE status IN ('livre','retire') AND date(delivered_at) = date('now')"),
    to_assign: c("SELECT COUNT(*) n FROM shipments WHERE driver_id IS NULL AND status IN ('cree','en_agence','au_depot','echec')"),
    failed: c("SELECT COUNT(*) n FROM shipments WHERE status = 'echec'"),
    pending_merchants: c("SELECT COUNT(*) n FROM merchants WHERE status = 'en_attente'"),
    cash_out_fc: c("SELECT COALESCE(SUM(amount_fc),0) n FROM cash WHERE closing_id IS NULL AND method = 'cash'"),
    payouts_due_fc: c("SELECT COALESCE(SUM(amount_fc),0) n FROM payouts WHERE status = 'a_reverser'"),
    revenue_today_fc: c("SELECT COALESCE(SUM(price_fc),0) n FROM shipments WHERE date(created_at) = date('now') AND status != 'annule'"),
    sales_today_fc: c("SELECT COALESCE(SUM(total_fc),0) n FROM sales WHERE date(created_at) = date('now')"),
    by_status: db.prepare('SELECT status, COUNT(*) n FROM shipments GROUP BY status').all(),
    drivers: db.prepare(`SELECT u.id, u.name, u.zone, u.last_lat, u.last_lng, u.last_seen,
      (SELECT COUNT(*) FROM shipments s WHERE s.driver_id = u.id AND s.status IN ('cree','ramasse','au_depot','en_livraison','echec')) open,
      (SELECT COUNT(*) FROM shipments s WHERE s.driver_id = u.id AND s.status = 'livre' AND date(s.delivered_at) = date('now')) done
      FROM users u WHERE u.role = 'livreur' AND u.active = 1 ORDER BY u.name`).all()
  });
});

// Paiements en attente (Mobile Money à vérifier sur le téléphone de l'entreprise).
r.get('/payments', (_req, res) => res.json(db.prepare(`SELECT id, tracking, sender_name, sender_phone, recipient_name, recipient_phone, from_commune, to_commune, price_fc, cod_amount_fc,
  price_fc + cod_amount_fc AS total_fc, pay_method, payment_ref, merchant_id, created_at FROM shipments
  WHERE payment_status = 'en_attente' AND status != 'annule' ORDER BY id DESC LIMIT 200`).all()));
r.post('/shipments/:t/confirm-payment', (req, res) => {
  const { otp_hash, ...s } = confirmPayment(mustGet(req.params.t), req.user, { method: req.body.method, ref: req.body.ref });
  res.json(s);
});

r.get('/shipments', (req, res) => {
  const where = []; const p = {};
  if (req.query.status) { where.push('s.status = @status'); p.status = req.query.status; }
  if (req.query.q) { where.push('(s.tracking LIKE @q OR s.recipient_name LIKE @q OR s.recipient_phone LIKE @q OR s.sender_name LIKE @q)'); p.q = `%${req.query.q}%`; }
  if (req.query.unassigned) where.push("s.driver_id IS NULL AND s.status IN ('cree','en_agence','au_depot','echec','ramasse')");
  const rows = db.prepare(`SELECT s.id, s.tracking, s.sender_name, s.recipient_name, s.recipient_phone, s.from_commune, s.to_commune,
    s.to_lat, s.to_lng, s.size, s.express, s.price_fc, s.pay_method, s.payment_status, s.payment_ref, s.cod_amount_fc, s.status, s.shelf, s.attempts, s.created_at,
    s.pickup_agency_id, u.name driver_name, s.driver_id
    FROM shipments s LEFT JOIN users u ON u.id = s.driver_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.express DESC, s.id DESC LIMIT 500`).all(p);
  res.json(rows.map((x) => ({ ...x, label: STATUS_LABELS[x.status] })));
});

r.get('/shipments/:t', (req, res) => {
  const { otp_hash, ...s } = mustGet(req.params.t);
  res.json({
    ...s, label: STATUS_LABELS[s.status], due: amountDue(s),
    events: db.prepare(`SELECT e.*, u.name user_name FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.shipment_id = ? ORDER BY e.id`).all(s.id).map((e) => ({ ...e, label: STATUS_LABELS[e.status] }))
  });
});

r.post('/shipments', async (req, res) => res.status(201).json(await createShipment(req.body, req.user)));

r.post('/shipments/:t/assign', (req, res) => {
  const s = mustGet(req.params.t);
  const d = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'livreur' AND active = 1").get(req.body.driver_id);
  if (s.payment_status === 'en_attente') fail(402, 'Colis non payé : confirmez d’abord le paiement');
  if (!d) fail(400, 'Livreur inconnu');
  if (!['cree', 'en_agence', 'ramasse', 'au_depot', 'echec'].includes(s.status)) fail(409, 'Ce colis ne peut plus être assigné');
  db.prepare('UPDATE shipments SET driver_id = ? WHERE id = ?').run(d.id, s.id);
  db.prepare('INSERT INTO events (shipment_id, status, note, user_id) VALUES (?, ?, ?, ?)').run(s.id, s.status, `Assigné à ${d.name}`, req.user.id);
  res.json({ ok: true });
});

r.post('/shipments/:t/status', (req, res) => {
  const s = mustGet(req.params.t);
  if (['livre', 'retire'].includes(req.body.status)) fail(400, 'La remise se fait avec le code du destinataire');
  res.json(move(s, req.body.status, req.user, { note: req.body.note || 'Changement manuel' }));
});

r.post('/shipments/:t/resend-code', async (req, res) => {
  const s = mustGet(req.params.t);
  // On ne connaît pas le code (il est chiffré) : on en crée un nouveau.
  const { otp, hash: h } = newOtp(s.tracking);
  db.prepare('UPDATE shipments SET otp_hash = ? WHERE id = ?').run(h, s.id);
  await notifyNewCode(s, otp);
  res.json({ ok: true });
});

r.post('/depot/scan', (req, res) => res.json(depotScan(mustGet(req.body.tracking), req.user)));

// ----- Personnes -----
r.get('/users', (_req, res) => res.json(db.prepare(`SELECT u.id, u.role, u.name, u.phone, u.zone, u.active, u.agency_id, a.name agency_name, u.created_at, u.driver_kind,
  p.license_no, p.experience_years, p.status application_status
  FROM users u LEFT JOIN agencies a ON a.id = u.agency_id LEFT JOIN driver_profiles p ON p.user_id = u.id
  WHERE u.role != 'commercant' AND COALESCE(p.status, 'valide') != 'en_attente' ORDER BY u.role, u.name`).all()));

// Candidatures de livreurs (formulaire « Postuler »).
r.get('/applications', (req, res) => {
  const st = ['en_attente', 'valide', 'refuse'].includes(req.query.status) ? req.query.status : 'en_attente';
  res.json(db.prepare(`SELECT p.*, u.name full_name, u.phone, u.driver_kind FROM driver_profiles p JOIN users u ON u.id = p.user_id
    WHERE p.status = ? ORDER BY p.created_at`).all(st));
});
r.post('/applications/:id', (req, res) => res.json(decide(Number(req.params.id), req.body.decision, req.user.id, req.body.zone)));
r.post('/users', (req, res) => {
  const { role, name, phone, password, agency_id, zone } = req.body;
  if (!['livreur', 'agent', 'admin'].includes(role)) fail(400, 'Rôle invalide');
  // Livreur ajouté par le bureau : mêmes champs que la candidature, validé tout de suite.
  if (role === 'livreur') return res.status(201).json({ id: createDriver(req.body, { validated: true, by: req.user.id, zone }) });
  if (!name || !phone || !password || String(password).length < 6) fail(400, 'Nom, téléphone et mot de passe (6 caractères) obligatoires');
  if (role === 'agent' && !agency_id) fail(400, 'Choisissez l’agence de l’agent');
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(normPhone(phone))) fail(409, 'Ce numéro a déjà un compte');
  const id = db.prepare('INSERT INTO users (role, name, phone, password_hash, agency_id, zone) VALUES (?, ?, ?, ?, ?, ?)')
    .run(role, String(name).trim(), normPhone(phone), hash(password), role === 'agent' ? agency_id : null, zone || null).lastInsertRowid;
  res.status(201).json({ id });
});
r.patch('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) || fail(404, 'Introuvable');
  if (u.id === req.user.id && req.body.active === false) fail(400, 'Vous ne pouvez pas désactiver votre propre compte');
  if (req.body.active && db.prepare("SELECT 1 FROM driver_profiles WHERE user_id = ? AND status != 'valide'").get(u.id)) fail(409, 'Validez d’abord la candidature de ce livreur');
  if ('active' in req.body) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, u.id);
  if ('driver_kind' in req.body) {
    if (!['salarie', 'independant'].includes(req.body.driver_kind)) fail(400, 'Type de chauffeur : salarié ou indépendant');
    db.prepare('UPDATE users SET driver_kind = ? WHERE id = ?').run(req.body.driver_kind, u.id);
  }
  if (req.body.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash(req.body.password), u.id);
  if ('zone' in req.body) db.prepare('UPDATE users SET zone = ? WHERE id = ?').run(req.body.zone || null, u.id);
  res.json({ ok: true });
});

r.get('/merchants', (_req, res) => res.json(db.prepare(`SELECT m.*,
  (SELECT COUNT(*) FROM shipments s WHERE s.merchant_id = m.id) shipments,
  (SELECT COALESCE(SUM(price_fc),0) FROM shipments s WHERE s.merchant_id = m.id AND s.pay_method = 'compte' AND s.shipping_paid = 0 AND s.status != 'annule') unpaid_fc
  FROM merchants m ORDER BY CASE m.status WHEN 'en_attente' THEN 0 ELSE 1 END, m.name`).all()));
r.post('/merchants/:id/status', async (req, res) => {
  const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id) || fail(404, 'Introuvable');
  if (!['actif', 'suspendu', 'en_attente'].includes(req.body.status)) fail(400, 'Statut invalide');
  db.prepare('UPDATE merchants SET status = ? WHERE id = ?').run(req.body.status, m.id);
  if (req.body.status === 'actif' && m.status !== 'actif') {
    await notifyMerchant(m, 'Votre compte commerçant est validé', 'Votre compte commerçant est validé. Vous pouvez créer vos envois.');
  }
  res.json({ ok: true });
});
// Le commerçant paie ses envois « sur compte » (facture de la semaine).
r.post('/merchants/:id/settle-shipping', (req, res) => {
  const n = db.prepare("UPDATE shipments SET shipping_paid = 1 WHERE merchant_id = ? AND pay_method = 'compte' AND shipping_paid = 0 AND status != 'annule'")
    .run(req.params.id).changes;
  res.json({ settled: n });
});

// ----- Tarifs et réglages -----
r.get('/rates', (_req, res) => res.json({
  rates: db.prepare('SELECT * FROM rates ORDER BY zone, CASE size WHEN \'petit\' THEN 0 WHEN \'moyen\' THEN 1 ELSE 2 END').all(),
  settings: Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key != 'jwt_secret'").all().map((x) => [x.key, x.value])),
  communes: db.prepare('SELECT * FROM communes ORDER BY secteur, name').all()
}));
r.put('/rates', (req, res) => {
  tx(() => {
    for (const x of req.body.rates || []) {
      if (int(x.price_fc) <= 0) fail(400, 'Prix invalide');
      db.prepare('UPDATE rates SET price_fc = ? WHERE zone = ? AND size = ?').run(int(x.price_fc), int(x.zone), x.size);
    }
    const allowed = ['company_name', 'express_supplement_fc', 'retry_fee_fc', 'insurance_pct', 'driver_share_salarie_pct', 'driver_share_independant_pct', 'relay_commission_pct',
      'base_petit_fc', 'base_moyen_fc', 'base_grand_fc', 'fuel_price_fc', 'fuel_l_per_km', 'minute_fc', 'speed_normal_kmh', 'speed_rush_kmh',
      'rush_hours', 'road_factor', 'momo_mpesa', 'momo_orange', 'momo_airtel'];
    for (const [k, v] of Object.entries(req.body.settings || {})) {
      if (allowed.includes(k)) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
    }
    for (const c of req.body.communes || []) db.prepare('UPDATE communes SET secteur = ? WHERE name = ?').run(String(c.secteur), c.name);
  })();
  res.json({ ok: true });
});

// ----- Agences, points relais, franchises -----
r.get('/agencies', (_req, res) => res.json(db.prepare(`SELECT a.*,
  (SELECT COALESCE(SUM(total_fc),0) FROM sales x WHERE x.agency_id = a.id AND date(x.created_at) = date('now')) sales_today_fc,
  (SELECT COUNT(*) FROM shipments s WHERE s.agency_id = a.id AND s.status = 'disponible_agence') waiting
  FROM agencies a ORDER BY a.name`).all()));
r.post('/agencies', (req, res) => {
  const b = req.body;
  if (!b.name || !['agence', 'relais', 'franchise'].includes(b.kind)) fail(400, 'Nom et type obligatoires');
  const id = tx(() => {
    const aid = db.prepare('INSERT INTO agencies (name, kind, commune, address, lat, lng, commission_pct) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(b.name, b.kind, b.commune || null, b.address || null, Number(b.lat) || null, Number(b.lng) || null, Number(b.commission_pct) || 0).lastInsertRowid;
    for (const p of db.prepare('SELECT id FROM products WHERE is_service = 0').all()) db.prepare('INSERT INTO stock (agency_id, product_id, qty) VALUES (?, ?, 0)').run(aid, p.id);
    return aid;
  })();
  res.status(201).json({ id });
});
r.patch('/agencies/:id', (req, res) => {
  const fields = ['name', 'kind', 'commune', 'address', 'lat', 'lng', 'commission_pct', 'active'].filter((k) => k in req.body);
  for (const k of fields) db.prepare(`UPDATE agencies SET ${k} = ? WHERE id = ?`).run(typeof req.body[k] === 'boolean' ? Number(req.body[k]) : req.body[k], req.params.id);
  res.json({ ok: true });
});

// ----- Articles et services -----
r.get('/products', (_req, res) => res.json({
  products: db.prepare('SELECT * FROM products ORDER BY category, name').all(),
  stock: db.prepare('SELECT * FROM stock').all()
}));
r.post('/products', (req, res) => {
  const b = req.body;
  if (!b.name || !b.category || int(b.price_fc) <= 0) fail(400, 'Nom, catégorie et prix obligatoires');
  const id = tx(() => {
    const pid = db.prepare('INSERT INTO products (name, category, price_fc, is_service) VALUES (?, ?, ?, ?)').run(b.name, b.category, int(b.price_fc), b.is_service ? 1 : 0).lastInsertRowid;
    if (!b.is_service) for (const a of db.prepare('SELECT id FROM agencies').all()) db.prepare('INSERT INTO stock (agency_id, product_id, qty) VALUES (?, ?, 0)').run(a.id, pid);
    return pid;
  })();
  res.status(201).json({ id });
});
r.patch('/products/:id', (req, res) => {
  if ('price_fc' in req.body) db.prepare('UPDATE products SET price_fc = ? WHERE id = ?').run(int(req.body.price_fc), req.params.id);
  if ('active' in req.body) db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  if ('name' in req.body) db.prepare('UPDATE products SET name = ? WHERE id = ?').run(String(req.body.name), req.params.id);
  res.json({ ok: true });
});
// Réception de marchandise dans une agence (+) ou correction (-).
r.post('/stock', (req, res) => {
  const { agency_id, product_id, delta } = req.body;
  db.prepare(`INSERT INTO stock (agency_id, product_id, qty) VALUES (?, ?, ?)
    ON CONFLICT(agency_id, product_id) DO UPDATE SET qty = qty + excluded.qty`).run(agency_id, product_id, int(delta));
  res.json(db.prepare('SELECT * FROM stock WHERE agency_id = ? AND product_id = ?').get(agency_id, product_id));
});

// ----- Caisse du soir -----
// Argent encore entre les mains des livreurs et des agences.
r.get('/cash', (_req, res) => {
  const open = db.prepare(`SELECT holder_type, holder_id,
    SUM(CASE WHEN method = 'cash' THEN amount_fc ELSE 0 END) cash_fc,
    SUM(CASE WHEN method != 'cash' THEN amount_fc ELSE 0 END) mobile_fc,
    COUNT(DISTINCT shipment_id) shipments
    FROM cash WHERE closing_id IS NULL GROUP BY holder_type, holder_id`).all();
  // Chaque livreur a le taux de SON type (salarié ou indépendant).
  const pct = { salarie: Number(setting('driver_share_salarie_pct', 0)), independant: Number(setting('driver_share_independant_pct', 0)) };
  const rows = open.map((o) => {
    const h = o.holder_type === 'livreur'
      ? db.prepare('SELECT name FROM users WHERE id = ?').get(o.holder_id)
      : db.prepare('SELECT name FROM agencies WHERE id = ?').get(o.holder_id);
    return { ...o, name: h?.name || '?' };
  });
  const drivers = db.prepare(`SELECT u.id, u.name, u.driver_kind, COUNT(s.id) delivered, COALESCE(SUM(s.price_fc),0) port_fc
    FROM users u LEFT JOIN shipments s ON s.driver_id = u.id AND s.status = 'livre' AND date(s.delivered_at) = date('now')
    WHERE u.role = 'livreur' AND u.active = 1 GROUP BY u.id ORDER BY u.name`).all()
    .map((d) => {
      const rate = pct[d.driver_kind] ?? pct.salarie;
      return { ...d, share_pct: rate, share_fc: Math.round(d.port_fc * rate / 100) };
    });
  const closings = db.prepare(`SELECT c.*, CASE c.holder_type WHEN 'livreur' THEN (SELECT name FROM users WHERE id = c.holder_id)
    ELSE (SELECT name FROM agencies WHERE id = c.holder_id) END name FROM closings c WHERE c.day = ? ORDER BY c.id DESC`).all(today());
  res.json({ open: rows, drivers, closings });
});

r.post('/cash/close', (req, res) => res.json(closeCash(req.body.holder_type, int(req.body.holder_id), int(req.body.given_cash_fc), req.body.note, req.user)));

export function closeCash(holderType, holderId, given, note, user) {
  if (!['livreur', 'agence'].includes(holderType)) fail(400, 'Type invalide');
  return tx(() => {
    const rows = db.prepare('SELECT * FROM cash WHERE holder_type = ? AND holder_id = ? AND closing_id IS NULL').all(holderType, holderId);
    if (!rows.length) fail(409, 'Rien à remettre');
    const expected = rows.filter((x) => x.method === 'cash').reduce((s, x) => s + x.amount_fc, 0);
    const mobile = rows.filter((x) => x.method !== 'cash').reduce((s, x) => s + x.amount_fc, 0);
    const id = db.prepare(`INSERT INTO closings (holder_type, holder_id, day, expected_cash_fc, given_cash_fc, mobile_fc, gap_fc, note, validated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(holderType, holderId, today(), expected, given, mobile, given - expected, note || null, user.id).lastInsertRowid;
    db.prepare(`UPDATE cash SET closing_id = ? WHERE id IN (${rows.map(() => '?').join(',')})`).run(id, ...rows.map((x) => x.id));
    return db.prepare('SELECT * FROM closings WHERE id = ?').get(id);
  })();
}

// ----- Reversements aux commerçants -----
r.get('/payouts', (_req, res) => res.json({
  due: db.prepare(`SELECT m.id merchant_id, m.name, m.payout_operator, m.payout_number, COUNT(p.id) shipments, SUM(p.amount_fc) amount_fc,
    MIN(p.created_at) oldest FROM payouts p JOIN merchants m ON m.id = p.merchant_id WHERE p.status = 'a_reverser'
    GROUP BY m.id ORDER BY oldest`).all(),
  recent: db.prepare(`SELECT p.reference, m.name, SUM(p.amount_fc) amount_fc, p.paid_at FROM payouts p JOIN merchants m ON m.id = p.merchant_id
    WHERE p.status = 'reverse' GROUP BY p.reference, m.id ORDER BY p.paid_at DESC LIMIT 30`).all()
}));
r.post('/payouts/pay', async (req, res) => {
  const { merchant_id, reference } = req.body;
  if (!reference) fail(400, 'Indiquez la référence de la transaction Mobile Money');
  const total = db.prepare("SELECT COALESCE(SUM(amount_fc),0) v FROM payouts WHERE merchant_id = ? AND status = 'a_reverser'").get(merchant_id).v;
  if (!total) fail(409, 'Rien à reverser');
  db.prepare("UPDATE payouts SET status = 'reverse', reference = ?, paid_at = datetime('now') WHERE merchant_id = ? AND status = 'a_reverser'")
    .run(String(reference).slice(0, 80), merchant_id);
  const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchant_id);
  await notifyMerchant(m, 'Paiement reçu', `${total.toLocaleString('fr-FR')} FC vous ont été reversés (réf. ${reference}).`);
  res.json({ paid_fc: total });
});

// ----- Boîtes postales -----
r.get('/mailboxes', (_req, res) => res.json(db.prepare(`SELECT b.*, a.name agency_name FROM mailboxes b JOIN agencies a ON a.id = b.agency_id ORDER BY a.name, b.number`).all()));

// Journal des SMS et e-mails envoyés automatiquement.
r.get('/sms', (_req, res) => res.json(db.prepare("SELECT id, to_addr phone, message, status, created_at FROM notifications WHERE channel = 'sms' ORDER BY id DESC LIMIT 100").all()));
r.get('/notifications', (req, res) => {
  const ch = ['sms', 'email'].includes(req.query.channel) ? req.query.channel : null;
  res.json(db.prepare(`SELECT n.*, s.tracking, m.name merchant_name FROM notifications n
    LEFT JOIN shipments s ON s.id = n.shipment_id LEFT JOIN merchants m ON m.id = n.merchant_id
    ${ch ? 'WHERE n.channel = ?' : ''} ORDER BY n.id DESC LIMIT 200`).all(...(ch ? [ch] : [])));
});

// Rapport par jour sur 30 jours
r.get('/report', (_req, res) => res.json(db.prepare(`SELECT date(created_at) day, COUNT(*) shipments, SUM(price_fc) revenue_fc,
  SUM(CASE WHEN status IN ('livre','retire') THEN 1 ELSE 0 END) delivered
  FROM shipments WHERE created_at >= date('now','-30 day') AND status != 'annule' GROUP BY day ORDER BY day`).all()));

export default r;
