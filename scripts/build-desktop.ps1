param([ValidateSet('all', 'setup', 'portable', 'dir')][string]$Target = 'all')
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$taskRoot = Split-Path $PSScriptRoot -Parent
$buildPython = Join-Path $taskRoot 'backend\.venv-build\Scripts\python.exe'
$stageRoot = [IO.Path]::GetFullPath((Join-Path $taskRoot 'build\workspace'))
$stageFrontend = Join-Path $stageRoot 'frontend'
$desktopTools = Join-Path $taskRoot 'build\desktop-tools'

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Ошибка команды: $Program $($Arguments -join ' ')" }
}

Push-Location $taskRoot
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot 'build') | Out-Null
    try {
        $buildLock = [IO.File]::Open((Join-Path $taskRoot 'build\desktop-build.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch {
        throw 'Уже выполняется другая сборка EXE. Дождитесь её завершения и повторите запуск.'
    }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Нужна 64-разрядная Windows.' }
    $nodeVersion = & node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') { throw 'Нужен Node.js 24.' }
    if (-not (Test-Path -LiteralPath $buildPython)) {
        Invoke-Checked 'py' @('-3.12', '-m', 'venv', (Join-Path $taskRoot 'backend\.venv-build'))
    }
    Invoke-Checked $buildPython @('-c', "import sys, struct; assert sys.version_info[:2] == (3, 12) and struct.calcsize('P') == 8")
    Write-Host 'Установка зависимостей сборки...' -ForegroundColor Cyan
    Invoke-Checked $buildPython @('-m', 'pip', 'install', '-r', 'backend/requirements-build.txt', '--disable-pip-version-check')
    Invoke-Checked $buildPython @('-m', 'pip', 'check')
    # Запущенный Electron из исходников удерживает DLL в корневом node_modules.
    # Инструменты упаковки устанавливаем отдельно, как и зависимости фронтенда.
    New-Item -ItemType Directory -Force -Path $desktopTools | Out-Null
    foreach ($name in @('package.json', 'package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path $taskRoot $name) -Destination $desktopTools
    }
    Invoke-Checked 'npm.cmd' @('--prefix', $desktopTools, 'ci', '--no-audit', '--no-fund')

    Write-Host 'Проверки и актуализация контракта...' -ForegroundColor Cyan
    Invoke-Checked $buildPython @('-m', 'ruff', 'check', 'backend')
    Invoke-Checked $buildPython @('-m', 'ruff', 'format', '--check', 'backend')
    Invoke-Checked $buildPython @('-m', 'pytest', 'backend/tests', '-q')
    Invoke-Checked $buildPython @('backend/scripts/export_contract.py')
    # Копия исходников позволяет собирать EXE при работающем Vite и не трогать его node_modules.
    $buildRoot = [IO.Path]::GetFullPath((Join-Path $taskRoot 'build'))
    if (-not $stageRoot.StartsWith($buildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Каталог временной сборки должен находиться внутри build.'
    }
    if (Test-Path -LiteralPath $stageRoot) {
        if ((Get-Item -LiteralPath $stageRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Каталог временной сборки не должен быть ссылкой.'
        }
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $stageFrontend | Out-Null
    foreach ($name in @('src', 'public', 'scripts', 'package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json')) {
        Copy-Item -LiteralPath (Join-Path $taskRoot "frontend\$name") -Destination $stageFrontend -Recurse
    }
    foreach ($name in @('contract', 'fixtures')) {
        Copy-Item -LiteralPath (Join-Path $taskRoot $name) -Destination $stageRoot -Recurse
    }
    Invoke-Checked 'npm.cmd' @('--prefix', $stageFrontend, 'ci', '--no-audit', '--no-fund')
    Invoke-Checked 'npm.cmd' @('--prefix', $stageFrontend, 'run', 'generate:contract')
    Copy-Item -LiteralPath (Join-Path $stageRoot 'contract\api-types.ts') -Destination (Join-Path $taskRoot 'contract\api-types.ts')
    Invoke-Checked 'npm.cmd' @('run', 'test:desktop')
    Invoke-Checked 'npm.cmd' @('--prefix', $stageFrontend, 'run', 'test:unit')

    Write-Host 'Сборка актуального интерфейса и Python...' -ForegroundColor Cyan
    Invoke-Checked 'npm.cmd' @('--prefix', $stageFrontend, 'run', 'build')
    Invoke-Checked $buildPython @('scripts/prepare-icon.py')
    Invoke-Checked $buildPython @('-m', 'PyInstaller', '--clean', '--noconfirm', '--distpath', 'build/backend', '--workpath', 'build/pyinstaller', 'desktop/backend.spec')
    Invoke-Checked 'node' @('scripts/smoke-backend.cjs')

    Write-Host 'Упаковка приложения Windows...' -ForegroundColor Cyan
    $builder = Join-Path $desktopTools 'node_modules\.bin\electron-builder.cmd'
    $builderArgs = @('--win', '--x64', '--publish', 'never')
    if ($Target -eq 'dir') { $builderArgs += '--dir' }
    elseif ($Target -eq 'setup') { $builderArgs = @('--win', 'nsis', '--x64', '--publish', 'never') }
    elseif ($Target -eq 'portable') { $builderArgs = @('--win', 'portable', '--x64', '--publish', 'never') }
    $electronVersion = (Get-Content -LiteralPath (Join-Path $desktopTools 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
    $electronDist = Join-Path $desktopTools 'node_modules\electron\dist'
    $builderArgs += @('--projectDir', $taskRoot, "--config.electronVersion=$electronVersion", "--config.electronDist=$electronDist")
    Invoke-Checked $builder $builderArgs
    Invoke-Checked 'node' @('scripts/smoke-desktop.cjs')
    Invoke-Checked 'node' @('scripts/smoke-desktop.cjs', '--portable-runtime')
    if ($Target -in @('all', 'portable')) {
        Invoke-Checked 'node' @('scripts/smoke-portable.cjs')
    }
    Invoke-Checked 'node' @('scripts/build-info.cjs', $Target)
    Write-Host "Готово. Результат: $taskRoot\release" -ForegroundColor Green
} catch {
    Write-Host "Сборка остановлена: $_" -ForegroundColor Red
    exit 1
} finally {
    if ($buildLock) { $buildLock.Dispose() }
    Pop-Location
}
