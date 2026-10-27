#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# Importa los proveedores del Excel de SAP al portal (desde Cloud Shell).
#
# 1. En https://shell.cloud.google.com: menú ⋮ → "Subir" → elige el Excel de SAP.
# 2. Pega (cambia el nombre del archivo si es otro):
#    bash <(curl -fsSL https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/scripts/importar-proveedores.sh) ID_PROYECTO ~/proveedores.xlsx
#
# Muestra un resumen (cuántos se crean, cuántos ya estaban, cuántos se omiten)
# y pregunta antes de crear nada. Opciones al final: --todos-activos (todos
# quedan activos aunque en SAP estén inactivos) y --si (no preguntar).
# Se puede volver a correr cada mes con el Excel nuevo: solo crea los nuevos.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

P="${1:-}"; F="${2:-}"
shift 2 2>/dev/null || true
case "$P" in
  "") echo "⛔ Uso: … importar-proveedores.sh ID_PROYECTO archivo.xlsx [--todos-activos] [--si]"; exit 1 ;;
  leitime) echo "⛔ leitime es el proyecto de la suite A-B-Swiss: este portal va en su propio proyecto."; exit 1 ;;
esac
[ -f "$F" ] || { echo "⛔ No encuentro el archivo \"$F\". Súbelo con el menú ⋮ → Subir (queda en tu carpeta ~)."; ls -1 ~/*.xlsx 2>/dev/null | sed 's/^/   encontrado: /'; exit 1; }

DIR=/tmp/portal-importar
mkdir -p "$DIR"
[ -d "$DIR/node_modules/exceljs" ] || (cd "$DIR" && npm init -y >/dev/null && npm i exceljs@4 --silent --no-fund --no-audit)
curl -fsSL https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/scripts/importar-proveedores-sap.mjs -o "$DIR/importar.mjs"

TOKEN=$(gcloud auth print-access-token) node "$DIR/importar.mjs" "$P" "$F" "$@"
