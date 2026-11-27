// Caisse d'agence (comptoir) : envois, ventes d'articles et de services, retraits, caisse du soir.
import express from 'express';
import { db, tx, setting } from '../db.js';
import { fail, STATUS_LABELS, MOBILE } from '../logic.js';
import { createShipment, mustGet, depotScan, handOver, agencyReceive, amountDue, confirmPayment, renewOtp } from '../shipments.js';
import { notifyNewCode } from '../notify.js';
import { limits } from '../limits.js';
import { closeCash } from './admin.js';

const r = express.Router();

// L'agent travaille dans son agence ; l'administrateur choisit l'agence (?agency_id=).
r.use((req, _res, next) => {
  const id = req.user.role === 'agent' ? req.user.agency_id : Number(req.query.agency_id || req.body?.agency_id);
  const a = db.prepare('SELECT * FROM agencies WHERE id = ? AND active = 1').get(id);
  if (!a) return next(Object.assign(new Error('Agence introuvable : choisissez une agence'), { status: 400 }));
  req.agency = a;
  next();
});

r.get('/info', (req, res) => {
  const a = req.agency;
  res.json({
    agency: a,
    products: db.prepare(`SELECT p.*, st.qty FROM products p LEFT JOIN stock st ON st.product_id = p.id AND st.agency_id = ?
      WHERE p.active = 1 ORDER BY p.category, p.name`).all(a.id),
    waiting: db.prepare(`SELECT tracking, recipient_name, recipient_phone, cod_amount_fc, price_fc, pay_method, shipping_paid, created_at
      FROM shipments WHERE pickup_agency_id = ? AND status = 'disponible_agence' ORDER BY id`).all(a.id)
      .map((s) => ({ ...s, due: amountDue(s).total })),
    deposited: db.prepare(`SELECT tracking, recipient_name, to_commune, created_at FROM shipments
      WHERE agency_id = ? AND status = 'en_agence' ORDER BY id`).all(a.id),
    cash: db.prepare(`SELECT method, kind, SUM(amount_fc) total FROM cash WHERE holder_type = 'agence' AND holder_id = ? AND closing_id IS NULL
      GROUP BY method, kind`).all(a.id),
    sales_today: db.prepare(`SELECT id, total_fc, pay_method, created_at FROM sales WHERE agency_id = ? AND date(created_at) = date('now') ORDER BY id DESC`).all(a.id),
    mailboxes: db.prepare('SELECT * FROM mailboxes WHERE agency_id = ? ORDER BY number').all(a.id)
  });
});

r.post('/shipments', async (req, res) => res.status(201).json(await createShipment(req.body, req.user, { agency: req.agency })));

// Nouveau code de livraison (expiré après 24 h ou bloqué après 3 essais) pour un colis qui attend dans cette agence.
r.post('/shipments/:t/resend-code', limits.resend, async (req, res) => {
  const s = mustGet(req.params.t);
  if (s.status !== 'disponible_agence' || s.agency_id !== req.agency.id) fail(403, 'Ce colis n’attend pas dans votre agence');
  await notifyNewCode(s, renewOtp(s));
  res.json({ ok: true });
});

// Paiements à confirmer : réservations en ligne et envois Mobile Money des commerçants.
r.get('/payments', (_req, res) => res.json(db.prepare(`SELECT id, tracking, sender_name, sender_phone, recipient_name, recipient_phone, from_commune, to_commune, price_fc, cod_amount_fc,
  price_fc + cod_amount_fc AS total_fc, pay_method, payment_ref, merchant_id, created_at FROM shipments
  WHERE payment_status = 'en_attente' AND status != 'annule' ORDER BY id DESC LIMIT 200`).all()));
r.post('/shipments/:t/confirm-payment', (req, res) => {
  const { otp_hash, ...s } = confirmPayment(mustGet(req.params.t), req.user,
    { method: req.body.method, ref: req.body.ref, agency: req.agency, deposit: !!req.body.deposit });
  res.json({ ...s, label: STATUS_LABELS[s.status] });
});

r.get('/shipments/:t', (req, res) => {
  const { otp_hash, ...s } = mustGet(req.params.t);
  res.json({ ...s, label: STATUS_LABELS[s.status], due: amountDue(s) });
});

// Vente d'articles et de services.
r.post('/sales', (req, res) => {
  const items = (req.body.items || []).filter((i) => Number(i.qty) > 0);
  const method = req.body.pay_method;
  if (!items.length) fail(400, 'Panier vide');
  if (!['cash', ...MOBILE].includes(method)) fail(400, 'Mode de paiement invalide');
  const sale = tx(() => {
    let total = 0;
    const lines = items.map((i) => {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(i.product_id) || fail(400, 'Article inconnu');
      const qty = Math.round(Number(i.qty));
      if (!p.is_service) {
        const st = db.prepare('SELECT qty FROM stock WHERE agency_id = ? AND product_id = ?').get(req.agency.id, p.id);
        if (!st || st.qty < qty) fail(409, `Stock insuffisant : ${p.name}`);
        db.prepare('UPDATE stock SET qty = qty - ? WHERE agency_id = ? AND product_id = ?').run(qty, req.agency.id, p.id);
      }
      total += qty * p.price_fc;
      return { p, qty };
    });
    const sid = db.prepare('INSERT INTO sales (agency_id, user_id, total_fc, pay_method) VALUES (?, ?, ?, ?)')
      .run(req.agency.id, req.user.id, total, method).lastInsertRowid;
    for (const l of lines) db.prepare('INSERT INTO sale_items (sale_id, product_id, qty, unit_price_fc) VALUES (?, ?, ?, ?)').run(sid, l.p.id, l.qty, l.p.price_fc);
    db.prepare(`INSERT INTO cash (holder_type, holder_id, sale_id, kind, method, amount_fc) VALUES ('agence', ?, ?, 'vente', ?, ?)`)
      .run(req.agency.id, sid, method, total);
    return { id: sid, total_fc: total };
  })();
  res.status(201).json(sale);
});

// Reçu imprimable.
r.get('/sales/:id/recu', (req, res) => {
  const s = db.prepare('SELECT * FROM sales WHERE id = ? AND agency_id = ?').get(req.params.id, req.agency.id) || fail(404, 'Vente introuvable');
  const items = db.prepare('SELECT i.*, p.name FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = ?').all(s.id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fc = (n) => `${Number(n).toLocaleString('fr-FR')} FC`;
  res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Reçu ${s.id}</title>
<link rel="stylesheet" href="/assets/label.css"></head><body><div class="receipt"><b>${esc(setting('company_name', 'Fenix Delivery'))}</b>
<div>${esc(req.agency.name)}</div><div>Reçu n° ${s.id} · ${esc(s.created_at)}</div><hr>
${items.map((i) => `<div class="line"><span>${i.qty} × ${esc(i.name)}</span><span>${fc(i.qty * i.unit_price_fc)}</span></div>`).join('')}
<hr><div class="line"><b>Total</b><b>${fc(s.total_fc)}</b></div><div>Payé : ${esc(s.pay_method)}</div><p>Merci !</p></div>
<script>window.print()</script></body></html>`);
});

// Scan d'arrivée au dépôt central (agences de type « agence » seulement).
r.post('/depot-scan', (req, res) => {
  if (req.agency.kind !== 'agence') fail(403, 'Le tri se fait au dépôt central');
  res.json(depotScan(mustGet(req.body.tracking), req.user));
});

// Un colis « à retirer » arrive dans cette agence.
r.post('/receive', (req, res) => res.json(agencyReceive(mustGet(req.body.tracking), req.user, req.agency)));

// Le destinataire vient chercher son colis avec son code.
r.post('/handover', (req, res) => {
  const s = mustGet(req.body.tracking);
  if (s.status !== 'disponible_agence' || s.pickup_agency_id !== req.agency.id) fail(409, 'Ce colis n’est pas disponible dans cette agence');
  res.json(handOver(s, req.user, { otp: req.body.otp, method: req.body.method, holder: { type: 'agence', id: req.agency.id } }));
});

r.post('/mailboxes', (req, res) => {
  const { number, holder_name, holder_phone, months = 12 } = req.body;
  if (!number || !holder_name || !holder_phone) fail(400, 'Numéro, titulaire et téléphone obligatoires');
  const d = new Date(); d.setMonth(d.getMonth() + Math.max(1, Number(months) || 12));
  try {
    db.prepare('INSERT INTO mailboxes (agency_id, number, holder_name, holder_phone, expires_on) VALUES (?, ?, ?, ?, ?)')
      .run(req.agency.id, String(number), holder_name, holder_phone, d.toISOString().slice(0, 10));
  } catch { fail(409, 'Cette boîte est déjà attribuée'); }
  res.status(201).json({ ok: true });
});

// Caisse du soir de l'agence.
r.post('/close', (req, res) => res.json(closeCash('agence', req.agency.id, Math.round(Number(req.body.given_cash_fc) || 0), req.body.note, req.user)));

export default r;
