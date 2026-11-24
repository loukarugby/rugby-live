// Notification "permanente" du match en direct, envoyée au téléphone par Web Push.
//
// Comment ça marche :
//  1. Dans l'appli, tu appuies sur « Activer » : le téléphone crée un "abonnement" (une adresse de livraison)
//     que l'appli envoie au serveur.
//  2. Le serveur surveille les matchs (avec ses données en cache, donc sans requêtes en plus) et, quand le score
//     ou la phase de jeu change, il envoie une notification. Elle REMPLACE la précédente (même "tag") :
//     tu as donc une seule notification qui se met à jour, même appli fermée.
//  3. Choix du match : celui de ton équipe favorite s'il est en direct, sinon le match en direct (s'il y en a
//     plusieurs, on ajoute « +N autres matchs en direct »). À la fin du match, un dernier message donne le score final.
//
// Il faut deux clés (VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY) dans les variables d'environnement : voir README.
const webpush = require('web-push');
const stockage = require('./stockage');

const FICHIER = 'abonnes.json';
const MAX_ABONNES = 20; // appli perso : on limite pour éviter les abus
// On n'accepte que les vrais services de notification des navigateurs (Chrome, Firefox, Safari, Edge).
const HOTES_OK = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com)$/;

let actif = false, clePublique = null;
const abonnes = new Map(); // adresse (endpoint) → { sub, equipe, dernier }

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
  for (const a of stockage.lire(FICHIER) || []) if (a?.sub?.endpoint) abonnes.set(a.sub.endpoint, a);
  console.log(`Notifications prêtes (${abonnes.size} abonné${abonnes.size > 1 ? 's' : ''} rechargé${abonnes.size > 1 ? 's' : ''})`);
}

const sauver = () => stockage.ecrire(FICHIER, [...abonnes.values()]);
const config = () => ({ actif, cle: clePublique });

function abonner(sub, equipe) {
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
    equipe: String(equipe || '').trim().slice(0, 60),
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
function choisir(donnees, entree) {
  const tous = [], vus = new Set();
  for (const m of Object.values(donnees).flat()) if (!vus.has(m.id)) { vus.add(m.id); tous.push(m); }
  const direct = tous.filter(m => m.status === 'live');
  // Le match suivi vient de se terminer : on envoie son score final (une seule fois)
  const d = entree.dernier;
  if (d && !d.fini) {
    const fini = tous.find(m => m.id === d.id && m.status === 'ft');
    if (fini) return { m: fini, autres: direct.length };
  }
  const fav = norm(entree.equipe);
  const m = (fav && direct.find(x => joue(x, fav))) || direct[0] || null;
  return m ? { m, autres: direct.length - 1 } : null;
}

function charge(m, autres, sonore) {
  const aussi = autres > 0 ? `+${autres} autre${autres > 1 ? 's' : ''} match${autres > 1 ? 's' : ''} en direct` : null;
  return {
    title: `🏉 ${m.home} ${m.scoreHome} - ${m.scoreAway} ${m.away}`,
    body: [m.status === 'live' ? m.label : 'Match terminé', m.league, aussi].filter(Boolean).join(' · '),
    tag: 'rugby-live',        // même tag = la nouvelle notification remplace l'ancienne
    silent: !sonore,          // mises à jour de score : discrètes ; début et fin de match : avec son/vibration
    renotify: sonore,
    requireInteraction: true, // reste affichée (sur ordinateur) tant qu'on ne la ferme pas
    url: '/',
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
  if (!(await envoyer(entree, charge(c.m, c.autres, nouveauMatch || fini)))) return false;
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
  const quoi = entree.equipe ? `le match de ${entree.equipe} (ou le match en direct)` : 'le match en direct';
  await envoyer(entree, { title: '🔔 Notifications activées', body: `Tu suivras ${quoi} ici, même appli fermée.`, tag: 'rugby-info', silent: false, renotify: true, url: '/' });
}

module.exports = { init, config, abonner, desabonner, diffuser, bienvenue, nombre: () => abonnes.size, actif: () => actif, choisir };
