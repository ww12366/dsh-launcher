// DshLauncher.cs — DeepSeek Harness splash launcher.
//
// A windowed (no-console) WinForms splash: shows the logo and a progress bar,
// starts `dsh web` fully hidden, waits for the port to answer, then opens the
// browser. Built as /target:winexe so Windows never allocates a console.
//
// Deliberately written in C# 5 syntax: the in-box csc.exe
// (Framework64\v4.0.30319) supports /langversion up to 5 only.
//
// Build: see build.ps1 in this directory.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DshLauncher
{
    internal static class Cfg
    {
        // Defaults only — nothing here is hardcoded to a particular machine.
        // launcher.ini, sitting next to this executable, overrides any of them;
        // the dsh-launcher plugin regenerates that file on every host boot from
        // the node binary and working directory the host is actually running.
        internal const int DefaultPort = 3080;
        internal const int TimeoutSeconds = 150;

        internal static int Port = DefaultPort;

        /// Directory `dsh web` is started in; dsh treats it as the workspace
        /// root. Falls back to the user profile when unset.
        internal static string WorkspaceRoot =
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        /// Explicit node.exe. Left null, the launcher resolves `node` on PATH.
        internal static string NodeExe;

        internal static string Url { get { return "http://127.0.0.1:" + Port; } }

        internal static readonly string IniPath =
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.ini");

        /// Read launcher.ini (plain key=value lines). A missing, unreadable or
        /// malformed file is never an error: every default above still works,
        /// so deleting the file can only make the launcher more generic.
        internal static void LoadIni()
        {
            try
            {
                string[] lines = File.Exists(IniPath) ? File.ReadAllLines(IniPath) : new string[0];
                for (int i = 0; i < lines.Length; i++)
                {
                    string line = lines[i].Trim();
                    if (line.Length == 0 || line[0] == '#' || line[0] == ';') continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string key = line.Substring(0, eq).Trim();
                    string value = line.Substring(eq + 1).Trim();
                    if (value.Length == 0) continue;

                    if (string.Equals(key, "port", StringComparison.OrdinalIgnoreCase))
                    {
                        int parsed;
                        if (int.TryParse(value, out parsed) && parsed > 0 && parsed < 65536) Port = parsed;
                    }
                    else if (string.Equals(key, "nodeExe", StringComparison.OrdinalIgnoreCase))
                    {
                        NodeExe = value;
                    }
                    else if (string.Equals(key, "workspaceRoot", StringComparison.OrdinalIgnoreCase))
                    {
                        WorkspaceRoot = value;
                    }
                }
            }
            catch (Exception ex) { Log("launcher.ini ignored: " + ex.Message); }

            // Always recorded, so "which port / which node did it actually use"
            // is answerable from launcher.log without guessing.
            Log("config: port=" + Port
                + "; node=" + (NodeExe == null ? "(resolved from PATH)" : NodeExe)
                + "; cwd=" + WorkspaceRoot);
        }

        internal static readonly string HomeDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "launcher");

        internal static readonly string AppLog = Path.Combine(HomeDir, "launcher.log");
        internal static readonly string Wrapper = Path.Combine(HomeDir, "run-dsh-web.cmd");

        /// Per-launch logs kept in the launcher directory.
        private const int KeepWebLogs = 5;

        /// A fresh log path for one launch.
        ///
        /// A fixed filename does not work: `dsh` keeps its own stdout redirect
        /// open for its entire lifetime, so the next launch's `>` cannot open
        /// the file, cmd aborts that redirection, the node command never runs
        /// and the launch fails while the previous server is still healthy.
        /// One file per launch cannot collide.
        internal static string NewWebLogPath()
        {
            PruneWebLogs();
            return Path.Combine(HomeDir, "dsh-web-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");
        }

        /// Keep the launcher directory from growing without bound.
        private static void PruneWebLogs()
        {
            try
            {
                // The wider glob also retires the legacy fixed-name log.
                string[] files = Directory.GetFiles(HomeDir, "dsh-web*.log");
                // Timestamped names sort chronologically as plain strings.
                Array.Sort(files, StringComparer.OrdinalIgnoreCase);
                int remove = files.Length - KeepWebLogs + 1;
                for (int i = 0; i < remove; i++)
                {
                    try { File.Delete(files[i]); } catch { }
                }
            }
            catch { }
        }

        internal static void Log(string msg)
        {
            try
            {
                Directory.CreateDirectory(HomeDir);
                File.AppendAllText(AppLog,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine,
                    new UTF8Encoding(false));
            }
            catch { }
        }
    }

    internal sealed class SplashForm : Form
    {
        // layout, in 96-DPI pixels; scaled by _scale at paint time
        private const int BaseW = 460;
        private const int BaseH = 276;

        private readonly float _scale;
        private readonly Bitmap _logo;
        private readonly bool _preview;
        private readonly Stopwatch _clock = new Stopwatch();
        private readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer();

        // 0 = probing whether a server is already up, 1 = starting, 2 = ready, 3 = error
        private int _state;
        private double _progress;
        private string _status = "\u6b63\u5728\u51c6\u5907\u2026";
        private bool _errorMode;
        private Process _proc;

        // ping state shared with the worker thread
        private volatile bool _pingBusy;
        private volatile bool _pingOk;
        private volatile bool _pingFresh;

        private bool _closeHover;
        /// The log file this launch is writing, so "view log" opens the right one.
        private string _webLog;

        public SplashForm(bool preview)
        {
            _preview = preview;
            _logo = LoadLogo();

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                     | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Color.White;
            Text = "DeepSeek Harness";
            ShowInTaskbar = true;
            KeyPreview = true;

            try { Icon = LoadIcon(); }
            catch { }

            // Read the DPI from the desktop DC rather than CreateGraphics(): the
            // latter creates this form's handle right here, and WinForms applies
            // StartPosition at handle creation — which at that moment is still
            // the default 300x300, so it would centre that size and leave the
            // grown window visibly off-centre.
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) { _scale = g.DpiX / 96f; }

            ClientSize = new Size((int)Math.Round(BaseW * _scale), (int)Math.Round(BaseH * _scale));
            CenterOnActiveScreen();

            _timer.Interval = 180;
            _timer.Tick += OnTick;
        }

        /// <summary>
        /// Place the splash in the middle of the working area of the monitor the
        /// user is actually on — the one under the cursor, which is where they
        /// just clicked the shortcut — falling back to the primary monitor. The
        /// working area is used so the taskbar can never cover the splash.
        /// </summary>
        private void CenterOnActiveScreen()
        {
            Screen target = null;
            try { target = Screen.FromPoint(Cursor.Position); }
            catch { }
            if (target == null) target = Screen.PrimaryScreen;
            if (target == null) return;

            Rectangle area = target.WorkingArea;
            Location = new Point(
                area.X + (area.Width - Width) / 2,
                area.Y + (area.Height - Height) / 2);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Windows 11: let DWM round the corners properly (anti-aliased).
            try
            {
                int pref = 2; // DWMWCP_ROUND
                DwmSetWindowAttribute(Handle, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref pref, sizeof(int));
            }
            catch { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Cfg.Log("splash shown; scale=" + _scale.ToString("0.##"));
            _clock.Start();
            _timer.Start();
        }

        // ---------------------------------------------------------------- logic

        private void OnTick(object sender, EventArgs e)
        {
            if (_state >= 2) return;
            double sec = _clock.Elapsed.TotalSeconds;

            if (_preview)
            {
                _progress = 0.78 * (1.0 - Math.Exp(-sec / 6.0)) + 0.10;
                _status = "\u9884\u89c8\u6a21\u5f0f\uff08\u4e0d\u4f1a\u542f\u52a8\u670d\u52a1\uff09";
                Invalidate();
                return;
            }

            // Guard: if even the very first probe never returns, don't sit in the
            // initial state forever waiting on a flag the worker never sets.
            if (_state == 0 && sec > 25.0)
            {
                Fail("\u65e0\u6cd5\u8fde\u63a5 " + Cfg.Url + "\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7");
                return;
            }

            // Consume a completed probe BEFORE starting the next one. Starting a
            // ping clears the fresh flag, so reading it afterwards would discard
            // every result that landed between two ticks and the app would spin
            // on "probing" forever.
            bool probed = _pingFresh;
            bool reachable = _pingOk;
            if (probed) _pingFresh = false;

            if (probed)
            {
                if (reachable)
                {
                    if (_state == 0)
                    {
                        // The server was already up, so nobody is going to hand off a
                        // browser for us: open the UI ourselves. The ?token= is
                        // per-process and unrecoverable from outside, but the auth
                        // cookie is signed with a durable secret and lasts 30 days,
                        // so a plain origin URL authenticates in practice.
                        _status = "\u670d\u52a1\u5df2\u5728\u8fd0\u884c\uff0c\u6b63\u5728\u6253\u5f00\u6d4f\u89c8\u5668\u2026";
                        OpenBrowser();
                    }
                    else
                    {
                        // We launched it: `dsh web` opens the authenticated token URL
                        // itself, so opening a tab here would add a second, token-less
                        // request that the auth fence answers with 401.
                        _status = "\u5df2\u5c31\u7eea\uff0c\u6d4f\u89c8\u5668\u5373\u5c06\u6253\u5f00\u2026";
                    }
                    Ready();
                    return;
                }
                if (_state == 0)
                {
                    _state = 1;
                    LaunchDsh();
                    Invalidate();
                    return;
                }
            }

            if (!_pingBusy)
            {
                _pingBusy = true;
                ThreadPool.QueueUserWorkItem(delegate(object o)
                {
                    bool ok = Ping();
                    _pingOk = ok;
                    _pingFresh = true;
                    _pingBusy = false;
                });
            }

            if (_state == 1)
            {
                if (_proc != null)
                {
                    bool exited = false;
                    try { exited = _proc.HasExited; }
                    catch { }
                    if (exited && sec > 4.0)
                    {
                        Fail("\u670d\u52a1\u8fdb\u7a0b\u5df2\u9000\u51fa\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7");
                        return;
                    }
                }
                if (sec > Cfg.TimeoutSeconds)
                {
                    Fail("\u542f\u52a8\u8d85\u65f6\uff08" + Cfg.TimeoutSeconds + " \u79d2\uff09\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7");
                    return;
                }
                // ease toward 93% while waiting; the last 7% lands on ready
                _progress = 0.93 * (1.0 - Math.Exp(-sec / 11.0));
                if (_status != "\u6b63\u5728\u542f\u52a8\u672c\u5730\u670d\u52a1\u2026")
                    _status = "\u6b63\u5728\u542f\u52a8\u672c\u5730\u670d\u52a1\u2026";
                Invalidate();
            }
        }

        private void Ready()
        {
            _state = 2;
            _progress = 1.0;
            _errorMode = false;
            Invalidate();
            Cfg.Log("ready at " + Cfg.Url);
            System.Windows.Forms.Timer close = new System.Windows.Forms.Timer();
            close.Interval = 550;
            close.Tick += delegate(object s, EventArgs a)
            {
                close.Stop();
                close.Dispose();
                Close();
            };
            close.Start();
        }

        private void Fail(string message)
        {
            _state = 3;
            _errorMode = true;
            _progress = 1.0;
            _status = message;
            Cfg.Log("FAILED: " + message);
            Invalidate();
        }

        private static bool Ping()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Cfg.Url + "/");
                req.Method = "GET";
                req.Timeout = 1500;
                req.AllowAutoRedirect = false;
                req.Proxy = null;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return true;
                }
            }
            catch (WebException we)
            {
                // any HTTP status (401 included) still proves the port is listening
                if (we.Response != null) { try { we.Response.Close(); } catch { } return true; }
                return false;
            }
            catch { return false; }
        }

        private static string ResolveDshBin()
        {
            try
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string npxRoot = Path.Combine(local, "npm-cache", "_npx");
                if (!Directory.Exists(npxRoot)) return null;

                string best = null;
                DateTime bestTime = DateTime.MinValue;
                string[] dirs = Directory.GetDirectories(npxRoot);
                for (int i = 0; i < dirs.Length; i++)
                {
                    string cand = Path.Combine(dirs[i], "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                    if (!File.Exists(cand)) continue;
                    DateTime t = File.GetLastWriteTimeUtc(cand);
                    if (best == null || t > bestTime) { best = cand; bestTime = t; }
                }
                return best;
            }
            catch (Exception ex) { Cfg.Log("resolve dsh bin failed: " + ex.Message); return null; }
        }

        private void LaunchDsh()
        {
            try
            {
                Directory.CreateDirectory(Cfg.HomeDir);

                string bin = ResolveDshBin();
                string portArg = (Cfg.Port == Cfg.DefaultPort) ? "" : (" --port " + Cfg.Port);
                _webLog = Cfg.NewWebLogPath();
                string body;
                if (bin != null)
                {
                    string node = (Cfg.NodeExe != null && File.Exists(Cfg.NodeExe)) ? Cfg.NodeExe : "node";
                    Cfg.Log("launching node: " + node + " " + bin + " web" + portArg + " (log: " + _webLog + ")");
                    body = "@echo off\r\n"
                         + "echo [%DATE% %TIME%] \" " + node + " \" \"" + bin + "\" web" + portArg + " > \"" + _webLog + "\"\r\n"
                         + "\"" + node + "\" \"" + bin + "\" web" + portArg + " >> \"" + _webLog + "\" 2>&1\r\n";
                }
                else
                {
                    Cfg.Log("no cached dsh found; falling back to npx");
                    body = "@echo off\r\n"
                         + "echo [%DATE% %TIME%] npx @deepseek-ai/dsh web" + portArg + " > \"" + _webLog + "\"\r\n"
                         + "call npx.cmd --yes @deepseek-ai/dsh web" + portArg + " >> \"" + _webLog + "\" 2>&1\r\n";
                }
                File.WriteAllText(Cfg.Wrapper, body, new UTF8Encoding(false));

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe");
                psi.Arguments = "/c \"" + Cfg.Wrapper + "\"";
                psi.WorkingDirectory = Directory.Exists(Cfg.WorkspaceRoot)
                    ? Cfg.WorkspaceRoot
                    : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                _proc = Process.Start(psi);
                _status = "\u6b63\u5728\u542f\u52a8\u672c\u5730\u670d\u52a1\u2026";
            }
            catch (Exception ex)
            {
                Fail("\u542f\u52a8\u5931\u8d25\uff1a" + ex.Message);
            }
        }

        private static void OpenBrowser()
        {
            try { Process.Start(Cfg.Url); }
            catch (Exception ex) { Cfg.Log("open browser failed: " + ex.Message); }
        }

        // ---------------------------------------------------------------- paint

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            float s = _scale;
            int w = ClientSize.Width;
            int h = ClientSize.Height;

            using (LinearGradientBrush bg = new LinearGradientBrush(
                new Rectangle(0, 0, w, h), Color.White, Color.FromArgb(230, 238, 250), 90f))
            {
                g.FillRectangle(bg, 0, 0, w, h);
            }
            using (Pen pen = new Pen(Color.FromArgb(220, 229, 243), 1f))
            using (GraphicsPath border = RoundedRect(new RectangleF(0.5f, 0.5f, w - 1f, h - 1f), 12f * s))
            {
                g.DrawPath(pen, border);
            }

            if (_logo != null)
            {
                int size = (int)Math.Round(104 * s);
                g.DrawImage(_logo, new Rectangle((w - size) / 2, (int)Math.Round(22 * s), size, size));
            }

            using (StringFormat sf = new StringFormat())
            {
                sf.Alignment = StringAlignment.Center;
                sf.LineAlignment = StringAlignment.Center;

                using (Font f = new Font("Segoe UI", 21f * s, FontStyle.Bold, GraphicsUnit.Pixel))
                using (Brush b = new SolidBrush(Color.FromArgb(43, 62, 99)))
                {
                    g.DrawString("DeepSeek Harness", f, b,
                        new RectangleF(0, 134f * s, w, 28f * s), sf);
                }

                using (Font f = new Font("Segoe UI", 12.5f * s, FontStyle.Regular, GraphicsUnit.Pixel))
                using (Brush b = new SolidBrush(_errorMode
                    ? Color.FromArgb(192, 57, 43)
                    : Color.FromArgb(122, 134, 158)))
                {
                    g.DrawString(_status, f, b, new RectangleF(0, 168f * s, w, 20f * s), sf);
                }

                if (_state == 3)
                {
                    using (Font f = new Font("Segoe UI", 12f * s, FontStyle.Underline, GraphicsUnit.Pixel))
                    using (Brush b = new SolidBrush(Color.FromArgb(76, 116, 190)))
                    {
                        g.DrawString("\u67e5\u770b\u65e5\u5fd7", f, b, new RectangleF(0, 220f * s, w, 18f * s), sf);
                    }
                }
            }

            // progress bar
            float margin = 62f * s;
            float barX = margin;
            float barW = w - margin * 2f;
            float barH = 8f * s;
            float barY = 200f * s;
            float radius = barH / 2f;

            using (GraphicsPath track = RoundedRect(new RectangleF(barX, barY, barW, barH), radius))
            using (Brush tb = new SolidBrush(Color.FromArgb(228, 235, 246)))
            {
                g.FillPath(tb, track);
            }

            float fillW = barW * (float)Math.Max(0.0, Math.Min(1.0, _progress));
            if (fillW > 0.5f)
            {
                if (fillW < barH) fillW = barH;
                RectangleF fr = new RectangleF(barX, barY, fillW, barH);
                Color c1 = _errorMode ? Color.FromArgb(192, 57, 43) : Color.FromArgb(76, 116, 190);
                Color c2 = _errorMode ? Color.FromArgb(224, 122, 108) : Color.FromArgb(143, 182, 228);
                using (GraphicsPath fill = RoundedRect(fr, radius))
                using (LinearGradientBrush fb = new LinearGradientBrush(
                    new RectangleF(barX, barY, Math.Max(fillW, 1f), barH), c1, c2, 0f))
                {
                    g.FillPath(fb, fill);
                }
            }

            // close button
            RectangleF cb = CloseRect();
            if (_closeHover)
            {
                using (Brush hb = new SolidBrush(Color.FromArgb(232, 238, 248)))
                {
                    g.FillEllipse(hb, cb);
                }
            }
            using (Pen xp = new Pen(_closeHover ? Color.FromArgb(70, 86, 112) : Color.FromArgb(150, 162, 182), 1.6f * s))
            {
                float pad = cb.Width * 0.32f;
                g.DrawLine(xp, cb.Left + pad, cb.Top + pad, cb.Right - pad, cb.Bottom - pad);
                g.DrawLine(xp, cb.Right - pad, cb.Top + pad, cb.Left + pad, cb.Bottom - pad);
            }
        }

        private RectangleF CloseRect()
        {
            float s = _scale;
            float size = 26f * s;
            return new RectangleF(ClientSize.Width - size - 12f * s, 12f * s, size, size);
        }

        private static GraphicsPath RoundedRect(RectangleF r, float radius)
        {
            GraphicsPath p = new GraphicsPath();
            float d = radius * 2f;
            if (d <= 0f) { p.AddRectangle(r); return p; }
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;
            p.AddArc(r.X, r.Y, d, d, 180f, 90f);
            p.AddArc(r.Right - d, r.Y, d, d, 270f, 90f);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0f, 90f);
            p.AddArc(r.X, r.Bottom - d, d, d, 90f, 90f);
            p.CloseFigure();
            return p;
        }

        // ------------------------------------------------------------- input

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            bool hover = CloseRect().Contains(e.Location);
            if (hover != _closeHover) { _closeHover = hover; Invalidate(); }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (_closeHover) { _closeHover = false; Invalidate(); }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;

            if (CloseRect().Contains(e.Location)) { Close(); return; }

            if (_state == 3 && e.Y > 215 * _scale && e.Y < 242 * _scale)
            {
                try
                {
                    string log = _webLog;
                    if (log != null && File.Exists(log)) Process.Start("notepad.exe", "\"" + log + "\"");
                    else Process.Start("explorer.exe", "/select,\"" + Cfg.HomeDir + "\"");
                }
                catch { }
                return;
            }

            ReleaseCapture();
            SendMessage(Handle, 0xA1 /* WM_NCLBUTTONDOWN */, 0x2 /* HTCAPTION */, 0);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape) Close();
        }

        // ------------------------------------------------------------- assets

        private static Stream Resource(string name)
        {
            try { return Assembly.GetExecutingAssembly().GetManifestResourceStream(name); }
            catch { return null; }
        }

        private static Icon LoadIcon()
        {
            using (Stream s = Resource("DshIcon.ico"))
            {
                if (s != null) return new Icon(s);
            }
            string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dsh.ico");
            if (File.Exists(p)) return new Icon(p);
            return SystemIcons.Application;
        }

        private static Bitmap LoadLogo()
        {
            try
            {
                using (Stream s = Resource("DshIcon.ico"))
                {
                    if (s != null)
                    {
                        using (Icon baseIcon = new Icon(s))
                        using (Icon big = new Icon(baseIcon, new Size(256, 256)))
                        {
                            return big.ToBitmap();
                        }
                    }
                }
            }
            catch (Exception ex) { Cfg.Log("logo load failed: " + ex.Message); }
            return null;
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // ini first, so an explicit --port on the command line still wins.
            Cfg.LoadIni();

            bool preview = false;
            int n = (args == null) ? 0 : args.Length;
            for (int i = 0; i < n; i++)
            {
                string a = args[i];
                if (string.Equals(a, "--preview", StringComparison.OrdinalIgnoreCase))
                {
                    preview = true;
                }
                else if (string.Equals(a, "--port", StringComparison.OrdinalIgnoreCase) && i + 1 < n)
                {
                    int p;
                    if (int.TryParse(args[i + 1], out p) && p > 0 && p < 65536) Cfg.Port = p;
                    i++;
                }
            }

            try
            {
                Application.Run(new SplashForm(preview));
            }
            catch (Exception ex)
            {
                Cfg.Log("fatal: " + ex);
                throw;
            }
        }
    }
}
