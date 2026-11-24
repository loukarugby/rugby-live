// Résultats de la semaine passée (le lundi → dimanche précédent).
//
// Principe pour ne pas gaspiller tes 100 requêtes par jour :
//  - on demande ces résultats UNE seule fois par semaine (au premier lancement de la semaine) ;
//  - on les garde en mémoire ET dans un fichier (data/historique.json) jusqu'à la fin de la semaine ;
//  - quand une nouvelle semaine commence, tout est effacé puis la nouvelle "semaine passée" est demandée ;
//  - on ne touche jamais aux dernières requêtes du jour (RESERVE_REQUETES_LIVE), gardées pour le direct ;
//  - si le quota ou le réseau coupe en cours de route, on garde ce qu'on a déjà et on ne redemande
//    plus tard QUE les jours manquants (avec des pauses de plus en plus longues).
const stockage = require('./stockage');

const FICHIER = 'historique.json';
const GROUPES = ['top14', 'prod2', 'france'];
const RESERVE = +process.env.RESERVE_REQUETES_LIVE || 20;
const RETRY_S = +process.env.RETRY_HISTORIQUE_S || 900;

const ajouterJours = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z'); // midi UTC : pas de souci d'heure d'été
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// "Semaine passée" = du lundi au dimanche qui précèdent la semaine en cours. aujourdhui = 'AAAA-MM-JJ' (heure de Paris).
function semainePassee(aujourdhui) {
  const joursDepuisLundi = (new Date(aujourdhui + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const debut = ajouterJours(aujourdhui, -joursDepuisLundi - 7);
  return { debut, fin: ajouterJours(debut, 6), jours: Array.from({ length: 7 }, (_, i) => ajouterJours(debut, i)) };
}

function creerHistorique({ provider, jourParis }) {
  // etat.parties : { 'AAAA-MM-JJ|groupe': [matchs] } — une "partie" = un jour pour un groupe (Top 14, Pro D2, France)
  let etat = null;

  function verifierSemaine() {
    const s = semainePassee(jourParis());
    if (etat && etat.semaine.debut === s.debut) return;
    if (etat) console.log('[historique] semaine écoulée : données effacées');
    etat = { semaine: s, parties: {}, enCours: false, erreur: null, essai: 0, echecs: 0 };
    const sauve = stockage.lire(FICHIER);
    if (sauve && sauve.semaine === s.debut) etat.parties = sauve.parties || {};
    else stockage.supprimer(FICHIER); // fichier d'une ancienne semaine : on le supprime
  }

  const manquantes = () => etat.semaine.jours
    .flatMap(j => GROUPES.map(g => [j, g]))
    .filter(([j, g]) => !etat.parties[j + '|' + g]);

  async function remplir() {
    const e = etat; // si la semaine change pendant le remplissage, on ne touche pas à la nouvelle
    e.enCours = true;
    try {
      for (const [jour, groupe] of manquantes()) {
        const b = provider.budget && provider.budget();
        if (b && b.restant <= RESERVE) throw new Error('quota du jour presque épuisé : la suite sera demandée plus tard');
        e.parties[jour + '|' + groupe] = await provider.getJournee(jour, groupe);
        if (e === etat) stockage.ecrire(FICHIER, { semaine: e.semaine.debut, parties: e.parties });
      }
      e.erreur = null; e.echecs = 0;
    } catch (err) {
      e.erreur = err.message; e.echecs++;
      console.error('[historique]', err.message);
    } finally { e.enCours = false; e.essai = Date.now(); }
  }

  function sortie() {
    const competitions = {};
    for (const g of GROUPES) {
      const vus = new Set(), liste = [];
      for (const j of etat.semaine.jours) {
        for (const m of etat.parties[j + '|' + g] || []) {
          if (m.status === 'up' || vus.has(m.id)) continue; // un match jamais joué n'est pas un résultat
          vus.add(m.id); liste.push(m);
        }
      }
      competitions[g] = liste.sort((a, b) => new Date(b.start) - new Date(a.start)); // le plus récent d'abord
    }
    return {
      semaine: { debut: etat.semaine.debut, fin: etat.semaine.fin },
      complet: manquantes().length === 0, enCours: etat.enCours, erreur: etat.erreur, competitions,
    };
  }

  // Appelé par /api/historique : renvoie tout de suite ce qu'on a, et lance le remplissage en arrière-plan si besoin.
  function lire() {
    verifierSemaine();
    const pause = Math.min(RETRY_S * 2 ** Math.max(0, etat.echecs - 1), 6 * 3600) * 1000;
    const attente = etat.erreur ? pause : 0;
    if (!etat.enCours && manquantes().length && Date.now() - etat.essai >= attente) remplir();
    return sortie();
  }

  function diagnostic() {
    verifierSemaine();
    return { semaine: etat.semaine.debut + ' → ' + etat.semaine.fin, partiesRecues: Object.keys(etat.parties).length,
      partiesTotal: etat.semaine.jours.length * GROUPES.length, enCours: etat.enCours, erreur: etat.erreur, echecs: etat.echecs };
  }

  return { lire, verifierSemaine, diagnostic };
}

module.exports = { creerHistorique, semainePassee };
