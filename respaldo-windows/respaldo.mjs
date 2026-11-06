/* ══════════════════════════════════════════════════════════════════
   RESPALDO DEL PORTAL DE PROVEEDORES EN EL SERVIDOR DEL HOTEL
   Lo corre el Programador de tareas de Windows cada noche (instalar.ps1).
     node respaldo.mjs C:\ProgramData\PortalProveedoresRespaldo\config.json

   En la carpeta de destino deja (nunca borra nada):
     datos\AAAA-MM-DD_HHMM\<colección>.jsonl.gz  copia completa de cada noche (para restaurar)
     datos\AAAA-MM-DD_HHMM\resumen.json           cuántos documentos de cada colección
     excel\*.xlsx                                 lo más reciente, para abrir en Excel sin el portal
     archivos\comprobantes\<RUC> <razón social>\<AAAA-MM>\<RUC-01-F001-00000123>.xml / .pdf
     archivos\retenciones\…                       (solo se bajan los que faltan; una versión nueva
                                                   de un mismo comprobante se guarda aparte)
     archivos\indice.json                         qué archivo es de qué documento (para restaurar)
     registro.log                                 una línea por corrida (y el error, si hubo)
   La llave es de SOLO LECTURA (rol "Cloud Datastore Viewer"): no puede cambiar nada en el portal.
   ══════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { leerLlave, cliente, documentos, camposPlanos, idDe, rutaDocs, escribirXlsx } from "./comun.mjs";

const COLECCIONES = ["usuarios", "pagos", "lotes", "comprobantes", "retenciones"];
const ARCHIVOS = { comprobantes: "comprobantes_archivos", retenciones: "retenciones_archivos" };

const config = JSON.parse(fs.readFileSync(process.argv[2] || path.join(import.meta.dirname, "config.json"), "utf8").replace(/^\uFEFF/, ""));
const DESTINO = config.destino, PROYECTO = config.proyecto;
const llave = process.env.FIRESTORE_EMULATOR_HOST ? null : leerLlave(config.llave);
const api = cliente(llave);
const p2 = (n) => String(n).padStart(2, "0");
const ahora = new Date();
const fecha = `${ahora.getFullYear()}-${p2(ahora.getMonth() + 1)}-${p2(ahora.getDate())}_${p2(ahora.getHours())}${p2(ahora.getMinutes())}`;
// Dos corridas en el mismo minuto (p. ej. una a mano) no comparten carpeta.
const sello = fs.existsSync(path.join(DESTINO, "datos", fecha)) ? `${fecha}${p2(ahora.getSeconds())}` : fecha;
const registro = (linea) => fs.appendFileSync(path.join(DESTINO, "registro.log"), `${new Date().toLocaleString("es-PE")}  ${linea}\r\n`);

/* ── Excel con lo más reciente (para consultar sin el portal) ── */
const EXCEL = {
  pagos: [["Fecha abono", "RUC", "Razón social", "Factura", "Moneda", "Bruto", "Retención", "Detracción", "Nota de crédito", "Neto", "Banco", "Cuenta abono", "Lote"],
    (d) => [d.fechaPago, d.ruc, d.razonSocial, d.factura, d.moneda || "PEN", d.bruto, d.retencion, d.detraccion, d.notaCredito, d.neto, d.banco, d.cuentaAbono, d.lote]],
  comprobantes: [["Emisión", "RUC", "Emisor", "Tipo", "Comprobante", "Moneda", "Valor venta", "IGV", "Total", "Vencimiento", "Estado SUNAT", "Origen"],
    (d) => [d.fechaEmision, d.ruc, d.razonSocial, d.tipoNombre || d.tipo, d.comprobante, d.moneda, d.neto, d.impuestos, d.total, d.fechaVencimiento, d.estadoSunat || "SIN VALIDAR", d.origen]],
  retenciones: [["Emisión", "Retención", "RUC", "Proveedor", "Facturas", "Total pagado", "Retenido", "Moneda"],
    (d) => [d.fechaEmision, d.comprobante, d.ruc, d.razonSocial, (d.documentos || []).map((x) => x.comprobante), d.totalPagado, d.total, d.moneda]],
  usuarios: [["Rol", "RUC", "Razón social / nombre", "Correo", "Activo", "Teléfono"],
    (d) => [d.rol, d.ruc || "", d.razonSocial || d.nombre || "", d.email || "", d.activo ? "Sí" : "No", d.telefono || ""]],
  lotes: [["Lote", "Fecha abono", "Banco", "Facturas", "Proveedores", "Total", "Archivo", "Cargado por"],
    (d) => [d.lote, d.fechaPago, d.banco, d.facturas, d.proveedores, d.total, d.archivoTxt, d.cargadoPor]],
};

/* ── XML y PDF: solo los que faltan en el disco ─────────────────── */
const limpio = (s) => String(s || "").replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
function carpetaDe(tipo, d) {
  const mes = String(d.fechaEmision || "sin-fecha").slice(0, 7);
  return path.join(DESTINO, "archivos", tipo, limpio(`${d.ruc} ${d.razonSocial}`), mes);
}
const nombreSunat = (tipo, d) => tipo === "retenciones"
  ? `${d.rucAgente || "20297885538"}-20-${d.serie}-${String(d.numero).padStart(8, "0")}`
  : `${d.ruc}-${d.tipo}-${d.serie}-${String(d.numero).padStart(8, "0")}`;

async function bajarArchivos(tipo, lista, indice) {
  let nuevos = 0;
  for (const d of lista) {
    if (!d.tieneXml) continue;
    const ya = indice[`${tipo}/${d.id}`];
    if (ya && ya.hash === (d.hash || "") && fs.existsSync(path.join(DESTINO, ya.xml))) continue;   // ya está y no cambió
    const a = await api.pedir(`${rutaDocs(PROYECTO)}/${ARCHIVOS[tipo]}/${encodeURIComponent(d.id)}`);
    if (!a) continue;
    const f = camposPlanos(a.fields);
    const dir = carpetaDe(tipo, d);
    fs.mkdirSync(dir, { recursive: true });
    // Si es una versión nueva de un comprobante ya guardado, la anterior se queda y esta va con la fecha.
    const base = ya && ya.hash !== (d.hash || "") ? `${nombreSunat(tipo, d)}__${sello}` : nombreSunat(tipo, d);
    const rel = (ext) => path.relative(DESTINO, path.join(dir, `${base}.${ext}`));
    fs.writeFileSync(path.join(DESTINO, rel("xml")), f.xml || "");
    const entrada = { hash: d.hash || "", xml: rel("xml") };
    if (f.pdf) { fs.writeFileSync(path.join(DESTINO, rel("pdf")), Buffer.from(f.pdf, "base64")); entrada.pdf = rel("pdf"); }
    indice[`${tipo}/${d.id}`] = entrada;
    nuevos++;
  }
  return nuevos;
}

/* ── Corrida ─────────────────────────────────────────────────────── */
async function main() {
  fs.mkdirSync(DESTINO, { recursive: true });
  const candado = path.join(DESTINO, "respaldo.en-curso");
  if (fs.existsSync(candado) && Date.now() - fs.statSync(candado).mtimeMs < 6 * 3600e3) throw new Error("Ya hay un respaldo en curso (respaldo.en-curso).");
  fs.writeFileSync(candado, String(process.pid));
  try {
    const carpeta = path.join(DESTINO, "datos", sello);
    fs.mkdirSync(carpeta, { recursive: true });
    fs.mkdirSync(path.join(DESTINO, "excel"), { recursive: true });
    const resumen = { proyecto: PROYECTO, inicio: ahora.toISOString(), colecciones: {}, archivosNuevos: {} };
    const indiceRuta = path.join(DESTINO, "archivos", "indice.json");
    const indice = fs.existsSync(indiceRuta) ? JSON.parse(fs.readFileSync(indiceRuta, "utf8")) : {};

    for (const col of COLECCIONES) {
      const gz = zlib.createGzip(), salida = fs.createWriteStream(path.join(carpeta, `${col}.jsonl.gz`));
      gz.pipe(salida);
      const planos = [];
      for await (const d of documentos(api, PROYECTO, col)) {
        gz.write(JSON.stringify(d) + "\n");   // tal cual lo da Firestore (con sus tipos): así se restaura igual
        planos.push({ id: idDe(d.name), ...camposPlanos(d.fields) });
      }
      gz.end();
      await new Promise((ok, mal) => { salida.on("finish", ok); salida.on("error", mal); });
      resumen.colecciones[col] = planos.length;
      const [enc, fila] = EXCEL[col];
      escribirXlsx(path.join(DESTINO, "excel", `${col}.xlsx`), col, enc, planos.map(fila));
      if (ARCHIVOS[col]) resumen.archivosNuevos[col] = await bajarArchivos(col, planos, indice);
    }
    fs.mkdirSync(path.dirname(indiceRuta), { recursive: true });
    fs.writeFileSync(indiceRuta, JSON.stringify(indice));
    resumen.fin = new Date().toISOString();
    fs.writeFileSync(path.join(carpeta, "resumen.json"), JSON.stringify(resumen, null, 2));
    const texto = `OK ${sello} · ${Object.entries(resumen.colecciones).map(([k, n]) => `${k} ${n}`).join(" · ")} · XML/PDF nuevos: ${Object.values(resumen.archivosNuevos).reduce((a, n) => a + n, 0)}`;
    registro(texto);
    console.log(texto);
  } finally {
    fs.rmSync(candado, { force: true });
  }
}

main().catch((err) => {
  try { registro(`ERROR ${sello} · ${err.message}`); } catch { /* sin carpeta de destino */ }
  console.error("ERROR:", err.message);
  process.exit(1);
});
