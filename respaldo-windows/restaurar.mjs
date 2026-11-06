/* ══════════════════════════════════════════════════════════════════
   RESTAURAR UN RESPALDO EN FIRESTORE (solo en una emergencia)
     node restaurar.mjs <carpeta del respaldo> <ID del proyecto destino> <llave con permiso de escritura>
   Ejemplo:
     node restaurar.mjs D:\Respaldos\PortalProveedores\datos\2026-11-06_0200 portal-proveedores-70bc4 C:\llave-escritura.json

   - Vuelve a escribir cada documento tal cual estaba esa noche (mismo ID, mismos tipos). No borra lo
     que haya en el destino: lo que exista con el mismo ID se reemplaza; lo demás queda como está.
   - Los XML y PDF se vuelven a subir desde la carpeta "archivos" (la de al lado de "datos").
   - La llave de los respaldos diarios es de SOLO LECTURA: para restaurar se usa otra, con el rol
     "Cloud Datastore User", que se crea solo para esto y se borra después (ver README.md).
   - Pide escribir RESTAURAR para confirmar (o --si al final, para no preguntar).
   - Las cuentas de acceso (Firebase Auth) no están en la base: los proveedores se recrean con
     scripts/importar-proveedores.sh (su clave es su RUC) y el personal desde el panel.
   ══════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { leerLlave, cliente, rutaDocs } from "./comun.mjs";

const [carpeta, proyecto, rutaLlave] = process.argv.slice(2).filter((a) => a !== "--si");
const sinPreguntar = process.argv.includes("--si");
if (!carpeta || !proyecto || (!rutaLlave && !process.env.FIRESTORE_EMULATOR_HOST)) {
  console.log("Uso: node restaurar.mjs <carpeta del respaldo> <ID del proyecto destino> <llave con permiso de escritura> [--si]");
  process.exit(1);
}
const api = cliente(process.env.FIRESTORE_EMULATOR_HOST ? null : leerLlave(rutaLlave));
const raiz = path.resolve(carpeta, "..", "..");   // …\datos\<fecha> → la carpeta del respaldo
const COLECCIONES = ["usuarios", "pagos", "lotes", "comprobantes", "retenciones"];

const leerLineas = (archivo) => zlib.gunzipSync(fs.readFileSync(archivo)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const nombreEn = (nombre) => nombre.replace(/^projects\/[^/]+\//, `projects/${proyecto}/`);

/** Escribe en tandas: hasta 400 documentos y ~8 MB por pedido (un commit acepta 500 y 10 MB). */
async function escribir(escrituras) {
  let tanda = [], peso = 0;
  const enviar = async () => {
    if (!tanda.length) return;
    await api.pedir(`${rutaDocs(proyecto)}:commit`, { method: "POST", body: JSON.stringify({ writes: tanda }) });
    tanda = []; peso = 0;
  };
  for (const e of escrituras) {
    const p = JSON.stringify(e).length;
    if (tanda.length >= 400 || peso + p > 8e6) await enviar();
    tanda.push(e); peso += p;
  }
  await enviar();
}

async function main() {
  const resumen = COLECCIONES.filter((c) => fs.existsSync(path.join(carpeta, `${c}.jsonl.gz`)))
    .map((c) => [c, leerLineas(path.join(carpeta, `${c}.jsonl.gz`))]);
  const indiceRuta = path.join(raiz, "archivos", "indice.json");
  const indice = fs.existsSync(indiceRuta) ? JSON.parse(fs.readFileSync(indiceRuta, "utf8")) : {};
  console.log(`Respaldo: ${carpeta}\nProyecto destino: ${proyecto}`);
  for (const [c, docs] of resumen) console.log(`  ${c}: ${docs.length} documentos`);
  console.log(`  XML/PDF: ${Object.keys(indice).length} archivos`);
  if (!resumen.length) throw new Error("La carpeta no tiene archivos .jsonl.gz de un respaldo.");

  if (!sinPreguntar) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const r = await new Promise((ok) => rl.question(`\nEsto escribirá todo en "${proyecto}". Escribe RESTAURAR para seguir: `, ok));
    rl.close();
    if (r.trim() !== "RESTAURAR") { console.log("Cancelado: no se cambió nada."); return; }
  }

  for (const [c, docs] of resumen) {
    await escribir(docs.map((d) => ({ update: { name: nombreEn(d.name), fields: d.fields || {} } })));
    console.log(`✓ ${c}: ${docs.length}`);
  }
  // XML y PDF de vuelta a comprobantes_archivos / retenciones_archivos (la última versión de cada uno).
  const coleccionArchivos = { comprobantes: "comprobantes_archivos", retenciones: "retenciones_archivos" };
  const escrituras = [];
  for (const [clave, e] of Object.entries(indice)) {
    const [tipo, id] = [clave.slice(0, clave.indexOf("/")), clave.slice(clave.indexOf("/") + 1)];
    if (!coleccionArchivos[tipo] || !fs.existsSync(path.join(raiz, e.xml))) continue;
    const campos = {
      xml: { stringValue: fs.readFileSync(path.join(raiz, e.xml), "utf8") },
      subidoPorUid: { stringValue: "respaldo" }, subidoEn: { timestampValue: new Date().toISOString() },
    };
    if (e.pdf && fs.existsSync(path.join(raiz, e.pdf))) campos.pdf = { stringValue: fs.readFileSync(path.join(raiz, e.pdf)).toString("base64") };
    escrituras.push({ update: { name: `projects/${proyecto}/databases/(default)/documents/${coleccionArchivos[tipo]}/${id}`, fields: campos } });
  }
  await escribir(escrituras);
  console.log(`✓ XML/PDF: ${escrituras.length}\nListo. Recuerda borrar la llave de escritura cuando termines.`);
}

main().catch((err) => { console.error("ERROR:", err.message); process.exit(1); });
