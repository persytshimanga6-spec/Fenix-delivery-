# Fenix Livreur (appli Android)

L'appli est l'appli livreur du site (`/livreur/`), affichée dans une vraie appli Android avec Capacitor.
Elle utilise le même serveur, les mêmes comptes et les mêmes colis.

## Adresse du serveur

- **HTTPS obligatoire.** L'adresse par défaut est `https://fenix.promarketmalchena.com`.
- `npm run sync` refuse une adresse `http://`. Seule exception : `http://localhost` pour les essais sur un PC.
- Pour changer l'adresse, va dans *GitHub › Actions › Appli Android Fenix Livreur › Run workflow* et mets la nouvelle adresse. On peut aussi créer la variable `FENIX_SERVER`.

## Clé de signature

**La clé n'est jamais dans le dépôt.** GitHub la lit dans 4 secrets (*Settings › Secrets and variables › Actions*) :

| Secret | Contenu |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | le fichier de la clé (`.p12`) encodé en base64, sur une seule ligne |
| `ANDROID_KEYSTORE_PASSWORD` | mot de passe du fichier |
| `ANDROID_KEY_ALIAS` | nom de la clé (ex. `fenix-livreur`) |
| `ANDROID_KEY_PASSWORD` | mot de passe de la clé (le même que celui du fichier, pour une clé PKCS12) |

Sans ces secrets, le build s'arrête avec un message clair. Aucun APK n'est signé avec une clé par défaut.

### Créer une clé (une seule fois, sur un PC qui a Java)

```
keytool -genkeypair -keystore fenix-livreur.p12 -storetype PKCS12 \
  -alias fenix-livreur -keyalg EC -groupname secp256r1 -sigalg SHA256withECDSA \
  -validity 10000 -dname "CN=Fenix Livreur, O=Fenix Delivery, C=CD"
base64 -w0 fenix-livreur.p12      # ce texte va dans ANDROID_KEYSTORE_BASE64
```

- **Garde le fichier `.p12` et son mot de passe en lieu sûr**, hors du dépôt. Si la clé est perdue, les livreurs devront désinstaller l'appli avant d'installer la version suivante.
- **Pour le Play Store**, crée une **autre** clé (clé d'envoi, avec Play App Signing). Ne réutilise jamais la clé des APK de test.
- L'ancienne clé de test (`fenix-test.keystore`) a été publiée dans le dépôt : **elle ne doit plus jamais servir.**

## Construire sur un PC

```
cd mobile && npm ci
FENIX_SERVER=https://fenix.promarketmalchena.com npm run sync
cd android
export ANDROID_KEYSTORE_FILE=/chemin/fenix-livreur.p12 ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=fenix-livreur ANDROID_KEY_PASSWORD=…
./gradlew assembleRelease
```
