// Candidatures des livreurs : formulaire public « Postuler », validation par le bureau.
import { db, tx } from './db.js';
import { fail } from './logic.js';
import { hash, normPhone } from './auth.js';
import { isEmail } from './notify.js';

db.exec(`CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  last_name TEXT NOT NULL, post_name TEXT NOT NULL, first_name TEXT NOT NULL,
  address TEXT NOT NULL, birth_year INTEGER NOT NULL, email TEXT NOT NULL,
  license_no TEXT NOT NULL,
  disability INTEGER NOT NULL, disability_note TEXT,
  criminal_record INTEGER NOT NULL,                 -- déclaration du candidat : 1 = oui
  experience_years INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'en_attente',        -- en_attente | valide | refuse
  decided_by INTEGER REFERENCES users(id), decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

export const MIN_AGE = 18, MIN_EXPERIENCE = 2;
const txt = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const yesNo = (v, label) => {
  if (v === true || v === 'oui' || v === '1' || v === 1) return 1;
  if (v === false || v === 'non' || v === '0' || v === 0) return 0;
  return fail(400, `${label} : répondez Oui ou Non`);
};
export const fullName = (p) => [p.last_name, p.post_name, p.first_name].filter(Boolean).join(' ');

/** Vérifie et nettoie les champs du formulaire livreur. Tous obligatoires. */
export function checkDriverForm(b) {
  const p = {
    last_name: txt(b.last_name, 60), post_name: txt(b.post_name, 60), first_name: txt(b.first_name, 60),
    phone: normPhone(b.phone), password: String(b.password || ''), address: txt(b.address, 300),
    birth_year: Number(b.birth_year), email: txt(b.email, 120).toLowerCase(), license_no: txt(b.license_no, 40),
    experience_years: Number(b.experience_years),
    driver_kind: b.driver_kind || 'salarie'
  };
  if (!['salarie', 'independant'].includes(p.driver_kind)) fail(400, 'Type de chauffeur : salarié ou indépendant');
  for (const [k, l] of [['last_name', 'Nom'], ['post_name', 'Post-nom'], ['first_name', 'Prénom'], ['phone', 'Téléphone'],
    ['address', 'Adresse'], ['email', 'E-mail'], ['license_no', 'Numéro du permis de conduire']]) {
    if (!p[k]) fail(400, `${l} obligatoire`);
  }
  if (!/^\+?\d{9,13}$/.test(p.phone)) fail(400, 'Numéro de téléphone invalide');
  if (p.password.length < 6) fail(400, 'Mot de passe : 6 caractères minimum');
  if (!isEmail(p.email)) fail(400, 'Adresse e-mail invalide');
  const year = new Date().getFullYear();
  if (!Number.isInteger(p.birth_year) || p.birth_year < year - 90 || p.birth_year > year) fail(400, 'Année de naissance invalide');
  if (year - p.birth_year < MIN_AGE) fail(400, `Il faut avoir ${MIN_AGE} ans ou plus`);
  if (!Number.isInteger(p.experience_years) || p.experience_years < 0 || p.experience_years > 60) fail(400, 'Années d’expérience de conduite invalides');
  if (p.experience_years < MIN_EXPERIENCE) fail(400, `Il faut au moins ${MIN_EXPERIENCE} ans d’expérience de conduite`);
  p.disability = yesNo(b.disability, 'Handicap');
  p.disability_note = p.disability ? txt(b.disability_note, 300) : null;
  if (p.disability && !p.disability_note) fail(400, 'Handicap : précisez');
  p.criminal_record = yesNo(b.criminal_record, 'Antécédent criminel');
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(p.phone)) fail(409, 'Ce numéro a déjà un compte');
  return p;
}

/** Crée le compte livreur et sa fiche. `validated` : ajouté par le bureau (actif tout de suite). */
export function createDriver(b, { validated = false, by = null, zone = null } = {}) {
  const p = checkDriverForm(b);
  return tx(() => {
    const id = db.prepare(`INSERT INTO users (role, name, phone, password_hash, zone, active, driver_kind) VALUES ('livreur', ?, ?, ?, ?, ?, ?)`)
      .run(fullName(p), p.phone, hash(p.password), zone || null, validated ? 1 : 0, p.driver_kind).lastInsertRowid;
    db.prepare(`INSERT INTO driver_profiles (user_id, last_name, post_name, first_name, address, birth_year, email, license_no,
      disability, disability_note, criminal_record, experience_years, status, decided_by, decided_at)
      VALUES (@id, @last_name, @post_name, @first_name, @address, @birth_year, @email, @license_no,
      @disability, @disability_note, @criminal_record, @experience_years, @status, @by, @at)`)
      .run({ ...p, id, status: validated ? 'valide' : 'en_attente', by, at: validated ? new Date().toISOString() : null });
    return id;
  })();
}

export function decide(userId, decision, by, zone = null) {
  if (!['valide', 'refuse'].includes(decision)) fail(400, 'Décision invalide');
  const p = db.prepare('SELECT * FROM driver_profiles WHERE user_id = ?').get(userId) || fail(404, 'Candidature introuvable');
  tx(() => {
    db.prepare('UPDATE driver_profiles SET status = ?, decided_by = ?, decided_at = ? WHERE user_id = ?').run(decision, by, new Date().toISOString(), userId);
    db.prepare('UPDATE users SET active = ?, zone = COALESCE(?, zone) WHERE id = ?').run(decision === 'valide' ? 1 : 0, zone || null, userId);
  })();
  return { ...p, status: decision };
}
