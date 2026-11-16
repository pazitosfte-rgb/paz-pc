const { app, BrowserWindow, Menu, shell, dialog, session } = require("electron");
const path = require("path");

// URL de la web app publicada (misma que usa la app Android).
// Si cambia, editar solo esta linea.
const URL_APP = "https://script.google.com/macros/s/AKfycbz-4Cgsi5D0-ho3JhQkiHF46VQ6eogns3KhWAbFM-TU-mUQ8Wi91WFKxikZ_dYe8pSbWw/exec";

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function esPropia(u) {
  try {
    const h = new URL(u).hostname;
    return h === "script.google.com" || h.endsWith(".googleusercontent.com") ||
           h === "accounts.google.com" || h.endsWith(".google.com") || h.endsWith(".gstatic.com");
  } catch (e) { return false; }
}

function crear() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    show: false, title: "Pazitos POS", autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { partition: "persist:pazitos", contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.maximize();
  win.once("ready-to-show", () => win.show());
  Menu.setApplicationMenu(null);

  win.loadURL(URL_APP);

  win.webContents.on("did-fail-load", (e, code, desc, url, principal) => {
    if (!principal || code === -3) return;
    win.loadFile(path.join(__dirname, "offline.html"), { query: { e: desc } });
  });

  // Enlaces externos (WhatsApp, Instagram, etc.) -> navegador por defecto.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return { action: "allow" };
    if (esPropia(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (ev, url) => {
    if (url.startsWith("file:")) return;
    if (!esPropia(url)) { ev.preventDefault(); shell.openExternal(url); }
  });

  // Atajos: F5 recarga, Ctrl+Shift+R recarga forzada, F11 pantalla completa, Ctrl +/- zoom
  win.webContents.on("before-input-event", (ev, i) => {
    if (i.type !== "keyDown") return;
    const c = i.control || i.meta;
    if (i.key === "F5" || (c && i.key.toLowerCase() === "r")) {
      ev.preventDefault();
      if (win.webContents.getURL().startsWith("file:")) win.loadURL(URL_APP);
      else i.shift ? win.webContents.reloadIgnoringCache() : win.webContents.reload();
    } else if (i.key === "F11") {
      ev.preventDefault(); win.setFullScreen(!win.isFullScreen());
    } else if (c && (i.key === "+" || i.key === "=")) {
      ev.preventDefault(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
    } else if (c && i.key === "-") {
      ev.preventDefault(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
    } else if (c && i.key === "0") {
      ev.preventDefault(); win.webContents.setZoomLevel(0);
    }
  });

  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  // Descargas (PDF, etc.): pedir donde guardar y abrir al terminar.
  session.fromPartition("persist:pazitos").on("will-download", (ev, item) => {
    const destino = path.join(app.getPath("downloads"), item.getFilename());
    const r = dialog.showSaveDialogSync(win, { defaultPath: destino });
    if (!r) { item.cancel(); return; }
    item.setSavePath(r);
    item.once("done", (e, estado) => {
      if (estado === "completed") shell.showItemInFolder(r);
    });
  });
  crear();
  app.on("activate", () => { if (!win) crear(); });
});

app.on("window-all-closed", () => app.quit());
