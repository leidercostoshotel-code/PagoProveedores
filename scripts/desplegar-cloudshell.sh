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
#         sunat (pide las credenciales de API de SUNAT y las guarda como secretos; plan Blaze)
#         llave-respaldo (cuenta de SOLO LECTURA y su llave para el respaldo en el servidor del hotel)
#         copias (copias de seguridad diarias de Firestore dentro de Google, 14 semanas; plan Blaze)
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
  "") echo "⛔ Falta el ID del proyecto: … desplegar-cloudshell.sh ID_PROYECTO [hosting reglas functions sunat]"; exit 1 ;;
  leitime) echo "⛔ leitime es el proyecto de la suite A-B-Swiss: este portal va en su propio proyecto."; exit 1 ;;
esac
for parte in $PARTES; do
  case "$parte" in hosting|reglas|functions|sunat|llave-respaldo|copias) ;; *) echo "⛔ Parte desconocida: $parte (usa hosting, reglas, functions, sunat, llave-respaldo o copias)"; exit 1 ;; esac
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

# Credenciales de API de SUNAT (SUNAT Operaciones en Línea → Credenciales de API SUNAT) como secretos de
# Firebase: se escriben sin verse en pantalla y van por la entrada estándar (no quedan en disco ni en el historial).
if [[ " $PARTES " == *" sunat "* ]]; then
  read -rp  "ID de la API de SUNAT (client_id): " SUNAT_ID
  read -rsp "Clave de la API de SUNAT (client_secret, no se ve al escribir): " SUNAT_CLAVE; echo
  [ -n "$SUNAT_ID" ] && [ -n "$SUNAT_CLAVE" ] || { echo "⛔ Faltan el ID o la clave."; exit 1; }
  printf %s "$SUNAT_ID" | $FB functions:secrets:set SUNAT_CLIENT_ID --project "$P" --data-file - --force
  printf %s "$SUNAT_CLAVE" | $FB functions:secrets:set SUNAT_CLIENT_SECRET --project "$P" --data-file - --force
  unset SUNAT_ID SUNAT_CLAVE
  echo "✅ Credenciales de SUNAT guardadas (si las Cloud Functions ya estaban publicadas, vuelve a publicar 'functions')."
fi

# Llave de SOLO LECTURA para el respaldo en el servidor del hotel (respaldo-windows/instalar.ps1).
# Rol "Cloud Datastore Viewer": puede leer la base pero no cambiar ni borrar nada.
if [[ " $PARTES " == *" llave-respaldo "* ]]; then
  SA="respaldo-servidor@$P.iam.gserviceaccount.com"
  gcloud services enable iam.googleapis.com --project "$P" >/dev/null
  gcloud iam service-accounts describe "$SA" --project "$P" >/dev/null 2>&1 \
    || gcloud iam service-accounts create respaldo-servidor --project "$P" --display-name "Respaldo en el servidor del hotel (solo lectura)"
  # Una cuenta recién creada tarda unos segundos en "existir" para los permisos: se reintenta.
  reintentar() { for i in 1 2 3 4 5 6 7 8 9 10 11 12; do "$@" && return 0; echo "   …esperando a que Google registre la cuenta ($i/12)" >&2; sleep 10; done; return 1; }
  reintentar gcloud projects add-iam-policy-binding "$P" --member "serviceAccount:$SA" --role roles/datastore.viewer --condition=None --quiet >/dev/null \
    || { echo "⛔ No se pudo dar el permiso de lectura a $SA."; exit 1; }
  echo "✅ Permiso de solo lectura (Cloud Datastore Viewer) dado a $SA"
  LL="$HOME/llave-respaldo-portal.json"
  reintentar gcloud iam service-accounts keys create "$LL" --iam-account "$SA" --project "$P" \
    || { echo "⛔ No se pudo crear la llave."; exit 1; }
  echo "✅ Llave de solo lectura creada: $LL"
  cloudshell download "$LL" 2>/dev/null || echo "   Descárgala con el menú ⋮ de Cloud Shell → Descargar → $LL"
  echo "   Cuando ya esté en el servidor, bórrala de Cloud Shell:  rm $LL"
fi

# Copias de seguridad de Firestore dentro de Google (diarias, se guardan 14 semanas). Plan Blaze.
if [[ " $PARTES " == *" copias "* ]]; then
  if gcloud firestore backups schedules list --database="(default)" --project "$P" --format="value(name)" 2>/dev/null | grep -q .; then
    echo "✅ Ya hay copias de seguridad programadas:"
    gcloud firestore backups schedules list --database="(default)" --project "$P"
  else
    gcloud firestore backups schedules create --database="(default)" --recurrence=daily --retention=14w --project "$P"
    echo "✅ Copias de seguridad diarias de Firestore programadas (se guardan 14 semanas)."
  fi
fi

if [[ " $PARTES " == *" functions "* ]]; then
  (cd functions && npm install --omit=dev --silent --no-fund --no-audit)
  $FB deploy --only functions --project "$P" --non-interactive --force
fi

echo "✅ Listo: https://$P.web.app"
