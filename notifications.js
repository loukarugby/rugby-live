// Notification "permanente" du match en direct, envoyée au téléphone par Web Push.
//
// Comment ça marche :
//  1. Dans l'appli, tu appuies sur « Activer » : le téléphone crée un "abonnement" (une adresse de livraison)
//     que l'appli envoie au serveur.
//  2. Le serveur surveille les matchs (avec ses données en cache, donc sans requêtes en plus) et, quand le score
//     ou la phase de jeu change, il envoie une notification. Elle REMPLACE la précédente (même "tag") :
//     tu as donc une seule notification qui se met à jour, même appli fermée.
//  3. Choix du match : celui d'une de tes équipes favorites s'il est en direct (dans l'ordre de ta liste), sinon le
//     premier match en direct (s'il y en a plusieurs, on ajoute « +N autres matchs en direct »). À la fin du match,
//     un dernier message donne le score final.
//  4. Tu choisis les championnats qui t'intéressent (Top 14, Pro D2, XV de France) : les matchs des autres ne
//     déclenchent rien, SAUF ceux de tes équipes favorites (toujours suivies).
//  5. Chaque notification porte aussi le nombre de matchs en direct : le téléphone l'affiche en pastille sur l'icône.
//
// Il faut deux clés (VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY) dans les variables d'environnement : voir README.
const webpush = require('web-push');
const stockage = require('./stockage');

const FICHIER = 'abonnes.json';
const MAX_ABONNES = 20; // appli perso : on limite pour éviter les abus
const MAX_FAVORIS = 8;
const CHAMPS = ['top14', 'prod2', 'france'];
// On n'accepte que les vrais services de notification des navigateurs (Chrome, Firefox, Safari, Edge).
const HOTES_OK = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com)$/;

let actif = false, clePublique = null;
const abonnes = new Map(); // adresse (endpoint) → { sub, equipes: [...], champs: [...], dernier }

function init() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    console.log('------------------------------------------------------------------');
    console.log('NOTIFICATIONS DÉSACTIVÉES : clés VAPID absentes.');
    console.log('Copie ces 2 lignes dans Render > Environment (une variable par ligne), puis redéploie :');
    console.log('VAPID_PUBLIC_KEY=' + k.publicKey);
    console.log('VAPID_PRIVATE_KEY=' + k.privateKey);
    console.log('(ce sont des secrets : ne les mets pas sur GitHub)');
    console.log('------------------------------------------------------------------');
    return;
  }
  const sujet = process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'mailto:rugby-live@example.com';
  try { webpush.setVapidDetails(sujet, pub, priv); } catch (e) { console.error('Clés VAPID invalides :', e.message); return; }
  actif = true; clePublique = pub;
  for (const a of stockage.lire(FICHIER) || []) {
    if (!a?.sub?.endpoint) continue;
    a.equipes = listeEquipes(a.equipes ?? a.equipe); delete a.equipe;   // anciennes versions : une seule équipe
    a.champs = listeChamps(a.champs);
    abonnes.set(a.sub.endpoint, a);
  }
  console.log(`Notifications prêtes (${abonnes.size} abonné${abonnes.size > 1 ? 's' : ''} rechargé${abonnes.size > 1 ? 's' : ''})`);
}

// Réglages reçus du téléphone : on les nettoie (jamais confiance aveugle).
function listeEquipes(v) {
  const l = Array.isArray(v) ? v : (v ? [v] : []);
  return [...new Set(l.map(x => String(x ?? '').trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_FAVORIS);
}
function listeChamps(v) { return Array.isArray(v) ? CHAMPS.filter(c => v.includes(c)) : [...CHAMPS]; } // absent = tous

const sauver = () => stockage.ecrire(FICHIER, [...abonnes.values()]);
const config = () => ({ actif, cle: clePublique });

function abonner(sub, equipes, champs) {
  if (!actif) return { erreur: 'Notifications non configurées sur le serveur' };
  let hote = '';
  try { const u = new URL(sub?.endpoint); if (u.protocol === 'https:') hote = u.hostname; } catch { /* adresse invalide */ }
  if (!hote || !HOTES_OK.test(hote) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
    return { erreur: 'Abonnement invalide' };
  }
  const ancien = abonnes.get(sub.endpoint);
  if (!ancien && abonnes.size >= MAX_ABONNES) return { erreur: 'Trop d’abonnés' };
  const entree = {
    sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    equipes: listeEquipes(equipes),
    champs: listeChamps(champs),
    dernier: ancien ? ancien.dernier : null,
  };
  abonnes.set(sub.endpoint, entree);
  sauver();
  return { entree };
}

function desabonner(endpoint) {
  if (abonnes.delete(endpoint)) sauver();
}

// Pour comparer des noms d'équipes : sans accents, sans majuscules, sans ponctuation.
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const joue = (m, fav) => [m.home, m.away].some(n => {
  const a = norm(n);
  return a === fav || (a.length >= 3 && fav.includes(a)) || (fav.length >= 3 && a.includes(fav));
});

// Quel match afficher dans la notification de cet abonné ? (null = rien à envoyer)
// `nb` = nombre de matchs en direct qui concernent cet abonné (pastille sur l'icône).
function choisir(donnees, entree) {
  const favs = (entree.equipes || []).map(norm).filter(Boolean);
  const champs = entree.champs || CHAMPS;
  const tous = [], vus = new Set();
  for (const [comp, liste] of Object.entries(donnees)) for (const m of liste) if (!vus.has(m.id)) { vus.add(m.id); tous.push({ ...m, comp }); }
  const direct = tous.filter(m => m.status === 'live' && (champs.includes(m.comp) || favs.some(f => joue(m, f))));
  // Le match suivi vient de se terminer : on envoie son score final (une seule fois)
  const d = entree.dernier;
  if (d && !d.fini) {
    const fini = tous.find(m => m.id === d.id && m.status === 'ft');
    if (fini) return { m: fini, autres: direct.length, nb: direct.length };
  }
  let m = null;
  for (const f of favs) { m = direct.find(x => joue(x, f)); if (m) break; } // équipes favorites, dans l'ordre de la liste
  m = m || direct[0] || null;
  return m ? { m, autres: direct.length - 1, nb: direct.length } : null;
}

function charge(m, autres, sonore, nb) {
  const aussi = autres > 0 ? `+${autres} autre${autres > 1 ? 's' : ''} match${autres > 1 ? 's' : ''} en direct` : null;
  return {
    title: `🏉 ${m.home} ${m.scoreHome} - ${m.scoreAway} ${m.away}`,
    body: [m.status === 'live' ? m.label : 'Match terminé', m.league, aussi].filter(Boolean).join(' · '),
    tag: 'rugby-live',        // même tag = la nouvelle notification remplace l'ancienne
    silent: !sonore,          // mises à jour de score : discrètes ; début et fin de match : avec son/vibration
    renotify: sonore,
    requireInteraction: true, // reste affichée (sur ordinateur) tant qu'on ne la ferme pas
    url: '/',
    badge: nb,                // nombre de matchs en direct → pastille sur l'icône de l'appli
  };
}

async function envoyer(entree, contenu) {
  try {
    // topic : si le téléphone est éteint, seule la dernière notification en attente est livrée
    await webpush.sendNotification(entree.sub, JSON.stringify(contenu), { TTL: 1800, urgency: 'high', topic: 'rugby-live' });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { abonnes.delete(entree.sub.endpoint); sauver(); } // abonnement expiré
    else console.error('[notifications]', e.statusCode || '', e.body || e.message);
    return false;
  }
}

async function diffuserUn(entree, donnees) {
  const c = choisir(donnees, entree);
  if (!c) return false;
  const signature = `${c.m.id}|${c.m.status}|${c.m.scoreHome}-${c.m.scoreAway}|${c.m.label}|${c.autres}`;
  if (entree.dernier && entree.dernier.sig === signature) return false; // rien de nouveau
  const fini = c.m.status === 'ft';
  const nouveauMatch = !entree.dernier || entree.dernier.id !== c.m.id;
  if (!(await envoyer(entree, charge(c.m, c.autres, nouveauMatch || fini, c.nb)))) return false;
  entree.dernier = { id: c.m.id, sig: signature, fini };
  sauver();
  return true;
}

// Appelé régulièrement par le serveur avec les matchs du jour.
async function diffuser(donnees) {
  if (!actif || !donnees) return;
  for (const entree of [...abonnes.values()]) await diffuserUn(entree, donnees);
}

// Message de confirmation quand on vient d'appuyer sur « Activer » (vérifie que toute la chaîne marche).
async function bienvenue(entree, donnees) {
  if (donnees && await diffuserUn(entree, donnees)) return; // un match est en direct : on l'affiche tout de suite
  const noms = { top14: 'Top 14', prod2: 'Pro D2', france: 'XV de France' };
  const quoi = [entree.equipes.length ? entree.equipes.join(', ') : '', entree.champs.length ? entree.champs.map(c => noms[c]).join(' / ') : ''].filter(Boolean).join(' + ') || 'rien pour le moment (choisis un championnat ou une équipe)';
  await envoyer(entree, { title: '🔔 Notifications activées', body: `Tu suivras : ${quoi}, même appli fermée.`, tag: 'rugby-info', silent: false, renotify: true, url: '/' });
}

module.exports = { init, config, abonner, desabonner, diffuser, bienvenue, nombre: () => abonnes.size, actif: () => actif, choisir };
