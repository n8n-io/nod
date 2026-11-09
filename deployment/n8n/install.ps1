& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $releases = 'https://github.com/n8n-io/nod/releases'
  $legacyUpdateSource = 'https://internal.users.n8n.cloud/webhook/nod/desktop'
  $files = [ordered]@{ installer = 'nod-Setup-x64.exe'; runtime = 'nod-Runtime-win32-x64.tar.gz' }

  $windows = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
  if (-not [Environment]::Is64BitOperatingSystem -or [int]$windows.CurrentBuildNumber -lt 22000) {
    throw 'Nod requires 64-bit Windows 11.'
  }
  if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer in a normal PowerShell window, not as administrator.'
  }
  if (Get-Process -Name nod -ErrorAction SilentlyContinue) {
    throw 'Quit Nod, then run this command again.'
  }

  try {
    $redirect = Invoke-WebRequest -Uri "$releases/latest/download/release-win32-x64.json" -MaximumRedirection 0 -UseBasicParsing
  } catch {
    $redirect = $_.Exception.Response
    if (-not $redirect) { throw 'The latest Nod release is unavailable.' }
  }
  $location = if ($redirect -is [System.Net.Http.HttpResponseMessage]) { $redirect.Headers.Location } else { $redirect.Headers['Location'] }
  $locations = @($location)
  if ($locations.Count -ne 1 -or -not $locations[0]) { throw 'The Nod release metadata is invalid.' }
  $targetUrl = [Uri]$locations[0]
  $match = [regex]::Match($targetUrl.AbsolutePath, '^/n8n-io/nod/releases/download/(nod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))/release-win32-x64\.json$')
  if ([int]$redirect.StatusCode -ne 302 -or $targetUrl.Scheme -ne 'https' -or $targetUrl.Host -ne 'github.com' -or $targetUrl.Port -ne 443 -or $targetUrl.UserInfo -or $targetUrl.Query -or $targetUrl.Fragment -or -not $match.Success -or $match.Groups[1].Value.Length -gt 70) {
    throw 'The Nod release metadata is invalid.'
  }
  $tag = $match.Groups[1].Value
  $version = $tag.Substring(5)
  $response = Invoke-WebRequest -Uri "$releases/download/$tag/release-win32-x64.json" -UseBasicParsing
  if ($response.RawContentStream.Length -gt 2097152) { throw 'The Nod release metadata is too large.' }
  $manifest = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
  if ($manifest.version -ne $version -or $manifest.platform -ne 'win32-x64' -or "$($manifest.source)" -cnotmatch '^[a-f0-9]{40}$' -or $manifest.signing.mode -ne 'artifact-signing' -or ($null -ne $manifest.updateSourceUrl -and $manifest.updateSourceUrl -ne $legacyUpdateSource)) {
    throw 'The Nod release files do not match their metadata.'
  }
  foreach ($key in $files.Keys) {
    $entry = $manifest.$key
    if ($entry.file -ne $files[$key] -or "$($entry.sha256)" -cnotmatch '^[a-f0-9]{64}$' -or [long]$entry.bytes -lt 1 -or [long]$entry.bytes -gt 4294967296) {
      throw 'The Nod release files do not match their metadata.'
    }
  }
  $assets = "$releases/download/$tag/"
  $arguments = '/S'
  $existing = (Get-ItemProperty -Path 'HKCU:\Software\nod' -ErrorAction SilentlyContinue).InstallDir
  $target = Join-Path $env:LOCALAPPDATA 'Programs\nod'
  if ($existing) {
    $target = $existing
    $arguments = "/S /D=$existing"
  }
  $installedPackage = Join-Path $target 'resources\app\package.json'
  if (Test-Path -LiteralPath $installedPackage -PathType Leaf) {
    $installedVersion = (Get-Content -LiteralPath $installedPackage -Raw | ConvertFrom-Json).version
    if ("$installedVersion" -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
      throw 'The installed Nod version is invalid.'
    }
    if ([version]$installedVersion -gt [version]$version) {
      throw 'A newer Nod version is already installed. Your app was kept.'
    }
  }

  $directory = Join-Path ([IO.Path]::GetTempPath()) ('nod-install-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $directory | Out-Null
  try {
    foreach ($key in $files.Keys) {
      $entry = $manifest.$key
      $path = Join-Path $directory $files[$key]
      Write-Host "Downloading $($files[$key])..."
      Invoke-WebRequest -Uri "$assets$($files[$key])" -OutFile $path -UseBasicParsing
      if ((Get-Item -LiteralPath $path).Length -ne [long]$entry.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        throw "$($files[$key]) failed its integrity check. Run this command again."
      }
    }
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $directory $files.installer)
    $certificate = $signature.SignerCertificate
    if ($signature.Status -ne 'Valid' -or -not $certificate -or $certificate.GetNameInfo('SimpleName', $false) -ne 'n8n GmbH' -or @($certificate.EnhancedKeyUsageList.ObjectId) -notcontains '1.3.6.1.4.1.311.97.516399124.569093350.771684794.174905458' -or -not $signature.TimeStamperCertificate) {
      throw 'The Nod installer signature is invalid.'
    }
    Write-Host "Installing Nod $version..."
    $process = Start-Process -FilePath (Join-Path $directory $files.installer) -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'The Nod installer did not finish.' }
    $installed = (Get-ItemProperty -Path 'HKCU:\Software\nod' -ErrorAction SilentlyContinue).InstallDir
    if (-not $installed -or [IO.Path]::GetFullPath($installed) -ne [IO.Path]::GetFullPath($target)) {
      throw 'The Nod installation destination could not be verified.'
    }
    $application = Join-Path $installed 'nod.exe'
    $package = Get-Content -LiteralPath (Join-Path $installed 'resources\app\package.json') -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $application -PathType Leaf) -or $package.name -ne 'nod-desktop' -or $package.version -ne $version -or $package.nodBuild.source -ne $manifest.source -or $package.nodBuild.updateSourceUrl -ne $manifest.updateSourceUrl) {
      throw 'The installed app does not match the Nod release.'
    }
  } finally {
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Nod $version is installed. Opening Nod..."
  try {
    Start-Process -FilePath $application -WorkingDirectory $installed
  } catch {
    throw 'Nod is installed, but could not open. Open Nod from the Start menu.'
  }
}
