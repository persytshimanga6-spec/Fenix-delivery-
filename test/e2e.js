// Test de bout en bout : tout le parcours d'un colis, l'agence, la caisse et les reversements.
// Lance : npm test   (base de données temporaire, rien n'est touché)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kincolis-'));
Object.assign(process.env, { DATA_DIR: dir, SHOW_OTP: '1', NO_LISTEN: '1', SEED_DEMO: '1', NODE_ENV: 'test', ADMIN_PHONE: '0800000000', ADMIN_PASSWORD: 'admin123' });
const { app } = await import('../src/server.js');
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

function client() {
  let cookie = '';
  const call = async (method, url, body, isForm = false) => {
    const res = await fetch(base + url, {
      method, headers: { ...(cookie ? { cookie } : {}), ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  const ok = async (method, url, body, isForm) => {
    const r = await call(method, url, body, isForm);
    if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return { call, ok, login: (phone, password) => ok('POST', '/api/login', { phone, password }),
    get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

const admin = client(); const merch = client(); const driver = client(); const driver2 = client();
const agent = client(); const relay = client(); const pub = client();

try {
  console.log('Parcours commerçant → livreur → client');
  await step('connexions de démo', async () => {
    await admin.login('0800000000', 'admin123');
    await driver.login('0820000001', 'demo123');
    await driver2.login('0820000002', 'demo123');
    await agent.login('0830000001', 'demo123');
    await relay.login('0830000002', 'demo123');
    // Prix stables pendant les tests : pas d'heure de pointe (testée plus bas).
    await admin.ok('PUT', '/api/admin/rates', { settings: { rush_hours: '' } });
  });

  let newMerchantId;
  await step('inscription commerçant en attente, puis validation', async () => {
    const bad = await pub.call('POST', '/api/merchants/signup', { name: 'X' });
    assert.equal(bad.status, 400);
    const form = { name: 'Shop Mode Kin', contact_name: 'Cédric', phone: '0811111111', password: 'secret12', commune: 'Kalamu',
      landmark: 'Rond-point Victoire', lat: -4.33, lng: 15.31, payout_operator: 'orange', accept: true, email: 'Shop@Exemple.com' };
    assert.equal((await pub.call('POST', '/api/merchants/signup', { ...form, password: 'court12' })).status, 400); // 8 caractères minimum
    const first = await pub.ok('POST', '/api/merchants/signup', form);
    // Même numéro : même réponse (on ne révèle pas qu'un compte existe).
    const again = await pub.call('POST', '/api/merchants/signup', { ...form, name: 'Autre' });
    assert.equal(again.status, 201); assert.equal(again.data.message, first.message);
    // En attente : pas de connexion.
    const pending = await merch.call('POST', '/api/login', { phone: '0811111111', password: 'secret12' });
    assert.equal(pending.status, 403);
    const list = await admin.ok('GET', '/api/admin/merchants');
    assert.equal(list.filter((m) => m.phone === '0811111111').length, 1);
    newMerchantId = list.find((m) => m.name === 'Shop Mode Kin').id;
    await admin.ok('POST', `/api/admin/merchants/${newMerchantId}/status`, { status: 'actif' });
    const li = await merch.login('0811111111', 'secret12');
    assert.equal(li.token, undefined); // jeton seulement dans le cookie httpOnly
  });

  const order = {
    recipient_name: 'Patrick Mbuyi', recipient_phone: '0899999999', to_commune: 'Limete', to_landmark: 'Portail bleu après l’église',
    to_lat: -4.36, to_lng: 15.34, size: 'moyen', cod_amount_fc: 50000, pay_method: 'mpesa', payment_ref: 'MP2611AB12', recipient_email: 'patrick@exemple.com'
  };
  let s1;
  let q1;
  await step('devis par trajet : prise en charge + carburant + temps', async () => {
    const trip = { from_commune: 'Kalamu', to_commune: 'Limete', size: 'moyen', cod_amount_fc: 50000, from_lat: -4.33, from_lng: 15.31, to_lat: -4.36, to_lng: 15.34 };
    q1 = await admin.ok('POST', '/api/quote?detail=1', trip); // détail complet : personnel seulement
    assert.equal(q1.zone, 3); // Funa → Mont-Amba (sert au tri)
    const km = q1.distance_km, min = Math.max(1, Math.round(km / 30 * 60));
    const up = (x) => Math.ceil(x / 100) * 100;
    assert.equal(q1.minutes, min);
    assert.equal(q1.price_fc, 4000 + up(km * 0.03 * 2640) + up(min * 100)); // pas de frais sur la marchandise
    assert.ok(!q1.lines.some((l) => /Encaissement/.test(l.label)));
    assert.ok(q1.lines.some((l) => l.label.startsWith('Carburant')) && q1.lines.some((l) => l.label.startsWith('Trafic')));
    assert.ok(!JSON.stringify(q1).includes('%'), 'aucun supplément en %');
    // Le client ne voit ni carburant ni trafic : regroupés dans « Distance », les lignes s'additionnent.
    const c = await pub.ok('POST', '/api/quote?detail=1', trip);
    assert.equal(c.price_fc, q1.price_fc);
    assert.ok(!c.lines.some((l) => /Carburant|Trafic|min/.test(l.label)) && c.minutes === undefined);
    const dist = c.lines.find((l) => l.label.startsWith('Distance'));
    assert.equal(dist.fc, q1.lines.filter((l) => /^(Carburant|Trafic)/.test(l.label)).reduce((t, l) => t + l.fc, 0));
    assert.equal(c.lines.reduce((t, l) => t + (l.fc || 0), 0), c.price_fc);
    const m = await merch.ok('POST', '/api/quote', trip);
    assert.ok(!m.lines.some((l) => /Carburant|Trafic/.test(l.label)));
  });
  await step('le commerçant crée un envoi payé par M-Pesa (marchandise encaissée à la livraison)', async () => {
    assert.equal((await merch.call('POST', '/api/merchant/shipments', { ...order, pay_method: 'compte' })).status, 400); // marchandise : le client paie tout avant
    assert.equal((await merch.call('POST', '/api/merchant/shipments', { ...order, cod_amount_fc: 0, payment_ref: '' })).status, 400);
    const missing = await merch.call('POST', '/api/merchant/shipments', { ...order, to_lat: null });
    assert.equal(missing.status, 400);
    s1 = await merch.ok('POST', '/api/merchant/shipments', order);
    assert.match(s1.tracking, /^FX-\d{4}-\d{6}$/);
    assert.equal(s1.from_commune, 'Kalamu');
    assert.equal(s1.price_fc, q1.price_fc);
    assert.equal(s1.payment_status, 'en_attente'); assert.equal(s1.shipping_paid, 0);
    const sms = await admin.ok('GET', '/api/admin/sms');
    // Le code est envoyé au client, mais jamais gardé en clair dans le journal.
    assert.ok(sms.some((m) => m.message.includes(s1.tracking) && m.message.includes('Code de livraison : ••••')));
    assert.ok(!sms.some((m) => m.message.includes(`livraison : ${s1.otp_demo}`)));
    const n = await admin.ok('GET', '/api/admin/notifications?channel=email');
    assert.ok(n.some((m) => m.to_addr === 'patrick@exemple.com' && m.message.includes('••••')), 'e-mail client (code masqué dans le journal)');
    assert.ok(n.some((m) => m.to_addr === 'shop@exemple.com' && m.audience === 'vendeur'), 'e-mail vendeur');
  });
  await step('suivi public sans données privées', async () => {
    const t = await pub.ok('GET', `/api/track/${s1.tracking}`);
    assert.equal(t.status, 'cree');
    assert.equal(t.recipient_phone, undefined);
    assert.equal(t.due_fc, 0); // rien à payer à la livraison
    assert.equal(t.payment, 'en_attente');
    assert.equal(t.price_fc, s1.price_fc + 50000); // à payer avant le départ : livraison + marchandise
  });
  await step('étiquette : propriétaire oui, autre commerçant non', async () => {
    const lbl = await merch.ok('GET', `/etiquette/${s1.tracking}`);
    assert.ok(lbl.includes(s1.tracking));
    const other = client(); await other.login('0810000001', 'demo123');
    assert.equal((await other.call('GET', `/etiquette/${s1.tracking}`)).status, 403);
  });
  await step('droits : le livreur ne voit pas le back office', async () => {
    assert.equal((await driver.call('GET', '/api/admin/dashboard')).status, 403);
    assert.equal((await pub.call('GET', '/api/driver/shipments')).status, 401);
  });

  const drivers = (await admin.ok('GET', '/api/admin/users')).filter((u) => u.role === 'livreur');
  const jk = drivers.find((d) => d.phone === '0820000001'); const gm = drivers.find((d) => d.phone === '0820000002');

  await step('non payé : aucun livreur, puis paiement confirmé par le comptoir', async () => {
    assert.equal((await admin.call('POST', `/api/admin/shipments/${s1.tracking}/assign`, { driver_id: jk.id })).status, 402);
    assert.equal((await agent.call('POST', '/api/agency/depot-scan', { tracking: s1.tracking })).status, 402);
    const pend = await agent.ok('GET', '/api/agency/payments');
    assert.ok(pend.some((x) => x.tracking === s1.tracking && x.payment_ref === 'MP2611AB12' && x.total_fc === s1.price_fc + 50000));
    const c = await admin.ok('POST', `/api/admin/shipments/${s1.tracking}/confirm-payment`, {});
    assert.equal(c.payment_status, 'paye'); assert.equal(c.shipping_paid, 1);
    assert.equal((await admin.call('POST', `/api/admin/shipments/${s1.tracking}/confirm-payment`, {})).status, 409);
  });
  await step('ramassage : assignation, scan chez le commerçant', async () => {
    await admin.ok('POST', `/api/admin/shipments/${s1.tracking}/assign`, { driver_id: jk.id });
    const mine = await driver.ok('GET', '/api/driver/shipments');
    assert.equal(mine.shipments.length, 1);
    assert.equal(mine.shipments[0].otp_hash, undefined);
    assert.equal((await driver2.call('POST', `/api/driver/shipments/${s1.tracking}/pickup`, {})).status, 403);
    await driver.ok('POST', `/api/driver/shipments/${s1.tracking}/pickup`, { lat: -4.33, lng: 15.31 });
  });
  await step('tri au dépôt : étagère par secteur et commune', async () => {
    const d = await agent.ok('POST', '/api/agency/depot-scan', { tracking: s1.tracking });
    assert.equal(d.status, 'au_depot');
    assert.equal(d.shelf, 'MONT-AMBA · LIMETE');
    assert.equal((await relay.call('POST', '/api/agency/depot-scan', { tracking: s1.tracking })).status, 403);
  });
  await step('livraison : mauvais code refusé, bon code accepté, argent enregistré', async () => {
    await admin.ok('POST', `/api/admin/shipments/${s1.tracking}/assign`, { driver_id: jk.id });
    await driver.ok('POST', `/api/driver/shipments/${s1.tracking}/start`, {});
    await driver.ok('POST', '/api/driver/location', { lat: -4.35, lng: 15.33 });
    const anon = await pub.ok('GET', `/api/track/${s1.tracking}`);
    assert.equal(anon.driver, null); assert.equal(anon.to_lat, null); assert.equal(anon.verified, false); // sans preuve : pas de position
    assert.equal((await pub.ok('GET', `/api/track/${s1.tracking}?phone=1234`)).verified, false);
    const t = await pub.ok('GET', `/api/track/${s1.tracking}?phone=9999`); // 4 derniers chiffres du destinataire (0899999999)
    assert.equal(t.driver.name, 'Jonathan'); assert.ok(t.to_lat);
    const photo = (otp) => { const fd = new FormData(); fd.append('otp', otp);
      fd.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'colis.jpg'); return fd; };
    const noPhoto = await driver.call('POST', `/api/driver/shipments/${s1.tracking}/deliver`, { otp: s1.otp_demo });
    assert.equal(noPhoto.status, 400); // photo obligatoire
    const wrong = await driver.call('POST', `/api/driver/shipments/${s1.tracking}/deliver`, photo('0000' === s1.otp_demo ? '1111' : '0000'), true);
    assert.equal(wrong.status, 400); // mauvais code
    const mine0 = await driver.ok('GET', '/api/driver/shipments');
    assert.equal(mine0.shipments.find((x) => x.tracking === s1.tracking).due.total, 0); // rien à encaisser
    const fd = new FormData();
    fd.append('otp', s1.otp_demo); fd.append('method', 'cash');
    fd.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'colis.jpg');
    const done = await driver.ok('POST', `/api/driver/shipments/${s1.tracking}/deliver`, fd, true);
    assert.equal(done.status, 'livre');
    assert.ok(done.photo);
    const cash = await driver.ok('GET', '/api/driver/cash');
    assert.equal(cash.length, 0); // le livreur ne touche pas d'argent
    await new Promise((r) => setTimeout(r, 20));
    const mine = await merch.ok('GET', '/api/merchant/notifications');
    assert.ok(!mine.some((m) => m.message.includes(`livraison : ${s1.otp_demo}`)), 'le commerçant ne voit pas le code du client');
    for (const subj of ['Colis ramassé', 'Votre colis est en route', 'Colis livré']) {
      assert.ok(mine.some((m) => m.channel === 'email' && m.subject?.startsWith(subj)), `notification : ${subj}`);
    }
    assert.ok(mine.some((m) => m.audience === 'vendeur' && m.message.includes('reversés sur votre compte')), 'vendeur prévenu du reversement');
  });
  await step('mon compte : e-mail et choix des notifications', async () => {
    const bad = await merch.call('PATCH', '/api/merchant/profile', { email: 'pas-un-email' });
    assert.equal(bad.status, 400);
    const p = await merch.ok('PATCH', '/api/merchant/profile', { email: 'boutique@exemple.com', notify_email: false });
    assert.equal(p.email, 'boutique@exemple.com'); assert.equal(p.notify_email, 0); assert.equal(p.notify_sms, 1);
  });

  let s2;
  await step('échec de livraison puis nouvelle tentative', async () => {
    s2 = await merch.ok('POST', '/api/merchant/shipments', { ...order, cod_amount_fc: 0, pay_method: 'compte', size: 'petit' });
    await admin.ok('POST', `/api/admin/shipments/${s2.tracking}/assign`, { driver_id: jk.id });
    await driver.ok('POST', `/api/driver/shipments/${s2.tracking}/pickup`, {});
    await driver.ok('POST', `/api/driver/shipments/${s2.tracking}/start`, {});
    assert.equal((await driver.call('POST', `/api/driver/shipments/${s2.tracking}/fail`, {})).status, 400);
    const f = await driver.ok('POST', `/api/driver/shipments/${s2.tracking}/fail`, { reason: 'Client absent' });
    assert.equal(f.status, 'echec'); assert.equal(f.attempts, 1);
    await driver.ok('POST', `/api/driver/shipments/${s2.tracking}/start`, {});
    const fd2 = new FormData(); fd2.append('otp', s2.otp_demo);
    fd2.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'colis.jpg');
    const ok = await driver.ok('POST', `/api/driver/shipments/${s2.tracking}/deliver`, fd2, true);
    assert.equal(ok.status, 'livre'); // rien à encaisser : facturé au commerçant
  });

  console.log('Agence : comptoir, retrait, ventes');
  const cfg = await pub.ok('GET', '/api/config');
  const relayId = cfg.agencies.find((a) => a.kind === 'relais').id;
  let s3;
  await step('envoi au comptoir payé en cash, retrait au point relais', async () => {
    s3 = await agent.ok('POST', '/api/agency/shipments', {
      sender_name: 'Marie', sender_phone: '0812222222', recipient_name: 'Joël', recipient_phone: '0813333333',
      to_commune: 'Limete', size: 'petit', pay_method: 'cash', pickup_agency_id: relayId
    });
    assert.equal(s3.status, 'en_agence'); assert.equal(s3.shipping_paid, 1); assert.equal(s3.payment_status, 'paye');
    await agent.ok('POST', '/api/agency/depot-scan', { tracking: s3.tracking });
    await admin.ok('POST', `/api/admin/shipments/${s3.tracking}/assign`, { driver_id: gm.id });
    await driver2.ok('POST', `/api/driver/shipments/${s3.tracking}/start`, {});
    assert.equal((await driver2.call('POST', `/api/driver/shipments/${s3.tracking}/deliver`, { otp: s3.otp_demo })).status, 409);
    const dropped = await driver2.ok('POST', `/api/driver/shipments/${s3.tracking}/drop-agency`, {});
    assert.equal(dropped.status, 'disponible_agence');
    assert.equal((await agent.call('POST', '/api/agency/handover', { tracking: s3.tracking, otp: s3.otp_demo })).status, 409);
    const h = await relay.ok('POST', '/api/agency/handover', { tracking: s3.tracking, otp: s3.otp_demo });
    assert.equal(h.status, 'retire');
  });
  await step('colis déposé au point relais, ramassé par un livreur puis trié', async () => {
    const s4 = await relay.ok('POST', '/api/agency/shipments', {
      sender_name: 'Aline', sender_phone: '0815555555', recipient_name: 'Ben', recipient_phone: '0816666666',
      to_commune: 'Gombe', to_landmark: 'Immeuble rouge', to_lat: -4.30, to_lng: 15.31, size: 'grand', pay_method: 'airtel', payment_ref: 'AM-778899'
    });
    assert.equal(s4.status, 'en_agence'); assert.equal(s4.shipping_paid, 1); // payé au comptoir
    await admin.ok('POST', `/api/admin/shipments/${s4.tracking}/assign`, { driver_id: gm.id });
    const list = await driver2.ok('GET', '/api/driver/shipments');
    assert.equal(list.shipments.find((x) => x.tracking === s4.tracking).deposit_agency_name, 'Relais Cyber Limete');
    const p = await driver2.ok('POST', `/api/driver/shipments/${s4.tracking}/pickup`, {});
    assert.equal(p.status, 'ramasse');
    const d = await agent.ok('POST', '/api/agency/depot-scan', { tracking: s4.tracking });
    assert.equal(d.shelf, 'LUKUNGA · GOMBE');
  });
  let pubMomo, pubCash, s5Price;
  await step('réservation en ligne : payée avant le départ (Mobile Money, puis espèces au comptoir)', async () => {
    const book = { sender_name: 'Rachel', sender_phone: '0817777777', from_commune: 'Lemba', from_landmark: 'Arrêt Righini',
      recipient_name: 'Paul', recipient_phone: '0818888888', to_commune: 'Gombe', to_landmark: 'Boulevard du 30 juin', to_lat: -4.31, to_lng: 15.3, size: 'petit' };
    assert.equal((await pub.call('POST', '/api/book', { ...book, pay_method: 'compte' })).status, 400);
    assert.equal((await pub.call('POST', '/api/book', { ...book, pay_method: 'orange' })).status, 400); // référence obligatoire
    pubMomo = await pub.ok('POST', '/api/book', { ...book, pay_method: 'orange', payment_ref: 'OM-55443322' });
    assert.match(pubMomo.tracking, /^FX-/); assert.equal(pubMomo.otp, undefined); // le code part seulement par SMS au destinataire
    assert.ok(!pubMomo.quote.lines.some((l) => /Carburant|Trafic/.test(l.label)));
    assert.equal(pubMomo.payment_status, 'en_attente');
    assert.equal((await admin.call('POST', `/api/admin/shipments/${pubMomo.tracking}/assign`, { driver_id: gm.id })).status, 402);
    await agent.ok('POST', `/api/agency/shipments/${pubMomo.tracking}/confirm-payment`, { method: 'orange' });
    await admin.ok('POST', `/api/admin/shipments/${pubMomo.tracking}/assign`, { driver_id: gm.id });
    const picked = await driver2.ok('POST', `/api/driver/shipments/${pubMomo.tracking}/pickup`, {});
    assert.equal(picked.status, 'ramasse');
    pubCash = await pub.ok('POST', '/api/book', { ...book, from_landmark: '', pay_method: 'cash' });
    const dep = await agent.ok('POST', `/api/agency/shipments/${pubCash.tracking}/confirm-payment`, { method: 'cash', deposit: true });
    assert.equal(dep.status, 'en_agence'); assert.equal(dep.payment_status, 'paye');
    const sms = await admin.ok('GET', '/api/admin/sms');
    assert.ok(sms.some((m) => m.message.includes('Paiement de') && m.message.includes(pubCash.tracking)));
  });
  await step('client d’un commerçant : paie livraison + marchandise par le lien, avant le départ', async () => {
    const s5 = await merch.ok('POST', '/api/merchant/shipments', { ...order, payment_ref: '', size: 'petit', cod_amount_fc: 30000 });
    assert.equal(s5.payment_status, 'en_attente');
    const sms = await admin.ok('GET', '/api/admin/sms');
    assert.ok(sms.some((m) => m.phone === '0899999999' && m.message.includes(`/payer.html?n=${s5.tracking}`)));
    assert.equal((await pub.call('GET', `/api/pay/${s5.tracking}`)).status, 403); // preuve obligatoire
    const info = await pub.ok('GET', `/api/pay/${s5.tracking}?phone=9999`);
    assert.equal(info.total_fc, s5.price_fc + 30000); assert.equal(info.goods_fc, 30000);
    assert.equal((await pub.call('POST', `/api/pay/${s5.tracking}`, { phone: '0811111111', pay_method: 'mpesa', payment_ref: 'MP99887766' })).status, 403);
    await pub.ok('POST', `/api/pay/${s5.tracking}`, { phone: '+243 899 999 999', pay_method: 'airtel', payment_ref: 'AM99887766' });
    const ok = await admin.ok('POST', `/api/admin/shipments/${s5.tracking}/confirm-payment`, {});
    assert.equal(ok.payment_status, 'paye'); assert.equal(ok.pay_method, 'airtel');
    s5Price = s5.price_fc;
  });
  await step('vente d’articles et de services, stock et reçu', async () => {
    const info = await agent.ok('GET', '/api/agency/info');
    const carton = info.products.find((p) => p.name === 'Carton moyen');
    const photos = info.products.find((p) => p.name.startsWith('Photos passeport'));
    assert.equal(carton.qty, 40);
    const sale = await agent.ok('POST', '/api/agency/sales', { pay_method: 'mpesa', items: [{ product_id: carton.id, qty: 2 }, { product_id: photos.id, qty: 1 }] });
    assert.equal(sale.total_fc, 2 * 2500 + 5000);
    const after = await agent.ok('GET', '/api/agency/info');
    assert.equal(after.products.find((p) => p.id === carton.id).qty, 38);
    assert.equal((await agent.call('POST', '/api/agency/sales', { pay_method: 'cash', items: [{ product_id: carton.id, qty: 999 }] })).status, 409);
    const recu = await agent.ok('GET', `/api/agency/sales/${sale.id}/recu`);
    assert.ok(recu.includes('Carton moyen'));
    await agent.ok('POST', '/api/agency/mailboxes', { number: 'BP 001', holder_name: 'Aline', holder_phone: '0814444444' });
    assert.equal((await agent.call('POST', '/api/agency/mailboxes', { number: 'BP 001', holder_name: 'X', holder_phone: '1' })).status, 409);
  });

  console.log('Caisse du soir et reversements');
  await step('remise de caisse : livreur avec écart, agence', async () => {
    const c = await admin.ok('GET', '/api/admin/cash');
    assert.ok(!c.open.some((o) => o.holder_type === 'livreur'), 'aucun argent chez les livreurs');
    assert.equal((await admin.call('POST', '/api/admin/cash/close', { holder_type: 'livreur', holder_id: jk.id, given_cash_fc: 0 })).status, 409);
    const ag = await agent.ok('POST', '/api/agency/close', { given_cash_fc: s3.price_fc + pubCash.price_fc });
    assert.equal(ag.expected_cash_fc, s3.price_fc + pubCash.price_fc); assert.equal(ag.mobile_fc, 10000 + pubMomo.price_fc); assert.equal(ag.gap_fc, 0);
    const c2 = await admin.ok('GET', '/api/admin/cash');
    assert.equal(c2.drivers.find((d) => d.id === jk.id).delivered, 2);
  });
  await step('reversement au commerçant avec référence', async () => {
    const p = await admin.ok('GET', '/api/admin/payouts');
    assert.equal(p.due[0].amount_fc, 50000);
    assert.equal((await admin.call('POST', '/api/admin/payouts/pay', { merchant_id: newMerchantId })).status, 400);
    const paid = await admin.ok('POST', '/api/admin/payouts/pay', { merchant_id: newMerchantId, reference: 'OM-123456' });
    assert.equal(paid.paid_fc, 50000);
    const sum = await merch.ok('GET', '/api/merchant/summary');
    assert.equal(sum.paid_fc, 50000); assert.equal(sum.to_receive_fc, 0);
    assert.equal(sum.unpaid_shipping_fc, s2.price_fc);
  });

  console.log('Réglages');
  await step('réglages du calcul appliqués au devis, heure de pointe = trajet plus long', async () => {
    await admin.ok('PUT', '/api/admin/rates', { settings: { express_supplement_fc: 6000, fuel_price_fc: 3000, minute_fc: 150 } });
    const pts = { from_commune: 'Gombe', to_commune: 'Gombe', size: 'petit', from_lat: -4.305, from_lng: 15.305, to_lat: -4.33, to_lng: 15.33 };
    const q = await admin.ok('POST', '/api/quote?detail=1', { ...pts, express: true });
    const up = (x) => Math.ceil(x / 100) * 100, min = Math.round(q.distance_km / 30 * 60);
    assert.equal(q.price_fc, 3000 + up(q.distance_km * 0.03 * 3000) + up(min * 150) + 6000);
    const far = await pub.ok('POST', '/api/quote', { from_commune: 'Gombe', to_commune: 'Nsele', size: 'petit' });
    assert.ok(far.distance_km > 15 && far.price_fc > q.price_fc, 'plus loin = plus cher');
    const grand = await pub.ok('POST', '/api/quote', { from_commune: 'Gombe', to_commune: 'Nsele', size: 'grand' });
    assert.equal(grand.price_fc - far.price_fc, 3000); // seule la prise en charge change
    await admin.ok('PUT', '/api/admin/rates', { settings: { rush_hours: '0-24' } });
    const rush = await admin.ok('POST', '/api/quote?detail=1', { from_commune: 'Gombe', to_commune: 'Nsele', size: 'petit' });
    const rushClient = await pub.ok('POST', '/api/quote', { from_commune: 'Gombe', to_commune: 'Nsele', size: 'petit' });
    assert.equal(rushClient.price_fc, rush.price_fc);
    assert.ok(!JSON.stringify(rushClient).includes('pointe') && !JSON.stringify(rushClient).includes('min'));
    const sunday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kinshasa', weekday: 'short' }).format(new Date()) === 'Sun';
    if (!sunday) {
      assert.equal(rush.minutes, Math.round(rush.distance_km / 18 * 60));
      assert.ok(rush.price_fc > far.price_fc && rush.lines.some((l) => l.label.includes('heure de pointe')));
    }
    assert.ok(!JSON.stringify(rush).includes('%'));
    const heat = await admin.ok('GET', '/api/admin/../heatmap');
    assert.ok(heat.communes.every((c) => c.pct === undefined));
    assert.equal((await driver.call('GET', '/api/heatmap')).status, 403);
    await admin.ok('PUT', '/api/admin/rates', { settings: { rush_hours: '', fuel_price_fc: 2640, minute_fc: 100 } });
  });
  await step('devenir livreur : candidature, contrôles, attente, validation', async () => {
    const y = new Date().getFullYear();
    const form = { last_name: 'Kabongo', post_name: 'Mutombo', first_name: 'Didier', phone: '0821234567', password: 'route123',
      address: 'Lemba, av. Kianza 12', birth_year: y - 25, email: 'didier@exemple.com', license_no: 'KIN-B-445566',
      disability: 'non', criminal_record: 'non', experience_years: 3, driver_kind: 'independant' };
    for (const k of Object.keys(form).filter((k) => k !== 'driver_kind')) {
      const { [k]: _, ...missing } = form;
      assert.equal((await pub.call('POST', '/api/drivers/apply', missing)).status, 400, `champ obligatoire : ${k}`);
    }
    assert.equal((await pub.call('POST', '/api/drivers/apply', { ...form, birth_year: y - 17 })).status, 400); // moins de 18 ans
    assert.equal((await pub.call('POST', '/api/drivers/apply', { ...form, experience_years: 1 })).status, 400); // moins de 2 ans
    assert.equal((await pub.call('POST', '/api/drivers/apply', { ...form, disability: 'oui' })).status, 400); // précision obligatoire
    await pub.ok('POST', '/api/drivers/apply', form);
    assert.equal((await pub.call('POST', '/api/drivers/apply', form)).status, 201); // réponse neutre, rien de créé en double
    const pending = client();
    const r = await pending.call('POST', '/api/login', { phone: '0821234567', password: 'route123' });
    assert.equal(r.status, 403); // en attente : pas de connexion
    const apps = await admin.ok('GET', '/api/admin/applications');
    const app = apps.find((x) => x.phone === '0821234567');
    assert.equal(app.full_name, 'Kabongo Mutombo Didier');
    for (const k of ['address', 'birth_year', 'email', 'license_no', 'disability', 'criminal_record', 'experience_years']) assert.ok(k in app, k);
    assert.equal((await admin.call('PATCH', `/api/admin/users/${app.user_id}`, { active: true })).status, 409); // pas de contournement
    await admin.ok('POST', `/api/admin/applications/${app.user_id}`, { decision: 'valide', zone: 'Mont-Amba' });
    const ok = client(); await ok.login('0821234567', 'route123');
    assert.equal((await ok.call('GET', '/api/driver/shipments')).status, 200);
    const list = await admin.ok('GET', '/api/admin/users');
    const d = list.find((u) => u.phone === '0821234567');
    assert.equal(d.license_no, 'KIN-B-445566'); assert.equal(d.experience_years, 3); assert.equal(d.zone, 'Mont-Amba');
    // Refusé : pas de connexion.
    await pub.ok('POST', '/api/drivers/apply', { ...form, phone: '0827654321', license_no: 'X-1' });
    const app2 = (await admin.ok('GET', '/api/admin/applications')).find((x) => x.phone === '0827654321');
    await admin.ok('POST', `/api/admin/applications/${app2.user_id}`, { decision: 'refuse' });
    assert.equal((await client().call('POST', '/api/login', { phone: '0827654321', password: 'route123' })).status, 403);
    // Ajout direct par le bureau : mêmes champs, validé tout de suite.
    assert.equal((await admin.call('POST', '/api/admin/users', { role: 'livreur', phone: '0829990000', password: 'route123' })).status, 400);
    await admin.ok('POST', '/api/admin/users', { ...form, role: 'livreur', phone: '0829990000', zone: 'Tshangu' });
    await client().login('0829990000', 'route123');
  });
  await step('part des livreurs : taux selon le type (salarié / indépendant)', async () => {
    const users = await admin.ok('GET', '/api/admin/users');
    assert.ok(users.filter((u) => u.role === 'livreur').every((u) => ['salarie', 'independant'].includes(u.driver_kind)));
    assert.equal(users.find((u) => u.id === jk.id).driver_kind, 'salarie'); // existants : salariés
    assert.equal(users.find((u) => u.phone === '0821234567').driver_kind, 'independant'); // choisi dans la candidature
    let c = await admin.ok('GET', '/api/admin/cash');
    const jkRow = () => c.drivers.find((d) => d.id === jk.id);
    assert.ok(jkRow().port_fc > 0);
    assert.ok(c.drivers.every((d) => d.share_fc === 0), 'les deux taux sont à 0 % au départ');
    assert.equal((await admin.call('PATCH', `/api/admin/users/${jk.id}`, { driver_kind: 'autre' })).status, 400);
    await admin.ok('PATCH', `/api/admin/users/${jk.id}`, { driver_kind: 'independant' });
    await admin.ok('PUT', '/api/admin/rates', { settings: { driver_share_independant_pct: 40, driver_share_salarie_pct: 0 } });
    c = await admin.ok('GET', '/api/admin/cash');
    assert.equal(jkRow().share_fc, Math.round(jkRow().port_fc * 0.4)); // effet immédiat, taux indépendant
    const sal = c.drivers.find((d) => d.driver_kind === 'salarie' && d.port_fc > 0);
    if (sal) assert.equal(sal.share_fc, 0);
    await admin.ok('PUT', '/api/admin/rates', { settings: { driver_share_independant_pct: 0 } });
    await admin.ok('PATCH', `/api/admin/users/${jk.id}`, { driver_kind: 'salarie' });
  });
  await step('mon compte admin : mot de passe et numéro', async () => {
    assert.equal((await admin.call('POST', '/api/me/password', { current: 'faux', password: 'nouveau123' })).status, 400);
    await admin.ok('POST', '/api/me/password', { current: 'admin123', password: 'nouveau123' });
    await admin.ok('PATCH', '/api/me', { phone: '0899111222', name: 'Persy' });
    const again = client(); await again.login('0899111222', 'nouveau123');
    // Changement de mot de passe : l'ancien est obligatoire et les autres sessions sont coupées.
    assert.equal((await again.call('POST', '/api/me/password', { password: 'encore1234' })).status, 400);
    const other = client(); await other.login('0899111222', 'nouveau123');
    await again.ok('POST', '/api/me/password', { current: 'nouveau123', password: 'encore1234' });
    assert.equal((await other.call('GET', '/api/me')).status, 401);          // autre session coupée
    assert.equal((await again.call('GET', '/api/me')).status, 200);          // la session qui a changé reste ouverte
    assert.equal((await admin.call('GET', '/api/me')).status, 401);
    await admin.login('0899111222', 'encore1234');
    // Déconnexion : le jeton est révoqué, même s'il est réutilisé.
    const saved = again.cookie;
    await again.ok('POST', '/api/logout', {});
    again.cookie = saved;
    assert.equal((await again.call('GET', '/api/me')).status, 401);
    assert.equal((await admin.call('PATCH', '/api/me', { phone: '0820000001' })).status, 400); // « Numéro indisponible », sans dire pourquoi
  });
  await step('tableau de bord et rapport', async () => {
    const d = await admin.ok('GET', '/api/admin/dashboard');
    assert.equal(d.delivered_today, 3);
    assert.equal(d.sales_today_fc, 10000);
    const rep = await admin.ok('GET', '/api/admin/report');
    assert.equal(rep[0].shipments, 7);
    // Revenus de Fenix = prix des livraisons seulement, jamais la marchandise des commerçants.
    const all = await admin.ok('GET', '/api/admin/shipments');
    assert.equal(rep[0].revenue_fc, all.filter((x) => x.status !== 'annule').reduce((t, x) => t + x.price_fc, 0));
  });
  await step('nouvel agent, nouveau point relais, nouvel article', async () => {
    const a = await admin.ok('POST', '/api/admin/agencies', { name: 'Relais Masina', kind: 'relais', commune: 'Masina', commission_pct: 10 });
    await admin.ok('POST', '/api/admin/users', { role: 'agent', name: 'Ruth', phone: '0835555555', password: 'secret12', agency_id: a.id });
    const p = await admin.ok('POST', '/api/admin/products', { name: 'Tampon encreur', category: 'Fournitures', price_fc: 4000 });
    await admin.ok('POST', '/api/admin/stock', { agency_id: a.id, product_id: p.id, delta: 5 });
    const ruth = client(); await ruth.login('0835555555', 'secret12');
    const info = await ruth.ok('GET', '/api/agency/info');
    assert.equal(info.agency.name, 'Relais Masina');
    assert.equal(info.products.find((x) => x.id === p.id).qty, 5);
  });
  await step('sécurité : code à 4 chiffres limité, en-têtes, origine, photo, agent sur compte', async () => {
    // Code faux 3 fois → bloqué 30 min, puis un nouveau code (bureau) débloque.
    const s6 = await merch.ok('POST', '/api/merchant/shipments', { ...order, cod_amount_fc: 0, pay_method: 'compte', payment_ref: '' });
    await admin.ok('POST', `/api/admin/shipments/${s6.tracking}/assign`, { driver_id: jk.id });
    await driver.ok('POST', `/api/driver/shipments/${s6.tracking}/pickup`, {});
    await agent.ok('POST', '/api/agency/depot-scan', { tracking: s6.tracking });
    await admin.ok('POST', `/api/admin/shipments/${s6.tracking}/assign`, { driver_id: jk.id });
    await driver.ok('POST', `/api/driver/shipments/${s6.tracking}/start`, {});
    const img = (otp, bytes = [0xff, 0xd8, 0xff, 0xd9], type = 'image/jpeg') => { const fd = new FormData(); fd.append('otp', otp);
      fd.append('photo', new Blob([Buffer.from(bytes)], { type }), 'colis.jpg'); return fd; };
    const wrong = s6.otp_demo === '0000' ? '1111' : '0000';
    assert.equal((await driver.call('POST', `/api/driver/shipments/${s6.tracking}/deliver`, img(s6.otp_demo, [0x3c, 0x73, 0x76, 0x67]), true)).status, 400); // pas une image
    assert.equal((await driver.call('POST', `/api/driver/shipments/${s6.tracking}/deliver`, img(wrong), true)).status, 400);
    assert.equal((await driver.call('POST', `/api/driver/shipments/${s6.tracking}/deliver`, img(wrong), true)).status, 400);
    assert.equal((await driver.call('POST', `/api/driver/shipments/${s6.tracking}/deliver`, img(wrong), true)).status, 429); // 3e : bloqué
    assert.equal((await driver.call('POST', `/api/driver/shipments/${s6.tracking}/deliver`, img(s6.otp_demo), true)).status, 429); // même le bon code
    await admin.ok('POST', `/api/admin/shipments/${s6.tracking}/resend-code`, {});
    assert.equal((await driver.call('POST', `/api/driver/shipments/${s6.tracking}/deliver`, img(s6.otp_demo), true)).status, 400); // ancien code invalide
    const photos = fs.readdirSync(path.join(dir, 'photos')).length;
    assert.equal((await driver2.call('POST', `/api/driver/shipments/${s6.tracking}/deliver`, img(s6.otp_demo), true)).status, 403); // pas sa tournée
    assert.equal(fs.readdirSync(path.join(dir, 'photos')).length, photos, 'aucune photo gardée quand la remise échoue');
    // Les hachages ne sortent jamais dans les réponses.
    const det = await admin.ok('GET', `/api/admin/shipments/${s6.tracking}`);
    assert.ok(!JSON.stringify(det).includes('otp_hash') && !JSON.stringify(det).includes('otp_salt'));
    // En-têtes de sécurité et CSP avec nonce.
    const page = await fetch(base + '/livreur/');
    const csp = page.headers.get('content-security-policy');
    assert.ok(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && /'nonce-[^']+'/.test(csp));
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert.ok((await page.text()).includes(`<script nonce="${nonce}"`));
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    // Requête venant d'un autre site : refusée.
    const csrf = await fetch(base + '/api/quote', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://pirate.example' },
      body: JSON.stringify({ from_commune: 'Gombe', to_commune: 'Limete', size: 'petit' }) });
    assert.equal(csrf.status, 403);
    // Un agent ne facture pas un envoi sur le compte d'un commerçant.
    const mid = (await admin.ok('GET', '/api/admin/merchants')).find((m) => m.status === 'actif').id;
    assert.equal((await agent.call('POST', '/api/agency/shipments', { sender_name: 'X', sender_phone: '0811000000', recipient_name: 'Y',
      recipient_phone: '0812000000', to_commune: 'Limete', size: 'petit', pay_method: 'compte', merchant_id: mid, pickup_agency_id: relayId })).status, 403);
    // Bureau : pas de mot de passe d'un autre admin, pas de désactivation du dernier admin.
    const meAdmin = (await admin.ok('GET', '/api/me')).user;
    assert.equal((await admin.call('PATCH', `/api/admin/users/${meAdmin.id}`, { active: false })).status, 400);
    assert.equal((await admin.call('POST', '/api/admin/stock', { agency_id: 99999, product_id: 1, delta: 1 })).status, 400);
  });
  await step('pages web servies', async () => {
    for (const p of ['/', '/suivi', '/commercant/', '/livreur/', '/admin/', '/agence/', '/vendor/leaflet/leaflet.js']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
    }
  });

  console.log(`\nTout est bon : ${passed} étapes réussies.`);
} catch (e) {
  console.error('\nÉCHEC :', e.message);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
