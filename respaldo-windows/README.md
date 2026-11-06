# Respaldo diario del Portal de Proveedores en el servidor del hotel (Windows)

Cada noche, el servidor del hotel guarda una copia completa del portal. **Nunca borra nada.** Si algún día
Firebase falla, los datos y los XML/PDF están en el servidor y se pueden restaurar en un proyecto nuevo.

## Qué queda en la carpeta de respaldos (por ejemplo `D:\Respaldos\PortalProveedores`)

| Carpeta / archivo | Qué es |
|---|---|
| `datos\AAAA-MM-DD_HHMM\` | Copia completa de esa noche (usuarios, pagos, lotes, comprobantes, retenciones), comprimida. Una carpeta por noche, para siempre. Es lo que se usa para restaurar. |
| `excel\` | Lo más reciente en Excel (`pagos.xlsx`, `comprobantes.xlsx`, `retenciones.xlsx`, `usuarios.xlsx`, `lotes.xlsx`), para consultar sin el portal. |
| `archivos\comprobantes\<RUC> <razón social>\<AAAA-MM>\` | XML y PDF de cada factura (nombre SUNAT: `RUC-01-F001-00000123.xml`). Solo se bajan los nuevos; si un comprobante cambia, la versión anterior se queda y la nueva va con la fecha. |
| `archivos\retenciones\…` | Lo mismo para los comprobantes de retención. |
| `registro.log` | Una línea por noche: `OK …` con cuántos documentos, o `ERROR …` con el motivo. |

## Instalación (una sola vez, ~10 minutos)

**1. Crear la llave de solo lectura** (en https://shell.cloud.google.com con la cuenta dueña del proyecto):

```
bash <(curl -fsSL https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/scripts/desplegar-cloudshell.sh) portal-proveedores-70bc4 llave-respaldo
```

Descarga el archivo `llave-respaldo-portal.json` (se ofrece solo; si no, menú ⋮ → Descargar) y pásalo al servidor.
Esa llave **solo puede leer**: no puede cambiar ni borrar nada del portal. Después, en Cloud Shell: `rm ~/llave-respaldo-portal.json`.

**2. En el servidor**, abre **PowerShell como administrador** (clic derecho → Ejecutar como administrador) y pega:

```
irm https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/respaldo-windows/instalar.ps1 | iex
```

(O, si bajaste esta carpeta, doble clic en `instalar.bat`.) Te pregunta el proyecto, la carpeta de destino, la llave
(la busca sola en Descargas) y la hora (02:00 por defecto). Instala Node.js si falta, crea la tarea programada
**"Portal de Proveedores - Respaldo diario"** (cuenta SYSTEM; si el servidor estaba apagado a esa hora, corre al prender)
y hace el primer respaldo en ese momento. Volver a correrlo es seguro: actualiza el programa, no borra respaldos.

## Uso diario

- No hay que hacer nada. Para revisar: abre `registro.log`.
- Respaldo a mano: `schtasks /run /tn "Portal de Proveedores - Respaldo diario"`.
- El programa y la llave están en `C:\ProgramData\PortalProveedoresRespaldo` (solo Administradores y SYSTEM pueden leerla).
- Si el servidor sale a internet por un proxy, avísanos: Node.js necesita configurarlo aparte.

## Restaurar (solo en una emergencia)

1. Crea un proyecto de Firebase nuevo (o usa el mismo) y publica el portal con `desplegar-cloudshell.sh … hosting reglas`.
2. Crea una llave **con permiso de escritura** solo para esto (Google Cloud → IAM → Cuentas de servicio → crear, rol
   **Cloud Datastore User** → Claves → Agregar clave → JSON).
3. En el servidor, en PowerShell como administrador:
   ```
   & "C:\Program Files\nodejs\node.exe" C:\ProgramData\PortalProveedoresRespaldo\restaurar.mjs D:\Respaldos\PortalProveedores\datos\<fecha> <ID del proyecto> C:\ruta\llave-escritura.json
   ```
   Muestra cuántos documentos hay y pide escribir `RESTAURAR`. Vuelve a subir también los XML y PDF.
4. Borra la llave de escritura cuando termines.
5. Las cuentas de acceso no están en la base: los proveedores se recrean con `scripts/importar-proveedores.sh`
   (su clave es su RUC) y el personal del hotel desde Administración → Usuarios.
