param([switch]$Dev, [switch]$NoBrowser, [switch]$Public)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$taskRoot = Split-Path $PSScriptRoot -Parent
$python = Join-Path $taskRoot 'backend\.venv\Scripts\python.exe'
function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Команда завершилась с ошибкой: $Program" }
}
function Get-InputsHash {
    param([string[]]$Paths)
    $hashes = foreach ($path in ($Paths | Sort-Object)) {
        "$path $((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)"
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($hashes -join "`n"))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
    finally { $sha.Dispose() }
}
try {
    if (-not (Test-Path -LiteralPath $python)) {
        $venvDir = Join-Path $taskRoot 'backend\.venv'
        $base = $null
        foreach ($candidate in @('py -3.12', 'py -3.13', 'python', 'python3')) {
            $parts = $candidate -split ' '
            if (-not (Get-Command $parts[0] -ErrorAction SilentlyContinue)) { continue }
            $extra = @($parts | Select-Object -Skip 1)
            try { $version = & $parts[0] @extra -c 'import sys; print(*sys.version_info[:2], sep=chr(46))' 2>$null }
            catch { continue }
            if ($LASTEXITCODE -eq 0 -and $version -in @('3.12', '3.13')) { $base = $parts; break }
        }
        if (-not $base) { throw 'Нужен Python 3.12 или 3.13: https://www.python.org/downloads/' }
        Invoke-Checked $base[0] (@($base | Select-Object -Skip 1) + @('-m', 'venv', $venvDir))
    }
    if (-not (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue)) { throw 'Нужен Node.js 22 или новее: https://nodejs.org/' }
    $requirements = Join-Path $taskRoot 'backend\requirements.txt'
    $reqHash = Get-InputsHash @($requirements)
    $reqStamp = Join-Path $taskRoot 'backend\.venv\requirements.sha256'
    if (-not (Test-Path $reqStamp) -or (Get-Content $reqStamp -Raw).Trim() -ne $reqHash) {
        Invoke-Checked $python @('-m', 'pip', 'install', '-r', $requirements)
        Set-Content -LiteralPath $reqStamp -Value $reqHash -Encoding utf8
    }
    Set-Location (Join-Path $taskRoot 'frontend')
    if (-not $Dev) {
        $inputs = @((Get-ChildItem src, public -Recurse -File -ErrorAction SilentlyContinue).FullName)
        $inputs += @((Get-ChildItem package.json, package-lock.json, index.html, vite.config.*, tsconfig*.json).FullName)
        $buildHash = Get-InputsHash $inputs
        $buildStamp = Join-Path $taskRoot 'frontend\dist\.build.sha256'
        if (-not (Test-Path $buildStamp) -or (Get-Content $buildStamp -Raw).Trim() -ne $buildHash) {
            Invoke-Checked 'npm.cmd' @('ci')
            Invoke-Checked 'npm.cmd' @('run', 'build')
            Set-Content -LiteralPath $buildStamp -Value $buildHash -Encoding utf8
        }
    } else {
        if (-not (Test-Path node_modules)) { Invoke-Checked 'npm.cmd' @('ci') }
        $vite = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev -- --host 127.0.0.1 --port 5180 --strictPort' -WorkingDirectory (Join-Path $taskRoot 'frontend') -WindowStyle Hidden -PassThru
    }
    if (-not $NoBrowser) {
        $url = if ($Dev) { 'http://127.0.0.1:5180' } else { 'http://127.0.0.1:8765' }
        $browserJob = Start-Job -ScriptBlock {
            param($url)
            for ($attempt = 0; $attempt -lt 120; $attempt++) {
                try {
                    $null = Invoke-RestMethod 'http://127.0.0.1:8765/api/health' -TimeoutSec 1
                    Start-Process $url
                    break
                } catch { Start-Sleep -Milliseconds 500 }
            }
        } -ArgumentList $url
    }
    if ($Public) {
        # Домен ngrok лежит в data/ (в git не попадает): одна строка вида name.ngrok-free.dev
        $domainFile = Join-Path $taskRoot 'data\ngrok-domain.txt'
        if (-not (Test-Path $domainFile)) { throw "Нет файла $domainFile с доменом ngrok" }
        $domain = (Get-Content $domainFile -Raw).Trim()
        if ($domain -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$') { throw 'Укажите только имя домена ngrok, без https:// и пути.' }
        $env:SS_PUBLIC_HOST = $domain.ToLowerInvariant()
        $ngrokLog = Join-Path $taskRoot 'data\logs\ngrok.log'
        New-Item -ItemType Directory -Force (Split-Path $ngrokLog) | Out-Null
        $ngrok = Start-Process -FilePath 'ngrok' -ArgumentList @('http', "--url=$domain", '--log', $ngrokLog, '8765') -WindowStyle Hidden -PassThru
        Write-Host "Игра доступна по ссылке: https://$domain" -ForegroundColor Green
    }
    Set-Location (Join-Path $taskRoot 'backend')
    $uvicornArgs = @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8765', '--loop', 'app.event_loop:loop_factory')
    if ($Dev) { $uvicornArgs += '--reload' }
    Invoke-Checked $python $uvicornArgs
} catch {
    Write-Host "Не удалось запустить Study Surfers: $_" -ForegroundColor Red
    exit 1
} finally {
    if ($vite -and -not $vite.HasExited) { & taskkill /PID $vite.Id /T /F | Out-Null }
    if ($ngrok -and -not $ngrok.HasExited) { Stop-Process -Id $ngrok.Id -Force }
    if ($browserJob) { Stop-Job $browserJob; Remove-Job $browserJob -Force }
}
