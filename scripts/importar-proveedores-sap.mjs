/* ══════════════════════════════════════════════════════════════════
   IMPORTAR PROVEEDORES DESDE EL EXCEL DE SAP (Socios de negocios)
   Crea, para cada proveedor nuevo, su cuenta de acceso (usuario = RUC,
   clave = su RUC) y su perfil en "usuarios". Se corre desde Cloud Shell
   con scripts/importar-proveedores.sh (no a mano).

   Del Excel usa (por el nombre del encabezado; si no lo encuentra, por la letra):
     C  Nombre SN · Y  Número de identificación fiscal (RUC)
     B  Código SN · D  Clase de socio (S = proveedor) · EV Activo · FX Borrado
     BF Correo electrónico · K Teléfono 1
   Reglas: solo clase S (proveedor), no borrados, RUC válido de 11 dígitos
   (10/15/17/20); un RUC repetido (código -S / -D) se crea una sola vez.
   Activo en el portal = Activo en SAP (con --todos-activos, todos activos).
   Nunca toca a un proveedor que ya tiene perfil, ni una cuenta creada por
   otro medio con ese RUC (la reporta para revisarla).

   Uso: TOKEN=$(gcloud auth print-access-token) node importar-proveedores-sap.mjs PROYECTO archivo.xlsx [--si] [--todos-activos]
   ══════════════════════════════════════════════════════════════════ */
import ExcelJS from "exceljs";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";

const [proyecto, archivo, ...banderas] = process.argv.slice(2);
const SIN_PREGUNTAR = banderas.includes("--si");
const TODOS_ACTIVOS = banderas.includes("--todos-activos");
const DOMINIO = "proveedores.hotel";
const TOKEN = process.env.TOKEN || "";
// Para probar contra los emuladores: AUTH_URL=http://127.0.0.1:9099/identitytoolkit.googleapis.com FS_URL=http://127.0.0.1:8080
const AUTH = process.env.AUTH_URL || "https://identitytoolkit.googleapis.com";
const FS = process.env.FS_URL || "https://firestore.googleapis.com";
const EMULADOR = !!process.env.AUTH_URL;

if (!proyecto || !archivo) { console.error("Uso: node importar-proveedores-sap.mjs PROYECTO archivo.xlsx [--si] [--todos-activos]"); process.exit(1); }
if (proyecto === "leitime") { console.error("⛔ leitime es el proyecto de la suite A-B-Swiss, no el del portal."); process.exit(1); }
if (!fs.existsSync(archivo)) { console.error(`⛔ No encuentro el archivo: ${archivo}`); process.exit(1); }
if (!TOKEN) { console.error("⛔ Falta TOKEN (gcloud auth print-access-token)."); process.exit(1); }

const cabeceras = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(EMULADOR ? {} : { "x-goog-user-project": proyecto }) };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function llamar(url, cuerpo, intentos = 5) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { method: "POST", headers: cabeceras, body: JSON.stringify(cuerpo) });
    const datos = await r.json().catch(() => ({}));
    if ((r.status === 429 || r.status >= 500) && i < intentos) { await espera(1000 * 2 ** i); continue; }
    return { ok: r.ok, status: r.status, datos };
  }
}

/* ── 1. Leer el Excel (en flujo: el de SAP puede pesar varios MB) ── */
const texto = (v) => {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
  }
  return String(v);
};
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const COLUMNAS = { // encabezado de SAP → columna por defecto (1 = A)
  nombre: ["nombre sn", 3], ruc: ["numero de identificacion fiscal", 25], codigo: ["codigo sn", 2],
  clase: ["clase de socio de negocios", 4], activo: ["activo", 152], borrado: ["borrado", 180],
  correo: ["correo electronico", 58], telefono: ["telefono 1", 11],
};

const porRuc = new Map();
const omitidos = { cliente: 0, borrado: 0, rucInvalido: 0, sinNombre: 0 };
let filas = 0, col = null;
const lector = new ExcelJS.stream.xlsx.WorkbookReader(archivo, { sharedStrings: "cache", hyperlinks: "ignore", styles: "ignore", worksheets: "emit" });
for await (const hoja of lector) {
  for await (const fila of hoja) {
    const v = fila.values; // 1 = A
    if (!col) {
      const enc = v.map((x) => norm(texto(x)));
      col = Object.fromEntries(Object.entries(COLUMNAS).map(([k, [nombre, def]]) => {
        const i = enc.indexOf(nombre);
        return [k, i > 0 ? i : (k === "nombre" || k === "ruc" ? def : 0)];
      }));
      if (enc.indexOf("nombre sn") < 0 || enc.indexOf("numero de identificacion fiscal") < 0) {
        console.log("ⓘ No encontré los encabezados de SAP: uso la columna C (nombre) y la Y (RUC).");
      }
      continue;
    }
    filas++;
    const celda = (k) => (col[k] ? texto(v[col[k]]).trim() : "");
    const clase = celda("clase").toUpperCase();
    if (clase && clase !== "S") { omitidos.cliente++; continue; }
    if (celda("borrado").toUpperCase() === "Y") { omitidos.borrado++; continue; }
    const ruc = celda("ruc").replace(/\D/g, "");
    if (!/^(10|15|17|20)\d{9}$/.test(ruc)) { omitidos.rucInvalido++; continue; }
    const nombre = celda("nombre").replace(/\s+/g, " ").toUpperCase();
    if (!nombre) { omitidos.sinNombre++; continue; }
    const p = {
      ruc, nombre, codigo: celda("codigo"),
      activo: TODOS_ACTIVOS || !col.activo || celda("activo").toUpperCase() !== "N",
      correo: /^\S+@\S+\.\S+$/.test(celda("correo")) ? celda("correo").toLowerCase() : "",
      telefono: celda("telefono"),
    };
    const previo = porRuc.get(ruc);
    // Un RUC repetido (códigos -S/-D): se queda el activo, y si no, el de soles; los datos que falten se completan.
    if (!previo || (p.activo && !previo.activo) || (p.activo === previo.activo && /-S$/i.test(p.codigo) && !/-S$/i.test(previo.codigo))) {
      porRuc.set(ruc, { ...p, correo: p.correo || previo?.correo || "", telefono: p.telefono || previo?.telefono || "" });
    } else {
      previo.correo ||= p.correo;
      previo.telefono ||= p.telefono;
    }
  }
  break; // solo la primera hoja
}

/* ── 2. Quiénes ya tienen perfil en el portal ── */
const base = `projects/${proyecto}/databases/(default)/documents`;
const yaPerfil = new Set();
{
  const r = await llamar(`${FS}/v1/${base}:runQuery`, { structuredQuery: {
    from: [{ collectionId: "usuarios" }],
    where: { fieldFilter: { field: { fieldPath: "rol" }, op: "EQUAL", value: { stringValue: "proveedor" } } },
    select: { fields: [{ fieldPath: "ruc" }] },
  } });
  if (!r.ok) { console.error("⛔ No pude leer los usuarios del portal:", r.status, JSON.stringify(r.datos).slice(0, 300)); process.exit(1); }
  for (const x of r.datos) { const ruc = x.document?.fields?.ruc?.stringValue; if (ruc) yaPerfil.add(ruc); }
}
const nuevos = [...porRuc.values()].filter((p) => !yaPerfil.has(p.ruc)).sort((a, b) => a.nombre.localeCompare(b.nombre));
const repetidos = [...porRuc.values()].length;

const n = (x) => x.toLocaleString("es-PE");
console.log(`
Excel: ${path.basename(archivo)} · ${n(filas)} filas
  Proveedores con RUC válido (sin repetir): ${n(repetidos)}
  Omitidos: ${n(omitidos.cliente)} clientes · ${n(omitidos.borrado)} borrados · ${n(omitidos.rucInvalido)} sin RUC válido (DNI, extranjeros…) · ${n(omitidos.sinNombre)} sin nombre
  Ya tienen cuenta en el portal: ${n(repetidos - nuevos.length)}
  Por crear: ${n(nuevos.length)} (${n(nuevos.filter((p) => p.activo).length)} activos, ${n(nuevos.filter((p) => !p.activo).length)} inactivos en SAP${TODOS_ACTIVOS ? "" : " → quedan desactivados; se activan en el panel"})
  Usuario = RUC · Clave = su RUC
`);
if (!nuevos.length) { console.log("✅ No hay proveedores nuevos que crear."); process.exit(0); }
for (const p of nuevos.slice(0, 5)) console.log(`   ${p.ruc}  ${p.nombre}${p.activo ? "" : "  (inactivo)"}`);
if (nuevos.length > 5) console.log(`   … y ${n(nuevos.length - 5)} más`);

if (!SIN_PREGUNTAR) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resp = await new Promise((r) => rl.question(`\n¿Crear las ${n(nuevos.length)} cuentas en ${proyecto}? (s/N) `, r));
  rl.close();
  if (!/^s/i.test(resp.trim())) { console.log("Cancelado: no se creó nada."); process.exit(0); }
}

/* ── 3. Cuentas de acceso (Firebase Auth, como administrador) ── */
const resultado = new Map(); // ruc → texto
const listos = [];
let hechos = 0;
async function crearCuenta(p) {
  const uid = `prov-${p.ruc}`, email = `${p.ruc}@${DOMINIO}`;
  const r = await llamar(`${AUTH}/v1/projects/${proyecto}/accounts`, {
    localId: uid, email, password: p.ruc, displayName: p.nombre.slice(0, 256), emailVerified: false,
  });
  const msg = r.datos?.error?.message || "";
  if (r.ok || msg.startsWith("DUPLICATE_LOCAL_ID")) { listos.push({ ...p, uid }); return; }
  if (msg.startsWith("EMAIL_EXISTS")) {
    // Si la cuenta es de una importación anterior (mismo uid), se completa su perfil; si la creó otro, no se toca.
    const l = await llamar(`${AUTH}/v1/projects/${proyecto}/accounts:lookup`, { email: [email] });
    if (l.datos?.users?.[0]?.localId === uid) { listos.push({ ...p, uid }); return; }
    resultado.set(p.ruc, "OMITIDO: ya existe una cuenta con ese RUC creada por otro medio (revísala en Authentication)");
    return;
  }
  resultado.set(p.ruc, `ERROR al crear la cuenta: ${msg || r.status}`);
}
const COLA = 8;
for (let i = 0; i < nuevos.length; i += COLA) {
  await Promise.all(nuevos.slice(i, i + COLA).map(crearCuenta));
  hechos = Math.min(i + COLA, nuevos.length);
  if (hechos % 200 < COLA || hechos === nuevos.length) console.log(`  Cuentas: ${n(hechos)} de ${n(nuevos.length)}…`);
}

/* ── 4. Perfiles en "usuarios" (sin pisar uno que ya exista) ── */
const ahora = new Date().toISOString();
const s = (x) => ({ stringValue: String(x ?? "") });
for (let i = 0; i < listos.length; i += 200) {
  const lote = listos.slice(i, i + 200);
  const r = await llamar(`${FS}/v1/${base}:batchWrite`, { writes: lote.map((p) => ({
    update: { name: `${base}/usuarios/${p.uid}`, fields: {
      rol: s("proveedor"), ruc: s(p.ruc), razonSocial: s(p.nombre), nombre: s(p.nombre), email: s(`${p.ruc}@${DOMINIO}`),
      contacto: s(p.correo), telefono: s(p.telefono), codigoSap: s(p.codigo), origen: s("sap"),
      activo: { booleanValue: p.activo }, debeCambiarClave: { booleanValue: false },
      creadoPor: s("Importación SAP"), creadoEn: { timestampValue: ahora },
    } },
    currentDocument: { exists: false },
  })) });
  if (!r.ok) { lote.forEach((p) => resultado.set(p.ruc, `ERROR al guardar el perfil: ${r.status}`)); continue; }
  (r.datos.status || []).forEach((st, k) => {
    const p = lote[k];
    if (!st.code) resultado.set(p.ruc, p.activo ? "CREADO" : "CREADO (inactivo)");
    else if (st.code === 6 || st.code === 9) resultado.set(p.ruc, "YA TENÍA PERFIL");
    else resultado.set(p.ruc, `ERROR al guardar el perfil: ${st.message || st.code}`);
  });
  console.log(`  Perfiles: ${n(Math.min(i + 200, listos.length))} de ${n(listos.length)}…`);
}

/* ── 5. Informe ── */
const cuenta = (pref) => [...resultado.values()].filter((t) => t.startsWith(pref)).length;
const sello = ahora.slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1_$2");
const informe = path.join(os.homedir(), `importacion_proveedores_${sello}.csv`);
const fila = (a) => a.map((x) => (/[;"\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x)).join(";");
fs.writeFileSync(informe, "﻿" + [fila(["RUC", "Razón social", "Resultado"]), ...nuevos.map((p) => fila([p.ruc, p.nombre, resultado.get(p.ruc) || "SIN RESULTADO"]))].join("\r\n"));
console.log(`
✅ Listo en ${proyecto}
  Creados: ${n(cuenta("CREADO"))} · Ya tenían perfil: ${n(cuenta("YA TENÍA"))} · Omitidos: ${n(cuenta("OMITIDO"))} · Errores: ${n(cuenta("ERROR"))}
  Detalle por RUC: ${informe}
`);
process.exit(cuenta("ERROR") ? 2 : 0);
