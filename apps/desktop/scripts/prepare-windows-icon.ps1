# Copy the approved original artwork unchanged to native, browser and download aliases.
$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $desktopRoot 'build/installer-icon-source.png'
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
if ($sourceHash -ne '2346537B7B2A2B19EDB0DA53FA7D689B7CD2521470E6FD8DD1CC5D15D895E7BB') {
  throw 'The branded icon source changed; review the original artwork before copying Windows icons.'
}
Add-Type -AssemblyName System.Drawing
$sourceBitmap = [Drawing.Bitmap]::new($sourcePath)
try {
  if ($sourceBitmap.Width -ne 1254 -or $sourceBitmap.Height -ne 1254) {
    throw 'The branded icon source must be 1254 by 1254 pixels.'
  }
} finally { $sourceBitmap.Dispose() }
foreach ($relativePath in @(
  'build/app-icon.png',
  'assets/windows-icon.png',
  'assets/app-icon.png',
  'assets/taskbar-icon.png',
  'resources/icon.png',
  'resources/icon-windows.png',
  'resources/icon-macos.png',
  '../web/public/xiaojing-character-logo.png',
  '../xiaojing-download/assets/app-icon.png'
)) {
  $destinationPath = Join-Path $desktopRoot $relativePath
  if ((Test-Path -LiteralPath $destinationPath) -and (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash -eq $sourceHash) { continue }
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}
