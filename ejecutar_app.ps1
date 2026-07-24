$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundledPython = "C:\Users\WILLIAMFERNANDOCABAR\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$PythonArgs = @()

if (Test-Path -LiteralPath $BundledPython) {
  $Python = $BundledPython
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $Python = (Get-Command py).Source
  $PythonArgs = @("-3")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $Python = (Get-Command python).Source
} else {
  throw "No se encontró Python 3.11 o superior. Instálalo y marca Add Python to PATH."
}

& $Python @PythonArgs -c "import openpyxl, pypdf" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Instalando dependencias de Excel y PDF..."
  & $Python @PythonArgs -m pip install -r "$AppDir\requirements.txt"
  if ($LASTEXITCODE -ne 0) {
    throw "No fue posible instalar las dependencias de la aplicacion."
  }
}

$env:RENAL_HOST = "127.0.0.1"
$env:RENAL_PORT = "8780"
Start-Process "http://127.0.0.1:8780/"
& $Python @PythonArgs "$AppDir\run.py"
