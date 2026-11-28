// Test de l'adaptateur SMS (Twilio simulé : aucun SMS réel, aucune clé réelle).
import assert from 'node:assert/strict';
Object.assign(process.env, { NODE_ENV: 'test', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: 'FENIX', SMS_WEBHOOK_TOKEN: 'jeton' });
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.twilio.com/')) {
    const f = new URLSearchParams(opts.body);
    sent.push({ to: f.get('To'), from: f.get('From'), body: f.get('Body'), auth: opts.headers.authorization });
    if (f.get('To') === '+243800000000') return new Response(JSON.stringify({ code: 21211, message: 'Invalid To' }), { status: 400 });
    return new Response(JSON.stringify({ sid: 'SM123', status: 'queued' }), { status: 201 });
  }
  return realFetch(url, opts);
};
const { toE164, server } = await import('../sms-adapter/server.mjs');
for (const [raw, want] of [['0812345678', '+243812345678'], ['812345678', '+243812345678'], ['243812345678', '+243812345678'],
  ['00243812345678', '+243812345678'], ['+243 81 234 5678', '+243812345678'], ['+1 555 010 0000', '+15550100000'], ['12', null], ['', null]]) {
  assert.equal(toE164(raw), want, raw);
}
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/send`;
const post = (body, token = 'jeton') => realFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
try {
  assert.equal((await post({ to: '0812345678', message: 'x' }, null)).status, 401);
  assert.equal((await post({ to: '0812345678', message: 'x' }, 'faux')).status, 401);
  assert.equal((await post({ to: '12', message: 'x' })).status, 400);
  const ok = await post({ to: '0812345678', message: 'Fenix Delivery : colis arrivé – Code de livraison : 1234' });
  assert.equal(ok.status, 200);
  assert.deepEqual(sent.at(-1), { to: '+243812345678', from: 'FENIX', body: 'Fenix Delivery : colis arrive - Code de livraison : 1234', auth: 'Basic ' + Buffer.from('ACtest:secret').toString('base64') });
  assert.equal((await post({ to: '0800000000', message: 'x' })).status, 502); // refus Twilio → erreur pour Fenix
  console.log('Adaptateur SMS : 7 vérifications réussies.');
} finally { server.close(); }
