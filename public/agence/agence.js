import { $, $$, api, esc, fc, when, toast, run, pills, fillCommunes, mapPicker, requireLogin, logout, PAY, quoteLines } from '/assets/app.js';

const cfg = await api('/api/config');
$$('[data-company]').forEach((e) => (e.textContent = cfg.company));
const agencyParam = new URLSearchParams(location.search).get('agency_id');
const q = (url) => (agencyParam ? `${url}${url.includes('?') ? '&' : '?'}agency_id=${agencyParam}` : url);
const A = (url, opts) => api(q('/api/agency' + url), opts);
const MONEY = ['cash', 'mpesa', 'orange', 'airtel'].map((m) => [m, PAY[m]]);

let info, cart = new Map(), salePay = 'cash', picker;
const ship = { size: 'petit', pay_method: 'cash', mode: 'domicile', to_lat: null, to_lng: null };

const load = async () => { info = await A('/info'); $('#agencyName').textContent = info.agency.name; };

// ---------------- Vente ----------------
function renderCatalog() {
  const term = $('#search').value.toLowerCase();
  const cats = {};
  for (const p of info.products) if (!term || p.name.toLowerCase().includes(term)) (cats[p.category] ||= []).push(p);
  $('#catalog').innerHTML = Object.entries(cats).map(([c, ps]) => `<div class="stack" style="gap:8px"><div class="label">${esc(c)}</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">${ps.map((p) => `<button class="prod" data-add="${p.id}" ${!p.is_service && !p.qty ? 'disabled' : ''}>
      <span>${esc(p.name)}</span><strong>${fc(p.price_fc)}</strong><small>${p.is_service ? 'Service' : `Stock : ${p.qty ?? 0}`}</small></button>`).join('')}</div></div>`).join('')
    || '<p class="muted">Aucun article</p>';
}
function renderCart() {
  let total = 0;
  $('#cart').innerHTML = [...cart.entries()].map(([id, n]) => {
    const p = info.products.find((x) => x.id === id); total += p.price_fc * n;
    return `<div class="cartline"><span>${esc(p.name)}</span><span class="row qty" style="gap:4px"><button data-dec="${id}" aria-label="Moins">−</button>${n}<button data-inc="${id}" aria-label="Plus">+</button></span><span>${fc(p.price_fc * n)}</span></div>`;
  }).join('') || '<p class="muted">Touchez un article pour l’ajouter.</p>';
  $('#cartTotal').textContent = fc(total);
}
$('#search').oninput = renderCatalog;
document.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]'), inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]');
  const id = Number((add || inc || dec)?.dataset.add || (add || inc || dec)?.dataset.inc || (add || inc || dec)?.dataset.dec);
  if (!id) return;
  const p = info.products.find((x) => x.id === id);
  const n = cart.get(id) || 0;
  if (add || inc) { if (!p.is_service && n + 1 > (p.qty || 0)) return toast('Stock insuffisant', true); cart.set(id, n + 1); }
  if (dec) n <= 1 ? cart.delete(id) : cart.set(id, n - 1);
  renderCart();
});
pills($('#salePay'), MONEY, salePay, (v) => (salePay = v));
$('#checkout').onclick = run(async () => {
  if (!cart.size) throw new Error('Panier vide');
  const s = await A('/sales', { method: 'POST', body: { pay_method: salePay, items: [...cart].map(([product_id, qty]) => ({ product_id, qty })) } });
  window.open(q(`/api/agency/sales/${s.id}/recu`), '_blank', 'noopener');
  toast(`Vente enregistrée : ${fc(s.total_fc)}`);
  cart.clear(); await load(); renderCatalog(); renderCart();
});

// ---------------- Nouvel envoi ----------------
const form = $('#ship');
fillCommunes($('#toCommune'), cfg.communes);
$('#pickupAgency').innerHTML = cfg.agencies.map((a) => `<option value="${a.id}" data-commune="${esc(a.commune || '')}">${esc(a.name)}</option>`).join('');
const quote = run(async () => {
  const f = new FormData(form);
  if (!f.get('to_commune')) return;
  const r = await api('/api/quote', { method: 'POST', body: { from_commune: info.agency.commune, from_lat: info.agency.lat, from_lng: info.agency.lng, to_commune: f.get('to_commune'), size: ship.size,
    ...(ship.mode === 'domicile' ? { to_lat: ship.to_lat, to_lng: ship.to_lng } : { pickup_agency_id: f.get('pickup_agency_id') }),
    express: !!f.get('express'), insured: !!f.get('insured'), declared_value_fc: f.get('declared_value_fc') } });
  $('#quoteLines').innerHTML = quoteLines(r);
  $('#price').textContent = fc(r.price_fc);
});
form.oninput = quote;
$('#insured').onchange = () => $('#valueField').classList.toggle('hidden', !$('#insured').checked);
$('#pickupAgency').onchange = () => { $('#toCommune').value = $('#pickupAgency').selectedOptions[0]?.dataset.commune || ''; quote(); };
const setMode = (v) => {
  ship.mode = v;
  $('#homeFields').classList.toggle('hidden', v !== 'domicile');
  $('#agencyField').classList.toggle('hidden', v !== 'agence');
  if (v === 'agence') $('#pickupAgency').onchange();
  if (v === 'domicile' && picker) setTimeout(() => picker.map.invalidateSize(), 50);
};
pills($('#mode'), [['domicile', 'Livraison à domicile'], ['agence', 'Retrait en agence']], ship.mode, setMode);
setMode('domicile');
pills($('#size'), [['petit', 'Petit'], ['moyen', 'Moyen'], ['grand', 'Grand']], ship.size, (v) => { ship.size = v; quote(); });
pills($('#shipPay'), MONEY, ship.pay_method, (v) => { ship.pay_method = v; $('#shipRefField').classList.toggle('hidden', v === 'cash'); });
form.onsubmit = run(async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const body = { ...f, size: ship.size, pay_method: ship.pay_method, express: !!f.express, insured: !!f.insured };
  if (ship.pay_method === 'cash') delete body.payment_ref;
  if (ship.mode === 'domicile') { body.to_lat = ship.to_lat; body.to_lng = ship.to_lng; delete body.pickup_agency_id; } else delete body.to_landmark;
  const s = await A('/shipments', { method: 'POST', body });
  window.open('/etiquette/' + s.tracking, '_blank', 'noopener');
  toast(`Envoi ${s.tracking} enregistré · ${fc(s.price_fc)}`);
  form.reset(); $('#price').textContent = '—'; $('#quoteLines').innerHTML = '';
});

// ---------------- Paiements à confirmer ----------------
async function renderPending() {
  const rows = await A('/payments');
  $('#payCount').textContent = rows.length; $('#payCount').classList.toggle('hidden', !rows.length);
  $('#pending').innerHTML = rows.map((s) => `<tr><td>${esc(s.tracking)}<div class="tiny muted">${when(s.created_at)}</div></td>
    <td>${esc(s.sender_name)}<div class="tiny muted">${esc(s.sender_phone)}</div></td><td class="small">${esc(s.from_commune)} → ${esc(s.to_commune)}</td>
    <td><strong>${fc(s.price_fc)}</strong></td><td class="small">${esc(PAY[s.pay_method] || s.pay_method)}${s.payment_ref ? `<div class="tiny">${esc(s.payment_ref)}</div>` : ''}</td>
    <td><button class="primary" data-confirm="${esc(s.tracking)}" data-method="${esc(s.pay_method)}">${s.pay_method === 'cash' ? 'Espèces reçues + colis déposé' : 'Paiement vérifié'}</button></td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">Aucun paiement en attente.</td></tr>';
}
$('#pending').onclick = run(async (e) => {
  const b = e.target.closest('[data-confirm]'); if (!b) return;
  if (!confirm(`Confirmer le paiement de ${b.dataset.confirm} ?`)) return;
  await A(`/shipments/${encodeURIComponent(b.dataset.confirm)}/confirm-payment`, { method: 'POST', body: { method: b.dataset.method, deposit: b.dataset.method === 'cash' } });
  toast('Paiement confirmé. Le colis peut partir.'); await renderPending();
});

// ---------------- Retrait ----------------
let hPay = 'cash', hTrk = null;
function renderWaiting() {
  $('#waiting').innerHTML = info.waiting.map((s) => `<tr><td>${esc(s.tracking)}<div class="tiny muted">${when(s.created_at)}</div></td>
    <td>${esc(s.recipient_name)}<div class="tiny muted">${esc(s.recipient_phone)}</div></td><td>${s.due ? fc(s.due) : 'Rien'}</td>
    <td><button class="blue" data-hand="${esc(s.tracking)}">Remettre</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun colis en attente.</td></tr>';
}
$('#waiting').onclick = (e) => {
  const b = e.target.closest('[data-hand]'); if (!b) return;
  const s = info.waiting.find((x) => x.tracking === b.dataset.hand);
  hTrk = s.tracking; hPay = 'cash';
  $('#handover').reset(); $('#handover').classList.remove('hidden');
  $('#hTitle').textContent = s.tracking;
  $('#hInfo').innerHTML = `${esc(s.recipient_name)} · ${s.due ? `<strong>À encaisser : ${fc(s.due)}</strong>` : 'Rien à payer'}`;
  $('#hPayBox').classList.toggle('hidden', !s.due);
  pills($('#hPay'), MONEY, hPay, (v) => (hPay = v));
  $('[name=otp]', $('#handover')).focus();
};
$('#handover').onsubmit = run(async (e) => {
  e.preventDefault();
  await A('/handover', { method: 'POST', body: { tracking: hTrk, otp: new FormData(e.target).get('otp'), method: hPay } });
  toast('Colis remis ✓'); $('#handover').classList.add('hidden'); await load(); renderWaiting();
});

// ---------------- Réception ----------------
$('#rec').onsubmit = run(async (e) => {
  e.preventDefault();
  const t = $('#recTrk').value.trim().toUpperCase(); $('#recTrk').value = '';
  const s = await A('/shipments/' + encodeURIComponent(t));
  let r, msg;
  if (s.pickup_agency_id === info.agency.id && s.status !== 'disponible_agence') { r = await A('/receive', { method: 'POST', body: { tracking: t } }); msg = 'Disponible pour le client (SMS envoyé)'; }
  else if (info.agency.kind === 'agence') { r = await A('/depot-scan', { method: 'POST', body: { tracking: t } }); msg = `Étagère : ${r.shelf}`; }
  else throw new Error('Ce colis n’est pas pour cette agence');
  $('#recOut').innerHTML = `<div class="card" style="background:var(--orange-soft);color:var(--ink);border:1px solid var(--orange)"><div class="small">${esc(r.tracking)}</div><div style="font-size:26px;font-weight:800">${esc(msg)}</div></div>`;
  await load(); renderDeposited(); $('#recTrk').focus();
});
const renderDeposited = () => {
  $('#recHelp').textContent = info.agency.kind === 'agence'
    ? 'Dépôt central : scannez chaque colis qui arrive. Les colis à retirer ici deviennent disponibles, les autres reçoivent leur étagère.'
    : 'Point relais : scannez les colis que le livreur vous apporte pour vos clients.';
  $('#deposited').innerHTML = info.deposited.map((s) => `<li>${esc(s.tracking)} · ${esc(s.recipient_name)} → ${esc(s.to_commune)}</li>`).join('') || '<li class="muted">Aucun</li>';
};

// ---------------- Boîtes postales ----------------
const renderBoxes = () => ($('#boxes').innerHTML = info.mailboxes.map((b) => `<tr><td>${esc(b.number)}</td><td>${esc(b.holder_name)}</td><td>${esc(b.holder_phone)}</td><td>${esc(b.expires_on)}</td></tr>`).join('')
  || '<tr><td colspan="4" class="muted">Aucune boîte attribuée</td></tr>');
$('#box').onsubmit = run(async (e) => {
  e.preventDefault();
  await A('/mailboxes', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
  toast('Boîte attribuée'); e.target.reset(); await load(); renderBoxes();
});

// ---------------- Caisse ----------------
function renderCash() {
  const by = (m) => info.cash.filter((c) => (m === 'cash' ? c.method === 'cash' : c.method !== 'cash')).reduce((s, c) => s + c.total, 0);
  const KIND = { port: 'Envois', vente: 'Ventes', marchandise: 'Marchandise (pour commerçants)' };
  $('#cashSummary').innerHTML = `<div class="grid">
    <div class="kpi"><div class="label">Cash attendu dans la caisse</div><div class="v">${fc(by('cash'))}</div></div>
    <div class="kpi"><div class="label">Reçu en Mobile Money</div><div class="v">${fc(by('mobile'))}</div></div></div>
    <table style="margin-top:12px"><tbody>${info.cash.map((c) => `<tr><td>${esc(KIND[c.kind] || c.kind)}</td><td>${esc(PAY[c.method])}</td><td>${fc(c.total)}</td></tr>`).join('')}</tbody></table>`;
  $('#sales').innerHTML = info.sales_today.map((s) => `<li><a href="${q(`/api/agency/sales/${s.id}/recu`)}" target="_blank" rel="noopener">Reçu n° ${s.id}</a> · ${fc(s.total_fc)} · ${esc(PAY[s.pay_method])} · ${when(s.created_at)}</li>`).join('') || '<li class="muted">Aucune vente</li>';
}
$('#close').onsubmit = run(async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const r = await A('/close', { method: 'POST', body: f });
  toast(r.gap_fc ? `Caisse clôturée avec un écart de ${fc(r.gap_fc)}` : 'Caisse clôturée, aucun écart');
  e.target.reset(); await load(); renderCash();
});

// ---------------- Navigation ----------------
async function tab() {
  const t = (location.hash || '#vente').slice(1);
  $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== t));
  await load();
  if (t === 'vente') { renderCatalog(); renderCart(); }
  if (t === 'envoi') {
    if (!picker) picker = mapPicker($('#map'), (la, ln) => { ship.to_lat = la; ship.to_lng = ln; }, info.agency.lat ? null : null);
    setTimeout(() => picker.map.invalidateSize(), 50);
  }
  if (t === 'paiements') await renderPending();
  if (t === 'retrait') renderWaiting();
  if (t === 'reception') renderDeposited();
  if (t === 'boites') renderBoxes();
  if (t === 'caisse') renderCash();
}
$('#out').onclick = (e) => { e.preventDefault(); logout(); };
requireLogin(['agent', 'admin'], run(async (u) => {
  if (u.role === 'admin' && !agencyParam) {
    const a = cfg.agencies[0];
    if (!a) throw new Error('Créez d’abord une agence dans le back office');
    location.search = '?agency_id=' + a.id; return;
  }
  window.onhashchange = run(tab); await tab();
}));
