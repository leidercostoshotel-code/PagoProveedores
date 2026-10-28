/* ══════════════════════════════════════════════════════════════════
   LECTURA DEL TXT DE TELECRÉDITO BCP ("Pago a Proveedores") + CSV DE
   DESCUENTOS (SAP B1)
   Formato tomado de un TXT real del banco (BCP_102026_01_20261015101650.txt):
   ancho fijo, una línea de encabezado "#1…" y una línea " 2…" por factura.
   ══════════════════════════════════════════════════════════════════ */

// Posiciones (inicio en 1, longitud).
export const CABECERA = {                                   // línea "#1"
  tipoCuenta: [4, 1], cuentaCargo: [5, 20], moneda: [25, 2], total: [27, 15], // total con 2 decimales implícitos
  fecha: [42, 8],                                           // DDMMAAAA
  referencia: [50, 20], cantidad: [85, 6],                  // n.º de pagos del archivo
};
export const DETALLE = {                                    // línea " 2" (una por comprobante)
  tipoCuenta: [3, 1], cuenta: [4, 20], nombre: [24, 40], moneda: [64, 2],
  importe: [66, 15],                                        // 2 decimales implícitos
  tipoDoc: [81, 3], numDoc: [84, 12],                       // "RUC" + número
  tipoComp: [96, 1], numComp: [97, 10],                     // F = factura, B = boleta… + número
};

const campo = (linea, [ini, len]) => linea.substr(ini - 1, len).trim();
const num = (s) => Number(String(s).replace(",", ".")) || 0;
const r2 = (n) => Math.round(n * 100) / 100;
const centavos = (s) => (Number(String(s).replace(/\D/g, "")) || 0) / 100;
const MONEDAS = { "S/": "PEN", US: "USD", "$ ": "USD", "U$": "USD" };
/** Tipo de registro: el segundo carácter ("#1" = encabezado, " 2" = detalle). */
const tipoRegistro = (l) => (l[0] === "#" || l[0] === " " ? l[1] : l[0]);

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
/** Número del comprobante sin serie ni ceros: "F001-00452" → 452, "F00046937" → 46937. */
const numeroComprobante = (f) => { const m = String(f).match(/(\d+)\D*$/); return m ? Number(m[1]) : NaN; };

/** Formas de buscar una factura: tal cual y como la guarda el TXT ("F001-46937" → "F00046937"). */
export function formasFactura(texto) {
  const F = String(texto).toUpperCase().replace(/\s/g, ""), m = F.match(/^([FBE])[A-Z0-9]*-(\d+)$/);
  return [...new Set([F, ...(m ? [`${m[1]}${m[2].padStart(8, "0")}`] : [])])];
}

/** ID del documento en "pagos": RUC + comprobante + fecha de abono (así nunca se duplica). */
export const idPago = (ruc, factura, f) => `${ruc}_${factura.replace(/[^\w-]/g, "")}_${f}`;

/** Huella SHA-256 (hex) de un archivo: reconoce un TXT ya cargado aunque se le cambie el nombre. */
export async function huellaArchivo(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (globalThis.crypto?.subtle) {
    const h = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Sin https (p. ej. abierto por http en la red local) no hay crypto.subtle: FNV-1a de 64 bits.
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return `fnv-${h.toString(16)}-${bytes.length}`;
}

/**
 * Interpreta el TXT del banco cruzado con los descuentos (texto del CSV, o
 * un mapa ya armado con leerDescuentos cuando son varios CSV).
 * Devuelve { lote, fechaPago, f, pagos[], avisos[], total, proveedores, integro, moneda }.
 * `integro` = el total y la cantidad del encabezado cuadran con el detalle.
 */
export function interpretarLote(textoTxt, nombreTxt, descuentos) {
  const lineas = textoTxt.split(/\r?\n/).filter((l) => l.trim());
  const cab = lineas.find((l) => tipoRegistro(l) === "1") || "";
  const fd = campo(cab, CABECERA.fecha);                    // DDMMAAAA
  const f = /^\d{8}$/.test(fd) ? `${fd.slice(4, 8)}${fd.slice(2, 4)}${fd.slice(0, 2)}` : "";
  const fechaPago = f ? `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}` : new Date().toISOString().slice(0, 10);
  const base = String(nombreTxt || "lote").replace(/\.txt$/i, "").replace(/^BCP_/i, "").replace(/[^\w-]/g, "_");
  const lote = `BCP_${f || "SINFECHA"}_${base}`;
  const desc = typeof descuentos === "object" && descuentos ? descuentos : leerDescuentos(descuentos);
  const hayDesc = Object.keys(desc).length > 0;
  // Índice por RUC + número de comprobante: el TXT trae "F00046937" y SAP puede traer "F001-46937".
  const porNumero = new Map(Object.entries(desc).map(([fac, d]) => [`${d.ruc}|${numeroComprobante(fac)}`, d]));
  const avisos = [];
  if (!cab) avisos.push("No se encontró el encabezado (línea #1): se usó la fecha de hoy como fecha de abono.");
  else if (!f) avisos.push("La fecha del encabezado no tiene formato DDMMAAAA.");

  const pagos = [];
  const detalles = lineas.filter((l) => tipoRegistro(l) === "2");
  if (!detalles.length) avisos.push("El archivo no tiene líneas de detalle (2). ¿Es el TXT de Pago a Proveedores?");

  for (const l of detalles) {
    const tipoDoc = campo(l, DETALLE.tipoDoc).toUpperCase();
    const ruc = campo(l, DETALLE.numDoc).replace(/\D/g, "");
    const nombre = campo(l, DETALLE.nombre);
    const neto = centavos(campo(l, DETALLE.importe));
    const moneda = MONEDAS[l.substr(DETALLE.moneda[0] - 1, 2)] || "PEN";
    const factura = `${campo(l, DETALLE.tipoComp)}${campo(l, DETALLE.numComp)}`.toUpperCase() || "SIN-REF";
    if (tipoDoc !== "RUC") avisos.push(`${nombre || "(sin nombre)"}: el documento es ${tipoDoc || "desconocido"} ${ruc}, no RUC.`);
    else if (ruc.length !== 11) avisos.push(`RUC "${ruc || "(vacío)"}" no tiene 11 dígitos (${nombre || "sin nombre"}).`);
    if (moneda !== "PEN") avisos.push(`${factura} (${nombre}) está en dólares.`);
    const d = desc[factura] || porNumero.get(`${ruc}|${numeroComprobante(factura)}`);
    if (!d && hayDesc) avisos.push(`${factura} (${ruc}) no está en el CSV de descuentos: se tomó el importe abonado como bruto.`);
    pagos.push({
      id: idPago(ruc, factura, f), ruc, razonSocial: nombre, factura, fechaPago, banco: "BCP", moneda,
      tipoCuenta: campo(l, DETALLE.tipoCuenta), cuentaAbono: campo(l, DETALLE.cuenta),
      bruto: r2(d?.bruto || neto), retencion: r2(d?.retencion || 0), detraccion: r2(d?.detraccion || 0),
      notaCredito: r2(d?.notaCredito || 0), neto: r2(neto), lote,
    });
  }
  const total = r2(pagos.reduce((s, p) => s + p.neto, 0));
  const proveedores = new Set(pagos.map((p) => p.ruc)).size;

  // Control de integridad contra el encabezado (total y cantidad de pagos).
  let integro = !!cab && !!f && pagos.length > 0;
  if (cab) {
    const totalCab = centavos(campo(cab, CABECERA.total));
    const cantCab = Number(campo(cab, CABECERA.cantidad)) || 0;
    if (Math.abs(totalCab - total) >= 0.005) { integro = false; avisos.unshift(`El total del encabezado (${totalCab.toFixed(2)}) no cuadra con la suma del detalle (${total.toFixed(2)}).`); }
    if (cantCab && cantCab !== pagos.length) { integro = false; avisos.unshift(`El encabezado dice ${cantCab} pagos y el detalle trae ${pagos.length}.`); }
  }
  // Moneda del lote: la del encabezado (S/ o US); sin encabezado, la de sus pagos.
  const moneda = MONEDAS[cab.substr(CABECERA.moneda[0] - 1, 2)] || (pagos.length && pagos.every((p) => p.moneda === "USD") ? "USD" : "PEN");
  return { lote, fechaPago, f, pagos, avisos, total, proveedores, integro, moneda };
}
