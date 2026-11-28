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

/** Distance jusqu'au virage, qui défile en direct : 60 m → 40 m → 25 m → 5 m → maintenant. */
export function fmtDist(m) {
  if (m < 5) return 'maintenant';
  if (m < 100) return `dans ${Math.round(m / 5) * 5} m`;
  if (m < 1000) return `dans ${Math.round(m / 10) * 10} m`;
  return `dans ${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
}
export const fmtKm = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`);
export const fmtMin = (s) => `${Math.max(1, Math.round(s / 60))} min`;
export const fmtClock = (date) => date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// ---------- Jour / nuit ----------
/** Lever et coucher du soleil (UTC) pour une position et un jour — formule simplifiée de la NOAA, précise à ~2 min. */
export function sunTimes(lat, lng, date = new Date()) {
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5);
  const g = (2 * Math.PI / 365) * (day - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(rad(90.833)) - Math.sin(rad(lat)) * Math.sin(decl)) / (Math.cos(rad(lat)) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null; // pôles : pas de lever/coucher ce jour-là
  const ha = (Math.acos(cosH) * 180) / Math.PI;
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const at = (min) => new Date(midnight + min * 60e3);
  return { rise: at(720 - 4 * (lng + ha) - eqt), set: at(720 - 4 * (lng - ha) - eqt) };
}
/** Nuit ? Avec la position : selon le soleil. Sans position : heure du téléphone (jour de 6 h à 18 h 30). */
export function isNight(date = new Date(), p = null) {
  const sun = p?.lat != null ? sunTimes(p.lat, p.lng, date) : null;
  if (sun) return date < sun.rise || date > sun.set;
  const m = date.getHours() * 60 + date.getMinutes();
  return m < 6 * 60 || m >= 18 * 60 + 30;
}

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

/** Cap (0 = nord, 90 = est) pour aller de a vers b, en degrés. */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
/** Plus petit écart d'angle signé (de a vers b), entre -180 et 180. */
export const angleDiff = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

/** Le point de la route situé à `along` mètres du départ, avec le cap de la route à cet endroit. */
export function pointAt(r, along) {
  const d = Math.max(0, Math.min(r.total, along));
  let i = 1;
  while (i < r.pts.length - 1 && r.cum[i] < d) i++;
  const a = r.pts[i - 1], b = r.pts[i] || a, seg = r.cum[i] - r.cum[i - 1];
  const t = seg > 0 ? (d - r.cum[i - 1]) / seg : 0;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, bearing: bearing(a, b) };
}

/** La position GPS « collée » sur la route (pour que la flèche reste sur la ligne), avec l'écart en mètres. */
export function snap(r, p) {
  const { off, along } = project(r, p);
  return { ...pointAt(r, along), off, along };
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

/**
 * Où en est le livreur : prochaine instruction, distance jusqu'au virage, reste, écart à la route.
 * `opts.along` : position déjà connue sur la route (position extrapolée) ; `opts.minK` : étape en cours à ne pas
 * quitter vers l'arrière (hystérésis : on ne revient en arrière que si l'on est 25 m avant le début de l'étape).
 */
export function progress(r, p, opts = {}) {
  const pr = opts.along != null ? { off: 0, along: opts.along } : project(r, p);
  const { off, along } = pr;
  let k = 0;
  for (let i = 0; i < r.steps.length; i++) if (r.steps[i].start <= along + 1) k = i;
  if (opts.minK != null && k < opts.minK && opts.minK < r.steps.length && along > r.steps[opts.minK].start - 25) k = opts.minK;
  const next = r.steps[Math.min(k + 1, r.steps.length - 1)];
  const remaining = Math.max(0, r.total - along);
  const cur = r.steps[k];
  const curLen = (r.steps[k + 1]?.start ?? r.total) - cur.start;
  const leftInCur = curLen > 0 ? Math.max(0, ((r.steps[k + 1]?.start ?? r.total) - along) / curLen) : 0;
  const remainingS = (cur.duration || 0) * leftInCur + r.steps.slice(k + 1).reduce((t, s) => t + (s.duration || 0), 0);
  return {
    k, step: k + 1 < r.steps.length ? k + 1 : k, text: next.text, road: cur.type === 'arrive' ? '' : cur.name || '', toTurn: Math.max(0, next.start - along),
    along, remaining, remainingS, offRoute: off, arrived: remaining < 30
  };
}

/**
 * Suivi en temps réel entre deux positions GPS (« dead reckoning ») : la flèche avance LE LONG DE LA ROUTE
 * avec la dernière vitesse connue ; un nouveau GPS corrige en douceur, sans saut ni recul pour un petit écart.
 */
export const SNAP_M = 35, MAX_EXTRAPOLATE_S = 6;
export function createTracker({ now = () => Date.now() } = {}) {
  let last = null, shown = null, shownAt = 0;
  return {
    reset() { last = null; shown = null; },
    get fix() { return last; },
    /** Un vrai GPS. Renvoie la position collée sur la route (ou null si le livreur est loin de la route). */
    fix(r, p, speed = 0) {
      const sn = snap(r, p);
      if (sn.off > SNAP_M) { last = null; shown = null; return null; }
      last = { along: sn.along, speed: Math.max(0, speed || 0), at: now() };
      return sn;
    },
    /** Position estimée maintenant (à appeler à chaque image). */
    position(r) {
      if (!last) return null;
      const t = now();
      const dt = Math.min(MAX_EXTRAPOLATE_S, Math.max(0, (t - last.at) / 1000));
      const target = Math.min(r.total, last.along + last.speed * dt);
      if (shown == null) shown = target;
      else {
        const d = target - shown, alpha = 1 - Math.exp(-Math.max(0, t - shownAt) / 250);
        if (!(d < 0 && d > -15)) shown += d * alpha; // petit recul (GPS un peu en retard) : la flèche attend, elle ne recule pas
      }
      shownAt = t;
      return { ...pointAt(r, shown), along: shown };
    }
  };
}

/**
 * Contrôleur du guidage : suit les positions, annonce les instructions (voix), demande un nouvel itinéraire
 * quand le livreur quitte la route. `speak` et `reroute` sont fournis par l'écran (ou par les tests).
 */
// Hors de la route : plus de 50 m sur deux vrais GPS de suite ; nouvel itinéraire au plus toutes les 10 s.
export const OFF_ROUTE_M = 50, OFF_ROUTE_COUNT = 2, REROUTE_EVERY_MS = 10000;
export function createGuide({ speak = () => {}, reroute = () => {}, now = () => Date.now() } = {}) {
  let route = null, lastStep = -1, nearSaid = -1, offCount = 0, lastReroute = 0, voice = true, quiet = null, floor = 0;
  return {
    setRoute(r) { route = r ? prepare(r) : null; lastStep = -1; nearSaid = -1; offCount = 0; floor = 0; return route; },
    /** Nouvel itinéraire après un recalcul : on ne répète pas la consigne si elle n'a pas changé. */
    replaceRoute(r) {
      quiet = route && lastStep >= 0 && lastStep !== Infinity ? route.steps[lastStep]?.text : null;
      route = prepare(r); offCount = 0; nearSaid = -1; lastStep = -1; floor = 0;
      return route;
    },
    get route() { return route; },
    get voice() { return voice; },
    setVoice(on) { voice = !!on; },
    /**
     * `p` : position ; `opts.along` : position estimée sur la route (entre deux GPS). Les positions estimées
     * mettent à jour bandeau et voix, mais seuls les vrais GPS (sans `along`) comptent pour le hors-route.
     */
    update(p, opts = {}) {
      if (!route || !p?.lat) return null;
      const estimated = opts.along != null;
      const g = progress(route, p, { along: opts.along, minK: floor });
      if (g.offRoute < OFF_ROUTE_M) floor = Math.max(floor, g.k);
      if (!estimated) {
        // Hors de la route : nouvel itinéraire calculé depuis la vraie position.
        offCount = g.offRoute > OFF_ROUTE_M ? offCount + 1 : 0;
        if (offCount >= OFF_ROUTE_COUNT && now() - lastReroute > REROUTE_EVERY_MS) { lastReroute = now(); offCount = 0; reroute(p); g.rerouting = true; }
        if (g.offRoute > OFF_ROUTE_M) return g; // loin de la route : on ne lit pas une consigne périmée
      }
      if (voice && !g.rerouting) {
        if (g.arrived && lastStep !== Infinity) { speak('Vous êtes arrivé à destination'); lastStep = Infinity; }
        else if (!g.arrived && g.step !== lastStep && quiet && g.text === quiet) { lastStep = g.step; }
        else if (!g.arrived && g.step !== lastStep) {
          speak(g.toTurn < 60 ? `${g.text} maintenant` : `Dans ${fmtKm(g.toTurn).replace(' m', ' mètres').replace(' km', ' kilomètres')}, ${g.text}`);
          lastStep = g.step; if (g.toTurn < 60) nearSaid = g.step;
        }
        else if (!g.arrived && g.toTurn < 60 && nearSaid !== g.step && g.toTurn >= 0) { speak(`${g.text} maintenant`); nearSaid = g.step; }
      } else if (!voice) { lastStep = g.arrived ? Infinity : g.step; }
      quiet = null;
      return g;
    }
  };
}
