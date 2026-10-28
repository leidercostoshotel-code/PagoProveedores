/* ══════════════════════════════════════════════════════════════════
   COMPROBANTES ELECTRÓNICOS (facturas recibidas, estilo Gosocket)
   Una sola pantalla para el hotel y para el proveedor:
   - Subir: XML de SUNAT o ZIP con varios (proveedor y Contabilidad) y el
     Excel "Recibidos" de Gosocket (solo Contabilidad). Se guarda solo y no
     se duplica nunca (ID = RUC_TIPO_SERIE-NÚMERO + huella del archivo).
   - Lista paginada en el servidor, cruzada con los pagos de los TXT
     ("Pagado el …" / "Pendiente") y descarga a Excel con el formato de Gosocket.
   - Cada comprobante se baja en XML (el original) y PDF (el que subió el
     proveedor junto a su XML o, si no, la representación impresa). Los
     archivos van en comprobantes_archivos/{id} para no cargarlos en las listas.
   El proveedor solo sube y ve los de su RUC (lo garantiza firestore.rules).
   ══════════════════════════════════════════════════════════════════ */
import { db } from "./firebase.js";
import {
  collection, query, where, orderBy, getDocs, getDoc, doc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  $, esc, icono, monto, fechaCorta, hoyISO, abrirModal, confirmar, notificar, paginador, archivosSoltados,
} from "./util.js";
import { puedeGestionar } from "./roles.js";
import { huellaArchivo } from "./bcp.js";
import { leerZip, leerXlsx, textoXml, descargarXlsx } from "./zip.js";
import { TIPOS, leerXmlSunat, leerNumero, filasGosocket, COLUMNAS_GOSOCKET, filaGosocket, enlaceGosocket } from "./sunat.js";
import { constancia } from "./vista-proveedor.js";
import { paginaServidor } from "./paginaServidor.js";
import { RUC_HOTEL } from "./config.js";

const colComp = () => collection(db, "comprobantes");
const refArchivos = (id) => doc(db, "comprobantes_archivos", id);
const MB = 1024 * 1024, MAX_ARCHIVO = 20 * MB;
// Un documento de Firestore admite hasta 1 MiB: XML + PDF (en base64) deben caber juntos.
const MAX_GUARDADO = 950000;
const ESTADOS_CARGA = {
  nuevo: ["pendiente", "Nuevo"], cambio: ["pendiente", "Ya cargado · cambió"], estado: ["pendiente", "Actualiza estado"],
  igual: ["neutro", "Ya cargado · se omite"], repetido: ["neutro", "Repetido"], omitido: ["neutro", "Se omite"], rechazado: ["inactivo", "Rechazado"],
  guardando: ["pendiente", "Guardando…"], guardado: ["activo", "Guardado"], error: ["inactivo", "Error"],
};
const chip = (clase, texto) => `<span class="etiqueta-estado ${clase}">${esc(texto)}</span>`;

/** Estado de pago de un comprobante (cruce con los TXT del banco). */
function chipPago(c, pago) {
  if (c.estadoSunat === "RECHAZADO") return chip("inactivo", "Rechazado SUNAT");
  if (c.estadoSunat === "ANULADO") return chip("inactivo", "Anulado");
  if (c.tipo === "07") return chip("neutro", "Nota de crédito");
  return pago ? chip("activo", `Pagado ${fechaCorta(pago.fechaPago)}`) : chip("pendiente", "Pendiente de pago");
}

/** Pagos de una lista de comprobantes: Map "RUC|FACTURA_DEL_TXT" → pago (el más reciente). */
async function pagosDe(lista, rucProveedor) {
  const mapa = new Map(), facturas = [...new Set(lista.map((c) => c.facturaPago).filter(Boolean))];
  for (let i = 0; i < facturas.length; i += 30) {
    const filtros = [where("factura", "in", facturas.slice(i, i + 30))];
    if (rucProveedor) filtros.unshift(where("ruc", "==", rucProveedor));   // el proveedor solo puede consultar los suyos
    const snap = await getDocs(query(collection(db, "pagos"), ...filtros));
    for (const d of snap.docs) {
      const p = d.data(), k = `${p.ruc}|${p.factura}`;
      if (!mapa.has(k) || p.fechaPago > mapa.get(k).fechaPago) mapa.set(k, p);
    }
  }
  return mapa;
}
const pagoDe = (mapa, c) => mapa.get(`${c.ruc}|${c.facturaPago}`) || null;

/* ── Archivos: XML original y PDF ────────────────────────────────── */
const aBase64 = (bytes) => { let t = ""; for (let i = 0; i < bytes.length; i += 0x8000) t += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(t); };
const deBase64 = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
const bytesTexto = (t) => new TextEncoder().encode(t).length;
// Nombre SUNAT: RUC-TIPO-SERIE-NÚMERO (8 dígitos).
const nombreSunat = (c, ext) => `${c.ruc}-${c.tipo}-${c.serie}-${String(c.numero).padStart(8, "0")}.${ext}`;
function descargarBlob(blob, nombre) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: nombre });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const hayXml = (c, proveedor) => c.tieneXml || (!proveedor && !!c.gosocketId);

/** Baja el XML o el PDF de un comprobante. Sin PDF guardado: representación impresa (para guardar como PDF). */
async function bajarArchivo(c, tipo, { proveedor }) {
  if (!c.tieneXml) {
    if (!proveedor && c.gosocketId) { window.open(enlaceGosocket(c.gosocketId, tipo), "_blank", "noopener"); return; }
    if (tipo === "pdf") return representacion(c);
    return notificar("Este comprobante no tiene su XML en el portal", "error");
  }
  if (tipo === "pdf" && !c.tienePdf) return representacion(c);
  try {
    const snap = await getDoc(refArchivos(c.id));
    if (!snap.exists()) return tipo === "pdf" ? representacion(c) : notificar("No se encontró el XML", "error");
    const a = snap.data();
    if (tipo === "xml") descargarBlob(new Blob([a.xml], { type: "application/xml" }), nombreSunat(c, "xml"));
    else if (a.pdf) descargarBlob(new Blob([deBase64(a.pdf)], { type: "application/pdf" }), nombreSunat(c, "pdf"));
    else representacion(c);
  } catch (err) {
    console.error("Portal: no se pudo bajar el archivo", err);
    notificar("No se pudo descargar el archivo", "error");
  }
}

/** Representación impresa del comprobante (desde sus datos): se imprime o se guarda como PDF. */
function representacion(c) {
  const items = c.items || [];
  const { el } = abrirModal(`
    <div class="representacion">
      <div class="rep-cab">
        <div><b>${esc(c.razonSocial)}</b><br><span class="ayuda">RUC ${esc(c.ruc)}</span></div>
        <div class="rep-caja"><b>${esc((c.tipoNombre || TIPOS[c.tipo] || "").toUpperCase())}</b><br>RUC ${esc(c.ruc)}<br><b class="mono">${esc(c.serie)}-${esc(String(c.numero).padStart(8, "0"))}</b></div>
      </div>
      <div class="constancia"><dl>
        <dt>Señor(es)</dt><dd>${esc(c.receptor || "—")}</dd>
        <dt>RUC</dt><dd class="mono">${esc(c.rucReceptor || "—")}</dd>
        <dt>Fecha de emisión</dt><dd>${fechaCorta(c.fechaEmision)}</dd>
        ${c.fechaVencimiento ? `<dt>Fecha de vencimiento</dt><dd>${fechaCorta(c.fechaVencimiento)}</dd>` : ""}
        <dt>Moneda</dt><dd>${c.moneda === "USD" ? "Dólares americanos" : "Soles"}</dd>
        ${c.refValor ? `<dt>Documento que modifica</dt><dd class="mono">${esc(c.refValor)}</dd>` : ""}
      </dl></div>
      ${items.length ? `<div class="tabla-caja" style="margin-top:12px"><table>
        <thead><tr><th class="num">Cant.</th><th>Unidad</th><th>Descripción</th><th class="num">Valor unit.</th><th class="num">Valor venta</th></tr></thead>
        <tbody>${items.map((it) => `<tr><td class="num">${esc(it.cantidad)}</td><td>${esc(it.unidad)}</td><td>${esc(it.descripcion)}</td>
          <td class="num">${monto(it.valorUnitario, c.moneda)}</td><td class="num">${monto(it.valorVenta, c.moneda)}</td></tr>`).join("")}</tbody>
      </table></div>` : ""}
      <div class="constancia"><dl style="margin-top:12px">
        <dt>Op. gravadas</dt><dd class="mono">${monto((Number(c.neto) || 0) - (Number(c.exento) || 0), c.moneda)}</dd>
        ${c.exento ? `<dt>Op. exoneradas / inafectas</dt><dd class="mono">${monto(c.exento, c.moneda)}</dd>` : ""}
        <dt>IGV</dt><dd class="mono">${monto(c.impuestos, c.moneda)}</dd>
        ${c.detraccion ? `<dt>Detracción</dt><dd class="mono">${monto(c.detraccion, c.moneda)}</dd>` : ""}
      </dl>
      <div class="total"><span>Importe total</span><span class="mono">${monto(c.total, c.moneda)}</span></div></div>
      <p class="ayuda">Representación impresa generada por el Portal de Proveedores con los datos del comprobante electrónico.
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

export function vistaComprobantes(cont, ctx, { proveedor = false } = {}) {
  const ruc = ctx.perfil.ruc, gestiona = puedeGestionar(ctx.perfil.rol);
  const puedeSubir = proveedor || gestiona;
  cont.innerHTML = `
    ${puedeSubir ? `<div class="panel">
      <div class="panel-titulo"><div><h2>${proveedor ? "Enviar mis comprobantes" : "Subir comprobantes"}</h2>
        <p>${proveedor
          ? "Sube el <b>XML</b> de tus facturas o notas de crédito y, si quieres, su <b>PDF</b> con el mismo nombre (o un <b>ZIP</b> con todo). Se guardan solos y Contabilidad los ve al instante."
          : "Sube los <b>XML</b> de SUNAT con su <b>PDF</b> (o un <b>ZIP</b>) o el <b>Excel de Gosocket</b> (Recibidos → Exportar). Se guarda solo y nunca se duplica."}</p></div></div>
      <div class="zona-archivo" id="zona-comp">
        ${icono("subir")}<b>Arrastra aquí la carpeta o los archivos</b>
        <small>${proveedor ? "XML (+ PDF opcional) o ZIP" : "XML (+ PDF), ZIP o Excel (.xlsx) de Gosocket"} · la carpeta entra también en sus subcarpetas · hasta 20 MB por archivo${RUC_HOTEL ? ` · dirigidos al RUC ${esc(RUC_HOTEL)}` : ""}</small>
        <span class="acciones" style="margin-top:6px">
          <button type="button" class="btn chico oscuro" id="btn-carpeta-comp">${icono("capas")}Elegir carpeta</button>
          <button type="button" class="btn chico" id="btn-archivos-comp">${icono("archivo")}Elegir archivos</button>
        </span>
        <input type="file" id="in-comp" multiple accept=".xml,.pdf,.zip${proveedor ? "" : ",.xlsx"}" class="sr-only">
        <input type="file" id="in-comp-carpeta" webkitdirectory directory multiple class="sr-only">
      </div>
      <div id="carga-comp"></div>
    </div>` : ""}
    <div class="panel">
      <div class="panel-titulo">
        <div><h2>${proveedor ? "Mis comprobantes" : "Comprobantes recibidos"}</h2><p id="desc-comp">Toca un comprobante para ver su detalle.</p></div>
        <div class="acciones"><button type="button" class="btn chico" id="excel-comp">${icono("bajar")}Excel (formato Gosocket)</button></div>
      </div>
      <form class="barra-filtros" id="filtros-comp">
        <label class="campo"><span>Emitido desde</span><input class="input chico" type="date" id="fc-desde"></label>
        <label class="campo"><span>Hasta</span><input class="input chico" type="date" id="fc-hasta"></label>
        <label class="campo"><span>Tipo</span><select class="select chico" id="fc-tipo"><option value="">Todos</option>
          ${Object.entries(TIPOS).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join("")}</select></label>
        <label class="campo crece"><span>Buscar</span><input class="input chico" style="width:100%" id="fc-buscar" autocomplete="off"
          placeholder="${proveedor ? "N° de comprobante: F001-46937" : "RUC (11 dígitos) o N° de comprobante: F001-46937"}"></label>
        <button class="btn oscuro" type="submit">${icono("buscar")}Buscar</button>
      </form>
      <p class="error" id="fc-error" hidden></p>
      <div class="tabla-caja"><table>
        <thead><tr><th>Emisión</th>${proveedor ? "" : "<th>RUC</th><th>Emisor</th>"}<th>Comprobante</th><th>Tipo</th>
          <th class="num">Total</th><th>Vence</th><th>Pago</th><th>Origen</th><th>Archivos</th></tr></thead>
        <tbody id="tb-comp"><tr><td colspan="10" class="vacio">Cargando…</td></tr></tbody>
      </table></div>
      <div id="pag-comp"></div>
    </div>`;

  /* ── Lista (paginada en el servidor) ─────────────────────────── */
  let actual = null, filas = [], mapaPagos = new Map();
  function armarConsulta() {
    const desde = $("#fc-desde", cont).value, hasta = $("#fc-hasta", cont).value, tipo = $("#fc-tipo", cont).value;
    const t = $("#fc-buscar", cont).value.trim(), n = leerNumero(t);
    const filtros = proveedor ? [where("ruc", "==", ruc)] : [];
    let desc = "";
    if (n) {   // un número de comprobante se busca en todas las fechas y tipos
      filtros.push(where("comprobante", "==", `${n.serie}-${n.numero}`));
      desc = `Comprobante ${n.serie}-${n.numero}.`;
    } else {
      if (t && (proveedor || !/^\d{11}$/.test(t))) return { error: proveedor ? "Escribe el número completo: F001-46937." : "Escribe un RUC de 11 dígitos o un número de comprobante (F001-46937)." };
      if (t) filtros.push(where("ruc", "==", t));
      if (tipo) filtros.push(where("tipo", "==", tipo));
      if (desde) filtros.push(where("fechaEmision", ">=", desde));
      if (hasta) filtros.push(where("fechaEmision", "<=", hasta));
      desc = `${t ? `RUC ${t} · ` : ""}${tipo ? `${TIPOS[tipo]} · ` : ""}${desde || hasta ? `emitidos${desde ? ` desde el ${fechaCorta(desde)}` : ""}${hasta ? ` hasta el ${fechaCorta(hasta)}` : ""}` : "todas las fechas"}.`;
    }
    return { col: colComp(), filtros, orden: [orderBy("fechaEmision", "desc")], desc };
  }
  const ps = paginaServidor({
    clave: proveedor ? "prov-comprobantes" : "adm-comprobantes", etiqueta: "comprobantes", barra: $("#pag-comp", cont),
    consulta: () => actual,
    pintar: async (docs) => {
      filas = docs.map((d) => ({ id: d.id, ...d.data() }));
      mapaPagos = await pagosDe(filas, proveedor ? ruc : null).catch(() => new Map());
      $("#tb-comp", cont).innerHTML = filas.map((c, i) => `<tr class="clic" data-i="${i}" tabindex="0">
        <td>${fechaCorta(c.fechaEmision)}</td>
        ${proveedor ? "" : `<td class="mono">${esc(c.ruc)}</td><td>${esc(c.razonSocial)}</td>`}
        <td class="mono">${esc(c.comprobante)}</td><td>${esc(c.tipoNombre || TIPOS[c.tipo] || c.tipo)}</td>
        <td class="num neto">${monto(c.total, c.moneda)}</td><td>${c.fechaVencimiento ? fechaCorta(c.fechaVencimiento) : "—"}</td>
        <td>${chipPago(c, pagoDe(mapaPagos, c))}</td><td style="font-size:11px">${textoOrigen(c, proveedor)}</td>
        <td><div class="acciones">${botonesArchivo(c, i, proveedor)}</div></td>
      </tr>`).join("") || `<tr><td colspan="10" class="vacio">${proveedor ? "Aún no has enviado comprobantes con estos filtros." : "No hay comprobantes con estos filtros."}</td></tr>`;
    },
    alError: (err) => {
      console.error("Portal: no se pudieron leer los comprobantes", err);
      $("#tb-comp", cont).innerHTML = `<tr><td colspan="10" class="vacio">No se pudieron cargar los comprobantes (${esc(err.code || err.message)}).</td></tr>`;
    },
  });
  function buscar() {
    const c = armarConsulta();
    $("#fc-error", cont).hidden = !c.error;
    if (c.error) { $("#fc-error", cont).textContent = c.error; return; }
    actual = c;
    $("#desc-comp", cont).textContent = `${c.desc[0].toUpperCase()}${c.desc.slice(1)} Toca un comprobante para ver su detalle.`;
    ps.cargar(true);
  }
  $("#filtros-comp", cont).addEventListener("submit", (e) => { e.preventDefault(); buscar(); });
  $("#tb-comp", cont).addEventListener("click", (e) => {
    const b = e.target.closest("[data-bajar]");
    if (b) { if (!b.disabled) bajarArchivo(filas[Number(b.dataset.i)], b.dataset.bajar, { proveedor }); return; }
    const tr = e.target.closest("tr[data-i]");
    if (tr) detalle(filas[Number(tr.dataset.i)], pagoDe(mapaPagos, filas[Number(tr.dataset.i)]), { proveedor, gestiona, alBorrar: () => ps.recargar() });
  });
  $("#tb-comp", cont).addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("tr[data-i]")) e.target.click(); });

  // Excel con las MISMAS columnas que exporta Gosocket (+ Pagado / Fecha Pago del cruce con los TXT).
  $("#excel-comp", cont).addEventListener("click", async () => {
    if (!actual) return;
    const total = ps.estado.total;
    if (total > 500 && !(await confirmar({ titulo: "Descargar comprobantes", textoOk: "Descargar",
      mensaje: `Se descargarán los ${total.toLocaleString("es-PE")} comprobantes de esta consulta (puede tardar unos segundos).` }))) return;
    try {
      const snap = await getDocs(query(actual.col, ...actual.filtros, ...actual.orden));
      const lista = snap.docs.map((d) => ({ id: d.id, ...d.data(), ...(proveedor ? { gosocketId: "" } : {}) }));
      const pagos = await pagosDe(lista, proveedor ? ruc : null);
      descargarXlsx(`comprobantes_${hoyISO()}.xlsx`, "Table1", COLUMNAS_GOSOCKET, lista.map((c) => filaGosocket(c, pagoDe(pagos, c))), { colorEncabezado: "FFEA7203" });
    } catch (err) {
      console.error("Portal: no se pudo descargar", err);
      notificar("No se pudo descargar", "error");
    }
  });

  if (puedeSubir) montarCarga(cont, ctx, { proveedor, alGuardar: () => ps.recargar() });
  buscar();
  return () => ps.detener();
}

const botonesArchivo = (c, i, proveedor) => `
  <button type="button" class="btn chico" data-bajar="pdf" data-i="${i}" title="${c.tienePdf ? "PDF original" : "Representación impresa"}">${icono("bajar")}PDF</button>
  <button type="button" class="btn chico" data-bajar="xml" data-i="${i}" ${hayXml(c, proveedor) ? "" : "disabled"} title="${hayXml(c, proveedor) ? "XML del comprobante" : "Sin XML en el portal"}">${icono("bajar")}XML</button>`;

const textoOrigen = (c, proveedor) => ({
  proveedor: proveedor ? "Enviado por ti" : "Proveedor (portal)",
  hotel: "Contabilidad",
  gosocket: proveedor ? "Recibido por el hotel" : "Gosocket",
}[c.origen] || "—");

/* ── Detalle de un comprobante ───────────────────────────────────── */
function detalle(c, pago, { proveedor, gestiona, alBorrar }) {
  if (!c) return;
  const items = c.items || [];
  const { el, cerrar } = abrirModal(`
    <div class="modal-cab"><h2>${esc(c.tipoNombre || TIPOS[c.tipo])} ${esc(c.comprobante)}</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
    <p class="modal-sub">${esc(c.razonSocial)} · RUC ${esc(c.ruc)}${c.receptor ? ` → ${esc(c.receptor)} (RUC ${esc(c.rucReceptor)})` : ""}</p>
    <div class="constancia"><dl>
      <dt>Emisión</dt><dd>${fechaCorta(c.fechaEmision)}</dd>
      <dt>Vencimiento</dt><dd>${c.fechaVencimiento ? fechaCorta(c.fechaVencimiento) : "—"}</dd>
      <dt>Moneda</dt><dd>${c.moneda === "USD" ? "Dólares (USD)" : "Soles (S/)"}</dd>
      <dt>Valor de venta</dt><dd class="mono">${monto(c.neto, c.moneda)}</dd>
      ${c.exento ? `<dt>Exonerado / inafecto</dt><dd class="mono">${monto(c.exento, c.moneda)}</dd>` : ""}
      <dt>IGV</dt><dd class="mono">${monto(c.impuestos, c.moneda)}</dd>
      ${c.detraccion ? `<dt>Detracción</dt><dd class="mono descuento">${monto(c.detraccion, c.moneda)}</dd>` : ""}
      ${c.refValor ? `<dt>Documento que modifica</dt><dd class="mono">${esc(c.refValor)}</dd>` : ""}
      ${c.estadoSunat ? `<dt>Estado SUNAT (Gosocket)</dt><dd>${esc(c.estadoSunat)}${c.motivoRechazo ? ` · ${esc(c.motivoRechazo)}` : ""}</dd>` : ""}
      <dt>Pago</dt><dd>${chipPago(c, pago)}</dd>
    </dl>
    <div class="total"><span>Importe total</span><span class="mono">${monto(c.total, c.moneda)}</span></div></div>
    ${items.length ? `<div class="tabla-caja" style="margin-top:12px;max-height:260px;overflow:auto"><table>
      <thead><tr><th>Descripción</th><th class="num">Cantidad</th><th class="num">Valor unit.</th><th class="num">Valor venta</th></tr></thead>
      <tbody>${items.map((it) => `<tr><td>${esc(it.descripcion)}</td><td class="num">${esc(it.cantidad)} ${esc(it.unidad)}</td>
        <td class="num">${monto(it.valorUnitario, c.moneda)}</td><td class="num">${monto(it.valorVenta, c.moneda)}</td></tr>`).join("")}</tbody>
    </table></div>` : `<p class="ayuda">${c.origen === "gosocket" ? "Importado del Excel de Gosocket: sin el detalle de ítems (sube el XML para verlo)." : "El comprobante no trae ítems."}</p>`}
    <div class="modal-pie">
      ${gestiona ? `<button type="button" class="btn rojo" data-borrar>Eliminar</button>` : ""}
      ${!proveedor && c.gosocketId ? `<a class="btn" href="${esc(enlaceGosocket(c.gosocketId, "ver"))}" target="_blank" rel="noopener noreferrer">Abrir en Gosocket</a>` : ""}
      ${pago ? `<button type="button" class="btn" data-constancia>${icono("recibo")}Constancia de pago</button>` : ""}
      ${botonesArchivo(c, 0, proveedor)}
      <button type="button" class="btn oscuro" data-cerrar>Cerrar</button>
    </div>`, { ancho: true });
  el.querySelector("[data-constancia]")?.addEventListener("click", () => { cerrar(); constancia(pago); });
  el.querySelectorAll("[data-bajar]").forEach((b) => b.addEventListener("click", () => { if (b.dataset.bajar === "pdf" && (!c.tieneXml || !c.tienePdf)) cerrar(); bajarArchivo(c, b.dataset.bajar, { proveedor }); }));
  el.querySelector("[data-borrar]")?.addEventListener("click", async () => {
    if (!(await confirmar({ titulo: "Eliminar comprobante", textoOk: "Eliminar", peligroso: true,
      mensaje: `Se eliminará ${c.comprobante} de ${c.razonSocial} del portal (no de SUNAT ni de Gosocket).` }))) return;
    try {
      const lote = writeBatch(db);
      lote.delete(doc(db, "comprobantes", c.id));
      lote.delete(refArchivos(c.id));
      await lote.commit();
      cerrar(); notificar("Comprobante eliminado"); alBorrar();
    }
    catch (err) { console.error("Portal: no se pudo eliminar", err); notificar("No se pudo eliminar", "error"); }
  });
}

/* ── Subir XML / ZIP / Excel de Gosocket ─────────────────────────── */
function montarCarga(cont, ctx, { proveedor, alGuardar }) {
  const zona = $("#zona-comp", cont), entrada = $("#in-comp", cont), caja = $("#carga-comp", cont);
  const uid = ctx.user.uid, ruc = ctx.perfil.ruc;
  const carpeta = $("#in-comp-carpeta", cont);
  $("#btn-carpeta-comp", cont).addEventListener("click", () => carpeta.click());
  $("#btn-archivos-comp", cont).addEventListener("click", () => entrada.click());
  for (const inp of [entrada, carpeta]) inp.addEventListener("change", () => { procesar([...inp.files]); inp.value = ""; });
  zona.addEventListener("dragover", (e) => { e.preventDefault(); zona.classList.add("sobre"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("sobre"));
  zona.addEventListener("drop", async (e) => { e.preventDefault(); zona.classList.remove("sobre"); procesar(await archivosSoltados(e.dataTransfer)); });

  let items = [], trabajando = false, resumen = "", ocultar = 0;
  const pag = paginador("carga-comprobantes", pintar, { etiqueta: "archivos" });

  async function leerArchivos(archivos) {
    const salida = [], pdfs = [];
    // Nombre sin carpeta ni extensión: así el PDF se empareja con el XML del mismo nombre.
    const base = (n) => n.split(/[\\/]/).pop().replace(/\.[^.]+$/, "").toLowerCase();
    const xml = async (nombre, bytes, grupo) => {
      const texto = textoXml(bytes), r = leerXmlSunat(texto);
      if (!r.ok) return salida.push({ nombre, estado: r.omitir ? "omitido" : "rechazado", motivo: r.motivo });
      salida.push({ nombre, id: r.id, doc: r.doc, hash: await huellaArchivo(new Blob([bytes])), origen: proveedor ? "proveedor" : "hotel",
        estado: "nuevo", xmlTexto: texto, base: base(nombre), grupo });
    };
    for (const f of archivos) {
      try {
        if (f.size > MAX_ARCHIVO) { salida.push({ nombre: f.name, estado: "rechazado", motivo: "Pesa más de 20 MB." }); continue; }
        if (/\.xml$/i.test(f.name)) await xml(f.name, new Uint8Array(await f.arrayBuffer()), "");
        else if (/\.zip$/i.test(f.name)) {
          const entradas = await leerZip(f);
          for (const e of entradas) {
            const nombre = `${f.name} › ${e.nombre.split("/").pop()}`;
            if (/\.xml$/i.test(e.nombre)) await xml(nombre, e.datos, f.name);
            else if (/\.pdf$/i.test(e.nombre)) pdfs.push({ nombre, base: base(e.nombre), datos: e.datos, grupo: f.name });
          }
          if (!entradas.some((e) => /\.xml$/i.test(e.nombre))) salida.push({ nombre: f.name, estado: "rechazado", motivo: "El ZIP no tiene archivos XML." });
        } else if (/\.xlsx$/i.test(f.name) && !proveedor) {
          const filasG = filasGosocket(await leerXlsx(f));
          if (!filasG) salida.push({ nombre: f.name, estado: "rechazado", motivo: "El Excel no tiene las columnas de Gosocket (Id Gosocket, Id Emisor, Correlativo…)." });
          else filasG.forEach((r) => salida.push(r.ok ? { nombre: r.nombre, id: r.id, doc: r.doc, hash: "", origen: "gosocket", estado: "nuevo" }
            : { nombre: r.nombre, estado: r.omitir ? "omitido" : "rechazado", motivo: r.motivo }));
        } else if (/\.pdf$/i.test(f.name)) pdfs.push({ nombre: f.name, base: base(f.name), datos: new Uint8Array(await f.arrayBuffer()), grupo: "" });
        else salida.push({ nombre: f.name, estado: "omitido", motivo: `Tipo de archivo no admitido (${proveedor ? "XML, PDF o ZIP" : "XML, PDF, ZIP o Excel de Gosocket"}).` });
      } catch (err) {
        salida.push({ nombre: f.name, estado: "rechazado", motivo: err.message || "No se pudo leer el archivo." });
      }
    }
    // PDF → el XML del mismo nombre (o, dentro de un ZIP, el único XML del ZIP si solo hay un PDF).
    const xmls = salida.filter((x) => x.xmlTexto);
    for (const pdf of pdfs) {
      const delGrupo = (g) => xmls.filter((x) => g && x.grupo === g);
      const x = xmls.find((y) => y.base === pdf.base && !y.pdf)
        || (delGrupo(pdf.grupo).length === 1 && pdfs.filter((q) => q.grupo === pdf.grupo).length === 1 ? delGrupo(pdf.grupo)[0] : null);
      if (!x) { salida.push({ nombre: pdf.nombre, estado: "rechazado", motivo: "PDF sin su XML: súbelo junto con el XML del mismo nombre." }); continue; }
      if (new TextDecoder().decode(pdf.datos.subarray(0, 5)) !== "%PDF-") { salida.push({ nombre: pdf.nombre, estado: "rechazado", motivo: "No es un PDF válido." }); continue; }
      x.pdf = aBase64(pdf.datos);
      x.nombre += " + PDF";
    }
    // Lo que no cabe en un documento de Firestore (1 MiB): sin PDF y, si aún no cabe, sin el XML (quedan los datos).
    for (const x of xmls) {
      if (x.pdf && bytesTexto(x.xmlTexto) + x.pdf.length > MAX_GUARDADO) { delete x.pdf; x.nombre = x.nombre.replace(/ \+ PDF$/, ""); x.motivo = "PDF muy pesado (más de ~500 KB): se usará la representación impresa."; }
      if (bytesTexto(x.xmlTexto) > MAX_GUARDADO) { x.xmlTexto = ""; x.motivo = "XML muy pesado: se guardan sus datos, no el archivo."; }
    }
    return salida;
  }

  async function procesar(archivos) {
    if (trabajando || !archivos.length) return;
    trabajando = true;
    clearTimeout(ocultar);
    resumen = "";
    caja.innerHTML = `<p class="ayuda">Leyendo ${archivos.length} archivo(s)…</p>`;
    try {
      items = await leerArchivos(archivos);
      // Reglas antes de guardar: RUC propio (proveedor), dirigido al hotel, fecha, repetidos en la selección.
      const vistos = new Set();
      for (const x of items.filter((y) => y.estado === "nuevo")) {
        if (proveedor && x.doc.ruc !== ruc) Object.assign(x, { estado: "rechazado", motivo: `Es del RUC ${x.doc.ruc}: solo puedes enviar tus propios comprobantes.` });
        else if (RUC_HOTEL && x.doc.rucReceptor && x.doc.rucReceptor !== RUC_HOTEL) Object.assign(x, { estado: "rechazado", motivo: `Está dirigido al RUC ${x.doc.rucReceptor}, no al hotel (${RUC_HOTEL}).` });
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(x.doc.fechaEmision)) Object.assign(x, { estado: "rechazado", motivo: "Sin fecha de emisión." });
        else if (vistos.has(x.id)) x.estado = "repetido";
        else vistos.add(x.id);
      }
      await compararConLoGuardado(items.filter((y) => y.estado === "nuevo"));
      pag.reiniciar();
      pintar();
      await guardar();
    } finally { trabajando = false; }
  }

  /** Lee lo ya guardado (por ID) y decide: nuevo, igual (se omite), cambió o solo actualiza el estado. */
  async function compararConLoGuardado(lista) {
    for (let i = 0; i < lista.length; i += 25) {
      const tanda = lista.slice(i, i + 25);
      const snaps = await Promise.all(tanda.map((x) => getDoc(doc(db, "comprobantes", x.id))));
      tanda.forEach((x, j) => {
        if (!snaps[j].exists()) return;
        const ya = snaps[j].data();
        if (x.origen === "gosocket") {
          if (ya.origen !== "gosocket") {
            // Ya está con su XML (más completo): de Gosocket solo se toma el estado SUNAT.
            const cambia = ya.estadoSunat !== x.doc.estadoSunat || ya.gosocketId !== x.doc.gosocketId;
            Object.assign(x, cambia ? { estado: "estado", parche: { estadoSunat: x.doc.estadoSunat, motivoRechazo: x.doc.motivoRechazo, gosocketId: x.doc.gosocketId, fechaRecepcion: x.doc.fechaRecepcion } } : { estado: "igual" });
          } else x.estado = ya.estadoSunat === x.doc.estadoSunat && ya.total === x.doc.total && ya.fechaEmision === x.doc.fechaEmision ? "igual" : "cambio";
          return;
        }
        if (ya.hash && ya.hash === x.hash && (ya.tieneXml || !x.xmlTexto) && (ya.tienePdf || !x.pdf)) { x.estado = "igual"; return; }
        if (proveedor && ya.origen !== "proveedor") { Object.assign(x, { estado: "igual", motivo: "Ya lo registró el hotel." }); return; }
        // El XML reemplaza los datos, pero conserva lo que vino de Gosocket (estado SUNAT y enlace).
        Object.assign(x.doc, { estadoSunat: ya.estadoSunat || "", motivoRechazo: ya.motivoRechazo || "", gosocketId: ya.gosocketId || "", ...(ya.fechaRecepcion ? { fechaRecepcion: ya.fechaRecepcion } : {}) });
        x.estado = "cambio";
      });
    }
  }

  async function guardar() {
    const porGuardar = items.filter((x) => ["nuevo", "cambio", "estado"].includes(x.estado));
    let hechos = 0;
    for (let i = 0; i < porGuardar.length; i += 200) {
      const tanda = porGuardar.slice(i, i + 200), lote = writeBatch(db);
      tanda.forEach((x) => {
        x.estado = "guardando";
        const ref = doc(db, "comprobantes", x.id);
        if (x.parche) { lote.update(ref, x.parche); return; }
        lote.set(ref, { ...x.doc, origen: x.origen, archivo: x.nombre.slice(0, 200), hash: x.hash,
          tieneXml: !!x.xmlTexto, tienePdf: !!(x.xmlTexto && x.pdf), subidoPorUid: uid, subidoEn: serverTimestamp() });
        if (x.xmlTexto) lote.set(refArchivos(x.id), { xml: x.xmlTexto, ...(x.pdf ? { pdf: x.pdf } : {}), subidoPorUid: uid, subidoEn: serverTimestamp() });
      });
      pintar();
      try {
        await lote.commit();
        tanda.forEach((x) => { x.estado = "guardado"; });
        hechos += tanda.length;
      } catch (err) {
        console.error("Portal: no se pudieron guardar los comprobantes", err);
        tanda.forEach((x) => Object.assign(x, { estado: "error", motivo: err.code === "permission-denied" ? "Sin permiso para guardarlo." : err.message }));
        break;
      }
    }
    // Terminado: la lista desaparece; solo quedan a la vista los que tienen algún problema.
    const ya = items.filter((x) => ["igual", "repetido"].includes(x.estado)).length, otros = items.filter((x) => x.estado === "omitido").length;
    resumen = `${hechos ? `✓ ${hechos} comprobante(s) guardado(s)` : "Nada nuevo que guardar"}${ya ? ` · ${ya} ya estaban (se omiten)` : ""}${otros ? ` · ${otros} que no son comprobantes de pago (guías, CDR u otros archivos) se omiten` : ""}`;
    items = items.filter((x) => ["rechazado", "error"].includes(x.estado) || (x.motivo && x.estado === "guardado"));
    pag.reiniciar();
    pintar();
    clearTimeout(ocultar);
    if (!items.length) ocultar = setTimeout(() => { resumen = ""; pintar(); }, 6000);
    if (hechos) { notificar(`${hechos} comprobante(s) guardado(s)`); alGuardar(); }
  }

  function pintar() {
    if (!items.length) { caja.innerHTML = resumen ? `<p class="aviso-ok">${esc(resumen)}</p>` : ""; return; }
    const cuenta = (...e) => items.filter((x) => e.includes(x.estado)).length;
    const { visibles, html } = pag.cortar(items);
    caja.innerHTML = `
      ${resumen ? `<p class="aviso-ok">${esc(resumen)}</p><p class="ayuda" style="margin:8px 0">Revisa estos archivos:</p>`
        : `<p class="ayuda" style="margin:12px 0 8px"><b>${cuenta("guardado")}</b> guardados · <b>${cuenta("igual", "repetido")}</b> ya estaban (se omiten)
        · <b>${cuenta("rechazado", "error")}</b> rechazados${cuenta("omitido") ? ` · <b>${cuenta("omitido")}</b> se omiten` : ""}${cuenta("nuevo", "cambio", "estado", "guardando") ? ` · <b>${cuenta("nuevo", "cambio", "estado", "guardando")}</b> en proceso` : ""}</p>`}
      <div class="tabla-caja"><table>
        <thead><tr><th>Archivo</th><th>Comprobante</th>${proveedor ? "" : "<th>Emisor</th>"}<th class="num">Total</th><th>Estado</th><th>Detalle</th></tr></thead>
        <tbody>${visibles.map((x) => {
          const [clase, texto] = ESTADOS_CARGA[x.estado] || ["neutro", x.estado];
          return `<tr><td style="font-size:11px">${esc(x.nombre)}</td><td class="mono">${x.doc ? esc(`${x.doc.serie}-${x.doc.numero}`) : "—"}</td>
            ${proveedor ? "" : `<td>${x.doc ? esc(x.doc.razonSocial) : "—"}</td>`}
            <td class="num">${x.doc ? monto(x.doc.total, x.doc.moneda) : "—"}</td><td>${chip(clase, texto)}</td>
            <td style="font-size:11px">${esc(x.motivo || "")}</td></tr>`;
        }).join("")}</tbody>
      </table></div>
      <div id="pag-carga-comp"></div>`;
    const barra = $("#pag-carga-comp", caja);
    barra.innerHTML = html;
    pag.enganchar(barra);
  }
}
