/* ══════════════════════════════════════════════════════════════════
   UTILIDADES COMPARTIDAS: íconos, formato, avisos, diálogos, CSV
   ══════════════════════════════════════════════════════════════════ */

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

/** Escapa texto para meterlo en innerHTML (los datos vienen de TXT/CSV externos). */
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ── Íconos (trazos estilo Lucide, los mismos que usa la suite) ─── */
const P = {
  billetera: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  llave: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  ojo: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  ojoNo: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  escudo: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  alerta: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  recibo: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  subir: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  bajar: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  capas: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  edificio: '<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>',
  usuarios: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  mas: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  basura: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  impresora: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  buscar: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  refrescar: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  archivo: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  dados: '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/>',
  grafico: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
};
export function icono(nombre, clase = "") {
  return `<svg class="${clase}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[nombre] || ""}</svg>`;
}

/* ── Formato ────────────────────────────────────────────────────── */
const fmtSoles = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const soles = (n) => fmtSoles.format(Number(n) || 0);
export const solesS = (n) => `S/ ${soles(n)}`;
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"];
export const NOMBRES_MES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Setiembre", "Octubre", "Noviembre", "Diciembre"];
/** "2026-10-24" → "24 oct 2026" */
export function fechaCorta(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return esc(iso || "—");
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d} ${MESES[Number(m) - 1]} ${y}`;
}
/** Timestamp de Firestore / Date / ISO → "24 oct 2026, 15:40" */
export function fechaHora(v) {
  if (!v) return "—";
  const d = typeof v.toDate === "function" ? v.toDate() : new Date(v);
  if (isNaN(d)) return "—";
  return d.toLocaleString("es-PE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
const pad = (n) => String(n).padStart(2, "0");
export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hoyISO = () => toISO(new Date());
/** Cuenta bancaria enmascarada: solo los últimos 4 dígitos. */
export const enmascarar = (c) => { const s = String(c || "").replace(/\s/g, ""); return s.length > 4 ? `•••• ${s.slice(-4)}` : s || "—"; };
/** Minúsculas y sin tildes, para buscar. */
export const normalizar = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/* ── Claves ─────────────────────────────────────────────────────── */
/** Política de claves del portal: mínimo 8, con letras y números. */
export function validarClaveNueva(clave) {
  if (clave.length < 8) return "La contraseña debe tener al menos 8 caracteres";
  if (!/[a-zA-Z]/.test(clave) || !/\d/.test(clave)) return "La contraseña debe combinar letras y números";
  return "";
}
/** Clave inicial aleatoria legible (sin 0/O/1/l para no confundir al dictarla). */
export function generarClave() {
  const letras = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ", nums = "23456789";
  const r = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  let c = "";
  for (let i = 0; i < 7; i++) c += r(letras);
  return c + r(nums) + r(nums) + r(nums);
}

/* ── Mensajes de error (mismos textos que la suite) ─────────────── */
export const ERRORES_LOGIN = {
  "auth/invalid-email": "RUC o correo inválido",
  "auth/user-disabled": "Esta cuenta está deshabilitada. Comunícate con Contabilidad.",
  "auth/user-not-found": "No existe una cuenta con ese RUC o correo",
  "auth/wrong-password": "Contraseña incorrecta",
  "auth/invalid-credential": "RUC/correo o contraseña incorrectos",
  "auth/missing-password": "Escribe la contraseña",
  "auth/too-many-requests": "Demasiados intentos. Espera un momento.",
  "auth/network-request-failed": "Sin conexión. Revisa tu internet e inténtalo de nuevo.",
};
export const ERRORES_ALTA = {
  "auth/email-already-in-use": "Ya existe una cuenta con ese RUC o correo",
  "auth/invalid-email": "Correo inválido",
  "auth/weak-password": "La contraseña debe tener al menos 6 caracteres",
};
export const ERRORES_CLAVE = {
  "auth/wrong-password": "La contraseña actual no es correcta",
  "auth/invalid-credential": "La contraseña actual no es correcta",
  "auth/weak-password": "La contraseña nueva es muy débil",
  "auth/too-many-requests": "Demasiados intentos. Espera un momento y vuelve a intentar.",
  "auth/requires-recent-login": "Por seguridad, cierra sesión, vuelve a entrar e inténtalo de nuevo.",
};

/** Mensaje del login, incluido el bloqueo por intentos (3 intentos → 1 hora). */
export function mensajeErrorLogin(err) {
  if (err.code === "auth/bloqueado-por-intentos") {
    const hora = new Date(err.bloqueadoHasta).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
    return `Cuenta bloqueada por 3 intentos fallidos. Vuelve a intentar después de las ${hora}.`;
  }
  const base = ERRORES_LOGIN[err.code] || "No se pudo iniciar sesión";
  if ((err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") && err.intentosRestantes) {
    const n = err.intentosRestantes;
    return `${base}. Te queda${n === 1 ? "" : "n"} ${n} intento${n === 1 ? "" : "s"} antes del bloqueo de 1 hora.`;
  }
  return base;
}

/* ── Aviso flotante ─────────────────────────────────────────────── */
let timerAviso = 0;
export function notificar(texto, tipo = "") {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.className = `toast ${tipo}`;
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ── Modales ────────────────────────────────────────────────────── */
/** Abre un modal con el HTML dado; devuelve { el, cerrar }. Esc o clic afuera cierran si `cerrable`. */
export function abrirModal(html, { ancho = false, cerrable = true, alCerrar } = {}) {
  const fondo = document.createElement("div");
  fondo.className = "modal-fondo";
  fondo.innerHTML = `<div class="modal ${ancho ? "ancho" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(fondo);
  const cerrar = () => {
    if (!fondo.isConnected) return;
    fondo.remove();
    document.removeEventListener("keydown", tecla);
    if (alCerrar) alCerrar();
  };
  const tecla = (e) => { if (e.key === "Escape" && cerrable) cerrar(); };
  document.addEventListener("keydown", tecla);
  if (cerrable) fondo.addEventListener("mousedown", (e) => { if (e.target === fondo) cerrar(); });
  fondo.querySelectorAll("[data-cerrar]").forEach((b) => b.addEventListener("click", cerrar));
  const foco = fondo.querySelector("[autofocus]") || fondo.querySelector("input, select, button");
  if (foco) setTimeout(() => foco.focus(), 30);
  return { el: fondo, cerrar };
}

/** Diálogo de confirmación; resuelve true/false. */
export function confirmar({ titulo, mensaje, textoOk = "Confirmar", peligroso = false }) {
  return new Promise((resolver) => {
    let resultado = false;
    const { el, cerrar } = abrirModal(`
      <div class="modal-cab"><h2>${esc(titulo)}</h2></div>
      <p class="modal-sub" style="margin-top:8px;font-size:12px">${esc(mensaje)}</p>
      <div class="modal-pie">
        <button type="button" class="btn" data-cerrar>Cancelar</button>
        <button type="button" class="btn ${peligroso ? "rojo-solido" : "oscuro"}" data-ok>${icono("check")}${esc(textoOk)}</button>
      </div>`, { alCerrar: () => resolver(resultado) });
    el.querySelector("[data-ok]").addEventListener("click", () => { resultado = true; cerrar(); });
  });
}

/* ── Exportar a CSV (se abre directo en Excel: ; y BOM UTF-8) ───── */
export function descargarCSV(nombre, encabezados, filas) {
  const celda = (v) => {
    const s = typeof v === "number" ? v.toFixed(2).replace(".", ",") : String(v ?? "");
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const texto = [encabezados, ...filas].map((f) => f.map(celda).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + texto], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Campo de contraseña con botón para mostrar/ocultar. */
export function campoClave({ id, etiqueta, autocomplete = "current-password", autofocus = false }) {
  return `<label class="campo"><span>${esc(etiqueta)}</span>
    <div class="con-ojo">
      <input class="input" id="${id}" type="password" required autocomplete="${autocomplete}" ${autofocus ? "autofocus" : ""}>
      <button type="button" class="ojo" data-ojo="${id}" title="Mostrar u ocultar" aria-label="Mostrar u ocultar contraseña">${icono("ojo")}</button>
    </div></label>`;
}
/** Activa los botones de "ver contraseña" dentro de `raiz`. */
export function activarOjos(raiz) {
  raiz.querySelectorAll("[data-ojo]").forEach((b) => b.addEventListener("click", () => {
    const inp = raiz.querySelector(`#${b.dataset.ojo}`);
    const ver = inp.type === "password";
    inp.type = ver ? "text" : "password";
    b.innerHTML = icono(ver ? "ojoNo" : "ojo");
  }));
}
