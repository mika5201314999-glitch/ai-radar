param([int]$X, [int]$Y)
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);}'
[M]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 250
[M]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[M]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
Write-Output ("CLICK {0},{1}" -f $X, $Y)
