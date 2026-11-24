// Frontend : demande les données à NOTRE backend (/api/...) et les affiche.
const COMPS = [['top14', 'Top 14'], ['prod2', 'Pro D2'], ['france', 'XV de France']];
let comp = 'top14', vue = 'matchs', matchs = null, classements = null, maj = null, erreur = false;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function charger(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function majMatchs() {
  try { const j = await charger('/api/matchs'); matchs = j.competitions; maj = new Date(j.majServeur); erreur = false; }
  catch { erreur = true; }
  render();
}
async function majClassements() {
  try { classements = await charger('/api/classements'); } catch { /* on garde l'ancien */ }
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

function ligne(m) {
  const heure = new Date(m.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const centre = m.status === 'up' ? heure : m.status === 'autre' ? '–' : `${esc(m.scoreHome)} - ${esc(m.scoreAway)}`;
  const pied = m.status === 'live' ? `● ${esc(m.label)}` : esc(m.label);
  return `<div class="m ${esc(m.status)}"><div class="t">${esc(m.home)}</div><div class="sc">${centre}<small>${pied}</small></div><div class="t a">${esc(m.away)}</div></div>`;
}

function tableau(rows, qual) {
  return `<div class="wrap"><table><thead><tr><th>#</th><th>Équipe</th><th>J</th><th>G</th><th>N</th><th>P</th><th>Pts</th></tr></thead><tbody>${
    rows.map((r, i) => `<tr class="${i < qual ? 'qual' : ''}"><td>${esc(r.rang)}</td><td>${esc(r.equipe)}</td><td>${esc(r.j)}</td><td>${esc(r.g)}</td><td>${esc(r.n)}</td><td>${esc(r.p)}</td><td>${esc(r.pts)}</td></tr>`).join('')}</tbody></table></div>`;
}

function render() {
  onglets($('#comp'), COMPS, comp, k => { comp = k; vue = 'matchs'; render(); });
  onglets($('#vue'), [['matchs', 'Matchs du jour'], ['classement', comp === 'france' ? 'Six Nations' : 'Classement']], vue, k => { vue = k; render(); });

  let h = '';
  if (vue === 'classement') {
    const rows = classements?.[comp === 'france' ? 'sixnations' : comp];
    h = rows?.length ? tableau(rows, { top14: 6, prod2: 2, france: 1 }[comp]) : '<div class="vide">Classement indisponible pour le moment.</div>';
  } else if (matchs) {
    const liste = matchs[comp] || [];
    if (!liste.length) h = '<div class="vide">Aucun match aujourd’hui. Consulte le classement ou reviens un jour de match.</div>';
    else if (comp === 'france') {
      const groupes = [...new Set(liste.map(m => m.league))];
      h = groupes.map(g => `<h2>${esc(g)}</h2>` + liste.filter(m => m.league === g).map(ligne).join('')).join('');
    } else h = liste.map(ligne).join('');
  }
  $('#out').innerHTML = h;

  const nb = matchs ? Object.values(matchs).flat().filter(m => m.status === 'live').length : 0;
  const heure = maj ? maj.toLocaleTimeString('fr-FR') : '';
  $('#statut').innerHTML = !navigator.onLine ? `Hors connexion · données de ${heure}`
    : erreur ? `Serveur injoignable · données de ${heure || 'jamais chargées'}`
    : `${nb ? `<b>● ${nb} match${nb > 1 ? 's' : ''} en direct</b> · ` : ''}mis à jour à ${heure}`;
}

// Polling : toutes les 30 s tant que l'appli est visible (le serveur, lui, protège le quota grâce à son cache).
majMatchs(); majClassements();
setInterval(() => { if (document.visibilityState === 'visible') majMatchs(); }, 30000);
setInterval(majClassements, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') majMatchs(); });
addEventListener('online', majMatchs); addEventListener('offline', render);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
