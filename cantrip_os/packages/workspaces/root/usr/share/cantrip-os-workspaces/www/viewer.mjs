import RFB from "./core/rfb.js";
const screen = document.querySelector("#screen");
const status = document.querySelector("#status");
const clip = document.querySelector("#clip");
const dialog = document.querySelector("#clip-dialog");
const clipboard = document.querySelector("#clipboard");
const send = document.querySelector("#send");
const id = new URLSearchParams(location.search).get("id");
document.querySelector("#workspace-name").textContent =
  id ?? "Unknown workspace";
document.title = `${id ?? "Unknown workspace"} · CantripOS`;
let rfb, timer;
async function connect() {
  clearTimeout(timer);
  status.textContent = "Connecting…";
  let record;
  try {
    if (!id) throw new Error("Select a workspace first");
    const response = await fetch(`/api/show?id=${encodeURIComponent(id)}`);
    record = await response.json();
    if (!response.ok) throw new Error(record.error ?? "Workspace unavailable");
    if (record.status !== "running")
      throw new Error("Desktop stopped. Start it from Workspaces.");
  } catch (error) {
    status.textContent = error.message;
    clipboard.disabled = send.disabled = true;
    timer = setTimeout(connect, 2000);
    return;
  }
  rfb = new RFB(
    screen,
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/websockify?token=${encodeURIComponent(id + "." + record.view_token)}`,
  );
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.background = "#000000";
  rfb.addEventListener("connect", () => {
    status.textContent = "";
    clipboard.disabled = send.disabled = false;
  });
  rfb.addEventListener("disconnect", () => {
    clipboard.disabled = send.disabled = true;
    status.textContent = "Reconnecting…";
    timer = setTimeout(connect, 1500);
  });
  rfb.addEventListener("clipboard", (event) => {
    clip.value = event.detail.text;
  });
}
clipboard.onclick = () => dialog.showModal();
send.onclick = () => {
  rfb.clipboardPasteFrom(clip.value);
  dialog.close();
};
document.querySelector("#close").onclick = () => dialog.close();
dialog.addEventListener("close", () => rfb?.focus());

// Let the host browser handle F11 instead of forwarding it to the guest.
for (const event of ["keydown", "keyup"]) {
  window.addEventListener(
    event,
    (event) => {
      if (event.key === "F11") event.stopImmediatePropagation();
    },
    true,
  );
}
const fullscreen = matchMedia("(display-mode: fullscreen)");
function syncFullscreen() {
  document.documentElement.classList.toggle(
    "browser-fullscreen",
    fullscreen.matches ||
      Boolean(document.fullscreenElement) ||
      window.fullScreen === true,
  );
}
fullscreen.addEventListener("change", syncFullscreen);
document.addEventListener("fullscreenchange", syncFullscreen);
window.addEventListener("resize", syncFullscreen);
syncFullscreen();
connect();
