// Fournisseur réel : API-Sports Rugby (https://api-sports.io). Vérifie les formats de réponse
// et les identifiants de ligues dans leur documentation : ils peuvent évoluer.
const BASE = 'https://v1.rugby.api-sports.io';
const KEY = process.env.API_SPORTS_KEY;
const MAX = +process.env.MAX_REQUETES_JOUR || 90; // le palier gratuit est limité par jour

const LIGUES = {
  top14: { id: +process.env.TOP14_LEAGUE_ID || 16, season: +process.env.TOP14_SEASON || 2026 },
  prod2: { id: +process.env.PROD2_LEAGUE_ID || 17, season: +process.env.PROD2_SEASON || 2026 },
  sixnations: { id: +process.env.SIXNATIONS_LEAGUE_ID || 51, season: +process.env.SIXNATIONS_SEASON || 2026 },
};

let jour = null, compteur = 0, restantes = null, jourRestantes = null;
const RESERVE = 5; // on garde quelques requêtes en réserve
const jourUTC = () => new Date().toISOString().slice(0, 10); // le quota d'API-Sports repart à 0 h UTC

async function appel(chemin, params) {
  const auj = jourUTC();
  if (jour !== auj) { jour = auj; compteur = 0; }
  if (jourRestantes !== auj) restantes = null;
  // Le fournisseur nous dit lui-même combien de requêtes il reste : on s'y fie en priorité.
  if (restantes !== null && restantes <= RESERVE) throw new Error(`Quota API-Sports presque épuisé (${restantes} requêtes restantes aujourd’hui)`);
  if (compteur >= MAX) throw new Error('Budget de requêtes du jour atteint');
  compteur++;
  const url = new URL(BASE + chemin);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { 'x-apisports-key': KEY } });
  const rest = r.headers.get('x-ratelimit-requests-remaining');
  if (rest !== null && rest !== '' && !Number.isNaN(+rest)) { restantes = +rest; jourRestantes = auj; }
  if (!r.ok) throw new Error('API-Sports : HTTP ' + r.status);
  const j = await r.json();
  // API-Sports répond souvent "200 OK" avec une liste vide ET un message d'erreur : on le remonte.
  const erreurs = Array.isArray(j.errors) ? j.errors : Object.values(j.errors || {});
  if (erreurs.length) throw new Error('API-Sports : ' + erreurs.join(' | '));
  return j.response || [];
}

const etat = () => ({ requetesRestantesChezApiSports: restantes, requetesEnvoyeesDepuisDemarrage: compteur, plafondLocal: MAX });

const EN_DIRECT = ['1H', 'HT', '2H', 'ET', 'BT', 'PT'];
const TERMINE = ['FT', 'AET', 'AOT', 'AWD'];
const LIBELLES = { '1H': '1re mi-temps', HT: 'Mi-temps', '2H': '2e mi-temps', ET: 'Prolongation', BT: 'Pause', PT: 'Tirs au but' };

function normaliser(g) {
  const s = g.status?.short;
  const status = EN_DIRECT.includes(s) ? 'live' : TERMINE.includes(s) ? 'ft' : s === 'NS' ? 'up' : 'autre';
  return {
    id: g.id, league: g.league?.name, home: g.teams?.home?.name, away: g.teams?.away?.name,
    scoreHome: g.scores?.home ?? 0, scoreAway: g.scores?.away ?? 0, status,
    label: status === 'live' ? LIBELLES[s] : status === 'ft' ? 'Terminé' : status === 'up' ? 'À venir' : (g.status?.long || '—'),
    start: g.date,
  };
}

// Une seule requête pour tous les matchs du jour, qu'on trie ensuite nous-mêmes : économise le quota.
async function getMatchs() {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ
  const jeux = await appel('/games', { date, timezone: 'Europe/Paris' });
  const out = { top14: [], prod2: [], france: [] };
  for (const g of jeux) {
    const id = g.league?.id;
    if (id === LIGUES.top14.id) out.top14.push(normaliser(g));
    else if (id === LIGUES.prod2.id) out.prod2.push(normaliser(g));
    else if (id === LIGUES.sixnations.id || g.teams?.home?.name === 'France' || g.teams?.away?.name === 'France') out.france.push(normaliser(g));
  }
  return out;
}

async function getClassement(cle) {
  const ligue = LIGUES[cle];
  if (!ligue) throw new Error('Compétition inconnue : ' + cle);
  const groupes = await appel('/standings', { league: ligue.id, season: ligue.season });
  const vus = new Map(); // une équipe peut apparaître dans plusieurs phases : on garde la première ligne
  for (const r of groupes.flat()) {
    const nom = r.team?.name;
    if (nom && !vus.has(nom)) vus.set(nom, {
      rang: r.position, equipe: nom, j: r.games?.played, g: r.games?.win?.total,
      n: r.games?.draw?.total, p: r.games?.lose?.total, pts: r.points,
    });
  }
  if (!vus.size) throw new Error(`Classement vide pour ${cle} (saison ${ligue.season}, ligue ${ligue.id}) : vérifie l’identifiant et la saison`);
  return [...vus.values()].sort((a, b) => a.rang - b.rang);
}

module.exports = { getMatchs, getClassement, etat };
