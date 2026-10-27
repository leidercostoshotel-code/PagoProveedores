/* Roles del portal (campo "rol" en usuarios/{uid}). Las reglas de
   Firestore (firestore.rules) usan exactamente estos mismos id. */
export const ROLES = [
  { id: "admin", etiqueta: "Administrador", interno: true, detalle: "Todo: pagos, carga de lotes, proveedores y usuarios internos." },
  { id: "contabilidad", etiqueta: "Contabilidad", interno: true, detalle: "Ve todos los pagos, carga y elimina lotes, crea y gestiona proveedores." },
  { id: "consulta", etiqueta: "Consulta", interno: true, detalle: "Solo ve los pagos, lotes y proveedores; no edita nada." },
  { id: "proveedor", etiqueta: "Proveedor", interno: false, detalle: "Solo ve sus propios pagos (los de su RUC)." },
];
export const ROLES_INTERNOS = ROLES.filter((r) => r.interno);
export const etiquetaRol = (id) => ROLES.find((r) => r.id === id)?.etiqueta || id || "Sin rol";
export const esInterno = (rol) => ROLES_INTERNOS.some((r) => r.id === rol);
export const puedeGestionar = (rol) => rol === "admin" || rol === "contabilidad";
