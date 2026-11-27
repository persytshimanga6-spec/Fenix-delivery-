import { $, $$, api, esc, fc, when, toast, run, badge, requireLogin, logout, PAY, PAY_STATE, KIN, fillCommunes, heatMap, heatLegend, quoteLines } from '/assets/app.js';

const cfg = await api('/api/config');
$$('[data-company]').forEach((e) => (e.textContent = cfg.company));
const view = $('#view');
const dlg = $('#dlg');
let drivers = [];
const open = (html) => { $('#dlgBody').innerHTML = html + '<button type="button" data-close>Fermer</button>'; dlg.showModal(); };
dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === dlg) dlg.close(); });
const driverOptions = (sel) => `<option value="">Choisir un livreur</option>` + drivers.map((d) => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}${d.zone ? ' · ' + esc(d.zone) : ''}</option>`).join('');
const AGENCY_KIND = { agence: 'Agence', relais: 'Point relais', franchise: 'Franchise' };

const pages = {
  // ---------------- Tableau de bord ----------------
  async dashboard() {
    const d = await api('/api/admin/dashboard');
    drivers = d.drivers;
    view.innerHTML = `<div class="stack" style="gap:20px">
      <div class="spread"><h1>Aujourd'hui</h1><button data-go="colis" class="primary">Voir les colis</button></div>
      <div class="grid">
        ${[['Envois créés', d.today], ['En livraison', d.in_delivery], ['Livrés', d.delivered_today], ['À assigner', d.to_assign],
           ['Échecs à replanifier', d.failed], ['Commerçants à valider', d.pending_merchants]]
          .map(([l, v]) => `<div class="card kpi"><div class="label">${l}</div><div class="v">${v}</div></div>`).join('')}
      </div>
      <div class="grid">
        ${[['Livraisons facturées', fc(d.revenue_today_fc)], ['Ventes en agence', fc(d.sales_today_fc)], ['Cash chez livreurs et agences', fc(d.cash_out_fc)], ['À reverser aux commerçants', fc(d.payouts_due_fc)]]
          .map(([l, v]) => `<div class="card kpi"><div class="label">${l}</div><div class="v" style="font-size:20px">${v}</div></div>`).join('')}
      </div>
      <div class="grid2" style="align-items:start">
        <div class="card stack"><h2>Carte des livreurs</h2><div id="map" class="map tall"></div></div>
        <div class="card stack"><h2>Livreurs</h2>
          <table><thead><tr><th>Nom</th><th>Secteur</th><th>En cours</th><th>Livrés</th><th>Vu</th></tr></thead><tbody>
          ${d.drivers.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.zone || '—')}</td><td>${x.open}</td><td>${x.done}</td><td class="tiny muted">${when(x.last_seen) || '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun livreur</td></tr>'}
          </tbody></table></div>
      </div>
        <div class="card stack"><div class="spread"><h2>Où sont les colis</h2><span class="small muted">Pour envoyer les livreurs au bon endroit</span></div>
          <div class="grid2" style="align-items:start"><div id="heat" class="map tall"></div><div id="heatInfo" class="stack"></div></div></div></div>`;
    const map = L.map('map').setView(KIN, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
    d.drivers.filter((x) => x.last_lat).forEach((x) => L.circleMarker([x.last_lat, x.last_lng], { radius: 9, color: '#110B06', fillOpacity: 1 }).addTo(map).bindTooltip(x.name));
    if (window.__heat) window.__heat.stop();
    window.__heat = heatMap($('#heat'), { onData: (h) => {
      const rows = [...h.communes].sort((a, b) => b.level - a.level || b.demand - a.demand).slice(0, 8);
      $('#heatInfo').innerHTML = heatLegend(h) + `<table><thead><tr><th>Commune</th><th>Colis en attente</th><th>Livreurs présents</th></tr></thead><tbody>
        ${rows.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.demand}</td><td>${c.drivers}</td></tr>`).join('')}</tbody></table>`;
    } });
    const live = await api('/api/admin/shipments?status=en_livraison');
    live.filter((s) => s.to_lat).forEach((s) => L.circleMarker([s.to_lat, s.to_lng], { radius: 7, color: '#F0905A', fillOpacity: 1 }).addTo(map).bindTooltip(`${s.tracking} · ${s.recipient_name}`));
  },

  // ---------------- Colis ----------------
  async colis() {
    view.innerHTML = `<div class="stack"><h1>Colis</h1>
      <form id="filter" class="row card">
        <input name="q" placeholder="N° de suivi, nom ou téléphone" style="flex:1;min-width:200px">
        <select name="status" style="width:auto"><option value="">Tous les statuts</option>${Object.entries(cfg.statuses).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <label class="row small"><input type="checkbox" name="unassigned"> Sans livreur</label>
        <button class="blue">Filtrer</button>
      </form>
      <div class="card scroll"><table><thead><tr><th>N° de suivi</th><th>De</th><th>Vers</th><th>Prix</th><th>Livreur</th><th>Statut</th><th>Assigner</th></tr></thead><tbody id="rows"></tbody></table></div></div>`;
    if (!drivers.length) drivers = (await api('/api/admin/dashboard')).drivers;
    const load = run(async () => {
      const f = new FormData($('#filter'));
      const qs = new URLSearchParams({ q: f.get('q') || '', status: f.get('status') || '', ...(f.get('unassigned') ? { unassigned: 1 } : {}) });
      const rows = await api('/api/admin/shipments?' + qs);
      $('#rows').innerHTML = rows.map((s) => `<tr>
        <td><a href="#" data-detail="${esc(s.tracking)}">${esc(s.tracking)}</a>${s.express ? ' <span class="badge b-en_livraison">Express</span>' : ''}<div class="tiny muted">${when(s.created_at)}</div></td>
        <td>${esc(s.sender_name)}<div class="tiny muted">${esc(s.from_commune)}</div></td>
        <td>${esc(s.recipient_name)}<div class="tiny muted">${esc(s.to_commune)}${s.pickup_agency_id ? ' · retrait agence' : ''}</div></td>
        <td>${fc(s.price_fc)}<div class="tiny muted">${esc(PAY[s.pay_method] || '')}${s.payment_status === 'en_attente' ? ' · <span style="color:#F4B683">non payé</span>' : ''}</div></td>
        <td>${esc(s.driver_name || '—')}</td><td>${badge(s.status, s.label)}${s.shelf ? `<div class="tiny muted">${esc(s.shelf)}</div>` : ''}</td>
        <td>${['cree', 'en_agence', 'ramasse', 'au_depot', 'echec'].includes(s.status) ? `<select data-assign="${esc(s.tracking)}" style="min-width:150px">${driverOptions(s.driver_id)}</select>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="7" class="muted">Aucun colis</td></tr>';
    });
    $('#filter').onsubmit = (e) => { e.preventDefault(); load(); };
    view.onchange = run(async (e) => {
      const sel = e.target.closest('[data-assign]'); if (!sel || !sel.value) return;
      await api(`/api/admin/shipments/${sel.dataset.assign}/assign`, { method: 'POST', body: { driver_id: Number(sel.value) } });
      toast('Livreur assigné');
    });
    load();
  },

  // ---------------- Dépôt ----------------
  async depot() {
    view.innerHTML = `<div class="stack" style="max-width:640px"><h1>Dépôt et tri</h1>
      <p class="muted">Scannez (lecteur de codes-barres) ou tapez le numéro de chaque colis qui arrive au dépôt. L'étagère s'affiche.</p>
      <form id="scan" class="row card"><input id="trk" placeholder="N° de suivi" autofocus style="flex:1"><button class="primary">Scanner</button></form>
      <div id="result"></div><div class="card"><h2>Derniers scans</h2><ul id="last" class="small"></ul></div></div>`;
    $('#scan').onsubmit = run(async (e) => {
      e.preventDefault();
      const t = $('#trk').value.trim().toUpperCase(); $('#trk').value = '';
      const s = await api('/api/admin/depot/scan', { method: 'POST', body: { tracking: t } });
      $('#result').innerHTML = `<div class="card stack" style="background:var(--orange-soft);color:var(--ink);border:1px solid var(--orange)"><div class="small">${esc(s.tracking)}${s.already ? ' · déjà scanné' : ''}</div>
        <div style="font-size:34px;font-weight:800">${esc(s.shelf)}</div><div>${s.pickup_agency_id ? 'À envoyer à l’agence de retrait' : 'À livrer à domicile'}</div></div>`;
      $('#last').insertAdjacentHTML('afterbegin', `<li>${esc(s.tracking)} → ${esc(s.shelf)}</li>`);
      $('#trk').focus();
    });
  },

  // ---------------- Équipe ----------------
  async equipe() {
    const [users, agencies] = await Promise.all([api('/api/admin/users'), api('/api/admin/agencies')]);
    const secteurs = [...new Set(cfg.communes.map((c) => c.secteur))];
    view.innerHTML = `<div class="stack"><h1>Livreurs et équipe</h1>
      <form id="add" class="card grid" style="align-items:end">
        <label class="f">Rôle<select name="role"><option value="livreur">Livreur</option><option value="agent">Agent d'agence</option><option value="admin">Administrateur</option></select></label>
        <label class="f">Nom<input name="name" required></label><label class="f">Téléphone<input name="phone" type="tel" required></label>
        <label class="f">Mot de passe<input name="password" minlength="6" required></label>
        <label class="f">Secteur (livreur)<select name="zone"><option value="">—</option>${secteurs.map((s) => `<option>${esc(s)}</option>`).join('')}</select></label>
        <label class="f">Agence (agent)<select name="agency_id"><option value="">—</option>${agencies.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
        <button class="primary">Ajouter</button>
      </form>
      <div class="card scroll"><table><thead><tr><th>Nom</th><th>Rôle</th><th>Téléphone</th><th>Secteur / agence</th><th>État</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.role)}</td><td>${esc(u.phone)}</td><td>${esc(u.zone || u.agency_name || '—')}</td>
        <td>${u.active ? badge('actif', 'Actif') : badge('suspendu', 'Désactivé')}</td>
        <td class="row" style="gap:6px"><button data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Désactiver' : 'Réactiver'}</button><button data-pass="${u.id}">Nouveau mot de passe</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    $('#add').onsubmit = run(async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      await api('/api/admin/users', { method: 'POST', body: { ...f, agency_id: f.agency_id ? Number(f.agency_id) : null } });
      toast('Compte créé'); pages.equipe();
    });
    view.onclick = run(async (e) => {
      const t = e.target.closest('[data-toggle]');
      if (t) { await api(`/api/admin/users/${t.dataset.toggle}`, { method: 'PATCH', body: { active: t.dataset.active !== '1' } }); return pages.equipe(); }
      const p = e.target.closest('[data-pass]');
      if (p) {
        const pw = prompt('Nouveau mot de passe (6 caractères minimum)'); if (!pw) return;
        await api(`/api/admin/users/${p.dataset.pass}`, { method: 'PATCH', body: { password: pw } }); toast('Mot de passe changé');
      }
    });
  },

  // ---------------- Commerçants ----------------
  async commercants() {
    const ms = await api('/api/admin/merchants');
    view.innerHTML = `<div class="stack"><h1>Commerçants</h1><div class="card scroll"><table><thead><tr><th>Commerce</th><th>Contact</th><th>Ramassage</th><th>Volume</th><th>Envois</th><th>Livraisons à facturer</th><th>Statut</th><th></th></tr></thead><tbody>
      ${ms.map((m) => `<tr><td><strong>${esc(m.name)}</strong><div class="tiny muted">${esc(m.kind || '')}</div></td><td>${esc(m.contact_name)}<div class="tiny muted">${esc(m.phone)}</div></td>
        <td>${esc(m.commune)}<div class="tiny muted">${esc(m.landmark || '')}</div></td><td>${esc(m.volume || '—')}/jour</td><td>${m.shipments}</td>
        <td>${fc(m.unpaid_fc)}${m.unpaid_fc ? ` <button data-settle="${m.id}">Payé</button>` : ''}</td>
        <td>${badge(m.status, m.status.replace('_', ' '))}</td>
        <td class="row" style="gap:6px">${m.status !== 'actif' ? `<button class="primary" data-st="${m.id}" data-v="actif">Valider</button>` : `<button class="danger" data-st="${m.id}" data-v="suspendu">Suspendre</button>`}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucun commerçant</td></tr>'}
      </tbody></table></div></div>`;
    view.onclick = run(async (e) => {
      const b = e.target.closest('[data-st]');
      if (b) { await api(`/api/admin/merchants/${b.dataset.st}/status`, { method: 'POST', body: { status: b.dataset.v } }); toast('Statut mis à jour'); return pages.commercants(); }
      const s = e.target.closest('[data-settle]');
      if (s && confirm('Le commerçant a payé toutes ses livraisons « sur compte » ?')) { await api(`/api/admin/merchants/${s.dataset.settle}/settle-shipping`, { method: 'POST' }); pages.commercants(); }
    });
  },

  // ---------------- Caisse du soir ----------------
  async caisse() {
    const c = await api('/api/admin/cash');
    view.innerHTML = `<div class="stack" style="gap:20px"><h1>Caisse du soir</h1>
      <div class="card scroll"><h2>Argent à récupérer</h2><table><thead><tr><th>Qui</th><th>Cash attendu</th><th>Mobile Money</th><th>Colis</th><th>Cash rendu</th><th></th></tr></thead><tbody>
      ${c.open.map((o) => `<tr><td><strong>${esc(o.name)}</strong><div class="tiny muted">${o.holder_type}</div></td><td>${fc(o.cash_fc)}</td><td>${fc(o.mobile_fc)}</td><td>${o.shipments}</td>
        <td><input type="number" min="0" step="100" value="${o.cash_fc}" id="g-${o.holder_type}-${o.holder_id}" style="width:140px"></td>
        <td><button class="blue" data-close-cash="${o.holder_type}:${o.holder_id}">Valider la remise</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Tout est remis.</td></tr>'}
      </tbody></table></div>
      <div class="card scroll"><h2>Part des livreurs aujourd'hui</h2><table><thead><tr><th>Livreur</th><th>Livrés</th><th>Prix des livraisons</th><th>Part du livreur</th></tr></thead><tbody>
      ${c.drivers.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.delivered}</td><td>${fc(d.port_fc)}</td><td><strong>${fc(d.share_fc)}</strong></td></tr>`).join('')}
      </tbody></table></div>
      <div class="card scroll"><h2>Remises validées aujourd'hui</h2><table><thead><tr><th>Qui</th><th>Attendu</th><th>Rendu</th><th>Écart</th><th>Mobile Money</th><th>Note</th></tr></thead><tbody>
      ${c.closings.map((x) => `<tr><td>${esc(x.name)}</td><td>${fc(x.expected_cash_fc)}</td><td>${fc(x.given_cash_fc)}</td>
        <td>${x.gap_fc ? badge('echec', fc(x.gap_fc)) : badge('livre', 'OK')}</td><td>${fc(x.mobile_fc)}</td><td class="small">${esc(x.note || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune</td></tr>'}
      </tbody></table></div></div>`;
    view.onclick = run(async (e) => {
      const b = e.target.closest('[data-close-cash]'); if (!b) return;
      const [type, id] = b.dataset.closeCash.split(':');
      const given = Number($(`#g-${type}-${id}`).value);
      const note = prompt('Note (facultatif, ex. raison de l’écart)') || '';
      const r = await api('/api/admin/cash/close', { method: 'POST', body: { holder_type: type, holder_id: Number(id), given_cash_fc: given, note } });
      toast(r.gap_fc ? `Remise validée avec un écart de ${fc(r.gap_fc)}` : 'Remise validée'); pages.caisse();
    });
  },

  // ---------------- Reversements ----------------
  async reversements() {
    const p = await api('/api/admin/payouts');
    view.innerHTML = `<div class="stack" style="gap:20px"><h1>Reversements aux commerçants</h1>
      <p class="muted" style="margin:0">Envoyez l'argent par Mobile Money, puis notez la référence de la transaction. Le commerçant est prévenu par SMS et e-mail.</p>
      <div class="card scroll"><table><thead><tr><th>Commerçant</th><th>Colis payés</th><th>À reverser</th><th>Compte</th><th>Depuis</th><th></th></tr></thead><tbody>
      ${p.due.map((d) => `<tr><td><strong>${esc(d.name)}</strong></td><td>${d.shipments}</td><td><strong>${fc(d.amount_fc)}</strong></td>
        <td>${esc(PAY[d.payout_operator] || d.payout_operator || '')} · ${esc(d.payout_number || '')}</td><td class="small">${when(d.oldest)}</td>
        <td><button class="primary" data-pay="${d.merchant_id}">Marquer reversé</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Rien à reverser.</td></tr>'}
      </tbody></table></div>
      <div class="card scroll"><h2>Derniers reversements</h2><table><thead><tr><th>Commerçant</th><th>Montant</th><th>Référence</th><th>Date</th></tr></thead><tbody>
      ${p.recent.map((r) => `<tr><td>${esc(r.name)}</td><td>${fc(r.amount_fc)}</td><td>${esc(r.reference)}</td><td>${when(r.paid_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun</td></tr>'}
      </tbody></table></div></div>`;
    view.onclick = run(async (e) => {
      const b = e.target.closest('[data-pay]'); if (!b) return;
      const ref = prompt('Référence de la transaction Mobile Money'); if (!ref) return;
      const r = await api('/api/admin/payouts/pay', { method: 'POST', body: { merchant_id: Number(b.dataset.pay), reference: ref } });
      toast(`${fc(r.paid_fc)} reversés`); pages.reversements();
    });
  },

  // ---------------- Agences ----------------
  async agences() {
    const ags = await api('/api/admin/agencies');
    view.innerHTML = `<div class="stack" style="gap:20px"><h1>Agences, points relais et franchises</h1>
      <form id="add" class="card grid" style="align-items:end">
        <label class="f">Nom<input name="name" required></label>
        <label class="f">Type<select name="kind"><option value="agence">Agence</option><option value="relais">Point relais</option><option value="franchise">Franchise</option></select></label>
        <label class="f">Commune<select name="commune" id="agCommune"></select></label>
        <label class="f">Adresse / repère<input name="address"></label>
        <label class="f">Commission (%)<input name="commission_pct" type="number" min="0" max="100" step="0.5" value="0"></label>
        <label class="f">Latitude<input name="lat" type="number" step="any"></label><label class="f">Longitude<input name="lng" type="number" step="any"></label>
        <button class="primary">Ajouter</button>
      </form>
      <div class="card scroll"><table><thead><tr><th>Nom</th><th>Type</th><th>Commune</th><th>Commission</th><th>Colis à retirer</th><th>Ventes du jour</th><th></th></tr></thead><tbody>
      ${ags.map((a) => `<tr><td><strong>${esc(a.name)}</strong><div class="tiny muted">${esc(a.address || '')}</div></td><td>${AGENCY_KIND[a.kind]}</td><td>${esc(a.commune || '')}</td>
        <td>${a.commission_pct} %</td><td>${a.waiting}</td><td>${fc(a.sales_today_fc)}</td>
        <td class="row" style="gap:6px"><a class="btn" href="/agence/?agency_id=${a.id}">Caisse</a><button data-active="${a.id}" data-v="${a.active ? 0 : 1}">${a.active ? 'Fermer' : 'Rouvrir'}</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    fillCommunes($('#agCommune'), cfg.communes);
    $('#add').onsubmit = run(async (e) => {
      e.preventDefault();
      await api('/api/admin/agencies', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Agence ajoutée'); pages.agences();
    });
    view.onclick = run(async (e) => {
      const b = e.target.closest('[data-active]'); if (!b) return;
      await api(`/api/admin/agencies/${b.dataset.active}`, { method: 'PATCH', body: { active: b.dataset.v === '1' } }); pages.agences();
    });
  },

  // ---------------- Articles ----------------
  async articles() {
    const [{ products, stock }, ags] = await Promise.all([api('/api/admin/products'), api('/api/admin/agencies')]);
    const qty = (a, p) => stock.find((s) => s.agency_id === a && s.product_id === p)?.qty ?? 0;
    view.innerHTML = `<div class="stack" style="gap:20px"><h1>Articles, services et stock</h1>
      <form id="add" class="card grid" style="align-items:end">
        <label class="f">Nom<input name="name" required></label>
        <label class="f">Catégorie<input name="category" list="cats" required></label>
        <datalist id="cats">${[...new Set(products.map((p) => p.category))].map((c) => `<option>${esc(c)}</option>`).join('')}</datalist>
        <label class="f">Prix (FC)<input name="price_fc" type="number" min="1" required></label>
        <label class="row small"><input type="checkbox" name="is_service"> C'est un service (pas de stock)</label>
        <button class="primary">Ajouter</button>
      </form>
      <div class="card scroll"><table><thead><tr><th>Article</th><th>Catégorie</th><th>Prix</th>${ags.map((a) => `<th>${esc(a.name)}</th>`).join('')}<th></th></tr></thead><tbody>
      ${products.map((p) => `<tr class="${p.active ? '' : 'muted'}"><td>${esc(p.name)}</td><td>${esc(p.category)}</td>
        <td><input type="number" value="${p.price_fc}" data-price="${p.id}" style="width:110px"></td>
        ${ags.map((a) => `<td>${p.is_service ? '<span class="tiny muted">service</span>' : `${qty(a.id, p.id)} <button data-stock="${a.id}:${p.id}" style="height:32px;padding:0 10px">+/−</button>`}</td>`).join('')}
        <td><button data-prod="${p.id}" data-v="${p.active ? 0 : 1}">${p.active ? 'Retirer' : 'Remettre'}</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    $('#add').onsubmit = run(async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      await api('/api/admin/products', { method: 'POST', body: { ...f, is_service: !!f.is_service } }); toast('Ajouté'); pages.articles();
    });
    view.onchange = run(async (e) => {
      const i = e.target.closest('[data-price]'); if (!i) return;
      await api(`/api/admin/products/${i.dataset.price}`, { method: 'PATCH', body: { price_fc: Number(i.value) } }); toast('Prix mis à jour');
    });
    view.onclick = run(async (e) => {
      const s = e.target.closest('[data-stock]');
      if (s) {
        const [a, p] = s.dataset.stock.split(':').map(Number);
        const d = prompt('Quantité reçue (ex. 20) ou retirée (ex. -3)'); if (!d) return;
        await api('/api/admin/stock', { method: 'POST', body: { agency_id: a, product_id: p, delta: Number(d) } }); return pages.articles();
      }
      const p = e.target.closest('[data-prod]');
      if (p) { await api(`/api/admin/products/${p.dataset.prod}`, { method: 'PATCH', body: { active: p.dataset.v === '1' } }); pages.articles(); }
    });
  },

  // ---------------- Tarifs ----------------
  async tarifs() {
    const t = await api('/api/admin/rates');
    const S = t.settings;
    const secteurs = [...new Set(t.communes.map((c) => c.secteur))];
    const field = (name, label, attrs = 'type="number" min="0"') => `<label class="f">${label}<input name="${name}" ${attrs} value="${esc(S[name] ?? '')}"></label>`;
    view.innerHTML = `<form id="f" class="stack" style="gap:20px"><div class="spread"><h1>Tarifs et réglages</h1><button class="primary">Enregistrer</button></div>
      <div class="card stack"><h2>Prix calculé pour chaque trajet</h2>
        <p class="muted small" style="margin:0">Prix = prise en charge + carburant + temps de trajet. Carburant = distance × consommation × prix du litre.
          Temps = distance ÷ vitesse ; à l'heure de pointe la vitesse est plus basse, donc le trajet est plus long. Aucun supplément en %.</p>
        <div class="grid">
          ${field('base_petit_fc', 'Prise en charge · petit (FC)')}
          ${field('base_moyen_fc', 'Prise en charge · moyen (FC)')}
          ${field('base_grand_fc', 'Prise en charge · grand (FC)')}
          ${field('fuel_price_fc', 'Prix du carburant (FC par litre)')}
          ${field('fuel_l_per_km', 'Consommation (litres par km)', 'type="number" min="0" step="0.001"')}
          ${field('minute_fc', 'Tarif à la minute de trajet (FC)')}
          ${field('speed_normal_kmh', 'Vitesse normale (km/h)')}
          ${field('speed_rush_kmh', 'Vitesse à l’heure de pointe (km/h)')}
          ${field('rush_hours', 'Heures de pointe (ex. 6-9,16-19 ; sauf dimanche)', 'type="text"')}
          ${field('road_factor', 'Détour moyen par la route (×)', 'type="number" min="1" step="0.05"')}
        </div>
        <div class="card" style="background:var(--bg)"><div class="label">Essai</div>
          <div class="grid" style="grid-template-columns:1fr 1fr 120px auto;align-items:end"><select id="tFrom"></select><select id="tTo"></select>
          <select id="tSize"><option>petit</option><option>moyen</option><option>grand</option></select><button type="button" id="tGo">Calculer</button></div>
          <div id="tOut" class="small" style="margin-top:8px"></div><p class="tiny muted" style="margin:6px 0 0">Enregistrez d'abord pour essayer les nouveaux réglages.</p></div>
      </div>
      <div class="card stack"><h2>Numéros Mobile Money de l'entreprise</h2>
        <p class="muted small" style="margin:0">Affichés aux clients pour payer avant le départ du colis.</p>
        <div class="grid">
          ${field('momo_mpesa', 'M-Pesa', 'type="tel"')}${field('momo_airtel', 'Airtel Money', 'type="tel"')}${field('momo_orange', 'Orange Money', 'type="tel"')}
        </div></div>
      <div class="card grid">
        <label class="f">Nom de la société<input name="company_name" value="${esc(S.company_name)}"></label>
        <label class="f">Supplément express (FC)<input name="express_supplement_fc" type="number" value="${esc(S.express_supplement_fc)}"></label>
        <label class="f">Frais d'encaissement (% de la marchandise)<input name="cod_fee_pct" type="number" step="0.1" value="${esc(S.cod_fee_pct)}"></label>
        <label class="f">Assurance (% de la valeur)<input name="insurance_pct" type="number" step="0.1" value="${esc(S.insurance_pct)}"></label>
        <label class="f">Deuxième tentative / retour (FC)<input name="retry_fee_fc" type="number" value="${esc(S.retry_fee_fc)}"></label>
        <label class="f">Part du livreur (% du prix)<input name="driver_share_pct" type="number" value="${esc(S.driver_share_pct)}"></label>
        <label class="f">Commission point relais (%)<input name="relay_commission_pct" type="number" value="${esc(S.relay_commission_pct)}"></label>
      </div>
      <div class="card stack"><h2>Secteurs des communes</h2><p class="muted small" style="margin:0">Servent au tri des colis au dépôt (étagères), pas au prix.</p>
      <div class="grid">${t.communes.map((c) => `<label class="f">${esc(c.name)}<select data-commune="${esc(c.name)}">${secteurs.map((s) => `<option ${s === c.secteur ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`).join('')}</div></div>
      </form>`;
    $('#f').onsubmit = run(async (e) => {
      e.preventDefault();
      const settings = Object.fromEntries(new FormData(e.target));
      const communes = $$('[data-commune]').map((s) => ({ name: s.dataset.commune, secteur: s.value }));
      await api('/api/admin/rates', { method: 'PUT', body: { settings, communes } }); toast('Réglages enregistrés');
    });
    fillCommunes($('#tFrom'), t.communes); fillCommunes($('#tTo'), t.communes);
    $('#tFrom').value = 'Gombe'; $('#tTo').value = 'Limete';
    $('#tGo').onclick = run(async () => {
      const q = await api('/api/quote?detail=1', { method: 'POST', body: { from_commune: $('#tFrom').value, to_commune: $('#tTo').value, size: $('#tSize').value } });
      $('#tOut').innerHTML = quoteLines(q) + `<div class="spread"><strong>Total</strong><strong>${fc(q.price_fc)}</strong></div>`;
    });
  },

  async paiements() {
    const rows = await api('/api/admin/payments');
    view.innerHTML = `<div class="stack"><h1>Paiements à confirmer</h1>
      <p class="muted" style="margin:0">Le client paie avant le départ du colis. Vérifiez la référence Mobile Money sur le téléphone de l'entreprise, puis confirmez.
        Les espèces se confirment au comptoir d'une agence. Tant que ce n'est pas confirmé, aucun livreur ne peut prendre le colis.</p>
      <div class="card scroll"><table><thead><tr><th>N° de suivi</th><th>Expéditeur</th><th>Trajet</th><th>Montant</th><th>Moyen · référence</th><th></th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td>${esc(s.tracking)}<div class="tiny muted">${when(s.created_at)}</div></td>
        <td>${esc(s.sender_name)}<div class="tiny muted">${esc(s.sender_phone)}</div></td><td class="small">${esc(s.from_commune)} → ${esc(s.to_commune)}</td>
        <td><strong>${fc(s.price_fc)}</strong></td><td class="small">${esc(PAY[s.pay_method] || s.pay_method)}${s.payment_ref ? `<div class="tiny">${esc(s.payment_ref)}</div>` : ''}</td>
        <td>${s.pay_method === 'cash' ? '<span class="small muted">Au comptoir</span>' : `<button class="primary" data-confirm="${esc(s.tracking)}">Paiement vérifié</button>`}</td></tr>`).join('')
        || '<tr><td colspan="6" class="muted">Aucun paiement en attente.</td></tr>'}
      </tbody></table></div></div>`;
    view.querySelector('tbody').onclick = run(async (e) => {
      const b = e.target.closest('[data-confirm]'); if (!b) return;
      if (!confirm(`Confirmer le paiement de ${b.dataset.confirm} ?`)) return;
      await api(`/api/admin/shipments/${encodeURIComponent(b.dataset.confirm)}/confirm-payment`, { method: 'POST', body: {} });
      toast('Paiement confirmé'); pages.paiements();
    });
  },

  async compte() {
    const { user } = await api('/api/me');
    view.innerHTML = `<div class="stack" style="max-width:560px"><h1>Mon compte</h1>
      <form id="meInfo" class="card stack"><div class="label">Connexion</div>
        <label class="f">Nom<input name="name" value="${esc(user.name || '')}"></label>
        <label class="f">Numéro de téléphone (sert à se connecter)<input name="phone" type="tel" value="${esc(user.phone)}"></label>
        <button class="primary">Enregistrer</button></form>
      <form id="mePass" class="card stack"><div class="label">Changer le mot de passe</div>
        <label class="f">Mot de passe actuel<input name="current" type="password" required autocomplete="current-password"></label>
        <label class="f">Nouveau mot de passe (6 caractères minimum)<input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
        <label class="f">Répéter le nouveau mot de passe<input name="again" type="password" minlength="6" required autocomplete="new-password"></label>
        <button class="primary">Changer le mot de passe</button></form></div>`;
    $('#meInfo').onsubmit = run(async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      await api('/api/me', { method: 'PATCH', body: { name: f.get('name'), phone: f.get('phone') } });
      toast('Enregistré. Utilisez ce numéro à la prochaine connexion.');
    });
    $('#mePass').onsubmit = run(async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      if (f.get('password') !== f.get('again')) { toast('Les deux nouveaux mots de passe ne sont pas pareils'); return; }
      await api('/api/me/password', { method: 'POST', body: { current: f.get('current'), password: f.get('password') } });
      e.target.reset(); toast('Mot de passe changé');
    });
  },
  async sms() {
    const rows = await api('/api/admin/notifications');
    const st = { envoye: 'Envoyé', enregistre: 'Enregistré', envoi: 'En cours', echec: 'Échec' };
    view.innerHTML = `<div class="stack"><h1>Notifications</h1><p class="muted" style="margin:0">SMS et e-mails envoyés automatiquement aux clients et aux vendeurs. « Enregistré » : aucun fournisseur SMS ou e-mail n'est encore branché (voir le guide d'installation).</p>
      <div class="card scroll"><table><thead><tr><th>Date</th><th>Canal</th><th>Pour</th><th>Colis</th><th>Message</th><th>État</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="small">${when(r.created_at)}</td><td>${r.channel === 'email' ? 'E-mail' : 'SMS'}</td>
        <td>${r.audience === 'client' ? 'Client' : r.audience === 'vendeur' ? 'Vendeur' : '—'}<div class="tiny muted">${esc(r.to_addr)}</div></td>
        <td class="small">${esc(r.tracking || r.merchant_name || '')}</td>
        <td class="small">${r.subject ? `<strong>${esc(r.subject)}</strong><br>` : ''}${esc(r.message)}</td>
        <td class="small">${esc(st[r.status] || r.status)}${r.error ? `<div class="tiny muted">${esc(r.error)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune notification</td></tr>'}
      </tbody></table></div></div>`;
  }
};

// Détail d'un colis (historique, actions)
view.addEventListener('click', run(async (e) => {
  const a = e.target.closest('[data-detail]'); if (!a) return;
  e.preventDefault();
  const s = await api('/api/admin/shipments/' + a.dataset.detail);
  open(`<div class="spread"><h2>${esc(s.tracking)}</h2>${badge(s.status, s.label)}</div>
    <div class="grid2 small">
      <div><div class="label">De</div>${esc(s.sender_name)} · ${esc(s.sender_phone)}<br>${esc(s.from_commune)} · ${esc(s.from_landmark || '')}</div>
      <div><div class="label">À</div>${esc(s.recipient_name)} · ${esc(s.recipient_phone)}<br>${esc(s.to_commune)} · ${esc(s.to_landmark || 'Retrait en agence')}</div>
      <div><div class="label">Colis</div>${esc(s.size)} · ${esc(s.description || '')}<br>Prix ${fc(s.price_fc)} · ${esc(PAY[s.pay_method] || '')} · ${esc(PAY_STATE[s.payment_status] || (s.shipping_paid ? 'Payé' : ''))}${s.payment_ref ? ` · réf. ${esc(s.payment_ref)}` : ''}</div>
      <div><div class="label">À encaisser</div>${fc(s.due.total)}${s.cod_amount_fc ? ` (dont marchandise ${fc(s.cod_amount_fc)})` : ''}</div>
    </div>
    ${s.photo ? `<a href="/photos/${esc(s.photo)}" target="_blank" rel="noopener">Voir la photo de livraison</a>` : ''}
    <ol class="timeline">${s.events.map((ev) => `<li><div><strong>${esc(ev.label)}</strong> <span class="tiny muted">${when(ev.created_at)} · ${esc(ev.user_name || '')}</span>${ev.note ? `<div class="small muted">${esc(ev.note)}</div>` : ''}</div></li>`).join('')}</ol>
    <div class="row">
      <a class="btn" href="/etiquette/${esc(s.tracking)}" target="_blank" rel="noopener">Étiquette</a>
      <button data-resend="${esc(s.tracking)}">Renvoyer un code au client</button>
      ${s.status === 'echec' ? `<button data-move="${esc(s.tracking)}" data-to="retour">Retour à l'expéditeur</button>` : ''}
      ${s.status === 'cree' ? `<button class="danger" data-move="${esc(s.tracking)}" data-to="annule">Annuler l'envoi</button>` : ''}
    </div>`);
}));
$('#dlgBody').addEventListener('click', run(async (e) => {
  const r = e.target.closest('[data-resend]');
  if (r) { await api(`/api/admin/shipments/${r.dataset.resend}/resend-code`, { method: 'POST' }); return toast('Nouveau code envoyé par SMS'); }
  const m = e.target.closest('[data-move]');
  if (m && confirm('Confirmer ?')) { await api(`/api/admin/shipments/${m.dataset.move}/status`, { method: 'POST', body: { status: m.dataset.to } }); dlg.close(); toast('Statut changé'); go('colis'); }
}));

const go = run(async (name) => {
  if (!pages[name]) name = 'dashboard';
  $$('.sidebar [data-go]').forEach((b) => (b.dataset.go === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  view.onclick = null; view.onchange = null;
  history.replaceState(null, '', '#' + name);
  await pages[name]();
});
document.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
$('#out').onclick = logout;
requireLogin(['admin'], () => go(location.hash.slice(1) || 'dashboard'));
