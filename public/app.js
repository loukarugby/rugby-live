// Frontend : demande les données à NOTRE backend (/api/...) et les affiche.
const COMPS = [['top14', 'Top 14'], ['prod2', 'Pro D2'], ['france', 'XV de France']];
let comp = 'top14', vue = 'matchs', matchs = null, classements = {}, classErr = {}, maj = null, erreur = false;
let cal = {}, calErr = {}, calAt = {}, journeeChoisie = {}; // calendrier de la saison, par compétition
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function charger(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erreur || r.status);
  return j;
}
async function majMatchs() {
  try { const j = await charger('/api/matchs'); matchs = j.competitions; maj = new Date(j.majServeur); erreur = false; }
  catch { erreur = true; }
  render();
}
// Le serveur ne demande le calendrier à Highlightly qu'une fois par semaine : ici on ne fait que le relire chez lui (gratuit).
async function majCalendrier(k = comp) {
  try { cal[k] = await charger('/api/calendrier?comp=' + k); calErr[k] = null; calAt[k] = Date.now(); }
  catch (e) { calErr[k] = e.message; }
  render();
}
// Tant que le calendrier n'est pas arrivé (ou en cours de chargement) on le relit souvent, ensuite toutes les 10 minutes.
const calendrierAJour = k => cal[k]?.complet && !cal[k].enCours && Date.now() - (calAt[k] || 0) < 10 * 60e3;
const cleClass = () => comp === 'france' ? 'sixnations' : comp;
async function majClassement() {
  const k = cleClass();
  try { classements[k] = await charger('/api/classements?comp=' + k); classErr[k] = null; }
  catch (e) { classErr[k] = e.message; }
  render();
}

function onglets(el, items, courant, fn) {
  el.innerHTML = '';
  items.forEach(([k, l]) => {
    const b = document.createElement('button');
    b.textContent = l; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', k === courant);
    b.onclick = () => fn(k); el.appendChild(b);
  });
}

function ligne(m, avecLigue) {
  const heure = new Date(m.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const centre = m.status === 'up' ? heure : m.status === 'autre' ? '–' : `${esc(m.scoreHome)} - ${esc(m.scoreAway)}`;
  const pied = m.status === 'live' ? `● ${esc(m.label)}` : esc(m.label) + (avecLigue && m.league ? ` · ${esc(m.league)}` : '');
  return `<div class="m ${esc(m.status)}"><div class="t">${esc(m.home)}</div><div class="sc">${centre}<small>${pied}</small></div><div class="t a">${esc(m.away)}</div></div>`;
}

function tableau(rows, qual) {
  return `<div class="wrap"><table><thead><tr><th>#</th><th>Équipe</th><th>J</th><th>G</th><th>N</th><th>P</th><th>Pts</th></tr></thead><tbody>${
    rows.map((r, i) => `<tr class="${i < qual ? 'qual' : ''}"><td>${esc(r.rang)}</td><td>${esc(r.equipe)}</td><td>${esc(r.j)}</td><td>${esc(r.g)}</td><td>${esc(r.n)}</td><td>${esc(r.p)}</td><td>${esc(r.pts)}</td></tr>`).join('')}</tbody></table></div>`;
}

// --- Calendrier de la saison et derniers résultats ---
const dateParis = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const jourLong = iso => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
const jourCourt = iso => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
const periode = l => { const d = jourCourt(l[0].start), f = jourCourt(l[l.length - 1].start); return d === f ? d : `${d} → ${f}`; };
const nomSaison = n => Number.isFinite(n) ? `${n}/${String(n + 1).slice(2)}` : '';

// Découpe les matchs d'une compétition en "tranches" : journées pour le Top 14 / la Pro D2, compétitions pour le XV de France.
function tranches(k) {
  const matchs = [...(cal[k]?.matchs || [])].sort((a, b) => new Date(a.start) - new Date(b.start));
  const par = new Map();
  for (const m of matchs) {
    const cle = k === 'france' ? m.league : (m.journee ? `J${m.journee}` : `D${dateParis(m.start)}`);
    if (!par.has(cle)) par.set(cle, { cle, nom: k === 'france' ? m.league : (m.journee ? `Journée ${m.journee}` : `Matchs du ${jourCourt(m.start)}`), ordre: m.journee ? +m.journee : 0, matchs: [] });
    par.get(cle).matchs.push(m);
  }
  const l = [...par.values()];
  if (k !== 'france' && l.every(t => t.ordre)) l.sort((a, b) => a.ordre - b.ordre);
  return l;
}
const termine = m => m.status === 'ft';
const aVenir = m => m.status === 'up' || m.status === 'live';

// Tranche affichée par défaut : la première qui n'est pas entièrement jouée (sinon la dernière).
function trancheAuto(l) { return Math.max(0, l.findIndex(t => t.matchs.some(aVenir)) === -1 ? l.length - 1 : l.findIndex(t => t.matchs.some(aVenir))); }

function etatCalendrier(k) {
  if (cal[k]?.matchs?.length) return '';
  if (!cal[k]) return `<div class="vide">${calErr[k] ? 'Calendrier indisponible pour le moment (' + esc(calErr[k]) + ').' : 'Chargement…'}</div>`;
  if (cal[k].enCours) return '<div class="vide">Chargement du calendrier…</div>';
  return `<div class="vide">${cal[k].erreur ? 'Calendrier indisponible pour le moment : ' + esc(cal[k].erreur) + ' Nouvelle tentative automatique.' : 'Calendrier pas encore disponible.'}</div>`;
}

function parJour(liste, avecLigue) {
  return [...new Set(liste.map(m => dateParis(m.start)))].map(j => {
    const duJour = liste.filter(m => dateParis(m.start) === j);
    return `<h3 class="jour">${esc(jourLong(duJour[0].start))}</h3>` + duJour.map(m => ligne(m, avecLigue)).join('');
  }).join('');
}

// Sous les matchs du jour : la dernière journée réellement jouée (avec ses dates), même s'il y a eu une pause depuis.
function sectionDerniers() {
  const vide = etatCalendrier(comp);
  if (vide) return '<h2>Derniers résultats</h2>' + vide;
  const joues = cal[comp].matchs.filter(termine);
  if (!joues.length) return '<h2>Derniers résultats</h2><div class="vide">Aucun match joué pour l’instant cette saison.</div>';
  let liste, titre;
  if (comp === 'france') {
    const dernier = new Date(joues[joues.length - 1].start).getTime();
    liste = joues.filter(m => dernier - new Date(m.start).getTime() < 10 * 86400e3);
    titre = [...new Set(liste.map(m => m.league))].join(' · ');
  } else {
    const t = tranches(comp).filter(t => t.matchs.some(termine)).pop();
    liste = t.matchs.filter(termine); titre = t.nom;
  }
  return `<h2>Derniers résultats <small>${esc(titre)} · ${esc(periode(liste))}</small></h2>` + parJour(liste, comp === 'france');
}

function vueCalendrier() {
  const vide = etatCalendrier(comp);
  if (vide) return vide;
  const l = tranches(comp);
  let i = journeeChoisie[comp] ?? trancheAuto(l);
  i = Math.min(Math.max(i, 0), l.length - 1);
  const t = l[i];
  let h = '';
  if (comp !== 'france' && l.length > 1) {
    h += `<div class="pager"><button type="button" id="prec" aria-label="Journée précédente" ${i === 0 ? 'disabled' : ''}>‹</button>`
      + `<select id="selJournee" aria-label="Choisir la journée">${l.map((x, n) => `<option value="${n}" ${n === i ? 'selected' : ''}>${esc(x.nom)} · ${esc(periode(x.matchs))}</option>`).join('')}</select>`
      + `<button type="button" id="suiv" aria-label="Journée suivante" ${i === l.length - 1 ? 'disabled' : ''}>›</button></div>`;
  }
  h += `<p class="saison">Saison ${esc(nomSaison(cal[comp].saison))}${comp === 'france' ? '' : ' · ' + esc(l.length)} ${comp === 'france' ? '' : 'journées'}</p>`;
  if (comp === 'france') {
    h += l.map(x => `<h2>${esc(x.nom)}</h2>` + parJour(x.matchs, false)).join('');
  } else {
    h += `<h2>${esc(t.nom)} <small>${esc(periode(t.matchs))}</small></h2>` + parJour(t.matchs, false);
  }
  const maj = cal[comp].majServeur ? new Date(cal[comp].majServeur).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' }) : '';
  return h + `<p class="petit">Calendrier actualisé chaque semaine${maj ? ' (dernière mise à jour : ' + esc(maj) + ')' : ''} ; les scores se complètent après chaque match.</p>`;
}

function brancherCalendrier() {
  const l = tranches(comp);
  const aller = n => { journeeChoisie[comp] = Math.min(Math.max(n, 0), l.length - 1); render(); };
  const courant = () => Math.min(Math.max(journeeChoisie[comp] ?? trancheAuto(l), 0), l.length - 1);
  $('#prec')?.addEventListener('click', () => aller(courant() - 1));
  $('#suiv')?.addEventListener('click', () => aller(courant() + 1));
  $('#selJournee')?.addEventListener('change', e => aller(+e.target.value));
}

function render() {
  onglets($('#comp'), COMPS, comp, k => { comp = k; vue = 'matchs'; render(); if (!calendrierAJour(k)) majCalendrier(k); });
  onglets($('#vue'), [['matchs', 'Matchs du jour'], ['calendrier', 'Calendrier'], ['classement', comp === 'france' ? 'Six Nations' : 'Classement']], vue, k => { vue = k; render(); if (k === 'classement') majClassement(); if (k === 'calendrier' && !calendrierAJour(comp)) majCalendrier(); });

  // Si le menu des journées est ouvert, on ne reconstruit pas la page (cela le fermerait) : seul le statut est rafraîchi.
  const figer = vue === 'calendrier' && document.activeElement?.id === 'selJournee';
  let h = '';
  if (vue === 'calendrier') {
    h = vueCalendrier();
  } else if (vue === 'classement') {
    const k = cleClass(), rows = classements[k];
    h = rows?.length ? tableau(rows, { top14: 6, prod2: 2, france: 1 }[comp])
      : `<div class="vide">${classErr[k] ? 'Classement indisponible : ' + esc(classErr[k]) : 'Chargement…'}</div>`;
  } else {
    if (matchs) {
      const liste = matchs[comp] || [];
      if (!liste.length) h = '<div class="vide">Aucun match aujourd’hui. Consulte le classement ou reviens un jour de match.</div>';
      else if (comp === 'france') {
        const groupes = [...new Set(liste.map(m => m.league))];
        h = groupes.map(g => `<h2>${esc(g)}</h2>` + liste.filter(m => m.league === g).map(m => ligne(m)).join('')).join('');
      } else h = liste.map(m => ligne(m)).join('');
    }
    h += sectionDerniers();
  }
  if (!figer) { $('#out').innerHTML = h; if (vue === 'calendrier') brancherCalendrier(); }

  const nb = matchs ? Object.values(matchs).flat().filter(m => m.status === 'live').length : 0;
  const heure = maj ? maj.toLocaleTimeString('fr-FR') : '';
  $('#statut').innerHTML = !navigator.onLine ? `Hors connexion · données de ${heure}`
    : erreur ? `Serveur injoignable · données de ${heure || 'jamais chargées'}`
    : `${nb ? `<b>● ${nb} match${nb > 1 ? 's' : ''} en direct</b> · ` : ''}mis à jour à ${heure}`;
}

// --- Notification permanente du match en direct (Web Push) ---
const stock = {
  lire: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  ecrire: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};
const notif = { support: false, serveur: null, abonne: false, occupe: false, msg: '' };

function cleVersOctets(b64) {
  const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function postJSON(url, corps) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erreur || r.status);
}
const envoyerAbonnement = (sub, test) => postJSON('/api/push/abonner', { subscription: sub.toJSON(), equipe: stock.lire('equipeFavorite'), test: !!test });

let equipes = null, equipesEnCours = false; // { top14: [...], prod2: [...], complet }
const notifBloquee = () => typeof Notification !== 'undefined' && Notification.permission === 'denied';

function renderNotif() {
  const fav = stock.lire('equipeFavorite');
  const cloche = $('#cloche'), sel = $('#fav');
  cloche.classList.toggle('on', notif.abonne);
  cloche.title = notif.abonne ? 'Notification activée' + (fav ? ' · ' + fav : '') : 'Notification désactivée';

  // Menu : « Désactivée », « sans favori », puis les clubs du Top 14, puis ceux de la Pro D2 (jamais d'équipe nationale)
  const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
  const groupe = (nom, l) => l?.length ? `<optgroup label="${nom}">${l.map(n => opt(n, n)).join('')}</optgroup>` : '';
  let h = opt('', '🔕 Désactivée') + opt('*', '🔔 Match en direct (sans équipe favorite)');
  if (fav && ![...(equipes?.top14 || []), ...(equipes?.prod2 || [])].includes(fav)) h += `<optgroup label="Mon équipe">${opt(fav, fav)}</optgroup>`;
  sel.innerHTML = h + groupe('Top 14', equipes?.top14) + groupe('Pro D2', equipes?.prod2);
  sel.value = notif.abonne ? (fav || '*') : '';
  sel.disabled = notif.occupe || !notif.support || !notif.serveur?.actif || notifBloquee();

  $('#notifMsg').textContent = notif.msg
    || (notifBloquee() ? 'Notifications bloquées : autorise-les pour ce site dans les réglages du téléphone.'
      : equipesEnCours ? 'Chargement des équipes…'
      : notif.abonne ? 'Active : mise à jour à chaque score, même appli fermée.'
      : notif.support && notif.serveur?.actif ? 'Choisis ton équipe pour activer la notification.' : '');
}

async function initNotif() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installee = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    notif.msg = ios && !installee
      ? 'Sur iPhone : ajoute d’abord l’appli à l’écran d’accueil (Partager → « Sur l’écran d’accueil »), puis ouvre-la depuis son icône.'
      : 'Ce navigateur ne sait pas afficher de notifications.';
    return renderNotif();
  }
  notif.support = true;
  try { notif.serveur = await charger('/api/push/config'); }
  catch { notif.msg = 'Serveur injoignable pour le moment.'; return renderNotif(); }
  if (!notif.serveur.actif) { notif.msg = 'Notifications pas encore configurées sur le serveur (clés VAPID : voir le README).'; return renderNotif(); }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  notif.abonne = !!sub && Notification.permission === 'granted';
  renderNotif();
  // À chaque ouverture on "réinscrit" l'abonnement : si le serveur a redémarré et tout oublié, c'est réparé.
  if (notif.abonne) envoyerAbonnement(sub).catch(() => {});
}

async function activerNotif() {
  notif.occupe = true; notif.msg = ''; renderNotif();
  try {
    if (await Notification.requestPermission() !== 'granted') throw new Error('permission refusée : autorise les notifications pour ce site dans les réglages du téléphone');
    const reg = await navigator.serviceWorker.ready;
    const cle = cleVersOctets(notif.serveur.cle);
    let sub = await reg.pushManager.getSubscription();
    const memeCle = s => { const k = s.options?.applicationServerKey; return !k || (k.byteLength === cle.length && new Uint8Array(k).every((v, i) => v === cle[i])); };
    if (sub && !memeCle(sub)) { await sub.unsubscribe(); sub = null; } // clés VAPID changées côté serveur
    sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cle });
    await envoyerAbonnement(sub, true);
    notif.abonne = true;
  } catch (e) { notif.msg = 'Impossible d’activer : ' + e.message; }
  notif.occupe = false; renderNotif();
}

async function couperNotif() {
  notif.occupe = true; notif.msg = ''; renderNotif();
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) { await postJSON('/api/push/desabonner', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    notif.abonne = false;
  } catch (e) { notif.msg = 'Impossible de désactiver : ' + e.message; }
  notif.occupe = false; renderNotif();
}

// Prévient le serveur que l'équipe favorite a changé.
async function resynchroniser() {
  try { const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); if (sub) await envoyerAbonnement(sub); }
  catch { /* réessayé à la prochaine ouverture de l'appli */ }
}

// Liste des clubs (demandée au serveur à l'ouverture du menu ; le serveur la garde en cache 12 h).
async function remplirEquipes() {
  if (equipes?.complet || equipesEnCours) return;
  equipesEnCours = true; renderNotif();
  try {
    equipes = await charger('/api/equipes');
    const fav = stock.lire('equipeFavorite');
    if (equipes.complet && fav && ![...equipes.top14, ...equipes.prod2].includes(fav)) {
      stock.ecrire('equipeFavorite', ''); // ex. une équipe nationale choisie dans une ancienne version : plus possible
      if (notif.abonne) resynchroniser();
    }
  } catch { /* réessayé à la prochaine ouverture du menu */ }
  equipesEnCours = false; renderNotif();
}

function ouvrirMenu(ouvert) {
  $('#menuNotif').hidden = !ouvert;
  $('#cloche').setAttribute('aria-expanded', String(ouvert));
  if (ouvert) remplirEquipes();
}
$('#cloche').addEventListener('click', () => {
  const ouvrir = $('#menuNotif').hidden;
  ouvrirMenu(ouvrir);
  // Le toucher sur la cloche est le bon moment pour demander l'autorisation (obligatoire sur iPhone : il faut un geste)
  if (ouvrir && notif.support && notif.serveur?.actif && Notification.permission === 'default') Notification.requestPermission().then(renderNotif).catch(() => {});
});
document.addEventListener('click', e => { if (!$('#menuNotif').hidden && !e.target.closest('#menuNotif, #cloche')) ouvrirMenu(false); });
addEventListener('keydown', e => { if (e.key === 'Escape') ouvrirMenu(false); });

$('#fav').addEventListener('change', async () => {
  const v = $('#fav').value;
  if (v === '') { if (notif.abonne) await couperNotif(); return; }
  stock.ecrire('equipeFavorite', v === '*' ? '' : v);
  if (notif.abonne) { renderNotif(); await resynchroniser(); } else await activerNotif();
});

// Polling : toutes les 30 s tant que l'appli est visible (le serveur, lui, protège le quota grâce à son cache).
// Le calendrier n'est relu chez le serveur que s'il n'est pas encore arrivé, puis toutes les 10 minutes (scores fusionnés).
const rafraichir = () => { majMatchs(); if (!calendrierAJour(comp)) majCalendrier(); };
rafraichir();
initNotif();
setInterval(() => { if (document.visibilityState === 'visible') rafraichir(); }, 30000);
setInterval(() => { if (vue === 'classement' && document.visibilityState === 'visible') majClassement(); }, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rafraichir(); });
addEventListener('online', rafraichir); addEventListener('offline', render);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
