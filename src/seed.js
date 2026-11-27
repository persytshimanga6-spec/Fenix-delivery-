// Données de base (communes, tarifs, réglages, administrateur) et données de démonstration.
import bcrypt from 'bcryptjs';
import { db, tx } from './db.js';
import { fileURLToPath } from 'node:url';

// Les 24 communes, regroupées par secteur (anciens districts). Même secteur = zone 2.
const COMMUNES = {
  Lukunga: ['Barumbu', 'Gombe', 'Kinshasa', 'Kintambo', 'Lingwala', 'Mont-Ngafula', 'Ngaliema'],
  Funa: ['Bandalungwa', 'Bumbu', 'Kalamu', 'Kasa-Vubu', 'Makala', 'Ngiri-Ngiri', 'Selembao'],
  'Mont-Amba': ['Kisenso', 'Lemba', 'Limete', 'Matete', 'Ngaba'],
  Tshangu: ['Kimbanseke', 'Maluku', 'Masina', "N'djili", 'Nsele']
};

// Centre approximatif de chaque commune (pour la distance et la carte des zones). Modifiable.
const CENTERS = {
  Gombe: [-4.305, 15.305], Barumbu: [-4.315, 15.325], Kinshasa: [-4.325, 15.31], Lingwala: [-4.322, 15.298],
  Kintambo: [-4.33, 15.27], Ngaliema: [-4.36, 15.24], 'Mont-Ngafula': [-4.45, 15.27], Bandalungwa: [-4.343, 15.285],
  Bumbu: [-4.385, 15.29], Kalamu: [-4.345, 15.315], 'Kasa-Vubu': [-4.34, 15.3], Makala: [-4.385, 15.305],
  'Ngiri-Ngiri': [-4.355, 15.295], Selembao: [-4.38, 15.27], Kisenso: [-4.42, 15.34], Lemba: [-4.39, 15.32],
  Limete: [-4.355, 15.345], Matete: [-4.38, 15.34], Ngaba: [-4.385, 15.325], Kimbanseke: [-4.43, 15.4],
  Maluku: [-4.07, 15.565], Masina: [-4.385, 15.395], "N'djili": [-4.4, 15.375], Nsele: [-4.38, 15.5]
};

// Tarifs de départ À MODIFIER dans le back office (Tarifs) après l'enquête terrain.
const RATES = { 1: [5000, 7000, 10000], 2: [7000, 9000, 13000], 3: [10000, 13000, 18000] };

const SETTINGS = {
  company_name: 'Fenix Delivery',
  express_supplement_fc: '5000',
  retry_fee_fc: '3000',      // deuxième tentative ou retour
  insurance_pct: '1',        // % de la valeur déclarée
  // Part du livreur sur le prix de la livraison, selon son type (réglable dans Tarifs et réglages).
  driver_share_salarie_pct: '0',      // salarié : payé au salaire, pas à la commission
  driver_share_independant_pct: '0',  // indépendant : taux à fixer plus tard
  relay_commission_pct: '10',
  // Prix calculé pour chaque trajet : prise en charge + carburant + temps de trajet.
  base_petit_fc: '3000', base_moyen_fc: '4000', base_grand_fc: '6000',
  fuel_price_fc: '2640',      // prix du litre d'essence
  fuel_l_per_km: '0.03',      // consommation moto : 3 L / 100 km
  minute_fc: '100',           // tarif à la minute de trajet
  speed_normal_kmh: '30', speed_rush_kmh: '18',
  rush_hours: '6-9,16-19',    // heures de pointe (sauf dimanche)
  road_factor: '1.35',        // détour moyen par la route
  // Numéros Mobile Money de l'entreprise, affichés au client pour payer.
  momo_mpesa: '', momo_orange: '', momo_airtel: '',
  carto_api_key: ''          // clé gratuite du fond de carte CARTO (Tarifs et réglages)
};

export function ensureBase() {
  tx(() => {
    const c = db.prepare('INSERT OR IGNORE INTO communes (name, secteur) VALUES (?, ?)');
    for (const [s, list] of Object.entries(COMMUNES)) list.forEach((n) => c.run(n, s));
    const cc = db.prepare('UPDATE communes SET lat = ?, lng = ? WHERE name = ? AND lat IS NULL');
    for (const [n, [la, ln]] of Object.entries(CENTERS)) cc.run(la, ln, n);
    const r = db.prepare('INSERT OR IGNORE INTO rates (zone, size, price_fc) VALUES (?, ?, ?)');
    for (const [z, p] of Object.entries(RATES)) ['petit', 'moyen', 'grand'].forEach((s, i) => r.run(Number(z), s, p[i]));
    const st = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(SETTINGS)) st.run(k, v);

    const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
    if (!hasAdmin) {
      const phone = process.env.ADMIN_PHONE || '0800000000';
      const pass = process.env.ADMIN_PASSWORD || 'admin123';
      db.prepare("INSERT INTO users (role, name, phone, password_hash) VALUES ('admin', 'Administrateur', ?, ?)")
        .run(phone, bcrypt.hashSync(pass, 10));
      console.log(`Compte administrateur créé : téléphone ${phone}, mot de passe ${pass} (à changer).`);
    }
  })();
}

const PRODUCTS = [
  ['Carton petit', 'Emballage', 1500, 0], ['Carton moyen', 'Emballage', 2500, 0], ['Carton grand', 'Emballage', 4000, 0],
  ['Enveloppe A4 renforcée', 'Emballage', 500, 0], ['Papier bulle (1 m)', 'Emballage', 1000, 0],
  ['Rouleau de scotch', 'Emballage', 2000, 0], ['Sac sécurisé', 'Emballage', 1000, 0],
  ['Impression noir et blanc (page)', 'Documents', 200, 1], ['Impression couleur (page)', 'Documents', 500, 1],
  ['Photocopie (page)', 'Documents', 100, 1], ['Scan (page)', 'Documents', 300, 1],
  ['Plastification A4', 'Documents', 1500, 1], ['Reliure', 'Documents', 3000, 1], ['Saisie de document (page)', 'Documents', 1000, 1],
  ['Photos passeport (lot de 4)', 'Photos', 5000, 1], ['Impression photo 10x15', 'Photos', 1000, 1],
  ['Ordinateur (1 heure)', 'Ordinateurs', 2000, 1], ['Aide démarche en ligne', 'Ordinateurs', 3000, 1],
  ['Stylo', 'Fournitures', 300, 0], ['Cahier', 'Fournitures', 1500, 0], ['Clé USB 16 Go', 'Fournitures', 15000, 0],
  ['Chargeur de téléphone', 'Fournitures', 8000, 0],
  ['Boîte postale (1 an)', 'Autres services', 60000, 1], ['Cartes de visite (50)', 'Autres services', 15000, 1]
];

export function seedDemo() {
  ensureBase();
  if (db.prepare('SELECT 1 FROM agencies').get()) { console.log('Démo déjà présente.'); return; }
  const h = (p) => bcrypt.hashSync(p, 10);
  tx(() => {
    const ag = db.prepare('INSERT INTO agencies (name, kind, commune, address, lat, lng, commission_pct) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const a1 = ag.run('Agence Gombe (dépôt central)', 'agence', 'Gombe', 'Av. du Commerce', -4.3030, 15.3100, 0).lastInsertRowid;
    const a2 = ag.run('Relais Cyber Limete', 'relais', 'Limete', '7e rue, près du marché', -4.3570, 15.3420, 10).lastInsertRowid;

    const m = db.prepare(`INSERT INTO merchants (name, contact_name, phone, kind, volume, commune, landmark, lat, lng, payout_operator, payout_number, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'actif')`)
      .run('Boutique Mama Neema', 'Neema K.', '0810000001', 'Vente en ligne', '5-20', 'Gombe', 'Près de la poste', -4.3050, 15.3120, 'mpesa', '0810000001').lastInsertRowid;

    const u = db.prepare('INSERT INTO users (role, name, phone, password_hash, agency_id, merchant_id, zone) VALUES (?, ?, ?, ?, ?, ?, ?)');
    u.run('commercant', 'Neema K.', '0810000001', h('demo123'), null, m, null);
    u.run('livreur', 'Jonathan K.', '0820000001', h('demo123'), null, null, 'Mont-Amba');
    u.run('livreur', 'Grâce M.', '0820000002', h('demo123'), null, null, 'Lukunga');
    u.run('agent', 'Esther (Agence Gombe)', '0830000001', h('demo123'), a1, null, null);
    u.run('agent', 'Paul (Relais Limete)', '0830000002', h('demo123'), a2, null, null);

    const p = db.prepare('INSERT INTO products (name, category, price_fc, is_service) VALUES (?, ?, ?, ?)');
    const s = db.prepare('INSERT INTO stock (agency_id, product_id, qty) VALUES (?, ?, ?)');
    for (const [n, c, pr, svc] of PRODUCTS) {
      const id = p.run(n, c, pr, svc).lastInsertRowid;
      if (!svc) { s.run(a1, id, 40); s.run(a2, id, 10); }
    }
  })();
  console.log('Démo créée. Mot de passe des comptes de démo : demo123');
  console.log('  Commerçant 0810000001 · Livreurs 0820000001, 0820000002 · Agents 0830000001, 0830000002');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) seedDemo();
