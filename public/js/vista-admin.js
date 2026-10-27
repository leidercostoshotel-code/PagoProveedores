/* ══════════════════════════════════════════════════════════════════
   ADMINISTRACIÓN (personal del hotel: admin / contabilidad / consulta)
   Pestañas: Pagos · Cargar lote · Lotes · Proveedores · Usuarios.
   Lo que cada rol puede hacer lo decide de verdad firestore.rules; aquí
   solo se esconden los botones que no le corresponden.
   ══════════════════════════════════════════════════════════════════ */
import { db, crearUsuario, restablecerClave } from "./firebase.js";
import {
  collection, query, where, orderBy, getDocs, getDoc, doc, setDoc, updateDoc,
  writeBatch, serverTimestamp, sum,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  $, esc, icono, soles, solesS, fechaCorta, fechaHora, toISO, hoyISO,
  abrirModal, confirmar, notificar, descargarCSV, generarClave, validarClaveNueva, ERRORES_ALTA,
  paginador,
} from "./util.js";
import { ROLES_INTERNOS, etiquetaRol, puedeGestionar } from "./roles.js";
import { leerArchivo, interpretarLote } from "./bcp.js";
import { constancia } from "./vista-proveedor.js";
import { paginaServidor } from "./paginaServidor.js";
import { DOMINIO_PROVEEDORES } from "./config.js";

export function pestanas(rol) {
  return [
    { id: "pagos", texto: "Pagos", icono: "recibo" },
    ...(puedeGestionar(rol) ? [{ id: "cargar", texto: "Cargar lote", icono: "subir" }] : []),
    { id: "lotes", texto: "Lotes", icono: "capas" },
    { id: "proveedores", texto: "Proveedores", icono: "edificio" },
    ...(rol === "admin" ? [{ id: "usuarios", texto: "Usuarios", icono: "usuarios" }] : []),
  ];
}

export function montar(id, cont, ctx) {
  const vistas = { pagos: vistaPagos, cargar: vistaCargar, lotes: vistaLotes, proveedores: vistaProveedores, usuarios: vistaUsuarios };
  return vistas[id](cont, ctx);
}

const sumar = (lista, k) => lista.reduce((s, p) => s + (Number(p[k]) || 0), 0);
const quien = (ctx) => ctx.perfil.nombre || ctx.user.email;
const estadoUsuario = (u) => !u.activo
  ? `<span class="etiqueta-estado inactivo">Inactivo</span>`
  : u.debeCambiarClave && u.rol !== "proveedor" ? `<span class="etiqueta-estado pendiente">Clave inicial</span>` : `<span class="etiqueta-estado activo">Activo</span>`;

/** Muestra las credenciales recién creadas para entregarlas (solo se ven esta vez). */
function modalCredenciales(titulo, usuario, clave, { pideCambio = true } = {}) {
  const { el } = abrirModal(`
    <div class="modal-cab"><h2>${esc(titulo)}</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
    <p class="modal-sub">Entrega estos datos por un medio seguro.${pideCambio ? " La clave solo se muestra ahora; al primer ingreso se le pedirá cambiarla." : ""}</p>
    <div class="aviso azul"><div>Usuario: <b class="mono">${esc(usuario)}</b></div><div>Clave: <b class="mono">${esc(clave)}</b></div></div>
    <div class="modal-pie">
      <button type="button" class="btn" data-copiar>${icono("archivo")}Copiar</button>
      <button type="button" class="btn oscuro" data-cerrar>${icono("check")}Listo</button>
    </div>`);
  el.querySelector("[data-copiar]").addEventListener("click", () => {
    navigator.clipboard?.writeText(`Portal de Proveedores\nUsuario: ${usuario}\nClave: ${clave}\n${location.origin}`)
      .then(() => notificar("Copiado"), () => notificar("No se pudo copiar", "error"));
  });
}

/** Modal para restablecer la clave de otra cuenta (vía Cloud Function). */
function modalRestablecer(u) {
  const esProv = u.rol === "proveedor";
  const { el, cerrar } = abrirModal(`
    <form novalidate>
      <div class="modal-cab"><h2>Restablecer clave</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
      <p class="modal-sub">${esc(u.razonSocial || u.nombre || "")} · ${esc(u.ruc || u.email)}</p>
      <label class="campo"><span>${esProv ? "Clave nueva (por defecto su RUC)" : "Clave temporal"}</span>
        <div style="display:flex;gap:6px"><input class="input mono" id="rc-clave" value="${esc(esProv ? u.ruc : generarClave())}" autocomplete="off">
        <button type="button" class="btn" id="rc-gen" title="Generar otra">${icono("dados")}</button></div></label>
      <p class="error" id="rc-error" hidden></p>
      <div class="modal-pie"><button type="button" class="btn" data-cerrar>Cancelar</button>
        <button type="submit" class="btn oscuro" id="rc-btn">${icono("llave")}Restablecer</button></div>
    </form>`);
  $("#rc-gen", el).addEventListener("click", () => { $("#rc-clave", el).value = generarClave(); });
  $("form", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const clave = $("#rc-clave", el).value.trim();
    const v = esProv && clave === u.ruc ? "" : validarClaveNueva(clave);
    if (v) { $("#rc-error", el).textContent = v; $("#rc-error", el).hidden = false; return; }
    $("#rc-btn", el).disabled = true;
    try {
      await restablecerClave(u.uid, clave);
      cerrar();
      modalCredenciales("Clave restablecida", u.ruc || u.email, clave, { pideCambio: !esProv });
    } catch (err) {
      console.error("Portal: no se pudo restablecer la clave", err);
      $("#rc-btn", el).disabled = false;
      $("#rc-error", el).textContent = err.code === "functions/permission-denied"
        ? "No tienes permiso para restablecer esta clave."
        : "No se pudo restablecer. Verifica que las Cloud Functions estén desplegadas (ver README).";
      $("#rc-error", el).hidden = false;
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   PAGOS — consulta de todos los pagos
   ══════════════════════════════════════════════════════════════════ */
function vistaPagos(cont, ctx) {
  const hace90 = toISO(new Date(Date.now() - 90 * 864e5));
  const p = ctx.params || {};
  const tipoIni = p.ruc ? "ruc" : p.lote ? "lote" : "";
  cont.innerHTML = `
    <div class="tarjetas" id="kpis"></div>
    <div class="panel">
      <div class="panel-titulo">
        <div><h2>Pagos a proveedores</h2><p id="descripcion"></p></div>
        <div class="acciones">
          <button type="button" class="btn chico" id="exportar">${icono("bajar")}Excel (CSV)</button>
          <button type="button" class="btn chico" id="imprimir">${icono("impresora")}Imprimir</button>
        </div>
      </div>
      <form class="barra-filtros" id="filtros">
        <label class="campo"><span>Desde</span><input class="input chico" type="date" id="f-desde" value="${p.lote ? "" : hace90}"></label>
        <label class="campo"><span>Hasta</span><input class="input chico" type="date" id="f-hasta" value="${p.lote ? "" : hoyISO()}"></label>
        <label class="campo"><span>Buscar por</span><select class="select chico" id="f-tipo">
          <option value="" ${tipoIni ? "" : "selected"}>Todas (por fechas)</option>
          <option value="ruc" ${tipoIni === "ruc" ? "selected" : ""}>RUC</option>
          <option value="razon">Razón social (cómo empieza)</option>
          <option value="factura">N° de factura</option>
          <option value="lote" ${tipoIni === "lote" ? "selected" : ""}>Lote</option>
        </select></label>
        <label class="campo crece"><span>Texto</span>
          <input class="input chico" style="width:100%" id="f-buscar" value="${esc(p.ruc || p.lote || "")}" placeholder="20123456789 · DISTRIBUIDORA · F001-00452 · BCP_20261024_…" autocomplete="off"></label>
        <button class="btn oscuro" type="submit">${icono("buscar")}Buscar</button>
      </form>
      <p class="error" id="f-error" hidden></p>
      <div class="tabla-caja"><table>
        <thead><tr><th>Fecha abono</th><th>RUC</th><th>Razón social</th><th>Factura</th><th>Banco</th><th class="num">Bruto</th>
          <th class="num">Retención</th><th class="num">Detracción</th><th class="num">N. crédito</th><th class="num">Neto</th><th>Lote</th></tr></thead>
        <tbody id="tb"><tr><td colspan="11" class="vacio">Cargando…</td></tr></tbody><tfoot id="tf"></tfoot>
      </table></div>
      <div id="pag"></div>
    </div>`;

  /* Filtros → consulta de Firestore. RUC y fechas van juntos; razón social,
     factura y lote buscan en todas las fechas (Firestore no combina dos rangos). */
  let filtroActual = null;
  function armarConsulta() {
    const tipo = $("#f-tipo", cont).value, texto = $("#f-buscar", cont).value.trim();
    const desde = $("#f-desde", cont).value, hasta = $("#f-hasta", cont).value;
    const col = collection(db, "pagos");
    const rango = [...(desde ? [where("fechaPago", ">=", desde)] : []), ...(hasta ? [where("fechaPago", "<=", hasta)] : [])];
    const fechas = `${desde ? ` desde el ${fechaCorta(desde)}` : ""}${hasta ? ` hasta el ${fechaCorta(hasta)}` : ""}`;
    const desc = { "": `Abonos${fechas || " de todas las fechas"}.` };
    if (tipo && !texto) return { error: "Escribe qué buscar." };
    if (tipo === "ruc") {
      if (!/^\d{11}$/.test(texto)) return { error: "El RUC debe tener 11 dígitos." };
      return { col, filtros: [where("ruc", "==", texto), ...rango], orden: [orderBy("fechaPago", "desc")], desc: `Pagos del RUC ${texto}${fechas}.` };
    }
    if (tipo === "razon") {
      const T = texto.toUpperCase();
      return { col, filtros: [where("razonSocial", ">=", T), where("razonSocial", "<=", `${T}`)], orden: [orderBy("razonSocial"), orderBy("fechaPago", "desc")], desc: `Razón social que empieza con “${T}” (todas las fechas).` };
    }
    if (tipo === "factura") return { col, filtros: [where("factura", "==", texto.toUpperCase())], orden: [orderBy("fechaPago", "desc")], desc: `Factura ${texto.toUpperCase()} (todas las fechas).` };
    if (tipo === "lote") return { col, filtros: [where("lote", "==", texto)], orden: [orderBy("fechaPago", "desc")], desc: `Pagos del lote ${texto}.` };
    return { col, filtros: rango, orden: [orderBy("fechaPago", "desc")], desc: desc[""] };
  }
  let docsPagina = [];
  const ps = paginaServidor({
    clave: "adm-pagos", etiqueta: "facturas", barra: $("#pag", cont),
    consulta: () => filtroActual,
    agregados: { bruto: sum("bruto"), retencion: sum("retencion"), detraccion: sum("detraccion"), notaCredito: sum("notaCredito"), neto: sum("neto") },
    pintar: (docs, st) => {
      docsPagina = docs.map((d) => ({ id: d.id, ...d.data() }));
      const a = st.agg;
      $("#kpis", cont).innerHTML = `
        <div class="tarjeta destacada"><div class="etiqueta">Total abonado</div><div class="valor">${solesS(a.neto)}</div><div class="sub">neto pagado en la consulta</div></div>
        <div class="tarjeta"><div class="etiqueta">Facturas</div><div class="valor">${(st.total || 0).toLocaleString("es-PE")}</div><div class="sub">en la consulta</div></div>
        <div class="tarjeta"><div class="etiqueta">Retenciones</div><div class="valor">${soles(a.retencion)}</div><div class="sub">Detracciones: ${soles(a.detraccion)}</div></div>
        <div class="tarjeta"><div class="etiqueta">Notas de crédito</div><div class="valor">${soles(a.notaCredito)}</div><div class="sub">Bruto: ${soles(a.bruto)}</div></div>`;
      $("#tb", cont).innerHTML = docsPagina.map((x, i) => `
        <tr class="clic" data-i="${i}">
          <td>${fechaCorta(x.fechaPago)}</td><td class="mono">${esc(x.ruc)}</td><td>${esc(x.razonSocial)}</td><td class="mono">${esc(x.factura)}</td><td>${esc(x.banco)}</td>
          <td class="num">${soles(x.bruto)}</td><td class="num descuento">${x.retencion ? soles(x.retencion) : "—"}</td>
          <td class="num descuento">${x.detraccion ? soles(x.detraccion) : "—"}</td><td class="num descuento">${x.notaCredito ? soles(x.notaCredito) : "—"}</td>
          <td class="num neto">${soles(x.neto)}</td><td class="mono" style="font-size:10.5px">${esc(x.lote)}</td>
        </tr>`).join("") || `<tr><td colspan="11" class="vacio">No hay pagos con estos filtros.</td></tr>`;
      $("#tf", cont).innerHTML = st.total ? `<tr><td colspan="5">Total de la consulta (${st.total.toLocaleString("es-PE")})</td><td class="num">${soles(a.bruto)}</td>
        <td class="num">${soles(a.retencion)}</td><td class="num">${soles(a.detraccion)}</td>
        <td class="num">${soles(a.notaCredito)}</td><td class="num">${soles(a.neto)}</td><td></td></tr>` : "";
    },
    alError: (err) => {
      console.error("Portal: no se pudieron leer los pagos", err);
      $("#tb", cont).innerHTML = `<tr><td colspan="11" class="vacio">No se pudieron cargar los pagos (${esc(err.code || err.message)}).</td></tr>`;
    },
  });
  function buscar() {
    const c = armarConsulta();
    $("#f-error", cont).hidden = !c.error;
    if (c.error) { $("#f-error", cont).textContent = c.error; return; }
    filtroActual = c;
    $("#descripcion", cont).textContent = c.desc;
    $("#tb", cont).innerHTML = `<tr><td colspan="11" class="vacio">Cargando…</td></tr>`;
    ps.cargar(true);
  }
  $("#filtros", cont).addEventListener("submit", (e) => { e.preventDefault(); buscar(); });
  $("#tb", cont).addEventListener("click", (e) => { const tr = e.target.closest("tr[data-i]"); if (tr) constancia(docsPagina[Number(tr.dataset.i)]); });
  $("#exportar", cont).addEventListener("click", async () => {
    if (!filtroActual) return;
    const total = ps.estado.total;
    if (total > 500 && !(await confirmar({ titulo: "Descargar pagos", textoOk: "Descargar",
      mensaje: `Se descargarán las ${total.toLocaleString("es-PE")} facturas de esta consulta (puede tardar unos segundos).` }))) return;
    try {
      const snap = await getDocs(query(filtroActual.col, ...filtroActual.filtros, ...filtroActual.orden));
      descargarCSV(`pagos_${hoyISO()}.csv`,
        ["Fecha abono", "RUC", "Razón social", "Factura", "Banco", "Cuenta abono", "Bruto", "Retención", "Detracción", "Nota de crédito", "Neto", "Lote"],
        snap.docs.map((d) => { const x = d.data(); return [x.fechaPago, x.ruc, x.razonSocial, x.factura, x.banco, x.cuentaAbono, x.bruto, x.retencion, x.detraccion, x.notaCredito, x.neto, x.lote]; }));
    } catch (err) {
      console.error("Portal: no se pudo descargar", err);
      notificar("No se pudo descargar", "error");
    }
  });
  $("#imprimir", cont).addEventListener("click", () => window.print());
  buscar();
  return () => ps.detener();
}

/* ══════════════════════════════════════════════════════════════════
   CARGAR LOTE — TXT de Telecrédito BCP + CSV de descuentos de SAP B1
   (lo mismo que hace scripts/cargar-pagos-bcp.js, pero desde el navegador)
   ══════════════════════════════════════════════════════════════════ */
function vistaCargar(cont, ctx) {
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo"><div><h2>Cargar lote de pagos</h2>
        <p>Sube el TXT de Pago a Proveedores de Telecrédito BCP y, si lo tienes, el CSV de descuentos de SAP B1. Primero verás una vista previa; nada se guarda hasta que confirmes.</p></div></div>
      <div class="grilla-2">
        ${zona("txt", "Archivo TXT del banco", "PROV_AAAAMMDD.txt · obligatorio", ".txt,text/plain")}
        ${zona("csv", "CSV de descuentos (SAP B1)", "factura;ruc;bruto;retencion;detraccion;notaCredito · opcional", ".csv,text/csv")}
      </div>
      <div class="acciones" style="margin-top:12px"><button type="button" class="btn oscuro" id="interpretar" disabled>${icono("buscar")}Ver vista previa</button></div>
    </div>
    <div id="vista-previa"></div>`;

  const archivos = { txt: null, csv: null };
  for (const tipo of ["txt", "csv"]) {
    const z = $(`#zona-${tipo}`, cont), inp = $(`#arch-${tipo}`, cont);
    const poner = (f) => {
      archivos[tipo] = f || null;
      $(`#nombre-${tipo}`, cont).textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(1)} KB` : "";
      $("#interpretar", cont).disabled = !archivos.txt;
      $("#vista-previa", cont).innerHTML = "";
    };
    inp.addEventListener("change", () => poner(inp.files[0]));
    z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("sobre"); });
    z.addEventListener("dragleave", () => z.classList.remove("sobre"));
    z.addEventListener("drop", (e) => { e.preventDefault(); z.classList.remove("sobre"); poner(e.dataTransfer.files[0]); });
  }

  $("#interpretar", cont).addEventListener("click", async () => {
    try {
      const [txt, csv] = await Promise.all([leerArchivo(archivos.txt), archivos.csv ? leerArchivo(archivos.csv) : ""]);
      const r = interpretarLote(txt, archivos.txt.name, csv);
      const [loteExiste, cuentas] = await Promise.all([
        getDoc(doc(db, "lotes", r.lote)).then((s) => s.exists()).catch(() => false),
        rucsConCuenta([...new Set(r.pagos.map((x) => x.ruc))]).catch(() => new Set()),
      ]);
      vistaPrevia(r, loteExiste, cuentas, archivos);
    } catch (err) {
      console.error("Portal: no se pudo interpretar el lote", err);
      $("#vista-previa", cont).innerHTML = `<div class="aviso rojo">No se pudo leer el archivo: ${esc(err.message)}</div>`;
    }
  });

  function vistaPrevia(r, loteExiste, cuentas, archs) {
    const sinCuenta = [...new Map(r.pagos.filter((x) => !cuentas.has(x.ruc)).map((x) => [x.ruc, x])).values()];
    const caja = $("#vista-previa", cont);
    caja.innerHTML = `
      <div class="tarjetas">
        <div class="tarjeta destacada"><div class="etiqueta">Total del lote</div><div class="valor">${solesS(r.total)}</div><div class="sub">abonado el ${fechaCorta(r.fechaPago)}</div></div>
        <div class="tarjeta"><div class="etiqueta">Facturas</div><div class="valor">${r.pagos.length}</div><div class="sub">${r.proveedores} proveedor${r.proveedores === 1 ? "" : "es"}</div></div>
        <div class="tarjeta"><div class="etiqueta">Lote</div><div class="valor" style="font-size:14px">${esc(r.lote)}</div><div class="sub">${loteExiste ? "Ya cargado antes: se actualizará" : "Lote nuevo"}</div></div>
        <div class="tarjeta"><div class="etiqueta">Sin cuenta en el portal</div><div class="valor">${sinCuenta.length}</div><div class="sub">proveedores que aún no pueden consultar</div></div>
      </div>
      ${loteExiste ? `<div class="aviso amarillo">Este lote ya se cargó antes. Si confirmas, se actualizarán los mismos registros (no se duplican).</div>` : ""}
      ${r.avisos.length ? `<div class="aviso amarillo"><b>Revisa antes de confirmar (${r.avisos.length}):</b><ul>${r.avisos.slice(0, 15).map((a) => `<li>${esc(a)}</li>`).join("")}${r.avisos.length > 15 ? `<li>…y ${r.avisos.length - 15} más</li>` : ""}</ul></div>` : ""}
      <div class="panel">
        <div class="panel-titulo"><div><h2>Vista previa</h2><p>Así lo verá cada proveedor en el portal.</p></div>
          <div class="acciones"><button type="button" class="btn oscuro" id="confirmar" ${r.pagos.length ? "" : "disabled"}>${icono("check")}Confirmar carga</button></div></div>
        <div class="tabla-caja"><table>
          <thead><tr><th>RUC</th><th>Razón social</th><th>Factura</th><th>Cuenta abono</th><th class="num">Bruto</th><th class="num">Retención</th>
            <th class="num">Detracción</th><th class="num">N. crédito</th><th class="num">Neto</th><th>Portal</th></tr></thead>
          <tbody id="tb-previa"></tbody>
          <tfoot><tr><td colspan="8">Total (${r.pagos.length})</td><td class="num">${soles(r.total)}</td><td></td></tr></tfoot>
        </table></div>
        <div id="pag-previa"></div>
      </div>`;
    const pag = paginador("adm-previa", pintarPrevia, { etiqueta: "facturas" });
    pag.enganchar($("#pag-previa", caja));
    function pintarPrevia() {
      const { visibles, html } = pag.cortar(r.pagos);
      $("#pag-previa", caja).innerHTML = html;
      $("#tb-previa", caja).innerHTML = visibles.map((x) => `<tr>
        <td class="mono">${esc(x.ruc)}</td><td>${esc(x.razonSocial)}</td><td class="mono">${esc(x.factura)}</td><td class="mono">${esc(x.cuentaAbono)}</td>
        <td class="num">${soles(x.bruto)}</td><td class="num">${soles(x.retencion)}</td><td class="num">${soles(x.detraccion)}</td>
        <td class="num">${soles(x.notaCredito)}</td><td class="num neto">${soles(x.neto)}</td>
        <td>${cuentas.has(x.ruc) ? `<span class="etiqueta-estado activo">Con cuenta</span>`
          : `<button type="button" class="btn chico" data-crear="${esc(x.ruc)}" data-razon="${esc(x.razonSocial)}">${icono("mas")}Crear cuenta</button>`}</td>
      </tr>`).join("") || `<tr><td colspan="10" class="vacio">El archivo no tiene pagos.</td></tr>`;
    }
    pintarPrevia();
    $("#tb-previa", caja).addEventListener("click", (e) => {
      const b = e.target.closest("[data-crear]");
      if (b) modalProveedor(ctx, { ruc: b.dataset.crear, razonSocial: b.dataset.razon }, () => { cuentas.add(b.dataset.crear); pintarPrevia(); });
    });

    $("#confirmar", caja).addEventListener("click", async () => {
      const ok = await confirmar({ titulo: "Confirmar carga", textoOk: "Cargar lote",
        mensaje: `Se publicarán ${r.pagos.length} facturas por ${solesS(r.total)} (lote ${r.lote}). Los proveedores las verán de inmediato.` });
      if (!ok) return;
      const btn = $("#confirmar", caja);
      btn.disabled = true;
      try {
        for (let i = 0; i < r.pagos.length; i += 450) {
          const batch = writeBatch(db);
          for (const { id, ...datos } of r.pagos.slice(i, i + 450)) {
            // Quién cargó queda solo en "lotes": el proveedor lee su pago completo (F12) y no necesita nombres internos.
            batch.set(doc(db, "pagos", id), { ...datos, cargadoEn: serverTimestamp() }, { merge: true });
          }
          btn.textContent = `Guardando ${Math.min(i + 450, r.pagos.length)} de ${r.pagos.length}…`;
          await batch.commit();
        }
        await setDoc(doc(db, "lotes", r.lote), {
          lote: r.lote, banco: "BCP", fechaPago: r.fechaPago, facturas: r.pagos.length, proveedores: r.proveedores, total: r.total,
          archivoTxt: archs.txt.name, archivoCsv: archs.csv?.name || "", cargadoPor: quien(ctx), cargadoEn: serverTimestamp(),
        });
        notificar(`Lote cargado: ${r.pagos.length} facturas`);
        ctx.irA("lotes");
      } catch (err) {
        console.error("Portal: falló la carga del lote", err);
        btn.disabled = false;
        btn.innerHTML = `${icono("check")}Reintentar carga`;
        notificar("No se pudo completar la carga", "error");
      }
    });
  }
}
/** RUC (de la lista dada) que ya tienen cuenta de proveedor: lee solo esos, de 30 en 30. */
async function rucsConCuenta(rucs) {
  const con = new Set();
  for (let i = 0; i < rucs.length; i += 30) {
    const snap = await getDocs(query(collection(db, "usuarios"), where("rol", "==", "proveedor"), where("ruc", "in", rucs.slice(i, i + 30))));
    snap.docs.forEach((d) => con.add(d.data().ruc));
  }
  return con;
}
const zona = (tipo, titulo, ayuda, accept) => `
  <label class="zona-archivo" id="zona-${tipo}">
    ${icono("subir")}<b>${titulo}</b><small>${ayuda}</small><small>Arrastra el archivo aquí o haz clic para elegirlo</small>
    <span class="nombre-archivo" id="nombre-${tipo}"></span>
    <input type="file" id="arch-${tipo}" accept="${accept}" class="sr-only">
  </label>`;

/* ══════════════════════════════════════════════════════════════════
   LOTES — historial de cargas
   ══════════════════════════════════════════════════════════════════ */
function vistaLotes(cont, ctx) {
  const gestiona = puedeGestionar(ctx.perfil.rol);
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo"><div><h2>Lotes cargados</h2><p>Del más reciente al más antiguo. "Ver pagos" muestra el detalle de cada lote.</p></div></div>
      <div class="tabla-caja"><table>
        <thead><tr><th>Lote</th><th>Fecha de abono</th><th>Banco</th><th class="num">Facturas</th><th class="num">Proveedores</th>
          <th class="num">Total</th><th>Archivos</th><th>Cargado por</th><th></th></tr></thead>
        <tbody id="tb"><tr><td colspan="9" class="vacio">Cargando…</td></tr></tbody>
      </table></div>
      <div id="pag"></div>
    </div>`;
  const ps = paginaServidor({
    clave: "adm-lotes", etiqueta: "lotes", barra: $("#pag", cont),
    consulta: () => ({ col: collection(db, "lotes"), filtros: [], orden: [orderBy("cargadoEn", "desc")] }),
    pintar,
    alError: (err) => { $("#tb", cont).innerHTML = `<tr><td colspan="9" class="vacio">No se pudieron leer los lotes (${esc(err.code || err.message)}).</td></tr>`; },
  });
  function pintar(docs) {
    $("#tb", cont).innerHTML = docs.map((d) => { const l = d.data(); return `<tr>
      <td class="mono">${esc(d.id)}</td><td>${fechaCorta(l.fechaPago)}</td><td>${esc(l.banco)}</td>
      <td class="num">${l.facturas ?? "—"}</td><td class="num">${l.proveedores ?? "—"}</td><td class="num neto">${soles(l.total)}</td>
      <td style="font-size:11px">${esc(l.archivoTxt || "")}${l.archivoCsv ? `<br>${esc(l.archivoCsv)}` : ""}</td>
      <td style="font-size:11px">${esc(l.cargadoPor || "")}<br><span style="color:var(--gris)">${fechaHora(l.cargadoEn)}</span></td>
      <td><div class="acciones"><button type="button" class="btn chico" data-ver="${esc(d.id)}">${icono("recibo")}Ver pagos</button>
        ${gestiona ? `<button type="button" class="btn chico rojo" data-borrar="${esc(d.id)}" data-n="${l.facturas || 0}">${icono("basura")}Eliminar</button>` : ""}</div></td>
    </tr>`; }).join("") || `<tr><td colspan="9" class="vacio">Aún no se ha cargado ningún lote.</td></tr>`;
  }

  $("#tb", cont).addEventListener("click", async (e) => {
    const ver = e.target.closest("[data-ver]"), borrar = e.target.closest("[data-borrar]");
    if (ver) ctx.irA("pagos", { lote: ver.dataset.ver });
    if (!borrar) return;
    const id = borrar.dataset.borrar;
    const ok = await confirmar({ titulo: "Eliminar lote", peligroso: true, textoOk: "Eliminar",
      mensaje: `Se borrarán las ${borrar.dataset.n} facturas del lote ${id} y los proveedores dejarán de verlas. Úsalo solo si el lote se cargó por error.` });
    if (!ok) return;
    borrar.disabled = true;
    try {
      const snap = await getDocs(query(collection(db, "pagos"), where("lote", "==", id)));
      const refs = [...snap.docs.map((d) => d.ref), doc(db, "lotes", id)];
      for (let i = 0; i < refs.length; i += 450) {
        const batch = writeBatch(db);
        refs.slice(i, i + 450).forEach((ref) => batch.delete(ref));
        await batch.commit();
      }
      notificar("Lote eliminado");
      ps.recargar();
    } catch (err) {
      console.error("Portal: no se pudo eliminar el lote", err);
      borrar.disabled = false;
      notificar("No se pudo eliminar el lote", "error");
    }
  });
  ps.cargar(true);
  return () => ps.detener();
}

/* ══════════════════════════════════════════════════════════════════
   PROVEEDORES — cuentas de acceso (RUC + clave)
   ══════════════════════════════════════════════════════════════════ */
function vistaProveedores(cont, ctx) {
  const gestiona = puedeGestionar(ctx.perfil.rol);
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo">
        <div><h2>Proveedores con acceso</h2><p>Cada proveedor entra con su RUC. Desactivar le corta el acceso de inmediato.</p></div>
        <div class="acciones">${gestiona ? `<button type="button" class="btn oscuro" id="nuevo">${icono("mas")}Nuevo proveedor</button>` : ""}
          <button type="button" class="btn chico" id="exportar">${icono("bajar")}CSV</button></div>
      </div>
      <div class="barra-filtros">
        <label class="campo crece"><span>Buscar</span><input class="input chico" style="width:100%" id="f-buscar" placeholder="RUC o razón social (cómo empieza)" autocomplete="off"></label>
        <label class="campo"><span>Estado</span><select class="select chico" id="f-estado">
          <option value="">Todos</option><option value="activo">Activos</option><option value="inactivo">Inactivos</option></select></label>
      </div>
      <div class="tabla-caja"><table>
        <thead><tr><th>RUC</th><th>Razón social</th><th>Contacto</th><th>Estado</th><th>Último ingreso</th><th>Alta</th><th></th></tr></thead>
        <tbody id="tb"><tr><td colspan="7" class="vacio">Cargando…</td></tr></tbody>
      </table></div>
      <div id="pag"></div>
    </div>`;

  /* Paginación en el servidor (paginaServidor): con miles de proveedores
     (importados de SAP) se lee solo la página visible y el total por conteo. */
  let lista = [];
  function filtros() {
    const t = $("#f-buscar", cont).value.trim(), est = $("#f-estado", cont).value;
    const conds = [where("rol", "==", "proveedor")];
    if (est) conds.push(where("activo", "==", est === "activo"));
    let campo = "razonSocial";
    if (/^\d+$/.test(t)) { campo = "ruc"; conds.push(where("ruc", ">=", t), where("ruc", "<=", `${t}\uf8ff`)); }
    else if (t) { const T = t.toUpperCase(); conds.push(where("razonSocial", ">=", T), where("razonSocial", "<=", `${T}\uf8ff`)); }
    return { conds, campo };
  }
  const ps = paginaServidor({
    clave: "adm-proveedores", etiqueta: "proveedores", barra: $("#pag", cont),
    consulta: () => { const { conds, campo } = filtros(); return { col: collection(db, "usuarios"), filtros: conds, orden: [orderBy(campo)] }; },
    pintar: (docs) => { lista = docs.map((d) => ({ uid: d.id, ...d.data() })); pintar(); },
    alError: (err) => {
      console.error("Portal: no se pudieron leer los proveedores", err);
      $("#tb", cont).innerHTML = `<tr><td colspan="7" class="vacio">No se pudieron leer los proveedores (${esc(err.code || err.message)}).</td></tr>`;
    },
  });
  const cargar = (reiniciar, recontar) => ps.cargar(reiniciar, recontar);
  function pintar() {
    $("#tb", cont).innerHTML = lista.map((u) => `<tr>
      <td class="mono">${esc(u.ruc)}</td><td>${esc(u.razonSocial)}</td>
      <td style="font-size:11px">${esc(u.contacto || "—")}${u.telefono ? `<br>${esc(u.telefono)}` : ""}</td>
      <td>${estadoUsuario(u)}</td><td style="font-size:11px">${fechaHora(u.ultimoIngreso)}</td><td style="font-size:11px">${fechaHora(u.creadoEn)}</td>
      <td><div class="acciones">
        <button type="button" class="btn chico" data-acc="pagos" data-uid="${esc(u.uid)}">${icono("recibo")}Pagos</button>
        ${gestiona ? `<button type="button" class="btn chico" data-acc="editar" data-uid="${esc(u.uid)}">Editar</button>
          <button type="button" class="btn chico" data-acc="clave" data-uid="${esc(u.uid)}">${icono("llave")}Clave</button>
          <button type="button" class="btn chico ${u.activo ? "rojo" : "verde"}" data-acc="activo" data-uid="${esc(u.uid)}">${u.activo ? "Desactivar" : "Activar"}</button>` : ""}
      </div></td></tr>`).join("") || `<tr><td colspan="7" class="vacio">${$("#f-buscar", cont).value || $("#f-estado", cont).value ? "Ningún proveedor coincide." : "Aún no hay proveedores con acceso."}</td></tr>`;
  }

  let espera = 0;
  $("#f-buscar", cont).addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(() => cargar(true), 400); });
  $("#f-estado", cont).addEventListener("change", () => cargar(true));
  $("#nuevo", cont)?.addEventListener("click", () => modalProveedor(ctx, {}, () => cargar(true)));
  $("#exportar", cont).addEventListener("click", async () => {
    const total = ps.estado.total;
    if (total > 500 && !(await confirmar({ titulo: "Descargar proveedores", textoOk: "Descargar",
      mensaje: `Se descargarán los ${total.toLocaleString("es-PE")} proveedores de este filtro (puede tardar unos segundos).` }))) return;
    try {
      const { conds, campo } = filtros();
      const snap = await getDocs(query(collection(db, "usuarios"), ...conds, orderBy(campo)));
      descargarCSV(`proveedores_${hoyISO()}.csv`, ["RUC", "Razón social", "Contacto", "Teléfono", "Activo", "Último ingreso"],
        snap.docs.map((d) => { const u = d.data(); return [u.ruc, u.razonSocial, u.contacto, u.telefono, u.activo ? "Sí" : "No", fechaHora(u.ultimoIngreso)]; }));
    } catch (err) {
      console.error("Portal: no se pudo descargar", err);
      notificar("No se pudo descargar", "error");
    }
  });
  $("#tb", cont).addEventListener("click", async (e) => {
    const b = e.target.closest("[data-acc]");
    if (!b) return;
    const u = lista.find((x) => x.uid === b.dataset.uid);
    if (b.dataset.acc === "pagos") ctx.irA("pagos", { ruc: u.ruc });
    if (b.dataset.acc === "editar") modalProveedor(ctx, u, null, () => cargar(false, true));
    if (b.dataset.acc === "clave") modalRestablecer(u);
    if (b.dataset.acc === "activo") {
      const ok = await confirmar({ titulo: u.activo ? "Desactivar proveedor" : "Activar proveedor", peligroso: u.activo,
        textoOk: u.activo ? "Desactivar" : "Activar",
        mensaje: u.activo ? `${u.razonSocial} (RUC ${u.ruc}) ya no podrá consultar sus pagos.` : `${u.razonSocial} (RUC ${u.ruc}) podrá volver a consultar sus pagos.` });
      if (ok) updateDoc(doc(db, "usuarios", u.uid), { activo: !u.activo, actualizadoPor: quien(ctx), actualizadoEn: serverTimestamp() })
        .then(() => { notificar(u.activo ? "Proveedor desactivado" : "Proveedor activado"); cargar(false, true); }, () => notificar("No se pudo actualizar", "error"));
    }
  });
  cargar(true);
  return () => { ps.detener(); clearTimeout(espera); };
}

/** Alta (sin uid) o edición (con uid) de un proveedor. `alCrear` / `alEditar` se llaman al guardar. */
function modalProveedor(ctx, u = {}, alCrear, alEditar) {
  const edicion = !!u.uid;
  const { el, cerrar } = abrirModal(`
    <form novalidate>
      <div class="modal-cab"><h2>${edicion ? "Editar proveedor" : "Nuevo proveedor"}</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
      <p class="modal-sub">${edicion ? "El RUC no se puede cambiar (es su usuario de ingreso)." : "Se crea su cuenta de acceso: entra con su RUC y esta clave (por defecto, su mismo RUC)."}</p>
      <label class="campo"><span>RUC</span><input class="input mono" id="p-ruc" maxlength="11" inputmode="numeric" value="${esc(u.ruc || "")}" ${edicion ? "disabled" : "autofocus"}></label>
      <label class="campo"><span>Razón social</span><input class="input" id="p-razon" value="${esc(u.razonSocial || "")}" ${edicion ? "autofocus" : ""}></label>
      <div class="grilla-2" style="gap:8px">
        <label class="campo"><span>Correo de contacto</span><input class="input" id="p-contacto" type="email" value="${esc(u.contacto || "")}" placeholder="opcional"></label>
        <label class="campo"><span>Teléfono</span><input class="input" id="p-telefono" value="${esc(u.telefono || "")}" placeholder="opcional"></label>
      </div>
      ${edicion ? "" : `<label class="campo"><span>Clave (por defecto su RUC)</span>
        <div style="display:flex;gap:6px"><input class="input mono" id="p-clave" value="${esc(u.ruc || "")}" autocomplete="off">
        <button type="button" class="btn" id="p-gen" title="Generar otra">${icono("dados")}</button></div></label>`}
      <p class="error" id="p-error" hidden></p>
      <div class="modal-pie"><button type="button" class="btn" data-cerrar>Cancelar</button>
        <button type="submit" class="btn oscuro" id="p-btn">${icono("check")}${edicion ? "Guardar" : "Crear acceso"}</button></div>
    </form>`);
  $("#p-gen", el)?.addEventListener("click", () => { $("#p-clave", el).value = generarClave(); });
  // Mientras no se escriba otra clave, la clave sigue al RUC.
  let rucPrevio = u.ruc || "";
  $("#p-ruc", el).addEventListener("input", () => {
    const inp = $("#p-clave", el);
    if (inp && inp.value === rucPrevio) inp.value = $("#p-ruc", el).value.trim();
    rucPrevio = $("#p-ruc", el).value.trim();
  });
  $("form", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = (t) => { $("#p-error", el).textContent = t; $("#p-error", el).hidden = false; };
    const ruc = $("#p-ruc", el).value.trim(), razon = $("#p-razon", el).value.trim().toUpperCase();
    const contacto = $("#p-contacto", el).value.trim(), telefono = $("#p-telefono", el).value.trim();
    if (!/^(10|15|17|20)\d{9}$/.test(ruc)) return error("El RUC debe tener 11 dígitos y empezar con 10, 15, 17 o 20");
    if (!razon) return error("Escribe la razón social");
    if (contacto && !/^\S+@\S+\.\S+$/.test(contacto)) return error("El correo de contacto no es válido");
    $("#p-btn", el).disabled = true;
    try {
      if (edicion) {
        await updateDoc(doc(db, "usuarios", u.uid), { razonSocial: razon, nombre: razon, contacto, telefono, actualizadoPor: quien(ctx), actualizadoEn: serverTimestamp() });
        notificar("Proveedor actualizado");
        cerrar();
        if (alEditar) alEditar();
        return;
      }
      const claveIni = $("#p-clave", el).value.trim();
      const v = claveIni === ruc ? "" : validarClaveNueva(claveIni);
      if (v) { $("#p-btn", el).disabled = false; return error(v); }
      const email = `${ruc}@${DOMINIO_PROVEEDORES}`;
      const uid = await crearUsuario(email, claveIni);
      await setDoc(doc(db, "usuarios", uid), {
        rol: "proveedor", ruc, razonSocial: razon, nombre: razon, email, contacto, telefono,
        activo: true, debeCambiarClave: false, creadoPor: quien(ctx), creadoEn: serverTimestamp(),
      });
      cerrar();
      if (alCrear) alCrear();
      modalCredenciales("Proveedor creado", ruc, claveIni, { pideCambio: false });
    } catch (err) {
      console.error("Portal: no se pudo guardar el proveedor", err);
      $("#p-btn", el).disabled = false;
      error(ERRORES_ALTA[err.code] || "No se pudo guardar. Inténtalo de nuevo.");
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   USUARIOS INTERNOS (solo administrador)
   ══════════════════════════════════════════════════════════════════ */
function vistaUsuarios(cont, ctx) {
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo">
        <div><h2>Usuarios internos</h2><p>Personal del hotel con acceso a la administración del portal.</p></div>
        <button type="button" class="btn oscuro" id="nuevo">${icono("mas")}Nuevo usuario</button>
      </div>
      <div class="tabla-caja"><table>
        <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th>Último ingreso</th><th></th></tr></thead>
        <tbody id="tb"><tr><td colspan="6" class="vacio">Cargando…</td></tr></tbody>
      </table></div>
      <div id="pag"></div>
      <div class="aviso azul" style="margin:12px 0 0">${ROLES_INTERNOS.map((r) => `<div><b>${r.etiqueta}:</b> ${r.detalle}</div>`).join("")}</div>
    </div>`;
  let lista = [];
  const ps = paginaServidor({
    clave: "adm-usuarios", etiqueta: "usuarios", barra: $("#pag", cont),
    consulta: () => ({ col: collection(db, "usuarios"), filtros: [where("rol", "in", ROLES_INTERNOS.map((r) => r.id))], orden: [orderBy("nombre")] }),
    pintar: (docs) => { lista = docs.map((d) => ({ uid: d.id, ...d.data() })); pintar(); },
    alError: (err) => { $("#tb", cont).innerHTML = `<tr><td colspan="6" class="vacio">No se pudieron leer los usuarios (${esc(err.code || err.message)}).</td></tr>`; },
  });
  function pintar() {
    $("#tb", cont).innerHTML = lista.map((u) => {
      const yo = u.uid === ctx.user.uid;
      return `<tr>
        <td>${esc(u.nombre)}${yo ? ` <span class="etiqueta-estado neutro">Tú</span>` : ""}</td><td>${esc(u.email)}</td>
        <td><select class="select chico" data-rol="${u.uid}" ${yo ? "disabled title='No puedes cambiar tu propio rol'" : ""}>
          ${ROLES_INTERNOS.map((r) => `<option value="${r.id}" ${r.id === u.rol ? "selected" : ""}>${r.etiqueta}</option>`).join("")}</select></td>
        <td>${estadoUsuario(u)}</td><td style="font-size:11px">${fechaHora(u.ultimoIngreso)}</td>
        <td>${yo ? "" : `<div class="acciones"><button type="button" class="btn chico" data-acc="clave" data-uid="${u.uid}">${icono("llave")}Clave</button>
          <button type="button" class="btn chico ${u.activo ? "rojo" : "verde"}" data-acc="activo" data-uid="${u.uid}">${u.activo ? "Desactivar" : "Activar"}</button></div>`}</td>
      </tr>`; }).join("") || `<tr><td colspan="6" class="vacio">Sin usuarios.</td></tr>`;
  }

  $("#tb", cont).addEventListener("change", (e) => {
    const s = e.target.closest("[data-rol]");
    if (!s) return;
    updateDoc(doc(db, "usuarios", s.dataset.rol), { rol: s.value, actualizadoPor: quien(ctx), actualizadoEn: serverTimestamp() })
      .then(() => { notificar(`Rol cambiado a ${etiquetaRol(s.value)}`); ps.recargar(); }, () => notificar("No se pudo cambiar el rol", "error"));
  });
  $("#tb", cont).addEventListener("click", async (e) => {
    const b = e.target.closest("[data-acc]");
    if (!b) return;
    const u = lista.find((x) => x.uid === b.dataset.uid);
    if (b.dataset.acc === "clave") return modalRestablecer(u);
    const ok = await confirmar({ titulo: u.activo ? "Desactivar usuario" : "Activar usuario", peligroso: u.activo,
      textoOk: u.activo ? "Desactivar" : "Activar", mensaje: `${u.nombre} (${u.email}) ${u.activo ? "perderá" : "recuperará"} el acceso al portal.` });
    if (ok) updateDoc(doc(db, "usuarios", u.uid), { activo: !u.activo, actualizadoPor: quien(ctx), actualizadoEn: serverTimestamp() })
      .then(() => { notificar(u.activo ? "Usuario desactivado" : "Usuario activado"); ps.recargar(); }, () => notificar("No se pudo actualizar", "error"));
  });
  $("#nuevo", cont).addEventListener("click", () => {
    const { el, cerrar } = abrirModal(`
      <form novalidate>
        <div class="modal-cab"><h2>Nuevo usuario interno</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
        <p class="modal-sub">Se crea su cuenta con una clave inicial que deberá cambiar al primer ingreso.</p>
        <label class="campo"><span>Nombre</span><input class="input" id="u-nombre" autofocus></label>
        <label class="campo"><span>Correo</span><input class="input" id="u-email" type="email" autocomplete="off"></label>
        <label class="campo"><span>Rol</span><select class="select" id="u-rol">${ROLES_INTERNOS.map((r) => `<option value="${r.id}" ${r.id === "consulta" ? "selected" : ""}>${r.etiqueta}</option>`).join("")}</select></label>
        <label class="campo"><span>Clave inicial</span><div style="display:flex;gap:6px"><input class="input mono" id="u-clave" value="${generarClave()}" autocomplete="off">
          <button type="button" class="btn" id="u-gen" title="Generar otra">${icono("dados")}</button></div></label>
        <p class="error" id="u-error" hidden></p>
        <div class="modal-pie"><button type="button" class="btn" data-cerrar>Cancelar</button>
          <button type="submit" class="btn oscuro" id="u-btn">${icono("check")}Crear usuario</button></div>
      </form>`);
    $("#u-gen", el).addEventListener("click", () => { $("#u-clave", el).value = generarClave(); });
    $("form", el).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const error = (t) => { $("#u-error", el).textContent = t; $("#u-error", el).hidden = false; };
      const nombre = $("#u-nombre", el).value.trim(), email = $("#u-email", el).value.trim().toLowerCase();
      const rol = $("#u-rol", el).value, clave = $("#u-clave", el).value.trim();
      if (!nombre) return error("Escribe el nombre");
      if (!/^\S+@\S+\.\S+$/.test(email)) return error("Correo inválido");
      if (email.endsWith(`@${DOMINIO_PROVEEDORES}`)) return error("Ese dominio es solo para proveedores");
      const v = validarClaveNueva(clave);
      if (v) return error(v);
      $("#u-btn", el).disabled = true;
      try {
        const uid = await crearUsuario(email, clave);
        await setDoc(doc(db, "usuarios", uid), { rol, nombre, email, activo: true, debeCambiarClave: true, creadoPor: quien(ctx), creadoEn: serverTimestamp() });
        cerrar();
        ps.recargar();
        modalCredenciales("Usuario creado", email, clave);
      } catch (err) {
        console.error("Portal: no se pudo crear el usuario", err);
        $("#u-btn", el).disabled = false;
        error(ERRORES_ALTA[err.code] || "No se pudo crear el usuario");
      }
    });
  });
  ps.cargar(true);
  return () => ps.detener();
}
