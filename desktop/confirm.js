// The question window's page (confirm.html): it shows what the shell asks
// and sends back one answer. "Don't allow" has the focus, and Escape or
// closing the window are a no.
const api =
  /** @type {{ text(): Promise<any>; answer(allowed: boolean): void; fit(height: number): void }} */ (
    /** @type {any} */ (window).archyneConfirm
  );

void api.text().then((text) => {
  const root = document.documentElement;
  root.lang = text.lang;
  root.dir = text.dir;
  if (text.theme === "light") root.dataset.theme = "light";
  document.title = text.title;
  /** @param {string} id @param {string} value */
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set("message", text.message);
  set("note", text.note);
  set("deny", text.deny);
  set("allow", text.allow);
  const rows = document.getElementById("rows");
  text.rows.forEach(
    (/** @type {{ label: string; value: string }} */ row, /** @type {number} */ i) => {
      const dt = document.createElement("dt");
      dt.textContent = row.label;
      const dd = document.createElement("dd");
      dd.textContent = row.value;
      // The secret's name and the address; the vault and the field read as words.
      if (i === 0 || i === 2) dd.className = "code";
      rows?.append(dt, dd);
    },
  );
  document.getElementById("deny")?.addEventListener("click", () => api.answer(false));
  document.getElementById("allow")?.addEventListener("click", () => api.answer(true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") api.answer(false);
  });
  document.getElementById("deny")?.focus();
  api.fit(Math.ceil(document.body.getBoundingClientRect().height));
});
