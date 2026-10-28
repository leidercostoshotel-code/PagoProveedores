/* ══════════════════════════════════════════════════════════════════
   ZIP Y EXCEL (.xlsx) SIN LIBRERÍAS
   - leerZip: abre un .zip (o un .xlsx, que también es un zip) con el
     DecompressionStream del navegador.
   - leerXlsx: lee la primera hoja de un .xlsx como filas de texto.
   - crearXlsx: arma un .xlsx con encabezado de color (zip sin comprimir).
   La CSP solo deja scripts propios: por eso no se usa SheetJS/JSZip.
   ══════════════════════════════════════════════════════════════════ */

const dec = new TextDecoder("utf-8");

/** Entradas de un zip: [{ nombre, datos: Uint8Array }] (sin carpetas). */
export async function leerZip(archivo) {
  const buf = new Uint8Array(await archivo.arrayBuffer());
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Fin del directorio central: firma 0x06054b50, buscada desde el final.
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { fin = i; break; }
  if (fin < 0) throw new Error("No es un archivo ZIP válido.");
  const total = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const salida = [];
  for (let n = 0; n < total; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP dañado.");
    const metodo = v.getUint16(p + 10, true), tam = v.getUint32(p + 20, true);
    const largoNombre = v.getUint16(p + 28, true), largoExtra = v.getUint16(p + 30, true), largoComent = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nombre = dec.decode(buf.subarray(p + 46, p + 46 + largoNombre));
    p += 46 + largoNombre + largoExtra + largoComent;
    if (nombre.endsWith("/")) continue;
    const ini = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const crudo = buf.subarray(ini, ini + tam);
    let datos;
    if (metodo === 0) datos = crudo;
    else if (metodo === 8) datos = new Uint8Array(await new Response(new Blob([crudo]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else continue;   // compresiones raras: se ignoran
    salida.push({ nombre, datos });
  }
  return salida;
}

/** Texto de un XML respetando su "encoding" (UTF-8 o ISO-8859-1). */
export function textoXml(bytes) {
  const cabeza = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const cod = /encoding=["']([^"']+)/i.exec(cabeza)?.[1]?.toLowerCase() || "utf-8";
  const t = new TextDecoder(/8859|latin/.test(cod) ? "latin1" : "utf-8").decode(bytes);
  return t.replace(/^﻿/, "");
}

/** Primera hoja de un .xlsx: filas como arreglos de texto (las fórmulas, con su texto "=..."). */
export async function leerXlsx(archivo) {
  const entradas = Object.fromEntries((await leerZip(archivo)).map((e) => [e.nombre.replace(/^\//, ""), e.datos]));
  const xml = (n) => (entradas[n] ? new DOMParser().parseFromString(textoXml(entradas[n]), "application/xml") : null);
  const compartidos = [...(xml("xl/sharedStrings.xml")?.getElementsByTagName("si") || [])]
    .map((si) => [...si.getElementsByTagName("t")].map((t) => t.textContent).join(""));
  const rels = xml("xl/_rels/workbook.xml.rels");
  const primera = xml("xl/workbook.xml")?.getElementsByTagName("sheet")[0];
  const rid = primera?.getAttribute("r:id") || primera?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const destino = [...(rels?.getElementsByTagName("Relationship") || [])].find((r) => r.getAttribute("Id") === rid)?.getAttribute("Target");
  const hoja = xml(destino ? `xl/${destino.replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml");
  if (!hoja) throw new Error("El Excel no tiene hojas.");
  const col = (ref) => [...ref.replace(/\d+/g, "")].reduce((s, c) => s * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return [...hoja.getElementsByTagName("row")].map((fila) => {
    const valores = [];
    for (const c of fila.getElementsByTagName("c")) {
      const tipo = c.getAttribute("t"), v = c.getElementsByTagName("v")[0]?.textContent, f = c.getElementsByTagName("f")[0]?.textContent;
      let texto = "";
      if (tipo === "s") texto = compartidos[Number(v)] ?? "";
      else if (tipo === "inlineStr") texto = [...c.getElementsByTagName("t")].map((t) => t.textContent).join("");
      else if (f) texto = f.startsWith("=") ? f : `=${f}`;
      else texto = v ?? "";
      valores[col(c.getAttribute("r"))] = texto;
    }
    return Array.from(valores, (x) => x ?? "");
  });
}

/* ── Escribir .xlsx ─────────────────────────────────────────────── */
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = TABLA_CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Zip sin comprimir (método 0): suficiente para un .xlsx y lo abre cualquier Excel. */
function crearZip(archivos) {
  const enc = new TextEncoder(), partes = [], central = [];
  let pos = 0;
  for (const [nombre, texto] of archivos) {
    const n = enc.encode(nombre), d = enc.encode(texto), crc = crc32(d);
    const cab = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0, 2], [14, crc, 4], [18, d.length, 4], [22, d.length, 4], [26, n.length, 2], [28, 0, 2]]
      .forEach(([o, val, l]) => (l === 4 ? cab.setUint32(o, val, true) : cab.setUint16(o, val, true)));
    const cen = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0, 2], [16, crc, 4], [20, d.length, 4], [24, d.length, 4], [28, n.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, pos, 4]]
      .forEach(([o, val, l]) => (l === 4 ? cen.setUint32(o, val, true) : cen.setUint16(o, val, true)));
    partes.push(new Uint8Array(cab.buffer), n, d);
    central.push(new Uint8Array(cen.buffer), n);
    pos += 30 + n.length + d.length;
  }
  const largoCentral = central.reduce((s, x) => s + x.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, archivos.length, 2], [10, archivos.length, 2], [12, largoCentral, 4], [16, pos, 4], [20, 0, 2]]
    .forEach(([o, val, l]) => (l === 4 ? fin.setUint32(o, val, true) : fin.setUint16(o, val, true)));
  return new Blob([...partes, ...central, new Uint8Array(fin.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const letra = (i) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/**
 * Descarga un .xlsx de una hoja. columnas: [{ titulo, ancho }]; filas: arreglos de valores
 * (número → celda numérica; { enlace, texto } → HIPERVÍNCULO; lo demás → texto).
 * colorEncabezado: ARGB, p. ej. "FFEA7203" (naranja, como el Excel de Gosocket).
 */
export function descargarXlsx(nombreArchivo, nombreHoja, columnas, filas, { colorEncabezado = "FF0B1F3A" } = {}) {
  const celda = (v, ref, estilo) => {
    if (v === null || v === undefined || v === "") return `<c r="${ref}" s="${estilo}"/>`;
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" s="${estilo}"><v>${v}</v></c>`;
    if (typeof v === "object" && v.enlace) {
      const f = `HYPERLINK("${String(v.enlace).replace(/"/g, '""')}","${String(v.texto || v.enlace).replace(/"/g, '""')}")`;
      return `<c r="${ref}" s="2" t="str"><f>${xmlEsc(f)}</f><v>${xmlEsc(v.texto || v.enlace)}</v></c>`;
    }
    return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const ultimo = `${letra(columnas.length - 1)}${filas.length + 1}`;
  const hoja = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${ultimo}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columnas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.ancho || 15}" customWidth="1"/>`).join("")}</cols>
<sheetData>
<row r="1">${columnas.map((c, i) => celda(c.titulo, `${letra(i)}1`, 1)).join("")}</row>
${filas.map((f, r) => `<row r="${r + 2}">${columnas.map((_, i) => celda(f[i], `${letra(i)}${r + 2}`, 0)).join("")}</row>`).join("\n")}
</sheetData>
<autoFilter ref="A1:${ultimo}"/>
</worksheet>`;
  const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="10"/><color rgb="FF0000FF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="${colorEncabezado}"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const blob = crearZip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(nombreHoja).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(nombreHoja).slice(0, 31)}'!$A$1:$${ultimo.replace(/(\d+)$/, "$$$1")}</definedName></definedNames></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", estilos],
    ["xl/worksheets/sheet1.xml", hoja],
  ]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nombreArchivo;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
