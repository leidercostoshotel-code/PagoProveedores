/* ══════════════════════════════════════════════════════════════════
   CONFIGURACIÓN DEL PORTAL
   Los valores "TU_..." los reemplaza solo el despliegue de GitHub Actions
   (.github/workflows/firebase-deploy.yml) con los secrets del repositorio
   FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID,
   FIREBASE_STORAGE_BUCKET, FIREBASE_MESSAGING_SENDER_ID y FIREBASE_APP_ID.
   Para probar en local, pon aquí tus valores (Consola de Firebase →
   Configuración del proyecto → Tus apps → Web) sin subirlos.
   La apiKey de Firebase NO es secreta: identifica al proyecto; lo que
   protege los datos son las reglas de Firestore (firestore.rules).
   ══════════════════════════════════════════════════════════════════ */
export const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_AUTH_DOMAIN",
  projectId: "TU_PROJECT_ID",
  storageBucket: "TU_STORAGE_BUCKET",
  messagingSenderId: "TU_MESSAGING_SENDER_ID",
  appId: "TU_APP_ID",
};

// Región de las Cloud Functions (bloqueo por intentos y restablecer clave).
export const REGION_FUNCIONES = "us-central1";

// Los proveedores entran con su RUC: por debajo, su cuenta de Firebase Auth
// es el correo sintético "<RUC>@<DOMINIO_PROVEEDORES>".
export const DOMINIO_PROVEEDORES = "proveedores.hotel";

export const EMPRESA = "Swissôtel Lima";
export const NOMBRE_SISTEMA = "Portal de Proveedores";

// Correo de Contabilidad que se muestra al proveedor para consultas.
export const CORREO_CONTABILIDAD = "contabilidad@hotel.com";

// Cierre de sesión automático (como la banca en línea):
// - tras este tiempo SIN actividad (minutos), con un aviso y cuenta regresiva antes;
export const MINUTOS_INACTIVIDAD = 15;
// - segundos de aviso ("Tu sesión se cerrará en 60 s · Seguir conectado") antes de cerrarla;
export const SEGUNDOS_AVISO_CIERRE = 60;
// - y, aunque haya actividad, cada cierto tiempo hay que volver a ingresar (horas).
export const HORAS_SESION_MAXIMA = 8;
