// Petit stockage dans des fichiers JSON (dossier "data/", ou DATA_DIR si tu le définis).
// ATTENTION : sur l'hébergement gratuit de Render, le disque est effacé à chaque redémarrage ou déploiement.
// Ce stockage est donc un "bonus" : s'il disparaît, l'appli redemande simplement ce dont elle a besoin.
const fs = require('fs');
const path = require('path');

const DOSSIER = process.env.DATA_DIR || path.join(__dirname, 'data');

function lire(nom) {
  try { return JSON.parse(fs.readFileSync(path.join(DOSSIER, nom), 'utf8')); } catch { return null; }
}

function ecrire(nom, objet) {
  try {
    fs.mkdirSync(DOSSIER, { recursive: true });
    const fichier = path.join(DOSSIER, nom);
    fs.writeFileSync(fichier + '.tmp', JSON.stringify(objet));
    fs.renameSync(fichier + '.tmp', fichier); // écriture "tout ou rien" : pas de fichier à moitié écrit
  } catch (e) { console.error('[stockage] écriture impossible :', e.message); }
}

function supprimer(nom) {
  try { fs.unlinkSync(path.join(DOSSIER, nom)); } catch { /* déjà absent */ }
}

module.exports = { lire, ecrire, supprimer };
