/* ══════════════════════════════════════════════════════════════════
   PAGINACIÓN EN EL SERVIDOR (obligatoria en toda lista que se lee de
   Firestore): se pide solo la página visible (orden + limit + startAfter)
   y el total —y las sumas que se pidan— con una consulta de agregación
   (count/sum), que Firebase calcula sin descargar los documentos.

   Uso:
     const ps = paginaServidor({
       clave: "adm-pagos", etiqueta: "facturas", barra: elBarra,
       consulta: () => ({ col, filtros: [where(...)], orden: [orderBy(...)] }),
       agregados: { neto: sum("neto") },                 // opcional
       pintar: (docs, st) => { ... st.total, st.agg.neto ... },
       alError: (err) => { ... },
     });
     ps.cargar(true);   // desde la página 1 (al cambiar filtros)
     ps.recargar();     // la misma página, volviendo a contar (tras editar)
   ══════════════════════════════════════════════════════════════════ */
import { query, getDocs, limit, startAfter, getAggregateFromServer, count } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { htmlPagina, leerTam, guardarTam } from "./util.js";

/** Firestore acepta como máximo 5 cálculos (count/sum/average) por consulta de agregación:
    se reparten en tandas de 5 y se juntan los resultados. */
export async function agregar(q, specs) {
  const pares = Object.entries(specs), tandas = [];
  for (let i = 0; i < pares.length; i += 5) tandas.push(Object.fromEntries(pares.slice(i, i + 5)));
  const res = await Promise.all(tandas.map((t) => getAggregateFromServer(q, t)));
  return Object.assign({}, ...res.map((r) => r.data()));
}

export function paginaServidor({ clave, etiqueta = "registros", barra, consulta, agregados = {}, pintar, alError }) {
  const st = { pagina: 1, tam: leerTam(clave) || 25, cursores: [null], total: 0, agg: {}, docs: [], pedido: 0, vivo: true, inicio: 0 };

  async function cargar(reiniciar = false, recontar = reiniciar) {
    const n = ++st.pedido;
    if (reiniciar) { st.pagina = 1; st.cursores = [null]; }
    const c = consulta();
    if (!c) return;
    const cursor = st.cursores[st.pagina - 1];
    try {
      const base = query(c.col, ...c.filtros);
      // El conteo va aparte de las sumas: si una suma falla (p. ej. un índice que Firebase aún está
      // creando), la tabla y el total de registros se muestran igual y las sumas salen "—".
      const [snap, cuenta, sumas] = await Promise.all([
        getDocs(query(c.col, ...c.filtros, ...c.orden, ...(cursor ? [startAfter(cursor)] : []), limit(st.tam))),
        recontar ? agregar(base, { total: count() }) : null,
        recontar && Object.keys(agregados).length
          ? agregar(base, agregados).catch((err) => { console.warn("Portal: no se pudieron calcular las sumas", err); return null; })
          : null,
      ]);
      if (!st.vivo || n !== st.pedido) return;
      if (cuenta) { st.total = cuenta.total; st.sumasOk = !!sumas || !Object.keys(agregados).length; st.agg = { total: cuenta.total, ...(sumas || {}) }; }
      // Si la página quedó vacía (se borró lo último), retrocede una.
      if (!snap.docs.length && st.pagina > 1) { st.pagina--; return cargar(false, false); }
      st.docs = snap.docs;
      st.inicio = (st.pagina - 1) * st.tam;
      st.cursores[st.pagina] = snap.docs[snap.docs.length - 1] || null;
      const paginas = Math.max(1, Math.ceil(st.total / st.tam));
      const desde = st.total ? st.inicio + 1 : 0;
      barra.innerHTML = htmlPagina({ pagina: st.pagina, paginas, total: st.total, desde,
        hasta: Math.min(st.inicio + snap.docs.length, st.total), tam: st.tam, saltos: false, etiqueta });
      pintar(snap.docs, st);
    } catch (err) {
      if (n === st.pedido && alError) alError(err);
    }
  }

  barra.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pag]");
    if (!b || b.disabled) return;
    st.pagina += b.dataset.pag === "siguiente" ? 1 : -1;
    cargar(false);
  });
  barra.addEventListener("change", (e) => {
    if (!e.target.matches("[data-tam]")) return;
    st.tam = Number(e.target.value);
    guardarTam(clave, st.tam);
    cargar(true);
  });

  return { cargar, recargar: () => cargar(false, true), estado: st, detener() { st.vivo = false; } };
}
