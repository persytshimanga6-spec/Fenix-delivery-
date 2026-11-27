// Notifications automatiques par SMS et par e-mail, au client (destinataire) et au vendeur (commerçant ou expéditeur).
// Sans fournisseur configuré, chaque message est quand même enregistré (Back office › Notifications).
import nodemailer from 'nodemailer';
import { db, setting } from './db.js';

const company = () => setting('company_name', 'Fenix Delivery');
const publicUrl = () => process.env.PUBLIC_URL || 'http://localhost:3000';
const fc = (n) => `${Number(n || 0).toLocaleString('fr-FR')} FC`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

let transport = null;
if (process.env.SMTP_HOST) {
  const port = Number(process.env.SMTP_PORT) || 587;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

function record(channel, to, subject, message, meta, status, error = null) {
  return db.prepare(`INSERT INTO notifications (channel, to_addr, subject, message, shipment_id, merchant_id, audience, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(channel, to, subject, message, meta.shipment_id ?? null, meta.merchant_id ?? null,
    meta.audience ?? null, status, error).lastInsertRowid;
}
const setStatus = (id, status, error = null) => db.prepare('UPDATE notifications SET status = ?, error = ? WHERE id = ?').run(status, error, id);

export async function sendSms(phone, message, meta = {}) {
  if (!phone) return;
  const url = process.env.SMS_WEBHOOK_URL;
  const id = record('sms', phone, null, message, meta, url ? 'envoi' : 'enregistre');
  if (!url) { if (process.env.NODE_ENV !== 'test') console.log(`[SMS] ${phone} : ${message}`); return; }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.SMS_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}) },
      body: JSON.stringify({ to: phone, message })
    });
    setStatus(id, r.ok ? 'envoye' : 'echec', r.ok ? null : `HTTP ${r.status}`);
  } catch (e) { setStatus(id, 'echec', e.message); }
}

function emailHtml(subject, lines, link) {
  const name = esc(company());
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#110B06;font-family:Arial,Helvetica,sans-serif;color:#E5D6C2">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<div style="font-size:22px;font-weight:800;color:#F5EDE2;margin-bottom:18px">${name.replace(/Delivery$/, '<span style="color:#F0905A">Delivery</span>')}</div>
<div style="background:#1A120B;border:1px solid #3A2B1D;border-radius:14px;padding:22px">
<div style="font-family:'Courier New',monospace;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#F0905A;margin-bottom:10px">Notification</div>
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.2;color:#F5EDE2">${esc(subject)}</h1>
${lines.map((l) => `<p style="margin:0 0 10px;font-size:15px;line-height:1.5">${esc(l)}</p>`).join('')}
${link ? `<p style="margin:18px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#F0905A;color:#110B06;font-weight:700;text-decoration:none;padding:12px 18px;border-radius:10px">Suivre le colis</a></p>` : ''}
</div><p style="font-size:12px;color:#A89A88;margin-top:16px">${name} · Kinshasa, RDC</p></div></body></html>`;
}

export async function sendEmail(to, subject, lines, meta = {}, link = null) {
  if (!isEmail(to)) return;
  const text = lines.join('\n') + (link ? `\n\nSuivi : ${link}` : '');
  const id = record('email', to, subject, text, meta, transport ? 'envoi' : 'enregistre');
  if (!transport) { if (process.env.NODE_ENV !== 'test') console.log(`[E-MAIL] ${to} : ${subject}`); return; }
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html: emailHtml(subject, lines, link) });
    setStatus(id, 'envoye');
  } catch (e) { setStatus(id, 'echec', e.message); }
}

const prepay = (s) => (s.pay_method === 'compte' ? 0 : s.price_fc) + (s.cod_amount_fc || 0);
const MOMO = { mpesa: ['M-Pesa', 'momo_mpesa'], orange: ['Orange Money', 'momo_orange'], airtel: ['Airtel Money', 'momo_airtel'] };
function payHint(s) {
  if (s.pay_method === 'cash') return `Paiement en attente : payez ${fc(s.price_fc)} en espèces au comptoir d'une agence ${company()}. Le colis partira après le paiement.`;
  const [name, key] = MOMO[s.pay_method] || ['Mobile Money', ''];
  const nb = key ? setting(key, '') : '';
  return `Paiement ${name} en attente de vérification (réf. ${s.payment_ref || '—'}${nb ? `, numéro ${nb}` : ''}). Le colis partira dès que le paiement est confirmé.`;
}

// Le vendeur : le commerçant (avec ses préférences) ou l'expéditeur venu au comptoir.
function seller(s) {
  if (s.merchant_id) {
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(s.merchant_id);
    if (m) return { phone: m.phone, email: m.email, sms: !!m.notify_sms, mail: !!m.notify_email, merchant_id: m.id };
  }
  return { phone: s.sender_phone, email: s.sender_email, sms: true, mail: true, merchant_id: null };
}

async function both(who, subject, lines, meta, link) {
  const msg = `${company()} : ${lines.join(' ')}${link ? ` Suivi : ${link}` : ''}`;
  const tasks = [];
  if (who.sms !== false && who.phone) tasks.push(sendSms(who.phone, msg, meta));
  if (who.mail !== false && who.email) tasks.push(sendEmail(who.email, subject, lines, meta, link));
  await Promise.all(tasks);
}

/** Envoie les messages qui vont avec une étape du colis. */
export async function notifyShipment(s, event, extra = {}) {
  const link = `${publicUrl()}/suivi.html?n=${s.tracking}`;
  const R = { phone: s.recipient_phone, email: s.recipient_email };
  const S = seller(s);
  const mR = { shipment_id: s.id, audience: 'client' };
  const mS = { shipment_id: s.id, merchant_id: S.merchant_id, audience: 'vendeur' };
  const due = s.payment_status ? 0 : (s.pay_method === 'cod' && !s.shipping_paid ? s.price_fc : 0) + (s.cod_amount_fc || 0); // tout est payé d'avance (sauf anciens colis)
  const agency = s.pickup_agency_id ? db.prepare('SELECT name, address, commune FROM agencies WHERE id = ?').get(s.pickup_agency_id) : null;
  const jobs = [];
  switch (event) {
    case 'cree':
      jobs.push(both(R, `Un colis arrive pour vous – ${s.tracking}`, [
        `Un colis de ${s.sender_name} arrive pour vous (${s.tracking}).`,
        `Code de livraison : ${extra.otp}. Donnez-le seulement quand vous avez le colis en main.`,
        ...(s.cod_amount_fc && s.payment_status === 'en_attente' ? [
          `Avant l'envoi, payez ${fc(prepay(s))} (livraison ${fc(s.price_fc)} + marchandise ${fc(s.cod_amount_fc)}) ici : ${publicUrl()}/payer.html?n=${s.tracking}`] : []),
        ...(due ? [`À payer à la réception : ${fc(due)}.`] : [])], mR, link));
      jobs.push(both(S, `Envoi enregistré – ${s.tracking}`, [
        `Envoi ${s.tracking} enregistré pour ${s.recipient_name} (${s.to_commune}). Prix : ${fc(s.price_fc)}.`,
        ...(s.cod_amount_fc && s.payment_status === 'en_attente'
          ? [`Votre client a reçu le lien pour payer ${fc(prepay(s))} (livraison + marchandise). Le colis partira après son paiement.`]
          : s.payment_status === 'en_attente' ? [payHint(s)] : [])], mS, link));
      break;
    case 'paiement':
      if (s.cod_amount_fc) {
        jobs.push(both(R, `Paiement reçu – ${s.tracking}`, [`Paiement de ${fc(prepay(s))} reçu. Votre colis ${s.tracking} va partir.`], mR, link));
        jobs.push(both(S, `Votre client a payé – ${s.tracking}`, [
          `Votre client a payé l'envoi ${s.tracking}. La marchandise (${fc(s.cod_amount_fc)}) vous sera reversée en entier sous 48 h après la livraison.`], mS, link));
      } else {
        jobs.push(both(S, `Paiement reçu – ${s.tracking}`, [
          `Paiement de ${fc(s.price_fc)} reçu pour l'envoi ${s.tracking}. Votre colis peut partir.`], mS, link));
      }
      break;
    case 'ramasse':
      jobs.push(both(S, `Colis ramassé – ${s.tracking}`, [`Votre colis ${s.tracking} a été ramassé par notre livreur.`], mS, link));
      break;
    case 'en_livraison':
      if (s.pickup_agency_id) break; // le client sera prévenu quand le colis arrive en agence
      jobs.push(both(R, `Votre colis est en route – ${s.tracking}`, [
        `Votre colis ${s.tracking} est en route vers vous.`,
        `Préparez votre code de livraison${due ? ` et ${fc(due)}` : ''}.`], mR, link));
      jobs.push(both(S, `En livraison – ${s.tracking}`, [`Le colis ${s.tracking} est en livraison vers ${s.recipient_name}.`], mS, link));
      break;
    case 'livre':
    case 'retire': {
      const how = event === 'livre' ? 'livré' : 'retiré en agence';
      jobs.push(both(R, `Colis ${how} – ${s.tracking}`, [`Votre colis ${s.tracking} a été ${how}. Merci d'avoir choisi ${company()} !`], mR, null));
      jobs.push(both(S, `Colis ${how} – ${s.tracking}`, [
        `Le colis ${s.tracking} a été ${how} à ${s.recipient_name}.`,
        ...(s.cod_amount_fc ? [`Marchandise payée d'avance : ${fc(s.cod_amount_fc)} reversés sur votre compte sous 48 h.`] : [])], mS, link));
      break;
    }
    case 'echec':
      jobs.push(both(R, `Livraison manquée – ${s.tracking}`, [
        `Nous n'avons pas pu livrer votre colis ${s.tracking} (${extra.note || 'raison non précisée'}).`,
        'Nous repasserons. Appelez-nous pour convenir d’un moment.'], mR, link));
      jobs.push(both(S, `Échec de livraison – ${s.tracking}`, [
        `Échec de livraison pour ${s.tracking} : ${extra.note || 'raison non précisée'}. Une nouvelle tentative sera planifiée.`], mS, link));
      break;
    case 'disponible_agence':
      jobs.push(both(R, `Votre colis vous attend – ${s.tracking}`, [
        `Votre colis ${s.tracking} vous attend à ${agency?.name || 'l’agence'} (${agency?.address || agency?.commune || ''}).`,
        `Venez avec votre code de livraison${due ? ` et ${fc(due)}` : ''}.`], mR, link));
      jobs.push(both(S, `Disponible en agence – ${s.tracking}`, [`Le colis ${s.tracking} est disponible à ${agency?.name || 'l’agence'} pour ${s.recipient_name}.`], mS, link));
      break;
    case 'retour':
      jobs.push(both(S, `Colis retourné – ${s.tracking}`, [`Le colis ${s.tracking} vous est retourné.${extra.note ? ` Raison : ${extra.note}.` : ''}`], mS, link));
      break;
    case 'annule':
      jobs.push(both(R, `Envoi annulé – ${s.tracking}`, [`L'envoi ${s.tracking} a été annulé.`], mR, null));
      jobs.push(both(S, `Envoi annulé – ${s.tracking}`, [`L'envoi ${s.tracking} a été annulé.`], mS, null));
      break;
    default:
      break;
  }
  await Promise.all(jobs);
}

export async function notifyNewCode(s, otp) {
  await both({ phone: s.recipient_phone, email: s.recipient_email }, `Nouveau code de livraison – ${s.tracking}`,
    [`Nouveau code de livraison pour ${s.tracking} : ${otp}.`], { shipment_id: s.id, audience: 'client' }, null);
}

export async function notifyMerchant(m, subject, line) {
  await both({ phone: m.phone, email: m.email, sms: true, mail: !!m.notify_email }, subject, [line], { merchant_id: m.id, audience: 'vendeur' }, null);
}
