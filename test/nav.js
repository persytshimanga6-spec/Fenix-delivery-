// Tests du guidage (public/assets/nav.js) : instructions en français, panneau qui change, hors route, voix on/off.
import assert from 'node:assert/strict';
import { instruction, fmtDist, prepare, progress, createGuide, dist, snap, bearing, angleDiff, sunTimes, isNight, createTracker, OFF_ROUTE_M, OFF_ROUTE_COUNT, REROUTE_EVERY_MS } from '../public/assets/nav.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// Itinéraire simulé (format renvoyé par /api/driver/route) : 600 m vers l'est, puis à droite (sud) 600 m.
const A = { lat: -4.32, lng: 15.30 }, B = { lat: -4.32, lng: 15.3054 }, C = { lat: -4.3254, lng: 15.3054 };
const route = { distance: 1200, duration: 300, coords: [[A.lat, A.lng], [B.lat, B.lng], [C.lat, C.lng]], steps: [
  { type: 'depart', name: 'Boulevard du 30 Juin', distance: 600, duration: 150, lat: A.lat, lng: A.lng },
  { type: 'turn', modifier: 'right', name: 'Avenue Kasa-Vubu', distance: 600, duration: 150, lat: B.lat, lng: B.lng },
  { type: 'arrive', name: '', distance: 0, duration: 0, lat: C.lat, lng: C.lng }] };
const lerp = (p, q, t) => ({ lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t });

try {
  check('instructions en français', () => {
    assert.equal(instruction({ type: 'turn', modifier: 'right', name: 'Avenue Kasa-Vubu' }), 'Tournez à droite sur Avenue Kasa-Vubu');
    assert.match(instruction({ type: 'turn', modifier: 'left', name: '' }), /^Tournez à gauche/);
    assert.match(instruction({ type: 'roundabout', exit: 2, name: 'Avenue X' }), /rond-point.*2e sortie/);
    assert.equal(instruction({ type: 'roundabout', exit: 1, name: 'S Carson Ct' }), 'Au rond-point, prenez la 1re sortie sur S Carson Ct');
    assert.match(instruction({ type: 'rotary', exit: 3 }), /3e sortie/);
    assert.match(instruction({ type: 'arrive' }), /arrivé/);
    assert.match(instruction({ type: 'continue', modifier: 'straight', name: 'Avenue Y' }), /Continuez tout droit/);
    assert.equal(fmtDist(300), 'dans 300 m'); assert.equal(fmtDist(1200), 'dans 1,2 km'); assert.equal(fmtDist(2), 'maintenant');
    // la distance défile en direct : 60 → 40 → 25 → 5 m
    assert.deepEqual([61, 39, 24, 6].map(fmtDist), ['dans 60 m', 'dans 40 m', 'dans 25 m', 'dans 5 m']);
  });
  check('le panneau change d’instruction en avançant', () => {
    const r = prepare(route);
    const g1 = progress(r, lerp(A, B, 0.3));
    assert.match(g1.text, /droite/); // prochaine manœuvre : tourner à droite
    assert.ok(g1.toTurn > 350 && g1.toTurn < 470, `distance au virage ${g1.toTurn}`);
    const g2 = progress(r, lerp(B, C, 0.5));
    assert.match(g2.text, /arrivé/); assert.ok(g2.remaining < 400);
    assert.ok(g1.remaining > g2.remaining && g1.remainingS > g2.remainingS);
    assert.ok(progress(r, C).arrived);
  });
  check('virage raté : nouvel itinéraire dès 2 GPS à plus de 50 m (au plus toutes les 10 s), pas sur le bruit du GPS', () => {
    let t = 1e6, reroutes = 0;
    const g = createGuide({ reroute: () => reroutes++, now: () => t });
    g.setRoute(route);
    assert.equal(OFF_ROUTE_M, 50); assert.equal(OFF_ROUTE_COUNT, 2); assert.equal(REROUTE_EVERY_MS, 10000);
    const noisy = { lat: A.lat + 0.0003, lng: A.lng + 0.002 }; // ~33 m à côté : bruit GPS
    for (let i = 0; i < 6; i++) g.update(noisy);
    assert.equal(reroutes, 0);
    const far = { lat: A.lat + 0.003, lng: A.lng + 0.002 }; // ~330 m à côté de la route (autre rue)
    g.update(far); assert.equal(reroutes, 0);
    assert.ok(g.update(far).rerouting); assert.equal(reroutes, 1);
    g.update(far); g.update(far); assert.equal(reroutes, 1);
    t += 10500; g.update(far); g.update(far); assert.equal(reroutes, 2);
    g.update(lerp(A, B, 0.2)); assert.equal(reroutes, 2);
    // les positions estimées (entre deux GPS) ne déclenchent jamais de recalcul
    t += 20000; for (let i = 0; i < 5; i++) g.update(far, { along: 100 }); assert.equal(reroutes, 2);
  });
  check('temps réel : entre deux GPS la flèche avance le long de la route, « dans X m » descend chaque seconde', () => {
    let t = 0;
    const tr = createTracker({ now: () => t });
    const r = prepare(route);
    const g = createGuide({ now: () => t });
    g.setRoute(route);
    tr.fix(r, lerp(A, B, 0.2), 11); // GPS à 120 m du départ, 11 m/s ≈ 40 km/h, puis plus de GPS pendant 4 s
    const seen = [];
    for (let ms = 0; ms <= 4000; ms += 50) { t = ms; const p = tr.position(r); if (ms % 1000 === 0) seen.push(Math.round(g.update(p, { along: p.along }).toTurn)); }
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] < seen[i - 1] - 5, `descend chaque seconde : ${seen}`);
    assert.ok(Math.abs(seen[0] - 480) < 15 && Math.abs(seen[4] - 436) < 15, `${seen}`);
    // le GPS suivant arrive un peu derrière : pas de recul de la flèche
    const before = tr.position(r).along;
    tr.fix(r, lerp(A, B, 0.2 + 40 / 600), 11); // 160 m alors que l'estimation est à ~164 m
    t += 50; assert.ok(tr.position(r).along >= before - 0.01, 'pas de recul');
    // arrêt (vitesse 0) : la flèche s'arrête aussi ; plus de 6 s sans GPS : on n'invente plus
    tr.fix(r, lerp(A, B, 0.5), 0); t += 3000; const stop = tr.position(r).along; t += 2000; assert.ok(Math.abs(tr.position(r).along - stop) < 0.5);
    tr.fix(r, lerp(A, B, 0.5), 10); t += 20000; assert.ok(tr.position(r).along < 300 + 10 * 6 + 1);
    assert.equal(tr.fix(r, { lat: A.lat + 0.003, lng: A.lng }, 10), null); // loin de la route : pas d'estimation
  });
  check('changement de consigne immédiat au virage, sans retour en arrière (hystérésis)', () => {
    const r = prepare(route);
    const g = createGuide({});
    g.setRoute(route);
    assert.match(g.update(lerp(A, B, 0.99)).text, /droite/);
    assert.match(g.update(lerp(B, C, 0.02), { along: 612 }).text, /arrivé/); // 12 m après le virage : consigne suivante
    assert.match(g.update(lerp(A, B, 0.995), { along: 597 }).text, /arrivé/); // le GPS repasse 3 m avant : on ne revient pas
    assert.match(g.update(lerp(A, B, 0.8), { along: 480 }).text, /droite/); // vraiment avant le virage : oui
    assert.ok(r.total > 1190);
  });
  check('la distance au virage défile à chaque position, puis la consigne suivante arrive aussitôt', () => {
    const r = prepare(route);
    const seen = [0.9, 0.93, 0.96, 0.99].map((t) => progress(r, lerp(A, B, t)));
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i].toTurn < seen[i - 1].toTurn);
    assert.ok(seen.every((x) => /droite/.test(x.text)));
    const after = progress(r, lerp(B, C, 0.02));
    assert.match(after.text, /arrivé/); assert.equal(after.road, 'Avenue Kasa-Vubu');
  });
  check('flèche collée à la ligne : position projetée sur la route, avec le cap de la route', () => {
    const r = prepare(route);
    const gpsNoisy = { lat: A.lat + 0.0002, lng: (A.lng + B.lng) / 2 }; // ~22 m au nord de la route
    const sn = snap(r, gpsNoisy);
    assert.ok(Math.abs(sn.lat - A.lat) < 1e-6, 'sur la ligne'); assert.ok(sn.off > 15 && sn.off < 30);
    assert.ok(Math.abs(angleDiff(sn.bearing, 90)) < 1, `cap est ${sn.bearing}`); // la route va vers l'est
    assert.ok(Math.abs(angleDiff(snap(r, lerp(B, C, 0.5)).bearing, 180)) < 1); // puis vers le sud
    assert.equal(Math.round(bearing(A, B)), 90); assert.equal(angleDiff(350, 10), 20); assert.equal(angleDiff(10, 350), -20);
  });
  check('recalcul : la nouvelle route remplace l’ancienne sans répéter la même consigne', () => {
    const said = [];
    const g = createGuide({ speak: (x) => said.push(x) });
    g.setRoute(route); g.update(lerp(A, B, 0.3));
    const n = said.length;
    g.replaceRoute(route); g.update(lerp(A, B, 0.32));
    assert.equal(said.length, n);
    assert.ok(g.route); // jamais de « pas de route » pendant le remplacement
  });
  check('jour / nuit automatique : selon le soleil à la position, sinon 6 h – 18 h 30', () => {
    const kin = { lat: -4.32, lng: 15.31 }; // Kinshasa : soleil vers 6 h et 18 h 15 (heure locale = UTC+1) toute l'année
    const sun = sunTimes(kin.lat, kin.lng, new Date('2026-11-27T12:00:00Z'));
    const hRise = sun.rise.getUTCHours() + 1 + sun.rise.getUTCMinutes() / 60, hSet = sun.set.getUTCHours() + 1 + sun.set.getUTCMinutes() / 60;
    assert.ok(hRise > 5.5 && hRise < 6.2, `lever ${hRise}`); assert.ok(hSet > 17.9 && hSet < 18.5, `coucher ${hSet}`);
    assert.equal(isNight(new Date('2026-11-27T11:00:00Z'), kin), false); // midi à Kinshasa : jour
    assert.equal(isNight(new Date('2026-11-27T20:30:00Z'), kin), true); // 21 h 30 : nuit
    const aurora = { lat: 39.73, lng: -104.83 }; // Aurora, 27 nov. : coucher vers 16 h 40 (UTC-7)
    assert.equal(isNight(new Date('2026-11-28T04:30:00Z'), aurora), true); // 21 h 30, la vidéo du soir
    assert.equal(isNight(new Date('2026-11-27T19:00:00Z'), aurora), false); // midi
    const local = (h, m) => { const d = new Date(2026, 10, 27, h, m); return isNight(d); }; // sans position
    assert.deepEqual([local(5, 59), local(6, 0), local(12, 0), local(18, 29), local(18, 30), local(23, 0)], [true, false, false, false, true, true]);
  });
  check('voix : annonce quand l’instruction change, silence quand coupée', () => {
    const said = [];
    const g = createGuide({ speak: (x) => said.push(x) });
    g.setRoute(route);
    g.update(lerp(A, B, 0.3));
    assert.equal(said.length, 1); assert.match(said[0], /^Dans \d+ mètres, Tournez à droite/);
    g.update(lerp(A, B, 0.35)); assert.equal(said.length, 1); // même instruction : pas de répétition
    g.update(lerp(A, B, 0.95)); assert.match(said.at(-1), /maintenant$/);
    g.setVoice(false);
    g.update(lerp(B, C, 0.3)); g.update(lerp(B, C, 0.5));
    const n = said.length;
    g.setVoice(true); g.update(lerp(B, C, 0.55)); assert.equal(said.length, n); // pas de rattrapage après réactivation
    g.update(C); assert.match(said.at(-1), /arrivé/);
    assert.ok(Math.abs(dist(A, B) - 600) < 10);
  });
  console.log(`\nGuidage : ${passed} contrôles réussis.`);
} catch (e) {
  console.error('\nÉCHEC :', e.message);
  process.exitCode = 1;
}
