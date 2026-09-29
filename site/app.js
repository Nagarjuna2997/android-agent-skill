const list = document.querySelector("#command-list"),
  search = document.querySelector("#search");
function render() {
  list.replaceChildren();
  const query = search.value.toLowerCase();
  const rows = (window.commandInventory ?? []).filter((o) =>
    (o.command + " " + o.description).toLowerCase().includes(query),
  );
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "commandrow";
    const code = document.createElement("code");
    code.textContent = "android-agent " + row.command;
    const desc = document.createElement("p");
    desc.textContent = row.description;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = row.destructive
      ? "CONFIRMATION"
      : row.mutates
        ? "CHANGES STATE"
        : "READ";
    el.append(code, desc, badge);
    list.append(el);
  }
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "No matching commands. Try a broader term.";
    list.append(empty);
  }
}
search.addEventListener("input", render);
render();
for (const button of document.querySelectorAll("[data-copy]"))
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(
        document.getElementById(button.dataset.copy).textContent,
      );
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select text to copy";
    }
  });
