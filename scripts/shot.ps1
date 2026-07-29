Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process electron -ErrorAction Stop |
  Where-Object { $_.MainWindowTitle -eq 'Artifact Board' } | Select-Object -First 1
if (-not $proc) { Write-Error 'window not found'; exit 1 }

$h = $proc.MainWindowHandle
$r = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top

$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (2) captures Chromium/Electron surfaces without needing
# the window to be foreground, so this does not steal focus from the user.
[Win]::PrintWindow($h, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)

$out = Join-Path $PSScriptRoot '..\shot.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "saved $w x $hh"
