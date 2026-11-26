// Backend : va chercher les données chez le fournisseur, les garde en cache,
// et les sert à la PWA via sa propre petite API. Envoie aussi les notifications du match en direct.
require('dotenv').config();
const express = require('express');
const path = require('path');
const notifs = require('./notifications');
const { creerCalendrier } = require('./calendrier');
const { creerClassements } = require('./classements');

// Choix de la source : Highlightly si sa clé est présente, sinon API-Sports, sinon données fictives.
let nomSource, provider;
if (process.env.HIGHLIGHTLY_API_KEY) { nomSource = 'Highlightly'; provider = require('./providers/highlightly'); }
else if (process.env.API_SPORTS_KEY) { nomSource = 'API-Sports'; provider = require('./providers/apisports'); }
else { nomSource = 'données fictives'; provider = require('./providers/mock'); }
const reel = nomSource !== 'données fictives';
console.log(reel ? 'Source : ' + nomSource : 'Source : données fictives (aucune clé API : HIGHLIGHTLY_API_KEY absente)');

const S = n => n * 1000;
const LIVE_S = +process.env.REFRESH_LIVE_S || (reel ? 300 : 10); // pendant un match
const IDLE_S = +process.env.REFRESH_IDLE_S || 3600;              // plafond hors match
const RETRY_S = +process.env.RETRY_AFTER_ERROR_S || 600;         // pause après une erreur

const jourParis = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

// Pendant un match on rafraîchit toutes les LIVE_S secondes... sauf si le quota du jour fond :
// on espace alors les rafraîchissements pour tenir jusqu'à la fin de la journée.
function secondesLive() {
  const b = provider.budget && provider.budget();
  if (!b) return LIVE_S;
  if (b.restant <= 20) return Math.max(LIVE_S, 1200);
  if (b.restant <= 40) return Math.max(LIVE_S, 600);
  return LIVE_S;
}

// Durée de vie du cache des matchs (économise les requêtes) :
// - un match est en cours, ou va commencer dans moins de 5 min : on rafraîchit souvent
// - sinon on "dort" jusqu'à 5 min avant le prochain coup d'envoi (au plus IDLE_S)
// (et le fournisseur ne redemande que les compétitions concernées : voir providers/highlightly.js)
function ttlMatchs(c) {
  const maintenant = Date.now();
  const liste = Object.values(c.donnees).flat();
  if (liste.some(m => m.status === 'live')) return S(secondesLive());
  const delais = liste.filter(m => m.status === 'up')
    .map(m => new Date(m.start) - maintenant)
    .filter(d => d > -2 * 3600e3); // un match "à venir" depuis plus de 2 h : reporté, on l'ignore
  if (!delais.length) return S(IDLE_S);
  const prochain = Math.min(...delais);
  if (prochain <= 5 * 60e3) return S(secondesLive());
  return Math.min(S(IDLE_S), (maintenant - c.at) + prochain - 5 * 60e3);
}

// Cache en mémoire. Une seule requête chez le fournisseur à la fois par type de données.
// Après une erreur, on attend RETRY_S avant de réessayer : sinon chaque visite gaspillerait des requêtes.
const caches = {};
const enCours = {};

async function lire(nom, charger, ttl, verifierJour) {
  const c = caches[nom] ||= { donnees: null, at: 0, essai: 0, erreur: null, jour: null };
  const maintenant = Date.now();
  const frais = c.donnees && (!verifierJour || c.jour === jourParis()) && maintenant - c.at < ttl(c);
  if (frais) return c;
  if (c.erreur && maintenant - c.essai < S(RETRY_S)) return c;
  if (!enCours[nom]) {
    // on donne au fournisseur ce qu'on sait déjà d'aujourd'hui, pour qu'il ne redemande que le nécessaire
    const precedent = c.donnees && c.jour === jourParis() ? c.donnees : null;
    enCours[nom] = charger(precedent)
      .then(d => { c.donnees = d; c.at = Date.now(); c.jour = jourParis(); c.erreur = null; })
      .catch(e => { c.erreur = e.message; console.error(`[${nom}]`, e.message); })
      .finally(() => { c.essai = Date.now(); enCours[nom] = null; });
  }
  if (!c.donnees) await enCours[nom]; // tout premier chargement : on attend
  return c;
}

const calendrier = creerCalendrier({ provider });
const classements = creerClassements();
// On retrouve les classements sauvegardés (si le disque a survécu au redémarrage)
for (const [cle, v] of Object.entries(classements.relire())) {
  caches['classement-' + cle] = { donnees: v.donnees, at: v.at, essai: 0, erreur: null, jour: null };
}
classements.lier(caches);

// À chaque mise à jour des matchs : on note ceux qui sont terminés (ils rendent le classement périmé, voir classements.js)
// et on recopie leurs scores dans le calendrier de la saison (voir calendrier.js) : sans aucune requête de plus.
const lireMatchs = () => lire('matchs', precedent => provider.getMatchs(precedent).then(d => { classements.noterMatchs(d); calendrier.fusionner(d); return d; }), ttlMatchs, true);

// Un classement est gardé tant qu'aucun match de sa compétition n'est terminé depuis : plus de renouvellement toutes les 12 h.
async function lireClassement(cle) {
  const nom = 'classement-' + cle;
  const avant = caches[nom]?.at;
  const c = await lire(nom, async () => {
    const ancien = caches[nom];
    const pourUnMatch = !!ancien && classements.perimeParMatch(cle, ancien, Date.now());
    const anciennes = ancien?.donnees;
    const nouvelles = await provider.getClassement(cle);
    classements.apres(cle, anciennes, nouvelles, pourUnMatch);
    return nouvelles;
  }, c => classements.perime(cle, c) ? 0 : Number.MAX_SAFE_INTEGER);
  if (c.at !== avant) classements.sauver();
  return c;
}

notifs.init();

const app = express();

app.get('/api/matchs', async (req, res) => {
  const c = await lireMatchs();
  if (!c.donnees || c.jour !== jourParis()) return res.status(503).json({ erreur: c.erreur || 'Données indisponibles' });
  res.json({ majServeur: new Date(c.at).toISOString(), competitions: c.donnees });
});

// Calendrier et résultats de toute la saison d'une compétition (?comp=top14 | prod2 | france).
// Renvoie tout de suite ce qu'on a ; si une mise à jour est nécessaire elle part en arrière-plan (enCours: true).
app.get('/api/calendrier', (req, res) => {
  const comp = String(req.query.comp || '');
  if (!calendrier.groupes.includes(comp)) return res.status(400).json({ erreur: 'Compétition inconnue' });
  if (!provider.getCalendrier) return res.status(501).json({ erreur: 'Calendrier indisponible avec cette source de données' });
  res.json(calendrier.lire(comp));
});

// Un classement à la fois (?comp=top14 | prod2 | sixnations) : on ne dépense une requête
// que pour le classement que l'utilisateur ouvre vraiment.
app.get('/api/classements', async (req, res) => {
  const cle = String(req.query.comp || '');
  if (!['top14', 'prod2', 'sixnations'].includes(cle)) return res.status(400).json({ erreur: 'Compétition inconnue' });
  const c = await lireClassement(cle);
  if (!c.donnees) return res.status(503).json({ erreur: c.erreur || 'Données indisponibles' });
  res.json(c.donnees);
});

// Équipes que l'on peut choisir en favori : clubs du Top 14, puis de la Pro D2 (jamais d'équipe nationale).
// Elle réutilise les classements en cache (les mêmes que l'onglet Classement : au plus 1 requête par
// compétition toutes les 12 h) et n'est appelée que quand on ouvre le menu de la cloche.
// Si un classement est indisponible, on se rabat sur les équipes des matchs du jour de cette compétition.
app.get('/api/equipes', async (req, res) => {
  const equipes = { top14: new Set(), prod2: new Set() };
  let complet = true;
  for (const cle of ['top14', 'prod2']) {
    // La liste des clubs ne change pas à la fin d'un match : on prend le classement en cache, même "périmé"
    const enCache = caches['classement-' + cle];
    const c = enCache?.donnees?.length ? enCache : await lireClassement(cle);
    if (c.donnees?.length) c.donnees.forEach(r => r.equipe && equipes[cle].add(r.equipe));
    else {
      complet = false;
      (caches.matchs?.donnees?.[cle] || []).forEach(x => { equipes[cle].add(x.home); equipes[cle].add(x.away); });
    }
  }
  const trier = set => [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr'));
  res.json({
    top14: trier(equipes.top14),
    prod2: trier(equipes.prod2).filter(n => !equipes.top14.has(n)),
    complet,
  });
});

// --- Notifications ---
app.get('/api/push/config', (req, res) => res.json(notifs.config()));

app.post('/api/push/abonner', express.json({ limit: '10kb' }), (req, res) => {
  const r = notifs.abonner(req.body?.subscription, req.body?.equipe);
  if (r.erreur) return res.status(400).json({ erreur: r.erreur });
  res.json({ ok: true });
  if (req.body?.test) { // on vient d'appuyer sur « Activer » : message de confirmation
    const c = caches.matchs;
    notifs.bienvenue(r.entree, c && c.jour === jourParis() ? c.donnees : null).catch(e => console.error('[notifications]', e.message));
  }
});

app.post('/api/push/desabonner', express.json({ limit: '10kb' }), (req, res) => {
  notifs.desabonner(String(req.body?.endpoint || ''));
  res.json({ ok: true });
});

// Ne dépense aucune requête chez le fournisseur : sert à garder le serveur éveillé (voir README).
app.get('/api/ping', (req, res) => res.type('text').send('ok'));

// Page de diagnostic : ouvre /api/etat dans le navigateur pour voir les erreurs et les requêtes restantes.
app.get('/api/etat', (req, res) => {
  const resume = {};
  for (const [nom, c] of Object.entries(caches)) {
    resume[nom] = { misAJour: c.at ? new Date(c.at).toISOString() : null, erreur: c.erreur };
  }
  res.json({
    source: nomSource, requetes: provider.etat ? provider.etat() : null, caches: resume,
    calendrier: provider.getCalendrier ? calendrier.diagnostic() : null,
    classements: classements.diagnostic(),
    notifications: { actives: notifs.actif(), abonnes: notifs.nombre() },
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// Tâche de fond (toutes les 30 s) :
//  - s'il y a des abonnés aux notifications, met les matchs à jour (le cache décide s'il faut vraiment
//    interroger le fournisseur) et envoie les notifications utiles.
setInterval(async () => {
  try {
    if (!notifs.actif() || !notifs.nombre()) return;
    const c = await lireMatchs();
    if (c.donnees && c.jour === jourParis()) await notifs.diffuser(c.donnees);
  } catch (e) { console.error('[tâche de fond]', e.message); }
}, 30000);

// Render (offre gratuite) endort le serveur après 15 min sans visite : plus de notifications dans ce cas.
// Tant que quelqu'un est abonné, le serveur s'appelle donc lui-même toutes les 10 min pour rester éveillé.
// (désactivable avec KEEP_AWAKE=non ; RENDER_EXTERNAL_URL est fournie automatiquement par Render)
const URL_PUBLIQUE = process.env.RENDER_EXTERNAL_URL;
if (URL_PUBLIQUE && process.env.KEEP_AWAKE !== 'non') {
  setInterval(() => { if (notifs.nombre()) fetch(URL_PUBLIQUE + '/api/ping').catch(() => {}); }, 10 * 60e3);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur prêt : http://localhost:${PORT}`));
