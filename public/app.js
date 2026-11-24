// Frontend : demande les données à NOTRE backend (/api/...) et les affiche.
const COMPS = [['top14', 'Top 14'], ['prod2', 'Pro D2'], ['france', 'XV de France']];
let comp = 'top14', vue = 'matchs', matchs = null, classements = {}, classErr = {}, maj = null, erreur = false;
let histo = null, histoErr = null, histoAt = 0; // résultats de la semaine passée
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
// Le serveur ne demande l'historique au fournisseur qu'une fois par semaine : ici on ne fait que le relire chez lui.
async function majHistorique() {
  try { histo = await charger('/api/historique'); histoErr = null; histoAt = Date.now(); }
  catch (e) { histoErr = e.message; }
  render();
}
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

// --- Résultats de la semaine passée (sous les matchs du jour) ---
const dateParis = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const jourLong = iso => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
const jourCourt = ymd => new Date(ymd + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function sectionHistorique() {
  const periode = histo?.semaine ? ` <small>${esc(jourCourt(histo.semaine.debut))} → ${esc(jourCourt(histo.semaine.fin))}</small>` : '';
  let h = `<h2>Résultats de la semaine passée${periode}</h2>`;
  const liste = histo?.competitions?.[comp] || [];
  if (liste.length) {
    for (const j of [...new Set(liste.map(m => dateParis(m.start)))]) {
      const duJour = liste.filter(m => dateParis(m.start) === j);
      h += `<h3 class="jour">${esc(jourLong(duJour[0].start))}</h3>` + duJour.map(m => ligne(m, comp === 'france')).join('');
    }
  } else if (!histo) {
    h += `<div class="vide">${histoErr ? 'Résultats indisponibles pour le moment (' + esc(histoErr) + ').' : 'Chargement…'}</div>`;
  } else if (histo.complet) {
    h += '<div class="vide">Aucun match la semaine passée dans cette compétition.</div>';
  } else {
    h += `<div class="vide">${histo.enCours ? 'Chargement des résultats…' : 'Résultats pas encore disponibles.'}</div>`;
  }
  if (histo && !histo.complet && liste.length) {
    h += `<p class="petit">${histo.enCours ? 'Chargement des autres jours…' : 'Résultats partiels : la suite sera demandée un peu plus tard.'}</p>`;
  }
  return h;
}

function render() {
  onglets($('#comp'), COMPS, comp, k => { comp = k; vue = 'matchs'; render(); });
  onglets($('#vue'), [['matchs', 'Matchs du jour'], ['classement', comp === 'france' ? 'Six Nations' : 'Classement']], vue, k => { vue = k; render(); if (k === 'classement') majClassement(); });

  let h = '';
  if (vue === 'classement') {
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
    h += sectionHistorique();
  }
  $('#out').innerHTML = h;

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
// L'historique, lui, n'est relu que tant qu'il est incomplet, puis toutes les 6 h (changement de semaine).
const historiqueAJour = () => histo?.complet && Date.now() - histoAt < 6 * 3600e3;
majMatchs();
majHistorique();
initNotif();
setInterval(() => { if (document.visibilityState === 'visible') { majMatchs(); if (!historiqueAJour()) majHistorique(); } }, 30000);
setInterval(() => { if (vue === 'classement' && document.visibilityState === 'visible') majClassement(); }, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { majMatchs(); if (!historiqueAJour()) majHistorique(); } });
addEventListener('online', majMatchs); addEventListener('offline', render);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
