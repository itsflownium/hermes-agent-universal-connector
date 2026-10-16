export async function openCliChats({ local, profile = "" }) {
  document.querySelector("#nectit-cli-chats")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "nectit-cli-chats";
  dialog.setAttribute("aria-labelledby", "nectit-cli-title");
  dialog.innerHTML = `<header><div><span>NECTIT · HERMES</span><h2 id="nectit-cli-title">Continue a terminal chat</h2></div><button type="button" aria-label="Close CLI chats">×</button></header>
    <p>Start a shared terminal chat with <code>./nectit cli</code>, or return to a saved CLI conversation below.</p>
    <div class="nectit-cli-fields"><label>Hermes profile<input id="nectit-cli-profile" placeholder="Current profile" autocomplete="off" spellcheck="false"></label><button type="button" id="nectit-cli-refresh">Refresh</button></div>
    <label class="nectit-cli-search">Find a chat<input id="nectit-cli-search" type="search" placeholder="Search chats" autocomplete="off"></label>
    <div id="nectit-cli-results" aria-live="polite"></div>
    <footer><strong>Already open in a standalone terminal?</strong><p>Wait for its current reply, then use <code>/exit</code> there before continuing here. Hermes protects the chat from two separate writers. Chats started with <code>./nectit cli</code> share Nectit’s backend and can stay open in both places.</p></footer>`;
  const profileInput = dialog.querySelector("#nectit-cli-profile");
  const search = dialog.querySelector("#nectit-cli-search");
  const results = dialog.querySelector("#nectit-cli-results");
  const refresh = dialog.querySelector("#nectit-cli-refresh");
  profileInput.value = profile;
  let rows = [], loading = false;
  function message(text) { results.replaceChildren(); const p = document.createElement("p"); p.textContent = text; results.append(p); }
  function paint() {
    const query = search.value.trim().toLowerCase();
    const visible = rows.filter((row) => (row.title + " " + row.id).toLowerCase().includes(query));
    if (!visible.length) { message(query ? "No matching terminal chats." : "No saved terminal chats in this profile yet. Send the first message in ./nectit cli, then refresh."); return; }
    results.replaceChildren();
    for (const row of visible) {
      const item = document.createElement("div"); item.className = "nectit-cli-row";
      const text = document.createElement("div"), title = document.createElement("strong"), detail = document.createElement("span");
      title.textContent = row.title;
      detail.textContent = `${row.profile || "Current profile"} · ${row.messageCount} messages · ${row.id}`;
      text.append(title, detail);
      const open = document.createElement("button"); open.textContent = "Continue";
      open.onclick = async () => {
        if (loading) return;
        loading = true; open.disabled = true;
        try {
          const value = await local("/local/cli-open", { id: row.id, profile: row.profile || "" });
          const next = new URL(value.url, location.origin);
          dialog.close();
          if (next.pathname === location.pathname && next.search === location.search) location.hash = next.hash;
          else location.assign(next.href);
        } catch (problem) { message(problem.message); }
        finally { loading = false; open.disabled = false; }
      };
      item.append(text, open); results.append(item);
    }
  }
  async function load() {
    if (loading) return;
    loading = true; refresh.disabled = true; message("Loading terminal chats…");
    try {
      const selected = profileInput.value.trim();
      const value = await local("/local/cli-sessions" + (selected ? "?profile=" + encodeURIComponent(selected) : ""));
      rows = value.sessions; paint();
    } catch (problem) { message(problem.message); }
    finally { loading = false; refresh.disabled = false; }
  }
  dialog.querySelector("header > button").onclick = () => dialog.close();
  dialog.addEventListener("close", () => dialog.remove());
  refresh.onclick = load;
  search.oninput = paint;
  profileInput.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); void load(); } };
  document.body.append(dialog); dialog.showModal();
  await load();
}
