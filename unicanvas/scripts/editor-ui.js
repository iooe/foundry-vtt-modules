/* Shared authoring controls. Game data stays in the owning module. */
(() => {
  const ROOTS = '#cv-editor, #ds-editor, #mp-editor, #chronicle-editor';
  const sessions = new Map();
  const config = {
    'cv-editor': { panel: '.cv-scene', items: '.cv-cities > button, .cv-screens > button, .cv-layers > button', toolbar: ':scope > header > nav', attr: 'data-act', add: ['newscreen', 'addpoi', 'add'], more: ['export', 'import'], extra: '[data-template-open], [data-preset-action="library"]' },
    'ds-editor': { panel: '.ds-library', items: '.ds-scene-list > button, .ds-character-list > button', toolbar: ':scope > header > nav', attr: 'data-ed', more: ['export', 'import', 'copy-uuid', 'presets'] },
    'mp-editor': { panel: '.mp-board-list', items: '.mp-board-buttons > button', toolbar: ':scope > header > nav', attr: 'data-act', add: ['person', 'document', 'clue', 'note', 'text'], more: ['export', 'import', 'copy-uuid', 'deductions'] },
    'chronicle-editor': { panel: '.ch-editor-sidebar', items: '.ch-case-list > button', toolbar: '.ch-editor-toolbar', attr: 'data-editor-action', more: ['export', 'import', 'copy-uuid', 'retry', 'reset'] },
  };
  const label = (ru, en) => game.i18n.lang === 'ru' ? ru : en;
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/ё/g, 'е').trim();
  const saveSelector = '[data-act="save"], [data-ed="save"], [data-editor-action="save"]';
  const uuidSelector = 'input[data-scene-field="greetingTableUuid"], input[data-character-field="actorUuid"], input[data-choice-field="questUuid"], input[data-object="actorUuid"], input[data-object="journalUuid"]';
  let theme = 'light';

  const revision = editor => Number(editor?.dataset?.ucSaveRevision || 0);
  function setSaveState(editor, state, expected = null) {
    if (!editor) return;
    if (expected !== null && revision(editor) !== expected) return;
    if (state === 'dirty') editor.dataset.ucSaveRevision = String(revision(editor) + 1);
    editor.dataset.ucSaveState = state;
    const status = editor.querySelector('[data-uc-save]');
    if (!status) return;
    const messages = { dirty: label('Есть изменения', 'Unsaved'), saving: label('Сохранение…', 'Saving…'), saved: label('Сохранено', 'Saved'), error: label('Не сохранено', 'Save failed') };
    status.dataset.state = state;
    status.textContent = messages[state] || '';
  }

  function applyTheme(value) {
    theme = value === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.ucEditorTheme = theme;
    for (const editor of sessions.keys()) {
      const button = editor.querySelector('[data-uc-theme]');
      if (!button) continue;
      button.textContent = theme === 'light' ? '◐' : '◑';
      button.title = theme === 'light' ? label('Тёмная тема', 'Dark theme') : label('Светлая тема', 'Light theme');
      button.setAttribute('aria-label', button.title);
    }
  }

  function menu(toolbar, state, key, title, buttons) {
    if (!buttons.length || toolbar.querySelector(`[data-uc-menu="${key}"]`)) return;
    const details = document.createElement('details');
    details.dataset.ucMenu = key;
    const summary = document.createElement('summary');
    summary.textContent = title;
    summary.setAttribute('aria-label', key === 'more' ? label('Другие действия', 'More actions') : title);
    const list = document.createElement('div');
    list.className = 'uc-editor-menu';
    details.append(summary, list);
    toolbar.insertBefore(details, toolbar.querySelector(saveSelector));
    for (const button of buttons) list.append(button);
    details.addEventListener('toggle', () => {
      if (details.open) toolbar.querySelectorAll('[data-uc-menu]').forEach(other => { if (other !== details) other.open = false; });
    });
    list.addEventListener('click', event => {
      if (!event.target.closest('button')?.disabled) details.open = false;
    });
  }

  function filter(editor, state) {
    const query = normalize(state.query);
    let shown = 0;
    for (const item of editor.querySelectorAll(state.config.items)) {
      const matches = !query || normalize(item.textContent).includes(query);
      item.classList.toggle('uc-search-hidden', !matches);
      if (matches) shown++;
    }
    const empty = editor.querySelector('[data-uc-search-empty]');
    if (empty) empty.hidden = !query || shown > 0;
    const clear = editor.querySelector('[data-uc-search-clear]');
    if (clear) clear.hidden = !state.query;
  }

  function refresh(editor, state) {
    if (!editor.isConnected) return;
    const panel = editor.querySelector(state.config.panel);
    if (panel && !panel.querySelector('[data-uc-search]')) {
      const box = document.createElement('div');
      box.className = 'uc-editor-search';
      const input = document.createElement('input');
      input.type = 'search'; input.dataset.ucSearch = '';
      input.placeholder = label('Поиск', 'Search'); input.value = state.query;
      input.setAttribute('aria-label', label('Поиск в списках', 'Search lists'));
      input.title = label('Поиск · Ctrl+K', 'Search · Ctrl+K');
      const clear = document.createElement('button');
      clear.type = 'button'; clear.dataset.ucSearchClear = ''; clear.textContent = '×';
      clear.setAttribute('aria-label', label('Очистить поиск', 'Clear search'));
      clear.addEventListener('click', event => { event.stopPropagation(); state.query = ''; input.value = ''; filter(editor, state); input.focus(); });
      input.addEventListener('input', event => { event.stopPropagation(); state.query = input.value; filter(editor, state); });
      const empty = document.createElement('p');
      empty.dataset.ucSearchEmpty = ''; empty.setAttribute('role', 'status');
      empty.textContent = label('Ничего не найдено', 'No results'); empty.hidden = true;
      box.append(input, clear); panel.prepend(box); panel.append(empty);
    }
    filter(editor, state);
    const toolbar = editor.querySelector(state.config.toolbar);
    if (toolbar) {
      const buttons = names => names.map(name => toolbar.querySelector(`:scope > button[${state.config.attr}="${name}"]`)).filter(Boolean);
      menu(toolbar, state, 'add', label('Добавить', 'Add'), buttons(state.config.add || []));
      menu(toolbar, state, 'more', '···', [...buttons(state.config.more), ...toolbar.querySelectorAll(state.config.extra || '[data-uc-never]')]);
      if (!toolbar.querySelector('[data-uc-theme]')) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.ucTheme = '';
        button.addEventListener('click', async event => {
          event.stopPropagation(); applyTheme(theme === 'light' ? 'dark' : 'light');
          try { await game.settings.set('unicanvas', 'editorTheme', theme); }
          catch (error) { ui.notifications.error(error.message); }
        });
        toolbar.insertBefore(button, toolbar.querySelector('[data-uc-menu="more"]'));
        applyTheme(theme);
      }
      if (!toolbar.querySelector('.cv-save-status, .ch-save-state, [data-uc-save]')) {
        const status = document.createElement('span'); status.dataset.ucSave = '';
        status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        toolbar.insertBefore(status, toolbar.querySelector(saveSelector));
        setSaveState(editor, editor.dataset.ucSaveState || 'saved');
      }
    }
    for (const input of editor.querySelectorAll(uuidSelector)) {
      if (input.dataset.ucReference !== undefined) continue;
      input.dataset.ucReference = '';
      input.placeholder = label('Выберите или перетащите документ', 'Select or drop a document');
      const tools = document.createElement('span'); tools.className = 'uc-reference-tools';
      const select = document.createElement('select');
      select.setAttribute('aria-label', label('Выбрать документ', 'Select document'));
      const none = document.createElement('option'); none.value = ''; none.textContent = label('Выбрать…', 'Select…'); select.append(none);
      const kind = input.dataset.sceneField ? 'RollTable' : input.dataset.characterField || input.dataset.object === 'actorUuid' ? 'Actor' : input.dataset.object === 'journalUuid' ? 'JournalEntry' : 'JournalEntryPage';
      const documents = kind === 'RollTable' ? game.tables?.contents || [] : kind === 'Actor' ? game.actors?.contents || [] : (game.journal?.contents || []).filter(entry => !entry.flags?.unicanvas?.registry).flatMap(entry => kind === 'JournalEntry' ? [entry, ...entry.pages] : [...entry.pages]);
      for (const doc of [...documents].sort((a,b) => a.name.localeCompare(b.name))) {
        const option = document.createElement('option'); option.value = doc.uuid;
        option.textContent = doc.documentName === 'JournalEntryPage' ? `${doc.parent.name} / ${doc.name}` : doc.name;
        select.append(option);
      }
      const status = document.createElement('small'); status.setAttribute('role', 'status');
      const open = document.createElement('button'); open.type = 'button'; open.textContent = '↗';
      open.setAttribute('aria-label', label('Открыть документ', 'Open document')); open.disabled = !input.value;
      let revision = 0;
      const validate = async () => {
        const current = ++revision, value = input.value.trim();
        if (!value) { status.textContent = ''; input.removeAttribute('aria-invalid'); open.disabled = true; return; }
        let doc = null; try { doc = await fromUuid(value); } catch (_) { /* invalid or removed reference */ }
        if (current !== revision || !input.isConnected) return;
        const valid = (doc?.documentName === kind || kind === 'JournalEntry' && doc?.documentName === 'JournalEntryPage') && (!input.dataset.choiceField || !doc.pack);
        status.textContent = valid ? doc.name : label('Документ не найден или неверный тип', 'Document missing or wrong type');
        input.setAttribute('aria-invalid', String(!valid)); open.disabled = !valid;
      };
      const use = value => {
        input.focus(); input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true })); void validate();
      };
      select.addEventListener('change', event => { event.stopPropagation(); if (select.value) use(select.value); select.value = ''; });
      open.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        try {
          const doc = await fromUuid(input.value.trim());
          if (input.dataset.choiceField && game.modules.get('simple-quest')?.active && ui.simpleQuest?.openToPage) await ui.simpleQuest.openToPage(doc.uuid);
          else if (doc?.sheet) doc.sheet.render(true);
        } catch (error) { ui.notifications.error(error.message); }
      });
      input.addEventListener('change', () => void validate());
      input.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); });
      input.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation();
        try { const data = JSON.parse(event.dataTransfer.getData('text/plain')); if (data.uuid) use(data.uuid); } catch (_) { /* non-document drop */ }
      });
      tools.append(select, open, status); input.after(tools); void validate();
    }
  }

  function mount(editor) {
    if (sessions.has(editor) || !config[editor.id]) return;
    const state = { config: config[editor.id], query: '', frame: null, observer: null };
    sessions.set(editor, state);
    editor.tabIndex = -1;
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-modal', 'true');
    if (!editor.hasAttribute('aria-label') && !editor.hasAttribute('aria-labelledby'))
      editor.setAttribute('aria-label', editor.querySelector('header strong, .ch-editor-brand h1')?.textContent || editor.id);
    state.observer = new MutationObserver(() => {
      if (state.frame !== null) return;
      state.frame = requestAnimationFrame(() => { state.frame = null; refresh(editor, state); });
    });
    state.observer.observe(editor, { childList: true, subtree: true });
    editor.addEventListener('keydown', event => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && ['k', 's'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key.toLowerCase() === 'k') { const input = editor.querySelector('[data-uc-search]'); input?.focus(); input?.select(); }
        else editor.querySelector(saveSelector)?.click();
      } else if (event.key === 'Escape') {
        const menu = editor.querySelector('[data-uc-menu][open]');
        if (menu) { event.preventDefault(); event.stopImmediatePropagation(); menu.open = false; menu.querySelector('summary').focus(); }
        else if (event.target.matches('[data-uc-search]') && state.query) { event.preventDefault(); event.stopImmediatePropagation(); state.query = ''; event.target.value = ''; filter(editor, state); }
      }
    }, true);
    editor.addEventListener('click', event => {
      if (!event.target.closest('[data-uc-menu]')) editor.querySelectorAll('[data-uc-menu][open]').forEach(menu => { menu.open = false; });
    }, true);
    refresh(editor, state);
    if (!editor.contains(document.activeElement)) editor.focus({ preventScroll: true });
  }
  function unmount(editor) {
    const state = sessions.get(editor); if (!state) return;
    state.observer.disconnect(); if (state.frame !== null) cancelAnimationFrame(state.frame);
    sessions.delete(editor);
  }
  globalThis.UniCanvasEditor = Object.freeze({ mount, unmount, setSaveState, revision, normalize });
  Hooks.once('init', () => game.settings.register('unicanvas', 'editorTheme', {
    name: label('Тема редакторов', 'Editor theme'), scope: 'client', config: true, type: String, default: 'light',
    choices: { light: label('Светлая', 'Light'), dark: label('Тёмная', 'Dark') }, onChange: applyTheme,
  }));
  Hooks.once('ready', () => {
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = 'modules/unicanvas/styles/editor.css'; document.head.append(style);
    applyTheme(game.settings.get('unicanvas', 'editorTheme'));
    document.querySelectorAll(ROOTS).forEach(mount);
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches(ROOTS)) mount(node);
        for (const node of record.removedNodes) if (sessions.has(node)) unmount(node);
      }
    }).observe(document.body, { childList: true });
  });
})();
