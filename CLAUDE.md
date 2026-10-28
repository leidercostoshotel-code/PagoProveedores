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
  `.pantalla-fondo` (ingreso) es `position: fixed` con su propio scroll: en el celular no se mueve al
  ocultarse la barra del navegador ni con el teclado; en pantallas táctiles las casillas van a 16 px (con
  menos el iPhone hace zoom al tocarlas). No volver a `min-height: 100vh` ahí.
  **Celular (≤ 640 px):** el encabezado no es fijo y las pestañas se deslizan de lado; toda `.tabla-caja` se
  ve como tarjetas (una por fila, cada dato con su título): `etiquetarTablas()` en app.js pone `data-etq` a
  cada celda con el título de su columna (y oculta las que dicen "—"), así una tabla nueva no necesita nada.
- `public/js/config.js` — configuración de Firebase (placeholders `TU_...` que reemplaza el workflow con los secrets), dominio de proveedores, correo de Contabilidad, minutos de inactividad.
- `public/js/firebase.js` — Auth/Firestore/Functions: `login()` con bloqueo, `cambiarPassword()`, `crearUsuario()` (segunda instancia de Auth), `restablecerClave()`.
- `public/js/app.js` — flujo de pantallas: carga → ingreso → perfil → cambio de clave obligatorio → app por rol;
  cierre de sesión automático: tras `MINUTOS_INACTIVIDAD` (15) sin actividad, con aviso "¿Sigues ahí?" y cuenta
  regresiva `SEGUNDOS_AVISO_CIERRE` (60) antes, y cada `HORAS_SESION_MAXIMA` (8) aunque se use (config.js).
  Se revisa con la hora real cada segundo y al volver a la pestaña (cierra tras suspender la PC); la hora de
  ingreso va en sessionStorage, así recargar no reinicia el tope.
- `public/js/vista-proveedor.js` / `vista-admin.js` — pestañas; cada una exporta `pestanas(rol)` y `montar(id, contenedor, ctx)` (devuelve función de limpieza).
- `public/js/bcp.js` — lector del TXT Telecrédito BCP "Pago a Proveedores" (formato REAL, tomado de
  `BCP_102026_01_20261015101650.txt`): encabezado `#1` (cuenta 5-24, moneda 25-26, total 27-41 con 2 dec.,
  fecha DDMMAAAA 42-49, cantidad 85-90) y una línea ` 2` por comprobante (tipo cuenta 3, cuenta 4-23, nombre
  24-63, moneda 64-65, importe 66-80, tipo doc 81-83, RUC 84-95, comprobante 96-106 p. ej. F00046937).
  `integro` = total y cantidad del encabezado cuadran con el detalle (si no, el TXT queda "Revisar"). Cruza
  con el CSV de SAP por factura exacta o por RUC + número sin serie ("F001-46937" ↔ "F00046937").
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
  bruto, retencion, detraccion, notaCredito, neto, moneda (PEN|USD; sin campo = PEN), lote, cargadoEn (quién cargó va solo en `lotes`: el
  proveedor puede ver su documento completo con F12).
- `lotes/{lote}`: lote, banco, fechaPago, facturas, proveedores, total, archivoTxt, hashTxt (SHA-256 del TXT),
  resumenProveedores [{ruc, razonSocial, facturas, total}] (Lotes → "Proveedores"; un lote viejo sin él se
  arma con sus pagos al abrirlo), moneda (la del encabezado del TXT), cargadoPor, cargadoEn.
- **Montos con su moneda:** `monto(n, moneda)` (util.js) pone "S/" o "USD"; los totales usan `monedaComun()`
  de las filas de la página (si hay soles y dólares juntos, van sin símbolo y con un aviso).

## Carga de TXT sin duplicar (carpeta completa)
"Cargar lotes" acepta una carpeta (input `webkitdirectory` o arrastrarla; entra en subcarpetas) o varios
TXT + CSV a la vez (los CSV se juntan en un solo mapa de descuentos). No se duplica nunca:
1. Cada pago tiene id `RUC_FACTURA_AAAAMMDD` y se guarda con `merge` → volver a cargarlo lo actualiza.
2. Cada lote guarda `hashTxt`: un TXT con la misma huella (aunque tenga otro nombre) sale "Ya cargado ·
   se omite"; uno con el mismo id de lote pero otro contenido, "Ya cargado · cambió" (se actualiza); copias
   dentro de la misma selección, "Repetido". Solo se marcan para cargar los nuevos y los que cambiaron.
   Lotes viejos sin `hashTxt` se comparan por facturas + total.
3. **Se guarda solo (pedido del dueño):** apenas se elige o se suelta la carpeta, los nuevos y los que
   cambiaron se guardan sin botón ni confirmación (avance archivo por archivo; si uno falla, para y queda
   "Cargar marcados" para reintentar). Un TXT sin facturas o sin fecha de abono NO se guarda solo:
   queda "Revisar" y se puede marcar y cargar a mano.
- `intentos_login/{email}`: solo Cloud Functions.

## Autenticación
Email/password en Firebase Auth. Proveedor = correo sintético `<RUC>@proveedores.hotel` (en el login
basta escribir el RUC). **Proveedores (pedido del dueño, 2026-10-27): clave por defecto = su mismo RUC
y SIN cambio de clave obligatorio** (`debeCambiarClave: false`; `decidir()` en app.js lo ignora para el
rol proveedor; el panel acepta el RUC como clave aunque no cumpla la política). Se le advirtió que el
RUC es público. El personal del hotel sí: clave inicial al azar y `debeCambiarClave: true`. El primer
admin se crea a mano en la consola (ver README).

## Pendientes conocidos
- Posible soporte futuro para TXT de Interbank y BBVA.

## Flujo de trabajo (pedido del dueño)
- **Claude crea el PR y lo fusiona él mismo en GitHub** al terminar cada cambio (no esperar a que el dueño haga clic).
- Al terminar, darle al dueño el comando de Cloud Shell para publicar:
  `bash <(curl -fsSL https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/scripts/desplegar-cloudshell.sh) ID_PROYECTO [hosting reglas functions]`
  (GitHub Actions falla mientras la cuenta de servicio no tenga los roles; ver el workflow).

## Paginación obligatoria EN EL SERVIDOR (pedido del dueño)
**Toda lista que se lee de Firestore va paginada en el servidor** con `paginaServidor()`
(`public/js/paginaServidor.js`): `orden + limit + startAfter` para la página visible y el total —y las
sumas que hagan falta— con `agregar()` (count/sum), sin descargar los documentos. **Usar siempre
`agregar()`: hace UNA consulta por cálculo** (en paralelo). Varias sumas en una sola consulta exigen un
índice con todos esos campos juntos (con los índices de un campo da `failed-precondition`, visto en
producción) y Firestore acepta como máximo 5 cálculos por consulta (con 6 da `invalid-argument`).
**`sum()` con filtros exige un índice compuesto por cada combinación** (campos del filtro… + el campo que
se suma, todos ASC; si falta da `failed-precondition`): los de `pagos` ya están en `firestore.indexes.json`
(filtros × bruto/retencion/detraccion/notaCredito/neto). OJO con el orden: un solo rango (solo fechas, o razón social
"cómo empieza") = (campo sumado, campo del rango), como lo pide Firebase; con igualdades = (igualdades…, fechaPago, campo sumado). La consola del
SDK está en `setLogLevel("silent")` (firebase.js): los errores se muestran en pantalla, no en F12. Un filtro o una suma nueva suma sus índices.
`paginaServidor` pide el conteo y las sumas por separado: si las sumas fallan (índice aún creándose tras
publicar), la lista carga igual y los totales salen "—" (`st.sumasOk`); si todo cabe en la primera página
(lo normal para un proveedor) los suma ahí mismo con las filas ya leídas (la clave del agregado = el campo).
25/50/100 por página, se recuerda por lista; `cargar(true)` al cambiar filtros, `recargar()` tras editar.
- Admin: **Pagos** (fechas; o RUC + fechas; o razón social / factura / lote en todas las fechas, porque
  Firestore no combina dos rangos; totales de la consulta con sum; "Buscar por: Automático" deduce el tipo
  de lo escrito: 11 dígitos = RUC, BCP_… = lote, F/B/E + número = factura, lo demás = razón social; la
  factura se busca tal cual y como la guarda el TXT, `formasFactura()` en bcp.js: "F001-46937" ↔ "F00046937"), **Lotes**, **Proveedores** (búsqueda
  por cómo empieza el RUC o la razón social en MAYÚSCULAS), **Usuarios**.
- Proveedor: **Mis pagos** (año/mes o factura exacta; totales con sum; "último abono" y años del filtro
  con 2 lecturas) y **Resumen por mes** (un año por vez = 12 agregaciones).
- Solo la vista previa del lote (archivo local, no Firestore) usa `paginador()` en el navegador.
- Índices en `firestore.indexes.json`. Las exportaciones CSV sí leen todo lo filtrado (piden confirmar
  si pasan de 500). Nunca leer una colección entera para pintar una tabla. Una tabla nueva usa
  `paginaServidor` desde el día uno (y sus índices).

## Convenciones
- Código y comentarios en español. Sin frameworks en el frontend (HTML + CSS + JS módulos).
- Todo dato externo se escapa con `esc()` antes de ir a `innerHTML`.
- No subir `serviceAccount.json`, `.firebaserc`, TXT ni CSV reales al repositorio.
