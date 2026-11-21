const { app, BrowserWindow, WebContentsView, Menu, shell, dialog, session, ipcMain } = require("electron");
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
    const alto = await wc.executeJavaScript("new Promise(function(r){var fin=function(){r(Math.ceil(document.body.getBoundingClientRect().height));};var im=Array.prototype.filter.call(document.images,function(i){return !i.complete;});if(!im.length)return fin();var n=im.length;im.forEach(function(i){i.onload=i.onerror=function(){if(--n<=0)fin();};});setTimeout(fin,4000);})");
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

// ---- Barra superior propia (zoom + refrescar) y vista de la aplicacion ----
const ALTO_BARRA = 36;
let vista = null; // WebContentsView con la web app (debajo de la barra)

function rutaCfg() { return path.join(app.getPath("userData"), "config.json"); }
function leerCfg() { try { return JSON.parse(fs.readFileSync(rutaCfg(), "utf8")); } catch (e) { return {}; } }
function guardarCfg(o) { try { fs.writeFileSync(rutaCfg(), JSON.stringify(Object.assign(leerCfg(), o))); } catch (e) {} }

function acomodarVista() {
  if (!win || win.isDestroyed() || !vista) return;
  const [w, h] = win.getContentSize();
  vista.setBounds({ x: 0, y: ALTO_BARRA, width: w, height: Math.max(0, h - ALTO_BARRA) });
}
function zoomActual() { return vista && !vista.webContents.isDestroyed() ? vista.webContents.getZoomFactor() : 1; }
function avisarZoom() { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("zoom", Math.round(zoomActual() * 100)); }
function cambiarZoom(d) {
  if (!vista) return;
  let f = d === "reset" ? 1 : Math.round((zoomActual() + d) * 100) / 100;
  f = Math.min(2.5, Math.max(0.5, f));
  vista.webContents.setZoomFactor(f); guardarCfg({ zoom: f }); avisarZoom();
}
function recargar(forzado) {
  if (!vista) return;
  const wc = vista.webContents;
  if (wc.getURL().startsWith("file:")) wc.loadURL(URL_APP);
  else if (forzado) wc.reloadIgnoringCache(); else wc.reload();
}

function crear() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    show: false, title: "Pazitos POS", autoHideMenuBar: true, backgroundColor: "#0f766e",
    icon: path.join(__dirname, "build", "icon.png"),
    // Barra de titulo propia: los botones de minimizar/maximizar/cerrar los dibuja Windows a la derecha
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0f766e", symbolColor: "#ffffff", height: ALTO_BARRA },
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "barra.html"));
  win.webContents.on("did-finish-load", avisarZoom);

  // La web app va en una vista debajo de la barra
  vista = new WebContentsView({ webPreferences: { partition: "persist:pazitos", contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.contentView.addChildView(vista);
  ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore"].forEach(ev => win.on(ev, acomodarVista));
  win.maximize();
  acomodarVista();
  win.once("ready-to-show", () => { acomodarVista(); win.show(); });

  const wc = vista.webContents;
  wc.loadURL(URL_APP);
  wc.on("did-finish-load", () => { wc.setZoomFactor(leerCfg().zoom || 1); avisarZoom(); });

  wc.on("did-fail-load", (e, code, desc, url, principal) => {
    if (!principal || code === -3) return;
    wc.loadFile(path.join(__dirname, "offline.html"), { query: { e: desc } });
  });

  // Enlaces externos (WhatsApp, Instagram, etc.) -> navegador por defecto.
  wc.setWindowOpenHandler(({ url }) => {
    // Impresion directa de tiquets (80 mm): la pagina abre una ventana oculta "about:blank#print80"
    if (url.indexOf("#print80") !== -1) return { action: "allow", overrideBrowserWindowOptions: { show: false, width: 340, height: 700, autoHideMenuBar: true } };
    if (url.startsWith("blob:") || url.startsWith("data:")) return { action: "allow" };
    if (esPropia(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (ev, url) => {
    if (url.startsWith("file:")) return;
    if (!esPropia(url)) { ev.preventDefault(); shell.openExternal(url); }
  });

  // Atajos: F5 recarga, Ctrl+Shift+R recarga forzada, F11 pantalla completa, Ctrl +/- zoom, Ctrl 0 zoom normal
  wc.on("before-input-event", (ev, i) => {
    if (i.type !== "keyDown") return;
    const c = i.control || i.meta;
    if (i.key === "F5" || (c && i.key.toLowerCase() === "r")) { ev.preventDefault(); recargar(i.shift); }
    else if (i.key === "F11") { ev.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if (c && (i.key === "+" || i.key === "=")) { ev.preventDefault(); cambiarZoom(0.1); }
    else if (c && i.key === "-") { ev.preventDefault(); cambiarZoom(-0.1); }
    else if (c && i.key === "0") { ev.preventDefault(); cambiarZoom("reset"); }
  });

  // Ventana oculta de impresion: cuando la pagina le pone el titulo __PRINT80__ se imprime sin mostrar dialogo
  wc.on("did-create-window", (child, details) => {
    if (String(details.url || "").indexOf("#print80") === -1) return;
    let hecho = false;
    child.webContents.on("page-title-updated", (e, title) => {
      if (hecho || title !== "__PRINT80__") return;
      hecho = true; imprimir80(child);
    });
    setTimeout(() => { if (!hecho && !child.isDestroyed()) child.close(); }, 15000);
  });

  win.on("closed", () => { try { if (vista && !vista.webContents.isDestroyed()) vista.webContents.close(); } catch (e) {} vista = null; win = null; });
}

// Botones de la barra superior (solo se aceptan ordenes de la propia barra)
ipcMain.on("barra:zoom", (e, d) => { if (win && e.sender === win.webContents) cambiarZoom(d === "reset" ? "reset" : (Number(d) || 0)); });
ipcMain.on("barra:refrescar", (e) => { if (win && e.sender === win.webContents) recargar(false); });

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
