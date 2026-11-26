// Calendrier et résultats de TOUTE la saison, pour chaque compétition (Top 14, Pro D2, XV de France).
//
// Pour dépenser le moins de requêtes possible :
//  - une compétition n'est demandée que quand quelqu'un la consulte (pas de demande "pour rien") ;
//  - elle est demandée en 1 à 3 requêtes (voir providers/highlightly.js), puis GARDÉE 7 jours
//    (mémoire + data/calendrier.json) : c'est la mise à jour hebdomadaire qui rattrape un calendrier modifié ;
//  - les scores des matchs vus en direct sont recopiés dans ce calendrier sans aucune requête (fusionner) :
//    les résultats du week-end y apparaissent tout de suite ;
//  - cas où il faut redemander avant 7 jours : un match prévu s'est terminé sans que le serveur ait vu son résultat
//    (par exemple parce qu'il dormait) ;
//  - on ne touche jamais aux dernières requêtes du jour (RESERVE_REQUETES_LIVE), gardées pour le direct ;
//  - après une erreur, pauses de plus en plus longues avant de réessayer (15 min, 30 min, 1 h... 6 h au maximum).
const stockage = require('./stockage');

const FICHIER = 'calendrier.json';
const GROUPES = ['top14', 'prod2', 'france'];
const AGE_MAX_S = +process.env.CALENDRIER_S || 7 * 86400;
const RESERVE = +process.env.RESERVE_REQUETES_LIVE || 20;
const RETRY_S = +process.env.RETRY_CALENDRIER_S || 900;
const DUREE_MATCH = 3 * 3600e3; // coup d'envoi + 3 h : le match est forcément terminé

function creerCalendrier({ provider }) {
  const groupes = (stockage.lire(FICHIER) || {}).groupes || {}; // groupe → { at, saison, matchs }
  const etat = {};                                              // groupe → { enCours, erreur, echecs, essai }
  const suivi = g => (etat[g] ||= { enCours: false, erreur: null, echecs: 0, essai: 0 });

  let timer = null;
  const sauver = () => stockage.ecrire(FICHIER, { groupes });
  const sauverPlusTard = () => { if (!timer) { timer = setTimeout(() => { timer = null; sauver(); }, 30000); timer.unref?.(); } };

  // Faut-il redemander ce calendrier ?
  function perime(g, maintenant = Date.now()) {
    const c = groupes[g];
    if (!c) return true;
    if (maintenant - c.at > AGE_MAX_S * 1000) return true;
    return c.matchs.some(m => {
      const fin = new Date(m.start).getTime() + DUREE_MATCH;
      return m.status === 'up' && fin < maintenant && c.at < fin; // match fini depuis, mais résultat jamais vu
    });
  }

  async function remplir(g) {
    const s = suivi(g);
    s.enCours = true;
    try {
      const b = provider.budget && provider.budget();
      if (b && b.restant <= RESERVE) throw new Error('quota du jour presque épuisé : le calendrier sera demandé plus tard');
      const { saison, matchs } = await provider.getCalendrier(g);
      matchs.sort((a, b2) => new Date(a.start) - new Date(b2.start));
      groupes[g] = { at: Date.now(), saison, matchs };
      s.erreur = null; s.echecs = 0;
      sauver();
    } catch (e) {
      s.erreur = e.message;
      if (!/quota|budget/i.test(e.message)) s.echecs++; // manquer de quota n'est pas une panne : pas de pause qui s'allonge
      console.error(`[calendrier ${g}]`, e.message);
    } finally { s.enCours = false; s.essai = Date.now(); }
  }

  // Appelé par /api/calendrier : renvoie tout de suite ce qu'on a, et lance la mise à jour en arrière-plan si besoin.
  function lire(g) {
    const s = suivi(g);
    const pause = Math.min(RETRY_S * 2 ** Math.max(0, s.echecs - 1), 6 * 3600) * 1000;
    if (!s.enCours && perime(g) && Date.now() - s.essai >= (s.erreur ? pause : 0)) remplir(g);
    const c = groupes[g];
    return { saison: c ? c.saison : null, majServeur: c ? new Date(c.at).toISOString() : null, matchs: c ? c.matchs : [], complet: !!c, enCours: s.enCours, erreur: s.erreur };
  }

  // Recopie dans le calendrier les statuts et scores vus en direct (matchs du jour) : zéro requête.
  function fusionner(direct) {
    let change = false;
    for (const g of GROUPES) {
      const c = groupes[g];
      if (!c) continue;
      for (const m of (direct && direct[g]) || []) {
        const x = c.matchs.find(y => y.id === m.id);
        if (!x) continue;
        for (const k of ['status', 'label', 'scoreHome', 'scoreAway', 'start']) if (x[k] !== m[k]) { x[k] = m[k]; change = true; }
      }
    }
    if (change) sauverPlusTard();
  }

  const diagnostic = () => Object.fromEntries(GROUPES.map(g => [g, {
    matchs: groupes[g] ? groupes[g].matchs.length : 0, saison: groupes[g]?.saison ?? null,
    misAJour: groupes[g] ? new Date(groupes[g].at).toISOString() : null, enCours: suivi(g).enCours, erreur: suivi(g).erreur, echecs: suivi(g).echecs,
  }]));

  return { lire, fusionner, perime, diagnostic, groupes: GROUPES };
}

module.exports = { creerCalendrier };
