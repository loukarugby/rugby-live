// Données fictives pour développer sans clé API. Les matchs "live" avancent à chaque appel.
// Faux logos : un rond de couleur avec les initiales du club
const logo = nom => {
  const h = [...nom].reduce((t, c) => (t * 31 + c.charCodeAt(0)) % 360, 7), ini = nom.split(/[\s-]+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="hsl(${h} 55% 42%)"/><text x="20" y="26" font-size="16" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${ini}</text></svg>`);
};
const avecLogos = m => ({ ...m, logoHome: logo(m.home), logoAway: logo(m.away) });
const dans = min => new Date(Date.now() + min * 60e3).toISOString();
const etat = [
  { competition: 'top14', league: 'Top 14', home: 'Toulouse', away: 'Racing 92', sh: 24, sa: 17, status: 'live', min: 58, start: dans(-58) },
  { competition: 'top14', league: 'Top 14', home: 'Stade Français', away: 'Montpellier', sh: 13, sa: 13, status: 'live', min: 33, start: dans(-33) },
  { competition: 'top14', league: 'Top 14', home: 'La Rochelle', away: 'Toulon', sh: 31, sa: 20, status: 'ft', start: dans(-150) },
  { competition: 'top14', league: 'Top 14', home: 'Bordeaux-Bègles', away: 'Clermont', sh: 0, sa: 0, status: 'up', start: dans(90) },
  { competition: 'prod2', league: 'Pro D2', home: 'Perpignan', away: 'Biarritz', sh: 19, sa: 22, status: 'live', min: 67, start: dans(-67) },
  { competition: 'prod2', league: 'Pro D2', home: 'Provence Rugby', away: 'Oyonnax', sh: 27, sa: 10, status: 'ft', start: dans(-160) },
  { competition: 'prod2', league: 'Pro D2', home: 'Vannes', away: 'Colomiers', sh: 0, sa: 0, status: 'up', start: dans(120) },
  { competition: 'france', league: 'Tournoi des Six Nations', home: 'France', away: 'Irlande', sh: 28, sa: 22, status: 'ft', start: dans(-200) },
  { competition: 'france', league: 'Tournée d’été', home: 'Nouvelle-Zélande', away: 'France', sh: 21, sa: 18, status: 'live', min: 49, start: dans(-49) },
];

async function getMatchs() {
  const out = { top14: [], prod2: [], france: [] };
  etat.forEach((m, i) => {
    if (m.status === 'live') {
      m.min += 1;
      if (Math.random() < 0.3) { const pts = [3, 5, 7][Math.floor(Math.random() * 3)]; Math.random() < 0.5 ? m.sh += pts : m.sa += pts; }
      if (m.min > 80) { m.min = 1; m.sh = 0; m.sa = 0; } // on "relance" un match pour la démo
    }
    out[m.competition].push(avecLogos({
      id: i, league: m.league, home: m.home, away: m.away,
      scoreHome: m.sh, scoreAway: m.sa, status: m.status, start: m.start,
      label: m.status === 'live' ? `${m.min}’` : m.status === 'ft' ? 'Terminé' : 'À venir',
    }));
  });
  return out;
}

// Calendrier fictif : une saison de journées hebdomadaires (les premières jouées, les suivantes à venir).
const EQUIPES = {
  top14: ['Toulouse', 'Racing 92', 'Stade Français', 'Montpellier', 'La Rochelle', 'Toulon', 'Bordeaux-Bègles', 'Clermont'],
  prod2: ['Perpignan', 'Biarritz', 'Provence Rugby', 'Oyonnax', 'Vannes', 'Colomiers'],
};
async function getCalendrier(groupe) {
  const maintenant = Date.now(), jour = 86400e3;
  const saison = new Date().getUTCFullYear();
  if (groupe === 'france') {
    const f = (i, adv, ligue, dec, home) => {
      const start = new Date(maintenant + dec * jour).toISOString(), fini = dec < 0;
      return { id: `f-${i}`, league: ligue, home: home ? 'France' : adv, away: home ? adv : 'France', scoreHome: fini ? 30 - i * 3 : 0, scoreAway: fini ? 20 + i : 0, status: fini ? 'ft' : 'up', label: fini ? 'Terminé' : 'À venir', start };
    };
    return { saison, matchs: [f(1, 'Australie', 'Tournée d’automne', -12, true), f(2, 'Afrique du Sud', 'Tournée d’automne', -5, true), f(3, 'Irlande', 'Six Nations', 70, false), f(4, 'Italie', 'Six Nations', 84, true)].map(avecLogos) };
  }
  const noms = EQUIPES[groupe], n = noms.length / 2, matchs = [];
  for (let j = 0; j < 12; j++) {                       // 12 journées, une par semaine ; les 7 premières sont jouées
    const decalage = (j - 7) * 7 + 1;
    for (let i = 0; i < n; i++) {
      const start = new Date(maintenant + (decalage + (i % 3)) * jour); start.setUTCHours(14 + (i % 3) * 2, 35, 0, 0);
      const fini = start.getTime() < maintenant;
      matchs.push({
        id: `c-${groupe}-${j}-${i}`, league: groupe === 'top14' ? 'Top 14' : 'Pro D2', journee: String(j + 1),
        home: noms[(i + j) % noms.length], away: noms[(i + j + n) % noms.length],
        scoreHome: fini ? 12 + ((j * 7 + i * 5) % 28) : 0, scoreAway: fini ? 9 + ((j * 5 + i * 3) % 25) : 0,
        status: fini ? 'ft' : 'up', label: fini ? 'Terminé' : 'À venir', start: start.toISOString(),
      });
    }
  }
  return { saison, matchs: matchs.map(avecLogos) };
}

const ligne = (equipe, j, g, n, p, pts) => ({ equipe, j, g, n, p, pts });
async function getClassements() {
  const tri = rows => rows.sort((a, b) => b.pts - a.pts).map((r, i) => ({ rang: i + 1, ...r }));
  return {
    top14: tri([ligne('Toulouse', 14, 11, 0, 3, 52), ligne('La Rochelle', 14, 10, 1, 3, 49), ligne('Bordeaux-Bègles', 14, 9, 0, 5, 44), ligne('Toulon', 14, 8, 1, 5, 41), ligne('Racing 92', 14, 7, 0, 7, 36), ligne('Clermont', 14, 6, 1, 7, 33)]),
    prod2: tri([ligne('Perpignan', 14, 10, 0, 4, 47), ligne('Vannes', 14, 9, 1, 4, 45), ligne('Biarritz', 14, 9, 0, 5, 43), ligne('Provence Rugby', 14, 8, 0, 6, 39), ligne('Colomiers', 14, 7, 1, 6, 35), ligne('Oyonnax', 14, 5, 0, 9, 26)]),
    sixnations: tri([ligne('France', 5, 4, 0, 1, 19), ligne('Irlande', 5, 3, 1, 1, 17), ligne('Angleterre', 5, 3, 0, 2, 15), ligne('Écosse', 5, 2, 0, 3, 11), ligne('Italie', 5, 1, 0, 4, 6), ligne('Pays de Galles', 5, 1, 1, 3, 5)]),
  };
}

const getClassement = async cle => (await getClassements())[cle];

module.exports = { getMatchs, getCalendrier, getClassement };
