// Limites de débit (connexion, inscriptions, suivi public, paiement, livraison…).
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { normPhone } from './auth.js';

const skipTests = () => process.env.NODE_ENV === 'test';
const tooMany = (msg) => (_req, res) => res.status(429).json({ error: msg });
const limiter = (windowMs, limit, msg, key) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: skipTests, handler: tooMany(msg), ...(key ? { keyGenerator: key } : {}) });
const ipKey = (req) => ipKeyGenerator(req.ip || '');
const ipPhoneKey = (req) => `${ipKey(req)}|${normPhone(req.body?.phone)}`;
const WAIT15 = 'Trop d’essais. Réessayez dans 15 minutes.', WAIT60 = 'Trop d’essais. Réessayez dans une heure.';
export const limits = {
  // Connexion : 5 essais / 15 min par IP + téléphone, puis blocage plus long (15 essais / heure par IP).
  login: [limiter(15 * 60e3, 5, WAIT15, ipPhoneKey), limiter(60 * 60e3, 15, WAIT60, ipKey)],
  sensitive: limiter(60 * 60e3, 5, WAIT60, ipKey),
  signup: limiter(60 * 60e3, 5, WAIT60, ipKey),
  book: limiter(60 * 60e3, 10, WAIT60, ipKey),
  pay: limiter(60 * 60e3, 20, WAIT60, ipKey),
  publicRead: limiter(60 * 60e3, 30, WAIT60, ipKey),
  quote: limiter(60e3, 60, 'Trop de demandes. Réessayez dans une minute.', ipKey),
  route: limiter(60 * 60e3, 600, WAIT60, (req) => `route:${req.user?.id || ipKey(req)}`),
  deliver: limiter(60 * 60e3, 20, WAIT60, (req) => `livreur:${req.user?.id || ipKey(req)}`),
  resend: limiter(60 * 60e3, 10, WAIT60, (req) => `admin:${req.user?.id || ipKey(req)}`)
};

