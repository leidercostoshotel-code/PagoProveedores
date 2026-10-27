/* ══════════════════════════════════════════════════════════════════
   VISTA DEL PROVEEDOR: solo sus pagos (los de su RUC — las reglas de
   Firestore no le dejan leer nada más aunque modifique la consulta).
   ══════════════════════════════════════════════════════════════════ */
import { db } from "./firebase.js";
import { collection, query, where, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  $, esc, icono, soles, solesS, fechaCorta, enmascarar, normalizar, NOMBRES_MES,
  abrirModal, descargarCSV, notificar, paginador,
} from "./util.js";
import { CORREO_CONTABILIDAD, EMPRESA } from "./config.js";

export function pestanas() {
  return [
    { id: "pagos", texto: "Mis pagos", icono: "recibo" },
    { id: "resumen", texto: "Resumen por mes", icono: "grafico" },
  ];
}

// Pagos del proveedor en memoria durante la sesión ("Actualizar" vuelve a pedirlos).
let cache = { ruc: null, pagos: null };
async function cargarPagos(ruc, forzar = false) {
  if (!forzar && cache.ruc === ruc && cache.pagos) return cache.pagos;
  const snap = await getDocs(query(collection(db, "pagos"), where("ruc", "==", ruc), orderBy("fechaPago", "desc")));
  cache = { ruc, pagos: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
  return cache.pagos;
}

const sumar = (lista, k) => lista.reduce((s, p) => s + (Number(p[k]) || 0), 0);

export function montar(id, cont, ctx) {
  cont.innerHTML = `<div class="panel"><p class="ayuda" style="margin:0">Cargando tus pagos…</p></div>`;
  let vivo = true;
  cargarPagos(ctx.perfil.ruc)
    .then((pagos) => { if (vivo) (id === "resumen" ? vistaResumen : vistaPagos)(cont, ctx, pagos); })
    .catch((err) => {
      console.error("Portal: no se pudieron leer los pagos", err);
      if (vivo) cont.innerHTML = `<div class="aviso rojo">No se pudieron cargar tus pagos. Recarga la página; si sigue igual, escribe a
        <a href="mailto:${esc(CORREO_CONTABILIDAD)}">${esc(CORREO_CONTABILIDAD)}</a>.</div>`;
    });
  return () => { vivo = false; };
}

/* ── Mis pagos ───────────────────────────────────────────────────── */
function vistaPagos(cont, ctx, pagos) {
  const anios = [...new Set(pagos.map((p) => (p.fechaPago || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const anioIni = anios[0] || "";
  cont.innerHTML = `
    <div class="tarjetas" id="kpis"></div>
    <div class="panel">
      <div class="panel-titulo">
        <div><h2>Facturas pagadas</h2><p>Toca una factura para ver su constancia de pago.</p></div>
        <div class="acciones">
          <button type="button" class="btn chico" id="actualizar">${icono("refrescar")}Actualizar</button>
          <button type="button" class="btn chico" id="exportar">${icono("bajar")}Excel (CSV)</button>
          <button type="button" class="btn chico" id="imprimir">${icono("impresora")}Imprimir</button>
        </div>
      </div>
      <div class="barra-filtros">
        <label class="campo"><span>Año</span><select class="select chico" id="f-anio">
          <option value="">Todos</option>${anios.map((a) => `<option ${a === anioIni ? "selected" : ""}>${esc(a)}</option>`).join("")}
        </select></label>
        <label class="campo"><span>Mes</span><select class="select chico" id="f-mes">
          <option value="">Todos</option>${NOMBRES_MES.map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}">${m}</option>`).join("")}
        </select></label>
        <label class="campo crece"><span>Buscar factura</span><input class="input chico" style="width:100%" id="f-buscar" placeholder="F001-00452"></label>
      </div>
      <div class="tabla-caja"><table>
        <thead><tr><th>Factura</th><th>Fecha de abono</th><th>Banco</th><th>Cuenta</th><th class="num">Bruto</th>
          <th class="num">Retención</th><th class="num">Detracción</th><th class="num">N. crédito</th><th class="num">Neto abonado</th></tr></thead>
        <tbody id="tb"></tbody><tfoot id="tf"></tfoot>
      </table></div>
      <div id="pag"></div>
      <p class="ayuda">¿Dudas sobre un pago? Escribe a <a href="mailto:${esc(CORREO_CONTABILIDAD)}">${esc(CORREO_CONTABILIDAD)}</a> indicando tu RUC y el número de factura.</p>
    </div>`;

  let filtradas = [];
  const pag = paginador("prov-pagos", () => pintar(false), { etiqueta: "facturas" });
  pag.enganchar($("#pag", cont));
  function pintar(reiniciar = true) {
    if (reiniciar) pag.reiniciar();
    const anio = $("#f-anio", cont).value, mes = $("#f-mes", cont).value, texto = normalizar($("#f-buscar", cont).value);
    filtradas = pagos.filter((p) => (!anio || p.fechaPago?.startsWith(anio)) && (!mes || p.fechaPago?.slice(5, 7) === mes)
      && (!texto || normalizar(p.factura).includes(texto)));
    const ultimo = pagos[0];
    $("#kpis", cont).innerHTML = `
      <div class="tarjeta destacada"><div class="etiqueta">Total abonado</div><div class="valor">${solesS(sumar(filtradas, "neto"))}</div><div class="sub">${anio || "Todos los años"}${mes ? ` · ${NOMBRES_MES[Number(mes) - 1]}` : ""}</div></div>
      <div class="tarjeta"><div class="etiqueta">Facturas pagadas</div><div class="valor">${filtradas.length}</div><div class="sub">en el periodo elegido</div></div>
      <div class="tarjeta"><div class="etiqueta">Retenciones</div><div class="valor">${soles(sumar(filtradas, "retencion"))}</div><div class="sub">Detracciones: ${soles(sumar(filtradas, "detraccion"))}</div></div>
      <div class="tarjeta"><div class="etiqueta">Último abono</div><div class="valor">${ultimo ? fechaCorta(ultimo.fechaPago) : "—"}</div><div class="sub">${ultimo ? `${esc(ultimo.factura)} · ${solesS(ultimo.neto)}` : "Aún no hay pagos"}</div></div>`;
    const { visibles, inicio, html } = pag.cortar(filtradas);
    $("#pag", cont).innerHTML = html;
    $("#tb", cont).innerHTML = visibles.map((p, i) => `
      <tr class="clic" data-i="${inicio + i}" tabindex="0">
        <td class="mono">${esc(p.factura)}</td><td>${fechaCorta(p.fechaPago)}</td><td>${esc(p.banco)}</td><td class="mono">${esc(enmascarar(p.cuentaAbono))}</td>
        <td class="num">${soles(p.bruto)}</td><td class="num descuento">${p.retencion ? soles(p.retencion) : "—"}</td>
        <td class="num descuento">${p.detraccion ? soles(p.detraccion) : "—"}</td><td class="num descuento">${p.notaCredito ? soles(p.notaCredito) : "—"}</td>
        <td class="num neto">${soles(p.neto)}</td>
      </tr>`).join("") || `<tr><td colspan="9" class="vacio">No hay pagos registrados${pagos.length ? " con estos filtros" : " para tu RUC todavía"}.</td></tr>`;
    $("#tf", cont).innerHTML = filtradas.length ? `<tr><td colspan="4">Total (${filtradas.length})</td>
      <td class="num">${soles(sumar(filtradas, "bruto"))}</td><td class="num">${soles(sumar(filtradas, "retencion"))}</td>
      <td class="num">${soles(sumar(filtradas, "detraccion"))}</td><td class="num">${soles(sumar(filtradas, "notaCredito"))}</td>
      <td class="num">${soles(sumar(filtradas, "neto"))}</td></tr>` : "";
  }
  ["#f-anio", "#f-mes"].forEach((s) => $(s, cont).addEventListener("change", () => pintar()));
  $("#f-buscar", cont).addEventListener("input", () => pintar());
  const abrir = (tr) => tr && constancia(filtradas[Number(tr.dataset.i)], ctx.perfil);
  $("#tb", cont).addEventListener("click", (e) => abrir(e.target.closest("tr[data-i]")));
  $("#tb", cont).addEventListener("keydown", (e) => { if (e.key === "Enter") abrir(e.target.closest("tr[data-i]")); });
  $("#actualizar", cont).addEventListener("click", async () => {
    const nuevos = await cargarPagos(ctx.perfil.ruc, true).catch(() => null);
    if (!nuevos) return notificar("No se pudo actualizar", "error");
    vistaPagos(cont, ctx, nuevos);
    notificar("Pagos actualizados");
  });
  $("#exportar", cont).addEventListener("click", () => descargarCSV(`pagos_${ctx.perfil.ruc}.csv`,
    ["Factura", "Fecha de abono", "Banco", "Cuenta", "Bruto", "Retención", "Detracción", "Nota de crédito", "Neto abonado"],
    filtradas.map((p) => [p.factura, p.fechaPago, p.banco, enmascarar(p.cuentaAbono), p.bruto, p.retencion, p.detraccion, p.notaCredito, p.neto])));
  $("#imprimir", cont).addEventListener("click", () => window.print());
  pintar();
}

/* ── Resumen por mes ─────────────────────────────────────────────── */
function vistaResumen(cont, ctx, pagos) {
  const meses = {};
  for (const p of pagos) {
    const k = (p.fechaPago || "").slice(0, 7);
    if (!k) continue;
    (meses[k] ||= []).push(p);
  }
  const filas = Object.keys(meses).sort().reverse();
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo"><div><h2>Resumen por mes</h2><p>Totales de lo abonado a tu RUC ${esc(ctx.perfil.ruc)}, mes a mes.</p></div>
        <div class="acciones"><button type="button" class="btn chico" id="imprimir">${icono("impresora")}Imprimir</button></div></div>
      <div class="tabla-caja"><table>
        <thead><tr><th>Mes</th><th class="num">Facturas</th><th class="num">Bruto</th><th class="num">Retención</th>
          <th class="num">Detracción</th><th class="num">N. crédito</th><th class="num">Neto abonado</th></tr></thead>
        <tbody id="tb"></tbody>
      </table></div>
      <div id="pag"></div>
    </div>`;
  const pag = paginador("prov-resumen", pintar, { etiqueta: "meses" });
  pag.enganchar($("#pag", cont));
  function pintar() {
    const { visibles, html } = pag.cortar(filas);
    $("#pag", cont).innerHTML = html;
    $("#tb", cont).innerHTML = visibles.map((k) => { const l = meses[k]; return `<tr>
      <td>${NOMBRES_MES[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}</td><td class="num">${l.length}</td>
      <td class="num">${soles(sumar(l, "bruto"))}</td><td class="num descuento">${soles(sumar(l, "retencion"))}</td>
      <td class="num descuento">${soles(sumar(l, "detraccion"))}</td><td class="num descuento">${soles(sumar(l, "notaCredito"))}</td>
      <td class="num neto">${soles(sumar(l, "neto"))}</td></tr>`; }).join("") || `<tr><td colspan="7" class="vacio">Aún no hay pagos registrados.</td></tr>`;
  }
  pintar();
  $("#imprimir", cont).addEventListener("click", () => window.print());
}

/* ── Constancia de pago de una factura (imprimible) ──────────────── */
export function constancia(p, perfil = {}) {
  if (!p) return;
  const { el } = abrirModal(`
    <div class="constancia">
      <div class="modal-cab"><h2>Constancia de pago</h2><button type="button" class="cerrar no-imprimir" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
      <p class="modal-sub">${esc(EMPRESA)} · ${esc(p.razonSocial || perfil.razonSocial || "")} · RUC ${esc(p.ruc)}</p>
      <dl>
        <dt>Factura</dt><dd class="mono">${esc(p.factura)}</dd>
        <dt>Fecha de abono</dt><dd>${fechaCorta(p.fechaPago)}</dd>
        <dt>Banco</dt><dd>${esc(p.banco)}</dd>
        <dt>Cuenta de abono</dt><dd class="mono">${esc(enmascarar(p.cuentaAbono))}</dd>
        <dt>Importe bruto</dt><dd class="mono">${soles(p.bruto)}</dd>
        <dt>Retención</dt><dd class="mono descuento">− ${soles(p.retencion)}</dd>
        <dt>Detracción</dt><dd class="mono descuento">− ${soles(p.detraccion)}</dd>
        <dt>Nota de crédito</dt><dd class="mono descuento">− ${soles(p.notaCredito)}</dd>
      </dl>
      <div class="total"><span>Neto abonado</span><span class="mono">${solesS(p.neto)}</span></div>
      <p class="ayuda">Lote ${esc(p.lote || "—")}. Documento informativo generado desde el Portal de Proveedores.</p>
      <div class="modal-pie no-imprimir">
        <button type="button" class="btn" data-cerrar>Cerrar</button>
        <button type="button" class="btn oscuro" data-imprimir>${icono("impresora")}Imprimir</button>
      </div>
    </div>`, { alCerrar: () => document.body.classList.remove("imprimiendo-modal") });
  el.querySelector("[data-imprimir]").addEventListener("click", () => {
    document.body.classList.add("imprimiendo-modal");
    window.print();
    document.body.classList.remove("imprimiendo-modal");
  });
}
