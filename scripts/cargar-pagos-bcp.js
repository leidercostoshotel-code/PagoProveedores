// Uso: node cargar-pagos-bcp.js PROV_20261024.txt descuentos.csv
// Requiere: npm i firebase-admin   y la clave de servicio en ./serviceAccount.json
const fs = require("fs");
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccount.json")) });
const db = admin.firestore();

// Mismas posiciones y lógica que public/js/bcp.js (carga desde el navegador):
// si cambias una, cambia la otra.
// === AJUSTA ESTAS POSICIONES A TU PLANTILLA TELECRÉDITO (inicio en 1, longitud) ===
// Verifica con una línea real de tu TXT antes de la primera carga.
const CABECERA = { fecha: [27, 8] };                       // AAAAMMDD en registro tipo "1"
const DETALLE = {                                          // registro tipo "2"
  cuentaAbono: [4, 20],  tipoDoc: [24, 1],  ruc: [25, 12],
  nombre: [37, 75],      importe: [115, 17], referencia: [132, 40],
};
const campo = (linea, [ini, len]) => linea.substr(ini - 1, len).trim();
const num = s => Number(String(s).replace(",", ".")) || 0;

// CSV de SAP B1 (separado por ;): factura;ruc;bruto;retencion;detraccion;notaCredito
function leerDescuentos(ruta) {
  const m = {};
  if (!ruta || !fs.existsSync(ruta)) return m;
  for (const l of fs.readFileSync(ruta, "latin1").split(/\r?\n/).slice(1)) {
    const [factura, ruc, bruto, retencion, detraccion, notaCredito] = l.split(";");
    if (factura) m[factura.trim()] = { ruc: ruc?.trim(), bruto: num(bruto), retencion: num(retencion), detraccion: num(detraccion), notaCredito: num(notaCredito) };
  }
  return m;
}

async function main() {
  const [txt, csv] = process.argv.slice(2);
  const lineas = fs.readFileSync(txt, "latin1").split(/\r?\n/).filter(Boolean);
  const cab = lineas.find(l => l.startsWith("1")) || "";
  const f = campo(cab, CABECERA.fecha);
  const fechaPago = /^\d{8}$/.test(f) ? `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}` : new Date().toISOString().slice(0, 10);
  const base = require("path").basename(txt).replace(/\.txt$/i, "").replace(/[^\w-]/g, "_");
  const lote = `BCP_${f || "SINFECHA"}_${base}`;
  const desc = leerDescuentos(csv);

  let batch = db.batch(), n = 0, total = 0;
  const rucs = new Set();
  for (const l of lineas.filter(l => l.startsWith("2"))) {
    const ruc = campo(l, DETALLE.ruc).replace(/\D/g, "");
    const neto = num(campo(l, DETALLE.importe)) / 100;      // Telecrédito manda importe sin punto decimal (2 decimales implícitos)
    const facturas = campo(l, DETALLE.referencia).split(/[ ,/]+/).filter(Boolean); // "F001-00452 F001-00460"
    for (const factura of facturas.length ? facturas : ["SIN-REF"]) {
      const d = desc[factura] || {};
      const bruto = d.bruto || neto, retencion = d.retencion || 0, detraccion = d.detraccion || 0, notaCredito = d.notaCredito || 0;
      const netoFactura = facturas.length > 1 && d.bruto ? bruto - retencion - detraccion - notaCredito : neto;
      const ref = db.collection("pagos").doc(`${ruc}_${factura.replace(/[^\w-]/g, "")}_${f}`);
      batch.set(ref, { ruc, razonSocial: campo(l, DETALLE.nombre), factura, fechaPago, banco: "BCP",
        cuentaAbono: campo(l, DETALLE.cuentaAbono), bruto, retencion, detraccion, notaCredito, neto: netoFactura, lote,
        cargadoEn: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      n++; total += netoFactura; rucs.add(ruc);
      if (n % 450 === 0) { await batch.commit(); batch = db.batch(); }
    }
  }
  if (n % 450) await batch.commit();
  // Registro del lote (pestaña "Lotes" del panel de administración).
  await db.collection("lotes").doc(lote).set({
    lote, banco: "BCP", fechaPago, facturas: n, proveedores: rucs.size, total: Math.round(total * 100) / 100,
    archivoTxt: require("path").basename(txt), archivoCsv: csv ? require("path").basename(csv) : "",
    cargadoPor: "script cargar-pagos-bcp.js", cargadoEn: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Lote ${lote}: ${n} facturas cargadas, S/ ${total.toFixed(2)} abonados el ${fechaPago}.`);
}
main().catch(e => { console.error("Error:", e.message); process.exit(1); });
