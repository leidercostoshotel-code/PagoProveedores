/* ══════════════════════════════════════════════════════════════════
   FIREBASE: Auth + Firestore + Functions (SDK v10 modular desde CDN)
   Mismo esquema de login que la suite A-B-Swiss (src/firebase.js):
   bloqueo por intentos fallidos con Cloud Functions, cambio de clave con
   reautenticación y alta de usuarios con una segunda instancia de Auth.
   ══════════════════════════════════════════════════════════════════ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  setPersistence, browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, setLogLevel } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { firebaseConfig, REGION_FUNCIONES, DOMINIO_PROVEEDORES } from "./config.js";

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
// Sin mensajes internos del SDK en la consola (F12): los errores ya se muestran en pantalla.
setLogLevel("silent");
export const auth = getAuth(app);

// La sesión se guarda solo mientras la pestaña está abierta (portal con
// datos bancarios: al cerrar el navegador hay que volver a ingresar).
setPersistence(auth, browserSessionPersistence).catch(() => {});

const functions = getFunctions(app, REGION_FUNCIONES);
const _verificarBloqueoLogin = httpsCallable(functions, "verificarBloqueoLogin");
const _registrarIntentoFallido = httpsCallable(functions, "registrarIntentoFallido");
const _limpiarIntentosLogin = httpsCallable(functions, "limpiarIntentosLogin");
const _restablecerClave = httpsCallable(functions, "restablecerClave");
/** Validar con SUNAT los comprobantes pendientes (Cloud Function; solo Contabilidad/admin). */
export const validarSunatAhora = () => httpsCallable(functions, "validarSunatAhora", { timeout: 310000 })({}).then((r) => r.data);

/** "20123456789" → "20123456789@proveedores.hotel"; un correo queda tal cual. */
export function correoDesdeUsuario(texto) {
  const t = String(texto || "").trim().toLowerCase();
  return /^\d{11}$/.test(t) ? `${t}@${DOMINIO_PROVEEDORES}` : t;
}

/** RUC a partir del correo sintético de un proveedor (o "" si no lo es). */
export function rucDesdeCorreo(email) {
  const [usuario, dominio] = String(email || "").toLowerCase().split("@");
  return dominio === DOMINIO_PROVEEDORES ? usuario : "";
}

/**
 * Inicia sesión con bloqueo por intentos fallidos: 3 intentos seguidos con
 * la misma cuenta la bloquean 1 hora (la Cloud Function la deshabilita de
 * verdad en Firebase Auth, ver functions/index.js). Si las funciones no
 * están desplegadas, el login sigue funcionando sin el bloqueo propio
 * (queda el freno de Firebase: auth/too-many-requests).
 *
 * Errores propios: `code: "auth/bloqueado-por-intentos"` con
 * `bloqueadoHasta` (epoch ms); y `intentosRestantes` agregado al error
 * normal de Firebase cuando la contraseña es incorrecta.
 */
export async function login(usuario, password) {
  const correo = correoDesdeUsuario(usuario);
  const estado = await _verificarBloqueoLogin({ email: correo }).catch(() => null);
  if (estado?.data?.bloqueado) {
    throw Object.assign(new Error("Cuenta bloqueada por intentos fallidos"), {
      code: "auth/bloqueado-por-intentos", bloqueadoHasta: estado.data.bloqueadoHasta,
    });
  }
  try {
    const cred = await signInWithEmailAndPassword(auth, correo, password);
    _limpiarIntentosLogin().catch(() => {});
    return cred;
  } catch (err) {
    if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
      const r = await _registrarIntentoFallido({ email: correo }).catch(() => null);
      if (r?.data?.bloqueado) {
        throw Object.assign(new Error("Cuenta bloqueada por intentos fallidos"), {
          code: "auth/bloqueado-por-intentos", bloqueadoHasta: r.data.bloqueadoHasta,
        });
      }
      if (r?.data) err.intentosRestantes = Math.max(0, 3 - r.data.intentos);
    }
    throw err;
  }
}

export function logout() {
  return signOut(auth);
}

export function onUser(cb) {
  return onAuthStateChanged(auth, cb);
}

/** Cambia la clave de la sesión activa (reautentica primero, como exige Firebase). */
export async function cambiarPassword(actual, nueva) {
  const user = auth.currentUser;
  if (!user) throw new Error("No hay sesión activa");
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, actual));
  await updatePassword(user, nueva);
}

/* Alta de usuarios: `createUserWithEmailAndPassword` deja la sesión abierta
   con la cuenta nueva en la instancia que se le pase. Para no sacar al
   administrador de su propia sesión se usa una SEGUNDA instancia de
   Firebase (misma configuración, distinto nombre) solo para ese momento. */
const appSecundaria = initializeApp(firebaseConfig, "alta-de-usuarios");
const authSecundaria = getAuth(appSecundaria);

/** Crea la cuenta y devuelve su uid, sin tocar la sesión del administrador. */
export async function crearUsuario(email, password) {
  const cred = await createUserWithEmailAndPassword(authSecundaria, email, password);
  const uid = cred.user.uid;
  await signOut(authSecundaria);
  return uid;
}

/** Pone una clave nueva a otra cuenta (Cloud Function; solo admin/contabilidad). */
export async function restablecerClave(uid, nuevaClave) {
  await _restablecerClave({ uid, nuevaClave });
}
