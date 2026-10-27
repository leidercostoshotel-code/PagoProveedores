#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# Despliegue del Portal de Proveedores desde Google Cloud Shell
# (https://shell.cloud.google.com, con la cuenta dueña del proyecto).
#
# Uso (una sola línea):
#   bash <(curl -fsSL https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/scripts/desplegar-cloudshell.sh) ID_PROYECTO [partes]
#
# ID_PROYECTO es el ID del proyecto de FIREBASE (Consola de Firebase →
# Configuración del proyecto → "ID del proyecto"), no el nombre del repositorio.
#
# Partes: hosting · reglas (Firestore: reglas e índices) · functions (plan Blaze)
# Sin partes = hosting + reglas.
#
# No toca otros proyectos: todo va con --project, no cambia el proyecto por
# defecto de gcloud/firebase, no escribe .firebaserc y trabaja en carpetas
# propias de /tmp (distintas a las de A-B-Swiss). Se niega a correr con leitime.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

P="${1:-}"
shift || true
PARTES="${*:-hosting reglas}"

case "$P" in
  "") echo "⛔ Falta el ID del proyecto: … desplegar-cloudshell.sh ID_PROYECTO [hosting reglas functions]"; exit 1 ;;
  leitime) echo "⛔ leitime es el proyecto de la suite A-B-Swiss: este portal va en su propio proyecto."; exit 1 ;;
esac
for parte in $PARTES; do
  case "$parte" in hosting|reglas|functions) ;; *) echo "⛔ Parte desconocida: $parte (usa hosting, reglas o functions)"; exit 1 ;; esac
done
echo "▶ Proyecto: $P · Partes: $PARTES"

# Código fresco de main (el repositorio es público: no hace falta sesión de GitHub).
DIR=/tmp/portal-proveedores
rm -rf "$DIR"
git clone -q --depth 1 https://github.com/leidercostoshotel-code/PagoProveedores.git "$DIR"
cd "$DIR"

# Firebase CLI propio del portal.
CLI=/tmp/firebase-cli-portal
[ -x "$CLI/node_modules/.bin/firebase" ] || npm i --prefix "$CLI" firebase-tools --silent --no-fund --no-audit
FB="$CLI/node_modules/.bin/firebase"
$FB projects:list >/dev/null 2>&1 || $FB login --no-localhost

# Configuración web de Firebase en public/js/config.js (se saca del propio proyecto).
if [[ " $PARTES " == *" hosting "* ]]; then
  APP=$($FB apps:list WEB --project "$P" --json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).result||[];console.log(r[0]?r[0].appId:"")')
  if [ -z "$APP" ]; then
    APP=$($FB apps:create WEB "Portal Proveedores" --project "$P" --json | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).result.appId)')
  fi
  $FB apps:sdkconfig WEB "$APP" --project "$P" --json | node -e '
    const fs = require("fs"), c = JSON.parse(fs.readFileSync(0, "utf8")).result.sdkConfig, f = "public/js/config.js";
    let s = fs.readFileSync(f, "utf8");
    const m = { TU_API_KEY: c.apiKey, TU_AUTH_DOMAIN: c.authDomain, TU_PROJECT_ID: c.projectId, TU_STORAGE_BUCKET: c.storageBucket || "",
      TU_MESSAGING_SENDER_ID: c.messagingSenderId || "", TU_APP_ID: c.appId };
    for (const [k, v] of Object.entries(m)) s = s.replace(`"${k}"`, JSON.stringify(v));
    fs.writeFileSync(f, s);
    console.log("✅ Configuración web puesta para", c.projectId);'
fi

# Firestore: se crea la base solo si todavía no existe (la región no se puede cambiar después).
if [[ " $PARTES " == *" reglas "* ]]; then
  gcloud firestore databases describe --database="(default)" --project="$P" >/dev/null 2>&1 \
    || gcloud firestore databases create --location=southamerica-east1 --project="$P"
fi

SOLO=""
[[ " $PARTES " == *" hosting "* ]] && SOLO="hosting"
[[ " $PARTES " == *" reglas "* ]] && SOLO="${SOLO:+$SOLO,}firestore"
if [ -n "$SOLO" ]; then
  $FB deploy --only "$SOLO" --project "$P" --non-interactive
fi

if [[ " $PARTES " == *" functions "* ]]; then
  (cd functions && npm install --omit=dev --silent --no-fund --no-audit)
  $FB deploy --only functions --project "$P" --non-interactive --force
fi

echo "✅ Listo: https://$P.web.app"
