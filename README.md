# Fenix Delivery – système de livraison de colis à Kinshasa

Un seul programme qui fait tourner les 4 parties :

| Partie | Adresse | Pour qui |
| --- | --- | --- |
| Site public | `/` | Tout le monde : prix, suivi d'un colis, agences |
| Suivi | `/suivi?n=KIN-…` | Le destinataire (lien reçu par SMS) |
| Espace commerçant | `/commercant/` | Inscription, nouvel envoi avec carte, étiquettes, argent à recevoir |
| Appli livreur | `/livreur/` | Sur le téléphone du livreur : tournée, scan, navigation, code, photo, caisse |
| Caisse d'agence | `/agence/` | Comptoir : envois, ventes, retraits, réception, boîtes postales, caisse du soir |
| Back office | `/admin/` | Toi : tableau de bord, colis, dépôt, équipe, commerçants, caisse, reversements, agences, stock, tarifs |

Le nom affiché est « Fenix Delivery » : tu peux le changer dans **Back office › Tarifs et réglages › Nom de la société**.

---

## 1. Lancer sur ton PC Windows (Docker Desktop)

1. Installe **Docker Desktop** et démarre-le.
2. Dézippe le dossier `kincolis`.
3. Dans le dossier, copie `.env.example` et renomme la copie en `.env`. Ouvre-la et change `ADMIN_PASSWORD`.
4. Ouvre PowerShell dans le dossier et tape :

   ```
   docker compose up -d --build
   ```

5. Ouvre **http://localhost:3000** dans ton navigateur.

Pour arrêter : `docker compose down`. Les données restent gardées (volume `kincolis-data`).

**Sans Docker** (Node.js 22 installé) : `npm install` puis `npm start`.

## 2. Comptes

- **Administrateur** : le téléphone et le mot de passe de ton fichier `.env` (par défaut `0800000000`).
- **Comptes de démonstration** (si `SEED_DEMO=1`), mot de passe `demo123` :
  - Commerçant : `0810000001`
  - Livreurs : `0820000001`, `0820000002`
  - Agents : `0830000001` (Agence Gombe, dépôt central), `0830000002` (Relais Limete)

Avant d'utiliser le système pour de vrai, mets `SEED_DEMO=0` et repars d'une base vide (supprime le volume : `docker compose down -v`).

## 3. Le parcours d'un colis

1. **Création** : par un commerçant (site), au comptoir d'une agence, ou par toi. Le destinataire reçoit par SMS le numéro de suivi et son **code de livraison à 4 chiffres**.
2. **Assignation** : dans *Back office › Colis*, choisis le livreur.
3. **Ramassage** : le livreur scanne l'étiquette chez le commerçant ou au point relais.
4. **Dépôt** : à l'agence centrale (*Caisse d'agence › Réception*, ou *Back office › Dépôt et tri*), le scan donne l'**étagère**.
5. **Livraison** : tu assignes le livreur de la zone, il part, navigue avec Google Maps, encaisse si besoin, entre le **code du client** et prend une photo.
6. **Échec** : raison choisie, SMS au client, nouvelle tentative ou retour.
7. **Retrait en agence** : le colis est déposé à l'agence choisie, le client vient avec son code.
8. **Le soir** : *Back office › Caisse du soir* (livreurs et agences rendent l'argent, les écarts sont notés), puis *Reversements* (argent des commerçants envoyé par Mobile Money, avec la référence).

## 4. Tarifs

Les prix de départ sont des **exemples** : change-les dans *Back office › Tarifs et réglages*.

- Zone 1 : même commune. Zone 2 : même secteur. Zone 3 : autre secteur.
- Les secteurs (Lukunga, Funa, Mont-Amba, Tshangu) se modifient commune par commune.
- On y règle aussi : supplément express, frais d'encaissement, assurance, part du livreur, commission des points relais.

## 5. Mettre en ligne (quand tu seras prêt)

Pour que les livreurs l'utilisent sur leur téléphone partout dans Kinshasa, il faut un **serveur en ligne** (environ 5 à 25 $/mois) et un **nom de domaine**.

- **HTTPS est obligatoire** : sans lui, le téléphone refuse la caméra (scan) et le GPS. On met le site derrière Caddy ou Nginx avec un certificat gratuit (Let's Encrypt).
- Dans `.env` : `PUBLIC_URL=https://ton-domaine`, `COOKIE_SECURE=1`, `SEED_DEMO=0`.
- **Sauvegarde** : toute la base est un seul fichier, `kincolis.db`, dans le volume. Copie-le chaque jour.

Rien n'est mis en ligne et rien n'est payant sans ton accord.

## Mettre en ligne (serveur à environ 6 $/mois)

À faire **depuis un PC**, une seule fois, en 20 minutes environ.

1. **Créer le serveur** : sur DigitalOcean, crée un *Droplet* : Ubuntu 24.04, Basic, 1 Go de RAM (environ 6 $/mois). Garde **l'adresse IP** et le **mot de passe root**.
2. **Envoyer le code** : sur le PC, ouvre un terminal dans le dossier où est le zip, puis tape :
   ```
   scp fenix-delivery.zip root@ADRESSE_IP:
   ssh root@ADRESSE_IP
   ```
3. **Installer** (sur le serveur) :
   ```
   apt-get install -y unzip && unzip fenix-delivery.zip -d fenix && bash fenix/deploy/install.sh
   ```
   À la fin, le script affiche les adresses du site et le **mot de passe admin**.
4. **Ton nom de domaine** (plus tard, facultatif) : fais pointer le domaine vers l'adresse IP, puis relance :
   `bash fenix/deploy/install.sh mondomaine.com`

Sans nom de domaine, le site marche quand même en HTTPS, avec une adresse gratuite du type `164-90-1-2.sslip.io`. Le HTTPS est obligatoire pour le GPS de l'appli livreur.

**Mettre à jour plus tard** : renvoie le nouveau zip, puis tape `unzip -o fenix-delivery.zip -d fenix && bash fenix/deploy/install.sh`. Les données sont gardées.

## 5 bis. Prix calculé pour chaque trajet, payé avant l'envoi

**Le prix** = prise en charge + carburant + temps de trajet. Il n'y a aucun supplément en %.
- Prise en charge : petit 3 000 FC, moyen 4 000 FC, grand 6 000 FC.
- Carburant : distance × 0,03 L/km × prix du litre (2 640 FC au départ).
- Temps : distance ÷ vitesse (30 km/h, ou 18 km/h aux heures de pointe 6-9 h et 16-19 h, sauf le dimanche) × 100 FC la minute.
- La distance part du point GPS, sinon du centre de la commune, puis on applique le détour moyen par la route (× 1,35).
- Tout se règle dans *Back office › Tarifs et réglages*, avec un bouton d'essai.

**Le paiement se fait avant le départ du colis.**
- Moyens : M-Pesa, Airtel Money, Orange Money (avec la référence de la transaction) ou espèces au comptoir.
- Au comptoir, l'agent encaisse : le colis est payé tout de suite.
- En ligne ou par Mobile Money, le colis est « en attente » jusqu'à la confirmation (*Paiements à confirmer*, au back office ou en agence).
- Tant qu'un colis n'est pas payé, aucun livreur ne peut le prendre, le dépôt refuse le scan, et il ne peut pas partir.
- Les commerçants « sur compte » gardent leur facture de la semaine.
- L'argent de la **marchandise** des commerçants s'encaisse toujours à la livraison.
- Les numéros Mobile Money de l'entreprise se règlent dans *Tarifs et réglages*.

La carte « Où sont les colis » du back office aide à envoyer les livreurs au bon endroit. Elle ne change pas le prix.

## 5 ter. Appli mobile « Fenix Livreur » (Android)

L'appli mobile est **la même appli livreur** que `/livreur/`, mise dans une vraie appli Android avec Capacitor. Elle utilise le même serveur, les mêmes comptes et les mêmes colis. La version web continue de marcher.

- **Dans l'appli** : le GPS et le scanner de QR code du téléphone (scanner Google), la photo avec l'appareil photo, et le code à 4 chiffres.
- **Construction automatique** : à chaque changement de `mobile/` ou de `public/livreur/`, GitHub construit l'APK (onglet *Actions*) et le publie dans *Releases*.
- **Lien à envoyer aux livreurs (WhatsApp)** : `https://github.com/persytshimanga6-spec/Fenix-delivery-/releases/latest/download/fenix-livreur.apk`
- **Changer l'adresse du serveur** (par exemple pour passer en HTTPS) : *Actions › Appli Android Fenix Livreur › Run workflow*, puis mettre l'adresse. On peut aussi créer la variable `FENIX_SERVER` dans *Settings › Secrets and variables › Actions › Variables*.
- **Signature** : pour les tests, l'APK est signé avec la clé de test du dépôt (`mobile/android/fenix-test.keystore`). Avant le Play Store, il faut créer une vraie clé et la mettre dans les secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` et `ANDROID_KEY_PASSWORD`.
- **Sur un PC, à la main** : `cd mobile && npm ci && FENIX_SERVER=http://… npm run sync && cd android && ./gradlew assembleRelease`. Il faut Android Studio ou le SDK Android, et Java 21.

## 6. Notifications automatiques (SMS + e-mail)

À chaque étape, le **client** (destinataire) et le **vendeur** (commerçant, ou expéditeur venu au comptoir) sont prévenus :

| Étape | Client | Vendeur |
|---|---|---|
| Envoi créé | n° de suivi + code de livraison | confirmation + prix |
| Ramassé | — | oui |
| En route | « préparez votre code » | oui |
| Disponible en agence | adresse de l'agence | oui |
| Livré / retiré | merci | oui + argent encaissé |
| Échec | raison + nouvelle tentative | oui |
| Retour / annulé | annulé | oui |
| Argent reversé, compte validé | — | oui |

- Le **SMS** part toujours. L'**e-mail** part si l'adresse est connue (champ facultatif dans les formulaires).
- Le commerçant met son e-mail et choisit SMS et/ou e-mail dans **Mon compte**.
- Tout est visible dans *Back office › Notifications* et dans *Mon compte* du commerçant.

**Tant que rien n'est branché, les messages sont seulement enregistrés** (état « Enregistré »). Rien de payant n'est activé.

- **Vrais SMS** : choisis un fournisseur qui couvre la RDC et mets son adresse dans `SMS_WEBHOOK_URL`. Le système envoie `{"to": "...", "message": "..."}`. Si le fournisseur attend un autre format, il faut un petit adaptateur.
- **Vrais e-mails** : remplis `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. Exemple Gmail : `smtp.gmail.com`, port `465`, ton adresse Gmail et un **mot de passe d'application** (Compte Google › Sécurité › Validation en 2 étapes › Mots de passe des applications). Gmail suffit pour commencer (limite d'environ 500 e-mails par jour).

## 7. Appli livreur

- Sur Android, ouvre `/livreur/` dans Chrome, puis menu › **Ajouter à l'écran d'accueil** : elle s'ouvre comme une appli.
- Avec un réseau faible, le ramassage, le départ et les échecs sont gardés sur le téléphone et envoyés au retour du réseau. La **livraison** demande le réseau, parce que le code du client est vérifié par le serveur.

## 8. Vérifier que tout marche

```
npm install
npm test
```

Le test fait tout le parcours sur une base temporaire : inscription, envoi, ramassage, tri, livraison, échec, comptoir, point relais, ventes, stock, caisse, reversements, tarifs.

## Technique

Node.js 22, Express, SQLite (`better-sqlite3`), cartes OpenStreetMap (Leaflet), scan QR (`html5-qrcode`). Aucun service payant. Mots de passe chiffrés (bcrypt), connexion par cookie sécurisé, droits par rôle (admin, agent, livreur, commerçant), codes de livraison stockés chiffrés.

```
src/server.js        routes publiques, commerçant, étiquette
src/routes/driver.js appli livreur
src/routes/agency.js caisse d'agence
src/routes/admin.js  back office
src/shipments.js     création, statuts, remise, échec, suivi
src/logic.js         prix, zones, codes
src/notify.js        notifications SMS + e-mail (client et vendeur)
src/db.js            base de données
src/seed.js          communes, tarifs, démo
public/              les pages web
test/e2e.js          test complet
```
