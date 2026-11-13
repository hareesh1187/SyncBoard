$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AssetsRoot = Join-Path $ProjectRoot 'assets'
$HighResolution = 1024
$Bitmap = New-Object System.Drawing.Bitmap($HighResolution, $HighResolution, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
$Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

function Get-Color([string] $Hex) { [System.Drawing.ColorTranslator]::FromHtml($Hex) }

function New-RoundedPath([float] $X, [float] $Y, [float] $Width, [float] $Height, [float] $Radius) {
  $Diameter = [Math]::Min($Radius * 2, [Math]::Min($Width, $Height))
  $Path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $Path.AddArc($X, $Y, $Diameter, $Diameter, 180, 90)
  $Path.AddArc($X + $Width - $Diameter, $Y, $Diameter, $Diameter, 270, 90)
  $Path.AddArc($X + $Width - $Diameter, $Y + $Height - $Diameter, $Diameter, $Diameter, 0, 90)
  $Path.AddArc($X, $Y + $Height - $Diameter, $Diameter, $Diameter, 90, 90)
  $Path.CloseFigure()
  return $Path
}

function Fill-Rounded([System.Drawing.Graphics] $Target, [float] $X, [float] $Y, [float] $Width, [float] $Height, [float] $Radius, [string] $Hex) {
  $Path = New-RoundedPath $X $Y $Width $Height $Radius
  $Brush = New-Object System.Drawing.SolidBrush((Get-Color $Hex))
  $Target.FillPath($Brush, $Path)
  $Brush.Dispose()
  $Path.Dispose()
}

$Scale = $HighResolution / 256.0
$Graphics.ScaleTransform($Scale, $Scale)
$BackgroundPath = New-RoundedPath 8 8 240 240 58
$BackgroundBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(8, 8, 240, 240), (Get-Color '#354368'), (Get-Color '#171d30'), 48)
$Graphics.FillPath($BackgroundBrush, $BackgroundPath)
$BackgroundBrush.Dispose(); $BackgroundPath.Dispose()

$GlowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(32, (Get-Color '#9eb4ff')))
$Graphics.FillEllipse($GlowBrush, -5, 151, 105, 105)
$GlowBrush.Dispose()

$Graphics.TranslateTransform(128, 128)
$Graphics.RotateTransform(-7)
$Graphics.TranslateTransform(-128, -128)
Fill-Rounded $Graphics 38 40 180 176 29 '#e9eee5'
Fill-Rounded $Graphics 38 37 180 176 29 '#fffefa'
Fill-Rounded $Graphics 56 56 70 65 16 '#dce6ff'
Fill-Rounded $Graphics 136 56 63 65 16 '#e4f4c7'
Fill-Rounded $Graphics 56 131 88 62 15 '#f7dfd3'
$VioletBrush = New-Object System.Drawing.SolidBrush((Get-Color '#d9cbff'))
$Graphics.FillEllipse($VioletBrush, 144, 135, 58, 58)
$VioletBrush.Dispose()

$MutedPen = New-Object System.Drawing.Pen((Get-Color '#98a1b4'), 4)
$MutedPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$MutedPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$Graphics.DrawLine($MutedPen, 126, 88, 136, 88)
$Graphics.DrawLine($MutedPen, 101, 122, 101, 132)
$Graphics.DrawLine($MutedPen, 148, 131, 160, 143)
$MutedPen.Dispose()

$LinePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(178, (Get-Color '#73809a')), 4)
$LinePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$LinePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$Graphics.DrawLine($LinePen, 72, 76, 105, 76)
$Graphics.DrawLine($LinePen, 72, 90, 96, 90)
$Graphics.DrawLine($LinePen, 150, 78, 181, 78)
$Graphics.DrawLine($LinePen, 150, 92, 169, 92)
$Graphics.DrawLine($LinePen, 72, 148, 122, 148)
$Graphics.DrawLine($LinePen, 72, 163, 108, 163)
$LinePen.Dispose()
$Graphics.ResetTransform()

$SparkPoints = @(
  [System.Drawing.PointF]::new(192, 23), [System.Drawing.PointF]::new(198, 40),
  [System.Drawing.PointF]::new(215, 46), [System.Drawing.PointF]::new(198, 52),
  [System.Drawing.PointF]::new(192, 69), [System.Drawing.PointF]::new(186, 52),
  [System.Drawing.PointF]::new(169, 46), [System.Drawing.PointF]::new(186, 40)
)
$SparkPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$SparkPath.AddPolygon($SparkPoints)
$SparkBrush = New-Object System.Drawing.SolidBrush((Get-Color '#d9fa78'))
$Graphics.FillPath($SparkBrush, $SparkPath)
$SparkBrush.Dispose(); $SparkPath.Dispose()
$CoralBrush = New-Object System.Drawing.SolidBrush((Get-Color '#f1b09a'))
$BlueBrush = New-Object System.Drawing.SolidBrush((Get-Color '#a6b7ff'))
$Graphics.FillEllipse($CoralBrush, 34, 68, 8, 8)
$Graphics.FillEllipse($BlueBrush, 211, 188, 10, 10)
$CoralBrush.Dispose(); $BlueBrush.Dispose()

$SmallBitmap = New-Object System.Drawing.Bitmap(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$SmallGraphics = [System.Drawing.Graphics]::FromImage($SmallBitmap)
$SmallGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$SmallGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$SmallGraphics.DrawImage($Bitmap, 0, 0, 256, 256)
$PngPath = Join-Path $AssetsRoot 'syncboard-icon.png'
$IcoPath = Join-Path $AssetsRoot 'syncboard.ico'
$SmallBitmap.Save($PngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$SmallBitmap.Dispose(); $SmallGraphics.Dispose(); $Bitmap.Dispose(); $Graphics.Dispose()

$PngBytes = [System.IO.File]::ReadAllBytes($PngPath)
$Stream = [System.IO.File]::Open($IcoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$Writer = New-Object System.IO.BinaryWriter($Stream)
$Writer.Write([UInt16]0)
$Writer.Write([UInt16]1)
$Writer.Write([UInt16]1)
$Writer.Write([Byte]0)
$Writer.Write([Byte]0)
$Writer.Write([Byte]0)
$Writer.Write([Byte]0)
$Writer.Write([UInt16]1)
$Writer.Write([UInt16]32)
$Writer.Write([UInt32]$PngBytes.Length)
$Writer.Write([UInt32]22)
$Writer.Write($PngBytes)
$Writer.Dispose(); $Stream.Dispose()

Write-Output "Created $IcoPath"
