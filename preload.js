// Puente seguro entre la barra superior (barra.html) y el programa
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("barra", {
  zoom: (d) => ipcRenderer.send("barra:zoom", d),
  refrescar: () => ipcRenderer.send("barra:refrescar"),
  onZoom: (cb) => ipcRenderer.on("zoom", (e, v) => cb(v))
});
