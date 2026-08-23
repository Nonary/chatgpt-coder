const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const MAX_ENTRIES = 500;
const MAX_DISCOVERY_DEPTH = 4;
const MAX_DISCOVERY_RESULTS = 200;
const WINDOWS_PICKER_WINDOW_HELPER = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Patchwork {
  public static class FolderPickerWindow {
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
      void BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);
      void GetParent(out IShellItem parent);
      void GetDisplayName(uint displayNameType, out IntPtr name);
      void GetAttributes(uint mask, out uint attributes);
      void Compare(IShellItem item, uint hint, out int order);
    }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog {
      [PreserveSig] int Show(IntPtr owner);
      void SetFileTypes(uint count, IntPtr filters);
      void SetFileTypeIndex(uint index);
      void GetFileTypeIndex(out uint index);
      void Advise(IntPtr events, out uint cookie);
      void Unadvise(uint cookie);
      void SetOptions(uint options);
      void GetOptions(out uint options);
      void SetDefaultFolder(IShellItem folder);
      void SetFolder(IShellItem folder);
      void GetFolder(out IShellItem folder);
      void GetCurrentSelection(out IShellItem item);
      void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
      void GetFileName(out IntPtr name);
      void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
      void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
      void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
      void GetResult(out IShellItem item);
      void AddPlace(IShellItem item, uint position);
      void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
      void Close(int result);
      void SetClientGuid(ref Guid guid);
      void ClearClientData();
      void SetFilter(IntPtr filter);
      void GetResults(out IntPtr items);
      void GetSelectedItems(out IntPtr items);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo {
      public int Size;
      public Rect Monitor;
      public Rect Work;
      public int Flags;
    }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern int GetClassName(IntPtr window, StringBuilder className, int capacity);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid interfaceId, out IShellItem item);

    private static void FocusNextDialog() {
      uint processId = (uint) Process.GetCurrentProcess().Id;
      HashSet<IntPtr> existing = new HashSet<IntPtr>();
      EnumWindows(delegate(IntPtr window, IntPtr parameter) {
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (owner == processId) existing.Add(window);
        return true;
      }, IntPtr.Zero);

      Thread worker = new Thread(delegate() {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (elapsed.ElapsedMilliseconds < 10000) {
          IntPtr dialog = IntPtr.Zero;
          EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            StringBuilder className = new StringBuilder(64);
            GetClassName(window, className, className.Capacity);
            if (owner == processId && !existing.Contains(window) && IsWindowVisible(window) && className.ToString() == "#32770") {
              dialog = window;
              return false;
            }
            return true;
          }, IntPtr.Zero);

          if (dialog != IntPtr.Zero) {
            ShowWindow(dialog, 9);
            IntPtr monitor = MonitorFromWindow(dialog, 2);
            MonitorInfo info = new MonitorInfo();
            info.Size = Marshal.SizeOf(info);
            if (GetMonitorInfo(monitor, ref info)) {
              int workWidth = info.Work.Right - info.Work.Left;
              int workHeight = info.Work.Bottom - info.Work.Top;
              int width = workWidth * 92 / 100;
              int height = workHeight * 92 / 100;
              int x = info.Work.Left + (workWidth - width) / 2;
              int y = info.Work.Top + (workHeight - height) / 2;
              SetWindowPos(dialog, new IntPtr(-1), x, y, width, height, 0x0040);
            }
            SetForegroundWindow(dialog);
            SetWindowPos(dialog, new IntPtr(-2), 0, 0, 0, 0, 0x0013);
            return;
          }
          Thread.Sleep(25);
        }
      });
      worker.IsBackground = true;
      worker.Start();
    }

    public static string Show(string initialDirectory) {
      IntPtr previousDpiContext = IntPtr.Zero;
      try {
        try { previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { }

        Type dialogType = Type.GetTypeFromCLSID(new Guid("dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7"));
        IFileOpenDialog dialog = (IFileOpenDialog) Activator.CreateInstance(dialogType);
        try {
          uint options;
          dialog.GetOptions(out options);
          dialog.SetOptions(options | 0x00000020 | 0x00000040 | 0x00000800 | 0x02000000);
          dialog.SetTitle("Select a Git repository folder");

          if (Directory.Exists(initialDirectory)) {
            Guid shellItemId = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            IShellItem initialFolder;
            if (SHCreateItemFromParsingName(initialDirectory, IntPtr.Zero, ref shellItemId, out initialFolder) == 0) {
              try { dialog.SetFolder(initialFolder); }
              finally { Marshal.FinalReleaseComObject(initialFolder); }
            }
          }

          FocusNextDialog();
          int result = dialog.Show(IntPtr.Zero);
          if (result == unchecked((int) 0x800704C7)) return null;
          if (result < 0) Marshal.ThrowExceptionForHR(result);

          IShellItem selectedFolder;
          dialog.GetResult(out selectedFolder);
          try {
            IntPtr selectedPath;
            selectedFolder.GetDisplayName(0x80058000, out selectedPath);
            try { return Marshal.PtrToStringUni(selectedPath); }
            finally { Marshal.FreeCoTaskMem(selectedPath); }
          } finally {
            Marshal.FinalReleaseComObject(selectedFolder);
          }
        } finally {
          Marshal.FinalReleaseComObject(dialog);
        }
      } finally {
        if (previousDpiContext != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpiContext);
      }
    }
  }
}`;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.cache', '.next', '.nuxt', 'vendor',
]);

function expandHome(value, homeDirectory) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return homeDirectory;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDirectory, raw.slice(2));
  return raw;
}

class FsService {
  constructor({
    homeDirectory = os.homedir(), platform = process.platform, execute = execFileAsync,
  } = {}) {
    this.homeDirectory = homeDirectory;
    this.platform = platform;
    this.execute = execute;
  }

  async selectDirectory() {
    let command;
    let args;
    let options = {};
    if (this.platform === 'win32') {
      command = 'powershell.exe';
      args = [
        '-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-Command',
        [
          '$ErrorActionPreference = \'Stop\'',
          `Add-Type -TypeDefinition '${WINDOWS_PICKER_WINDOW_HELPER.replaceAll("'", "''")}'`,
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
          '$selectedPath = [Patchwork.FolderPickerWindow]::Show($env:PATCHWORK_PICKER_INITIAL_DIRECTORY)',
          'if ($selectedPath) {',
          '  [Console]::Out.Write($selectedPath)',
          '}',
        ].join('; '),
      ];
      options = {
        windowsHide: true,
        env: { ...process.env, PATCHWORK_PICKER_INITIAL_DIRECTORY: this.homeDirectory },
      };
    } else if (this.platform === 'darwin') {
      command = 'osascript';
      args = ['-e', 'POSIX path of (choose folder with prompt "Select a Git repository folder")'];
    } else {
      command = 'zenity';
      args = ['--file-selection', '--directory', '--title=Select a Git repository folder'];
    }

    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await this.execute(command, args, options));
    } catch (error) {
      const canceled = (this.platform === 'darwin' && error.code === 1)
        || (this.platform !== 'win32' && this.platform !== 'darwin' && error.code === 1);
      if (canceled) return null;
      throw new Error(`The operating system folder picker could not be opened: ${error.message}`);
    }
    if (String(stderr || '').trim()) {
      throw new Error(`The operating system folder picker could not be opened: ${String(stderr).trim()}`);
    }
    const selectedPath = String(stdout || '').trim();
    if (!selectedPath) return null;
    const resolved = await fs.realpath(path.resolve(selectedPath));
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
    return resolved;
  }

  async roots() {
    const roots = [{ label: 'Home', path: this.homeDirectory }];
    if (this.platform === 'win32') {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`;
        try {
          await fs.access(drive);
          roots.push({ label: `${letter}:`, path: drive });
        } catch {
          // The drive letter is not mounted.
        }
      }
    } else {
      roots.push({ label: 'Filesystem', path: '/' });
    }
    return roots;
  }

  async isRepository(directory) {
    try {
      const stat = await fs.stat(path.join(directory, '.git'));
      return stat.isDirectory() || stat.isFile();
    } catch {
      return false;
    }
  }

  async browse(targetPath) {
    const requested = expandHome(targetPath, this.homeDirectory) || this.homeDirectory;
    const resolved = await fs.realpath(path.resolve(requested));
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const directories = [];
    for (const entry of entries) {
      if (directories.length >= MAX_ENTRIES) break;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.config') continue;
      const childPath = path.join(resolved, entry.name);
      if (entry.isSymbolicLink()) {
        const childStat = await fs.stat(childPath).catch(() => null);
        if (!childStat?.isDirectory()) continue;
      }
      directories.push({
        name: entry.name,
        path: childPath,
        repository: await this.isRepository(childPath),
      });
    }
    directories.sort((left, right) => left.name.localeCompare(right.name));

    const parent = path.dirname(resolved);
    return {
      path: resolved,
      parent: parent === resolved ? null : parent,
      repository: await this.isRepository(resolved),
      truncated: directories.length >= MAX_ENTRIES,
      directories,
      roots: await this.roots(),
    };
  }

  async discoverRepositories(targetPath, maxDepth = MAX_DISCOVERY_DEPTH) {
    const root = await fs.realpath(path.resolve(expandHome(targetPath, this.homeDirectory)));
    const found = [];
    const visit = async (directory, depth) => {
      if (found.length >= MAX_DISCOVERY_RESULTS || depth > maxDepth) return;
      if (await this.isRepository(directory)) {
        found.push({ name: path.basename(directory), path: directory });
        return;
      }
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(directory, entry.name), depth + 1);
      }
    };
    await visit(root, 0);
    return found;
  }

  // Replaces Electron's shell.showItemInFolder.
  async reveal(targetPath) {
    const resolved = path.resolve(expandHome(targetPath, this.homeDirectory));
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) throw new Error(`Path not found: ${resolved}`);
    const directory = stat.isDirectory() ? resolved : path.dirname(resolved);
    if (this.platform === 'win32') {
      // explorer.exe exits with a non-zero status even on success.
      await execFileAsync('explorer.exe', [stat.isDirectory() ? directory : `/select,${resolved}`])
        .catch(() => {});
      return true;
    }
    if (this.platform === 'darwin') {
      await execFileAsync('open', stat.isDirectory() ? [directory] : ['-R', resolved]);
      return true;
    }
    await execFileAsync('xdg-open', [directory]);
    return true;
  }
}

module.exports = { FsService, expandHome, SKIPPED_DIRECTORIES };
