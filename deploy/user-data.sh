#!/bin/bash
# À coller dans DigitalOcean › Create Droplet › Advanced Options › « Add Initialization scripts (user data) ».
# Le serveur s'installe tout seul au démarrage (environ 5 minutes). Aucun PC nécessaire.
ADMIN_PASSWORD="CHANGE-MOI"          # ← mets ton mot de passe admin ici
REPO="https://github.com/TON-COMPTE/fenix-delivery.git"

apt-get update -y && apt-get install -y git
git clone "$REPO" /opt/fenix
cd /opt/fenix
cp .env.example .env
sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PASSWORD|" .env
bash deploy/install.sh > /var/log/fenix-install.log 2>&1
