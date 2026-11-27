// Base de données SQLite : un seul fichier, facile à sauvegarder.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });

export const dataDir = DATA_DIR;
export const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'kincolis.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agence',          -- agence | relais | franchise
  commune TEXT, address TEXT, lat REAL, lng REAL,
  commission_pct REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, contact_name TEXT, phone TEXT NOT NULL,
  kind TEXT, volume TEXT,
  commune TEXT, landmark TEXT, lat REAL, lng REAL,
  payout_operator TEXT, payout_number TEXT,
  status TEXT NOT NULL DEFAULT 'en_attente',      -- en_attente | actif | suspendu
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,                              -- admin | agent | livreur | commercant
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  agency_id INTEGER REFERENCES agencies(id),
  merchant_id INTEGER REFERENCES merchants(id),
  zone TEXT,                                       -- secteur habituel du livreur
  last_lat REAL, last_lng REAL, last_seen TEXT,    -- dernière position connue du livreur
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS communes (
  name TEXT PRIMARY KEY,
  secteur TEXT NOT NULL                            -- communes voisines = même secteur
);

CREATE TABLE IF NOT EXISTS rates (
  zone INTEGER NOT NULL,                           -- 1 même commune, 2 même secteur, 3 autre
  size TEXT NOT NULL,                              -- petit | moyen | grand
  price_fc INTEGER NOT NULL,
  PRIMARY KEY (zone, size)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY,
  tracking TEXT NOT NULL UNIQUE,
  merchant_id INTEGER REFERENCES merchants(id),
  agency_id INTEGER REFERENCES agencies(id),       -- agence où le colis a été déposé
  pickup_agency_id INTEGER REFERENCES agencies(id),-- si le client vient chercher en agence
  sender_name TEXT NOT NULL, sender_phone TEXT NOT NULL,
  from_commune TEXT, from_landmark TEXT, from_lat REAL, from_lng REAL,
  recipient_name TEXT NOT NULL, recipient_phone TEXT NOT NULL,
  to_commune TEXT, to_landmark TEXT, to_lat REAL, to_lng REAL,
  size TEXT NOT NULL, weight_kg REAL, description TEXT,
  declared_value_fc INTEGER DEFAULT 0, insured INTEGER DEFAULT 0, express INTEGER DEFAULT 0,
  zone INTEGER, price_fc INTEGER NOT NULL,
  pay_method TEXT NOT NULL,                        -- mpesa | orange | airtel | cash | cod | compte
  shipping_paid INTEGER NOT NULL DEFAULT 0,
  cod_amount_fc INTEGER NOT NULL DEFAULT 0,        -- valeur de la marchandise à encaisser pour le commerçant
  status TEXT NOT NULL DEFAULT 'cree',
  driver_id INTEGER REFERENCES users(id),
  shelf TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  otp_hash TEXT,
  photo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ship_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_ship_driver ON shipments(driver_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  status TEXT NOT NULL, note TEXT,
  user_id INTEGER REFERENCES users(id),
  lat REAL, lng REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Argent encaissé par un livreur ou une agence, en attente de remise
CREATE TABLE IF NOT EXISTS cash (
  id INTEGER PRIMARY KEY,
  holder_type TEXT NOT NULL,                       -- livreur | agence
  holder_id INTEGER NOT NULL,
  shipment_id INTEGER REFERENCES shipments(id),
  sale_id INTEGER,
  kind TEXT NOT NULL,                              -- port | marchandise | vente
  method TEXT NOT NULL,                            -- cash | mpesa | orange | airtel
  amount_fc INTEGER NOT NULL,
  closing_id INTEGER REFERENCES closings(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS closings (
  id INTEGER PRIMARY KEY,
  holder_type TEXT NOT NULL, holder_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  expected_cash_fc INTEGER NOT NULL, given_cash_fc INTEGER NOT NULL,
  mobile_fc INTEGER NOT NULL, gap_fc INTEGER NOT NULL,
  note TEXT, validated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ce qu'on doit au commerçant (marchandise encaissée à la livraison)
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  amount_fc INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'a_reverser',       -- a_reverser | reverse
  reference TEXT,
  shipment_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, category TEXT NOT NULL,
  price_fc INTEGER NOT NULL,
  is_service INTEGER NOT NULL DEFAULT 0,           -- un service n'a pas de stock
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stock (
  agency_id INTEGER NOT NULL REFERENCES agencies(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agency_id, product_id)
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_fc INTEGER NOT NULL, pay_method TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sale_items (
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL, unit_price_fc INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id),
  number TEXT NOT NULL,
  holder_name TEXT NOT NULL, holder_phone TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  UNIQUE (agency_id, number)
);

CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY, phone TEXT NOT NULL, message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

CREATE_NOTIF();

function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
function CREATE_NOTIF() {
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY, channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
    to_addr TEXT NOT NULL, subject TEXT, message TEXT NOT NULL,
    shipment_id INTEGER, merchant_id INTEGER, audience TEXT,
    status TEXT NOT NULL DEFAULT 'enregistre', error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notif_merchant ON notifications(merchant_id, id);`);
}
addColumn('communes', 'lat', 'REAL');
addColumn('communes', 'lng', 'REAL');
addColumn('merchants', 'email', 'TEXT');
addColumn('merchants', 'notify_sms', 'INTEGER NOT NULL DEFAULT 1');
addColumn('merchants', 'notify_email', 'INTEGER NOT NULL DEFAULT 1');
addColumn('shipments', 'recipient_email', 'TEXT');
// Paiement avant le départ du colis : paye | en_attente | compte (facture hebdomadaire du commerçant).
addColumn('shipments', 'payment_status', 'TEXT');
addColumn('shipments', 'payment_ref', 'TEXT');
addColumn('shipments', 'paid_at', 'TEXT');
// Anciens réglages du prix par zone et du supplément dynamique : retirés.
db.exec(`DELETE FROM settings WHERE key IN ('pricing_mode','km_fc','surge_on','busy_score','very_busy_score','busy_pct',
  'very_busy_pct','traffic_hours','traffic_pct','surge_max_pct')`);
addColumn('shipments', 'sender_email', 'TEXT');

export const setting = (key, fallback = null) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
};
export const tx = (fn) => db.transaction(fn);
