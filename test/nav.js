// Tests du guidage (public/assets/nav.js) : instructions en français, panneau qui change, hors route, voix on/off.
import assert from 'node:assert/strict';
import { instruction, fmtDist, prepare, progress, createGuide, dist } from '../public/assets/nav.js';

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
    assert.match(instruction({ type: 'arrive' }), /arrivé/);
    assert.match(instruction({ type: 'continue', modifier: 'straight', name: 'Avenue Y' }), /Continuez tout droit/);
    assert.equal(fmtDist(300), 'dans 300 m'); assert.equal(fmtDist(1200), 'dans 1,2 km'); assert.equal(fmtDist(20), 'maintenant');
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
  check('hors de la route : nouvel itinéraire demandé (une seule fois en 20 s)', () => {
    let t = 1e6, reroutes = 0;
    const g = createGuide({ reroute: () => reroutes++, now: () => t });
    g.setRoute(route);
    const far = { lat: A.lat + 0.003, lng: A.lng + 0.002 }; // ~330 m à côté de la route
    g.update(far); assert.equal(reroutes, 0);
    assert.ok(g.update(far).rerouting); assert.equal(reroutes, 1);
    g.update(far); g.update(far); assert.equal(reroutes, 1);
    t += 21000; g.update(far); assert.equal(reroutes, 2);
    g.update(lerp(A, B, 0.2)); assert.equal(reroutes, 2);
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
