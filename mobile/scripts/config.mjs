// Écrit capacitor.config.json avec l'adresse du serveur Fenix.
// FENIX_SERVER=https://fenix.promarketmalchena.com npm run sync
import { writeFileSync } from 'node:fs';
const server = (process.env.FENIX_SERVER || 'https://fenix.promarketmalchena.com').replace(/\/+$/, '');
// HTTPS obligatoire (mots de passe, positions, photos). Seule exception : http://localhost pour les essais sur PC.
const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server);
if (!server.startsWith('https://') && !local) {
  console.error(`Refusé : l'appli doit utiliser une adresse HTTPS (reçu : ${server}).`);
  process.exit(1);
}
const http = local;
const config = {
  appId: 'com.fenixdelivery.livreur',
  appName: 'Fenix Livreur',
  webDir: 'www',
  server: {
    // L'appli ouvre directement l'appli livreur du serveur : même code, mêmes comptes, mêmes colis.
    url: `${server}/livreur/`,
    cleartext: http,
    errorPath: 'offline.html'
  },
  android: { allowMixedContent: http },
  plugins: {
    // Barre de statut : Capacitor donne la hauteur à la page (--safe-area-inset-top), utilisée par l'en-tête.
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover' }
  }
};
writeFileSync(new URL('../capacitor.config.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
// La page « Pas de connexion » sait où réessayer.
writeFileSync(new URL('../www/config.js', import.meta.url), `window.FENIX_URL = ${JSON.stringify(config.server.url)};\n`);
console.log(`Serveur Fenix : ${server}`);
