param([string]$Out = 'C:\Users\Lenovo\ai-radar\app\shot.png')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$sig = 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);public struct RECT{public int Left,Top,Right,Bottom;}}'
Add-Type -TypeDefinition $sig
$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*ai-radar*' } | Select-Object -First 1
if (-not $p) { Write-Output 'WINDOW_NOT_FOUND'; exit 1 }
$h = $p.MainWindowHandle
[W]::ShowWindow($h, 9) | Out-Null
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
Write-Output ("RECT {0},{1} {2}x{3}" -f $r.Left, $r.Top, $w, $ht)
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output ("SAVED " + $Out)
