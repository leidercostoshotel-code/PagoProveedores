/* ══════════════════════════════════════════════════════════════════
   PLANTILLAS DE LAS PANTALLAS
   El index.html se mantiene mínimo (pedido: "HTML máximo 20 líneas"):
   todo el marcado de carga, ingreso y la app vive aquí y se inserta al
   arrancar. Ingreso con el mismo diseño de la suite A-B-Swiss.
   ══════════════════════════════════════════════════════════════════ */
import { EMPRESA, NOMBRE_SISTEMA } from "./config.js";

const LOGO = `img/logo-30-anos.gif`;
const ALT_LOGO = `30 años ${EMPRESA}`;
const CREDITO = `Powered by <a href="https://leidertisnado.com" target="_blank" rel="noopener noreferrer">leidertisnado.com</a>`;

const CARGA = `
<div id="pantalla-carga" class="pc-raiz" role="status" aria-live="polite">
  <div class="pc-centro">
    <div class="pc-logo"><img src="${LOGO}" alt="${ALT_LOGO}"></div>
    <div class="pc-pista"><div class="pc-barra"></div></div>
    <p class="pc-texto-linea"><span class="pc-texto" id="texto-carga">Cargando</span><span class="pc-punto">.</span><span class="pc-punto">.</span><span class="pc-punto">.</span></p>
  </div>
</div>`;

const INGRESO = `
<div id="pantalla-ingreso" class="pantalla-fondo" hidden>
  <form id="form-ingreso" class="tarjeta-ingreso" novalidate>
    <div class="marca-ingreso">
      <img class="logo30" src="${LOGO}" alt="${ALT_LOGO}">
      <div class="icono-sistema" data-icono="billetera"></div>
      <div><div class="sobretitulo">${EMPRESA}</div><div class="titulo-sistema">${NOMBRE_SISTEMA}</div></div>
    </div>
    <label class="campo"><span>RUC o correo</span>
      <input class="input" id="ingreso-usuario" type="text" inputmode="email" required autocomplete="username"
        placeholder="20123456789" spellcheck="false" autocapitalize="off">
    </label>
    <label class="campo" style="margin-bottom:16px"><span>Contraseña</span>
      <div class="con-ojo">
        <input class="input" id="ingreso-clave" type="password" required autocomplete="current-password">
        <button type="button" class="ojo" data-ojo="ingreso-clave" title="Mostrar u ocultar" aria-label="Mostrar u ocultar contraseña"></button>
      </div>
    </label>
    <p id="ingreso-error" class="error" role="alert" hidden></p>
    <button id="ingreso-btn" class="btn oscuro bloque" type="submit">Entrar</button>
    <p class="ayuda"><b>Proveedores:</b> ingresa con tu RUC y la clave que te entregó Contabilidad. En tu primer ingreso
      te pediremos cambiarla.<br><b>Personal del hotel:</b> ingresa con tu correo.</p>
    <div class="sello-seguro" data-icono-sello>Conexión segura · 3 intentos fallidos bloquean la cuenta 1 hora</div>
  </form>
  <p class="credito">${CREDITO}</p>
</div>`;

const APP = `
<div id="pantalla-aviso" hidden></div>
<div id="app" hidden>
  <header id="encabezado" class="encabezado">
    <div class="contenedor">
      <div class="fila-sup">
        <div class="marca-app">
          <div class="icono" data-icono="billetera"></div>
          <div><div class="sobre">${EMPRESA}</div><div class="nombre" id="nombre-vista">${NOMBRE_SISTEMA}</div></div>
          <img class="logo30-enc" src="${LOGO}" alt="${ALT_LOGO}">
        </div>
        <div class="usuario-app">
          <span class="chip-usuario" id="chip-usuario"></span>
          <button type="button" class="btn fantasma chico" id="btn-clave" title="Cambiar tu contraseña"></button>
          <button type="button" class="btn fantasma chico" id="btn-salir"></button>
        </div>
      </div>
      <nav class="pestanas" id="pestanas" aria-label="Secciones"></nav>
    </div>
  </header>
  <main class="contenedor" id="contenido"></main>
  <footer class="pie">${CREDITO}</footer>
</div>
<div id="toast" class="toast" hidden></div>`;

export { CREDITO, LOGO, ALT_LOGO };

/** Inserta todas las pantallas en el <body> (una sola vez, al arrancar). */
export function montarPlantillas() {
  document.body.insertAdjacentHTML("beforeend", CARGA + INGRESO + APP);
}
