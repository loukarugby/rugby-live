// Quand faut-il redemander un classement ?
//
// Un classement ne change que lorsqu'un match se termine. Plutôt que de le redemander toutes les 12 h,
// on le garde donc (en mémoire et dans data/classements.json) jusqu'à ce qu'un match de la compétition soit fini :
//  - le serveur note la fin des matchs qu'il voit passer (coup d'envoi + 2 h = match terminé et pris en compte) ;
//  - un classement plus ancien que cette fin est "périmé" : il est redemandé UNE fois, au prochain affichage ;
//  - si Highlightly n'a pas encore mis son classement à jour (le nombre de matchs joués n'a pas bougé),
//    on réessaie 30 min plus tard, 3 fois au maximum ;
//  - garde-fou : un classement plus vieux que 4 jours est redemandé quand même
//    (au cas où le serveur n'aurait pas vu les matchs, par exemple s'il dormait).
const stockage = require('./stockage');

const FICHIER = 'classements.json';
const DUREE_MATCH_MIN = 120;
const RETRY_MIN = 30;
const MAX_RETRY = 3;
const AGE_MAX_S = +process.env.REFRESH_STANDINGS_S || 4 * 86400;

const matchsJoues = lignes => (lignes || []).reduce((total, r) => total + (+r.j || 0), 0);

function creerClassements() {
  const sauve = stockage.lire(FICHIER) || {};
  const fins = sauve.fins || {};     // cle → instant à partir duquel un classement plus ancien est périmé
  const essais = {};                 // cle → réessais déjà faits parce que Highlightly n'avait pas encore mis à jour

  // À appeler avec les matchs du jour à chaque mise à jour (même clés que /api/matchs : top14, prod2, france).
  function noterMatchs(donnees) {
    let change = false;
    for (const [comp, liste] of Object.entries(donnees || {})) {
      const cle = comp === 'france' ? 'sixnations' : comp;
      for (const m of liste || []) {
        if (m.status !== 'ft') continue;
        if (comp === 'france' && !/six nations/i.test(m.league || '')) continue; // les tests d'automne n'ont pas de classement
        const fin = new Date(m.start).getTime() + DUREE_MATCH_MIN * 60e3;
        if (Number.isFinite(fin) && fin > (fins[cle] || 0)) { fins[cle] = fin; change = true; }
      }
    }
    if (change) sauver();
  }

  // Le classement en cache est-il périmé à cause d'un match terminé depuis ?
  const perimeParMatch = (cle, c, maintenant) => !!c.donnees && !!fins[cle] && maintenant >= fins[cle] && fins[cle] > c.at;
  const perime = (cle, c, maintenant = Date.now()) =>
    !c.donnees || perimeParMatch(cle, c, maintenant) || maintenant - c.at > AGE_MAX_S * 1000;

  // Après un chargement réussi : si on l'avait demandé à cause d'un match mais que rien n'a changé chez
  // Highlightly (pas plus de matchs joués), on prévoit un nouvel essai dans 30 min.
  function apres(cle, anciennes, nouvelles, pourUnMatch, maintenant = Date.now()) {
    if (pourUnMatch && matchsJoues(nouvelles) <= matchsJoues(anciennes) && (essais[cle] || 0) < MAX_RETRY) {
      essais[cle] = (essais[cle] || 0) + 1;
      fins[cle] = maintenant + RETRY_MIN * 60e3;
    } else essais[cle] = 0;
    sauver();
  }

  // Sauvegarde / relecture (meilleur effort : le disque de Render gratuit est effacé à chaque déploiement).
  let lies = {};
  const lier = caches => { lies = caches; }; // le serveur nous donne son cache en mémoire, qu'on sauvegarde tel quel
  function sauver() {
    const donnees = {};
    for (const [nom, c] of Object.entries(lies)) if (nom.startsWith('classement-') && c.donnees) donnees[nom.slice(11)] = { donnees: c.donnees, at: c.at };
    stockage.ecrire(FICHIER, { fins, donnees });
  }
  const relire = () => sauve.donnees || {};

  const diagnostic = () => ({
    apresMatchsFinisAu: Object.fromEntries(Object.entries(fins).map(([k, v]) => [k, new Date(v).toISOString()])),
    ageMaxJours: AGE_MAX_S / 86400,
  });

  return { noterMatchs, perime, perimeParMatch, apres, lier, sauver, relire, diagnostic };
}

module.exports = { creerClassements };
