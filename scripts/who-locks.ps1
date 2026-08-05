# 어떤 프로세스가 이 경로들을 물고 있는가 — Windows Restart Manager 에 직접 묻는다.
#
# `handle.exe`(SysInternals)가 없어도 되고 관리자 권한도 필요 없다. 커널이 알고 있는
# 것을 그대로 돌려주므로 추측이 없다. `Get-Process` 로는 알 수 없다 — 파일을 연
# 프로세스는 그 파일과 아무 이름도 공유하지 않는다.
#
# 출력은 한 줄에 하나: `<pid>\t<프로세스이름>`. 못 찾으면 아무것도 내지 않는다.
# 경로는 **파일로** 받는다(한 줄에 하나, UTF-8). `powershell -File script -Paths a b c`
# 는 첫 하나만 -Paths 에 묶고 나머지를 위치 인자로 흘려 «positional parameter cannot
# be found» 로 죽는다. 쉼표로 이으면 경로에 쉼표가 든 순간 깨진다. 목록 파일이 제일
# 조용하다.
param([Parameter(Mandatory = $true)][string]$PathsFile)

$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class LockFinder {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded,
        ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    const int ERROR_MORE_DATA = 234;

    public static List<string> Who(string[] paths) {
        var res = new List<string>();
        uint handle;
        if (RmStartSession(out handle, 0, Guid.NewGuid().ToString()) != 0) return res;
        try {
            if (RmRegisterResources(handle, (uint)paths.Length, paths, 0, IntPtr.Zero, 0, null) != 0) return res;
            uint needed = 0, count = 0, reason = 0;
            if (RmGetList(handle, out needed, ref count, null, ref reason) != ERROR_MORE_DATA) return res;
            if (needed == 0) return res;
            var info = new RM_PROCESS_INFO[needed];
            count = needed;
            if (RmGetList(handle, out needed, ref count, info, ref reason) != 0) return res;
            for (int i = 0; i < count; i++) {
                int pid = info[i].Process.dwProcessId;
                string name = info[i].strAppName;
                try { name = Process.GetProcessById(pid).ProcessName; } catch { }
                res.Add(pid + "\t" + name);
            }
        } finally {
            RmEndSession(handle);
        }
        return res;
    }
}
'@

Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
# 디렉터리를 섞어 넘기면 RmRegisterResources 가 조용히 실패하고 목록이 통째로
# 비어 나온다 — 파일만 남긴다. (파일 하나로는 찾던 것을 폴더를 함께 넘기자
# 못 찾아서 알게 됐다.)
$Paths = @(Get-Content -LiteralPath $PathsFile -Encoding UTF8 | Where-Object { $_.Trim() })
$exists = @($Paths | Where-Object {
    (Test-Path -LiteralPath $_) -and -not (Get-Item -LiteralPath $_ -Force).PSIsContainer
})
if ($exists.Count -eq 0) { exit 0 }
[LockFinder]::Who($exists) | ForEach-Object { $_ }
