import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { fail } from './logic.js';

// Clé secrète : variable d'environnement, sinon générée une fois et gardée dans la base.
function secret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  let r = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
  if (!r) {
    const v = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)").run(v);
    r = { value: v };
  }
  return r.value;
}

export const normPhone = (p) => String(p || '').replace(/[^\d+]/g, '');

export function login(phone, password) {
  const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(normPhone(phone));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) fail(401, 'Téléphone ou mot de passe incorrect');
  if (!u.active) {
    // Candidature de livreur pas encore validée (ou refusée) : pas de connexion.
    let st = null;
    try { st = db.prepare('SELECT status FROM driver_profiles WHERE user_id = ?').get(u.id)?.status; } catch { /* table absente */ }
    if (st === 'en_attente') fail(403, 'Votre candidature est en attente de validation par le bureau');
    if (st === 'refuse') fail(403, 'Votre candidature n’a pas été retenue');
    fail(401, 'Téléphone ou mot de passe incorrect');
  }
  const token = jwt.sign({ id: u.id, role: u.role }, secret(), { expiresIn: '12h' });
  return { token, user: publicUser(u) };
}

export const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, phone: u.phone, agency_id: u.agency_id, merchant_id: u.merchant_id, zone: u.zone
});

export function authenticate(req, _res, next) {
  const raw = req.cookies?.kc || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (raw) {
    try {
      const p = jwt.verify(raw, secret());
      const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(p.id);
      if (u) req.user = u;
    } catch { /* jeton expiré ou invalide : visiteur */ }
  }
  next();
}

export const need = (...roles) => (req, _res, next) => {
  if (!req.user) return next(Object.assign(new Error('Connexion requise'), { status: 401 }));
  if (roles.length && !roles.includes(req.user.role)) return next(Object.assign(new Error('Accès refusé'), { status: 403 }));
  next();
};

export const hash = (p) => bcrypt.hashSync(String(p), 10);
