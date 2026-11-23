param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Exercise actual PE resources, including language variants and unrelated data.
# The supplied executable is copied; the original artifact is never modified.
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ManifestFixture {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResourceW(string path, bool delete);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateResourceW(IntPtr h, IntPtr type, IntPtr name, ushort language, byte[] bytes, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr h, bool discard);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr FindResourceExW(IntPtr h, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LoadResource(IntPtr h, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint SizeofResource(IntPtr h, IntPtr resource);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
    public static void Write(string path, int type, int name, ushort language, byte[] bytes) {
        var h=BeginUpdateResourceW(path,false); if(h==IntPtr.Zero) throw new Win32Exception();
        if(!UpdateResourceW(h,new IntPtr(type),new IntPtr(name),language,bytes,(uint)bytes.Length)) { EndUpdateResourceW(h,true); throw new Win32Exception(); }
        if(!EndUpdateResourceW(h,false)) throw new Win32Exception();
    }
    public static byte[] Read(string path, int type, int name, ushort language) {
        var h=LoadLibraryExW(path,IntPtr.Zero,2); if(h==IntPtr.Zero) throw new Win32Exception();
        try {
            var resource=FindResourceExW(h,new IntPtr(type),new IntPtr(name),language);
            if(resource==IntPtr.Zero) throw new Win32Exception();
            var loaded=LoadResource(h,resource); if(loaded==IntPtr.Zero) throw new Win32Exception();
            var pointer=LockResource(loaded); if(pointer==IntPtr.Zero) throw new Win32Exception();
            var bytes=new byte[checked((int)SizeofResource(h,resource))];
            Marshal.Copy(pointer,bytes,0,bytes.Length); return bytes;
        } finally { FreeLibrary(h); }
    }
}
'@

$root = Join-Path ([IO.Path]::GetTempPath()) ('cantrip-manifest-test-' + [guid]::NewGuid())
New-Item -ItemType Directory $root | Out-Null
try {
    $file = Join-Path $root 'fixture.exe'
    Copy-Item -LiteralPath $Executable -Destination $file
    $xml = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity name="Cantrip.Preserve" version="1.0.0.0" type="win32"/><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo><application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware></windowsSettings></application></assembly>'
    $bytes = [Text.Encoding]::UTF8.GetBytes($xml)
    foreach ($language in @(1033,1041)) { [ManifestFixture]::Write($file,24,1,$language,$bytes) }
    $opaque = [byte[]]@(0,255,1,2,128,127,42)
    [ManifestFixture]::Write($file,10,777,1033,$opaque)
    $tool = Join-Path $PSScriptRoot 'windows-utf8-manifest.ps1'
    $powershell = Join-Path $PSHOME 'powershell.exe'
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tool -Root $root
    if ($LASTEXITCODE -ne 0) { throw 'Manifest update failed' }
    foreach ($language in @(1033,1041)) {
        [xml]$actual = [Text.Encoding]::UTF8.GetString([ManifestFixture]::Read($file,24,1,$language))
        if ($actual.GetElementsByTagName('activeCodePage','http://schemas.microsoft.com/SMI/2019/WindowsSettings')[0].InnerText -ne 'UTF-8') { throw 'Missing UTF-8 language variant' }
        if ($actual.GetElementsByTagName('requestedExecutionLevel','urn:schemas-microsoft-com:asm.v3')[0].GetAttribute('level') -ne 'asInvoker') { throw 'Changed execution privileges' }
        if ($actual.GetElementsByTagName('longPathAware','http://schemas.microsoft.com/SMI/2016/WindowsSettings')[0].InnerText -ne 'true') { throw 'Lost long-path setting' }
        if ($actual.GetElementsByTagName('assemblyIdentity','urn:schemas-microsoft-com:asm.v1')[0].GetAttribute('name') -ne 'Cantrip.Preserve') { throw 'Lost assembly identity' }
    }
    if ([Convert]::ToBase64String([ManifestFixture]::Read($file,10,777,1033)) -ne [Convert]::ToBase64String($opaque)) { throw 'Changed unrelated PE resource' }
    $first = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tool -Root $root
    if ($LASTEXITCODE -ne 0) { throw 'Repeated manifest update failed' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $first) { throw 'Repeated update changed artifact bytes' }
    Write-Output '{"suite":"windows-utf8-manifest","languageVariants":2,"privilegesPreserved":true,"longPathSettingPreserved":true,"assemblyIdentityPreserved":true,"opaqueResourcePreserved":true,"idempotent":true}'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
