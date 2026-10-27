/* ══════════════════════════════════════════════════════════════════
   PRUEBAS DE SEGURIDAD DE firestore.rules
   Hace lo que intentaría alguien desde F12 (consola del navegador) con
   cada rol y comprueba que las reglas lo bloquean. Corre en el emulador:
     npm install && npm run probar:reglas
   (necesita Java). Si cambias firestore.rules, vuelve a correrlas.
   ══════════════════════════════════════════════════════════════════ */
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import fs from "fs";
import { fileURLToPath } from "url";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, serverTimestamp } from "firebase/firestore";

const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
const reglas = fs.readFileSync(fileURLToPath(new URL("../firestore.rules", import.meta.url)), "utf8");
const env = await initializeTestEnvironment({ projectId: "demo-portal", firestore: { host, port: Number(port), rules: reglas } });
await env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore();
  const u = (id, d) => setDoc(doc(db, "usuarios", id), d);
  await u("ADM", { rol: "admin", activo: true, nombre: "Admin" });
  await u("CON", { rol: "contabilidad", activo: true });
  await u("CSU", { rol: "consulta", activo: true });
  await u("PA", { rol: "proveedor", activo: true, ruc: "20111111111", debeCambiarClave: true });
  await u("PB", { rol: "proveedor", activo: true, ruc: "20222222222" });
  await u("PX", { rol: "proveedor", activo: false, ruc: "20333333333" });
  await setDoc(doc(db, "pagos", "A1"), { ruc: "20111111111", factura: "F1", fechaPago: "2026-10-01", neto: 100 });
  await setDoc(doc(db, "pagos", "B1"), { ruc: "20222222222", factura: "F2", fechaPago: "2026-10-01", neto: 999 });
  await setDoc(doc(db, "pagos", "X1"), { ruc: "20333333333", factura: "F3", fechaPago: "2026-10-01", neto: 5 });
  await setDoc(doc(db, "lotes", "L1"), { total: 1 });
  await setDoc(doc(db, "intentos_login", "a@b.c"), { intentos: 1 });
});
const as = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
let ok = 0, mal = 0;
async function caso(nombre, esperado, fn) {
  try { await (esperado ? assertSucceeds(fn()) : assertFails(fn())); ok++; console.log("  ✓", nombre); }
  catch (e) { mal++; console.log("  ✗", nombre, "→", e.message.split("\n")[0]); }
}
const pagosDe = (db, ruc) => getDocs(query(collection(db, "pagos"), where("ruc", "==", ruc)));

console.log("Sin sesión");
let db = as(null);
await caso("no lee pagos", false, () => getDocs(collection(db, "pagos")));
await caso("no lee un pago", false, () => getDoc(doc(db, "pagos", "A1")));
await caso("no lee usuarios", false, () => getDocs(collection(db, "usuarios")));
await caso("no lee intentos_login", false, () => getDoc(doc(db, "intentos_login", "a@b.c")));

console.log("Cuenta creada desde F12 sin perfil");
db = as("INTRUSO");
await caso("no lee pagos de nadie", false, () => pagosDe(db, "20111111111"));
await caso("no se crea perfil de admin", false, () => setDoc(doc(db, "usuarios", "INTRUSO"), { rol: "admin", activo: true }));
await caso("no se crea perfil de proveedor", false, () => setDoc(doc(db, "usuarios", "INTRUSO"), { rol: "proveedor", activo: true, ruc: "20111111111" }));

console.log("Proveedor A (F12)");
db = as("PA");
await caso("lee SUS pagos", true, () => pagosDe(db, "20111111111"));
await caso("NO lee pagos de B (consulta)", false, () => pagosDe(db, "20222222222"));
await caso("NO lee pago de B (directo)", false, () => getDoc(doc(db, "pagos", "B1")));
await caso("NO lista todos los pagos", false, () => getDocs(collection(db, "pagos")));
await caso("NO lista con 'in' de varios RUC", false, () => getDocs(query(collection(db, "pagos"), where("ruc", "in", ["20111111111", "20222222222"]))));
await caso("NO lee lotes", false, () => getDocs(collection(db, "lotes")));
await caso("NO lista usuarios", false, () => getDocs(collection(db, "usuarios")));
await caso("NO lee perfil de B", false, () => getDoc(doc(db, "usuarios", "PB")));
await caso("lee su propio perfil", true, () => getDoc(doc(db, "usuarios", "PA")));
await caso("NO escribe pagos", false, () => setDoc(doc(db, "pagos", "A2"), { ruc: "20111111111", neto: 1 }));
await caso("NO cambia su pago", false, () => updateDoc(doc(db, "pagos", "A1"), { neto: 1e6 }));
await caso("NO borra su pago", false, () => deleteDoc(doc(db, "pagos", "A1")));
await caso("NO se pone rol admin", false, () => updateDoc(doc(db, "usuarios", "PA"), { rol: "admin" }));
await caso("NO se cambia el RUC", false, () => updateDoc(doc(db, "usuarios", "PA"), { ruc: "20222222222" }));
await caso("NO se desactiva/cambia activo", false, () => updateDoc(doc(db, "usuarios", "PA"), { activo: false }));
await caso("NO pone texto inventado en ultimoIngreso", false, () => updateDoc(doc(db, "usuarios", "PA"), { ultimoIngreso: "x".repeat(5000) }));
await caso("marca su último ingreso (hora del servidor)", true, () => updateDoc(doc(db, "usuarios", "PA"), { ultimoIngreso: serverTimestamp() }));
await caso("NO vuelve a poner debeCambiarClave en true para otro campo", false, () => updateDoc(doc(db, "usuarios", "PA"), { debeCambiarClave: true, nombre: "x" }));
await caso("NO crea un proveedor", false, () => setDoc(doc(db, "usuarios", "NUEVO"), { rol: "proveedor", activo: true, ruc: "20222222222" }));
await caso("NO lee intentos_login", false, () => getDoc(doc(db, "intentos_login", "a@b.c")));

console.log("Proveedor desactivado");
db = as("PX");
await caso("NO lee ni sus propios pagos", false, () => pagosDe(db, "20333333333"));
await caso("NO se reactiva a sí mismo", false, () => updateDoc(doc(db, "usuarios", "PX"), { activo: true }));

console.log("Consulta");
db = as("CSU");
await caso("lee todos los pagos", true, () => getDocs(collection(db, "pagos")));
await caso("lee lotes", true, () => getDocs(collection(db, "lotes")));
await caso("NO escribe pagos", false, () => setDoc(doc(db, "pagos", "Z"), { ruc: "1" }));
await caso("NO crea proveedores", false, () => setDoc(doc(db, "usuarios", "N1"), { rol: "proveedor", activo: true, ruc: "20444444444" }));
await caso("NO se sube a admin", false, () => updateDoc(doc(db, "usuarios", "CSU"), { rol: "admin" }));

console.log("Contabilidad");
db = as("CON");
await caso("escribe pagos", true, () => setDoc(doc(db, "pagos", "N1"), { ruc: "20111111111", neto: 1 }));
await caso("crea un proveedor", true, () => setDoc(doc(db, "usuarios", "N2"), { rol: "proveedor", activo: true, ruc: "20555555555" }));
await caso("NO crea un admin", false, () => setDoc(doc(db, "usuarios", "N3"), { rol: "admin", activo: true }));
await caso("NO edita al admin", false, () => updateDoc(doc(db, "usuarios", "ADM"), { activo: false }));
await caso("NO convierte proveedor en admin", false, () => updateDoc(doc(db, "usuarios", "PB"), { rol: "admin" }));
await caso("NO cambia el RUC de un proveedor", false, () => updateDoc(doc(db, "usuarios", "PB"), { ruc: "20111111111" }));
await caso("desactiva un proveedor", true, () => updateDoc(doc(db, "usuarios", "PB"), { activo: false }));
await caso("NO se sube a admin", false, () => updateDoc(doc(db, "usuarios", "CON"), { rol: "admin" }));

console.log("Administrador");
db = as("ADM");
await caso("crea un usuario interno", true, () => setDoc(doc(db, "usuarios", "N4"), { rol: "consulta", activo: true }));
await caso("NO se desactiva a sí mismo", false, () => updateDoc(doc(db, "usuarios", "ADM"), { activo: false }));
await caso("NO se borra a sí mismo", false, () => deleteDoc(doc(db, "usuarios", "ADM")));
await caso("NO toca intentos_login", false, () => setDoc(doc(db, "intentos_login", "a@b.c"), { intentos: 0 }));

console.log(`\n${ok} correctos, ${mal} fallidos`);
await env.cleanup();
process.exit(mal ? 1 : 0);
