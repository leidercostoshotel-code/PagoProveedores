/* ══════════════════════════════════════════════════════════════════
   Piezas comunes del respaldo y la restauración (Node.js 18+, sin
   dependencias): token de Google con la llave de la cuenta de servicio
   (JWT firmado aquí mismo) y la API REST de Firestore.
   Con FIRESTORE_EMULATOR_HOST (pruebas) va al emulador y no pide token.
   ══════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import fs from "node:fs";

const EMULADOR = process.env.FIRESTORE_EMULATOR_HOST;
export const BASE = EMULADOR ? `http://${EMULADOR}/v1` : "https://firestore.googleapis.com/v1";
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const b64url = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Lee la llave JSON de la cuenta de servicio y valida lo mínimo. */
export function leerLlave(ruta) {
  const k = JSON.parse(fs.readFileSync(ruta, "utf8").replace(/^\uFEFF/, ""));   // el Bloc de notas agrega BOM
  if (k.type !== "service_account" || !k.client_email || !k.private_key) throw new Error(`${ruta} no es una llave de cuenta de servicio de Google.`);
  return k;
}

/** Cliente con token que se renueva solo (las corridas largas pasan de una hora). */
export function cliente(llave) {
  let token = null, vence = 0;
  async function obtenerToken() {
    if (EMULADOR) return "owner";
    if (token && Date.now() < vence - 120000) return token;
    const ahora = Math.floor(Date.now() / 1000), aud = llave.token_uri || "https://oauth2.googleapis.com/token";
    const cuerpo = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({
      iss: llave.client_email, scope: "https://www.googleapis.com/auth/datastore", aud, iat: ahora, exp: ahora + 3600 }))}`;
    const firma = b64url(crypto.createSign("RSA-SHA256").update(cuerpo).sign(llave.private_key));
    const r = await fetch(aud, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${cuerpo}.${firma}` }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Google no aceptó la llave (${r.status}): ${j.error_description || j.error || "sin detalle"}`);
    token = j.access_token;
    vence = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return token;
  }
  /** Pide a la API con reintentos (429 / 5xx / red). 404 devuelve null. */
  async function pedir(url, opciones = {}) {
    for (let intento = 1; ; intento++) {
      try {
        const r = await fetch(url, { ...opciones, headers: { ...(opciones.headers || {}), Authorization: `Bearer ${await obtenerToken()}`, "Content-Type": "application/json" } });
        if (r.status === 404) return null;
        if (r.ok) return r.json();
        const texto = await r.text();
        if (r.status === 401) token = null;
        if (intento >= 5 || ![401, 429, 500, 502, 503, 504].includes(r.status)) throw new Error(`Firestore respondió ${r.status}: ${texto.slice(0, 300)}`);
      } catch (err) {
        if (intento >= 5 || /^Firestore respondió|^Google no aceptó/.test(err.message)) throw err;
      }
      await espera(1000 * 2 ** intento);
    }
  }
  return { pedir };
}

export const rutaDocs = (proyecto) => `${BASE}/projects/${proyecto}/databases/(default)/documents`;

/** Recorre una colección completa, página por página (los documentos tal cual los da la API, con sus tipos). */
export async function* documentos(api, proyecto, coleccion) {
  let pagina = "";
  do {
    const j = await api.pedir(`${rutaDocs(proyecto)}/${coleccion}?pageSize=300${pagina ? `&pageToken=${encodeURIComponent(pagina)}` : ""}`);
    for (const d of j?.documents || []) yield d;
    pagina = j?.nextPageToken || "";
  } while (pagina);
}

/** Valor de Firestore (con su tipo) → valor simple de JavaScript. */
export function plano(v) {
  if (!v || typeof v !== "object") return v ?? null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(plano);
  if ("mapValue" in v) return camposPlanos(v.mapValue.fields);
  return null;
}
export const camposPlanos = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, plano(v)]));
export const idDe = (nombre) => decodeURIComponent(nombre.split("/").pop());

/* ── Excel (.xlsx) sin librerías: zip sin comprimir + hoja con encabezado de color ── */
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = TABLA_CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(archivos) {
  const partes = [], central = [];
  let pos = 0;
  for (const [nombre, texto] of archivos) {
    const n = Buffer.from(nombre), d = Buffer.from(texto, "utf8"), crc = crc32(d);
    const cab = Buffer.alloc(30), cen = Buffer.alloc(46);
    cab.writeUInt32LE(0x04034b50, 0); cab.writeUInt16LE(20, 4); cab.writeUInt16LE(0x0800, 6);
    cab.writeUInt32LE(crc, 14); cab.writeUInt32LE(d.length, 18); cab.writeUInt32LE(d.length, 22); cab.writeUInt16LE(n.length, 26);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(d.length, 20); cen.writeUInt32LE(d.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(pos, 42);
    partes.push(cab, n, d); central.push(cen, n);
    pos += 30 + n.length + d.length;
  }
  const largo = central.reduce((s, b) => s + b.length, 0), fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(largo, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...partes, ...central, fin]);
}
const xe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const letra = (i) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** Escribe un .xlsx de una hoja: números como números (sin líos de coma o punto decimal), el resto como texto. */
export function escribirXlsx(ruta, hoja, encabezados, filas) {
  const celda = (v, ref, s) => {
    if (v === null || v === undefined || v === "") return `<c r="${ref}" s="${s}"/>`;
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
    return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xe(Array.isArray(v) ? v.join(", ") : v)}</t></is></c>`;
  };
  const ult = `${letra(encabezados.length - 1)}${filas.length + 1}`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${ult}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${encabezados.map((t, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(12, Math.min(45, String(t).length + 6))}" customWidth="1"/>`).join("")}</cols><sheetData><row r="1">${encabezados.map((t, i) => celda(t, `${letra(i)}1`, 1)).join("")}</row>${filas.map((f, r) => `<row r="${r + 2}">${encabezados.map((_, i) => celda(f[i], `${letra(i)}${r + 2}`, 0)).join("")}</row>`).join("")}</sheetData><autoFilter ref="A1:${ult}"/></worksheet>`;
  fs.writeFileSync(ruta, zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xe(hoja).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B1F3A"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ["xl/worksheets/sheet1.xml", xml],
  ]));
}
