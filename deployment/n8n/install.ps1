& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $base = 'https://internal.users.n8n.cloud/webhook/nod/desktop'
  $files = [ordered]@{ installer = 'nod-Setup-x64.exe'; runtime = 'nod-Runtime-win32-x64.tar.gz' }

  $windows = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
  if (-not [Environment]::Is64BitOperatingSystem -or [int]$windows.CurrentBuildNumber -lt 22000) {
    throw 'nod requires 64-bit Windows 11.'
  }
  if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer in a normal PowerShell window, not as administrator.'
  }
  if (Get-Process -Name nod -ErrorAction SilentlyContinue) {
    throw 'Quit nod, then run this command again.'
  }

  $latest = Invoke-RestMethod -Uri "$base/releases?installer=true&platform=win32-x64" -UseBasicParsing
  $assets = "$base/releases/$($latest.releaseId)/assets/"
  if ($latest.schema -ne 1 -or "$($latest.version)" -notmatch '^\d+\.\d+\.\d+$' -or -not "$($latest.manifestUrl)".StartsWith($assets)) {
    throw 'The nod release metadata is invalid.'
  }
  foreach ($key in $files.Keys) {
    $entry = $latest.$key
    if (-not "$($entry.url)".StartsWith($assets) -or "$($entry.sha256)" -cnotmatch '^[a-f0-9]{64}$' -or [long]$entry.bytes -lt 1) {
      throw 'The nod release metadata is invalid.'
    }
  }
  $response = Invoke-WebRequest -Uri $latest.manifestUrl -UseBasicParsing
  $manifest = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
  if ($manifest.version -ne $latest.version -or $manifest.platform -ne 'win32-x64') {
    throw 'The nod release files do not match their metadata.'
  }
  foreach ($key in $files.Keys) {
    if ($manifest.$key.file -ne $files[$key] -or $manifest.$key.sha256 -ne $latest.$key.sha256 -or [long]$manifest.$key.bytes -ne [long]$latest.$key.bytes) {
      throw 'The nod release files do not match their metadata.'
    }
  }

  $directory = Join-Path ([IO.Path]::GetTempPath()) ('nod-install-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $directory | Out-Null
  try {
    foreach ($key in $files.Keys) {
      $entry = $latest.$key
      $path = Join-Path $directory $files[$key]
      Write-Host "Downloading $($files[$key])..."
      Invoke-WebRequest -Uri $entry.url -OutFile $path -UseBasicParsing
      if ((Get-Item -LiteralPath $path).Length -ne [long]$entry.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        throw "$($files[$key]) failed its integrity check. Run this command again."
      }
    }
    $arguments = '/S'
    $existing = (Get-ItemProperty -Path 'HKCU:\Software\nod' -ErrorAction SilentlyContinue).InstallDir
    $target = Join-Path $env:LOCALAPPDATA 'Programs\nod'
    if ($existing) {
      $target = $existing
      $arguments = "/S /D=$existing"
    }
    Write-Host "Installing nod $($latest.version)..."
    $process = Start-Process -FilePath (Join-Path $directory $files.installer) -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'The nod installer did not finish.' }
    $installed = (Get-ItemProperty -Path 'HKCU:\Software\nod' -ErrorAction SilentlyContinue).InstallDir
    if (-not $installed -or [IO.Path]::GetFullPath($installed) -ne [IO.Path]::GetFullPath($target)) {
      throw 'The nod installation destination could not be verified.'
    }
    $application = Join-Path $installed 'nod.exe'
    $package = Get-Content -LiteralPath (Join-Path $installed 'resources\app\package.json') -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $application -PathType Leaf) -or $package.name -ne 'nod-desktop' -or $package.version -ne $latest.version) {
      throw 'The installed app does not match the nod release.'
    }
  } finally {
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "nod $($latest.version) is installed. Opening nod..."
  try {
    Start-Process -FilePath $application -WorkingDirectory $installed
  } catch {
    throw 'nod is installed, but could not open. Open nod from the Start menu.'
  }
}
