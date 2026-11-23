/* ══════════════════════════════════════════════════════════════════
   POR PAGAR: facturas pendientes de cada proveedor según SAP y, si ya
   están en una propuesta de pago aprobada, la fecha programada.
   Origen: el archivo «Para el portal de proveedores» que se descarga en
   Control de vencimientos (liquidacion-sap.web.app → Programación de pagos).
   También acepta el Excel de la consulta «Vencimientos proveedores» de SAP
   (sin fechas programadas). Contabilidad/admin lo sube y REEMPLAZA todo:
   lo que ya no figura (porque se pagó) se borra.
   - porpagar/{RUC_FACTURA}: una factura pendiente (el proveedor ve solo las de su RUC).
   - porpagar_cargas/actual: la última carga (archivo, datos al, totales y los ids, para borrar
     lo que sobra sin listar la colección).
   Todo paginado en el servidor (paginaServidor) y los totales con agregar() (count/sum).
   ══════════════════════════════════════════════════════════════════ */
import { db } from "./firebase.js";
import {
  collection, query, where, orderBy, limit, getDocs, getDoc, setDoc, doc, writeBatch, serverTimestamp, count, sum,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  $, esc, icono, soles, monto, fechaCorta, fechaHora, hoyISO, notificar, confirmar, normalizar,
} from "./util.js";
import { paginaServidor, agregar } from "./paginaServidor.js";
import { leerXlsx } from "./zip.js";
import { puedeGestionar } from "./roles.js";
import { CORREO_CONTABILIDAD } from "./config.js";

const colPP = () => collection(db, "porpagar");
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const conDia = (iso) => (iso ? `${DIAS[new Date(`${iso}T12:00:00`).getDay()]} ${fechaCorta(iso)}` : "");
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ── Lectura del archivo ──────────────────────────────────────────── */
const SIN = {
  ruc: ["ruc", "rucdelproveedor"],
  razon: ["razonsocial", "razonsocialdelproveedor", "proveedor"],
  doc: ["documento", "tipo"],
  factura: ["numerodefactura", "factura", "numero"],
  numsap: ["registrosap", "registrodecompras"],
  emision: ["fechaemision", "fecha"],
  venc: ["fechavencimiento", "vencimiento"],
  moneda: ["moneda"],
  total: ["total"],
  saldo: ["saldo"],
  prog: ["fechadepagoprogramada", "fechaprogramada", "pagoprogramado"],
  montoProg: ["montoprogramado"],
  datosAl: ["datosal"],
};
const clave = (s) => normalizar(s).replace(/[^a-z0-9]/g, "");
function fechaISO(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Math.round((Number(s) - 25569) * 86400000)); return d.toISOString().slice(0, 10); }  // serie de Excel
  return "";
}
function numero(v) {
  let s = String(v ?? "").trim(); if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || s.includes("-"); s = s.replace(/[^\d.,]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  const n = parseFloat(s) || 0; return neg ? -n : n;
}
const monedaDe = (v) => (/US|\$|DOL/i.test(String(v)) && !/S\//.test(String(v)) ? "USD" : "PEN");

/** Filas del Excel → facturas pendientes { id, ruc, razonSocial, factura, … }. */
export function interpretarPorPagar(filas) {
  let ini = -1, col = null;
  for (let i = 0; i < Math.min(25, filas.length); i++) {
    const h = filas[i].map(clave), m = {};
    for (const [k, lista] of Object.entries(SIN)) { const j = h.findIndex((x, n) => lista.includes(x) && !Object.values(m).includes(n)); if (j > -1) m[k] = j; }
    if (m.ruc != null && m.venc != null && m.saldo != null) { ini = i; col = m; break; }
  }
  if (ini < 0) throw new Error("El archivo no tiene las columnas RUC, Fecha Vencimiento y Saldo. Use el archivo «Para el portal de proveedores» de Control de vencimientos.");
  const g = (f, k) => (col[k] != null ? f[col[k]] : "");
  const salida = new Map(), avisos = [];
  let datosAl = "";
  for (const f of filas.slice(ini + 1)) {
    const ruc = String(g(f, "ruc")).replace(/\D/g, "");
    if (!ruc) continue;
    if (!/^\d{11}$/.test(ruc)) { avisos.push(`RUC inválido: ${g(f, "ruc")}`); continue; }
    const saldo = r2(numero(g(f, "saldo")));
    if (/^(nc|notadecredito)/.test(clave(g(f, "doc"))) || saldo <= 0.005) continue;   // notas de crédito y saldos a favor no se publican
    const venc = fechaISO(g(f, "venc"));
    if (!venc) { avisos.push(`Sin fecha de vencimiento: ${ruc} ${g(f, "factura")}`); continue; }
    const factura = String(g(f, "factura")).trim().toUpperCase(), numsap = String(g(f, "numsap")).replace(/\.0+$/, "").trim();
    let id = `${ruc}_${(factura || `SAP${numsap}`).replace(/[^\w-]/g, "")}`.slice(0, 120);
    if (salida.has(id)) id = `${id}_${numsap || salida.size}`;
    const prog = fechaISO(g(f, "prog"));
    datosAl = datosAl || fechaISO(g(f, "datosAl"));
    salida.set(id, {
      id, ruc, razonSocial: String(g(f, "razon")).trim(), factura: factura || `Registro ${numsap}`, numsap,
      fechaEmision: fechaISO(g(f, "emision")), fechaVencimiento: venc, moneda: monedaDe(g(f, "moneda")),
      total: r2(numero(g(f, "total"))) || saldo, saldo,
      programada: !!prog, fechaProgramada: prog, montoProgramado: prog ? r2(numero(g(f, "montoProg")) || saldo) : 0,
    });
  }
  const lista = [...salida.values()];
  if (!lista.length) throw new Error("El archivo no tiene facturas pendientes con saldo.");
  return { lista, avisos, datosAl: datosAl || hoyISO(), conProgramacion: col.prog != null };
}

/** Guarda la carga: escribe las facturas, borra las que ya no están y actualiza porpagar_cargas/actual. */
async function publicar(r, archivo, ctx, avance) {
  const ant = await getDoc(doc(db, "porpagar_cargas", "actual"));
  const idsAnt = (ant.exists() && ant.data().ids) || [];
  const nuevos = new Set(r.lista.map((x) => x.id));
  const borrar = idsAnt.filter((id) => !nuevos.has(id));
  const ops = [...r.lista.map((x) => ["set", x]), ...borrar.map((id) => ["del", id])];
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    for (const [tipo, x] of ops.slice(i, i + 400)) {
      if (tipo === "del") b.delete(doc(db, "porpagar", x));
      else { const { id, ...d } = x; b.set(doc(db, "porpagar", id), { ...d, datosAl: r.datosAl, cargadoEn: serverTimestamp() }); }
    }
    await b.commit();
    avance(Math.min(ops.length, i + 400), ops.length);
  }
  const porMon = (m) => r2(r.lista.filter((x) => x.moneda === m).reduce((t, x) => t + x.saldo, 0));
  await setDoc(doc(db, "porpagar_cargas", "actual"), {
    archivo, datosAl: r.datosAl, documentos: r.lista.length, proveedores: new Set(r.lista.map((x) => x.ruc)).size,
    programadas: r.lista.filter((x) => x.programada).length, totalPEN: porMon("PEN"), totalUSD: porMon("USD"),
    ids: [...nuevos], borradas: borrar.length, cargadoPor: ctx.user.email || "", cargadoEn: serverTimestamp(),
  });
  return { escritas: r.lista.length, borradas: borrar.length };
}

const estadoHTML = (p) => (p.programada
  ? `<span class="etiqueta-estado activo">Programada · ${esc(conDia(p.fechaProgramada))}</span>${p.montoProgramado && Math.abs(p.montoProgramado - p.saldo) > 0.01 ? `<br><small>${monto(p.montoProgramado, p.moneda)} de ${monto(p.saldo, p.moneda)}</small>` : ""}`
  : `<span class="etiqueta-estado neutro">Pendiente de programación</span>`);

/* ── Vista del hotel ──────────────────────────────────────────────── */
export function vistaPorPagarAdmin(cont, ctx) {
  const gestiona = puedeGestionar(ctx.perfil.rol);
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo"><div><h2>Por pagar (lo que ve cada proveedor)</h2>
        <p>Cada proveedor ve en «Por pagar» sus facturas pendientes según SAP y, si están en una propuesta de pago aprobada, la fecha programada.
        Se publica con el archivo <b>«Para el portal de proveedores»</b> de Control de vencimientos → Programación de pagos (o el Excel de la consulta «Vencimientos proveedores» de SAP, sin fechas programadas).
        Cada carga <b>reemplaza</b> la anterior: lo que ya no figura (porque se pagó) se quita solo.</p></div>
        ${gestiona ? `<div class="acciones"><button type="button" class="btn chico oscuro" id="pp-subir">${icono("subir")}Cargar archivo</button>
          <input type="file" id="pp-in" accept=".xlsx" class="sr-only"></div>` : ""}</div>
      <div id="pp-info"><p class="ayuda">Cargando…</p></div>
      <div id="pp-previa"></div>
    </div>
    <div class="panel">
      <div class="panel-titulo"><div><h2>Facturas publicadas</h2></div></div>
      <div class="barra-filtros">
        <label class="campo"><span>RUC</span><input class="input chico" id="pp-ruc" placeholder="11 dígitos" inputmode="numeric" maxlength="11" autocomplete="off"></label>
        <label class="campo"><span>Mostrar</span><select class="select chico" id="pp-filtro"><option value="">Todas</option><option value="prog">Solo programadas</option></select></label>
      </div>
      <div class="tabla-caja"><table>
        <thead><tr><th>Proveedor</th><th>Factura</th><th>Emisión</th><th>Vencimiento</th><th class="num">Saldo</th><th>Estado</th></tr></thead>
        <tbody id="pp-tb"><tr><td colspan="6" class="vacio">Cargando…</td></tr></tbody>
      </table></div>
      <div id="pp-pag"></div>
    </div>`;

  async function info() {
    try {
      const s = await getDoc(doc(db, "porpagar_cargas", "actual")), d = s.exists() ? s.data() : null;
      $("#pp-info", cont).innerHTML = d ? `<div class="tarjetas">
        <div class="tarjeta destacada"><div class="etiqueta">Publicado</div><div class="valor">${(d.documentos || 0).toLocaleString("es-PE")} facturas</div><div class="sub">${(d.proveedores || 0).toLocaleString("es-PE")} proveedores · datos de SAP al ${fechaCorta(d.datosAl)}</div></div>
        <div class="tarjeta"><div class="etiqueta">Programadas</div><div class="valor">${(d.programadas || 0).toLocaleString("es-PE")}</div><div class="sub">con fecha de pago aprobada</div></div>
        <div class="tarjeta"><div class="etiqueta">Saldo pendiente</div><div class="valor">S/ ${soles(d.totalPEN)}</div><div class="sub">${d.totalUSD ? `USD ${soles(d.totalUSD)}` : "sin facturas en dólares"}</div></div>
        <div class="tarjeta"><div class="etiqueta">Última carga</div><div class="valor">${fechaHora(d.cargadoEn)}</div><div class="sub">${esc(d.archivo || "")} · ${esc(d.cargadoPor || "")}</div></div></div>`
        : `<div class="aviso">Todavía no se publicó nada. ${gestiona ? "Cargue el archivo de Control de vencimientos." : ""}</div>`;
    } catch (err) { console.error("Portal: porpagar_cargas", err); $("#pp-info", cont).innerHTML = `<div class="aviso rojo">No se pudo leer la última carga.</div>`; }
  }

  function consulta() {
    const ruc = $("#pp-ruc", cont).value.replace(/\D/g, ""), prog = $("#pp-filtro", cont).value === "prog";
    if (ruc && ruc.length !== 11) return null;
    const filtros = [...(ruc ? [where("ruc", "==", ruc)] : []), ...(prog ? [where("programada", "==", true)] : [])];
    return { col: colPP(), filtros, orden: [orderBy(prog ? "fechaProgramada" : "fechaVencimiento", "asc")] };
  }
  const ps = paginaServidor({
    clave: "adm-porpagar", etiqueta: "facturas", barra: $("#pp-pag", cont), consulta,
    pintar: (docs) => {
      const hoy = hoyISO();
      $("#pp-tb", cont).innerHTML = docs.map((d) => { const p = d.data();
        return `<tr><td>${esc(p.razonSocial)}<br><small class="mono">${esc(p.ruc)}</small></td><td class="mono">${esc(p.factura)}</td>
          <td>${fechaCorta(p.fechaEmision)}</td><td>${fechaCorta(p.fechaVencimiento)}${p.fechaVencimiento < hoy ? ' <small class="descuento">vencida</small>' : ""}</td>
          <td class="num">${monto(p.saldo, p.moneda)}</td><td>${estadoHTML(p)}</td></tr>`; }).join("")
        || `<tr><td colspan="6" class="vacio">No hay facturas con estos filtros.</td></tr>`;
    },
    alError: (err) => { console.error("Portal: porpagar", err); $("#pp-tb", cont).innerHTML = `<tr><td colspan="6" class="vacio">No se pudieron leer las facturas.</td></tr>`; },
  });
  let espera = 0;
  $("#pp-ruc", cont).addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(() => ps.cargar(true), 400); });
  $("#pp-filtro", cont).addEventListener("change", () => ps.cargar(true));

  if (gestiona) {
    $("#pp-subir", cont).addEventListener("click", () => $("#pp-in", cont).click());
    $("#pp-in", cont).addEventListener("change", async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      const prev = $("#pp-previa", cont);
      try {
        const r = interpretarPorPagar(await leerXlsx(f));
        const prov = new Set(r.lista.map((x) => x.ruc)).size, prog = r.lista.filter((x) => x.programada).length;
        prev.innerHTML = `<div class="aviso ${r.conProgramacion ? "" : "amarillo"}">
          <b>${esc(f.name)}</b>: ${r.lista.length.toLocaleString("es-PE")} facturas pendientes de ${prov.toLocaleString("es-PE")} proveedores, ${prog} programadas · datos al ${fechaCorta(r.datosAl)}.
          ${r.conProgramacion ? "" : "<br>Este archivo no trae fechas programadas (es el Excel de SAP): los proveedores verán sus facturas como «Pendiente de programación»."}
          ${r.avisos.length ? `<br>${r.avisos.length} fila(s) omitidas: ${esc(r.avisos.slice(0, 4).join(" · "))}${r.avisos.length > 4 ? "…" : ""}` : ""}
          <div class="acciones" style="margin-top:8px"><button type="button" class="btn chico oscuro" id="pp-ok">${icono("check")}Publicar en el portal</button>
          <button type="button" class="btn chico" id="pp-cancelar">Cancelar</button></div></div>`;
        $("#pp-cancelar", cont).addEventListener("click", () => { prev.innerHTML = ""; });
        $("#pp-ok", cont).addEventListener("click", async () => {
          if (!(await confirmar({ titulo: "Publicar facturas por pagar", textoOk: "Publicar",
            mensaje: `Se reemplaza lo publicado: cada proveedor verá sus facturas pendientes de este archivo (${r.lista.length} en total) y se quitan las que ya no figuran.` }))) return;
          const b = $("#pp-ok", cont); b.disabled = true;
          try {
            const x = await publicar(r, f.name, ctx, (n, t) => { b.textContent = `Guardando ${n} de ${t}…`; });
            prev.innerHTML = `<div class="aviso verde">Publicado: ${x.escritas.toLocaleString("es-PE")} facturas${x.borradas ? ` · se quitaron ${x.borradas} que ya no figuran (pagadas)` : ""}.</div>`;
            notificar("Facturas por pagar publicadas");
            info(); ps.cargar(true);
          } catch (err) { console.error("Portal: publicar porpagar", err); b.disabled = false; b.textContent = "Publicar en el portal"; notificar("No se pudo publicar: " + (err.code || err.message), "error"); }
        });
      } catch (err) { prev.innerHTML = `<div class="aviso rojo">${esc(err.message)}</div>`; }
    });
  }
  info(); ps.cargar(true);
  return () => { ps.detener(); clearTimeout(espera); };
}

/* ── Vista del proveedor ──────────────────────────────────────────── */
export function vistaPorPagarProveedor(cont, ctx) {
  const ruc = ctx.perfil.ruc;
  cont.innerHTML = `
    <div class="tarjetas" id="pp-kpis"></div>
    <div class="panel">
      <div class="panel-titulo"><div><h2>Facturas por pagar</h2>
        <p>Tus facturas registradas en el hotel que aún no se pagan. Si ya tienen fecha de pago aprobada, se indica aquí; cuando se abone, la verás en «Mis pagos».</p></div>
        <div class="acciones"><button type="button" class="btn chico" id="pp-act">${icono("refrescar")}Actualizar</button></div></div>
      <div class="tabla-caja"><table>
        <thead><tr><th>Factura</th><th>Emisión</th><th>Vencimiento</th><th class="num">Saldo</th><th>Estado</th></tr></thead>
        <tbody id="pp-tb"><tr><td colspan="5" class="vacio">Cargando…</td></tr></tbody>
      </table></div>
      <div id="pp-pag"></div>
      <p class="ayuda">La fecha programada es referencial y puede cambiar. ¿Dudas? Escribe a <a href="mailto:${esc(CORREO_CONTABILIDAD)}">${esc(CORREO_CONTABILIDAD)}</a> con tu RUC y el número de factura.</p>
    </div>`;
  const base = () => [where("ruc", "==", ruc)];
  async function kpis() {
    try {
      const q = query(colPP(), ...base());
      const [n, pen, usd, prog, prox] = await Promise.all([
        agregar(q, { n: count() }),
        agregar(query(colPP(), ...base(), where("moneda", "==", "PEN")), { s: sum("saldo") }),
        agregar(query(colPP(), ...base(), where("moneda", "==", "USD")), { s: sum("saldo") }),
        agregar(query(colPP(), ...base(), where("programada", "==", true)), { n: count() }),
        getDocs(query(colPP(), ...base(), where("programada", "==", true), where("fechaProgramada", ">=", hoyISO()), orderBy("fechaProgramada", "asc"), limit(1))),
      ]);
      const p = prox.docs[0]?.data();
      $("#pp-kpis", cont).innerHTML = `
        <div class="tarjeta destacada"><div class="etiqueta">Pendiente de pago</div><div class="valor">${!pen.s && usd.s ? `USD ${soles(usd.s)}` : `S/ ${soles(pen.s)}`}</div><div class="sub">${pen.s && usd.s ? `y USD ${soles(usd.s)}` : usd.s ? "en dólares" : "en soles"}</div></div>
        <div class="tarjeta"><div class="etiqueta">Facturas pendientes</div><div class="valor">${(n.n || 0).toLocaleString("es-PE")}</div><div class="sub">${prog.n || 0} con fecha de pago</div></div>
        <div class="tarjeta"><div class="etiqueta">Próximo pago programado</div><div class="valor">${p ? esc(conDia(p.fechaProgramada)) : "—"}</div><div class="sub">${p ? `${esc(p.factura)} · ${monto(p.montoProgramado || p.saldo, p.moneda)}` : "Aún sin fecha"}</div></div>
        <div class="tarjeta"><div class="etiqueta">Información al</div><div class="valor"><span id="pp-al">—</span></div><div class="sub">según los registros de SAP</div></div>`;
    } catch (err) { console.error("Portal: kpis porpagar", err); }
  }
  const ps = paginaServidor({
    clave: "prov-porpagar", etiqueta: "facturas", barra: $("#pp-pag", cont),
    consulta: () => ({ col: colPP(), filtros: base(), orden: [orderBy("fechaVencimiento", "asc")] }),
    pintar: (docs) => {
      const filas = docs.map((d) => d.data());
      const al = filas[0]?.datosAl; const e = $("#pp-al", cont); if (e && al) e.textContent = fechaCorta(al);
      $("#pp-tb", cont).innerHTML = filas.map((p) => `<tr><td class="mono">${esc(p.factura)}</td><td>${fechaCorta(p.fechaEmision)}</td>
        <td>${fechaCorta(p.fechaVencimiento)}</td><td class="num">${monto(p.saldo, p.moneda)}</td><td>${estadoHTML(p)}</td></tr>`).join("")
        || `<tr><td colspan="5" class="vacio">No tienes facturas pendientes de pago registradas.</td></tr>`;
    },
    alError: (err) => { console.error("Portal: porpagar", err); $("#pp-tb", cont).innerHTML = `<tr><td colspan="5" class="vacio">No se pudieron cargar tus facturas por pagar.</td></tr>`; },
  });
  $("#pp-act", cont).addEventListener("click", () => { ps.recargar(); kpis(); notificar("Actualizado"); });
  kpis().then(() => ps.cargar(true));
  return () => ps.detener();
}
