/* ══════════════════════════════════════════════════════════════════
   RETENCIONES (comprobante de retención SUNAT tipo 20, R001-…)
   Las emite el hotel como agente de retención (3 %) al pagar. Contabilidad
   sube los XML (+ PDF, ZIP o carpeta) y cada proveedor ve y descarga los
   suyos. Al guardarlas se completan los pagos del TXT (bruto y retención),
   y al cargar un TXT después se usan las retenciones ya guardadas.
   ══════════════════════════════════════════════════════════════════ */
import { db } from "./firebase.js";
import {
  collection, query, where, orderBy, getDocs, getDoc, doc, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { $, esc, icono, monto, fechaCorta, hoyISO, abrirModal, confirmar, notificar } from "./util.js";
import { puedeGestionar } from "./roles.js";
import { idPago } from "./bcp.js";
import { TIPOS, leerNumero } from "./sunat.js";
import { htmlCarga, montarCarga, descargarBlob, deBase64 } from "./comprobantes.js";
import { descargarXlsx } from "./zip.js";
import { paginaServidor } from "./paginaServidor.js";
import { RUC_HOTEL, RAZON_SOCIAL_HOTEL, EMPRESA } from "./config.js";

const colRet = () => collection(db, "retenciones");
const refArchivos = (id) => doc(db, "retenciones_archivos", id);
const nombreSunat = (r, ext) => `${r.rucAgente || RUC_HOTEL}-20-${r.serie}-${String(r.numero).padStart(8, "0")}.${ext}`;
const facturas = (r) => (r.documentos || []).map((d) => d.comprobante).join(", ");

/* ── Cruce con los pagos del TXT ─────────────────────────────────── */
const casi = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.011;

/**
 * Tras guardar retenciones: a cada pago del TXT que cuadra (mismo RUC, factura, fecha de abono y neto)
 * le pone el bruto y la retención. Devuelve el texto para el resumen de la carga.
 */
export async function completarPagosConRetenciones(retenciones) {
  const cambios = [];
  for (const r of retenciones) {
    for (const d of r.documentos || []) {
      if (!d.facturaPago || !d.fechaPago) continue;
      const ref = doc(db, "pagos", idPago(r.ruc, d.facturaPago, d.fechaPago.replace(/-/g, "")));
      const snap = await getDoc(ref);
      if (!snap.exists()) continue;
      const p = snap.data();
      if (casi(p.neto, d.neto) && (!casi(p.retencion, d.retenido) || !casi(p.bruto, d.pagado))) cambios.push([ref, { bruto: d.pagado, retencion: d.retenido }]);
    }
  }
  for (let i = 0; i < cambios.length; i += 450) {
    const lote = writeBatch(db);
    cambios.slice(i, i + 450).forEach(([ref, datos]) => lote.update(ref, datos));
    await lote.commit();
  }
  return cambios.length ? `${cambios.length} pago(s) completados con su retención` : "";
}

/** Al cargar un TXT: pone bruto y retención a sus pagos con las retenciones ya guardadas de esa fecha de abono. */
export async function aplicarRetencionesAPagos(pagos, fechaPago) {
  if (!fechaPago || !pagos.length) return 0;
  const snap = await getDocs(query(colRet(), where("fechasPago", "array-contains", fechaPago)));
  const mapa = new Map();
  for (const s of snap.docs) {
    const r = s.data();
    for (const d of r.documentos || []) if (d.fechaPago === fechaPago) mapa.set(`${r.ruc}|${d.facturaPago}`, d);
  }
  let n = 0;
  for (const p of pagos) {
    const d = mapa.get(`${p.ruc}|${p.factura}`);
    if (d && casi(p.neto, d.neto) && !p.retencion) { p.bruto = d.pagado; p.retencion = d.retenido; n++; }
  }
  return n;
}

/* ── Archivos ───────────────────────────────────────────────────── */
async function bajar(r, tipo) {
  if (!r.tieneXml || (tipo === "pdf" && !r.tienePdf)) return tipo === "pdf" ? representacion(r) : notificar("Esta retención no tiene su XML en el portal", "error");
  try {
    const snap = await getDoc(refArchivos(r.id));
    if (!snap.exists()) return tipo === "pdf" ? representacion(r) : notificar("No se encontró el XML", "error");
    const a = snap.data();
    if (tipo === "xml") descargarBlob(new Blob([a.xml], { type: "application/xml" }), nombreSunat(r, "xml"));
    else if (a.pdf) descargarBlob(new Blob([deBase64(a.pdf)], { type: "application/pdf" }), nombreSunat(r, "pdf"));
    else representacion(r);
  } catch (err) {
    console.error("Portal: no se pudo bajar la retención", err);
    notificar("No se pudo descargar el archivo", "error");
  }
}
const botones = (r, i) => `
  <button type="button" class="btn chico" data-bajar="pdf" data-i="${i}" title="${r.tienePdf ? "PDF original" : "Representación impresa"}">${icono("bajar")}PDF</button>
  <button type="button" class="btn chico" data-bajar="xml" data-i="${i}" ${r.tieneXml ? "" : "disabled"}>${icono("bajar")}XML</button>`;

/** Representación impresa del comprobante de retención (para imprimir o guardar como PDF). */
function representacion(r) {
  const docs = r.documentos || [];
  const { el } = abrirModal(`
    <div class="representacion">
      <div class="rep-cab">
        <div><b>${esc(RAZON_SOCIAL_HOTEL)}</b><br><span class="ayuda">${esc(EMPRESA)} · Agente de retención · RUC ${esc(r.rucAgente || RUC_HOTEL)}</span></div>
        <div class="rep-caja"><b>COMPROBANTE DE RETENCIÓN ELECTRÓNICO</b><br>RUC ${esc(r.rucAgente || RUC_HOTEL)}<br><b class="mono">${esc(r.serie)}-${esc(String(r.numero).padStart(8, "0"))}</b></div>
      </div>
      <div class="constancia"><dl>
        <dt>Proveedor</dt><dd>${esc(r.razonSocial)}</dd>
        <dt>RUC</dt><dd class="mono">${esc(r.ruc)}</dd>
        <dt>Fecha de emisión</dt><dd>${fechaCorta(r.fechaEmision)}</dd>
        <dt>Régimen</dt><dd>Tasa ${esc(r.porcentaje)} %</dd>
      </dl></div>
      <div class="tabla-caja" style="margin-top:12px"><table>
        <thead><tr><th>Comprobante</th><th>Emisión</th><th class="num">Importe</th><th>Pago</th><th class="num">Pagado</th><th class="num">Retenido</th><th class="num">Neto pagado</th></tr></thead>
        <tbody>${docs.map((d) => `<tr><td class="mono">${esc(TIPOS[d.tipo] ? d.comprobante : `${d.tipo} ${d.comprobante}`)}</td><td>${fechaCorta(d.fechaEmision)}</td>
          <td class="num">${monto(d.total, r.moneda)}</td><td>${fechaCorta(d.fechaPago)}</td><td class="num">${monto(d.pagado, r.moneda)}</td>
          <td class="num descuento">${monto(d.retenido, r.moneda)}</td><td class="num neto">${monto(d.neto, r.moneda)}</td></tr>`).join("")}</tbody>
      </table></div>
      <div class="constancia"><dl style="margin-top:12px">
        <dt>Total pagado</dt><dd class="mono">${monto(r.totalPagado, r.moneda)}</dd>
      </dl>
      <div class="total"><span>Total retenido</span><span class="mono">${monto(r.total, r.moneda)}</span></div></div>
      <p class="ayuda">Representación impresa generada por el Portal de Proveedores con los datos del comprobante de retención electrónico.
        No reemplaza al comprobante original (XML) registrado en SUNAT.</p>
      <div class="modal-pie no-imprimir">
        <button type="button" class="btn" data-cerrar>Cerrar</button>
        <button type="button" class="btn oscuro" data-imprimir>${icono("impresora")}Imprimir / Guardar PDF</button>
      </div>
    </div>`, { ancho: true, alCerrar: () => document.body.classList.remove("imprimiendo-modal") });
  el.querySelector("[data-imprimir]").addEventListener("click", () => {
    document.body.classList.add("imprimiendo-modal");
    window.print();
    document.body.classList.remove("imprimiendo-modal");
  });
}

/* ── Pestaña Retenciones (hotel y proveedor) ─────────────────────── */
export function vistaRetenciones(cont, ctx, { proveedor = false } = {}) {
  const ruc = ctx.perfil.ruc, gestiona = !proveedor && puedeGestionar(ctx.perfil.rol);
  cont.innerHTML = `
    ${gestiona ? htmlCarga("ret", {
      titulo: "Subir retenciones",
      texto: "Sube los <b>XML</b> de los comprobantes de retención (y su <b>PDF</b> con el mismo nombre), un <b>ZIP</b> o la <b>carpeta</b> completa. Se guardan solos, nunca se duplican y cada proveedor ve los suyos. Además se completa la retención de cada pago del TXT.",
      detalle: `XML (+ PDF) o ZIP · emitidas por el RUC ${esc(RUC_HOTEL)}`,
      acepta: ".xml,.pdf,.zip",
    }) : ""}
    <div class="panel">
      <div class="panel-titulo">
        <div><h2>${proveedor ? "Mis retenciones" : "Comprobantes de retención"}</h2><p id="desc-ret"></p></div>
        <div class="acciones"><button type="button" class="btn chico" id="excel-ret">${icono("bajar")}Excel</button></div>
      </div>
      <form class="barra-filtros" id="filtros-ret">
        <label class="campo"><span>Emitida desde</span><input class="input chico" type="date" id="fr-desde"></label>
        <label class="campo"><span>Hasta</span><input class="input chico" type="date" id="fr-hasta"></label>
        <label class="campo crece"><span>Buscar</span><input class="input chico" style="width:100%" id="fr-buscar" autocomplete="off"
          placeholder="${proveedor ? "N° de retención: R001-8726" : "RUC del proveedor (11 dígitos) o N° de retención: R001-8726"}"></label>
        <button class="btn oscuro" type="submit">${icono("buscar")}Buscar</button>
      </form>
      <p class="error" id="fr-error" hidden></p>
      <div class="tabla-caja"><table>
        <thead><tr><th>Emisión</th><th>Retención</th>${proveedor ? "" : "<th>RUC</th><th>Proveedor</th>"}<th>Facturas</th>
          <th class="num">Total pagado</th><th class="num">Retenido</th><th>Archivos</th></tr></thead>
        <tbody id="tb-ret"><tr><td colspan="8" class="vacio">Cargando…</td></tr></tbody>
      </table></div>
      <div id="pag-ret"></div>
      ${proveedor ? `<p class="ayuda">La retención (3 %) se descuenta del pago y se declara a SUNAT a tu favor. Toca una retención para ver su detalle.</p>` : ""}
    </div>`;

  let actual = null, filas = [];
  function armarConsulta() {
    const desde = $("#fr-desde", cont).value, hasta = $("#fr-hasta", cont).value, t = $("#fr-buscar", cont).value.trim(), n = leerNumero(t);
    const filtros = proveedor ? [where("ruc", "==", ruc)] : [];
    if (n) return { col: colRet(), filtros: [...filtros, where("comprobante", "==", `${n.serie}-${n.numero}`)], orden: [orderBy("fechaEmision", "desc")], desc: `Retención ${n.serie}-${n.numero}.` };
    if (t && (proveedor || !/^\d{11}$/.test(t))) return { error: proveedor ? "Escribe el número completo: R001-8726." : "Escribe un RUC de 11 dígitos o el número de retención (R001-8726)." };
    if (t) filtros.push(where("ruc", "==", t));
    if (desde) filtros.push(where("fechaEmision", ">=", desde));
    if (hasta) filtros.push(where("fechaEmision", "<=", hasta));
    return { col: colRet(), filtros, orden: [orderBy("fechaEmision", "desc")],
      desc: `${t ? `RUC ${t} · ` : ""}${desde || hasta ? `Emitidas${desde ? ` desde el ${fechaCorta(desde)}` : ""}${hasta ? ` hasta el ${fechaCorta(hasta)}` : ""}` : "Todas las fechas"}.` };
  }
  const ps = paginaServidor({
    clave: proveedor ? "prov-retenciones" : "adm-retenciones", etiqueta: "retenciones", barra: $("#pag-ret", cont),
    consulta: () => actual,
    pintar: (docs) => {
      filas = docs.map((d) => ({ id: d.id, ...d.data() }));
      $("#tb-ret", cont).innerHTML = filas.map((r, i) => `<tr class="clic" data-i="${i}" tabindex="0">
        <td>${fechaCorta(r.fechaEmision)}</td><td class="mono">${esc(r.comprobante)}</td>
        ${proveedor ? "" : `<td class="mono">${esc(r.ruc)}</td><td>${esc(r.razonSocial)}</td>`}
        <td class="mono" style="font-size:11px">${esc(facturas(r))}</td>
        <td class="num">${monto(r.totalPagado, r.moneda)}</td><td class="num neto">${monto(r.total, r.moneda)}</td>
        <td><div class="acciones">${botones(r, i)}</div></td></tr>`).join("")
        || `<tr><td colspan="8" class="vacio">${proveedor ? "Aún no tienes retenciones con estos filtros." : "No hay retenciones con estos filtros."}</td></tr>`;
    },
    alError: (err) => {
      console.error("Portal: no se pudieron leer las retenciones", err);
      $("#tb-ret", cont).innerHTML = `<tr><td colspan="8" class="vacio">No se pudieron cargar las retenciones (${esc(err.code || err.message)}).</td></tr>`;
    },
  });
  function buscar() {
    const c = armarConsulta();
    $("#fr-error", cont).hidden = !c.error;
    if (c.error) { $("#fr-error", cont).textContent = c.error; return; }
    actual = c;
    $("#desc-ret", cont).textContent = `${c.desc} Toca una retención para ver su detalle.`;
    ps.cargar(true);
  }
  $("#filtros-ret", cont).addEventListener("submit", (e) => { e.preventDefault(); buscar(); });
  $("#tb-ret", cont).addEventListener("click", (e) => {
    const b = e.target.closest("[data-bajar]");
    if (b) { if (!b.disabled) bajar(filas[Number(b.dataset.i)], b.dataset.bajar); return; }
    const tr = e.target.closest("tr[data-i]");
    if (tr) detalle(filas[Number(tr.dataset.i)], { gestiona, alBorrar: () => ps.recargar() });
  });
  $("#tb-ret", cont).addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("tr[data-i]")) e.target.click(); });

  // Excel: una fila por factura de cada retención.
  $("#excel-ret", cont).addEventListener("click", async () => {
    if (!actual) return;
    const total = ps.estado.total;
    if (total > 500 && !(await confirmar({ titulo: "Descargar retenciones", textoOk: "Descargar",
      mensaje: `Se descargarán las ${total.toLocaleString("es-PE")} retenciones de esta consulta.` }))) return;
    try {
      const snap = await getDocs(query(actual.col, ...actual.filtros, ...actual.orden));
      const filasX = snap.docs.flatMap((s) => { const r = s.data(); return (r.documentos || []).map((d) => [
        r.fechaEmision, r.comprobante, r.ruc, r.razonSocial, d.comprobante, d.fechaEmision, Number(d.total) || 0, d.fechaPago,
        Number(d.pagado) || 0, Number(d.retenido) || 0, Number(d.neto) || 0, r.moneda || "PEN"]); });
      const columnas = ["Fecha retención", "Retención", "RUC", "Proveedor", "Comprobante", "Fecha comprobante", "Importe", "Fecha pago",
        "Pagado", "Retenido", "Neto pagado", "Moneda"].map((titulo, i) => ({ titulo, ancho: [14, 14, 14, 40, 16, 16, 13, 13, 13, 13, 13, 9][i] }));
      descargarXlsx(`retenciones_${hoyISO()}.xlsx`, "Retenciones", columnas, filasX);
    } catch (err) {
      console.error("Portal: no se pudo descargar", err);
      notificar("No se pudo descargar", "error");
    }
  });

  if (gestiona) montarCarga(cont, ctx, { modo: "retenciones", alGuardar: () => ps.recargar(), despues: completarPagosConRetenciones });
  buscar();
  return () => ps.detener();
}

/* ── Detalle ────────────────────────────────────────────────────── */
function detalle(r, { gestiona, alBorrar }) {
  if (!r) return;
  const { el, cerrar } = abrirModal(`
    <div class="modal-cab"><h2>Retención ${esc(r.comprobante)}</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
    <p class="modal-sub">${esc(r.razonSocial)} · RUC ${esc(r.ruc)} · emitida el ${fechaCorta(r.fechaEmision)} · tasa ${esc(r.porcentaje)} %</p>
    <div class="tabla-caja"><table>
      <thead><tr><th>Comprobante</th><th>Pago</th><th class="num">Pagado</th><th class="num">Retenido</th><th class="num">Neto</th></tr></thead>
      <tbody>${(r.documentos || []).map((d) => `<tr><td class="mono">${esc(d.comprobante)}</td><td>${fechaCorta(d.fechaPago)}</td>
        <td class="num">${monto(d.pagado, r.moneda)}</td><td class="num descuento">${monto(d.retenido, r.moneda)}</td><td class="num neto">${monto(d.neto, r.moneda)}</td></tr>`).join("")}</tbody>
    </table></div>
    <div class="constancia"><div class="total"><span>Total retenido</span><span class="mono">${monto(r.total, r.moneda)}</span></div></div>
    <div class="modal-pie">
      ${gestiona ? `<button type="button" class="btn rojo" data-borrar>Eliminar</button>` : ""}
      ${botones(r, 0)}
      <button type="button" class="btn oscuro" data-cerrar>Cerrar</button>
    </div>`, { ancho: true });
  el.querySelectorAll("[data-bajar]").forEach((b) => b.addEventListener("click", () => { if (b.dataset.bajar === "pdf" && !r.tienePdf) cerrar(); bajar(r, b.dataset.bajar); }));
  el.querySelector("[data-borrar]")?.addEventListener("click", async () => {
    if (!(await confirmar({ titulo: "Eliminar retención", textoOk: "Eliminar", peligroso: true,
      mensaje: `Se eliminará la retención ${r.comprobante} de ${r.razonSocial} del portal (no de SUNAT). Los pagos conservan su retención.` }))) return;
    try {
      const lote = writeBatch(db);
      lote.delete(doc(db, "retenciones", r.id));
      lote.delete(refArchivos(r.id));
      await lote.commit();
      cerrar(); notificar("Retención eliminada"); alBorrar();
    } catch (err) { console.error("Portal: no se pudo eliminar", err); notificar("No se pudo eliminar", "error"); }
  });
}
