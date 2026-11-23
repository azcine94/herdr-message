import ctypes
from ctypes import wintypes
import json
import os
import re
import sys
import tempfile
import time

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

EXTENDED_STARTUPINFO_PRESENT = 0x00080000
PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016


class COORD(ctypes.Structure):
    _fields_ = [("X", wintypes.SHORT), ("Y", wintypes.SHORT)]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(wintypes.BYTE)),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [
        ("StartupInfo", STARTUPINFOW),
        ("lpAttributeList", ctypes.c_void_p),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


# Explicit 64-bit Win32 signatures so ConPTY attribute list attaches properly
kernel32.CreatePseudoConsole.argtypes = [
    COORD,
    wintypes.HANDLE,
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.HANDLE),
]
kernel32.CreatePseudoConsole.restype = ctypes.c_long

kernel32.InitializeProcThreadAttributeList.argtypes = [
    ctypes.c_void_p,
    wintypes.DWORD,
    wintypes.DWORD,
    ctypes.POINTER(ctypes.c_size_t),
]
kernel32.InitializeProcThreadAttributeList.restype = wintypes.BOOL

kernel32.UpdateProcThreadAttribute.argtypes = [
    ctypes.c_void_p,
    wintypes.DWORD,
    ctypes.c_size_t,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_void_p,
    ctypes.c_void_p,
]
kernel32.UpdateProcThreadAttribute.restype = wintypes.BOOL


def strip_ansi(text: str) -> str:
    s = re.sub(r"\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", " ", text)
    s = re.sub(r"[\r\x00-\x08\x0b-\x1f]", " ", s)
    return re.sub(r" +", " ", s)


def probe_devin_usage(devin_bin: str) -> dict:
    in_read, in_write = wintypes.HANDLE(), wintypes.HANDLE()
    out_read, out_write = wintypes.HANDLE(), wintypes.HANDLE()
    kernel32.CreatePipe(ctypes.byref(in_read), ctypes.byref(in_write), None, 0)
    kernel32.CreatePipe(ctypes.byref(out_read), ctypes.byref(out_write), None, 0)

    hpc = wintypes.HANDLE()
    size = COORD(120, 36)
    hr = kernel32.CreatePseudoConsole(size, in_read, out_write, 0, ctypes.byref(hpc))
    if hr != 0:
        raise RuntimeError(f"CreatePseudoConsole failed: {hr}")

    attr_size = ctypes.c_size_t(0)
    kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(attr_size))
    attr_buf = ctypes.create_string_buffer(attr_size.value)
    kernel32.InitializeProcThreadAttributeList(attr_buf, 1, 0, ctypes.byref(attr_size))
    ok_attr = kernel32.UpdateProcThreadAttribute(
        attr_buf,
        0,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
        ctypes.c_void_p(hpc.value),
        ctypes.sizeof(wintypes.HANDLE),
        None,
        None,
    )
    if not ok_attr:
        raise RuntimeError(f"UpdateProcThreadAttribute failed: {ctypes.get_last_error()}")

    si = STARTUPINFOEXW()
    si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
    si.lpAttributeList = ctypes.cast(attr_buf, ctypes.c_void_p)
    pi = PROCESS_INFORMATION()

    cmd = f'"{devin_bin}" --process-model in-process --respect-workspace-trust false'
    ok = kernel32.CreateProcessW(
        None,
        ctypes.create_unicode_buffer(cmd),
        None,
        None,
        False,
        EXTENDED_STARTUPINFO_PRESENT,
        None,
        tempfile.gettempdir(),
        ctypes.byref(si),
        ctypes.byref(pi),
    )
    if not ok:
        raise RuntimeError(f"CreateProcessW failed: {ctypes.get_last_error()}")

    kernel32.CloseHandle(in_read)
    kernel32.CloseHandle(out_write)

    def read_available() -> bytes:
        avail = wintypes.DWORD(0)
        chunks = []
        while (
            kernel32.PeekNamedPipe(out_read, None, 0, None, ctypes.byref(avail), None)
            and avail.value > 0
        ):
            buf = ctypes.create_string_buffer(min(avail.value, 8192))
            read_n = wintypes.DWORD(0)
            kernel32.ReadFile(out_read, buf, len(buf), ctypes.byref(read_n), None)
            chunks.append(buf.raw[: read_n.value])
        return b"".join(chunks)

    def write_bytes(data: bytes) -> None:
        written = wintypes.DWORD(0)
        kernel32.WriteFile(in_write, data, len(data), ctypes.byref(written), None)

    start = time.time()
    sent_usage = False
    try:
        while time.time() - start < 5.0:
            chunk = read_available()
            if chunk:
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                if b"\x1b[6n" in chunk:
                    write_bytes(b"\x1b[1;1R")
            if not sent_usage and time.time() - start > 2.1:
                write_bytes(b"/usage")
                time.sleep(0.2)
                write_bytes(b"\r")
                sent_usage = True
            time.sleep(0.08)
    finally:
        kernel32.TerminateProcess(pi.hProcess, 0)
        kernel32.ClosePseudoConsole(hpc)
        kernel32.CloseHandle(in_write)
        kernel32.CloseHandle(out_read)
        kernel32.CloseHandle(pi.hProcess)
        kernel32.CloseHandle(pi.hThread)


if __name__ == "__main__":
    bin_arg = (
        sys.argv[1]
        if len(sys.argv) > 1
        else os.path.join(os.environ.get("LOCALAPPDATA", ""), "devin", "cli", "bin", "devin.exe")
    )
    probe_devin_usage(bin_arg)
