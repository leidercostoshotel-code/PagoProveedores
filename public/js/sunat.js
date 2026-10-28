/* ══════════════════════════════════════════════════════════════════
   COMPROBANTES ELECTRÓNICOS SUNAT (UBL 2.1)
   - leerXmlSunat: Invoice (01 factura / 03 boleta), CreditNote (07) y
     DebitNote (08) → datos del comprobante, en el navegador.
   - filasGosocket: el Excel "Recibidos" que exporta Gosocket → comprobantes.
   - COLUMNAS_GOSOCKET / filaGosocket: la descarga en el MISMO formato.
   ID en Firestore: RUC_TIPO_SERIE-NÚMERO (sin ceros), así nunca se duplica.
   ══════════════════════════════════════════════════════════════════ */

export const TIPOS = {
  "01": "Factura Electrónica",
  "03": "Boleta de Venta Electrónica",
  "07": "Nota de Crédito Electrónica",
  "08": "Nota de Débito Electrónica",
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Identificador del comprobante y la forma en que el TXT del banco escribe el mismo número. */
export function claves(ruc, tipo, serie, numero) {
  const s = String(serie).toUpperCase().trim(), n = Number(String(numero).replace(/\D/g, "")) || 0;
  return {
    serie: s, numero: n,
    comprobante: `${s}-${n}`,
    id: `${ruc}_${tipo}_${s}-${n}`,
    // TXT de Telecrédito: letra de la serie + número a 8 dígitos ("F001-46937" → "F00046937").
    facturaPago: `${s[0] || ""}${String(n).padStart(8, "0")}`,
  };
}

/** "F001-00046937" / "f001-46937" → { serie, numero } (o null). */
export function leerNumero(texto) {
  const m = String(texto || "").toUpperCase().replace(/\s/g, "").match(/^([A-Z0-9]{4})-(\d{1,8})$/);
  return m ? { serie: m[1], numero: Number(m[2]) } : null;
}

/* ── XML UBL ────────────────────────────────────────────────────── */
// Hijos directos por nombre local (sin depender de los prefijos cbc:/cac:).
const hijos = (el, nombre) => (el ? [...el.children].filter((h) => h.localName === nombre) : []);
const hijo = (el, nombre) => hijos(el, nombre)[0] || null;
const ruta = (el, ...nombres) => nombres.reduce((e, n) => hijo(e, n), el);
const texto = (el) => (el ? el.textContent.trim() : "");
const numero = (el) => r2(texto(el));

/** Parte (emisor o receptor): RUC/DNI y nombre. */
function parte(el) {
  const p = ruta(el, "Party");
  return {
    id: texto(ruta(p, "PartyIdentification", "ID")),
    nombre: texto(ruta(p, "PartyLegalEntity", "RegistrationName")) || texto(ruta(p, "PartyName", "Name")),
  };
}

/**
 * Lee un XML de comprobante SUNAT. Devuelve { ok: true, doc } o { ok: false, motivo }.
 * doc trae los campos que se guardan en Firestore (sin los de quién/cuándo subió).
 */
export function leerXmlSunat(textoXml) {
  const x = new DOMParser().parseFromString(textoXml, "application/xml");
  if (x.getElementsByTagName("parsererror").length) return { ok: false, motivo: "El XML está dañado o incompleto." };
  const raiz = x.documentElement, tipoRaiz = raiz.localName;
  if (tipoRaiz === "ApplicationResponse") return { ok: false, omitir: true, motivo: "Constancia (CDR) de SUNAT: no es el comprobante." };
  if (tipoRaiz === "DespatchAdvice") return { ok: false, omitir: true, motivo: "Guía de remisión: no es un comprobante de pago." };
  if (!["Invoice", "CreditNote", "DebitNote"].includes(tipoRaiz)) return { ok: false, motivo: "No es un comprobante electrónico SUNAT (UBL 2.1)." };

  const tipo = tipoRaiz === "CreditNote" ? "07" : tipoRaiz === "DebitNote" ? "08" : texto(hijo(raiz, "InvoiceTypeCode")).padStart(2, "0");
  if (!TIPOS[tipo]) return { ok: false, motivo: `Tipo de comprobante ${tipo || "desconocido"}: solo facturas, boletas y notas de crédito/débito.` };
  const num = leerNumero(texto(hijo(raiz, "ID")));
  if (!num) return { ok: false, motivo: `Número de comprobante no válido ("${texto(hijo(raiz, "ID"))}").` };
  const emisor = parte(hijo(raiz, "AccountingSupplierParty")), receptor = parte(hijo(raiz, "AccountingCustomerParty"));
  if (!/^\d{11}$/.test(emisor.id)) return { ok: false, motivo: "El XML no trae el RUC del emisor." };

  // Totales: Invoice/CreditNote → LegalMonetaryTotal; DebitNote → RequestedMonetaryTotal.
  const totales = hijo(raiz, "LegalMonetaryTotal") || hijo(raiz, "RequestedMonetaryTotal");
  const impuestos = hijos(raiz, "TaxTotal").reduce((s, t) => s + numero(hijo(t, "TaxAmount")), 0);
  // Exonerado (9997) e inafecto (9998): base sin IGV.
  const exento = hijos(raiz, "TaxTotal").flatMap((t) => hijos(t, "TaxSubtotal"))
    .filter((st) => ["9997", "9998"].includes(texto(ruta(st, "TaxCategory", "TaxScheme", "ID"))))
    .reduce((s, st) => s + numero(hijo(st, "TaxableAmount")), 0);
  const total = numero(hijo(totales, "PayableAmount"));
  const neto = numero(hijo(totales, "LineExtensionAmount")) || r2(total - impuestos);

  // Vencimiento: cbc:DueDate o la última cuota de cac:PaymentTerms. Detracción: PaymentTerms "Detraccion".
  const terminos = hijos(raiz, "PaymentTerms");
  const cuotas = terminos.map((t) => texto(hijo(t, "PaymentDueDate"))).filter(Boolean).sort();
  const det = terminos.find((t) => /detrac/i.test(texto(hijo(t, "ID"))));

  const lineaTag = { Invoice: "InvoiceLine", CreditNote: "CreditNoteLine", DebitNote: "DebitNoteLine" }[tipoRaiz];
  const cantTag = { Invoice: "InvoicedQuantity", CreditNote: "CreditedQuantity", DebitNote: "DebitedQuantity" }[tipoRaiz];
  const items = hijos(raiz, lineaTag).slice(0, 300).map((l) => {
    const cant = hijo(l, cantTag);
    return {
      descripcion: texto(ruta(l, "Item", "Description")).replace(/\s+/g, " ").slice(0, 250),
      cantidad: numero(cant), unidad: cant?.getAttribute("unitCode") || "",
      valorUnitario: numero(ruta(l, "Price", "PriceAmount")), valorVenta: numero(hijo(l, "LineExtensionAmount")),
    };
  });
  const ref = ruta(raiz, "BillingReference", "InvoiceDocumentReference");
  const k = claves(emisor.id, tipo, num.serie, num.numero);
  return {
    ok: true,
    doc: {
      ruc: emisor.id, razonSocial: emisor.nombre, tipo, tipoNombre: TIPOS[tipo],
      serie: k.serie, numero: k.numero, correlativo: texto(hijo(raiz, "ID")).split("-")[1] || String(k.numero),
      comprobante: k.comprobante, facturaPago: k.facturaPago,
      fechaEmision: texto(hijo(raiz, "IssueDate")), fechaVencimiento: texto(hijo(raiz, "DueDate")) || cuotas[cuotas.length - 1] || "",
      moneda: texto(hijo(raiz, "DocumentCurrencyCode")) || "PEN", tipoCambio: 0,
      neto, exento: r2(exento), impuestos: r2(impuestos), total, detraccion: det ? numero(hijo(det, "Amount")) : 0,
      rucReceptor: receptor.id, receptor: receptor.nombre,
      refTipo: texto(hijo(ref, "DocumentTypeCode")), refValor: texto(hijo(ref, "ID")),
      estadoSunat: "", motivoRechazo: "", gosocketId: "",
      items,
    },
    id: k.id,
  };
}

/* ── Excel de Gosocket ("Recibidos" → Exportar a Excel) ─────────── */
export const COLUMNAS_GOSOCKET = [
  ["Id Gosocket", 40], ["Id País", 50], ["Id Externo", 20], ["Fecha de Emisión", 22], ["Fecha de Recepción", 22],
  ["Estado Entidad Tributaria", 25], ["Motivo Rechazo", 50], ["Fecha de Autorización", 23], ["Serie", 13], ["Correlativo", 14],
  ["Número Tipo Documento", 25], ["Tipo Documento", 28], ["Id Emisor", 16], ["Nombre Emisor", 50], ["Division", 13],
  ["Id Receptor", 16], ["Nombre Receptor", 35], ["Monto Neto", 15], ["Monto Exento", 17], ["Monto Impuestos", 19],
  ["Monto Total", 15], ["Moneda", 13], ["Tipo Cambio", 15], ["Anulado", 14], ["Nota de Crédito", 18],
  ["Factorizado", 15], ["Pagado", 13], ["Fecha Pago", 14], ["GosocketLink", 50], ["Número de operación", 23],
  ["Referencia-Tipo", 18], ["Referencia-TipoDocumento", 27], ["Referencia-Valor", 50], ["Referencia-Fecha", 25], ["Referencia-GosocketDocumentId", 38],
  ["Referencia-GosocketLink", 50], ["SmartSupply-Id-Envío", 22], ["SmartSupply-Fecha-Envío", 25], ["Estado Comercial", 19], ["Motivo Rechazo Comercial", 26],
  ["Fecha de Emisión Reclamo", 25], ["Usuario Reclamo", 18], ["Descripcion Reclamo", 25], ["Usuario creación", 18], ["Distribuido", 13],
  ["Emails Enviados", 30], ["Archivo Distribuido", 20], ["PdfLink", 20], ["XmlLink", 20], ["Monto NF", 13],
  ["Monto Periodo", 15], ["Total Periodo", 15], ["Sucursal", 13],
].map(([titulo, ancho]) => ({ titulo, ancho }));

const ddmmaaaa = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : "");
const enlaceGosocket = (id, tipo) => (!id ? "" : {
  ver: `https://www2.gosocket.net/Inbox/Viewer?documentId=${id}`,
  pdf: `https://www2.gosocket.net/Inbox/PdfApiCallViewTemp3?documentId=${id}&countryId=pe`,
  xml: `https://www2.gosocket.net/Inbox/XmlApiCallTemp3?documentId=${id}&countryId=pe`,
}[tipo]);
export { enlaceGosocket };

/** "01-10-2026T00:00:00" → "2026-10-01"; "10/16/2026 12:00:00 AM" → "2026-10-16". */
function fechaGosocket(s) {
  let m = String(s || "").match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}
const urlDe = (formula) => /HYPERLINK\("([^"]+)"/i.exec(formula || "")?.[1] || "";

/**
 * Filas del Excel de Gosocket → [{ ok, id, doc } | { ok: false, motivo, nombre }].
 * Solo facturas, boletas y notas (las guías de remisión no son comprobantes de pago).
 */
export function filasGosocket(filas) {
  const enc = (filas[0] || []).map((t) => String(t).trim());
  const i = (titulo) => enc.indexOf(titulo);
  if (i("Id Gosocket") < 0 || i("Id Emisor") < 0 || i("Correlativo") < 0) return null;   // no es el Excel de Gosocket
  const v = (f, titulo) => (i(titulo) >= 0 ? String(f[i(titulo)] ?? "").trim() : "");
  return filas.slice(1).filter((f) => f.some((c) => c !== "")).map((f) => {
    const tipo = v(f, "Número Tipo Documento").padStart(2, "0"), ruc = v(f, "Id Emisor");
    const nombre = `${v(f, "Serie")}-${v(f, "Correlativo")} · ${v(f, "Nombre Emisor")}`;
    if (!TIPOS[tipo]) return { ok: false, omitir: true, nombre, motivo: `${v(f, "Tipo Documento") || "Tipo " + tipo}: no es un comprobante de pago.` };
    if (!/^\d{11}$/.test(ruc)) return { ok: false, nombre, motivo: "Sin RUC de emisor válido." };
    const k = claves(ruc, tipo, v(f, "Serie"), v(f, "Correlativo"));
    if (!/^[A-Z0-9]{4}$/.test(k.serie) || !k.numero) return { ok: false, nombre, motivo: "Serie o correlativo no válidos." };
    const num = (titulo) => r2(v(f, titulo));
    return {
      ok: true, id: k.id, nombre,
      doc: {
        ruc, razonSocial: v(f, "Nombre Emisor"), tipo, tipoNombre: TIPOS[tipo],
        serie: k.serie, numero: k.numero, correlativo: v(f, "Correlativo"), comprobante: k.comprobante, facturaPago: k.facturaPago,
        fechaEmision: fechaGosocket(v(f, "Fecha de Emisión")), fechaVencimiento: "", fechaRecepcion: v(f, "Fecha de Recepción"),
        moneda: v(f, "Moneda") || "PEN", tipoCambio: num("Tipo Cambio"),
        neto: num("Monto Neto"), exento: num("Monto Exento"), impuestos: num("Monto Impuestos"), total: num("Monto Total"), detraccion: 0,
        rucReceptor: v(f, "Id Receptor"), receptor: v(f, "Nombre Receptor"),
        refTipo: v(f, "Referencia-TipoDocumento"), refValor: v(f, "Referencia-Valor").split(",")[0].trim(),
        estadoSunat: v(f, "Estado Entidad Tributaria").toUpperCase(), motivoRechazo: v(f, "Motivo Rechazo").slice(0, 300),
        gosocketId: v(f, "Id Gosocket") || /documentId=([\w-]+)/.exec(urlDe(v(f, "GosocketLink")))?.[1] || "",
        items: [],
      },
    };
  });
}

/** Un comprobante (con su pago, si lo hay) como fila del Excel con el formato de Gosocket. */
export function filaGosocket(c, pago) {
  const fechaRec = c.fechaRecepcion || (c.subidoEn?.toDate ? (() => {
    const d = c.subidoEn.toDate(), p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  })() : "");
  const g = c.gosocketId;
  const valores = {
    "Id Gosocket": g || c.id, "Id País": c.hash || "", "Fecha de Emisión": c.fechaEmision ? `${ddmmaaaa(c.fechaEmision)}T00:00:00` : "",
    "Fecha de Recepción": fechaRec, "Estado Entidad Tributaria": c.estadoSunat || "RECIBIDO", "Motivo Rechazo": c.motivoRechazo || "",
    "Serie": c.serie, "Correlativo": c.correlativo || String(c.numero), "Número Tipo Documento": String(Number(c.tipo)),
    "Tipo Documento": c.tipoNombre || TIPOS[c.tipo] || "", "Id Emisor": c.ruc, "Nombre Emisor": c.razonSocial,
    "Id Receptor": c.rucReceptor || "", "Nombre Receptor": c.receptor || "",
    "Monto Neto": Number(c.neto) || 0, "Monto Exento": Number(c.exento) || 0, "Monto Impuestos": Number(c.impuestos) || 0,
    "Monto Total": Number(c.total) || 0, "Moneda": c.moneda || "PEN", "Tipo Cambio": Number(c.tipoCambio) || 0,
    "Anulado": c.estadoSunat === "ANULADO" ? "Si" : "", "Pagado": pago ? "Si" : "No", "Fecha Pago": pago ? ddmmaaaa(pago.fechaPago) : "",
    "GosocketLink": g ? { enlace: enlaceGosocket(g, "ver"), texto: enlaceGosocket(g, "ver") } : "",
    "Número de operación": pago ? pago.lote || "" : "",
    "Referencia-TipoDocumento": c.refTipo || "", "Referencia-Valor": c.refValor || "",
    "Usuario creación": { proveedor: "Proveedor (portal)", hotel: "Contabilidad (portal)", gosocket: "Gosocket" }[c.origen] || "",
    "Distribuido": "No",
    "PdfLink": g ? { enlace: enlaceGosocket(g, "pdf"), texto: "Abrir en Navegador" } : "",
    "XmlLink": g ? { enlace: enlaceGosocket(g, "xml"), texto: "Descargar XML" } : "",
    "Monto NF": 0, "Monto Periodo": 0, "Total Periodo": 0,
  };
  return COLUMNAS_GOSOCKET.map((col) => valores[col.titulo] ?? "");
}
