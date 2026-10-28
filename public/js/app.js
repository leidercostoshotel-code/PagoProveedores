/* ══════════════════════════════════════════════════════════════════
   PORTAL DE PROVEEDORES — arranque y control de pantallas
   Flujo (igual que la suite A-B-Swiss): carga → ingreso → perfil en
   "usuarios" → (cambio de clave obligatorio) → app según el rol.
   ══════════════════════════════════════════════════════════════════ */
import { db, login, logout, onUser, cambiarPassword } from "./firebase.js";
import { doc, onSnapshot, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  $, $$, esc, icono, notificar, abrirModal, campoClave, activarOjos,
  mensajeErrorLogin, validarClaveNueva, ERRORES_CLAVE,
} from "./util.js";
import { etiquetaRol, esInterno } from "./roles.js";
import { MINUTOS_INACTIVIDAD, SEGUNDOS_AVISO_CIERRE, HORAS_SESION_MAXIMA, CORREO_CONTABILIDAD } from "./config.js";
import * as vistaProveedor from "./vista-proveedor.js";
import * as vistaAdmin from "./vista-admin.js";
import { montarPlantillas, CREDITO, LOGO, ALT_LOGO } from "./plantillas.js";

montarPlantillas();

// Íconos de las partes estáticas del HTML.
$$("[data-icono]").forEach((el) => { el.innerHTML = icono(el.dataset.icono); });
$("[data-icono-sello]").insertAdjacentHTML("afterbegin", icono("escudo"));
$("#btn-clave").innerHTML = `${icono("llave")}Clave`;
$("#btn-salir").innerHTML = `${icono("power")}Salir`;
activarOjos($("#form-ingreso"));

const PANTALLAS = ["pantalla-carga", "pantalla-ingreso", "pantalla-aviso", "app"];
function mostrar(id) {
  PANTALLAS.forEach((p) => { document.getElementById(p).hidden = p !== id; });
}
function pantallaCarga(texto = "Cargando") {
  $("#texto-carga").textContent = texto;
  mostrar("pantalla-carga");
}

/* ── Estado de la sesión ─────────────────────────────────────────── */
let user = null;
let perfil = undefined;
let soltarPerfil = null;
let ingresoMarcado = false;
let vistaActual = null;      // { modulo, id }
let limpiarVista = null;
let motivoSalida = "";       // texto a mostrar en el ingreso (p. ej. "por inactividad")

onUser((u) => {
  user = u;
  if (soltarPerfil) { soltarPerfil(); soltarPerfil = null; }
  perfil = undefined;
  ingresoMarcado = false;
  desmontarVista();
  if (!u) {
    detenerInactividad();
    try { Object.keys(sessionStorage).filter((k) => k.startsWith("sesion:inicio:")).forEach((k) => sessionStorage.removeItem(k)); } catch { /* nada */ }
    inicioSesion = 0;
    pantallaIngreso();
    return;
  }
  pantallaCarga("Verificando tu acceso");
  soltarPerfil = onSnapshot(doc(db, "usuarios", u.uid), (snap) => {
    perfil = snap.exists() ? snap.data() : null;
    decidir();
  }, (err) => {
    console.error("Portal: no se pudo leer el perfil", err);
    perfil = null;
    decidir();
  });
});

/** Elige qué pantalla mostrar según el perfil (se re-evalúa en vivo). */
function decidir() {
  if (!user) return;
  if (!perfil || !perfil.activo || !perfil.rol) { desmontarVista(); pantallaSinAcceso(); return; }
  // Cambio de clave obligatorio solo para el personal del hotel (los proveedores no, pedido del dueño).
  if (perfil.debeCambiarClave && perfil.rol !== "proveedor") { desmontarVista(); pantallaCambioObligatorio(); return; }
  if (!ingresoMarcado) {
    ingresoMarcado = true;
    updateDoc(doc(db, "usuarios", user.uid), { ultimoIngreso: serverTimestamp() }).catch(() => {});
  }
  iniciarInactividad();
  montarApp();
}

/* ══════════════════════════════════════════════════════════════════
   INGRESO
   ══════════════════════════════════════════════════════════════════ */
function pantallaIngreso() {
  const err = $("#ingreso-error");
  err.hidden = !motivoSalida;
  err.textContent = motivoSalida;
  err.classList.toggle("ok", false);
  motivoSalida = "";
  $("#ingreso-clave").value = "";
  $("#ingreso-btn").disabled = false;
  $("#ingreso-btn").textContent = "Entrar";
  mostrar("pantalla-ingreso");
  setTimeout(() => $("#ingreso-usuario").focus(), 30);
}

$("#form-ingreso").addEventListener("submit", async (e) => {
  e.preventDefault();
  const usuario = $("#ingreso-usuario").value.trim();
  const clave = $("#ingreso-clave").value;
  const err = $("#ingreso-error");
  if (!usuario || !clave) { err.textContent = "Completa RUC/correo y contraseña"; err.hidden = false; return; }
  if (/^\d+$/.test(usuario) && usuario.length !== 11) { err.textContent = "El RUC debe tener 11 dígitos"; err.hidden = false; return; }
  err.hidden = true;
  const btn = $("#ingreso-btn");
  btn.disabled = true;
  btn.textContent = "Entrando…";
  try {
    await login(usuario, clave);
  } catch (ex) {
    btn.disabled = false;
    btn.textContent = "Entrar";
    err.textContent = mensajeErrorLogin(ex);
    err.hidden = false;
  }
});

/* ══════════════════════════════════════════════════════════════════
   SIN ACCESO / CAMBIO DE CLAVE OBLIGATORIO
   ══════════════════════════════════════════════════════════════════ */
function pantallaSinAcceso() {
  detenerInactividad();
  const desactivado = perfil && perfil.activo === false;
  const el = $("#pantalla-aviso");
  el.className = "pantalla-aviso";
  el.innerHTML = `
    <div class="caja">
      ${icono("alerta", "grande")}
      <h1>${desactivado ? "Tu acceso está desactivado" : "Sin acceso al portal"}</h1>
      <p>${desactivado
        ? "Tu cuenta fue desactivada. Si crees que es un error, comunícate con Contabilidad."
        : "Tu cuenta no tiene un perfil asignado en el portal. Pide al administrador que te habilite."}</p>
      <p>Consultas: <a href="mailto:${esc(CORREO_CONTABILIDAD)}">${esc(CORREO_CONTABILIDAD)}</a></p>
      <div style="margin-top:16px"><button type="button" class="btn" id="aviso-salir">${icono("power")}Salir</button></div>
    </div>
    <p class="credito oscuro">${CREDITO}</p>`;
  $("#aviso-salir").addEventListener("click", () => logout());
  mostrar("pantalla-aviso");
}

/** Primer ingreso (o clave restablecida): no deja entrar hasta cambiarla. */
function pantallaCambioObligatorio() {
  detenerInactividad();
  const el = $("#pantalla-aviso");
  el.className = "pantalla-fondo";
  el.innerHTML = `
    <form class="tarjeta-ingreso" id="form-obligatorio" novalidate>
      <div class="marca-ingreso">
        <img class="logo30" src="${LOGO}" alt="${ALT_LOGO}">
        <div class="icono-sistema">${icono("llave")}</div>
        <div>
          <div class="sobretitulo">Swissôtel Lima</div>
          <div class="titulo-sistema">Crea tu contraseña personal</div>
        </div>
      </div>
      <p class="modal-sub">Por seguridad, cambia la clave inicial que te entregaron. Usa al menos 8 caracteres, con letras y números.</p>
      ${campoClave({ id: "ob-actual", etiqueta: "Clave inicial (actual)", autofocus: true })}
      ${campoClave({ id: "ob-nueva", etiqueta: "Contraseña nueva", autocomplete: "new-password" })}
      ${campoClave({ id: "ob-confirmar", etiqueta: "Repite la contraseña nueva", autocomplete: "new-password" })}
      <p class="error" id="ob-error" hidden></p>
      <button class="btn oscuro bloque" type="submit" id="ob-btn">Guardar y entrar</button>
      <div style="text-align:center;margin-top:10px"><button type="button" class="btn chico" id="ob-salir">${icono("power")}Salir</button></div>
    </form>
    <p class="credito">${CREDITO}</p>`;
  activarOjos(el);
  $("#ob-salir").addEventListener("click", () => logout());
  $("#form-obligatorio").addEventListener("submit", async (e) => {
    e.preventDefault();
    const actual = $("#ob-actual").value, nueva = $("#ob-nueva").value, conf = $("#ob-confirmar").value;
    const error = (t) => { $("#ob-error").textContent = t; $("#ob-error").hidden = false; };
    if (!actual) return error("Escribe la clave inicial");
    const v = validarClaveNueva(nueva);
    if (v) return error(v);
    if (nueva !== conf) return error("Las dos contraseñas nuevas no coinciden");
    if (nueva === actual) return error("La contraseña nueva debe ser distinta a la inicial");
    $("#ob-error").hidden = true;
    $("#ob-btn").disabled = true;
    $("#ob-btn").textContent = "Guardando…";
    try {
      await cambiarPassword(actual, nueva);
      await updateDoc(doc(db, "usuarios", user.uid), { debeCambiarClave: false, claveCambiadaEn: serverTimestamp() });
      notificar("Contraseña creada. ¡Bienvenido!");
    } catch (ex) {
      $("#ob-btn").disabled = false;
      $("#ob-btn").textContent = "Guardar y entrar";
      error(ERRORES_CLAVE[ex.code] || "No se pudo cambiar la contraseña");
    }
  });
  mostrar("pantalla-aviso");
}

/** Modal para que cualquier cuenta cambie su propia contraseña. */
function modalClave() {
  const { el, cerrar } = abrirModal(`
    <form id="form-clave" novalidate>
      <div class="modal-cab"><h2>Cambiar contraseña</h2><button type="button" class="cerrar" data-cerrar aria-label="Cerrar">${icono("x")}</button></div>
      <p class="modal-sub">${esc(user.email)}</p>
      ${campoClave({ id: "cl-actual", etiqueta: "Contraseña actual", autofocus: true })}
      ${campoClave({ id: "cl-nueva", etiqueta: "Contraseña nueva", autocomplete: "new-password" })}
      ${campoClave({ id: "cl-confirmar", etiqueta: "Repite la contraseña nueva", autocomplete: "new-password" })}
      <p class="error" id="cl-error" hidden></p>
      <div class="modal-pie">
        <button type="button" class="btn" data-cerrar>Cancelar</button>
        <button type="submit" class="btn oscuro" id="cl-btn">${icono("check")}Guardar</button>
      </div>
    </form>`);
  activarOjos(el);
  $("#form-clave", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const actual = $("#cl-actual", el).value, nueva = $("#cl-nueva", el).value, conf = $("#cl-confirmar", el).value;
    const error = (t) => { $("#cl-error", el).textContent = t; $("#cl-error", el).hidden = false; };
    if (!actual) return error("Escribe tu contraseña actual");
    const v = validarClaveNueva(nueva);
    if (v) return error(v);
    if (nueva !== conf) return error("Las dos contraseñas nuevas no coinciden");
    if (nueva === actual) return error("La contraseña nueva debe ser distinta a la actual");
    $("#cl-btn", el).disabled = true;
    try {
      await cambiarPassword(actual, nueva);
      updateDoc(doc(db, "usuarios", user.uid), { claveCambiadaEn: serverTimestamp() }).catch(() => {});
      notificar("Contraseña actualizada");
      cerrar();
    } catch (ex) {
      $("#cl-btn", el).disabled = false;
      error(ERRORES_CLAVE[ex.code] || "No se pudo cambiar la contraseña");
    }
  });
}
$("#btn-clave").addEventListener("click", () => modalClave());
$("#btn-salir").addEventListener("click", () => logout());

/* ══════════════════════════════════════════════════════════════════
   APLICACIÓN
   ══════════════════════════════════════════════════════════════════ */
function montarApp() {
  const modulo = esInterno(perfil.rol) ? vistaAdmin : vistaProveedor;
  const nombre = perfil.rol === "proveedor"
    ? `${perfil.razonSocial || perfil.nombre || ""} · RUC ${perfil.ruc}`
    : `${perfil.nombre || user.email} · ${etiquetaRol(perfil.rol)}`;
  $("#chip-usuario").textContent = nombre;
  $("#chip-usuario").title = user.email;
  $("#nombre-vista").textContent = esInterno(perfil.rol) ? "Portal de Proveedores · Administración" : "Portal de Proveedores";

  const pestanas = modulo.pestanas(perfil.rol);
  // Si cambió el rol en vivo y la pestaña actual ya no corresponde, vuelve a la primera.
  const id = vistaActual && vistaActual.modulo === modulo && pestanas.some((p) => p.id === vistaActual.id) ? vistaActual.id : pestanas[0].id;
  const yaMontada = vistaActual && vistaActual.modulo === modulo && vistaActual.id === id && vistaActual.rol === perfil.rol;
  $("#pestanas").innerHTML = pestanas.map((p) =>
    `<button type="button" class="pestana ${p.id === id ? "activa" : ""}" data-pestana="${p.id}">${icono(p.icono)}${esc(p.texto)}</button>`).join("");
  $$("#pestanas [data-pestana]").forEach((b) => b.addEventListener("click", () => irA(b.dataset.pestana)));
  mostrar("app");
  if (!yaMontada) irA(id);
}

function desmontarVista() {
  if (limpiarVista) { try { limpiarVista(); } catch { /* nada */ } }
  limpiarVista = null;
  vistaActual = null;
}

/** Cambia de pestaña. `params` permite, p. ej., abrir "Pagos" filtrado por un RUC. */
function irA(id, params = {}) {
  const modulo = esInterno(perfil.rol) ? vistaAdmin : vistaProveedor;
  desmontarVista();
  $$("#pestanas [data-pestana]").forEach((b) => b.classList.toggle("activa", b.dataset.pestana === id));
  const cont = $("#contenido");
  cont.innerHTML = "";
  vistaActual = { modulo, id, rol: perfil.rol };
  limpiarVista = modulo.montar(id, cont, { user, perfil, irA, params }) || null;
  window.scrollTo({ top: 0 });
}

/* En el celular las tablas se ven como tarjetas (estilos.css): cada celda lleva en data-etq el título de su
   columna, tomado del encabezado de la tabla (respeta colspan). Vale para toda tabla nueva sin tocarla. */
function etiquetarTablas() {
  for (const t of document.querySelectorAll(".tabla-caja table")) {
    const titulos = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    for (const tr of t.querySelectorAll("tbody tr, tfoot tr")) {
      let col = 0;
      for (const td of tr.children) {
        if (!td.hasAttribute("data-etq")) {
          td.dataset.etq = td.colSpan > 1 ? "" : titulos[col] || "";
          if (td.textContent.trim() === "—") td.dataset.sinDato = "";   // en el celular no se muestra
        }
        col += td.colSpan || 1;
      }
    }
  }
}
let etiquetaPendiente = false;
new MutationObserver(() => {
  if (etiquetaPendiente) return;
  etiquetaPendiente = true;
  requestAnimationFrame(() => { etiquetaPendiente = false; etiquetarTablas(); });
}).observe(document.body, { childList: true, subtree: true });

// Sombra del encabezado al bajar (como el encabezado inteligente de la suite).
window.addEventListener("scroll", () => $("#encabezado").classList.toggle("con-sombra", window.scrollY > 4), { passive: true });

/* ── Cierre de sesión automático ─────────────────────────────────────
   Como la banca en línea: tras MINUTOS_INACTIVIDAD sin tocar nada aparece un
   aviso con cuenta regresiva (SEGUNDOS_AVISO_CIERRE) y, si nadie responde, se
   cierra la sesión. Además, cada HORAS_SESION_MAXIMA hay que volver a ingresar
   aunque se esté usando. Se revisa con la hora real (no solo con temporizadores),
   así también cierra al volver de una computadora suspendida. */
const EVENTOS_ACTIVIDAD = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"];
const LIMITE_INACTIVO = MINUTOS_INACTIVIDAD * 60 * 1000;
const AVISO = SEGUNDOS_AVISO_CIERRE * 1000;
const LIMITE_SESION = HORAS_SESION_MAXIMA * 3600 * 1000;
let ultimaActividad = 0, inicioSesion = 0, relojSesion = 0, avisoCierre = null;

function registrarActividad() {
  if (!avisoCierre) ultimaActividad = Date.now(); // con el aviso abierto solo cuenta el botón
}
function cerrarPorTiempo(motivo) {
  detenerInactividad();
  motivoSalida = motivo;
  logout();
}
function revisarSesion() {
  const ahora = Date.now();
  if (ahora - inicioSesion >= LIMITE_SESION) {
    return cerrarPorTiempo(`Por seguridad, cada ${HORAS_SESION_MAXIMA} horas hay que volver a ingresar.`);
  }
  const inactivo = ahora - ultimaActividad;
  if (inactivo >= LIMITE_INACTIVO) {
    return cerrarPorTiempo(`Tu sesión se cerró tras ${MINUTOS_INACTIVIDAD} minutos sin actividad. Vuelve a ingresar.`);
  }
  const quedan = Math.ceil((LIMITE_INACTIVO - inactivo) / 1000);
  if (inactivo >= LIMITE_INACTIVO - AVISO) mostrarAvisoCierre(quedan);
  else if (avisoCierre) { avisoCierre.cerrar(); avisoCierre = null; }
}
function mostrarAvisoCierre(quedan) {
  if (avisoCierre) { const n = avisoCierre.el.querySelector("[data-quedan]"); if (n) n.textContent = quedan; return; }
  avisoCierre = abrirModal(`
    <div class="modal-cab"><h2>¿Sigues ahí?</h2></div>
    <p class="modal-sub" style="font-size:12.5px;margin-top:8px">Por seguridad, tu sesión se cerrará en
      <b class="mono" style="font-size:16px;color:var(--rojo)" data-quedan>${quedan}</b> segundos por inactividad.</p>
    <div class="modal-pie">
      <button type="button" class="btn" data-salir>${icono("power")}Cerrar sesión</button>
      <button type="button" class="btn oscuro" data-seguir autofocus>${icono("check")}Seguir conectado</button>
    </div>`, { cerrable: false });
  avisoCierre.el.querySelector("[data-seguir]").addEventListener("click", () => {
    avisoCierre.cerrar(); avisoCierre = null;
    ultimaActividad = Date.now();
  });
  avisoCierre.el.querySelector("[data-salir]").addEventListener("click", () => cerrarPorTiempo(""));
}
function iniciarInactividad() {
  if (relojSesion) return; // ya corre (decidir() se vuelve a llamar con cada cambio del perfil)
  ultimaActividad = Date.now();
  // La hora de ingreso se guarda en la pestaña: recargar la página no reinicia el tope de horas.
  const clave = `sesion:inicio:${user?.uid}`;
  try { inicioSesion = Number(sessionStorage.getItem(clave)) || 0; } catch { /* sin almacenamiento */ }
  if (!inicioSesion) { inicioSesion = Date.now(); try { sessionStorage.setItem(clave, String(inicioSesion)); } catch { /* nada */ } }
  EVENTOS_ACTIVIDAD.forEach((ev) => window.addEventListener(ev, registrarActividad, { passive: true }));
  document.addEventListener("visibilitychange", revisarSesion);
  relojSesion = setInterval(revisarSesion, 1000);
}
function detenerInactividad() {
  clearInterval(relojSesion);
  relojSesion = 0;
  EVENTOS_ACTIVIDAD.forEach((ev) => window.removeEventListener(ev, registrarActividad));
  document.removeEventListener("visibilitychange", revisarSesion);
  if (avisoCierre) { avisoCierre.cerrar(); avisoCierre = null; }
}
