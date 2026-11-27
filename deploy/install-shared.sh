#!/usr/bin/env bash
# Installe Fenix Delivery À CÔTÉ d'un autre site (ex. ProMarket), sans le toucher.
# - dossier /opt/fenix, projet docker « fenix », réseau et volume à part
# - port public 8081 (ou FENIX_PORT=xxxx), jamais 80/443/3000/5432/6379
# - aucune modification de nginx, des autres conteneurs ou de leurs fichiers
set -eu  # pas de pipefail : « tr … | head -c » se termine normalement par SIGPIPE (141)
PORT="${FENIX_PORT:-8081}"
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
COMPOSE="docker compose -f deploy/docker-compose.shared.yml"

echo "== 1/6 Vérifications (lecture seule)"
case " 80 443 3000 5432 6379 " in *" $PORT "*) echo "STOP : le port $PORT est réservé."; exit 1;; esac
[ "$APP_DIR" = "/opt/fenix" ] || { echo "STOP : le code doit être dans /opt/fenix (il est dans $APP_DIR)."; exit 1; }
command -v docker >/dev/null || { echo "STOP : Docker n'est pas installé."; exit 1; }
if ss -tln | grep -q ":$PORT "; then
  if ! docker ps --format '{{.Names}}' | grep -qx fenix-delivery; then echo "STOP : le port $PORT est déjà utilisé."; exit 1; fi
fi
FREE_MB=$(free -m | awk '/^Mem:/{print $7}')
[ "$FREE_MB" -gt 400 ] || { echo "STOP : pas assez de mémoire libre ($FREE_MB Mo)."; exit 1; }
echo "   Port $PORT libre, mémoire libre $FREE_MB Mo : OK"

echo "== 2/6 Photo de l'état actuel (sauvegarde)"
mkdir -p /root/fenix-sauvegardes
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' > "/root/fenix-sauvegardes/conteneurs-avant-$STAMP.txt"
OTHERS_BEFORE=$(docker ps --format '{{.Names}}' | { grep -vx fenix-delivery || true; } | sort)
if docker volume inspect fenix_fenix-data >/dev/null 2>&1; then
  docker run --rm -v fenix_fenix-data:/d -v /root/fenix-sauvegardes:/b alpine tar czf "/b/fenix-data-$STAMP.tgz" -C /d . && echo "   Données Fenix sauvegardées"
fi
echo "   État enregistré dans /root/fenix-sauvegardes/"

echo "== 3/6 Réglages Fenix (.env, dans /opt/fenix seulement)"
IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
if [ ! -f .env ] || ! grep -q '^JWT_SECRET=' .env; then
  [ -f .env ] || cp .env.example .env
  PASS=$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2)
  if [ -z "$PASS" ] || [ "$PASS" = "change-moi-tout-de-suite" ] || [ "$PASS" = "CHANGE-MOI" ]; then PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12); fi
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PASS|; s|^SEED_DEMO=.*|SEED_DEMO=0|" .env
  echo "JWT_SECRET=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)" >> .env
  echo "$PASS" > .admin-password
fi
# Adresse publique : on garde une adresse HTTPS déjà réglée ; sinon http://IP:PORT (installation de départ).
CUR_URL=$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)
case "$CUR_URL" in
  https://*) echo "   Adresse publique gardée : $CUR_URL" ;;
  *) sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=http://$IP:$PORT|" .env; CUR_URL="http://$IP:$PORT" ;;
esac
# En HTTPS, le cookie de connexion est toujours « secure » (jamais remis à 0 par ce script).
case "$CUR_URL" in
  https://*) if grep -q '^COOKIE_SECURE=' .env; then sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=1|" .env; else echo "COOKIE_SECURE=1" >> .env; fi ;;
esac
grep -q '^NODE_ENV=' .env || echo "NODE_ENV=production" >> .env
chmod 600 .env; [ -f .admin-password ] && chmod 600 .admin-password

echo "== 4/6 Construction et démarrage (projet « fenix » uniquement)"
FENIX_PORT=$PORT $COMPOSE up -d --build

echo "== 5/6 Vérification de Fenix"
OK=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done
[ $OK = 1 ] && echo "   Fenix répond sur le port $PORT : OK" || { echo "   Fenix ne répond pas. Journal :"; $COMPOSE logs --tail 40; exit 1; }

echo "== 6/6 Vérification que les autres sites n'ont pas bougé"
OTHERS_AFTER=$(docker ps --format '{{.Names}}' | { grep -vx fenix-delivery || true; } | sort)
if [ "$OTHERS_BEFORE" = "$OTHERS_AFTER" ]; then echo "   Autres conteneurs toujours en marche : OK"; else
  echo "   ATTENTION : la liste des autres conteneurs a changé !"; echo "Avant :"; echo "$OTHERS_BEFORE"; echo "Après :"; echo "$OTHERS_AFTER"; fi
docker ps --format '{{.Names}}\t{{.Status}}' > "/root/fenix-sauvegardes/conteneurs-apres-$STAMP.txt"

echo "   Port $PORT lié à 127.0.0.1 et au réseau Docker seulement (pas ouvert sur Internet)."

echo
echo "================ FENIX EST EN LIGNE ================"
echo " Site web      : $CUR_URL"
echo " Commerçants   : $CUR_URL/commercant/"
echo " Back office   : $CUR_URL/admin/"
echo " Agences       : $CUR_URL/agence/"
echo " Appli livreur : $CUR_URL/livreur/"
[ -f .admin-password ] && echo " Mot de passe admin du premier démarrage : dans /opt/fenix/.admin-password (à changer, puis supprimer ce fichier)"
echo " Arrêter Fenix (sans perdre les données) :  cd /opt/fenix && $COMPOSE down"
echo "===================================================="
