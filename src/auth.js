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

// Jetons révoqués (déconnexion, changement de mot de passe), gardés jusqu'à leur expiration.
db.exec(`CREATE TABLE IF NOT EXISTS revoked_tokens (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`);
// Version des jetons d'un utilisateur : on l'augmente pour couper toutes ses sessions.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'token_version')) db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
export const TOKEN_TTL_S = 2 * 3600;          // 2 h, renouvelé automatiquement tant que la personne utilise l'appli
const REFRESH_AFTER_S = 30 * 60;

export const PASSWORD_MIN = 8, PASSWORD_MAX = 72;
export function checkPassword(p) {
  const s = String(p ?? '');
  if (s.length < PASSWORD_MIN) fail(400, `Mot de passe : ${PASSWORD_MIN} caractères minimum`);
  if (Buffer.byteLength(s) > PASSWORD_MAX) fail(400, `Mot de passe : ${PASSWORD_MAX} caractères maximum`);
  return s;
}

export function signToken(u) {
  const jti = crypto.randomUUID();
  const v = db.prepare('SELECT token_version FROM users WHERE id = ?').get(u.id)?.token_version ?? 0;
  return jwt.sign({ id: u.id, role: u.role, jti, v }, secret(), { expiresIn: TOKEN_TTL_S });
}
export function cookieOptions() {
  // strict : le cookie n'est jamais envoyé depuis un autre site (protection CSRF).
  return { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === '1', maxAge: TOKEN_TTL_S * 1000, path: '/' };
}
export function revoke(payload) {
  if (!payload?.jti) return;
  db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run(payload.jti, payload.exp || Math.floor(Date.now() / 1000) + TOKEN_TTL_S);
  db.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
}
/** Coupe toutes les sessions d'un utilisateur (après un changement de mot de passe). */
export function revokeAllFor(userId) {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
}

const DUMMY = bcrypt.hashSync('fenix-dummy-password', 12);
export async function login(phone, password) {
  const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(normPhone(phone));
  // On calcule toujours un hash (même si le compte n'existe pas) : même durée de réponse.
  const ok = await bcrypt.compare(String(password || '').slice(0, 200), u?.password_hash || DUMMY);
  if (!u || !ok) fail(401, 'Téléphone ou mot de passe incorrect');
  if (!u.active) {
    let st = null;
    try { st = db.prepare('SELECT status FROM driver_profiles WHERE user_id = ?').get(u.id)?.status; } catch { /* table absente */ }
    if (st === 'en_attente') fail(403, 'Votre candidature est en attente de validation par le bureau');
    if (st === 'refuse') fail(403, 'Votre candidature n’a pas été retenue');
    if (u.role === 'commercant') {
      const m = db.prepare('SELECT status FROM merchants WHERE id = ?').get(u.merchant_id);
      if (m?.status === 'en_attente') fail(403, 'Votre compte commerçant est en attente de validation par le bureau');
    }
    fail(401, 'Téléphone ou mot de passe incorrect');
  }
  return { token: signToken(u), user: publicUser(u) };
}

export const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, phone: u.phone, agency_id: u.agency_id, merchant_id: u.merchant_id, zone: u.zone
});

export function authenticate(req, res, next) {
  const raw = req.cookies?.kc || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (raw) {
    try {
      const p = jwt.verify(raw, secret());
      const revoked = p.jti && db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(p.jti);
      const found = !revoked && db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(p.id);
      const u = found && (p.v ?? 0) === (found.token_version ?? 0) ? found : null;
      if (u) {
        req.user = u; req.token = p;
        // Renouvellement glissant : un livreur en tournée n'est pas déconnecté toutes les 2 h.
        if (req.cookies?.kc && Date.now() / 1000 - p.iat > REFRESH_AFTER_S) {
          res.cookie('kc', signToken(u), cookieOptions());
        }
      }
    } catch { /* jeton expiré ou invalide : visiteur */ }
  }
  next();
}

export const need = (...roles) => (req, _res, next) => {
  if (!req.user) return next(Object.assign(new Error('Connexion requise'), { status: 401 }));
  if (roles.length && !roles.includes(req.user.role)) return next(Object.assign(new Error('Accès refusé'), { status: 403 }));
  next();
};

export const hash = (p) => bcrypt.hash(String(p), 12);
export const hashSync = (p) => bcrypt.hashSync(String(p), 12);
export const verifyPassword = (p, h) => bcrypt.compare(String(p ?? '').slice(0, 200), h);
