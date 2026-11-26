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
    journee: g.week ? String(g.week) : undefined, // numéro de journée (championnats)
  };
}

// Les matchs d'un jour donné (par défaut aujourd'hui, heure de Paris), au format AAAA-MM-JJ.
async function matchsDuJour(params, date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' })) {
  const j = await appel('/matches', { date, timezone: 'Europe/Paris', limit: 100, ...params });
  return j.data || [];
}

// Un "groupe" = top14, prod2 ou france (home + away). Renvoie les matchs normalisés d'un jour (aujourd'hui par défaut).
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

// --- Calendrier d'une saison (résultats + matchs à venir) ---------------------------------------------
// Sans date, /matches renvoie TOUS les matchs de la ligue, du plus récent au plus ancien (ceux à venir en premier).
// Une page de 100 matchs contient donc déjà presque toute la saison en cours : on lit les pages une à une
// et on s'arrête dès qu'on tombe sur la saison précédente. Coût réel : 1 à 3 requêtes par compétition.
const MAX_PAGES = +process.env.CALENDRIER_MAX_PAGES || 4;

// La saison "en cours" = celle du match le plus proche d'aujourd'hui (passé ou futur).
function saisonCourante(matchs) {
  let meilleur = null;
  for (const m of matchs) {
    const saison = Number(m.league?.season);
    if (!Number.isFinite(saison)) continue;
    const ecart = Math.abs(new Date(m.date) - Date.now());
    if (!meilleur || ecart < meilleur.ecart) meilleur = { saison, ecart };
  }
  return meilleur ? meilleur.saison : null;
}

async function calendrierLigue(groupe) {
  const { id } = await infosLigue(groupe);
  const recus = new Map();
  let saison = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await appel('/matches', { leagueId: id, limit: 100, offset: page * 100 });
    const data = j.data || [];
    data.forEach(m => recus.set(m.id, m));
    saison = saisonCourante([...recus.values()]);
    const total = j.pagination?.totalCount;
    const saisonPrecedenteAtteinte = saison !== null && data.some(m => Number(m.league?.season) < saison);
    if (data.length < 100 || saisonPrecedenteAtteinte || (Number.isFinite(total) && (page + 1) * 100 >= total)) break;
  }
  if (saison === null) throw new Error(`Aucun match trouvé pour ${LIGUES[groupe].nom} (ligue ${id})`);
  return { saison, matchs: [...recus.values()].filter(m => Number(m.league?.season) === saison).map(normaliser) };
}

// XV de France : pas de ligue unique (Six Nations, tests d'automne, tournées...). On demande ses matchs à domicile
// puis à l'extérieur (2 requêtes, la page la plus récente suffit) et on garde la saison du 1er juillet au 30 juin.
async function calendrierFrance() {
  const n = new Date();
  const annee = n.getUTCMonth() >= 6 ? n.getUTCFullYear() : n.getUTCFullYear() - 1;
  const debut = Date.UTC(annee, 6, 1), fin = Date.UTC(annee + 1, 6, 1);
  const france = x => String(x?.name || '').trim().toLowerCase() === 'france'; // exactement "France" (pas les -20 ans, etc.)
  const recus = new Map();
  for (const p of [{ homeTeamName: 'France' }, { awayTeamName: 'France' }]) {
    const j = await appel('/matches', { ...p, limit: 100 });
    for (const g of j.data || []) {
      const t = new Date(g.date).getTime();
      if ((france(g.homeTeam) || france(g.awayTeam)) && t >= debut && t < fin) recus.set(g.id, g);
    }
  }
  return { saison: annee, matchs: [...recus.values()].map(normaliser) };
}

function getCalendrier(groupe) {
  if (groupe === 'france') return calendrierFrance();
  if (groupe === 'top14' || groupe === 'prod2') return calendrierLigue(groupe);
  throw new Error('Compétition inconnue : ' + groupe);
}

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

module.exports = { getMatchs, getCalendrier, getClassement, etat, budget };
