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
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, serverTimestamp, getAggregateFromServer, count, sum, writeBatch } from "firebase/firestore";

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
  await setDoc(doc(db, "comprobantes", "20111111111_01_F001-1"), { ruc: "20111111111", origen: "hotel", total: 10 });
  await setDoc(doc(db, "comprobantes", "20111111111_01_F001-2"), { ruc: "20111111111", origen: "proveedor", total: 20 });
  await setDoc(doc(db, "comprobantes", "20222222222_01_F001-1"), { ruc: "20222222222", origen: "proveedor", total: 30 });
  await setDoc(doc(db, "retenciones", "20111111111_20_R001-1"), { ruc: "20111111111", total: 1 });
  await setDoc(doc(db, "retenciones", "20222222222_20_R001-2"), { ruc: "20222222222", total: 2 });
  await setDoc(doc(db, "retenciones_archivos", "20111111111_20_R001-1"), { xml: "<Retention/>" });
  await setDoc(doc(db, "retenciones_archivos", "20222222222_20_R001-2"), { xml: "<Retention/>" });
});
// Comprobante válido (como lo arma public/js/comprobantes.js).
const comp = (uid, ruc, numero, origen, extra = {}) => ({
  ruc, razonSocial: "X", tipo: "01", tipoNombre: "Factura Electrónica", serie: "F001", numero, correlativo: String(numero),
  comprobante: `F001-${numero}`, facturaPago: `F${String(numero).padStart(8, "0")}`, fechaEmision: "2026-10-01", fechaVencimiento: "",
  moneda: "PEN", tipoCambio: 0, neto: 100, exento: 0, impuestos: 18, total: 118, detraccion: 0, rucReceptor: "20297885538",
  receptor: "HOTEL", refTipo: "", refValor: "", estadoSunat: "", motivoRechazo: "", gosocketId: "", items: [],
  origen, archivo: "a.xml", hash: "h", subidoPorUid: uid, subidoEn: serverTimestamp(), ...extra,
});
const compRef = (db, ruc, numero) => doc(db, "comprobantes", `${ruc}_01_F001-${numero}`);
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
await caso("cuenta y suma SUS pagos (totales del servidor)", true, () => getAggregateFromServer(query(collection(db, "pagos"), where("ruc", "==", "20111111111")), { n: count(), neto: sum("neto") }));
await caso("NO cuenta/suma los pagos de B", false, () => getAggregateFromServer(query(collection(db, "pagos"), where("ruc", "==", "20222222222")), { n: count(), neto: sum("neto") }));
await caso("NO cuenta/suma todos los pagos", false, () => getAggregateFromServer(collection(db, "pagos"), { n: count(), neto: sum("neto") }));
await caso("NO cuenta usuarios", false, () => getAggregateFromServer(collection(db, "usuarios"), { n: count() }));
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

console.log("Proveedor A · comprobantes (F12)");
db = as("PA");
await caso("sube SU comprobante", true, () => setDoc(compRef(db, "20111111111", 9), comp("PA", "20111111111", 9, "proveedor")));
await caso("NO sube uno de otro RUC", false, () => setDoc(compRef(db, "20222222222", 9), comp("PA", "20222222222", 9, "proveedor")));
await caso("NO se hace pasar por el hotel (origen)", false, () => setDoc(compRef(db, "20111111111", 10), comp("PA", "20111111111", 10, "hotel")));
await caso("NO sube con un ID que no cuadra", false, () => setDoc(doc(db, "comprobantes", "20111111111_01_F001-77"), comp("PA", "20111111111", 11, "proveedor")));
await caso("NO agrega campos extra", false, () => setDoc(compRef(db, "20111111111", 12), comp("PA", "20111111111", 12, "proveedor", { pagado: true })));
await caso("NO firma a nombre de otro usuario", false, () => setDoc(compRef(db, "20111111111", 13), comp("PB", "20111111111", 13, "proveedor")));
await caso("lee el suyo por ID", true, () => getDoc(compRef(db, "20111111111", 1)));
await caso("consulta por ID uno suyo que no existe", true, () => getDoc(compRef(db, "20111111111", 999)));
await caso("NO lee el de B por ID", false, () => getDoc(compRef(db, "20222222222", 1)));
await caso("lista los suyos", true, () => getDocs(query(collection(db, "comprobantes"), where("ruc", "==", "20111111111"))));
await caso("NO lista los de B", false, () => getDocs(query(collection(db, "comprobantes"), where("ruc", "==", "20222222222"))));
await caso("NO lista todos", false, () => getDocs(collection(db, "comprobantes")));
await caso("NO cuenta todos", false, () => getAggregateFromServer(collection(db, "comprobantes"), { n: count() }));
await caso("reemplaza el que él subió", true, () => setDoc(compRef(db, "20111111111", 2), comp("PA", "20111111111", 2, "proveedor")));
await caso("NO cambia el que registró el hotel", false, () => setDoc(compRef(db, "20111111111", 1), comp("PA", "20111111111", 1, "proveedor")));
await caso("NO borra comprobantes", false, () => deleteDoc(compRef(db, "20111111111", 2)));
const archRef = (db, ruc, numero) => doc(db, "comprobantes_archivos", `${ruc}_01_F001-${numero}`);
const arch = (uid, extra = {}) => ({ xml: "<Invoice/>", subidoPorUid: uid, subidoEn: serverTimestamp(), ...extra });
await caso("sube el XML y PDF de su comprobante (en el mismo lote)", true, async () => {
  const b = writeBatch(db);
  b.set(compRef(db, "20111111111", 20), comp("PA", "20111111111", 20, "proveedor", { tieneXml: true, tienePdf: true }));
  b.set(archRef(db, "20111111111", 20), arch("PA", { pdf: "JVBERi0=" }));
  return b.commit();
});
await caso("baja el XML de su comprobante", true, () => getDoc(archRef(db, "20111111111", 20)));
await caso("NO baja el XML de B", false, () => getDoc(archRef(db, "20222222222", 1)));
await caso("NO lista los archivos", false, () => getDocs(collection(db, "comprobantes_archivos")));
await caso("NO pone archivos a un comprobante del hotel", false, () => setDoc(archRef(db, "20111111111", 1), arch("PA")));
await caso("NO pone archivos sin comprobante", false, () => setDoc(archRef(db, "20111111111", 404), arch("PA")));
await caso("NO pone archivos a un comprobante de B", false, () => setDoc(archRef(db, "20222222222", 1), arch("PA")));
await caso("NO agrega campos extra a los archivos", false, () => setDoc(archRef(db, "20111111111", 20), arch("PA", { otro: 1 })));

console.log("Proveedor A · retenciones (F12)");
const ret = (uid, ruc, numero, extra = {}) => ({ ruc, razonSocial: "X", rucAgente: "20297885538", serie: "R001", numero, comprobante: `R001-${numero}`,
  fechaEmision: "2026-10-15", porcentaje: 3, moneda: "PEN", total: 21.94, totalPagado: 709.31, documentos: [], fechasPago: ["2026-10-15"],
  origen: "hotel", archivo: "r.xml", hash: "h", tieneXml: true, tienePdf: false, subidoPorUid: uid, subidoEn: serverTimestamp(), ...extra });
const retRef = (db, ruc, numero) => doc(db, "retenciones", `${ruc}_20_R001-${numero}`);
await caso("lee SUS retenciones", true, () => getDocs(query(collection(db, "retenciones"), where("ruc", "==", "20111111111"))));
await caso("lee la suya por ID", true, () => getDoc(retRef(db, "20111111111", 1)));
await caso("baja el XML de la suya", true, () => getDoc(doc(db, "retenciones_archivos", "20111111111_20_R001-1")));
await caso("NO lee las de B", false, () => getDocs(query(collection(db, "retenciones"), where("ruc", "==", "20222222222"))));
await caso("NO lee la de B por ID", false, () => getDoc(retRef(db, "20222222222", 2)));
await caso("NO baja el XML de B", false, () => getDoc(doc(db, "retenciones_archivos", "20222222222_20_R001-2")));
await caso("NO lista todas", false, () => getDocs(collection(db, "retenciones")));
await caso("NO sube retenciones (las emite el hotel)", false, () => setDoc(retRef(db, "20111111111", 50), ret("PA", "20111111111", 50)));

console.log("Proveedor desactivado");
db = as("PX");
await caso("NO lee ni sus propios pagos", false, () => pagosDe(db, "20333333333"));
await caso("NO se reactiva a sí mismo", false, () => updateDoc(doc(db, "usuarios", "PX"), { activo: true }));

console.log("Consulta");
db = as("CSU");
await caso("lee todos los pagos", true, () => getDocs(collection(db, "pagos")));
await caso("lee lotes", true, () => getDocs(collection(db, "lotes")));
await caso("suma todos los pagos (totales del panel)", true, () => getAggregateFromServer(collection(db, "pagos"), { n: count(), neto: sum("neto") }));
await caso("NO escribe pagos", false, () => setDoc(doc(db, "pagos", "Z"), { ruc: "1" }));
await caso("NO crea proveedores", false, () => setDoc(doc(db, "usuarios", "N1"), { rol: "proveedor", activo: true, ruc: "20444444444" }));
await caso("NO se sube a admin", false, () => updateDoc(doc(db, "usuarios", "CSU"), { rol: "admin" }));
await caso("lee todos los comprobantes", true, () => getDocs(collection(db, "comprobantes")));
await caso("lee todas las retenciones", true, () => getDocs(collection(db, "retenciones")));
await caso("NO sube retenciones", false, () => setDoc(retRef(db, "20111111111", 51), ret("CSU", "20111111111", 51)));
await caso("NO sube comprobantes", false, () => setDoc(compRef(db, "20111111111", 50), comp("CSU", "20111111111", 50, "hotel")));

console.log("Contabilidad");
db = as("CON");
await caso("escribe pagos", true, () => setDoc(doc(db, "pagos", "N1"), { ruc: "20111111111", neto: 1 }));
await caso("crea un proveedor", true, () => setDoc(doc(db, "usuarios", "N2"), { rol: "proveedor", activo: true, ruc: "20555555555" }));
await caso("NO crea un admin", false, () => setDoc(doc(db, "usuarios", "N3"), { rol: "admin", activo: true }));
await caso("NO edita al admin", false, () => updateDoc(doc(db, "usuarios", "ADM"), { activo: false }));
await caso("NO convierte proveedor en admin", false, () => updateDoc(doc(db, "usuarios", "PB"), { rol: "admin" }));
await caso("NO cambia el RUC de un proveedor", false, () => updateDoc(doc(db, "usuarios", "PB"), { ruc: "20111111111" }));
await caso("desactiva un proveedor", true, () => updateDoc(doc(db, "usuarios", "PB"), { activo: false }));
await caso("sube un comprobante (XML)", true, () => setDoc(compRef(db, "20222222222", 60), comp("CON", "20222222222", 60, "hotel")));
await caso("importa uno del Excel de Gosocket", true, () => setDoc(compRef(db, "20222222222", 61), comp("CON", "20222222222", 61, "gosocket", { estadoSunat: "ACEPTADO", gosocketId: "abc" })));
await caso("actualiza solo el estado SUNAT", true, () => updateDoc(compRef(db, "20222222222", 60), { estadoSunat: "RECHAZADO", gosocketId: "def" }));
await caso("NO lo marca como subido por el proveedor", false, () => setDoc(compRef(db, "20222222222", 62), comp("CON", "20222222222", 62, "proveedor")));
await caso("guarda el XML de un comprobante que sube", true, () => setDoc(doc(db, "comprobantes_archivos", "20222222222_01_F001-60"), { xml: "<Invoice/>", subidoPorUid: "CON", subidoEn: serverTimestamp() }));
await caso("baja cualquier XML", true, () => getDoc(doc(db, "comprobantes_archivos", "20111111111_01_F001-20")));
await caso("borra un comprobante", true, () => deleteDoc(compRef(db, "20222222222", 61)));
await caso("sube una retención con su XML", true, () => { const b = writeBatch(db); b.set(retRef(db, "20111111111", 60), ret("CON", "20111111111", 60));
  b.set(doc(db, "retenciones_archivos", "20111111111_20_R001-60"), { xml: "<Retention/>", subidoPorUid: "CON", subidoEn: serverTimestamp() }); return b.commit(); });
await caso("NO sube una retención con un ID que no cuadra", false, () => setDoc(doc(db, "retenciones", "20111111111_20_R001-999"), ret("CON", "20111111111", 61)));
await caso("NO agrega campos extra a una retención", false, () => setDoc(retRef(db, "20111111111", 62), ret("CON", "20111111111", 62, { otro: 1 })));
await caso("completa un pago con su retención", true, () => updateDoc(doc(db, "pagos", "A1"), { bruto: 103.09, retencion: 3.09 }));
await caso("borra una retención", true, () => deleteDoc(retRef(db, "20111111111", 60)));
await caso("borra sus archivos", true, () => deleteDoc(doc(db, "comprobantes_archivos", "20222222222_01_F001-60")));
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
