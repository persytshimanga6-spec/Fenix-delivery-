// Guidage du livreur dans Fenix (comme Yango / Uber) : logique pure, sans écran, testable dans Node.
// L'itinéraire vient d'OSRM via le serveur Fenix (/api/driver/route) ; les instructions sont écrites en français ici.

const R = 6371000;
const rad = (x) => (x * Math.PI) / 180;
export function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Instructions en français ----------
const MOD = {
  left: 'à gauche', right: 'à droite', 'slight left': 'légèrement à gauche', 'slight right': 'légèrement à droite',
  'sharp left': 'franchement à gauche', 'sharp right': 'franchement à droite', straight: 'tout droit', uturn: 'demi-tour'
};
const onto = (name) => (name ? ` sur ${name}` : '');
const ordinal = (n) => (n === 1 ? '1re' : `${n}e`);

/** Une étape OSRM (type, modifier, name, exit) → phrase française. */
export function instruction(step) {
  const { type, modifier: m, name = '', exit } = step;
  const dir = MOD[m] || '';
  switch (type) {
    case 'depart': return `Démarrez${onto(name)}`;
    case 'arrive': return 'Vous êtes arrivé à destination';
    case 'roundabout': case 'rotary':
      return exit ? `Au rond-point, prenez la ${ordinal(exit)} sortie${onto(name)}` : `Prenez le rond-point${onto(name)}`;
    case 'roundabout turn': case 'exit roundabout': case 'exit rotary': return `Sortez du rond-point${onto(name)}`;
    case 'merge': return `Rejoignez${name ? ` ${name}` : ' la route'}${dir && m !== 'straight' ? ` ${dir}` : ''}`;
    case 'fork': return m?.includes('left') ? `Gardez la gauche${onto(name)}` : m?.includes('right') ? `Gardez la droite${onto(name)}` : `Continuez${onto(name)}`;
    case 'new name': case 'continue': case 'notification':
      if (m === 'uturn') return `Faites demi-tour${onto(name)}`;
      return m && m !== 'straight' ? `Continuez ${dir}${onto(name)}` : `Continuez tout droit${onto(name)}`;
    default: // turn, end of road, on ramp, off ramp…
      if (m === 'uturn') return `Faites demi-tour${onto(name)}`;
      if (!m || m === 'straight') return `Continuez tout droit${onto(name)}`;
      return `Tournez ${dir}${onto(name)}`;
  }
}

export function fmtDist(m) {
  if (m < 50) return 'maintenant';
  if (m < 1000) return `dans ${Math.round(m / 10) * 10} m`;
  return `dans ${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
}
export const fmtKm = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`);
export const fmtMin = (s) => `${Math.max(1, Math.round(s / 60))} min`;
export const fmtClock = (date) => date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// ---------- Itinéraire et progression ----------
/** Prépare l'itinéraire du serveur : distances cumulées des points et des étapes. */
export function prepare(route) {
  const pts = route.coords.map(([lat, lng]) => ({ lat, lng }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  let acc = 0;
  const steps = route.steps.map((s) => { const st = { ...s, start: acc, text: instruction(s) }; acc += s.distance; return st; });
  const scale = acc > 0 ? cum[cum.length - 1] / acc : 1; // aligne les étapes sur la ligne tracée
  steps.forEach((s) => { s.start *= scale; });
  return { pts, cum, steps, total: cum[cum.length - 1], duration: route.duration };
}

/** Point le plus proche sur la route : distance à la route et distance déjà parcourue. */
export function project(r, p) {
  const kx = Math.cos(rad(p.lat)) * R * Math.PI / 180, ky = R * Math.PI / 180;
  let best = { off: Infinity, along: 0 };
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1], b = r.pts[i];
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { off, along: r.cum[i - 1] + t * (r.cum[i] - r.cum[i - 1]) };
  }
  return best;
}

/** Où en est le livreur : prochaine instruction, distance jusqu'au virage, reste, écart à la route. */
export function progress(r, p) {
  const { off, along } = project(r, p);
  let k = 0;
  for (let i = 0; i < r.steps.length; i++) if (r.steps[i].start <= along + 1) k = i;
  const next = r.steps[Math.min(k + 1, r.steps.length - 1)];
  const remaining = Math.max(0, r.total - along);
  const cur = r.steps[k];
  const curLen = (r.steps[k + 1]?.start ?? r.total) - cur.start;
  const leftInCur = curLen > 0 ? Math.max(0, ((r.steps[k + 1]?.start ?? r.total) - along) / curLen) : 0;
  const remainingS = (cur.duration || 0) * leftInCur + r.steps.slice(k + 1).reduce((t, s) => t + (s.duration || 0), 0);
  return {
    step: k + 1 < r.steps.length ? k + 1 : k, text: next.text, toTurn: Math.max(0, next.start - along),
    remaining, remainingS, offRoute: off, arrived: remaining < 30
  };
}

/**
 * Contrôleur du guidage : suit les positions, annonce les instructions (voix), demande un nouvel itinéraire
 * quand le livreur quitte la route. `speak` et `reroute` sont fournis par l'écran (ou par les tests).
 */
export function createGuide({ speak = () => {}, reroute = () => {}, now = () => Date.now() } = {}) {
  let route = null, lastStep = -1, nearSaid = -1, offCount = 0, lastReroute = 0, voice = true;
  return {
    setRoute(r) { route = r ? prepare(r) : null; lastStep = -1; nearSaid = -1; offCount = 0; return route; },
    get route() { return route; },
    get voice() { return voice; },
    setVoice(on) { voice = !!on; },
    update(p) {
      if (!route || !p?.lat) return null;
      const g = progress(route, p);
      // Hors de la route (plus de 50 m, deux fois de suite) : nouvel itinéraire, au plus toutes les 20 s.
      offCount = g.offRoute > 50 ? offCount + 1 : 0;
      if (offCount >= 2 && now() - lastReroute > 20000) { lastReroute = now(); offCount = 0; reroute(p); g.rerouting = true; }
      if (voice && !g.rerouting) {
        if (g.arrived && lastStep !== Infinity) { speak('Vous êtes arrivé à destination'); lastStep = Infinity; }
        else if (!g.arrived && g.step !== lastStep) {
          speak(g.toTurn < 60 ? `${g.text} maintenant` : `Dans ${fmtKm(g.toTurn).replace(' m', ' mètres').replace(' km', ' kilomètres')}, ${g.text}`);
          lastStep = g.step; if (g.toTurn < 60) nearSaid = g.step;
        }
        else if (!g.arrived && g.toTurn < 60 && nearSaid !== g.step && g.toTurn >= 0) { speak(`${g.text} maintenant`); nearSaid = g.step; }
      } else if (!voice) { lastStep = g.arrived ? Infinity : g.step; }
      return g;
    }
  };
}
