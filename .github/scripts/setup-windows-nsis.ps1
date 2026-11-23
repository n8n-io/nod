$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Use a disposable GitHub Windows runner.'
}
$installer = Join-Path $env:RUNNER_TEMP 'nsis-3.13-setup.exe'
Invoke-WebRequest -Uri 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13-setup.exe' -OutFile $installer -MaximumRetryCount 3 -RetryIntervalSec 5 -TimeoutSec 120
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne 'DB9A1038BBC0E53FEF24F423FD609979BD578E942F1BE1198DB186D1C42652A3') {
  throw 'The NSIS installer failed its SHA-256 check.'
}
$destination = Join-Path $env:RUNNER_TEMP 'nsis-3.13'
$install = Start-Process -FilePath $installer -ArgumentList "/S /D=$destination" -PassThru
if (-not $install.WaitForExit(120000)) {
  Stop-Process -Id $install.Id -Force -ErrorAction SilentlyContinue
  throw 'NSIS installation did not finish within two minutes.'
}
if ($install.ExitCode -ne 0) { throw "NSIS installation failed with code $($install.ExitCode)." }
$compiler = Join-Path $destination 'makensis.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The NSIS compiler was not installed.' }
$version = & $compiler /VERSION
if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne 'v3.13') { throw "The NSIS version check failed with code $LASTEXITCODE and version $version." }
"NOD_NSIS=$compiler" | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8
Write-Output 'NSIS 3.13 is ready. Its installer passed the SHA-256 check.'
