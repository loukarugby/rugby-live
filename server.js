// Backend : va chercher les données chez le fournisseur, les garde en cache,
// et les sert à la PWA via sa propre petite API.
require('dotenv').config();
const express = require('express');
const path = require('path');

const reel = Boolean(process.env.API_SPORTS_KEY);
const provider = require(reel ? './providers/apisports' : './providers/mock');
console.log(reel ? 'Source : API-Sports' : 'Source : données fictives (aucune clé API)');

const S = n => n * 1000;
const LIVE_S = +process.env.REFRESH_LIVE_S || (reel ? 300 : 10); // pendant un match
const IDLE_S = +process.env.REFRESH_IDLE_S || 3600;              // plafond hors match
const CLASS_S = +process.env.REFRESH_STANDINGS_S || 43200;       // classements : 12 h
const RETRY_S = +process.env.RETRY_AFTER_ERROR_S || 600;         // pause après une erreur

const jourParis = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

// Durée de vie du cache des matchs (économise les requêtes) :
// - un match est en cours, ou va commencer dans moins de 5 min : on rafraîchit souvent
// - sinon on "dort" jusqu'à 5 min avant le prochain coup d'envoi (au plus IDLE_S)
function ttlMatchs(c) {
  const maintenant = Date.now();
  const liste = Object.values(c.donnees).flat();
  if (liste.some(m => m.status === 'live')) return S(LIVE_S);
  const delais = liste.filter(m => m.status === 'up')
    .map(m => new Date(m.start) - maintenant)
    .filter(d => d > -2 * 3600e3); // un match "à venir" depuis plus de 2 h : reporté, on l'ignore
  if (!delais.length) return S(IDLE_S);
  const prochain = Math.min(...delais);
  if (prochain <= 5 * 60e3) return S(LIVE_S);
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
    enCours[nom] = charger()
      .then(d => { c.donnees = d; c.at = Date.now(); c.jour = jourParis(); c.erreur = null; })
      .catch(e => { c.erreur = e.message; console.error(`[${nom}]`, e.message); })
      .finally(() => { c.essai = Date.now(); enCours[nom] = null; });
  }
  if (!c.donnees) await enCours[nom]; // tout premier chargement : on attend
  return c;
}

const app = express();

app.get('/api/matchs', async (req, res) => {
  const c = await lire('matchs', provider.getMatchs, ttlMatchs, true);
  if (!c.donnees || c.jour !== jourParis()) return res.status(503).json({ erreur: c.erreur || 'Données indisponibles' });
  res.json({ majServeur: new Date(c.at).toISOString(), competitions: c.donnees });
});

// Un classement à la fois (?comp=top14 | prod2 | sixnations) : on ne dépense une requête
// que pour le classement que l'utilisateur ouvre vraiment.
app.get('/api/classements', async (req, res) => {
  const cle = String(req.query.comp || '');
  if (!['top14', 'prod2', 'sixnations'].includes(cle)) return res.status(400).json({ erreur: 'Compétition inconnue' });
  const c = await lire('classement-' + cle, () => provider.getClassement(cle), () => S(CLASS_S));
  if (!c.donnees) return res.status(503).json({ erreur: c.erreur || 'Données indisponibles' });
  res.json(c.donnees);
});

// Page de diagnostic : ouvre /api/etat dans le navigateur pour voir les erreurs et les requêtes restantes.
app.get('/api/etat', (req, res) => {
  const resume = {};
  for (const [nom, c] of Object.entries(caches)) {
    resume[nom] = { misAJour: c.at ? new Date(c.at).toISOString() : null, erreur: c.erreur };
  }
  res.json({ source: reel ? 'API-Sports' : 'données fictives', requetes: provider.etat ? provider.etat() : null, caches: resume });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur prêt : http://localhost:${PORT}`));
