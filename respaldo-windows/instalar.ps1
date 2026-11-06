# ==================================================================
# Instalador del RESPALDO DIARIO del Portal de Proveedores en un servidor Windows.
# (Windows Server 2016+ o Windows 10+; PowerShell 5.1 o superior.)
#
# Uso, en PowerShell abierto "Como administrador", una sola linea:
#   irm https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/respaldo-windows/instalar.ps1 | iex
# o doble clic en instalar.bat (si se bajo la carpeta respaldo-windows).
#
# Hace, en este orden:
#   1. Pregunta el proyecto, la carpeta de destino, la llave de solo lectura y la hora.
#   2. Instala Node.js 22 si no esta (descarga oficial de nodejs.org, instalacion silenciosa).
#   3. Copia el programa a C:\ProgramData\PortalProveedoresRespaldo (solo Administradores y SYSTEM lo leen).
#   4. Crea la tarea "Portal de Proveedores - Respaldo diario" (cuenta SYSTEM, todos los dias a la hora
#      elegida; si el servidor estaba apagado, corre apenas prenda).
#   5. Hace el primer respaldo en ese momento.
# Volver a correrlo es seguro: actualiza el programa y la tarea, no borra respaldos.
# (Sin tildes a proposito: asi se ve bien en cualquier consola de Windows.)
# ==================================================================

function Instalar-RespaldoPortal {
  $ErrorActionPreference = "Stop"
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo  = "https://raw.githubusercontent.com/leidercostoshotel-code/PagoProveedores/main/respaldo-windows"
  $App   = Join-Path $env:ProgramData "PortalProveedoresRespaldo"
  $Tarea = "Portal de Proveedores - Respaldo diario"
  $NodeVersion = "22.11.0"

  Write-Host ""
  Write-Host "=== Respaldo diario del Portal de Proveedores ===" -ForegroundColor Cyan

  # --- Administrador ---------------------------------------------------------------------------
  $yo = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $yo.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Abre PowerShell con clic derecho > 'Ejecutar como administrador' y vuelve a correr el comando." -ForegroundColor Red
    return
  }

  # --- 1. Datos ----------------------------------------------------------------------------------
  $proyecto = Read-Host "ID del proyecto de Firebase [portal-proveedores-70bc4]"
  if (-not $proyecto) { $proyecto = "portal-proveedores-70bc4" }

  $porDefecto = if (Test-Path "D:\") { "D:\Respaldos\PortalProveedores" } else { "C:\Respaldos\PortalProveedores" }
  $destino = Read-Host "Carpeta donde se guardan los respaldos [$porDefecto]"
  if (-not $destino) { $destino = $porDefecto }
  if ($destino.StartsWith("\\")) {
    Write-Host "Aviso: la tarea corre como SYSTEM y una carpeta de red (\\servidor\...) puede no estar accesible. Mejor un disco local." -ForegroundColor Yellow
  }

  # La llave descargada de Cloud Shell (llave-respaldo-portal.json); se busca sola en Descargas.
  $sugerida = Get-ChildItem -Path (Join-Path $env:USERPROFILE "Downloads") -Filter "llave-respaldo-portal*.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $sugeridaRuta = if ($sugerida) { $sugerida.FullName } else { "" }
  $llave = Read-Host "Ruta de la llave de solo lectura (.json) [$sugeridaRuta]"
  if (-not $llave) { $llave = $sugeridaRuta }
  $llave = $llave.Trim('"')
  if (-not $llave -or -not (Test-Path $llave)) { Write-Host "No encuentro la llave: $llave" -ForegroundColor Red; return }
  try { $k = Get-Content $llave -Raw | ConvertFrom-Json } catch { Write-Host "La llave no es un JSON valido." -ForegroundColor Red; return }
  if ($k.type -ne "service_account" -or -not $k.client_email -or -not $k.private_key) {
    Write-Host "Ese archivo no es una llave de cuenta de servicio de Google." -ForegroundColor Red; return
  }
  if ($k.project_id -and $k.project_id -ne $proyecto) {
    Write-Host "Aviso: la llave es del proyecto '$($k.project_id)', no de '$proyecto'." -ForegroundColor Yellow
  }

  $hora = Read-Host "Hora del respaldo diario, formato 24 h [02:00]"
  if (-not $hora) { $hora = "02:00" }
  if ($hora -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { Write-Host "Hora no valida: $hora (ejemplo: 02:00)" -ForegroundColor Red; return }

  # --- 2. Node.js --------------------------------------------------------------------------------
  function Buscar-Node {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $p) { return $p }
    return $null
  }
  $node = Buscar-Node
  $sirve = $false
  if ($node) {
    $v = & $node -v
    if ($v -match '^v(\d+)\.(\d+)') { $sirve = ([int]$Matches[1] -gt 20) -or ([int]$Matches[1] -eq 20 -and [int]$Matches[2] -ge 11) }
  }
  if (-not $sirve) {
    Write-Host "Instalando Node.js $NodeVersion (necesario para el respaldo)..."
    $msi = Join-Path $env:TEMP "node-v$NodeVersion-x64.msi"
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-x64.msi" -OutFile $msi -UseBasicParsing
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Write-Host "No se pudo instalar Node.js (codigo $($p.ExitCode))." -ForegroundColor Red; return }
    $node = Join-Path $env:ProgramFiles "nodejs\node.exe"
  }
  Write-Host "Node.js: $node ($(& $node -v))"

  # --- 3. Programa, llave y configuracion ----------------------------------------------------------
  New-Item -ItemType Directory -Force -Path $App | Out-Null
  # Antes de copiar nada: solo Administradores y SYSTEM pueden leer la carpeta del programa (por la llave).
  # Por SID, asi sirve en Windows en espanol ("Administradores") o en ingles.
  & icacls.exe $App /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /Q | Out-Null
  New-Item -ItemType Directory -Force -Path $destino | Out-Null
  foreach ($f in "comun.mjs", "respaldo.mjs", "restaurar.mjs") {
    $junto = if ($PSScriptRoot) { Join-Path $PSScriptRoot $f } else { "" }
    if ($junto -and (Test-Path $junto)) { Copy-Item $junto (Join-Path $App $f) -Force }
    else { Invoke-WebRequest "$Repo/$f" -OutFile (Join-Path $App $f) -UseBasicParsing }
  }
  $llaveApp = Join-Path $App "llave.json"
  if ((Resolve-Path $llave).Path -ne $llaveApp) { Copy-Item $llave $llaveApp -Force }
  $config = [ordered]@{ proyecto = $proyecto; destino = $destino; llave = $llaveApp } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $App "config.json"), $config)   # UTF-8 sin BOM


  # --- 4. Tarea programada -----------------------------------------------------------------------
  $accion = New-ScheduledTaskAction -Execute $node -Argument "`"$App\respaldo.mjs`" `"$App\config.json`"" -WorkingDirectory $App
  $cuando = New-ScheduledTaskTrigger -Daily -At $hora
  $quien  = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger $cuando -Principal $quien -Settings $ajustes `
    -Description "Copia diaria del Portal de Proveedores (Firebase $proyecto) en $destino. Nunca borra respaldos." -Force | Out-Null
  Write-Host "Tarea programada creada: '$Tarea', todos los dias a las $hora."

  # --- 5. Primer respaldo --------------------------------------------------------------------------
  Write-Host "Haciendo el primer respaldo (puede tardar unos minutos)..."
  & $node "$App\respaldo.mjs" "$App\config.json"
  if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Listo. Los respaldos quedan en $destino (registro.log dice como fue cada noche)." -ForegroundColor Green
  } else {
    Write-Host "El primer respaldo fallo: revisa el mensaje de arriba y $destino\registro.log." -ForegroundColor Red
    Write-Host "La tarea programada si quedo creada; cuando se corrija, puedes probar con: schtasks /run /tn `"$Tarea`""
  }

  if ((Resolve-Path $llave).Path -ne $llaveApp) {
    $borrar = Read-Host "La llave ya quedo guardada en un lugar protegido. Borrar la copia de $llave ? (S/N) [S]"
    if ($borrar -ne "N" -and $borrar -ne "n") { Remove-Item $llave -Force; Write-Host "Copia de la llave borrada." }
  }
}

Instalar-RespaldoPortal
