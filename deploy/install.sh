#!/usr/bin/env bash
# Installe Fenix Delivery sur un serveur Ubuntu neuf (DigitalOcean, Hetzner…), avec HTTPS.
# Usage (sur le serveur, en root) :  bash install.sh            → adresse gratuite xx-xx-xx-xx.sslip.io
#                                    bash install.sh mondomaine.com  → ton propre nom de domaine
set -eu  # pas de pipefail : « tr … | head -c » se termine normalement par SIGPIPE (141)
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
DOMAIN="${1:-}"

echo "== 1/5 Installation de Docker"
if ! command -v docker >/dev/null; then
  apt-get update -y && apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi

echo "== 2/5 Pare-feu (SSH, HTTP, HTTPS)"
if command -v ufw >/dev/null; then ufw allow OpenSSH >/dev/null; ufw allow 80 >/dev/null; ufw allow 443 >/dev/null; ufw --force enable >/dev/null; fi

echo "== 3/5 Adresse du site"
if [ -z "$DOMAIN" ]; then
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  DOMAIN="${IP//./-}.sslip.io"
fi
echo "   Site : https://$DOMAIN"

echo "== 4/5 Réglages (.env)"
if [ ! -f .env ] || ! grep -q '^JWT_SECRET=' .env; then
  [ -f .env ] || cp .env.example .env
  PASS=$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2)
  if [ -z "$PASS" ] || [ "$PASS" = "change-moi-tout-de-suite" ] || [ "$PASS" = "CHANGE-MOI" ]; then PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12); fi
  SECRET=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PASS|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|; s|^SEED_DEMO=.*|SEED_DEMO=0|; s|^COOKIE_SECURE=.*|COOKIE_SECURE=1|" .env
  echo "JWT_SECRET=$SECRET" >> .env
  echo "$PASS" > .admin-password
  chmod 600 .env .admin-password
else
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" .env
fi
printf '%s {\n  encode gzip\n  reverse_proxy fenix-delivery:3000\n}\n' "$DOMAIN" > deploy/Caddyfile

echo "== 5/5 Démarrage"
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build

echo
echo "================ C'EST EN LIGNE ================"
echo " Site web      : https://$DOMAIN"
echo " Commerçants   : https://$DOMAIN/commercant/"
echo " Appli livreur : https://$DOMAIN/livreur/   (Safari/Chrome › Ajouter à l'écran d'accueil)"
echo " Back office   : https://$DOMAIN/admin/"
echo " Agences       : https://$DOMAIN/agence/"
echo " Connexion admin : $(grep ^ADMIN_PHONE .env | cut -d= -f2)  /  mot de passe : $(cat .admin-password 2>/dev/null || echo 'celui du fichier .env')"
echo " → Change le mot de passe tout de suite dans le back office."
echo "================================================="
