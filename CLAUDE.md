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
- `scripts/desplegar-cloudshell.sh` — despliegue desde Google Cloud Shell (una línea; nunca con `leitime`).
- `.github/workflows/firebase-deploy.yml` — despliega Hosting, Firestore y Functions con secrets `FIREBASE_*`.

## Modelo de datos
- `usuarios/{uid}`: rol (admin|contabilidad|consulta|proveedor), activo, nombre, email, ruc y razonSocial
  (proveedor), contacto, telefono, debeCambiarClave, ultimoIngreso, creadoPor/creadoEn.
- `pagos/{RUC_FACTURA_AAAAMMDD}`: ruc, razonSocial, factura, fechaPago (YYYY-MM-DD), banco, cuentaAbono,
  bruto, retencion, detraccion, notaCredito, neto, lote, cargadoEn, cargadoPor.
- `lotes/{lote}`: lote, banco, fechaPago, facturas, proveedores, total, archivoTxt, archivoCsv, cargadoPor, cargadoEn.
- `intentos_login/{email}`: solo Cloud Functions.

## Autenticación
Email/password en Firebase Auth. Proveedor = correo sintético `<RUC>@proveedores.hotel` (en el login
basta escribir el RUC). Las cuentas se crean desde Administración con clave inicial y
`debeCambiarClave: true`. El primer admin se crea a mano en la consola (ver README).

## Pendientes conocidos
- Ajustar posiciones de ancho fijo del TXT (en `public/js/bcp.js` y en el script) con un TXT real.
- Posible soporte futuro para TXT de Interbank y BBVA.

## Flujo de trabajo (pedido del dueño)
- **Claude crea el PR y lo fusiona él mismo en GitHub** al terminar cada cambio (no esperar a que el dueño haga clic).
- Al terminar, darle al dueño el comando de Cloud Shell para publicar:
  `bash <(curl -fsSL https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/scripts/desplegar-cloudshell.sh) ID_PROYECTO [hosting reglas functions]`
  (GitHub Actions falla mientras la cuenta de servicio no tenga los roles; ver el workflow).

## Convenciones
- Código y comentarios en español. Sin frameworks en el frontend (HTML + CSS + JS módulos).
- Todo dato externo se escapa con `esc()` antes de ir a `innerHTML`.
- No subir `serviceAccount.json`, `.firebaserc`, TXT ni CSV reales al repositorio.
