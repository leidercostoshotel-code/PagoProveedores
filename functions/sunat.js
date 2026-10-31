/**
 * Consulta integrada de validez de comprobantes de pago — API de SUNAT (gratuita).
 * Credenciales: SUNAT Operaciones en Línea (Clave SOL del hotel) → Empresas → Credenciales de API SUNAT.
 * Se guardan como secretos de Firebase: SUNAT_CLIENT_ID y SUNAT_CLIENT_SECRET (nunca en el código).
 *
 *   Token:     POST https://api-seguridad.sunat.gob.pe/v1/clientesextranet/{client_id}/oauth2/token/
 *   Consulta:  POST https://api.sunat.gob.pe/v1/contribuyente/contribuyentes/{rucConsultante}/validarcomprobante
 *              { numRuc, codComp, numeroSerie, numero, fechaEmision: "dd/mm/aaaa", monto }
 *   Respuesta: data.estadoCp → 0 NO EXISTE · 1 ACEPTADO · 2 ANULADO · 3 AUTORIZADO · 4 NO AUTORIZADO
 */
const ESTADOS_CP = { 0: "NO EXISTE", 1: "ACEPTADO", 2: "ANULADO", 3: "AUTORIZADO", 4: "NO AUTORIZADO" };
const ESTADOS_RUC = { "00": "ACTIVO", "01": "BAJA PROVISIONAL", "02": "BAJA PROV. POR OFICIO", "03": "SUSPENSION TEMPORAL",
  10: "BAJA DEFINITIVA", 11: "BAJA DE OFICIO", 22: "INHABILITADO-VENT.UNICA" };
const CONDICION = { "00": "HABIDO", "09": "PENDIENTE", 11: "POR VERIFICAR", 12: "NO HABIDO", 20: "NO HALLADO" };

let token = null, venceToken = 0;

async function obtenerToken(clientId, clientSecret) {
  if (token && Date.now() < venceToken - 60000) return token;
  const r = await fetch(`https://api-seguridad.sunat.gob.pe/v1/clientesextranet/${encodeURIComponent(clientId)}/oauth2/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.sunat.gob.pe/v1/contribuyente/contribuyentes",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const e = new Error(`SUNAT no dio el token (${r.status}): ${j.error_description || j.error || "credenciales no válidas"}`);
    e.credenciales = r.status === 400 || r.status === 401;
    throw e;
  }
  token = j.access_token;
  venceToken = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return token;
}

const ddmmaaaa = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Valida un comprobante (documento de "comprobantes"). Devuelve { estado, detalle } o lanza en errores de red/servicio.
 * El hotel consulta con su propio RUC (rucConsultante).
 */
async function validarComprobante(c, { clientId, clientSecret, rucConsultante }) {
  const pedir = async (t) => fetch(`https://api.sunat.gob.pe/v1/contribuyente/contribuyentes/${rucConsultante}/validarcomprobante`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: JSON.stringify({
      numRuc: c.ruc, codComp: c.tipo, numeroSerie: c.serie, numero: String(c.numero),
      fechaEmision: ddmmaaaa(c.fechaEmision), monto: (Number(c.total) || 0).toFixed(2),
    }),
  });
  let r = await pedir(await obtenerToken(clientId, clientSecret));
  if (r.status === 401) { token = null; r = await pedir(await obtenerToken(clientId, clientSecret)); }   // token vencido
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success || !j.data) throw new Error(`SUNAT respondió ${r.status}: ${j.message || "sin datos"}`);
  const d = j.data;
  const estado = ESTADOS_CP[Number(d.estadoCp)] || `ESTADO ${d.estadoCp}`;
  const partes = [];
  if (d.estadoRuc && d.estadoRuc !== "00") partes.push(`RUC del emisor: ${ESTADOS_RUC[d.estadoRuc] || d.estadoRuc}`);
  if (d.condDomiRuc && d.condDomiRuc !== "00") partes.push(`domicilio: ${CONDICION[d.condDomiRuc] || d.condDomiRuc}`);
  if (Array.isArray(d.observaciones)) partes.push(...d.observaciones.map(String).filter((o) => o.trim().length > 1));
  return { estado, detalle: partes.join(" · ").slice(0, 300) };
}

module.exports = { validarComprobante };
