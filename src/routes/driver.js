// Appli livreur : sa tournée, ramassage, livraison, échec, position, sa caisse.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, dataDir } from '../db.js';
import { fail, STATUS_LABELS } from '../logic.js';
import { mustGet, move, handOver, failDelivery, amountDue, agencyReceive } from '../shipments.js';

const r = express.Router();
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(dataDir, 'photos'),
    filename: (_req, _f, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`)
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, f, cb) => cb(null, /^image\//.test(f.mimetype))
});

const mine = (req, t) => {
  const s = mustGet(t);
  if (s.driver_id !== req.user.id) fail(403, 'Ce colis n’est pas dans votre tournée');
  return s;
};
const pos = (b) => ({ lat: Number(b.lat) || null, lng: Number(b.lng) || null });

r.get('/shipments', (req, res) => {
  const rows = db.prepare(`SELECT s.*, a.name AS pickup_agency_name, a.lat AS pickup_agency_lat, a.lng AS pickup_agency_lng,
    d.name AS deposit_agency_name, d.lat AS deposit_agency_lat, d.lng AS deposit_agency_lng
    FROM shipments s LEFT JOIN agencies a ON a.id = s.pickup_agency_id LEFT JOIN agencies d ON d.id = s.agency_id
    WHERE s.driver_id = ? AND s.status IN ('cree','en_agence','ramasse','au_depot','en_livraison','echec')
    ORDER BY CASE s.status WHEN 'en_livraison' THEN 0 WHEN 'cree' THEN 1 WHEN 'en_agence' THEN 1 ELSE 2 END, s.express DESC, s.id`).all(req.user.id);
  const done = db.prepare(`SELECT COUNT(*) n FROM shipments WHERE driver_id = ? AND status IN ('livre','disponible_agence')
    AND date(delivered_at) = date('now')`).get(req.user.id).n;
  res.json({
    done_today: done,
    shipments: rows.map(({ otp_hash, ...s }) => ({ ...s, label: STATUS_LABELS[s.status], due: amountDue(s) }))
  });
});

// Ramassage chez l'expéditeur : scan du code QR.
r.post('/shipments/:t/pickup', (req, res) => {
  const s = mine(req, req.params.t);
  res.json(move(s, 'ramasse', req.user, { ...pos(req.body), note: s.status === 'en_agence' ? 'Ramassé à l’agence' : 'Ramassé chez l’expéditeur' }));
});

// Départ en livraison.
r.post('/shipments/:t/start', (req, res) => {
  const s = mine(req, req.params.t);
  res.json(move(s, 'en_livraison', req.user, pos(req.body)));
});

// Livraison avec code du destinataire, photo facultative, paiement.
r.post('/shipments/:t/deliver', upload.single('photo'), (req, res) => {
  const s = mine(req, req.params.t);
  if (s.status !== 'en_livraison') fail(409, 'Démarrez d’abord la livraison');
  if (s.pickup_agency_id) fail(409, 'Ce colis doit être déposé à l’agence de retrait');
  res.json(handOver(s, req.user, {
    otp: req.body.otp, method: req.body.method, photo: req.file?.filename || null, ...pos(req.body),
    holder: { type: 'livreur', id: req.user.id }
  }));
});

// Dépôt d'un colis « à retirer » dans son agence.
r.post('/shipments/:t/drop-agency', (req, res) => {
  const s = mine(req, req.params.t);
  const a = db.prepare('SELECT * FROM agencies WHERE id = ?').get(s.pickup_agency_id);
  if (!a) fail(409, 'Pas d’agence de retrait pour ce colis');
  res.json(agencyReceive(s, req.user, a));
});

r.post('/shipments/:t/fail', (req, res) => {
  const s = mine(req, req.params.t);
  res.json(failDelivery(s, req.user, String(req.body.reason || '').slice(0, 200), pos(req.body).lat, pos(req.body).lng));
});

r.post('/location', (req, res) => {
  const { lat, lng } = pos(req.body);
  if (lat == null || lng == null) fail(400, 'Position invalide');
  db.prepare("UPDATE users SET last_lat = ?, last_lng = ?, last_seen = datetime('now') WHERE id = ?").run(lat, lng, req.user.id);
  res.json({ ok: true });
});

// Argent que le livreur doit rendre ce soir.
r.get('/cash', (req, res) => {
  const rows = db.prepare(`SELECT method, SUM(amount_fc) total FROM cash
    WHERE holder_type = 'livreur' AND holder_id = ? AND closing_id IS NULL GROUP BY method`).all(req.user.id);
  res.json(rows);
});

export default r;
