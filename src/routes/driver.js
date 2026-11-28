// Appli livreur : sa tournée, ramassage, livraison, échec, position, sa caisse.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { limits } from '../limits.js';
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
  fileFilter: (_req, f, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif)$/.test(f.mimetype))
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

// Itinéraire routier pour le guidage dans l'appli (OSRM gratuit, sans clé). Le serveur fait la demande :
// une seule adresse autorisée par la CSP, et une réponse courte pour le téléphone. Si OSRM ne répond pas : 502,
// l'appli trace alors une ligne droite et garde Google Maps (la livraison n'est jamais bloquée).
const routeCache = new Map();
r.get('/route', limits.route, async (req, res) => {
  const pt = (v) => { const [lat, lng] = String(v || '').split(',').map(Number); return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null; };
  const from = pt(req.query.from), to = pt(req.query.to);
  if (!from || !to) fail(400, 'Positions de départ et d’arrivée obligatoires');
  const key = [from.lat, from.lng, to.lat, to.lng].map((x) => x.toFixed(4)).join(',');
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < 120e3) return res.json(hit.data);
  const base = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
  let j;
  try {
    const r = await fetch(`${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`,
      { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'FenixDelivery/1.0' } });
    j = r.ok ? await r.json() : null;
  } catch { j = null; }
  const route = j?.code === 'Ok' && j.routes?.[0];
  if (!route) return res.status(502).json({ error: 'Itinéraire indisponible pour le moment' }); // l'écran trace alors la ligne droite
  const data = {
    distance: route.distance, duration: route.duration,
    coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    steps: route.legs.flatMap((l) => l.steps).map((s) => ({
      type: s.maneuver.type, modifier: s.maneuver.modifier || null, exit: s.maneuver.exit || null,
      name: s.name || s.ref || '', distance: s.distance, duration: s.duration,
      lat: s.maneuver.location[1], lng: s.maneuver.location[0]
    }))
  };
  routeCache.set(key, { at: Date.now(), data });
  if (routeCache.size > 500) routeCache.delete(routeCache.keys().next().value);
  res.json(data);
});

// Vérifie le vrai contenu du fichier (pas seulement son type annoncé) : JPEG, PNG, WebP ou HEIC.
function isImage(file) {
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(12);
  try { fs.readSync(fd, b, 0, 12, 0); } finally { fs.closeSync(fd); }
  return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)                                   // JPEG
    || b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) // PNG
    || (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')      // WebP
    || (b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)$/.test(b.toString('latin1', 8, 12))); // HEIC
}
const drop = (f) => { if (f?.path) fs.unlink(f.path, () => {}); };

// Livraison : code du destinataire + photo, tous les deux obligatoires.
// Les contrôles (tournée, statut) passent AVANT l'envoi de la photo ; la photo est supprimée si la remise échoue.
r.post('/shipments/:t/deliver', limits.deliver, (req, _res, next) => {
  const s = mine(req, req.params.t);
  if (s.status !== 'en_livraison') fail(409, 'Démarrez d’abord la livraison');
  if (s.pickup_agency_id) fail(409, 'Ce colis doit être déposé à l’agence de retrait');
  next();
}, upload.single('photo'), (req, res) => {
  try {
    if (!req.file) fail(400, 'Photo du colis remis obligatoire');
    if (!isImage(req.file.path)) fail(400, 'La photo doit être une image JPEG, PNG, WebP ou HEIC');
    const s = mine(req, req.params.t);
    res.json(handOver(s, req.user, {
      otp: req.body.otp, method: req.body.method, photo: req.file.filename, ...pos(req.body),
      holder: { type: 'livreur', id: req.user.id }
    }));
  } catch (e) { drop(req.file); throw e; }
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
