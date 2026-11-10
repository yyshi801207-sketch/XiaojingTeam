# Compile the installer artwork into white-backed NSIS bitmaps.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$buildPath = Join-Path $PSScriptRoot '../build'
$outputs = @(
    @{ Source = 'installer-robot-source.png'; Name = 'installer-product-logo.bmp'; Width = 640; Height = 360 },
    @{ Source = 'installer-robot-source.png'; Name = 'installer-product-logo-small.bmp'; Width = 72; Height = 72 },
    @{ Source = 'installer-robot-source.png'; Name = 'installer-sidebar.bmp'; Width = 164; Height = 314 },
    @{ Source = 'installer-icon-source.png'; Name = 'installer-header.bmp'; Width = 150; Height = 57 },
    @{ Source = 'installer-company-source.png'; Name = 'installer-company-logo.bmp'; Width = 180; Height = 58 }
)
foreach ($output in $outputs) {
    $sourceImage = [System.Drawing.Image]::FromFile([System.IO.Path]::GetFullPath((Join-Path $buildPath $output.Source)))
    try {
        $sourceArea = [System.Drawing.RectangleF]::new(0, 0, $sourceImage.Width, $sourceImage.Height)
        $bitmap = [System.Drawing.Bitmap]::new($output.Width, $output.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::White)
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $scale = [Math]::Min(($output.Width - 4) / $sourceArea.Width, ($output.Height - 4) / $sourceArea.Height)
                $width = $sourceArea.Width * $scale
                $height = $sourceArea.Height * $scale
                $targetArea = [System.Drawing.RectangleF]::new(($output.Width - $width) / 2, ($output.Height - $height) / 2, $width, $height)
                $graphics.DrawImage($sourceImage, $targetArea, $sourceArea, [System.Drawing.GraphicsUnit]::Pixel)
            } finally {
                $graphics.Dispose()
            }
            $bitmap.Save((Join-Path $buildPath $output.Name), [System.Drawing.Imaging.ImageFormat]::Bmp)
        } finally {
            $bitmap.Dispose()
        }
    } finally {
        $sourceImage.Dispose()
    }
}
