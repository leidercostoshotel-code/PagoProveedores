/* ══════════════════════════════════════════════════════════════════
   LECTURA DEL TXT DE TELECRÉDITO BCP + CSV DE DESCUENTOS (SAP B1)
   Versión navegador de scripts/cargar-pagos-bcp.js: misma lógica y mismas
   posiciones. Si cambias las posiciones aquí, cámbialas también allá.
   ══════════════════════════════════════════════════════════════════ */

// === AJUSTA ESTAS POSICIONES A TU PLANTILLA TELECRÉDITO (inicio en 1, longitud) ===
export const CABECERA = { fecha: [27, 8] };                // AAAAMMDD en registro tipo "1"
export const DETALLE = {                                   // registro tipo "2"
  cuentaAbono: [4, 20], tipoDoc: [24, 1], ruc: [25, 12],
  nombre: [37, 75], importe: [115, 17], referencia: [132, 40],
};

const campo = (linea, [ini, len]) => linea.substr(ini - 1, len).trim();
const num = (s) => Number(String(s).replace(",", ".")) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

/** Lee un File como texto latin1 (los TXT del banco y los CSV de SAP vienen así). */
export function leerArchivo(file) {
  return file.arrayBuffer().then((buf) => new TextDecoder("iso-8859-1").decode(buf));
}

/** CSV de SAP B1 (separado por ;): factura;ruc;bruto;retencion;detraccion;notaCredito */
export function leerDescuentos(texto) {
  const m = {};
  if (!texto) return m;
  for (const l of texto.split(/\r?\n/).slice(1)) {
    const [factura, ruc, bruto, retencion, detraccion, notaCredito] = l.split(";");
    if (factura && factura.trim()) {
      m[factura.trim()] = { ruc: ruc?.trim(), bruto: num(bruto), retencion: num(retencion), detraccion: num(detraccion), notaCredito: num(notaCredito) };
    }
  }
  return m;
}

/** ID del documento en "pagos" (el mismo que arma el script de Node). */
export const idPago = (ruc, factura, f) => `${ruc}_${factura.replace(/[^\w-]/g, "")}_${f}`;

/**
 * Interpreta el TXT del banco cruzado con los descuentos.
 * Devuelve { lote, fechaPago, f, pagos[], avisos[], total, proveedores }.
 */
export function interpretarLote(textoTxt, nombreTxt, textoCsv) {
  const lineas = textoTxt.split(/\r?\n/).filter(Boolean);
  const cab = lineas.find((l) => l.startsWith("1")) || "";
  const f = /^\d{8}$/.test(campo(cab, CABECERA.fecha)) ? campo(cab, CABECERA.fecha) : "";
  const fechaPago = f ? `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}` : new Date().toISOString().slice(0, 10);
  const base = String(nombreTxt || "lote").replace(/\.txt$/i, "").replace(/[^\w-]/g, "_");
  const lote = `BCP_${f || "SINFECHA"}_${base}`;
  const desc = leerDescuentos(textoCsv);
  const avisos = [];
  if (!cab) avisos.push("No se encontró el registro de cabecera (tipo 1): se usó la fecha de hoy como fecha de pago.");
  else if (!f) avisos.push("La fecha de la cabecera no tiene formato AAAAMMDD: revisa las posiciones de CABECERA.");

  const pagos = [];
  const detalles = lineas.filter((l) => l.startsWith("2"));
  if (!detalles.length) avisos.push("El archivo no tiene registros de detalle (tipo 2). ¿Es el TXT de Pago a Proveedores?");

  for (const l of detalles) {
    const ruc = campo(l, DETALLE.ruc).replace(/\D/g, "");
    const neto = num(campo(l, DETALLE.importe)) / 100;     // Telecrédito manda el importe sin punto decimal (2 decimales implícitos)
    const facturas = campo(l, DETALLE.referencia).split(/[ ,/]+/).filter(Boolean); // "F001-00452 F001-00460"
    if (ruc.length !== 11) avisos.push(`RUC "${ruc || "(vacío)"}" no tiene 11 dígitos (${campo(l, DETALLE.nombre) || "sin nombre"}).`);
    for (const factura of facturas.length ? facturas : ["SIN-REF"]) {
      const d = desc[factura] || {};
      if (!desc[factura] && textoCsv) avisos.push(`${factura} (${ruc}) no está en el CSV de descuentos: se tomó el importe abonado como bruto.`);
      if (desc[factura]?.ruc && desc[factura].ruc !== ruc) avisos.push(`${factura}: el RUC del CSV (${desc[factura].ruc}) no coincide con el del banco (${ruc}).`);
      const bruto = d.bruto || neto, retencion = d.retencion || 0, detraccion = d.detraccion || 0, notaCredito = d.notaCredito || 0;
      const netoFactura = facturas.length > 1 && d.bruto ? bruto - retencion - detraccion - notaCredito : neto;
      pagos.push({
        id: idPago(ruc, factura, f), ruc, razonSocial: campo(l, DETALLE.nombre), factura, fechaPago, banco: "BCP",
        cuentaAbono: campo(l, DETALLE.cuentaAbono), bruto: r2(bruto), retencion: r2(retencion), detraccion: r2(detraccion),
        notaCredito: r2(notaCredito), neto: r2(netoFactura), lote,
      });
    }
  }
  const total = r2(pagos.reduce((s, p) => s + p.neto, 0));
  const proveedores = new Set(pagos.map((p) => p.ruc)).size;
  return { lote, fechaPago, f, pagos, avisos, total, proveedores };
}
