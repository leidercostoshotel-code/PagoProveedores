# Portal de Proveedores — contexto para Claude Code

Sistema de consulta de pagos para proveedores de un hotel en Lima (Swissôtel). Elimina las consultas
manuales a Contabilidad: el proveedor entra con su RUC y clave y ve sus facturas pagadas. El personal
del hotel administra todo desde el mismo portal. Login y estilo copiados de la suite A-B-Swiss
(`leidercostoshotel-code/A-B-Swiss`: `vencimientos/src/sistema-vencimientos.jsx` → `PantallaLogin`,
`src/firebase.js` → `login()`, `functions/index.js` → bloqueo por intentos).

## Estructura
- `public/index.html` — **mínimo (pedido del dueño: máximo ~20 líneas)**. No meter marcado ahí:
  las pantallas viven en `public/js/plantillas.js`.
- `public/css/estilos.css` — todos los estilos (paleta de la suite: tinta #0B1F3A, cinta #FFDC3D, papel #EDF1F6).
- `public/js/config.js` — configuración de Firebase (placeholders `TU_...` que reemplaza el workflow con los secrets), dominio de proveedores, correo de Contabilidad, minutos de inactividad.
- `public/js/firebase.js` — Auth/Firestore/Functions: `login()` con bloqueo, `cambiarPassword()`, `crearUsuario()` (segunda instancia de Auth), `restablecerClave()`.
- `public/js/app.js` — flujo de pantallas: carga → ingreso → perfil → cambio de clave obligatorio → app por rol; inactividad.
- `public/js/vista-proveedor.js` / `vista-admin.js` — pestañas; cada una exporta `pestanas(rol)` y `montar(id, contenedor, ctx)` (devuelve función de limpieza).
- `public/js/bcp.js` — lector del TXT Telecrédito BCP + CSV SAP en el navegador. **Mismas posiciones que `scripts/cargar-pagos-bcp.js`.**
- `public/js/util.js` — íconos SVG, formato, modales, CSV, mensajes de error. `roles.js` — roles.
- `functions/index.js` — `verificarBloqueoLogin`, `registrarIntentoFallido`, `limpiarIntentosLogin`, `restablecerClave` (plan Blaze, opcionales).
- `firestore.rules` — roles con perfil en `usuarios/{uid}`; proveedor solo lee `pagos` con su `ruc`.
- `pruebas/reglas.mjs` — 46 pruebas de seguridad de las reglas (lo que intentaría alguien con F12 en cada rol);
  `npm install && npm run probar:reglas` (emulador, necesita Java). **Correrlas tras tocar `firestore.rules`.**
- `firebase.json` — cabeceras de seguridad (CSP: scripts solo propios y de gstatic, datos solo a Google;
  sin iframes ajenos; HSTS). Un script o servicio externo nuevo hay que sumarlo a la CSP.
- `scripts/importar-proveedores.sh` + `scripts/importar-proveedores-sap.mjs` — importa el Excel de SAP
  (Socios de negocios: C nombre, Y RUC, D clase, EV activo, FX borrado, BF correo, K teléfono) desde Cloud
  Shell: crea cuenta `prov-<RUC>` (clave = RUC) y perfil, solo proveedores (clase S) nuevos con RUC válido;
  activo = activo en SAP. Desde el navegador NO se pueden crear miles (Firebase limita ~100 altas/hora
  por IP), por eso va por el API de administrador con `gcloud auth print-access-token`. Re-ejecutable.
- `scripts/desplegar-cloudshell.sh` — despliegue desde Google Cloud Shell (una línea; nunca con `leitime`).
- `.github/workflows/firebase-deploy.yml` — despliega Hosting, Firestore y Functions con secrets `FIREBASE_*`.

## Modelo de datos
- `usuarios/{uid}`: rol (admin|contabilidad|consulta|proveedor), activo, nombre, email, ruc y razonSocial
  (proveedor), contacto, telefono, debeCambiarClave, ultimoIngreso, creadoPor/creadoEn.
- `pagos/{RUC_FACTURA_AAAAMMDD}`: ruc, razonSocial, factura, fechaPago (YYYY-MM-DD), banco, cuentaAbono,
  bruto, retencion, detraccion, notaCredito, neto, lote, cargadoEn (quién cargó va solo en `lotes`: el
  proveedor puede ver su documento completo con F12).
- `lotes/{lote}`: lote, banco, fechaPago, facturas, proveedores, total, archivoTxt, archivoCsv, cargadoPor, cargadoEn.
- `intentos_login/{email}`: solo Cloud Functions.

## Autenticación
Email/password en Firebase Auth. Proveedor = correo sintético `<RUC>@proveedores.hotel` (en el login
basta escribir el RUC). **Proveedores (pedido del dueño, 2026-10-27): clave por defecto = su mismo RUC
y SIN cambio de clave obligatorio** (`debeCambiarClave: false`; `decidir()` en app.js lo ignora para el
rol proveedor; el panel acepta el RUC como clave aunque no cumpla la política). Se le advirtió que el
RUC es público. El personal del hotel sí: clave inicial al azar y `debeCambiarClave: true`. El primer
admin se crea a mano en la consola (ver README).

## Pendientes conocidos
- Ajustar posiciones de ancho fijo del TXT (en `public/js/bcp.js` y en el script) con un TXT real.
- Posible soporte futuro para TXT de Interbank y BBVA.

## Flujo de trabajo (pedido del dueño)
- **Claude crea el PR y lo fusiona él mismo en GitHub** al terminar cada cambio (no esperar a que el dueño haga clic).
- Al terminar, darle al dueño el comando de Cloud Shell para publicar:
  `bash <(curl -fsSL https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/scripts/desplegar-cloudshell.sh) ID_PROYECTO [hosting reglas functions]`
  (GitHub Actions falla mientras la cuenta de servicio no tenga los roles; ver el workflow).

## Paginación obligatoria (pedido del dueño)
**Toda lista del portal va paginada** (25/50/100 por página, se recuerda por lista): `paginador()` y
`htmlPagina()` en util.js para listas ya cargadas (Pagos, Lotes, Usuarios, vista previa del lote, Mis
pagos, Resumen por mes). **Proveedores pagina en el servidor** (puede haber miles): `orderBy` + `limit`
+ `startAfter` y el total con `getCountFromServer`; búsqueda por cómo empieza el RUC o la razón social
(en MAYÚSCULAS). Usa los índices de `firestore.indexes.json` (rol + razonSocial/ruc, con y sin activo).
Nunca leer la colección `usuarios` entera desde el panel (la vista previa del lote consulta solo los
RUC del lote, de 30 en 30). Una tabla nueva lleva su paginador desde el día uno.

## Convenciones
- Código y comentarios en español. Sin frameworks en el frontend (HTML + CSS + JS módulos).
- Todo dato externo se escapa con `esc()` antes de ir a `innerHTML`.
- No subir `serviceAccount.json`, `.firebaserc`, TXT ni CSV reales al repositorio.
