const list = document.querySelector("#workspaces");
const message = document.querySelector("#message");
const form = document.querySelector("#create");
let busy = false;
let snapshot;
async function api(command, id) {
  const response = await fetch(
    `/api/${command}`,
    id === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Workspace request failed");
  return value;
}
function element(tag, text, className) {
  const value = document.createElement(tag);
  value.textContent = text;
  if (className) value.className = className;
  return value;
}
async function action(command, id) {
  if (busy) return;
  busy = true;
  form.querySelector("button").disabled = true;
  message.textContent = `${command === "open" ? "Opening" : command === "stop" ? "Stopping" : "Restarting"} ${id}…`;
  for (const button of list.querySelectorAll("button")) button.disabled = true;
  try {
    await api(command, id);
    message.textContent = "";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    busy = false;
    form.querySelector("button").disabled = false;
    snapshot = undefined;
    await refresh();
  }
}
async function refresh() {
  if (busy) return;
  try {
    const rows = await api("list");
    if (busy) return;
    if (message.textContent.startsWith("Cannot reach workspace service:"))
      message.textContent = "";
    const next = JSON.stringify(rows);
    if (snapshot === next) return;
    snapshot = next;
    const nodes = rows.map((row) => {
      const card = element("section", "", "workspace");
      const details = element("div", "", "details");
      details.append(
        element("strong", row.id),
        element(
          "p",
          `${row.status === "running" ? "Desktop running" : "Desktop stopped"} · ${row.user}`,
        ),
      );
      if (row.error) details.append(element("p", row.error, "error"));
      card.append(details);
      if (row.status === "running") {
        const link = element("a", "View desktop");
        link.href = `/desktop.html?id=${encodeURIComponent(row.id)}`;
        link.target = "_blank";
        link.rel = "noopener";
        card.append(link);
      }
      for (const command of row.status === "running"
        ? ["restart", "stop"]
        : ["open"]) {
        const button = element(
          "button",
          command === "open"
            ? "Start desktop"
            : command === "stop"
              ? "Stop"
              : "Restart",
        );
        button.onclick = () => action(command, row.id);
        card.append(button);
      }
      return card;
    });
    list.replaceChildren(...nodes);
    if (!rows.length)
      list.append(element("p", "Create a workspace to get started."));
  } catch (error) {
    message.textContent = `Cannot reach workspace service: ${error.message}`;
  }
}
form.onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await api("create", new FormData(form).get("name"));
    form.reset();
    message.textContent = "";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    busy = false;
    button.disabled = false;
    await refresh();
  }
};
await refresh();
setInterval(refresh, 3000);
