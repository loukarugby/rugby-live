// Backend : va chercher les données chez le fournisseur, les garde en cache,
// et les sert à la PWA via sa propre petite API.
require('dotenv').config();
const express = require('express');
const path = require('path');

const reel = Boolean(process.env.API_SPORTS_KEY);
const provider = require(reel ? './providers/apisports' : './providers/mock');
console.log(reel ? 'Source : API-Sports' : 'Source : données fictives (aucune clé API)');

const S = n => n * 1000;
const LIVE_S = +process.env.REFRESH_LIVE_S || (reel ? 120 : 10);
const IDLE_S = +process.env.REFRESH_IDLE_S || 1800;
const CLASS_S = +process.env.REFRESH_STANDINGS_S || 21600;

// Durée de vie du cache des matchs : courte si un match est en cours ou va commencer, longue sinon.
function ttlMatchs(donnees) {
  const maintenant = Date.now();
  const actif = Object.values(donnees).flat().some(m => {
    if (m.status === 'live') return true;
    const dans = new Date(m.start) - maintenant; // ms avant le coup d'envoi
    return m.status === 'up' && dans < 30 * 60e3 && dans > -2 * 3600e3;
  });
  return S(actif ? LIVE_S : IDLE_S);
}

// Cache en mémoire. Si les données sont périmées, on répond avec l'ancienne version
// et on rafraîchit en arrière-plan. Une seule requête chez le fournisseur à la fois.
const cache = { matchs: { donnees: null, at: 0 }, classements: { donnees: null, at: 0 } };
const enCours = {};

async function lire(nom, charger, ttl) {
  const c = cache[nom];
  if (c.donnees && Date.now() - c.at < ttl(c.donnees)) return c;
  if (!enCours[nom]) {
    enCours[nom] = charger()
      .then(d => { c.donnees = d; c.at = Date.now(); })
      .catch(e => console.error(`[${nom}]`, e.message))
      .finally(() => { enCours[nom] = null; });
  }
  if (!c.donnees) await enCours[nom]; // tout premier chargement : on attend
  return c;
}

const app = express();

app.get('/api/matchs', async (req, res) => {
  const c = await lire('matchs', provider.getMatchs, ttlMatchs);
  if (!c.donnees) return res.status(503).json({ erreur: 'Données indisponibles' });
  res.json({ majServeur: new Date(c.at).toISOString(), competitions: c.donnees });
});

app.get('/api/classements', async (req, res) => {
  const c = await lire('classements', provider.getClassements, () => S(CLASS_S));
  if (!c.donnees) return res.status(503).json({ erreur: 'Données indisponibles' });
  res.json(c.donnees);
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur prêt : http://localhost:${PORT}`));
