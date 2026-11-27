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
  return { call, ok, login: (phone, password) => ok('POST', '/api/login', { phone, password }) };
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
    // Les étapes suivantes vérifient l'ancien tableau par zone ; le prix « comme Uber » est testé plus bas.
    await admin.ok('PUT', '/api/admin/rates', { settings: { pricing_mode: 'zone', surge_on: '0' } });
  });

  let newMerchantId;
  await step('inscription commerçant en attente, puis validation', async () => {
    const bad = await pub.call('POST', '/api/merchants/signup', { name: 'X' });
    assert.equal(bad.status, 400);
    await pub.ok('POST', '/api/merchants/signup', {
      name: 'Shop Mode Kin', contact_name: 'Cédric', phone: '0811111111', password: 'secret1', commune: 'Kalamu',
      landmark: 'Rond-point Victoire', lat: -4.33, lng: 15.31, payout_operator: 'orange', accept: true, email: 'Shop@Exemple.com'
    });
    await merch.login('0811111111', 'secret1');
    const denied = await merch.call('POST', '/api/merchant/shipments', {});
    assert.equal(denied.status, 403);
    const list = await admin.ok('GET', '/api/admin/merchants');
    newMerchantId = list.find((m) => m.name === 'Shop Mode Kin').id;
    await admin.ok('POST', `/api/admin/merchants/${newMerchantId}/status`, { status: 'actif' });
  });

  const order = {
    recipient_name: 'Patrick Mbuyi', recipient_phone: '0899999999', to_commune: 'Limete', to_landmark: 'Portail bleu après l’église',
    to_lat: -4.36, to_lng: 15.34, size: 'moyen', cod_amount_fc: 50000, pay_method: 'cod', recipient_email: 'patrick@exemple.com'
  };
  let s1;
  await step('devis : zone et prix', async () => {
    const q = await pub.ok('POST', '/api/quote', { from_commune: 'Kalamu', to_commune: 'Limete', size: 'moyen', cod_amount_fc: 50000 });
    assert.equal(q.zone, 3); // Funa → Mont-Amba
    assert.equal(q.price_fc, 13000 + 1000); // tarif + 2 % de 50 000
  });
  await step('le commerçant crée un envoi (paiement à la livraison + marchandise)', async () => {
    const missing = await merch.call('POST', '/api/merchant/shipments', { ...order, to_lat: null });
    assert.equal(missing.status, 400);
    s1 = await merch.ok('POST', '/api/merchant/shipments', order);
    assert.match(s1.tracking, /^KIN-\d{4}-\d{6}$/);
    assert.equal(s1.from_commune, 'Kalamu');
    assert.equal(s1.price_fc, 14000);
    const sms = await admin.ok('GET', '/api/admin/sms');
    assert.ok(sms.some((m) => m.message.includes(s1.tracking) && m.message.includes(s1.otp_demo)));
    const n = await admin.ok('GET', '/api/admin/notifications?channel=email');
    assert.ok(n.some((m) => m.to_addr === 'patrick@exemple.com' && m.message.includes(s1.otp_demo)), 'e-mail client avec code');
    assert.ok(n.some((m) => m.to_addr === 'shop@exemple.com' && m.audience === 'vendeur'), 'e-mail vendeur');
  });
  await step('suivi public sans données privées', async () => {
    const t = await pub.ok('GET', `/api/track/${s1.tracking}`);
    assert.equal(t.status, 'cree');
    assert.equal(t.recipient_phone, undefined);
    assert.equal(t.due_fc, 64000);
  });
  await step('étiquette : propriétaire oui, autre commerçant non', async () => {
    const lbl = await merch.ok('GET', `/etiquette/${s1.tracking}`);
    assert.ok(lbl.includes(s1.tracking) && lbl.includes('64'));
    const other = client(); await other.login('0810000001', 'demo123');
    assert.equal((await other.call('GET', `/etiquette/${s1.tracking}`)).status, 403);
  });
  await step('droits : le livreur ne voit pas le back office', async () => {
    assert.equal((await driver.call('GET', '/api/admin/dashboard')).status, 403);
    assert.equal((await pub.call('GET', '/api/driver/shipments')).status, 401);
  });

  const drivers = (await admin.ok('GET', '/api/admin/users')).filter((u) => u.role === 'livreur');
  const jk = drivers.find((d) => d.phone === '0820000001'); const gm = drivers.find((d) => d.phone === '0820000002');

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
    const t = await pub.ok('GET', `/api/track/${s1.tracking}`);
    assert.equal(t.driver.name, 'Jonathan');
    const wrong = await driver.call('POST', `/api/driver/shipments/${s1.tracking}/deliver`, { otp: '0000' === s1.otp_demo ? '1111' : '0000', method: 'cash' });
    assert.equal(wrong.status, 400);
    const noPay = await driver.call('POST', `/api/driver/shipments/${s1.tracking}/deliver`, { otp: s1.otp_demo });
    assert.equal(noPay.status, 400);
    const fd = new FormData();
    fd.append('otp', s1.otp_demo); fd.append('method', 'cash');
    fd.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'colis.jpg');
    const done = await driver.ok('POST', `/api/driver/shipments/${s1.tracking}/deliver`, fd, true);
    assert.equal(done.status, 'livre');
    assert.ok(done.photo);
    const cash = await driver.ok('GET', '/api/driver/cash');
    assert.equal(cash[0].total, 64000);
    await new Promise((r) => setTimeout(r, 20));
    const mine = await merch.ok('GET', '/api/merchant/notifications');
    assert.ok(!mine.some((m) => m.message.includes(`livraison : ${s1.otp_demo}`)), 'le commerçant ne voit pas le code du client');
    for (const subj of ['Colis ramassé', 'Votre colis est en route', 'Colis livré']) {
      assert.ok(mine.some((m) => m.channel === 'email' && m.subject?.startsWith(subj)), `notification : ${subj}`);
    }
    assert.ok(mine.some((m) => m.audience === 'vendeur' && m.message.includes('encaissés pour vous')), 'vendeur prévenu de l’argent encaissé');
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
    const ok = await driver.ok('POST', `/api/driver/shipments/${s2.tracking}/deliver`, { otp: s2.otp_demo });
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
    assert.equal(s3.status, 'en_agence'); assert.equal(s3.shipping_paid, 1); assert.equal(s3.price_fc, 10000);
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
      to_commune: 'Gombe', to_landmark: 'Immeuble rouge', to_lat: -4.30, to_lng: 15.31, size: 'grand', pay_method: 'cod'
    });
    assert.equal(s4.status, 'en_agence'); assert.equal(s4.shipping_paid, 0);
    await admin.ok('POST', `/api/admin/shipments/${s4.tracking}/assign`, { driver_id: gm.id });
    const list = await driver2.ok('GET', '/api/driver/shipments');
    assert.equal(list.shipments.find((x) => x.tracking === s4.tracking).deposit_agency_name, 'Relais Cyber Limete');
    const p = await driver2.ok('POST', `/api/driver/shipments/${s4.tracking}/pickup`, {});
    assert.equal(p.status, 'ramasse');
    const d = await agent.ok('POST', '/api/agency/depot-scan', { tracking: s4.tracking });
    assert.equal(d.shelf, 'LUKUNGA · GOMBE');
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
    const jkCash = c.open.find((o) => o.holder_type === 'livreur' && o.holder_id === jk.id);
    assert.equal(jkCash.cash_fc, 64000);
    const close = await admin.ok('POST', '/api/admin/cash/close', { holder_type: 'livreur', holder_id: jk.id, given_cash_fc: 60000, note: 'Manque 4 000' });
    assert.equal(close.gap_fc, -4000);
    assert.equal((await admin.call('POST', '/api/admin/cash/close', { holder_type: 'livreur', holder_id: jk.id, given_cash_fc: 0 })).status, 409);
    const ag = await agent.ok('POST', '/api/agency/close', { given_cash_fc: 10000 });
    assert.equal(ag.expected_cash_fc, 10000); assert.equal(ag.mobile_fc, 10000); assert.equal(ag.gap_fc, 0);
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
  await step('changement de tarif appliqué au devis', async () => {
    await admin.ok('PUT', '/api/admin/rates', { rates: [{ zone: 1, size: 'petit', price_fc: 4500 }], settings: { express_supplement_fc: 6000 } });
    const q = await pub.ok('POST', '/api/quote', { from_commune: 'Gombe', to_commune: 'Gombe', size: 'petit', express: true });
    assert.equal(q.price_fc, 10500);
  });
  await step('prix comme Uber : distance, zone occupée, heure de pointe', async () => {
    await admin.ok('PUT', '/api/admin/rates', { settings: { pricing_mode: 'distance', surge_on: '1', traffic_pct: 0,
      busy_score: 1, very_busy_score: 1000, busy_pct: 20, km_fc: 700, base_petit_fc: 3000 } });
    const near = await pub.ok('POST', '/api/quote', { from_commune: 'Gombe', to_commune: 'Gombe', size: 'petit', from_lat: -4.305, from_lng: 15.305, to_lat: -4.31, to_lng: 15.31 });
    const far = await pub.ok('POST', '/api/quote', { from_commune: 'Gombe', to_commune: 'Nsele', size: 'petit' });
    assert.equal(near.mode, 'distance');
    assert.ok(far.distance_km > 15 && far.price_fc > near.price_fc + 10000, 'plus loin = plus cher');
    const grand = await pub.ok('POST', '/api/quote', { from_commune: 'Gombe', to_commune: 'Nsele', size: 'grand' });
    assert.ok(grand.price_fc > far.price_fc);
    // Kalamu a des envois récents et aucun livreur proche : zone occupée, +20 %.
    const heat = await driver.ok('GET', '/api/heatmap');
    assert.equal(heat.communes.find((c) => c.name === 'Kalamu').level, 1);
    assert.equal(heat.communes.find((c) => c.name === 'Maluku').level, 0);
    const busy = await pub.ok('POST', '/api/quote', { from_commune: 'Kalamu', to_commune: 'Limete', size: 'petit' });
    assert.equal(busy.surge.pct, 20);
    assert.ok(busy.lines.some((l) => l.label.startsWith('Forte demande à Kalamu')));
    await admin.ok('PUT', '/api/admin/rates', { settings: { traffic_pct: 15, traffic_hours: '0-24' } });
    const rush = await pub.ok('POST', '/api/quote', { from_commune: 'Kalamu', to_commune: 'Limete', size: 'petit' });
    const sunday = new Date().getUTCDay() === 0;
    assert.equal(rush.surge.pct, sunday ? 20 : 35);
    assert.equal((await pub.call('GET', '/api/heatmap')).status, 401);
    await admin.ok('PUT', '/api/admin/rates', { settings: { pricing_mode: 'zone', surge_on: '0', traffic_hours: '6-9,16-19' } });
  });
  await step('mon compte admin : mot de passe et numéro', async () => {
    assert.equal((await admin.call('POST', '/api/me/password', { current: 'faux', password: 'nouveau123' })).status, 400);
    await admin.ok('POST', '/api/me/password', { current: 'admin123', password: 'nouveau123' });
    await admin.ok('PATCH', '/api/me', { phone: '0899111222', name: 'Persy' });
    const again = client(); await again.login('0899111222', 'nouveau123');
    assert.equal((await admin.call('PATCH', '/api/me', { phone: '0820000001' })).status, 409);
  });
  await step('tableau de bord et rapport', async () => {
    const d = await admin.ok('GET', '/api/admin/dashboard');
    assert.equal(d.delivered_today, 3);
    assert.equal(d.sales_today_fc, 10000);
    const rep = await admin.ok('GET', '/api/admin/report');
    assert.equal(rep[0].shipments, 4);
  });
  await step('nouvel agent, nouveau point relais, nouvel article', async () => {
    const a = await admin.ok('POST', '/api/admin/agencies', { name: 'Relais Masina', kind: 'relais', commune: 'Masina', commission_pct: 10 });
    await admin.ok('POST', '/api/admin/users', { role: 'agent', name: 'Ruth', phone: '0835555555', password: 'secret1', agency_id: a.id });
    const p = await admin.ok('POST', '/api/admin/products', { name: 'Tampon encreur', category: 'Fournitures', price_fc: 4000 });
    await admin.ok('POST', '/api/admin/stock', { agency_id: a.id, product_id: p.id, delta: 5 });
    const ruth = client(); await ruth.login('0835555555', 'secret1');
    const info = await ruth.ok('GET', '/api/agency/info');
    assert.equal(info.agency.name, 'Relais Masina');
    assert.equal(info.products.find((x) => x.id === p.id).qty, 5);
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
