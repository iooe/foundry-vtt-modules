/* Foundry document links for suite entities. Journals are an index, not a second editor. */
(() => {
  const MOD = "unicanvas";
  const sources = {
    "city-viewer": ["city", "presets"],
    "dialogue-stage": ["scene", "presets"],
    "mind-palace": ["project"],
    chronicle: ["project"],
  };
  const queues = new Map(), timers = new Map();
  const copy = (v) => foundry.utils.deepClone(v);
  const escape = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const label = (ru, en) => game.i18n.lang === "ru" ? ru : en;
  const primary = () => game.user?.isGM && (game.users?.activeGM?.id === game.user.id ||
    (!game.users?.activeGM && [...(game.users?.contents || [])].filter(u => u.active && u.isGM).sort((a,b) => a.id.localeCompare(b.id))[0]?.id === game.user.id));
  const entries = () => game.journal?.contents || [];
  const meta = doc => doc?.flags?.[MOD]?.entity;
  const keyOf = (setting, path) => JSON.stringify([setting, ...path]);
  function collect(moduleId, setting, project) {
    const result = [];
    const walk = (value, path = [], parentName = "") => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.id) walk(child, [...path, String(child.id)], parentName);
        return;
      }
      const name = String(value.name || value.title || value.label || value.line || value.text || value.id || parentName).slice(0, 140);
      if (value.id) {
        const data = Object.fromEntries(Object.entries(value).map(([field, content]) => [field,
          Array.isArray(content) && content.some(child => child?.id) ? content.map(child => ({ id: child.id })) : copy(content)]));
        result.push({ key: keyOf(setting, path), moduleId, setting, path, name, data });
      }
      for (const [field, children] of Object.entries(value)) {
        if (Array.isArray(children) && children.some(child => child?.id)) walk(children, [...path, field], name);
      }
    };
    walk(project);
    return result;
  }
  function list(moduleId) {
    return entries().filter(j => j.flags?.[MOD]?.registry === moduleId).flatMap(j =>
      [...j.pages].filter(p => meta(p) && !meta(p).archived).map(p => ({ uuid: p.uuid, name: p.name, ...copy(meta(p)), data: undefined })));
  }
  async function sync(moduleId) {
    if (!primary() || !game.modules.get(moduleId)?.active || !globalThis.JournalEntry) return [];
    const rows = [];
    for (const setting of sources[moduleId] || []) {
      if (!game.settings.settings.has(`${moduleId}.${setting}`)) continue;
      rows.push(...collect(moduleId, setting, game.settings.get(moduleId, setting)));
    }
    let journal = entries().find(j => j.flags?.[MOD]?.registry === moduleId);
    if (!rows.length && !journal) return [];
    if (!journal) journal = await JournalEntry.create({
      name: game.modules.get(moduleId)?.title || moduleId,
      ownership: { default: 0 }, flags: { [MOD]: { registry: moduleId } },
    });
    const existing = new Map([...journal.pages].filter(p => meta(p)).map(p => [meta(p).key, p]));
    const create = [], update = [], active = new Set();
    for (const row of rows) {
      active.add(row.key);
      const old = existing.get(row.key);
      const entity = { ...row, archived: false };
      if (old && JSON.stringify(meta(old)) === JSON.stringify(entity)) continue;
      const data = {
        name: row.name,
        type: "text", ownership: { default: 0 },
        text: { format: 1, content: `<h2>${escape(row.name)}</h2><p>${escape(row.data.line || row.data.description || row.data.hint || "")}</p><p><button type="button" data-uc-entity="${escape(row.key)}" data-uc-module="${escape(moduleId)}">${label("Открыть в редакторе", "Open in editor")}</button></p>` },
        flags: { [MOD]: { entity } },
      };
      if (old) update.push({ _id: old.id, ...data });
      else create.push(data);
    }
    for (const [key, page] of existing) if (!active.has(key) && !meta(page).archived)
      update.push({ _id: page.id, [`flags.${MOD}.entity.archived`]: true });
    // Batches keep the socket payload bounded; unchanged pages are never rewritten.
    for (let i = 0; i < create.length; i += 40) await journal.createEmbeddedDocuments("JournalEntryPage", create.slice(i, i + 40));
    for (let i = 0; i < update.length; i += 40) await journal.updateEmbeddedDocuments("JournalEntryPage", update.slice(i, i + 40));
    Hooks.callAll("unicanvas.documentsSynced", moduleId);
    return list(moduleId);
  }
  function ensure(moduleId) {
    const task = (queues.get(moduleId) || Promise.resolve()).catch(() => {}).then(() => sync(moduleId));
    queues.set(moduleId, task);
    return task;
  }
  function schedule(moduleId) {
    clearTimeout(timers.get(moduleId));
    timers.set(moduleId, setTimeout(() => ensure(moduleId).catch(error => {
      console.error(`${MOD} | Document index`, error);
      ui.notifications.error(label("Не удалось сохранить UUID документов. Повторите сохранение.", "Document UUIDs could not be saved. Save again to retry."));
    }), 1000));
  }
  function uuid(moduleId, path, setting = sources[moduleId]?.[0]) {
    const key = keyOf(setting, path);
    return list(moduleId).find(row => row.key === key)?.uuid || "";
  }
  async function resolve(ref) {
    const doc = await fromUuid(ref);
    if (!doc || !doc.testUserPermission(game.user, "OBSERVER")) return null;
    const entity = meta(doc);
    return entity && !entity.archived ? { uuid: doc.uuid, ...copy(entity) } : null;
  }
  async function open(ref) {
    if (!game.user.isGM) return false;
    const entity = await resolve(ref);
    if (!entity) return false;
    const api = game.modules.get(entity.moduleId)?.api;
    if (api?.editEntity) return api.editEntity(entity.path, entity.setting);
    return api?.openEditor?.();
  }
  async function copyUuid(moduleId, path, setting) {
    await ensure(moduleId);
    const ref = uuid(moduleId, path, setting);
    if (!ref) throw new Error(label("Документ ещё не создан.", "Document is not available yet."));
    await (game.clipboard?.copyPlainText ? game.clipboard.copyPlainText(ref) : navigator.clipboard.writeText(ref));
    ui.notifications.info(label("UUID скопирован", "UUID copied"));
    return ref;
  }
  globalThis.UniCanvasDocuments = Object.freeze({ list, ensure, uuid, resolve, open, copyUuid, collect });
  Hooks.on("updateSetting", setting => {
    for (const [moduleId, settings] of Object.entries(sources))
      if (settings.some(key => setting.key === `${moduleId}.${key}`)) schedule(moduleId);
  });
  Hooks.once("ready", () => {
    for (const moduleId of Object.keys(sources)) if (game.modules.get(moduleId)?.active) schedule(moduleId);
    document.addEventListener("click", event => {
      const button = event.target.closest?.("[data-uc-entity][data-uc-module]");
      if (!button) return;
      event.preventDefault();
      const item = list(button.dataset.ucModule).find(row => row.key === button.dataset.ucEntity);
      if (item) void open(item.uuid).catch(error => ui.notifications.error(error.message));
    });
  });
})();
