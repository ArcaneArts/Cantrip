param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Build-time resource editing only. Preserve existing execution privileges,
# compatibility declarations and every other resource; no OS locale changes.
Add-Type -ReferencedAssemblies 'System.dll','System.Xml.dll' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Xml;

public static class CantripUtf8Manifest {
    const uint LoadAsData = 0x00000002;
    static readonly IntPtr ManifestType = new IntPtr(24);
    static readonly IntPtr ManifestName = new IntPtr(1);
    const string Asm = "urn:schemas-microsoft-com:asm.v3";
    const string Settings = "http://schemas.microsoft.com/SMI/2019/WindowsSettings";
    delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr context);

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr context);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr BeginUpdateResourceW(string path, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] bytes, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool EndUpdateResourceW(IntPtr update, bool discard);

    static byte[] EnableUtf8(byte[] existing) {
        var document = new XmlDocument();
        document.PreserveWhitespace = true;
        document.XmlResolver = null;
        if (existing == null) {
            document.LoadXml("<assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\" manifestVersion=\"1.0\"/>");
        } else {
            using (var input = new MemoryStream(existing)) document.Load(input);
        }
        var nodes = document.GetElementsByTagName("activeCodePage", Settings);
        if (nodes.Count > 0) {
            bool changed = false;
            foreach (XmlNode node in nodes) {
                if (node.InnerText != "UTF-8") { node.InnerText = "UTF-8"; changed = true; }
            }
            if (!changed) return null;
        } else {
            var manager = new XmlNamespaceManager(document.NameTable);
            manager.AddNamespace("a", Asm);
            var root = document.DocumentElement;
            var application = root.SelectSingleNode("a:application", manager);
            if (application == null) application = root.AppendChild(document.CreateElement("application", Asm));
            var settings = application.SelectSingleNode("a:windowsSettings", manager);
            if (settings == null) settings = application.AppendChild(document.CreateElement("windowsSettings", Asm));
            settings.AppendChild(document.CreateElement("activeCodePage", Settings)).InnerText = "UTF-8";
        }
        using (var output = new MemoryStream()) {
            using (var writer = XmlWriter.Create(output, new XmlWriterSettings { Encoding = new UTF8Encoding(false) })) document.Save(writer);
            return output.ToArray();
        }
    }

    public static bool Apply(string path) {
        var module = LoadLibraryExW(path, IntPtr.Zero, LoadAsData);
        if (module == IntPtr.Zero) throw new Win32Exception();
        var updates = new Dictionary<ushort, byte[]>();
        try {
            var languages = new List<ushort>();
            LanguageCallback collect = (m, t, n, language, context) => { languages.Add(language); return true; };
            if (!EnumResourceLanguagesW(module, ManifestType, ManifestName, collect, IntPtr.Zero)) {
                int error = Marshal.GetLastWin32Error();
                if (error != 1812 && error != 1813 && error != 1814) throw new Win32Exception(error);
            }
            GC.KeepAlive(collect);
            if (languages.Count == 0) updates.Add(0, EnableUtf8(null));
            foreach (ushort language in languages) {
                var resource = FindResourceExW(module, ManifestType, ManifestName, language);
                if (resource == IntPtr.Zero) throw new Win32Exception();
                uint length = SizeofResource(module, resource);
                if (length == 0) throw new Win32Exception();
                var loaded = LoadResource(module, resource);
                if (loaded == IntPtr.Zero) throw new Win32Exception();
                var pointer = LockResource(loaded);
                if (pointer == IntPtr.Zero) throw new Win32Exception();
                var bytes = new byte[checked((int)length)];
                Marshal.Copy(pointer, bytes, 0, bytes.Length);
                var changed = EnableUtf8(bytes);
                if (changed != null) updates.Add(language, changed);
            }
        } finally { FreeLibrary(module); }
        if (updates.Count == 0) return false;
        var update = BeginUpdateResourceW(path, false);
        if (update == IntPtr.Zero) throw new Win32Exception();
        try {
            foreach (var entry in updates) {
                if (!UpdateResourceW(update, ManifestType, ManifestName, entry.Key, entry.Value, (uint)entry.Value.Length)) throw new Win32Exception();
            }
            bool saved = EndUpdateResourceW(update, false);
            update = IntPtr.Zero;
            if (!saved) throw new Win32Exception();
        } finally { if (update != IntPtr.Zero) EndUpdateResourceW(update, true); }
        return true;
    }
}
'@

$changed = 0
Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.exe' | ForEach-Object {
    if ([CantripUtf8Manifest]::Apply($_.FullName)) { $changed++ }
}
Write-Output "Enabled per-process UTF-8 manifests in $changed packaged executables."
