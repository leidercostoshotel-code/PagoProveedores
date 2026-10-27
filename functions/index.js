/**
 * Cloud Functions del Portal de Proveedores (requieren el plan Blaze).
 *
 * 1) Bloqueo por intentos fallidos de inicio de sesión — misma lógica que la
 *    suite A-B-Swiss (functions/index.js de ese repo): 3 intentos seguidos
 *    con la misma cuenta la deshabilitan DE VERDAD en Firebase Auth por 1
 *    hora (no es un candado "de mentira" en la pantalla). Un documento por
 *    correo en "intentos_login"; solo estas funciones lo tocan (las reglas
 *    lo cierran para el cliente) para que nadie resetee su contador ni
 *    fabrique un bloqueo contra otra cuenta.
 *
 * 2) restablecerClave — el SDK del navegador no puede cambiar la clave de
 *    OTRA cuenta; esta función lo hace con el Admin SDK si quien llama es
 *    admin/contabilidad activo (contabilidad solo a proveedores). Al personal
 *    lo deja con "debeCambiarClave"; a un proveedor no (su clave puede ser su RUC).
 *
 * Si no se despliegan, el portal funciona igual: sin el bloqueo propio (queda
 * el freno de Firebase "too-many-requests") y sin "Restablecer clave".
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const MAX_INTENTOS = 3;
const DURACION_BLOQUEO_MS = 60 * 60 * 1000; // 1 hora

function normalizarEmail(data) {
  const email = String((data && data.email) || "").trim().toLowerCase();
  if (!email || email.length > 200) throw new HttpsError("invalid-argument", "Falta el correo.");
  return email;
}

/** Antes de mandar la contraseña: ¿la cuenta está bloqueada? Si el bloqueo
 * anterior ya venció, reactiva la cuenta y limpia el contador acá mismo. */
exports.verificarBloqueoLogin = onCall({ cors: true }, async (request) => {
  const email = normalizarEmail(request.data);
  const ref = admin.firestore().doc(`intentos_login/${email}`);
  const snap = await ref.get();
  if (!snap.exists) return { bloqueado: false };

  const datos = snap.data();
  if (!datos.bloqueadoHasta || datos.bloqueadoHasta <= Date.now()) {
    if (datos.bloqueadoHasta) {
      try {
        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().updateUser(user.uid, { disabled: false });
      } catch { /* la cuenta no existe o ya estaba habilitada */ }
    }
    await ref.set({ email, intentos: 0, bloqueadoHasta: null }, { merge: true });
    return { bloqueado: false };
  }
  return { bloqueado: true, bloqueadoHasta: datos.bloqueadoHasta };
});

/** Firebase Auth acaba de rechazar la contraseña: suma un intento y, al
 * llegar a 3, deshabilita la cuenta por 1 hora. */
exports.registrarIntentoFallido = onCall({ cors: true }, async (request) => {
  const email = normalizarEmail(request.data);
  const ref = admin.firestore().doc(`intentos_login/${email}`);

  const r = await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const datos = snap.exists ? snap.data() : {};
    const ahora = Date.now();
    if (datos.bloqueadoHasta && datos.bloqueadoHasta > ahora) {
      return { bloqueado: true, bloqueadoHasta: datos.bloqueadoHasta, intentos: MAX_INTENTOS };
    }
    const previos = datos.bloqueadoHasta && datos.bloqueadoHasta <= ahora ? 0 : (datos.intentos || 0);
    const intentos = previos + 1;
    const bloqueado = intentos >= MAX_INTENTOS;
    const bloqueadoHasta = bloqueado ? ahora + DURACION_BLOQUEO_MS : null;
    tx.set(ref, { email, intentos: bloqueado ? 0 : intentos, bloqueadoHasta, ultimoIntento: ahora }, { merge: true });
    return { bloqueado, bloqueadoHasta, intentos: bloqueado ? MAX_INTENTOS : intentos };
  });

  if (r.bloqueado) {
    try {
      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().updateUser(user.uid, { disabled: true });
    } catch { /* correo sin cuenta real: nada que deshabilitar */ }
  }
  return r;
});

/** Tras un ingreso exitoso: limpia el contador del PROPIO token (nunca de
 * un correo que mande el cliente). */
exports.limpiarIntentosLogin = onCall({ cors: true }, async (request) => {
  if (!request.auth || !request.auth.token.email) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión primero.");
  }
  const email = String(request.auth.token.email).trim().toLowerCase();
  await admin.firestore().doc(`intentos_login/${email}`).set({ email, intentos: 0, bloqueadoHasta: null }, { merge: true });
  return { ok: true };
});

/** Pone una clave temporal a otra cuenta (Administración → Clave). */
exports.restablecerClave = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión primero.");
  const { uid, nuevaClave } = request.data || {};
  const clave = String(nuevaClave || "");
  if (!uid || typeof uid !== "string") throw new HttpsError("invalid-argument", "Falta la cuenta.");
  if (uid === request.auth.uid) throw new HttpsError("failed-precondition", "Para tu propia cuenta usa \"Cambiar contraseña\".");

  const db = admin.firestore();
  const [quien, destino] = await Promise.all([db.doc(`usuarios/${request.auth.uid}`).get(), db.doc(`usuarios/${uid}`).get()]);
  const q = quien.exists ? quien.data() : {};
  if (!q.activo || !["admin", "contabilidad"].includes(q.rol)) throw new HttpsError("permission-denied", "No tienes permiso.");
  if (!destino.exists) throw new HttpsError("not-found", "La cuenta no tiene perfil en el portal.");
  if (q.rol === "contabilidad" && destino.data().rol !== "proveedor") {
    throw new HttpsError("permission-denied", "Contabilidad solo puede restablecer claves de proveedores.");
  }
  // Al proveedor se le puede volver a poner su RUC; cualquier otra clave sigue la política.
  const esProv = destino.data().rol === "proveedor";
  const esSuRuc = esProv && clave === destino.data().ruc;
  if (!esSuRuc && (clave.length < 8 || !/[a-zA-Z]/.test(clave) || !/\d/.test(clave))) {
    throw new HttpsError("invalid-argument", "La clave debe tener al menos 8 caracteres, con letras y números.");
  }

  await admin.auth().updateUser(uid, { password: clave, disabled: false });
  const email = (await admin.auth().getUser(uid)).email;
  if (email) await db.doc(`intentos_login/${email.toLowerCase()}`).set({ email: email.toLowerCase(), intentos: 0, bloqueadoHasta: null }, { merge: true });
  await destino.ref.update({
    debeCambiarClave: !esProv,
    claveRestablecidaPor: q.nombre || request.auth.token.email || request.auth.uid,
    claveRestablecidaEn: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});
