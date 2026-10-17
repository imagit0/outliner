# Renders the PNG app icons (same design as icons/icon.svg) with System.Drawing.
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\icons'

function Draw([int]$size, [string]$file, [bool]$maskable) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $s = $size / 512.0
    $bg = [System.Drawing.ColorTranslator]::FromHtml('#1f2328')
    $fg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#e6e8eb'))
    $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#6ea2ff')), (10 * $s)
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'

    if ($maskable) {
        # Full-bleed background; content shrunk into the 80% safe zone.
        $g.Clear($bg)
        $g.TranslateTransform($size * 0.1, $size * 0.1)
        $s = $s * 0.8
    } else {
        $g.Clear([System.Drawing.Color]::Transparent)
        $r = 96 * $s; $d = 2 * $r; $w = $size
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($w - $d, 0, $d, $d, 270, 90)
        $path.AddArc($w - $d, $w - $d, $d, $d, 0, 90); $path.AddArc(0, $w - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $g.FillPath((New-Object System.Drawing.SolidBrush $bg), $path)
    }
    $pen.Width = 10 * $s

    function Pill($x, $y, $w, $h) {
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $p.AddArc($x * $s, $y * $s, $h * $s, $h * $s, 90, 180)
        $p.AddArc(($x + $w - $h) * $s, $y * $s, $h * $s, $h * $s, 270, 180)
        $p.CloseFigure()
        $g.FillPath($fg, $p)
    }
    function Dot($cx, $cy) { $g.FillEllipse($fg, ($cx - 26) * $s, ($cy - 26) * $s, 52 * $s, 52 * $s) }

    Dot 136 152; Pill 186 136 210 32
    Dot 206 256; Pill 256 240 140 32
    Dot 206 360; Pill 256 344 170 32
    $g.DrawLines($pen, [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF (136 * $s), (190 * $s)),
        (New-Object System.Drawing.PointF (136 * $s), (360 * $s)),
        (New-Object System.Drawing.PointF (170 * $s), (360 * $s))))
    $g.DrawLine($pen, 136 * $s, 256 * $s, 170 * $s, 256 * $s)

    $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

Draw 192 'icon-192.png' $false
Draw 512 'icon-512.png' $false
Draw 512 'icon-maskable-512.png' $true
Write-Output "icons written to $out"
