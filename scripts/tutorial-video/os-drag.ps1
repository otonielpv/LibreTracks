# Real operating-system drag of every file in a folder, from a File Explorer
# window onto a point of the screen (the app's timeline), with the real mouse.
# Used by the tutorial video for the "drag your stems in" scene: WebDriver can
# only fake drags inside the page, not a drop from Explorer.
#
#   powershell -File os-drag.ps1 -Folder <dir> -ExplorerRect "0,0,700,1040" -DropX 1200 -DropY 500
#
# The mouse really moves while this runs.
param(
  [Parameter(Mandatory = $true)][string]$Folder,
  [string]$ExplorerRect = "0,0,700,1040",
  [Parameter(Mandatory = $true)][int]$DropX,
  [Parameter(Mandatory = $true)][int]$DropY,
  [int]$MoveMs = 1600,
  [switch]$KeepExplorer,
  # "open": open and place Explorer, hide the test consoles (before recording).
  # "drag": select every file and drag them (while recording).
  [ValidateSet("open", "drag", "close", "all")][string]$Phase = "all"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LtInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static void MinimizeConsoles() {
    EnumWindows((h, p) => {
      var sb = new System.Text.StringBuilder(256);
      GetClassName(h, sb, 256);
      var c = sb.ToString();
      if (IsWindowVisible(h) && (c == "ConsoleWindowClass" || c == "CASCADIA_HOSTING_WINDOW_CLASS")) ShowWindow(h, 6);
      return true;
    }, IntPtr.Zero);
  }
  public const uint LEFTDOWN = 0x02, LEFTUP = 0x04;
}
"@

function Find-ExplorerWindow($title) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, "CabinetWClass")
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    if ($w.Current.Name -like "*$title*") { return $w }
  }
  return $null
}

$name = Split-Path $Folder -Leaf
$r = $ExplorerRect.Split(",") | ForEach-Object { [int]$_ }
$win = Find-ExplorerWindow $name
if ($Phase -ne "drag") {
  [LtInput]::MinimizeConsoles()
  if (-not $win) { Start-Process explorer.exe -ArgumentList "`"$Folder`"" }
  for ($i = 0; $i -lt 40 -and -not $win; $i++) { Start-Sleep -Milliseconds 250; $win = Find-ExplorerWindow $name }
  if (-not $win) { throw "Explorer window '$name' did not appear" }
  $hwnd = [IntPtr]$win.Current.NativeWindowHandle
  [LtInput]::ShowWindow($hwnd, 1) | Out-Null
  [LtInput]::SetWindowPos($hwnd, [IntPtr]::Zero, $r[0], $r[1], $r[2], $r[3], 0x0040) | Out-Null
  [LtInput]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 1200
  if ($Phase -eq "open") { Write-Output "explorer ready"; exit 0 }
}
if (-not $win) { throw "Explorer window '$name' is not open (run -Phase open first)" }
if ($Phase -eq "close") {
  ([System.Windows.Automation.WindowPattern]$win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Close()
  Write-Output "explorer closed"; exit 0
}

# First file of the list, from UI Automation.
$itemCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::ListItem)
$items = $null
for ($i = 0; $i -lt 20; $i++) {
  $items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $itemCond)
  if ($items.Count -gt 0) { break }
  Start-Sleep -Milliseconds 250
}
if ($items.Count -eq 0) { throw "no files listed in Explorer" }
$b = $items[0].Current.BoundingRectangle
$sx = [int]($b.X + [Math]::Min(60, $b.Width / 2)); $sy = [int]($b.Y + $b.Height / 2)

function Glide($fromX, $fromY, $toX, $toY, $ms) {
  $steps = [Math]::Max(10, [int]($ms / 16))
  for ($i = 1; $i -le $steps; $i++) {
    $t = $i / $steps
    $e = if ($t -lt 0.5) { 2 * $t * $t } else { 1 - [Math]::Pow(-2 * $t + 2, 2) / 2 }
    [LtInput]::SetCursorPos([int]($fromX + ($toX - $fromX) * $e), [int]($fromY + ($toY - $fromY) * $e)) | Out-Null
    Start-Sleep -Milliseconds 16
  }
}

# Click the first file, then extend the selection to the last one as a
# Shift+click would. The selection itself goes through UI Automation: the
# synthetic keyboard (Ctrl+A, Shift) did not reach Explorer reliably.
Glide ($r[0] + $r[2] / 2) ($r[1] + $r[3] - 80) $sx $sy 700
[LtInput]::mouse_event([LtInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
[LtInput]::mouse_event([LtInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 400
$lb = $items[$items.Count - 1].Current.BoundingRectangle
$lx = [int]($lb.X + [Math]::Min(60, $lb.Width / 2)); $ly = [int]($lb.Y + $lb.Height / 2)
Glide $sx $sy $lx $ly 600
foreach ($it in $items) {
  ([System.Windows.Automation.SelectionItemPattern]$it.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).AddToSelection()
}
Start-Sleep -Milliseconds 700
Glide $lx $ly $sx $sy 500
[LtInput]::mouse_event([LtInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
Glide $sx $sy ($sx + 30) ($sy + 10) 200          # start the OS drag
Glide ($sx + 30) ($sy + 10) $DropX $DropY $MoveMs
Start-Sleep -Milliseconds 700
[LtInput]::mouse_event([LtInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400

if (-not $KeepExplorer) {
  ([System.Windows.Automation.WindowPattern]$win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Close()
}
Write-Output "dragged $($items.Count) files"
