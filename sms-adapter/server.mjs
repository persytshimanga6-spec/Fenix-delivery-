// Adaptateur SMS Fenix → Twilio.
// Fenix envoie POST /send {"to","message"} (avec « Authorization: Bearer SMS_WEBHOOK_TOKEN »).
// L'adaptateur met le numéro au format international (+243…) et appelle l'API Twilio Messages.
// Les clés Twilio vivent seulement dans l'environnement de ce service (jamais dans le dépôt).
// Le texte des SMS n'est jamais écrit dans les journaux (il peut contenir le code de livraison).
import http from 'node:http';
import crypto from 'node:crypto';

const env = (k, d = '') => (process.env[k] ?? d).trim();
const SID = env('TWILIO_ACCOUNT_SID');
const TOKEN = env('TWILIO_AUTH_TOKEN');
const FROM = env('TWILIO_FROM');                      // ex. FENIX (nom d'expéditeur) ou +1… (numéro Twilio)
const SERVICE = env('TWILIO_MESSAGING_SERVICE_SID');  // ou un « Messaging Service » (MG…)
const BEARER = env('SMS_WEBHOOK_TOKEN');
const CC = env('DEFAULT_COUNTRY_CODE', '243');
const HOST = env('HOST', '0.0.0.0');                  // dans Docker : le port n'est publié que sur le réseau privé
const PORT = Number(env('PORT', '3001'));
// Sans accents, un SMS tient en 160 caractères au lieu de 70 : 2 à 3 fois moins de SMS facturés.
const ASCII = env('SMS_ASCII', '1') === '1';
export const plain = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘]/g, "'").replace(/[«»“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/\u00a0|\u202f/g, ' ')
  .replace(/[^\x20-\x7e\n]/g, '');

if (!SID || !TOKEN || (!FROM && !SERVICE)) {
  console.error('Configuration manquante : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN et TWILIO_FROM (ou TWILIO_MESSAGING_SERVICE_SID).');
  process.exit(1);
}
if (!BEARER) console.warn('Attention : SMS_WEBHOOK_TOKEN est vide, /send n’est pas protégé par un jeton.');

/** Numéro Fenix → E.164. 0812345678, 812345678, 243812345678, 00243…, +243… → +243812345678. */
export function toE164(raw, cc = CC) {
  const s = String(raw ?? '').trim();
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (s.startsWith('+')) return /^\d{8,15}$/.test(d) ? `+${d}` : null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith(cc) && d.length === cc.length + 9) { /* déjà avec l'indicatif */ }
  else if (d.length === 10 && d.startsWith('0')) d = cc + d.slice(1);
  else if (d.length === 9) d = cc + d;
  else return null;
  return /^\d{8,15}$/.test(d) ? `+${d}` : null;
}

const mask = (n) => (n ? n.slice(0, 4) + '•••' + n.slice(-3) : '?');
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 16 * 1024) throw Object.assign(new Error('Message trop long'), { code: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON invalide'), { code: 400 }); }
}

async function sendTwilio(to, body) {
  const form = new URLSearchParams({ To: to, Body: body });
  if (SERVICE) form.set('MessagingServiceSid', SERVICE); else form.set('From', FROM);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID)}/Messages.json`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: form, signal: AbortSignal.timeout(15000)
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/send') return json(res, 404, { error: 'Introuvable' });
    if (BEARER && !safeEqual(req.headers.authorization || '', `Bearer ${BEARER}`)) return json(res, 401, { error: 'Jeton invalide' });
    const { to, message } = await readJson(req);
    const e164 = toE164(to);
    if (!e164) return json(res, 400, { error: 'Numéro invalide' });
    const text = (ASCII ? plain(message ?? '') : String(message ?? '')).slice(0, 1600);
    if (!text) return json(res, 400, { error: 'Message vide' });
    const t = await sendTwilio(e164, text);
    if (t.ok) {
      console.log(`[SMS] envoyé à ${mask(e164)} · ${t.data.sid} · ${t.data.status}`);
      return json(res, 200, { ok: true, sid: t.data.sid, status: t.data.status });
    }
    console.error(`[SMS] refusé par Twilio pour ${mask(e164)} · HTTP ${t.status} · code ${t.data.code} · ${t.data.message}`);
    return json(res, 502, { error: 'Refusé par Twilio', code: t.data.code ?? null });
  } catch (e) {
    console.error('[SMS] erreur :', e.message);
    return json(res, e.code === 400 || e.code === 413 ? e.code : 502, { error: e.code ? e.message : 'Erreur d’envoi' });
  }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => console.log(`Adaptateur SMS Fenix → Twilio sur ${HOST}:${PORT} (expéditeur : ${SERVICE ? 'Messaging Service' : FROM})`));
}
export { server };
