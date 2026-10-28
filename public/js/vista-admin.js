/* ══════════════════════════════════════════════════════════════════
   ADMINISTRACIÓN (personal del hotel: admin / contabilidad / consulta)
   Pestañas: Pagos · Comprobantes · Cargar lote · Lotes · Proveedores · Usuarios.
   Lo que cada rol puede hacer lo decide de verdad firestore.rules; aquí
   solo se esconden los botones que no le corresponden.
   ══════════════════════════════════════════════════════════════════ */
import { db, crearUsuario, restablecerClave } from "./firebase.js";
import {
  collection, query, where, orderBy, limit, getDocs, getDoc, doc, setDoc, updateDoc,
  writeBatch, serverTimestamp, sum,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  $, esc, icono, soles, monto, monedaComun, fechaCorta, fechaHora, toISO, hoyISO,
  abrirModal, confirmar, notificar, descargarCSV, generarClave, validarClaveNueva, ERRORES_ALTA,
  paginador, archivosSoltados,
} from "./util.js";
import { ROLES_INTERNOS, etiquetaRol, puedeGestionar } from "./roles.js";
import { leerArchivo, interpretarLote, leerDescuentos, huellaArchivo, formasFactura } from "./bcp.js";
import { constancia } from "./vista-proveedor.js";
import { paginaServidor } from "./paginaServidor.js";
import { vistaComprobantes } from "./comprobantes.js";
import { DOMINIO_PROVEEDORES } from "./config.js";

export function pestanas(rol) {
  return [
    { id: "pagos", texto: "Pagos", icono: "recibo" },
    { id: "comprobantes", texto: "Comprobantes", icono: "archivo" },
    ...(puedeGestionar(rol) ? [{ id: "cargar", texto: "Cargar lotes", icono: "subir" }] : []),
    { id: "lotes", texto: "Lotes", icono: "capas" },
    { id: "proveedores", texto: "Proveedores", icono: "edificio" },
    ...(rol === "admin" ? [{ id: "usuarios", texto: "Usuarios", icono: "usuarios" }] : []),
  ];
}

export function montar(id, cont, ctx) {
  const vistas = { pagos: vistaPagos, comprobantes: vistaComprobantes, cargar: vistaCargar, lotes: vistaLotes, proveedores: vistaProveedores, usuarios: vistaUsuarios };
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
        <label class="campo"><span>Desde</span><input class="input chico" type="date" id="f-desde" value="${p.lote ? "" : p.fecha || hace90}"></label>
        <label class="campo"><span>Hasta</span><input class="input chico" type="date" id="f-hasta" value="${p.lote ? "" : p.fecha || hoyISO()}"></label>
        <label class="campo"><span>Buscar por</span><select class="select chico" id="f-tipo">
          <option value="" ${tipoIni ? "" : "selected"}>Automático</option>
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
    const texto = $("#f-buscar", cont).value.trim();
    // "Automático": se deduce de lo escrito (sin texto = todas las facturas de las fechas).
    const tipo = $("#f-tipo", cont).value || (!texto ? "" : /^\d+$/.test(texto) ? "ruc" : /^BCP_/i.test(texto) ? "lote"
      : /^[FBE][A-Z0-9]{0,3}-?\d+$/i.test(texto) ? "factura" : "razon");
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
    if (tipo === "factura") {
      // El TXT del banco guarda "F00046937"; en SAP se ve "F001-46937": se buscan las dos formas.
      const formas = formasFactura(texto);
      return { col, filtros: [where("factura", "in", formas)], orden: [orderBy("fechaPago", "desc")], desc: `Factura ${formas[0]} (todas las fechas).` };
    }
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
      // Totales con la moneda de las facturas; si hay soles y dólares juntos, sin símbolo y con aviso.
      const mon = monedaComun(docsPagina), mezcla = !mon;
      const m = (k) => (st.sumasOk ? (mon ? `${mon} ${soles(a[k])}` : soles(a[k])) : "—");
      $("#kpis", cont).innerHTML = `
        <div class="tarjeta destacada"><div class="etiqueta">Total abonado</div><div class="valor">${m("neto")}</div><div class="sub">${st.sumasOk ? "neto pagado en la consulta" : "Firebase aún prepara el índice de los totales; reintenta en unos minutos"}</div></div>
        <div class="tarjeta"><div class="etiqueta">Facturas</div><div class="valor">${(st.total || 0).toLocaleString("es-PE")}</div><div class="sub">en la consulta</div></div>
        <div class="tarjeta"><div class="etiqueta">Retenciones</div><div class="valor">${m("retencion")}</div><div class="sub">Detracciones: ${m("detraccion")}</div></div>
        <div class="tarjeta"><div class="etiqueta">Notas de crédito</div><div class="valor">${m("notaCredito")}</div><div class="sub">Bruto: ${m("bruto")}</div></div>`;
      $("#tb", cont).innerHTML = docsPagina.map((x, i) => `
        <tr class="clic" data-i="${i}">
          <td>${fechaCorta(x.fechaPago)}</td><td class="mono">${esc(x.ruc)}</td><td>${esc(x.razonSocial)}</td><td class="mono">${esc(x.factura)}</td><td>${esc(x.banco)}</td>
          <td class="num">${monto(x.bruto, x.moneda)}</td><td class="num descuento">${x.retencion ? monto(x.retencion, x.moneda) : "—"}</td>
          <td class="num descuento">${x.detraccion ? monto(x.detraccion, x.moneda) : "—"}</td><td class="num descuento">${x.notaCredito ? monto(x.notaCredito, x.moneda) : "—"}</td>
          <td class="num neto">${monto(x.neto, x.moneda)}</td><td class="mono" style="font-size:10.5px">${esc(x.lote)}</td>
        </tr>`).join("") || `<tr><td colspan="11" class="vacio">No hay pagos con estos filtros.</td></tr>`;
      $("#tf", cont).innerHTML = st.total ? `<tr><td colspan="5">Total de la consulta (${st.total.toLocaleString("es-PE")})</td><td class="num">${m("bruto")}</td>
        <td class="num">${m("retencion")}</td><td class="num">${m("detraccion")}</td>
        <td class="num">${m("notaCredito")}</td><td class="num">${m("neto")}</td><td></td></tr>${mezcla ? `<tr><td colspan="11" class="ayuda">Hay pagos en soles y en dólares en esta página: los totales suman ambas monedas.</td></tr>` : ""}` : "";
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
   (formato real del banco: ver public/js/bcp.js)
   ══════════════════════════════════════════════════════════════════ */
function vistaCargar(cont, ctx) {
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo"><div><h2>Cargar lotes de pagos</h2>
        <p>Sube <b>la carpeta completa</b> o varios TXT de Pago a Proveedores de Telecrédito BCP (y, si los tienes, los CSV de descuentos de SAP B1).
        <b>Se guarda solo</b>: los archivos nuevos o que cambiaron se cargan apenas los eliges; los ya cargados se reconocen —aunque cambies su nombre— y se omiten.</p></div></div>
      <div class="zona-archivo" id="zona">
        ${icono("subir")}<b>Arrastra aquí la carpeta o los archivos</b>
        <small>TXT del banco (obligatorio) · CSV de descuentos de SAP: factura;ruc;bruto;retencion;detraccion;notaCredito (opcional)</small>
        <span class="acciones" style="margin-top:6px">
          <button type="button" class="btn chico oscuro" id="btn-carpeta">${icono("capas")}Elegir carpeta</button>
          <button type="button" class="btn chico" id="btn-archivos">${icono("archivo")}Elegir archivos</button>
        </span>
        <span class="nombre-archivo" id="resumen-archivos"></span>
        <input type="file" id="in-carpeta" webkitdirectory directory multiple class="sr-only">
        <input type="file" id="in-archivos" accept=".txt,.csv,text/plain,text/csv" multiple class="sr-only">
      </div>
    </div>
    <div id="vista-previa"></div>`;

  let txts = [], csvs = [];
  const zonaEl = $("#zona", cont);
  $("#btn-carpeta", cont).addEventListener("click", () => $("#in-carpeta", cont).click());
  $("#btn-archivos", cont).addEventListener("click", () => $("#in-archivos", cont).click());
  $("#in-carpeta", cont).addEventListener("change", (e) => recibir([...e.target.files]));
  $("#in-archivos", cont).addEventListener("change", (e) => recibir([...e.target.files]));
  zonaEl.addEventListener("dragover", (e) => { e.preventDefault(); zonaEl.classList.add("sobre"); });
  zonaEl.addEventListener("dragleave", () => zonaEl.classList.remove("sobre"));
  zonaEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    zonaEl.classList.remove("sobre");
    recibir(await archivosSoltados(e.dataTransfer));
  });

  function recibir(lista) {
    // Sin la extensión, así "PROV_20261020" va antes que "PROV_20261020_copia" (si son iguales, se queda el original).
    const base = (f) => f.name.replace(/\.txt$/i, "");
    txts = lista.filter((f) => /\.txt$/i.test(f.name)).sort((a, b) => base(a).localeCompare(base(b), "es", { numeric: true }));
    csvs = lista.filter((f) => /\.csv$/i.test(f.name));
    const otros = lista.length - txts.length - csvs.length;
    $("#resumen-archivos", cont).textContent = txts.length
      ? `${txts.length} TXT${csvs.length ? ` · ${csvs.length} CSV de descuentos` : ""}${otros ? ` · ${otros} archivo(s) que no son TXT ni CSV se ignoran` : ""}`
      : lista.length ? "No hay archivos .txt en lo que elegiste." : "";
    $("#vista-previa", cont).innerHTML = "";
    if (txts.length) analizar();
  }

  /* Analiza cada TXT y decide su estado contra lo ya cargado:
     nuevo · ya cargado igual (se omite) · ya cargado con cambios (se actualiza) · repetido en la selección. */
  async function analizar() {
    const caja = $("#vista-previa", cont);
    caja.innerHTML = `<div class="panel"><p class="ayuda" style="margin:0">Revisando ${txts.length} archivo(s)…</p></div>`;
    try {
      const desc = {};
      for (const f of csvs) Object.assign(desc, leerDescuentos(await leerArchivo(f)));
      const lotes = [];
      const vistos = new Map(); // huella → nombre del primer archivo con ese contenido
      for (const f of txts) {
        const [texto, huella] = await Promise.all([leerArchivo(f), huellaArchivo(f)]);
        const r = interpretarLote(texto, f.name, desc);
        const item = { file: f, r, huella, estado: "nuevo", detalle: "", incluir: true };
        if (vistos.has(huella)) { item.estado = "repetido"; item.detalle = `mismo contenido que ${vistos.get(huella)}`; item.incluir = false; }
        else if (lotes.some((x) => x.r.lote === r.lote)) { item.estado = "repetido"; item.detalle = "otro archivo con el mismo nombre y fecha"; item.incluir = false; }
        vistos.set(huella, f.name);
        lotes.push(item);
      }
      // Contra lo ya cargado: por la huella (aunque el archivo tenga otro nombre) y por el id del lote.
      await Promise.all(lotes.filter((x) => x.estado === "nuevo").map(async (x) => {
        const [porHuella, porId] = await Promise.all([
          getDocs(query(collection(db, "lotes"), where("hashTxt", "==", x.huella), limit(1))),
          getDoc(doc(db, "lotes", x.r.lote)),
        ]);
        if (!porHuella.empty) {
          x.estado = "igual"; x.incluir = false;
          x.detalle = porHuella.docs[0].id === x.r.lote ? "" : `cargado antes como ${porHuella.docs[0].id}`;
        } else if (porId.exists()) {
          const d = porId.data();
          const mismo = !d.hashTxt && d.facturas === x.r.pagos.length && Math.abs((d.total || 0) - x.r.total) < 0.005;
          x.estado = mismo ? "igual" : "cambio"; x.incluir = !mismo;
        }
      }));
      // Un TXT sin facturas, sin fecha de abono o cuyo encabezado no cuadra con el detalle (total o cantidad)
      // no se guarda solo: queda para revisar (y cargarlo a mano si se quiere).
      for (const x of lotes) {
        if ((x.estado === "nuevo" || x.estado === "cambio") && !x.r.integro) {
          x.estado = "revisar"; x.incluir = false;
          x.detalle = !x.r.pagos.length ? "no tiene facturas (¿es el TXT de Pago a Proveedores?)"
            : !x.r.f ? "sin fecha de abono en el encabezado" : x.r.avisos[0];
        }
      }
      const rucs = [...new Set(lotes.filter((x) => x.estado !== "repetido").flatMap((x) => x.r.pagos.map((p) => p.ruc)))];
      const cuentas = await rucsConCuenta(rucs).catch(() => new Set());
      vistaLotesPrevia(lotes, cuentas, csvs.length > 0);
    } catch (err) {
      console.error("Portal: no se pudieron revisar los archivos", err);
      caja.innerHTML = `<div class="aviso rojo">No se pudieron leer los archivos: ${esc(err.message)}</div>`;
    }
  }

  const ETIQUETA = {
    nuevo: `<span class="etiqueta-estado activo">Nuevo</span>`,
    cambio: `<span class="etiqueta-estado pendiente">Ya cargado · cambió</span>`,
    igual: `<span class="etiqueta-estado neutro">Ya cargado · se omite</span>`,
    repetido: `<span class="etiqueta-estado inactivo">Repetido · se omite</span>`,
    revisar: `<span class="etiqueta-estado inactivo">Revisar · no se guardó</span>`,
    guardando: `<span class="etiqueta-estado pendiente">Guardando…</span>`,
    guardado: `<span class="etiqueta-estado activo">✓ Guardado</span>`,
    error: `<span class="etiqueta-estado inactivo">Error · reintentar</span>`,
  };

  function vistaLotesPrevia(lotes, cuentas, hayCsv) {
    const caja = $("#vista-previa", cont);
    caja.innerHTML = `
      <div class="tarjetas" id="kpis-carga"></div>
      <div id="estado-carga"></div>
      ${hayCsv ? "" : `<div class="aviso azul">No subiste CSV de descuentos: cada factura se guarda con el importe abonado como bruto (sin retención ni detracción).</div>`}
      <div class="panel">
        <div class="panel-titulo"><div><h2>Archivos</h2><p>Toca un archivo para ver sus facturas. Los marcados "Revisar" puedes cargarlos a mano.</p></div>
          <div class="acciones"><button type="button" class="btn oscuro" id="confirmar" hidden>${icono("check")}Cargar marcados</button>
            <button type="button" class="btn chico" id="ver-lotes">${icono("capas")}Ver lotes</button></div></div>
        <div class="tabla-caja"><table>
          <thead><tr><th></th><th>Archivo</th><th>Fecha de abono</th><th class="num">Facturas</th>
            <th class="num">Proveedores</th><th class="num">Total</th><th>Avisos</th><th>Estado</th></tr></thead>
          <tbody id="tb-lotes"></tbody>
        </table></div>
        <div id="pag-lotes"></div>
      </div>`;
    const pag = paginador("adm-carga", pintar, { etiqueta: "archivos" });
    pag.enganchar($("#pag-lotes", caja));
    let trabajando = false;
    function resumen() {
      const hechos = lotes.filter((x) => x.estado === "guardado");
      const facturas = hechos.reduce((s, x) => s + x.r.pagos.length, 0);
      const total = hechos.reduce((s, x) => s + x.r.total, 0);
      const sinCuenta = new Set(hechos.flatMap((x) => x.r.pagos.map((p) => p.ruc)).filter((r) => !cuentas.has(r))).size;
      const cuantos = (...e) => lotes.filter((x) => e.includes(x.estado)).length;
      $("#kpis-carga", caja).innerHTML = `
        <div class="tarjeta destacada"><div class="etiqueta">Guardado ahora</div><div class="valor">${(() => { const mo = monedaComun(hechos.map((x) => ({ moneda: x.r.moneda }))); return mo ? `${mo} ${soles(total)}` : soles(total); })()}</div><div class="sub">${hechos.length} archivo(s) · ${facturas.toLocaleString("es-PE")} facturas</div></div>
        <div class="tarjeta"><div class="etiqueta">Por guardar</div><div class="valor">${cuantos("nuevo", "cambio", "guardando", "error")}</div><div class="sub">nuevos o con cambios</div></div>
        <div class="tarjeta"><div class="etiqueta">Se omiten</div><div class="valor">${cuantos("igual", "repetido")}</div><div class="sub">ya cargados o repetidos: no se duplican</div></div>
        <div class="tarjeta"><div class="etiqueta">Sin cuenta en el portal</div><div class="valor">${sinCuenta}</div><div class="sub">proveedores de lo guardado</div></div>`;
      const manual = lotes.filter((x) => x.incluir && (x.estado === "revisar" || x.estado === "error"));
      $("#confirmar", caja).hidden = !manual.length || trabajando;
      $("#confirmar", caja).innerHTML = `${icono("check")}Cargar ${manual.length} marcado${manual.length === 1 ? "" : "s"}`;
    }
    function pintar() {
      const { visibles, inicio, html } = pag.cortar(lotes);
      $("#pag-lotes", caja).innerHTML = html;
      $("#tb-lotes", caja).innerHTML = visibles.map((x, i) => {
        const k = inicio + i, puede = !trabajando && (x.estado === "revisar" || x.estado === "error");
        return `<tr class="clic" data-k="${k}">
          <td><input type="checkbox" data-incluir="${k}" ${x.incluir ? "checked" : ""} ${puede ? "" : "disabled"}></td>
          <td style="font-size:11.5px"><b>${esc(x.file.name)}</b><br><span class="mono" style="color:var(--gris);font-size:10px">${esc(x.r.lote)}</span></td>
          <td>${fechaCorta(x.r.fechaPago)}</td><td class="num">${x.r.pagos.length}</td><td class="num">${x.r.proveedores}</td>
          <td class="num neto">${monto(x.r.total, x.r.moneda)}</td>
          <td>${x.r.avisos.length ? `<span class="etiqueta-estado pendiente" title="${esc(x.r.avisos.slice(0, 5).join(" · "))}">${x.r.avisos.length}</span>` : "—"}</td>
          <td>${ETIQUETA[x.estado]}${x.detalle ? `<br><small style="color:var(--gris)">${esc(x.detalle)}</small>` : ""}</td>
        </tr>`;
      }).join("");
      resumen();
    }
    pintar();
    $("#tb-lotes", caja).addEventListener("change", (e) => {
      const c = e.target.closest("[data-incluir]");
      if (c) { lotes[Number(c.dataset.incluir)].incluir = c.checked; resumen(); }
    });
    $("#tb-lotes", caja).addEventListener("click", (e) => {
      if (e.target.closest("input")) return;
      const tr = e.target.closest("tr[data-k]");
      if (tr) detalleLote(lotes[Number(tr.dataset.k)], cuentas);
    });

    /** Guarda uno por uno los marcados (sin preguntar) y muestra el avance; si uno falla, para y deja reintentar. */
    async function guardar(lista) {
      if (!lista.length) {
        $("#estado-carga", caja).innerHTML = `<div class="aviso azul">No hay archivos nuevos: todo lo de esta carpeta ya estaba cargado.</div>`;
        return;
      }
      trabajando = true;
      let hechos = 0;
      try {
        for (const x of lista) {
          $("#estado-carga", caja).innerHTML = `<div class="aviso amarillo"><b>Guardando automáticamente…</b> archivo ${hechos + 1} de ${lista.length}: ${esc(x.file.name)}. No cierres esta página.</div>`;
          x.estado = "guardando"; pintar();
          await guardarLote(x, ctx);
          x.estado = "guardado"; x.incluir = false; x.detalle = "";
          hechos++;
          pintar();
        }
        const fact = lista.reduce((s, x) => s + x.r.pagos.length, 0);
        $("#estado-carga", caja).innerHTML = `<div class="aviso azul" style="border-color:#A9D3C4;background:#E1F2EB;color:var(--verde)"><b>✓ Listo:</b> se guardaron ${hechos} archivo(s) con ${fact.toLocaleString("es-PE")} facturas. Los proveedores ya las ven.</div>`;
        notificar(`${hechos} archivo(s) guardados`);
      } catch (err) {
        console.error("Portal: falló la carga", err);
        const x = lista[hechos];
        if (x) { x.estado = "error"; x.incluir = true; x.detalle = err.code || err.message; }
        lista.slice(hechos + 1).forEach((y) => { y.estado = "error"; y.incluir = true; y.detalle = "no se llegó a guardar"; });
        $("#estado-carga", caja).innerHTML = `<div class="aviso rojo">Se guardaron ${hechos} de ${lista.length}. Falló ${esc(x?.file.name || "")}: toca "Cargar marcados" para reintentar (no se duplica).</div>`;
      } finally {
        trabajando = false;
        pintar();
      }
    }
    $("#confirmar", caja).addEventListener("click", () => guardar(lotes.filter((x) => x.incluir && (x.estado === "revisar" || x.estado === "error"))));
    $("#ver-lotes", caja).addEventListener("click", () => ctx.irA("lotes"));
    guardar(lotes.filter((x) => x.incluir && (x.estado === "nuevo" || x.estado === "cambio")));
  }

  /** Detalle de las facturas de un archivo (paginado), con "Crear cuenta" para quien no tiene. */
  function detalleLote(x, cuentas) {
    const { el } = abrirModal(`
      <div class="modal-cab"><h2>${esc(x.file.name)}</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
      <p class="modal-sub">Lote ${esc(x.r.lote)} · abonado el ${fechaCorta(x.r.fechaPago)} · ${x.r.pagos.length} facturas · ${monto(x.r.total, x.r.moneda)}</p>
      ${x.r.avisos.length ? `<div class="aviso amarillo"><b>Avisos (${x.r.avisos.length}):</b><ul>${x.r.avisos.slice(0, 10).map((a) => `<li>${esc(a)}</li>`).join("")}${x.r.avisos.length > 10 ? `<li>…y ${x.r.avisos.length - 10} más</li>` : ""}</ul></div>` : ""}
      <div class="tabla-caja"><table>
        <thead><tr><th>RUC</th><th>Razón social</th><th>Factura</th><th class="num">Bruto</th><th class="num">Ret.</th><th class="num">Detr.</th><th class="num">N.C.</th><th class="num">Neto</th><th>Portal</th></tr></thead>
        <tbody id="tb-det"></tbody>
      </table></div>
      <div id="pag-det"></div>
      <div class="modal-pie"><button type="button" class="btn oscuro" data-cerrar>Cerrar</button></div>`, { ancho: true });
    el.querySelector(".modal").style.maxWidth = "980px";
    const pag = paginador("adm-carga-detalle", pintar, { etiqueta: "facturas" });
    pag.enganchar($("#pag-det", el));
    function pintar() {
      const { visibles, html } = pag.cortar(x.r.pagos);
      $("#pag-det", el).innerHTML = html;
      $("#tb-det", el).innerHTML = visibles.map((p) => `<tr>
        <td class="mono">${esc(p.ruc)}</td><td>${esc(p.razonSocial)}</td><td class="mono">${esc(p.factura)}</td>
        <td class="num">${monto(p.bruto, p.moneda)}</td><td class="num">${monto(p.retencion, p.moneda)}</td><td class="num">${monto(p.detraccion, p.moneda)}</td>
        <td class="num">${monto(p.notaCredito, p.moneda)}</td><td class="num neto">${monto(p.neto, p.moneda)}</td>
        <td>${cuentas.has(p.ruc) ? `<span class="etiqueta-estado activo">Con cuenta</span>`
          : `<button type="button" class="btn chico" data-crear="${esc(p.ruc)}" data-razon="${esc(p.razonSocial)}">${icono("mas")}Crear cuenta</button>`}</td>
      </tr>`).join("") || `<tr><td colspan="9" class="vacio">El archivo no tiene pagos.</td></tr>`;
    }
    pintar();
    $("#tb-det", el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-crear]");
      if (b) modalProveedor(ctx, { ruc: b.dataset.crear, razonSocial: b.dataset.razon }, () => { cuentas.add(b.dataset.crear); pintar(); });
    });
  }
}

/** Guarda un lote: pagos en tandas de 450 (id = RUC_FACTURA_FECHA, así nunca se duplican) y su registro con la huella. */
async function guardarLote(x, ctx) {
  const { r, file, huella } = x;
  for (let i = 0; i < r.pagos.length; i += 450) {
    const batch = writeBatch(db);
    for (const { id, ...datos } of r.pagos.slice(i, i + 450)) {
      // Quién cargó queda solo en "lotes": el proveedor lee su pago completo (F12) y no necesita nombres internos.
      batch.set(doc(db, "pagos", id), { ...datos, cargadoEn: serverTimestamp() }, { merge: true });
    }
    await batch.commit();
  }
  await setDoc(doc(db, "lotes", r.lote), {
    lote: r.lote, banco: "BCP", fechaPago: r.fechaPago, facturas: r.pagos.length, proveedores: r.proveedores, total: r.total,
    resumenProveedores: resumirPorProveedor(r.pagos), moneda: r.moneda,
    archivoTxt: file.webkitRelativePath || file.name, hashTxt: huella, cargadoPor: quien(ctx), cargadoEn: serverTimestamp(),
  });
}

/** Proveedores de una lista de pagos: RUC, razón social, n.º de facturas y total (mayor primero). */
function resumirPorProveedor(pagos) {
  const m = new Map();
  for (const p of pagos) {
    const x = m.get(p.ruc) || { ruc: p.ruc, razonSocial: p.razonSocial, facturas: 0, total: 0 };
    x.facturas++; x.total = Math.round((x.total + (Number(p.neto) || 0)) * 100) / 100;
    m.set(p.ruc, x);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** Ventana con los proveedores que vinieron en un lote (paginada), con "Ver pagos" de cada uno. */
async function proveedoresDelLote(id, ctx) {
  const { el, cerrar } = abrirModal(`
    <div class="modal-cab"><h2>Proveedores del lote</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
    <p class="modal-sub mono">${esc(id)}</p>
    <div id="lp-cuerpo"><p class="ayuda">Cargando…</p></div>
    <div class="modal-pie"><button type="button" class="btn oscuro" data-cerrar>Cerrar</button></div>`, { ancho: true });
  el.querySelector(".modal").style.maxWidth = "860px";
  try {
    const lote = (await getDoc(doc(db, "lotes", id))).data() || {};
    let lista = lote.resumenProveedores;
    // Lotes cargados antes de guardar el resumen: se arma con sus pagos (una sola vez).
    if (!Array.isArray(lista)) {
      const snap = await getDocs(query(collection(db, "pagos"), where("lote", "==", id)));
      lista = resumirPorProveedor(snap.docs.map((d) => d.data()));
    }
    const cuentas = await rucsConCuenta(lista.map((x) => x.ruc)).catch(() => new Set());
    const cuerpo = $("#lp-cuerpo", el);
    cuerpo.innerHTML = `
      <p class="ayuda" style="margin:0 0 10px">Abonado el <b>${fechaCorta(lote.fechaPago)}</b> · ${lista.length} proveedor(es) · ${(lote.facturas ?? lista.reduce((s, x) => s + x.facturas, 0)).toLocaleString("es-PE")} facturas · <b>${monto(lote.total ?? lista.reduce((s, x) => s + x.total, 0), lote.moneda)}</b></p>
      <div class="tabla-caja"><table>
        <thead><tr><th>RUC</th><th>Razón social</th><th class="num">Facturas</th><th class="num">Total abonado</th><th>Portal</th><th></th></tr></thead>
        <tbody id="lp-tb"></tbody>
      </table></div>
      <div id="lp-pag"></div>`;
    const pag = paginador("adm-lote-proveedores", pintar, { etiqueta: "proveedores" });
    pag.enganchar($("#lp-pag", el));
    function pintar() {
      const { visibles, html } = pag.cortar(lista);
      $("#lp-pag", el).innerHTML = html;
      $("#lp-tb", el).innerHTML = visibles.map((x) => `<tr>
        <td class="mono">${esc(x.ruc)}</td><td>${esc(x.razonSocial)}</td><td class="num">${x.facturas}</td><td class="num neto">${monto(x.total, lote.moneda)}</td>
        <td>${cuentas.has(x.ruc) ? `<span class="etiqueta-estado activo">Con cuenta</span>` : `<span class="etiqueta-estado inactivo">Sin cuenta</span>`}</td>
        <td><button type="button" class="btn chico" data-ruc="${esc(x.ruc)}">${icono("recibo")}Ver pagos</button></td>
      </tr>`).join("") || `<tr><td colspan="6" class="vacio">El lote no tiene pagos.</td></tr>`;
    }
    pintar();
    $("#lp-tb", el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-ruc]");
      if (b) { cerrar(); ctx.irA("pagos", { ruc: b.dataset.ruc, fecha: lote.fechaPago }); }
    });
  } catch (err) {
    console.error("Portal: no se pudieron leer los proveedores del lote", err);
    $("#lp-cuerpo", el).innerHTML = `<div class="aviso rojo">No se pudieron leer los proveedores del lote (${esc(err.code || err.message)}).</div>`;
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
/* ══════════════════════════════════════════════════════════════════
   LOTES — historial de cargas
   ══════════════════════════════════════════════════════════════════ */
function vistaLotes(cont, ctx) {
  const gestiona = puedeGestionar(ctx.perfil.rol);
  cont.innerHTML = `
    <div class="panel">
      <div class="panel-titulo"><div><h2>Lotes cargados</h2><p>Del más reciente al más antiguo. "Proveedores" muestra quiénes vinieron en cada carga; "Ver pagos", sus facturas.</p></div></div>
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
      <td class="num">${l.facturas ?? "—"}</td><td class="num">${l.proveedores ?? "—"}</td><td class="num neto">${monto(l.total, l.moneda)}</td>
      <td style="font-size:11px">${esc(l.archivoTxt || "")}${l.archivoCsv ? `<br>${esc(l.archivoCsv)}` : ""}</td>
      <td style="font-size:11px">${esc(l.cargadoPor || "")}<br><span style="color:var(--gris)">${fechaHora(l.cargadoEn)}</span></td>
      <td><div class="acciones"><button type="button" class="btn chico oscuro" data-prov="${esc(d.id)}">${icono("edificio")}Proveedores</button>
        <button type="button" class="btn chico" data-ver="${esc(d.id)}">${icono("recibo")}Ver pagos</button>
        ${gestiona ? `<button type="button" class="btn chico rojo" data-borrar="${esc(d.id)}" data-n="${l.facturas || 0}">${icono("basura")}Eliminar</button>` : ""}</div></td>
    </tr>`; }).join("") || `<tr><td colspan="9" class="vacio">Aún no se ha cargado ningún lote.</td></tr>`;
  }

  $("#tb", cont).addEventListener("click", async (e) => {
    const ver = e.target.closest("[data-ver]"), borrar = e.target.closest("[data-borrar]"), prov = e.target.closest("[data-prov]");
    if (ver) ctx.irA("pagos", { lote: ver.dataset.ver });
    if (prov) proveedoresDelLote(prov.dataset.prov, ctx);
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
