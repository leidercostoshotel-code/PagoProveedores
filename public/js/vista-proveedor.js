/* ══════════════════════════════════════════════════════════════════
   VISTA DEL PROVEEDOR: solo sus pagos (los de su RUC — las reglas de
   Firestore no le dejan leer nada más aunque modifique la consulta).
   Todo paginado en el servidor: se lee la página visible y los totales
   los calcula Firebase (count/sum), sin descargar todas sus facturas.
   ══════════════════════════════════════════════════════════════════ */
import { db } from "./firebase.js";
import {
  collection, query, where, orderBy, limit, getDocs, count, sum,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  $, esc, icono, soles, solesS, fechaCorta, enmascarar, NOMBRES_MES,
  abrirModal, descargarCSV, notificar, confirmar,
} from "./util.js";
import { paginaServidor, agregar } from "./paginaServidor.js";
import { CORREO_CONTABILIDAD, EMPRESA } from "./config.js";

export function pestanas() {
  return [
    { id: "pagos", texto: "Mis pagos", icono: "recibo" },
    { id: "resumen", texto: "Resumen por mes", icono: "grafico" },
  ];
}

const colPagos = () => collection(db, "pagos");
const SUMAS = () => ({ bruto: sum("bruto"), retencion: sum("retencion"), detraccion: sum("detraccion"), notaCredito: sum("notaCredito"), neto: sum("neto") });
const pad2 = (n) => String(n).padStart(2, "0");
const finMes = (anio, mes) => `${anio}-${pad2(mes)}-${pad2(new Date(anio, mes, 0).getDate())}`;

/** Primer y último pago del proveedor (2 lecturas): para los años del filtro y "Último abono". */
async function extremos(ruc) {
  const [ult, pri] = await Promise.all([
    getDocs(query(colPagos(), where("ruc", "==", ruc), orderBy("fechaPago", "desc"), limit(1))),
    getDocs(query(colPagos(), where("ruc", "==", ruc), orderBy("fechaPago", "asc"), limit(1))),
  ]);
  return { ultimo: ult.docs[0]?.data() || null, primero: pri.docs[0]?.data() || null };
}
function aniosEntre(primero, ultimo) {
  if (!primero || !ultimo) return [];
  const a = Number(primero.fechaPago.slice(0, 4)), b = Number(ultimo.fechaPago.slice(0, 4));
  return Array.from({ length: b - a + 1 }, (_, i) => String(b - i));
}

export function montar(id, cont, ctx) {
  cont.innerHTML = `<div class="panel"><p class="ayuda" style="margin:0">Cargando tus pagos…</p></div>`;
  let vivo = true, limpiar = null;
  extremos(ctx.perfil.ruc)
    .then((ext) => { if (vivo) limpiar = (id === "resumen" ? vistaResumen : vistaPagos)(cont, ctx, ext); })
    .catch((err) => {
      console.error("Portal: no se pudieron leer los pagos", err);
      if (vivo) cont.innerHTML = `<div class="aviso rojo">No se pudieron cargar tus pagos. Recarga la página; si sigue igual, escribe a
        <a href="mailto:${esc(CORREO_CONTABILIDAD)}">${esc(CORREO_CONTABILIDAD)}</a>.</div>`;
    });
  return () => { vivo = false; if (limpiar) limpiar(); };
}

/* ── Mis pagos ───────────────────────────────────────────────────── */
function vistaPagos(cont, ctx, { ultimo, primero }) {
  const ruc = ctx.perfil.ruc;
  const anios = aniosEntre(primero, ultimo);
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
          <option value="">Todos</option>${NOMBRES_MES.map((m, i) => `<option value="${pad2(i + 1)}">${m}</option>`).join("")}
        </select></label>
        <label class="campo crece"><span>Buscar factura (número completo)</span><input class="input chico" style="width:100%" id="f-buscar" placeholder="F001-00452" autocomplete="off"></label>
      </div>
      <div class="tabla-caja"><table>
        <thead><tr><th>Factura</th><th>Fecha de abono</th><th>Banco</th><th>Cuenta</th><th class="num">Bruto</th>
          <th class="num">Retención</th><th class="num">Detracción</th><th class="num">N. crédito</th><th class="num">Neto abonado</th></tr></thead>
        <tbody id="tb"><tr><td colspan="9" class="vacio">Cargando…</td></tr></tbody><tfoot id="tf"></tfoot>
      </table></div>
      <div id="pag"></div>
      <p class="ayuda">¿Dudas sobre un pago? Escribe a <a href="mailto:${esc(CORREO_CONTABILIDAD)}">${esc(CORREO_CONTABILIDAD)}</a> indicando tu RUC y el número de factura.</p>
    </div>`;

  function consulta() {
    const anio = $("#f-anio", cont).value, mes = $("#f-mes", cont).value, fac = $("#f-buscar", cont).value.trim().toUpperCase();
    const base = [where("ruc", "==", ruc)];
    if (fac) return { col: colPagos(), filtros: [...base, where("factura", "==", fac)], orden: [orderBy("fechaPago", "desc")], periodo: `Factura ${fac}` };
    let desde = "", hasta = "";
    if (anio && mes) { desde = `${anio}-${mes}-01`; hasta = finMes(Number(anio), Number(mes)); }
    else if (anio) { desde = `${anio}-01-01`; hasta = `${anio}-12-31`; }
    else if (mes) return { error: "Elige también el año." };
    const rango = desde ? [where("fechaPago", ">=", desde), where("fechaPago", "<=", hasta)] : [];
    return { col: colPagos(), filtros: [...base, ...rango], orden: [orderBy("fechaPago", "desc")],
      periodo: `${anio || "Todos los años"}${mes ? ` · ${NOMBRES_MES[Number(mes) - 1]}` : ""}` };
  }
  let actual = consulta(), docsPagina = [];
  const ps = paginaServidor({
    clave: "prov-pagos", etiqueta: "facturas", barra: $("#pag", cont),
    consulta: () => actual, agregados: SUMAS(),
    pintar: (docs, st) => {
      docsPagina = docs.map((d) => ({ id: d.id, ...d.data() }));
      const a = st.agg;
      $("#kpis", cont).innerHTML = `
        <div class="tarjeta destacada"><div class="etiqueta">Total abonado</div><div class="valor">${solesS(a.neto)}</div><div class="sub">${esc(actual.periodo)}</div></div>
        <div class="tarjeta"><div class="etiqueta">Facturas pagadas</div><div class="valor">${(st.total || 0).toLocaleString("es-PE")}</div><div class="sub">en el periodo elegido</div></div>
        <div class="tarjeta"><div class="etiqueta">Retenciones</div><div class="valor">${soles(a.retencion)}</div><div class="sub">Detracciones: ${soles(a.detraccion)}</div></div>
        <div class="tarjeta"><div class="etiqueta">Último abono</div><div class="valor">${ultimo ? fechaCorta(ultimo.fechaPago) : "—"}</div><div class="sub">${ultimo ? `${esc(ultimo.factura)} · ${solesS(ultimo.neto)}` : "Aún no hay pagos"}</div></div>`;
      $("#tb", cont).innerHTML = docsPagina.map((p, i) => `
        <tr class="clic" data-i="${i}" tabindex="0">
          <td class="mono">${esc(p.factura)}</td><td>${fechaCorta(p.fechaPago)}</td><td>${esc(p.banco)}</td><td class="mono">${esc(enmascarar(p.cuentaAbono))}</td>
          <td class="num">${soles(p.bruto)}</td><td class="num descuento">${p.retencion ? soles(p.retencion) : "—"}</td>
          <td class="num descuento">${p.detraccion ? soles(p.detraccion) : "—"}</td><td class="num descuento">${p.notaCredito ? soles(p.notaCredito) : "—"}</td>
          <td class="num neto">${soles(p.neto)}</td>
        </tr>`).join("") || `<tr><td colspan="9" class="vacio">No hay pagos registrados${ultimo ? " con estos filtros" : " para tu RUC todavía"}.</td></tr>`;
      $("#tf", cont).innerHTML = st.total ? `<tr><td colspan="4">Total (${st.total.toLocaleString("es-PE")})</td>
        <td class="num">${soles(a.bruto)}</td><td class="num">${soles(a.retencion)}</td>
        <td class="num">${soles(a.detraccion)}</td><td class="num">${soles(a.notaCredito)}</td>
        <td class="num">${soles(a.neto)}</td></tr>` : "";
    },
    alError: (err) => {
      console.error("Portal: no se pudieron leer los pagos", err);
      $("#tb", cont).innerHTML = `<tr><td colspan="9" class="vacio">No se pudieron cargar tus pagos.</td></tr>`;
    },
  });
  function buscar() {
    const c = consulta();
    if (c.error) { notificar(c.error, "error"); return; }
    actual = c;
    $("#tb", cont).innerHTML = `<tr><td colspan="9" class="vacio">Cargando…</td></tr>`;
    ps.cargar(true);
  }
  let espera = 0;
  ["#f-anio", "#f-mes"].forEach((s) => $(s, cont).addEventListener("change", buscar));
  $("#f-buscar", cont).addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(buscar, 500); });
  const abrir = (tr) => tr && constancia(docsPagina[Number(tr.dataset.i)], ctx.perfil);
  $("#tb", cont).addEventListener("click", (e) => abrir(e.target.closest("tr[data-i]")));
  $("#tb", cont).addEventListener("keydown", (e) => { if (e.key === "Enter") abrir(e.target.closest("tr[data-i]")); });
  $("#actualizar", cont).addEventListener("click", () => { ps.recargar(); notificar("Pagos actualizados"); });
  $("#exportar", cont).addEventListener("click", async () => {
    const total = ps.estado.total;
    if (total > 500 && !(await confirmar({ titulo: "Descargar pagos", textoOk: "Descargar",
      mensaje: `Se descargarán las ${total.toLocaleString("es-PE")} facturas del periodo elegido.` }))) return;
    try {
      const snap = await getDocs(query(actual.col, ...actual.filtros, ...actual.orden));
      descargarCSV(`pagos_${ruc}.csv`,
        ["Factura", "Fecha de abono", "Banco", "Cuenta", "Bruto", "Retención", "Detracción", "Nota de crédito", "Neto abonado"],
        snap.docs.map((d) => { const p = d.data(); return [p.factura, p.fechaPago, p.banco, enmascarar(p.cuentaAbono), p.bruto, p.retencion, p.detraccion, p.notaCredito, p.neto]; }));
    } catch (err) {
      console.error("Portal: no se pudo descargar", err);
      notificar("No se pudo descargar", "error");
    }
  });
  $("#imprimir", cont).addEventListener("click", () => window.print());
  ps.cargar(true);
  return () => { ps.detener(); clearTimeout(espera); };
}

/* ── Resumen por mes: un año por vez, 12 conteos/sumas en el servidor ── */
function vistaResumen(cont, ctx, { ultimo, primero }) {
  const ruc = ctx.perfil.ruc;
  const anios = aniosEntre(primero, ultimo);
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo"><div><h2>Resumen por mes</h2><p>Totales de lo abonado a tu RUC ${esc(ruc)}, mes a mes.</p></div>
        <div class="acciones"><button type="button" class="btn chico" id="imprimir">${icono("impresora")}Imprimir</button></div></div>
      <div class="barra-filtros"><label class="campo"><span>Año</span><select class="select chico" id="f-anio">
        ${anios.map((a) => `<option>${esc(a)}</option>`).join("") || `<option value="">—</option>`}</select></label></div>
      <div class="tabla-caja"><table>
        <thead><tr><th>Mes</th><th class="num">Facturas</th><th class="num">Bruto</th><th class="num">Retención</th>
          <th class="num">Detracción</th><th class="num">N. crédito</th><th class="num">Neto abonado</th></tr></thead>
        <tbody id="tb"></tbody><tfoot id="tf"></tfoot>
      </table></div>
      <div class="paginacion no-imprimir" id="pag-anio"></div>
    </div>`;
  let vivo = true;
  async function pintar() {
    const anio = $("#f-anio", cont).value;
    const i = anios.indexOf(anio);
    $("#pag-anio", cont).innerHTML = anio ? `<span>Año <b>${esc(anio)}</b></span><div class="paginacion-nav">
      <button type="button" class="btn chico" data-anio="${esc(anios[i + 1] || "")}" ${anios[i + 1] ? "" : "disabled"} title="Año anterior">‹</button>
      <span class="paginacion-num">${i + 1} de ${anios.length}</span>
      <button type="button" class="btn chico" data-anio="${esc(anios[i - 1] || "")}" ${i > 0 ? "" : "disabled"} title="Año siguiente">›</button></div><span></span>` : "";
    if (!anio) { $("#tb", cont).innerHTML = `<tr><td colspan="7" class="vacio">Aún no hay pagos registrados.</td></tr>`; return; }
    $("#tb", cont).innerHTML = `<tr><td colspan="7" class="vacio">Cargando…</td></tr>`;
    try {
      const meses = await Promise.all(Array.from({ length: 12 }, (_, m) => agregar(
        query(colPagos(), where("ruc", "==", ruc), where("fechaPago", ">=", `${anio}-${pad2(m + 1)}-01`), where("fechaPago", "<=", finMes(Number(anio), m + 1))),
        { total: count(), ...SUMAS() }).then((r) => ({ mes: m, ...r }))));
      if (!vivo || $("#f-anio", cont).value !== anio) return;
      const con = meses.filter((x) => x.total).reverse();
      const t = (k) => meses.reduce((s, x) => s + (Number(x[k]) || 0), 0);
      $("#tb", cont).innerHTML = con.map((x) => `<tr>
        <td>${NOMBRES_MES[x.mes]} ${esc(anio)}</td><td class="num">${x.total}</td>
        <td class="num">${soles(x.bruto)}</td><td class="num descuento">${soles(x.retencion)}</td>
        <td class="num descuento">${soles(x.detraccion)}</td><td class="num descuento">${soles(x.notaCredito)}</td>
        <td class="num neto">${soles(x.neto)}</td></tr>`).join("") || `<tr><td colspan="7" class="vacio">Sin pagos en ${esc(anio)}.</td></tr>`;
      $("#tf", cont).innerHTML = con.length ? `<tr><td>Total ${esc(anio)}</td><td class="num">${t("total")}</td><td class="num">${soles(t("bruto"))}</td>
        <td class="num">${soles(t("retencion"))}</td><td class="num">${soles(t("detraccion"))}</td><td class="num">${soles(t("notaCredito"))}</td>
        <td class="num">${soles(t("neto"))}</td></tr>` : "";
    } catch (err) {
      console.error("Portal: no se pudo armar el resumen", err);
      $("#tb", cont).innerHTML = `<tr><td colspan="7" class="vacio">No se pudo cargar el resumen.</td></tr>`;
    }
  }
  $("#f-anio", cont).addEventListener("change", pintar);
  $("#pag-anio", cont).addEventListener("click", (e) => {
    const b = e.target.closest("[data-anio]");
    if (!b || b.disabled) return;
    $("#f-anio", cont).value = b.dataset.anio;
    pintar();
  });
  $("#imprimir", cont).addEventListener("click", () => window.print());
  pintar();
  return () => { vivo = false; };
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
