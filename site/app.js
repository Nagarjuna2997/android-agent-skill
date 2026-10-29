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

const recipeList = document.querySelector("#recipe-list"),
  recipeSearch = document.querySelector("#recipe-search");
function renderRecipes() {
  recipeList.replaceChildren();
  const query = recipeSearch.value.toLowerCase();
  const rows = (window.capabilityCatalog ?? []).filter((c) =>
    (c.id + " " + c.name + " " + c.category + " " + c.summary)
      .toLowerCase()
      .includes(query),
  );
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "commandrow";
    const link = document.createElement("a");
    link.href =
      "https://github.com/Nagarjuna2997/android-agent-skill/blob/main/" +
      row.path;
    const code = document.createElement("code");
    code.textContent = row.id;
    link.append(code);
    const desc = document.createElement("p");
    desc.textContent = row.summary;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = row.category.toUpperCase();
    el.append(link, desc, badge);
    recipeList.append(el);
  }
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "No matching recipes. Try a broader term.";
    recipeList.append(empty);
  }
}
recipeSearch.addEventListener("input", renderRecipes);
renderRecipes();
