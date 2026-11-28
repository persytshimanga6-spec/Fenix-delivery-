// Test de l'écran de guidage dans un vrai navigateur (Chrome) : suivi, rotation, flèche collée, recalcul robuste.
// Lance : npm test (ignoré proprement si Chrome ou playwright-core ne sont pas installés sur la machine).
// Variables : PLAYWRIGHT=/chemin/vers/playwright-core/index.mjs  CHROME=/chemin/vers/chrome
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const pw = await import(process.env.PLAYWRIGHT || 'playwright-core').catch(() => null);
const chrome = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p));
if (!pw || !chrome) { console.log('Écran de guidage : test navigateur ignoré (Chrome / playwright-core absents).'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenix-ui-'));
Object.assign(process.env, { DATA_DIR: dir, NO_LISTEN: '1', SEED_DEMO: '1', NODE_ENV: 'test', ADMIN_PHONE: '0800000000', ADMIN_PASSWORD: 'admin123' });
const { app } = await import('../src/server.js');
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;

// Route simulée : 600 m vers l'est puis à droite (sud) 600 m. Autre route possible en gris.
const A = [-4.32, 15.30], B = [-4.32, 15.3054], C = [-4.3254, 15.3054];
const steps = [
  { type: 'depart', name: 'Boulevard du 30 Juin', distance: 600, duration: 150, lat: A[0], lng: A[1] },
  { type: 'turn', modifier: 'right', name: 'Avenue Kasa-Vubu', distance: 600, duration: 150, lat: B[0], lng: B[1] },
  { type: 'arrive', name: '', distance: 0, duration: 0, lat: C[0], lng: C[1] }];
const ROUTE = { distance: 1200, duration: 300, coords: [A, B, C], steps,
  alternatives: [{ distance: 1500, duration: 400, coords: [A, [-4.3227, 15.30], [-4.3254, 15.3054]], steps }] };
let mode = 'ok', calls = 0, lastFrom = null;

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
const b = await pw.chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
try {
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, geolocation: { latitude: A[0], longitude: A[1] }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const ship = { tracking: 'FX-UI1', status: 'en_livraison', label: '5 000 FC', recipient_name: 'Marie K.', recipient_phone: '0810000000',
    to_commune: 'Gombe', to_landmark: 'Poste', to_lat: C[0], to_lng: C[1], due: { total: 0 }, attempts: 0 };
  await page.route('**/api/driver/shipments', (r) => r.fulfill({ json: { shipments: [ship], done_today: 0 } }));
  await page.route('**/api/driver/route*', (r) => {
    calls++; lastFrom = new URL(r.request().url()).searchParams.get('from');
    if (mode === 'dead') return r.fulfill({ status: 502, json: { error: 'Itinéraire indisponible pour le moment' } });
    if (mode === 'detour') { // nouvelle route routière qui part de la rue prise par le livreur
      const [lat, lng] = lastFrom.split(',').map(Number);
      return r.fulfill({ json: { distance: 900, duration: 250, coords: [[lat, lng], [lat, 15.3054], C], alternatives: [], steps: [
        { type: 'depart', name: 'Avenue de la Justice', distance: 500, duration: 140, lat, lng },
        { type: 'turn', modifier: 'right', name: 'Avenue Kasa-Vubu', distance: 400, duration: 110, lat, lng: 15.3054 },
        { type: 'arrive', name: '', distance: 0, duration: 0, lat: C[0], lng: C[1] }] } });
    }
    return r.fulfill({ json: ROUTE });
  });
  await page.route(/basemaps\.cartocdn\.com/, (r) => r.fulfill({ status: 204 }));
  const st = () => page.evaluate(() => window.__fenixNav());
  const go = async (lat, lng, wait = 1100) => { await ctx.setGeolocation({ latitude: lat, longitude: lng }); await page.waitForTimeout(wait); };
  const shot = (n) => process.env.SHOTS && page.screenshot({ path: path.join(process.env.SHOTS, `${n}.png`) });
  const along = (t) => [A[0], A[1] + (B[1] - A[1]) * t];

  await page.goto(`${base}/livreur/`);
  await page.fill('input[name=phone]', '0820000001'); await page.fill('input[name=password]', 'demo123');
  await page.click('#login button[type=submit]');
  await page.waitForSelector('[data-a=guide]'); await page.waitForTimeout(800);
  await page.click('[data-a=guide]'); await page.waitForTimeout(1200);

  await check('à l’ouverture : carte centrée sur le livreur, zoom 17, route + autre route en gris', async () => {
    const s = await st();
    assert.equal(s.zoom, 17); assert.ok(s.follow);
    assert.ok(Math.abs(s.center.lat - A[0]) < 2e-4 && Math.abs(s.center.lng - A[1]) < 2e-4, JSON.stringify(s.center));
    assert.equal(s.line, 3); assert.ok(s.lineOnMap); assert.equal(s.alts, 1); assert.ok(!s.straight);
  });

  await check('en roulant : la carte suit, tourne avec le cap, la flèche reste collée à la ligne, la distance défile', async () => {
    const dists = [];
    for (const t of [0.1, 0.2, 0.3, 0.4]) { await go(along(t)[0] + 0.00012, along(t)[1]); dists.push(parseInt((await st()).dist.replace(/\D/g, ''), 10)); } // GPS ~13 m à côté
    const s = await st();
    assert.ok(Math.abs(s.me.lat - A[0]) < 1e-5, 'flèche sur la ligne malgré le bruit GPS');
    assert.ok(Math.abs(s.center.lng - s.me.lng) < 5e-5, 'la carte suit le livreur');
    assert.ok(Math.abs(s.bearing - 90) < 25, `la carte tourne (cap ${s.bearing})`); assert.match(s.rotate, /rotate\(-\d/);
    for (let i = 1; i < dists.length; i++) assert.ok(dists[i] < dists[i - 1], `distance qui défile ${dists}`);
    assert.match(s.text, /droite/);
    assert.ok(Math.abs(s.arrowOnScreen) < 25, `la flèche pointe vers le haut (${s.arrowOnScreen})`);
    await shot('guidage-en-route');
  });

  await check('la flèche avance en douceur (position intermédiaire entre deux GPS)', async () => {
    const before = (await st()).me.lng;
    await ctx.setGeolocation({ latitude: along(0.5)[0], longitude: along(0.5)[1] });
    await page.waitForTimeout(350);
    const mid = (await st()).me.lng;
    await page.waitForTimeout(1200);
    const after = (await st()).me.lng;
    assert.ok(mid > before && mid < after, `${before} < ${mid} < ${after}`);
  });

  await check('boutons + / − et « Recentrer » après un déplacement à la main', async () => {
    await page.click('#navZoomIn'); assert.equal((await st()).zoom, 18);
    await page.click('#navZoomOut'); assert.equal((await st()).zoom, 17);
    const box = await page.locator('#navWrap').boundingBox();
    await page.mouse.move(box.x + 150, box.y + 250); await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 330, { steps: 8 }); await page.mouse.up();
    let s = await st(); assert.ok(!s.follow); assert.ok(s.recenter); assert.equal(s.rotate, '');
    await page.click('#navRecenter');
    s = await st(); assert.ok(s.follow); assert.equal(s.zoom, 17); assert.ok(!s.recenter);
  });

  await check('service en panne en cours de route : l’ancienne route reste, nouvel essai à 15 s', async () => {
    mode = 'dead';
    const off = [-4.3227, 15.3027]; // une autre rue, ~300 m de la route
    const n0 = calls;
    for (let i = 0; i < 4; i++) await go(off[0], off[1] + i * 0.00003, 700);
    await page.waitForTimeout(600);
    let s = await st();
    assert.ok(calls > n0, 'recalcul demandé'); assert.ok(s.lineOnMap); assert.equal(s.line, 3); assert.ok(!s.straight, 'pas de ligne droite');
    assert.match(s.warn, /15 s/);
    // le service revient : au prochain essai (15 s), nouvelle route routière depuis la vraie position
    mode = 'detour';
    const n1 = calls;
    await page.waitForTimeout(15500);
    s = await st();
    assert.ok(calls > n1, 'nouvel essai fait'); assert.ok(lastFrom.startsWith('-4.3227'), lastFrom);
    assert.ok(s.lineOnMap); assert.ok(!s.straight); assert.equal(s.warn, '');
    assert.match(s.text, /Kasa-Vubu/); assert.equal((await page.textContent('#navRoad')), 'Avenue de la Justice'); // consignes de la nouvelle route
    await shot('guidage-nouvel-itineraire');
  });

  // ----- Temps réel : on roule vers l'est sur le Boulevard (A → B), virage à droite en B -----
  const M = (B[1] - A[1]) / 599.4; // degrés de longitude par mètre ici
  const atM = (m) => (m <= 599.4 ? [A[0], A[1] + m * M] : [A[0], B[1] + (m - 599.4) * M]); // tout droit, même après B (virage raté)
  const atTurnM = (m) => (m <= 599.4 ? atM(m) : [A[0] - (m - 599.4) / 110574, B[1]]); // en tournant à droite en B
  async function drive({ from, speed, seconds, every, path = atTurnM, sample = 250 }) {
    await page.click('#navClose').catch(() => {});
    await ctx.setGeolocation({ latitude: path(from)[0], longitude: path(from)[1] });
    await page.waitForTimeout(300);
    await page.click('[data-a=guide]'); await page.waitForTimeout(1500);
    const out = []; const t0 = Date.now(); let nextFix = 0;
    while (Date.now() - t0 < seconds * 1000) {
      const t = (Date.now() - t0) / 1000;
      if (t >= nextFix) { const p = path(from + speed * nextFix); await ctx.setGeolocation({ latitude: p[0], longitude: p[1] }); nextFix += every; }
      const s = await st();
      out.push({ t, truth: from + speed * t, dist: s.dist, text: s.text, me: s.me, calls });
      await page.waitForTimeout(sample);
    }
    return out;
  }
  const meters = (txt) => (/maintenant/.test(txt) ? 0 : /km/.test(txt) ? parseFloat(txt.replace(/[^\d,]/g, '').replace(',', '.')) * 1000 : parseInt(txt.replace(/\D/g, ''), 10));
  const everySecond = (out, until, startSec = 2) => {
    const pts = []; for (let sec = startSec; sec <= until; sec++) { const o = out.find((x) => x.t >= sec); if (o) pts.push(o); }
    return pts;
  };

  await check('temps réel, 1 GPS/s : « dans X m » descend chaque seconde, la flèche ne s’arrête jamais, consigne suivante dans la seconde', async () => {
    mode = 'ok';
    const out = await drive({ from: 450, speed: 12, seconds: 16, every: 1 });
    const before = everySecond(out, 11).filter((o) => o.truth < 590);
    const d = before.map((o) => meters(o.dist));
    for (let i = 1; i < d.length; i++) assert.ok(d[i] < d[i - 1], `descend chaque seconde : ${d}`);
    const moving = out.filter((o) => o.t > 2 && o.truth < 590);
    for (let i = 1; i < moving.length; i++) assert.ok(moving[i].me.lng > moving[i - 1].me.lng, `la flèche avance toujours (${i})`);
    const passed = out.find((o) => o.truth >= 599.4 + 12); // une seconde après le virage
    const later = out.filter((o) => o.t >= passed.t);
    assert.ok(later.length && /arrivé/.test(later[0].text), `consigne suivante : ${later[0]?.text}`);
  });

  await check('temps réel, 1 GPS toutes les 4 s : la distance descend QUAND MÊME chaque seconde (estimation)', async () => {
    // la vitesse est connue au 2e GPS (t = 4 s) ; ensuite seulement un GPS toutes les 4 s
    const out = await drive({ from: 250, speed: 12, seconds: 17, every: 4 });
    const d = everySecond(out, 16, 5).map((o) => meters(o.dist));
    for (let i = 1; i < d.length; i++) assert.ok(d[i] < d[i - 1], `descend chaque seconde entre deux GPS : ${d}`);
    console.log(`    (GPS toutes les 4 s, bandeau seconde par seconde : ${d.join(' → ')} m)`);
    const err = everySecond(out, 16, 5).map((o) => Math.abs((599.4 - o.truth) - meters(o.dist)));
    assert.ok(Math.max(...err) < 40, `écart avec la vraie distance : ${err.map(Math.round)}`);
  });

  await check('virage raté volontaire : nouvel itinéraire en moins de 10 s', async () => {
    const out = await drive({ from: 520, speed: 12, seconds: 18, every: 1, path: atM });
    const passT = (599.4 - 520) / 12;
    const c0 = out.find((o) => o.t >= passT).calls;
    const got = out.find((o) => o.t > passT && o.calls > c0);
    assert.ok(got, 'recalcul demandé');
    console.log(`    (nouvel itinéraire demandé ${(got.t - passT).toFixed(1)} s après le virage raté)`); assert.ok(got.t - passT < 10, `recalcul ${(got.t - passT).toFixed(1)} s après le virage`);
  });

  await check('jour / nuit automatique : carte claire le jour, bleu nuit le soir', async () => {
    mode = 'ok';
    for (const [iso, want, style] of [['2026-11-27T11:00:00Z', 'day', 'light'], ['2026-11-27T20:30:00Z', 'night', 'dark']]) {
      const p2 = await ctx.newPage();
      await p2.clock.setFixedTime(new Date(iso)); // midi puis 21 h 30 à Kinshasa
      await p2.route('**/api/driver/shipments', (r) => r.fulfill({ json: { shipments: [ship], done_today: 0 } }));
      await p2.route('**/api/driver/route*', (r) => r.fulfill({ json: ROUTE }));
      await p2.route(/basemaps\.cartocdn\.com/, (r) => r.fulfill({ status: 204 }));
      await p2.goto(`${base}/livreur/`); await p2.waitForSelector('[data-a=guide]'); await p2.waitForTimeout(500);
      await p2.click('[data-a=guide]'); await p2.waitForTimeout(1200);
      const s = await p2.evaluate(() => window.__fenixNav());
      assert.equal(s.theme, want); assert.equal(s.tileStyle, style);
      assert.ok(await p2.locator(`#navWrap.${want}`).count());
      const bg = await p2.evaluate(() => getComputedStyle(document.querySelector('#navWrap')).backgroundColor);
      assert.equal(bg, want === 'day' ? 'rgb(207, 230, 247)' : 'rgb(10, 22, 40)');
      assert.ok(s.lineOnMap, 'route visible');
      if (process.env.SHOTS) await p2.screenshot({ path: path.join(process.env.SHOTS, `guidage-${want === 'day' ? 'jour' : 'nuit'}.png`) });
      await p2.close();
    }
  });

  await check('premier calcul raté : ligne droite + Google Maps, livraison possible', async () => {
    await page.click('#navClose');
    mode = 'dead';
    await page.click('[data-a=guide]'); await page.waitForTimeout(1200);
    const s = await st();
    assert.ok(s.straight); assert.ok(!s.haveRoad); assert.match(s.warn, /ligne droite/);
    assert.ok(await page.locator('#navGmaps').isVisible()); assert.ok(await page.locator('#navDeliver').isVisible());
  });

  assert.deepEqual(errors, []);
  console.log(`Écran de guidage : ${passed} contrôles réussis dans Chrome.`);
} catch (e) {
  console.error('\nÉCHEC :', e.message);
  process.exitCode = 1;
} finally {
  await b.close(); server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
