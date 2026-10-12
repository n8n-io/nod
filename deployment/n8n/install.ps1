& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $base = 'https://internal.users.n8n.cloud/webhook/otto-desktop'
  $files = [ordered]@{ installer = 'Otto-Setup-x64.exe'; runtime = 'Otto-Runtime-win32-x64.tar.gz' }

  $windows = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
  if (-not [Environment]::Is64BitOperatingSystem -or [int]$windows.CurrentBuildNumber -lt 22000) {
    throw 'Otto requires 64-bit Windows 11.'
  }
  if (Get-Process -Name Otto -ErrorAction SilentlyContinue) {
    throw 'Quit Otto, then run this command again.'
  }

  $latest = Invoke-RestMethod -Uri "$base/releases?installer=true&platform=win32-x64" -UseBasicParsing
  $assets = "$base/releases/$($latest.releaseId)/assets/"
  if ($latest.schema -ne 1 -or "$($latest.version)" -notmatch '^\d+\.\d+\.\d+$' -or -not "$($latest.manifestUrl)".StartsWith($assets)) {
    throw 'The Otto release metadata is invalid.'
  }
  foreach ($key in $files.Keys) {
    $entry = $latest.$key
    if (-not "$($entry.url)".StartsWith($assets) -or "$($entry.sha256)" -cnotmatch '^[a-f0-9]{64}$' -or [long]$entry.bytes -lt 1) {
      throw 'The Otto release metadata is invalid.'
    }
  }
  $response = Invoke-WebRequest -Uri $latest.manifestUrl -UseBasicParsing
  $manifest = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
  if ($manifest.version -ne $latest.version -or $manifest.platform -ne 'win32-x64') {
    throw 'The Otto release files do not match their metadata.'
  }
  foreach ($key in $files.Keys) {
    if ($manifest.$key.file -ne $files[$key] -or $manifest.$key.sha256 -ne $latest.$key.sha256 -or [long]$manifest.$key.bytes -ne [long]$latest.$key.bytes) {
      throw 'The Otto release files do not match their metadata.'
    }
  }

  $directory = Join-Path ([IO.Path]::GetTempPath()) ('otto-install-' + [Guid]::NewGuid())
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
    $existing = (Get-ItemProperty -Path 'HKCU:\Software\Otto' -ErrorAction SilentlyContinue).InstallDir
    if ($existing) { $arguments = "/S /D=$existing" }
    Write-Host "Installing Otto $($latest.version)..."
    $process = Start-Process -FilePath (Join-Path $directory $files.installer) -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'The Otto installer did not finish.' }
  } finally {
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Otto $($latest.version) is installed. Open Otto from the Start menu."
}
