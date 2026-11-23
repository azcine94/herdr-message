param(
  [Parameter(Mandatory = $true)]
  [string]$DevinBin
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ConPtyProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, int nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool PeekNamedPipe(IntPtr hNamedPipe, byte[] lpBuffer, uint nBufferSize, IntPtr lpBytesRead, out uint lpTotalBytesAvail, IntPtr lpBytesLeftThisMessage);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    public static string Run(string devinBin) {
        IntPtr inRead, inWrite, outRead, outWrite;
        CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0);
        CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0);

        COORD size = new COORD { X = 120, Y = 36 };
        IntPtr hPC;
        if (CreatePseudoConsole(size, inRead, outWrite, 0, out hPC) != 0) return "";

        IntPtr lpSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lpSize);
        IntPtr attrList = Marshal.AllocHGlobal(lpSize);
        InitializeProcThreadAttributeList(attrList, 1, 0, ref lpSize);
        UpdateProcThreadAttribute(attrList, 0, (IntPtr)0x00020016, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        var cmd = new StringBuilder("\"" + devinBin + "\" --process-model in-process --respect-workspace-trust false");
        bool created = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, Path.GetTempPath(), ref si, out pi);
        CloseHandle(inRead);
        CloseHandle(outWrite);

        var sb = new MemoryStream();
        if (created) {
            byte[] buf = new byte[8192];
            var start = DateTime.UtcNow;
            bool sent = false;
            try {
                while ((DateTime.UtcNow - start).TotalSeconds < 5.2) {
                    uint avail = 0;
                    while (PeekNamedPipe(outRead, null, 0, IntPtr.Zero, out avail, IntPtr.Zero) && avail > 0) {
                        uint read = 0;
                        if (ReadFile(outRead, buf, (uint)Math.Min(avail, buf.Length), out read, IntPtr.Zero) && read > 0) {
                            sb.Write(buf, 0, (int)read);
                            string chunk = Encoding.UTF8.GetString(buf, 0, (int)read);
                            if (chunk.Contains("\x1b[6n")) {
                                var resp = Encoding.ASCII.GetBytes("\x1b[1;1R");
                                uint w; WriteFile(inWrite, resp, (uint)resp.Length, out w, IntPtr.Zero);
                            }
                        }
                    }
                    if (!sent && (DateTime.UtcNow - start).TotalSeconds > 2.1) {
                        uint w;
                        var u = Encoding.ASCII.GetBytes("/usage");
                        WriteFile(inWrite, u, (uint)u.Length, out w, IntPtr.Zero);
                        Thread.Sleep(200);
                        var cr = Encoding.ASCII.GetBytes("\r");
                        WriteFile(inWrite, cr, (uint)cr.Length, out w, IntPtr.Zero);
                        sent = true;
                    }
                    Thread.Sleep(80);
                }
            } finally {
                TerminateProcess(pi.hProcess, 0);
                CloseHandle(pi.hProcess);
                CloseHandle(pi.hThread);
            }
        }

        ClosePseudoConsole(hPC);
        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(attrList);
        CloseHandle(inWrite);
        CloseHandle(outRead);
        return Encoding.UTF8.GetString(sb.ToArray());
    }
}
"@

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ([ConPtyProbe]::Run($DevinBin))
