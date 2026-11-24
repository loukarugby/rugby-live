// Fournisseur réel : Highlightly, API Rugby (https://highlightly.net/rugby-api/documentation/).
// Il renvoie le même format que mock.js et apisports.js : server.js et public/ n'ont rien à savoir de Highlightly.
const BASE = process.env.HIGHLIGHTLY_BASE_URL || 'https://rugby.highlightly.net';
const KEY = process.env.HIGHLIGHTLY_API_KEY;
const MAX = +process.env.MAX_REQUETES_JOUR || 90; // garde-fou local pour ne pas vider le quota

// Noms exacts des compétitions chez Highlightly (on en déduit les identifiants tout seuls).
// Si une compétition n'est pas trouvée, mets son identifiant à la main dans les variables d'environnement.
const LIGUES = {
  top14: { nom: process.env.TOP14_NAME || 'Top 14', pays: 'France', id: +process.env.TOP14_LEAGUE_ID || null },
  prod2: { nom: process.env.PROD2_NAME || 'Pro D2', pays: 'France', id: +process.env.PROD2_LEAGUE_ID || null },
  sixnations: { nom: process.env.SIXNATIONS_NAME || 'Six Nations', pays: null, id: +process.env.SIXNATIONS_LEAGUE_ID || null },
};

let jour = null, compteur = 0, restantApi = null, derniereErreur = null;
const jourUTC = () => new Date().toISOString().slice(0, 10);

// Budget de requêtes du jour. Deux sources, on prend la plus prudente :
//  - notre compteur local (remis à zéro si le serveur redémarre) ;
//  - le chiffre exact renvoyé par Highlightly dans l'en-tête "x-ratelimit-requests-remaining".
function budget() {
  const auj = jourUTC();
  if (jour !== auj) { jour = auj; compteur = 0; restantApi = null; } // le quota se réinitialise chaque jour (UTC)
  const local = MAX - compteur;
  return { utilise: compteur, plafond: MAX, restantApi, restant: restantApi === null ? local : Math.min(local, restantApi) };
}

async function appel(chemin, params) {
  if (budget().restant <= 0) throw new Error('Budget de requêtes du jour atteint (MAX_REQUETES_JOUR ou quota Highlightly)');
  compteur++;
  const url = new URL(BASE + chemin);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { 'x-rapidapi-key': KEY } });
  const reste = parseInt(r.headers.get('x-ratelimit-requests-remaining'), 10);
  if (Number.isFinite(reste)) restantApi = reste;
  if (!r.ok) {
    const corps = (await r.text().catch(() => '')).slice(0, 200);
    const e = new Error(`Highlightly : HTTP ${r.status} sur ${chemin} ${corps}`);
    derniereErreur = e.message;
    throw e;
  }
  derniereErreur = null;
  return r.json();
}

const etat = () => ({ requetesEnvoyeesAujourdhui: compteur, plafondLocal: MAX, restantSelonHighlightly: restantApi, restantUtilisable: budget().restant, derniereErreur, ligues: LIGUES });

// Retrouve l'identifiant (et les saisons) d'une compétition à partir de son nom. Résultat gardé en mémoire.
const infos = {};
async function infosLigue(cle) {
  const l = LIGUES[cle];
  if (infos[cle]) return infos[cle];
  if (l.id) {
    // Identifiant fourni à la main : on cherche quand même les saisons pour le classement
    const j = await appel('/leagues', { leagueName: l.nom, limit: 100 });
    const trouve = (j.data || []).find(x => x.id === l.id);
    return (infos[cle] = { id: l.id, saisons: (trouve?.seasons || []).map(s => s.season).sort((a, b) => b - a) });
  }
  const j = await appel('/leagues', { leagueName: l.nom, limit: 100 });
  const liste = j.data || [];
  const nom = s => String(s || '').trim().toLowerCase();
  let ok = liste.filter(x => nom(x.name) === nom(l.nom));
  if (l.pays && ok.some(x => nom(x.country?.name) === nom(l.pays))) ok = ok.filter(x => nom(x.country?.name) === nom(l.pays));
  if (!ok.length) {
    const vus = liste.map(x => `${x.name} (${x.country?.name}, id ${x.id})`).slice(0, 8).join(' ; ') || 'aucune';
    throw new Error(`Compétition « ${l.nom} » introuvable chez Highlightly. Trouvé : ${vus}`);
  }
  const x = ok[0];
  return (infos[cle] = { id: x.id, saisons: (x.seasons || []).map(s => s.season).sort((a, b) => b - a) });
}

const TERMINE = ['Finished', 'Finished after extra time', 'Awarded'];
const EN_DIRECT = { 'First half': '1re mi-temps', 'Half time': 'Mi-temps', 'Second half': '2e mi-temps', 'Extra time': 'Prolongation', 'Break time': 'Pause', Penalties: 'Tirs au but' };
const AUTRES = { Postponed: 'Reporté', Suspended: 'Suspendu', Interrupted: 'Interrompu', Cancelled: 'Annulé', Abandoned: 'Abandonné', 'To be announced': 'À confirmer', Unknown: '—' };

function normaliser(g) {
  const d = g.state?.description;
  const status = d in EN_DIRECT ? 'live' : TERMINE.includes(d) ? 'ft' : d === 'Not started' ? 'up' : 'autre';
  const [sh, sa] = String(g.state?.score ?? '').split('-').map(s => parseInt(s, 10));
  return {
    id: g.id, league: g.league?.name, home: g.homeTeam?.name, away: g.awayTeam?.name,
    scoreHome: Number.isFinite(sh) ? sh : 0, scoreAway: Number.isFinite(sa) ? sa : 0, status,
    label: status === 'live' ? EN_DIRECT[d] : status === 'ft' ? 'Terminé' : status === 'up' ? 'À venir' : (AUTRES[d] || d || '—'),
    start: g.date,
  };
}

// Les matchs d'un jour donné (par défaut aujourd'hui, heure de Paris), au format AAAA-MM-JJ.
async function matchsDuJour(params, date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' })) {
  const j = await appel('/matches', { date, timezone: 'Europe/Paris', limit: 100, ...params });
  return j.data || [];
}

// Un "groupe" = top14, prod2 ou france (home + away). Renvoie les matchs normalisés d'un jour.
async function matchsGroupe(groupe, date) {
  if (groupe === 'france') {
    // XV de France : tous les matchs où la France joue (à domicile ou à l'extérieur)
    const vus = new Set(), out = [];
    for (const p of [{ homeTeamName: 'France' }, { awayTeamName: 'France' }]) {
      for (const g of await matchsDuJour(p, date)) {
        if (!vus.has(g.id)) { vus.add(g.id); out.push(normaliser(g)); }
      }
    }
    return out;
  }
  const { id } = await infosLigue(groupe);
  return (await matchsDuJour({ leagueId: id }, date)).map(normaliser);
}

// Une compétition n'est à redemander que si un de ses matchs est en direct, ou va commencer dans moins de 10 min.
// Les autres (terminés, ou pas avant longtemps) gardent leurs données : zéro requête dépensée pour elles.
const aSuivre = liste => (liste || []).some(m => {
  if (m.status === 'live') return true;
  const dans = new Date(m.start) - Date.now();
  return m.status === 'up' && dans < 10 * 60e3 && dans > -2 * 3600e3;
});

// precedent = les données déjà connues pour AUJOURD'HUI (ou rien : première demande de la journée → on demande tout)
async function getMatchs(precedent) {
  const out = { top14: [], prod2: [], france: [] };
  for (const cle of ['top14', 'prod2', 'france']) {
    out[cle] = precedent && !aSuivre(precedent[cle]) ? precedent[cle] : await matchsGroupe(cle);
  }
  return out;
}

// Pour l'historique de la semaine passée : les matchs d'un jour précis pour un groupe.
const getJournee = (date, groupe) => matchsGroupe(groupe, date);

async function getClassement(cle) {
  if (!LIGUES[cle]) throw new Error('Compétition inconnue : ' + cle);
  const { id, saisons } = await infosLigue(cle);
  if (!saisons.length) throw new Error(`Aucune saison connue pour ${LIGUES[cle].nom} (ligue ${id})`);
  // On essaie la saison la plus récente, puis la précédente si le classement est vide
  for (const season of saisons.slice(0, 2)) {
    const j = await appel('/standings', { leagueId: id, season });
    const vus = new Map();
    for (const groupe of j.groups || []) {
      for (const r of groupe.standings || []) {
        const nom = r.team?.name;
        if (nom && !vus.has(nom)) vus.set(nom, { rang: r.position, equipe: nom, j: r.gamesPlayed, g: r.wins, n: r.draws, p: r.loses, pts: r.points });
      }
    }
    if (vus.size) return [...vus.values()].sort((a, b) => a.rang - b.rang);
  }
  throw new Error(`Classement vide pour ${LIGUES[cle].nom} (ligue ${id}, saisons ${saisons.slice(0, 2).join(' / ')})`);
}

module.exports = { getMatchs, getJournee, getClassement, etat, budget };
