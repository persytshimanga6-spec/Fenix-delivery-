import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import { limits } from './limits.js';
import QRCode from 'qrcode';
import { db, setting, dataDir } from './db.js';
import { ensureBase, seedDemo } from './seed.js';
import { authenticate, need, login, publicUser, hash, normPhone, cookieOptions, signToken, revoke, revokeAllFor, checkPassword, verifyPassword } from './auth.js';
import { quote, fail, STATUS_LABELS, HttpError } from './logic.js';
import { createShipment, mustGet, publicTrack, amountDue, prepayTotal, submitPayment, ownsShipment } from './shipments.js';
import { MOBILE } from './logic.js';
import { isEmail, maskCodes } from './notify.js';
import { createDriver } from './drivers.js';
import { heatmap, clientQuote } from './pricing.js';
import driverRoutes from './routes/driver.js';
import adminRoutes from './routes/admin.js';
import agencyRoutes from './routes/agency.js';

ensureBase();
if (process.env.SEED_DEMO === '1') seedDemo();

export const app = express();
app.disable('x-powered-by');
// Seuls nginx (même machine ou réseau Docker privé) peut annoncer l'IP du visiteur.
app.set('trust proxy', ['loopback', 'uniquelocal']);
app.use(express.json({ limit: '1mb' }));
// Jamais de hachage (code, mot de passe) dans les réponses JSON.
app.set('json replacer', (k, v) => (k === 'otp_hash' || k === 'otp_salt' || k === 'password_hash' ? undefined : v));
app.use(cookieParser());

// ---------- En-têtes de sécurité (CSP avec nonce pour les scripts des pages) ----------
const HTTPS = process.env.COOKIE_SECURE === '1';
app.use((_req, res, next) => { res.locals.nonce = crypto.randomBytes(16).toString('base64'); next(); });
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.nonce}'`],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://basemaps.cartocdn.com', 'https://*.basemaps.cartocdn.com'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  strictTransportSecurity: HTTPS ? { maxAge: 31536000, includeSubDomains: false } : false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' }
}));

// CSRF : une requête qui change quelque chose doit venir du site lui-même (en plus du cookie sameSite=strict).
app.use((req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    let host = null; try { host = new URL(origin).host; } catch { /* origine illisible */ }
    if (host !== req.get('host')) return next(new HttpError(403, 'Origine refusée'));
  }
  next();
});
app.use(authenticate);

const root = path.resolve(import.meta.dirname, '..');
// Pages HTML : chaque <script> reçoit le nonce de la CSP.
const htmlCache = new Map();
function sendPage(res, file) {
  let html = htmlCache.get(file);
  if (html === undefined) { html = fs.readFileSync(file, 'utf8'); if (process.env.NODE_ENV === 'production') htmlCache.set(file, html); }
  res.type('html').set('Cache-Control', 'no-cache').send(html.replace(/<script(?=[\s>])/g, `<script nonce="${res.locals.nonce}"`));
}
const pub = path.join(root, 'public');
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let p = decodeURIComponent(req.path);
  if (p.includes('\0') || p.split('/').includes('..')) return next();
  if (p.endsWith('/')) p += 'index.html';
  const candidates = p.endsWith('.html') ? [p] : path.extname(p) ? [] : [`${p}.html`, `${p}/index.html`];
  for (const c of candidates) {
    const file = path.join(pub, c);
    if (file.startsWith(pub + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      if (!p.endsWith('/index.html') && c.endsWith('/index.html') && !req.path.endsWith('/')) return res.redirect(301, req.path + '/');
      return sendPage(res, file);
    }
  }
  next();
});
app.use(express.static(pub, { index: false }));
app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules/leaflet/dist')));
app.use('/vendor/html5-qrcode', express.static(path.join(root, 'node_modules/html5-qrcode')));

const api = express.Router();
app.use('/api', api);

// ---------- Public ----------
api.get('/config', (_req, res) => res.json({
  company: setting('company_name', 'Fenix Delivery'),
  communes: db.prepare('SELECT name, secteur FROM communes ORDER BY name').all(),
  agencies: db.prepare('SELECT id, name, kind, commune, address, lat, lng FROM agencies WHERE active = 1 ORDER BY name').all(),
  statuses: STATUS_LABELS,
  // Numéros Mobile Money de l'entreprise, pour payer avant le départ du colis.
  momo: Object.fromEntries(MOBILE.map((m) => [m, setting(`momo_${m}`, '')])),
  // Clé publique du fond de carte (visible dans les adresses des tuiles, comme toute clé de carte).
  map: { carto_key: setting('carto_api_key', '') || process.env.CARTO_API_KEY || '' }
}));

// Devis. Le client voit « Distance » (carburant + trafic regroupés) ; le personnel peut demander le détail (?detail=1).
api.post('/quote', limits.quote, (req, res) => {
  const q = quote({ ...req.body, cod_amount_fc: Number(req.body.cod_amount_fc) || 0, declared_value_fc: Number(req.body.declared_value_fc) || 0 });
  const staff = ['admin', 'agent'].includes(req.user?.role) && req.query.detail === '1';
  res.json(staff ? q : clientQuote(q));
});

// Carte « où sont les colis » (aide pour organiser les livreurs). Aucun effet sur le prix.
api.get('/heatmap', need('admin', 'agent'), (_req, res) => res.json({ communes: heatmap(), at: new Date().toISOString() }));

// Réservation en ligne par un client : le prix est payé avant le départ du colis.
// Lien de paiement envoyé au client d'un commerçant : livraison + marchandise, payées avant le départ.
// Preuve de possession : les 4 derniers chiffres du téléphone du destinataire (ou de l'expéditeur).
api.get('/pay/:t', limits.publicRead, (req, res) => {
  const s = mustGet(req.params.t);
  if (!ownsShipment(s, req.query.phone)) fail(403, 'Entrez les 4 derniers chiffres du téléphone du destinataire');
  const merchant = s.merchant_id ? db.prepare('SELECT name FROM merchants WHERE id = ?').get(s.merchant_id)?.name : null;
  res.json({ tracking: s.tracking, from: merchant || s.sender_name, to_commune: s.to_commune, status: s.payment_status,
    delivery_fc: s.pay_method === 'compte' ? 0 : s.price_fc, goods_fc: s.cod_amount_fc || 0, total_fc: prepayTotal(s),
    pay_method: s.pay_method, ref_sent: !!s.payment_ref,
    momo: Object.fromEntries(MOBILE.map((m) => [m, setting(`momo_${m}`, '')])) });
});
api.post('/pay/:t', limits.pay, (req, res) => {
  const s = submitPayment(mustGet(req.params.t), { phone: req.body.phone, method: req.body.pay_method, ref: req.body.payment_ref });
  res.json({ tracking: s.tracking, status: s.payment_status, payment_ref: s.payment_ref });
});
// Candidature « Devenir livreur » : compte créé en attente, validé par le bureau.
api.post('/drivers/apply', limits.signup, async (req, res) => {
  // Réponse toujours identique : on ne dit jamais si un numéro a déjà un compte.
  await createDriver(req.body, { silentIfExists: true });
  res.status(201).json({ ok: true, message: 'Candidature envoyée. Le bureau vous appellera après vérification.' });
});
api.post('/book', limits.book, async (req, res) => {
  const s = await createShipment(req.body, null, { public: true });
  // Le code de livraison part seulement par SMS au destinataire (jamais dans cette réponse).
  res.status(201).json({ tracking: s.tracking, price_fc: s.price_fc, quote: clientQuote(s.quote), pay_method: s.pay_method,
    payment_status: s.payment_status, payment_ref: s.payment_ref, momo_number: setting(`momo_${s.pay_method}`, '') || null });
});

// Suivi : sans preuve, seulement l'état du colis ; avec les 4 derniers chiffres d'un téléphone du colis, le détail (carte, livreur).
api.get('/track/:tracking', limits.publicRead, (req, res) => {
  const s = mustGet(req.params.tracking);
  res.json(publicTrack(s, { full: ownsShipment(s, req.query.phone) }));
});

api.post('/login', ...limits.login, async (req, res) => {
  const { token, user } = await login(req.body.phone, req.body.password);
  res.cookie('kc', token, cookieOptions());
  res.json({ user }); // jeton seulement dans le cookie httpOnly
});
api.post('/logout', (req, res) => { revoke(req.token); res.clearCookie('kc', { path: '/' }); res.json({ ok: true }); });
api.get('/me', need(), (req, res) => res.json({ user: publicUser(req.user) }));
// Mon compte : changer son nom et son numéro de connexion.
api.patch('/me', need(), (req, res) => {
  const b = req.body;
  if (b.phone) {
    const phone = normPhone(b.phone);
    if (!/^\+?\d{9,13}$/.test(phone)) fail(400, 'Numéro invalide (ex. 0812345678)');
    if (db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(phone, req.user.id)) fail(400, 'Numéro indisponible');
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.id);
  }
  if (b.name && String(b.name).trim()) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name).trim().slice(0, 80), req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});
api.post('/me/password', limits.sensitive, need(), async (req, res) => {
  const { password, current } = req.body;
  if (!current) fail(400, 'Mot de passe actuel obligatoire');
  const me = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(current, me.password_hash))) fail(400, 'Mot de passe actuel incorrect');
  const pw = checkPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hash(pw), req.user.id);
  // Toutes les autres sessions sont coupées ; celle-ci reçoit un nouveau jeton.
  revokeAllFor(req.user.id);
  res.cookie('kc', signToken(req.user), cookieOptions());
  res.json({ ok: true });
});

// Inscription d'un commerçant : compte « en attente » jusqu'à validation par l'administrateur.
api.post('/merchants/signup', limits.signup, async (req, res) => {
  const done = () => res.status(201).json({ ok: true, message: 'Demande reçue. Un agent vous appelle sous 24 h pour valider votre compte.' });
  const b = req.body;
  const phone = normPhone(b.phone);
  for (const [k, l] of [['name', 'Nom du commerce'], ['contact_name', 'Nom du responsable'], ['commune', 'Commune'], ['landmark', 'Repère']]) {
    if (!String(b[k] || '').trim()) fail(400, `${l} obligatoire`);
  }
  if (phone.length < 9) fail(400, 'Numéro de téléphone invalide');
  const pw = checkPassword(b.password);
  if (!db.prepare('SELECT 1 FROM communes WHERE name = ?').get(b.commune)) fail(400, 'Commune inconnue');
  if (!b.accept) fail(400, 'Vous devez accepter les conditions');
  if (b.email && !isEmail(b.email)) fail(400, 'Adresse e-mail invalide');
  // Numéro déjà utilisé : même réponse que pour une nouvelle demande (on ne révèle pas les comptes existants).
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) return done();
  const pwHash = await hash(pw);
  const mid = db.prepare(`INSERT INTO merchants (name, contact_name, phone, email, kind, volume, commune, landmark, lat, lng, payout_operator, payout_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    String(b.name).trim(), String(b.contact_name).trim(), phone, b.email ? String(b.email).trim().toLowerCase() : null, b.kind || null, b.volume || null, b.commune, String(b.landmark).trim(),
    Number(b.lat) || null, Number(b.lng) || null, b.payout_operator || null, normPhone(b.payout_number) || phone).lastInsertRowid;
  // Compte inactif jusqu'à la validation par le bureau.
  db.prepare("INSERT INTO users (role, name, phone, password_hash, merchant_id, active) VALUES ('commercant', ?, ?, ?, ?, 0)")
    .run(String(b.contact_name).trim(), phone, pwHash, mid);
  done();
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
  .map((n) => ({ ...n, message: maskCodes(n.message) }))));
merchant.get('/shipments', (req, res) => {
  const rows = db.prepare(`SELECT tracking, recipient_name, recipient_phone, to_commune, size, price_fc, pay_method, payment_status, cod_amount_fc, status, created_at
    FROM shipments WHERE merchant_id = ? ORDER BY id DESC LIMIT 500`).all(req.user.merchant_id);
  res.json(rows.map((r) => ({ ...r, label: STATUS_LABELS[r.status] })));
});
merchant.post('/shipments', async (req, res) => {
  const s = await createShipment(req.body, req.user);
  res.status(201).json({ ...s, quote: clientQuote(s.quote) });
});
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
</div><script nonce="${res.locals.nonce}">window.print()</script></body></html>`);
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
