# Portal de Proveedores · Swissôtel Lima

Portal web donde cada proveedor entra con su **RUC y clave** y consulta sus facturas pagadas,
la fecha de abono, el banco y el desglose de descuentos (retención, detracción, notas de crédito).
El personal del hotel tiene un **panel de administración** para cargar los lotes de pago del BCP,
crear las cuentas de los proveedores y gestionar usuarios internos.

El ingreso usa el mismo diseño y la misma seguridad que la suite **A-B-Swiss** (foto del hotel,
logo "30 años", bloqueo de 1 hora tras 3 intentos fallidos, cambio de clave con reautenticación).

Hecho en **HTML + CSS + JavaScript sin frameworks** y Firebase (Auth, Firestore, Hosting, Functions).
El `public/index.html` es mínimo; las pantallas se arman desde `public/js/plantillas.js`.

## Roles

| Rol | Qué puede hacer |
|---|---|
| **Administrador** | Todo: pagos, cargar/eliminar lotes, proveedores y usuarios internos. |
| **Contabilidad** | Ve todos los pagos, carga y elimina lotes, crea y gestiona proveedores. |
| **Consulta** | Solo ve pagos, lotes y proveedores. |
| **Proveedor** | Solo ve sus propios pagos (los de su RUC). |

Lo decide `firestore.rules` (no solo la pantalla). Desactivar una cuenta le corta el acceso al instante.

## Funciones

- **Proveedor:** tarjetas con total abonado, facturas, retenciones y último abono; filtros por año,
  mes y factura; constancia de pago imprimible por factura; resumen por mes; exportar a Excel (CSV).
  Cuenta bancaria enmascarada (solo últimos 4 dígitos).
- **Administración:**
  - *Pagos:* búsqueda por fechas, RUC, razón social, factura o lote; totales; exportar CSV.
  - *Cargar lote:* subes el TXT de Telecrédito BCP + el CSV de descuentos de SAP B1, ves una
    vista previa con avisos (RUC inválido, factura sin desglose, proveedor sin cuenta) y confirmas.
  - *Lotes:* historial de cargas; ver o eliminar un lote cargado por error.
  - *Proveedores:* alta con RUC + razón social (la clave por defecto es su RUC); editar,
    activar/desactivar, restablecer clave.
  - *Usuarios:* personal interno con su rol (solo administrador).
- **Seguridad:** el personal del hotel cambia la clave en su primer ingreso (los proveedores entran con
  su RUC y su clave, por defecto su mismo RUC, sin cambio obligatorio); claves de 8+ caracteres con letras y
  números; bloqueo por intentos fallidos; cierre de sesión tras 30 min sin actividad; la sesión no
  sobrevive al cerrar el navegador.

## Puesta en marcha

1. Crea un proyecto en Firebase y habilita **Authentication → Correo electrónico/contraseña** y **Firestore**.
2. Agrega una **app web** al proyecto (Configuración del proyecto → Tus apps) para obtener su configuración.
3. En GitHub → *Settings → Secrets and variables → Actions → New repository secret*, crea:

   | Name | Secret (dónde sale) |
   |---|---|
   | `FIREBASE_API_KEY` | `apiKey` de la app web |
   | `FIREBASE_AUTH_DOMAIN` | `authDomain` (ej. `mi-proyecto.firebaseapp.com`) |
   | `FIREBASE_PROJECT_ID` | `projectId` |
   | `FIREBASE_STORAGE_BUCKET` | `storageBucket` |
   | `FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
   | `FIREBASE_APP_ID` | `appId` |
   | `FIREBASE_SERVICE_ACCOUNT` | JSON completo de una cuenta de servicio (Configuración → Cuentas de servicio → Generar nueva clave privada) |

   Con eso, cada merge a `main` despliega solo (`.github/workflows/firebase-deploy.yml`).
   Para desplegar a mano: pon tus valores en `public/js/config.js` (sin subirlos), copia
   `.firebaserc.example` a `.firebaserc` y ejecuta `npm run deploy`.
4. Ajusta en `public/js/config.js` el correo de Contabilidad (`CORREO_CONTABILIDAD`).
5. *(Opcional, plan Blaze)* Cloud Functions para el bloqueo por intentos y "Restablecer clave":
   el workflow las despliega; a mano, `npm run deploy:functions`. Sin ellas el portal funciona igual.

### Publicar desde Google Cloud Shell (sin GitHub Actions)

Abre https://shell.cloud.google.com con la cuenta dueña del proyecto de Firebase y pega
(cambia `ID_PROYECTO` por el **ID del proyecto de Firebase**, no el nombre del repositorio):
```
bash <(curl -fsSL https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/scripts/desplegar-cloudshell.sh) ID_PROYECTO
```
Por defecto publica `hosting` y `reglas`; agrega `functions` al final si tienes plan Blaze.
La configuración web la saca sola del proyecto (no hace falta pegar la apiKey). Trabaja en
`/tmp`, usa siempre `--project` y se niega a correr con `leitime`, así que no toca otros proyectos.

### El primer administrador (una sola vez, en la consola de Firebase)

1. **Authentication → Users → Agregar usuario**: tu correo y una clave.
2. Copia el **UID** de ese usuario.
3. **Firestore → Iniciar colección** `usuarios` → documento con ID = ese UID y los campos:
   `rol` = `admin` (string), `activo` = `true` (boolean), `nombre` (string), `email` (string).

Desde ahí, todo lo demás (proveedores y usuarios) se crea desde el panel.

## Cargar un lote de pagos

Desde el panel: **Cargar lote**. También sigue disponible por consola:
```
npm install
npm run cargar -- PROV_20261024.txt descuentos.csv
```
(requiere `serviceAccount.json` en la raíz, que está en `.gitignore`). El CSV sale de SAP B1 con el
formato de `ejemplos/descuentos.csv`. Ajusta las posiciones de columna del TXT en
`public/js/bcp.js` **y** en `scripts/cargar-pagos-bcp.js` (deben ser iguales).

## Probar en local
```
npm run servir      # http://localhost:5000 (con tus valores en public/js/config.js)
```
