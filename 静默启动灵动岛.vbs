' Silent desktop launcher for Herdr Island (delegated to Explorer.exe so it never dies with parent shell)
Set fso = CreateObject("Scripting.FileSystemObject")
Set wsh = CreateObject("WScript.Shell")
Set shellApp = CreateObject("Shell.Application")
rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
wsh.CurrentDirectory = rootDir

electronExe = rootDir & "\node_modules\electron\dist\electron.exe"
distHtml = rootDir & "\dist\index.html"
distMain = rootDir & "\dist-electron\electron\main.js"

If Not fso.FileExists(distHtml) Or Not fso.FileExists(distMain) Then
  wsh.Run "cmd /c npm run build", 0, True
End If

wsh.Run "powershell -NoProfile -WindowStyle Hidden -Command ""$t = '" & electronExe & "'; Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $t } | Stop-Process -Force -ErrorAction SilentlyContinue""", 0, True
WScript.Sleep 250
shellApp.ShellExecute electronExe, ".", rootDir, "open", 1
