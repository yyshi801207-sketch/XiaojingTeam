# Copy the approved original artwork unchanged to native, browser and download aliases.
$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $desktopRoot 'build/installer-icon-source.png'
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
if ($sourceHash -ne '1E00BE3E6C1356739D04B3F8851507B0655213F8B4329EB6610CA5ECB873AD7D') {
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
  '../../packages/client/xiaojing-product/src/client/assets/xiaojing-team-app-icon.png',
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
