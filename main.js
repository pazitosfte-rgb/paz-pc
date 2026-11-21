const { app, BrowserWindow, Menu, shell, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");

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

// Impresora de tiquets: si existe userData/impresora.json con {"nombre":"EPSON TM-T20IIIL Receipt"} se usa esa;
// si no, se busca una impresora Epson TM / "Receipt"; si no hay, la predeterminada de Windows.
async function elegirImpresora(wc) {
  try {
    const f = path.join(app.getPath("userData"), "impresora.json");
    if (fs.existsSync(f)) { const n = JSON.parse(fs.readFileSync(f, "utf8")).nombre; if (n) return n; }
  } catch (e) {}
  try {
    const lista = await wc.getPrintersAsync();
    const r = lista.find(p => /TM-?T20|receipt/i.test(p.name)) || lista.find(p => /epson.*TM|TM-?T/i.test(p.name));
    if (r) return r.name;
  } catch (e) {}
  return "";
}
async function imprimir80(child) {
  const wc = child.webContents;
  try {
    const alto = await wc.executeJavaScript("new Promise(function(r){var fin=function(){r(Math.ceil(document.documentElement.scrollHeight));};var im=Array.prototype.filter.call(document.images,function(i){return !i.complete;});if(!im.length)return fin();var n=im.length;im.forEach(function(i){i.onload=i.onerror=function(){if(--n<=0)fin();};});setTimeout(fin,4000);})");
    const nombre = await elegirImpresora(wc);
    const micras = Math.max(40000, Math.round(alto * 25400 / 96) + 4000); // alto del contenido en micrones + margen
    wc.print({ silent: true, printBackground: true, deviceName: nombre, margins: { marginType: "none" }, pageSize: { width: 80000, height: micras } },
      (ok, motivo) => {
        if (!ok) dialog.showErrorBox("No se pudo imprimir", "Impresora: " + (nombre || "predeterminada de Windows") + "\n" + (motivo || "error desconocido"));
        if (!child.isDestroyed()) child.close();
      });
  } catch (e) {
    dialog.showErrorBox("No se pudo imprimir", String(e && e.message || e));
    if (!child.isDestroyed()) child.close();
  }
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
    // Impresion directa de tiquets (80 mm): la pagina abre una ventana oculta "about:blank#print80"
    if (url.indexOf("#print80") !== -1) return { action: "allow", overrideBrowserWindowOptions: { show: false, width: 340, height: 700, autoHideMenuBar: true } };
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

  // Ventana oculta de impresion: cuando la pagina le pone el titulo __PRINT80__ se imprime sin mostrar dialogo
  win.webContents.on("did-create-window", (child, details) => {
    if (String(details.url || "").indexOf("#print80") === -1) return;
    let hecho = false;
    child.webContents.on("page-title-updated", (e, title) => {
      if (hecho || title !== "__PRINT80__") return;
      hecho = true; imprimir80(child);
    });
    setTimeout(() => { if (!hecho && !child.isDestroyed()) child.close(); }, 15000);
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
