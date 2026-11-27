import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import QRCode from 'qrcode';
import { db, setting, dataDir } from './db.js';
import { ensureBase, seedDemo } from './seed.js';
import { authenticate, need, login, publicUser, hash, normPhone } from './auth.js';
import { quote, fail, STATUS_LABELS, HttpError } from './logic.js';
import { createShipment, mustGet, publicTrack, amountDue } from './shipments.js';
import { isEmail } from './notify.js';
import { heatmap, traffic } from './pricing.js';
import driverRoutes from './routes/driver.js';
import adminRoutes from './routes/admin.js';
import agencyRoutes from './routes/agency.js';

ensureBase();
if (process.env.SEED_DEMO === '1') seedDemo();

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(authenticate);
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

const root = path.resolve(import.meta.dirname, '..');
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules/leaflet/dist')));
app.use('/vendor/html5-qrcode', express.static(path.join(root, 'node_modules/html5-qrcode')));

const api = express.Router();
app.use('/api', api);

// ---------- Public ----------
api.get('/config', (_req, res) => res.json({
  company: setting('company_name', 'Fenix Delivery'),
  communes: db.prepare('SELECT name, secteur FROM communes ORDER BY name').all(),
  agencies: db.prepare('SELECT id, name, kind, commune, address, lat, lng FROM agencies WHERE active = 1 ORDER BY name').all(),
  statuses: STATUS_LABELS
}));

api.post('/quote', (req, res) => res.json(quote({
  ...req.body, cod_amount_fc: Number(req.body.cod_amount_fc) || 0, declared_value_fc: Number(req.body.declared_value_fc) || 0
})));

// Carte des zones occupées (livreurs, commerçants, agences, back office).
api.get('/heatmap', need('livreur', 'admin', 'agent', 'commercant'), (_req, res) => res.json({ communes: heatmap(), traffic: traffic(), at: new Date().toISOString() }));

api.get('/track/:tracking', (req, res) => res.json(publicTrack(mustGet(req.params.tracking))));

api.post('/login', (req, res) => {
  const { token, user } = login(req.body.phone, req.body.password);
  res.cookie('kc', token, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 12 * 3600e3 });
  res.json({ user, token });
});
api.post('/logout', (_req, res) => { res.clearCookie('kc'); res.json({ ok: true }); });
api.get('/me', need(), (req, res) => res.json({ user: publicUser(req.user) }));
api.post('/me/password', need(), (req, res) => {
  const { password } = req.body;
  if (!password || String(password).length < 6) fail(400, 'Mot de passe : 6 caractères minimum');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash(password), req.user.id);
  res.json({ ok: true });
});

// Inscription d'un commerçant : compte « en attente » jusqu'à validation par l'administrateur.
api.post('/merchants/signup', (req, res) => {
  const b = req.body;
  const phone = normPhone(b.phone);
  for (const [k, l] of [['name', 'Nom du commerce'], ['contact_name', 'Nom du responsable'], ['commune', 'Commune'], ['landmark', 'Repère']]) {
    if (!String(b[k] || '').trim()) fail(400, `${l} obligatoire`);
  }
  if (phone.length < 9) fail(400, 'Numéro de téléphone invalide');
  if (!b.password || String(b.password).length < 6) fail(400, 'Mot de passe : 6 caractères minimum');
  if (!db.prepare('SELECT 1 FROM communes WHERE name = ?').get(b.commune)) fail(400, 'Commune inconnue');
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) fail(409, 'Ce numéro a déjà un compte');
  if (!b.accept) fail(400, 'Vous devez accepter les conditions');
  if (b.email && !isEmail(b.email)) fail(400, 'Adresse e-mail invalide');
  const mid = db.prepare(`INSERT INTO merchants (name, contact_name, phone, email, kind, volume, commune, landmark, lat, lng, payout_operator, payout_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    String(b.name).trim(), String(b.contact_name).trim(), phone, b.email ? String(b.email).trim().toLowerCase() : null, b.kind || null, b.volume || null, b.commune, String(b.landmark).trim(),
    Number(b.lat) || null, Number(b.lng) || null, b.payout_operator || null, normPhone(b.payout_number) || phone).lastInsertRowid;
  db.prepare("INSERT INTO users (role, name, phone, password_hash, merchant_id) VALUES ('commercant', ?, ?, ?, ?)")
    .run(String(b.contact_name).trim(), phone, hash(b.password), mid);
  res.status(201).json({ ok: true, message: 'Demande reçue. Un agent vous appelle sous 24 h pour valider votre compte.' });
});

// ---------- Commerçant ----------
const merchant = express.Router();
api.use('/merchant', need('commercant'), merchant);
merchant.get('/profile', (req, res) => res.json(db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.user.merchant_id)));
// Mon compte : e-mail et choix des notifications automatiques.
merchant.patch('/profile', (req, res) => {
  const b = req.body, id = req.user.merchant_id;
  if ('email' in b) {
    if (b.email && !isEmail(b.email)) fail(400, 'Adresse e-mail invalide');
    db.prepare('UPDATE merchants SET email = ? WHERE id = ?').run(b.email ? String(b.email).trim().toLowerCase() : null, id);
  }
  if ('notify_sms' in b) db.prepare('UPDATE merchants SET notify_sms = ? WHERE id = ?').run(b.notify_sms ? 1 : 0, id);
  if ('notify_email' in b) db.prepare('UPDATE merchants SET notify_email = ? WHERE id = ?').run(b.notify_email ? 1 : 0, id);
  for (const k of ['contact_name', 'landmark']) if (b[k] && String(b[k]).trim()) db.prepare(`UPDATE merchants SET ${k} = ? WHERE id = ?`).run(String(b[k]).trim().slice(0, 200), id);
  res.json(db.prepare('SELECT * FROM merchants WHERE id = ?').get(id));
});
// Les messages envoyés au commerçant et à ses clients.
merchant.get('/notifications', (req, res) => res.json(db.prepare(`SELECT n.id, n.channel, n.to_addr, n.subject, n.message, n.audience, n.status, n.created_at, s.tracking
  FROM notifications n LEFT JOIN shipments s ON s.id = n.shipment_id
  WHERE n.merchant_id = ? OR s.merchant_id = ? ORDER BY n.id DESC LIMIT 200`).all(req.user.merchant_id, req.user.merchant_id)
  // Le code de livraison reste secret : seul le client le voit.
  .map((n) => ({ ...n, message: n.message.replace(/(code de livraison[^:]*: )\d{4}/gi, '$1••••') }))));
merchant.get('/shipments', (req, res) => {
  const rows = db.prepare(`SELECT tracking, recipient_name, recipient_phone, to_commune, size, price_fc, pay_method, cod_amount_fc, status, created_at
    FROM shipments WHERE merchant_id = ? ORDER BY id DESC LIMIT 500`).all(req.user.merchant_id);
  res.json(rows.map((r) => ({ ...r, label: STATUS_LABELS[r.status] })));
});
merchant.post('/shipments', async (req, res) => res.status(201).json(await createShipment(req.body, req.user)));
merchant.get('/summary', (req, res) => {
  const id = req.user.merchant_id;
  res.json({
    to_receive_fc: db.prepare("SELECT COALESCE(SUM(amount_fc),0) v FROM payouts WHERE merchant_id = ? AND status = 'a_reverser'").get(id).v,
    paid_fc: db.prepare("SELECT COALESCE(SUM(amount_fc),0) v FROM payouts WHERE merchant_id = ? AND status = 'reverse'").get(id).v,
    unpaid_shipping_fc: db.prepare("SELECT COALESCE(SUM(price_fc),0) v FROM shipments WHERE merchant_id = ? AND pay_method = 'compte' AND shipping_paid = 0 AND status NOT IN ('annule')").get(id).v
  });
});

// Étiquette à imprimer (commerçant propriétaire, agents, administrateur)
app.get('/etiquette/:tracking', need(), async (req, res) => {
  const s = mustGet(req.params.tracking);
  const u = req.user;
  if (u.role === 'commercant' && s.merchant_id !== u.merchant_id) fail(403, 'Accès refusé');
  if (u.role === 'livreur') fail(403, 'Accès refusé');
  const qr = await QRCode.toDataURL(s.tracking, { margin: 1, width: 220 });
  const due = amountDue(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Étiquette ${esc(s.tracking)}</title>
<link rel="stylesheet" href="/assets/label.css"></head><body><div class="label">
<div class="top"><b>${esc(setting('company_name', 'Fenix Delivery'))}</b><span>${s.express ? 'EXPRESS' : 'Zone ' + s.zone}</span></div>
<div class="row"><img src="${qr}" alt="QR ${esc(s.tracking)}"><div><div class="trk">${esc(s.tracking)}</div>
<div class="big">${esc(String(s.to_commune).toUpperCase())}</div><div>Taille : ${esc(s.size)}</div></div></div>
<div class="box"><small>DE</small><div>${esc(s.sender_name)} · ${esc(s.sender_phone)}</div><div>${esc(s.from_commune)} · ${esc(s.from_landmark)}</div></div>
<div class="box"><small>À</small><div><b>${esc(s.recipient_name)}</b> · ${esc(s.recipient_phone)}</div><div>${esc(s.to_commune)} · ${esc(s.to_landmark || 'Retrait en agence')}</div></div>
<div class="due">${due.total ? 'À ENCAISSER : ' + due.total.toLocaleString('fr-FR') + ' FC' : 'DÉJÀ PAYÉ'}</div>
</div><script>window.print()</script></body></html>`);
});

app.use('/photos', need('admin', 'agent'), express.static(path.join(dataDir, 'photos')));

api.use('/driver', need('livreur'), driverRoutes);
api.use('/admin', need('admin'), adminRoutes);
api.use('/agency', need('agent', 'admin'), agencyRoutes);

api.use((_req, _res, next) => next(new HttpError(404, 'Introuvable')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  const message = status >= 500 ? 'Erreur du serveur' : err.message;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).type('text').send(message);
});

const port = Number(process.env.PORT) || 3000;
if (process.env.NO_LISTEN !== '1') {
  app.listen(port, () => console.log(`${setting('company_name', 'Fenix Delivery')} en marche sur http://localhost:${port}`));
}
