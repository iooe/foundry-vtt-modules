const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const modules = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(modules, file), 'utf8');

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/fixture') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><head></head><body></body></html>'); }
    const file = path.resolve(modules, decodeURIComponent(req.url.split('?')[0]).replace(/^\/modules\//, ''));
    if (!file.startsWith(modules + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    const type = { '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.jpg': 'image/jpeg' }[path.extname(file)] || 'application/octet-stream';
    res.setHeader('Content-Type', type); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.UC_BROWSER ? { executablePath: process.env.UC_BROWSER } : {}) });
  const errors = [];
  try {
    for (const moduleId of ['dialogue-stage', 'city-viewer', 'mind-palace', 'chronicle']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      page.on('pageerror', error => errors.push(`${moduleId}: ${error.message}`));
      await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
      await page.setContent('<!doctype html><html lang="ru"><head></head><body style="margin:0"></body></html>');
      const translations = fs.existsSync(path.join(modules, moduleId, 'lang/ru.json')) ? JSON.parse(read(`${moduleId}/lang/ru.json`)) : {};
      await page.evaluate(({ moduleId, translations }) => {
        const callbacks = new Map(), values = new Map(), registered = new Map();
        window.Hooks = {
          once(name, fn) { (callbacks.get(name) || callbacks.set(name, []).get(name)).push(fn); },
          on() {}, callAll() {}, call() { return true; },
        };
        window.runInit = async () => { for (const fn of callbacks.get('init') || []) await fn(); };
        window.runReady = async () => { for (const fn of callbacks.get('ready') || []) await fn(); };
        window.runEditorReady = async () => { await callbacks.get('ready')[0](); };
        const gm = { id: 'gm', name: 'Мастер', isGM: true, active: true, flags: {}, getFlag() { return undefined; } };
        const rollTable = { uuid: 'RollTable.greeting', name: 'Приветствия торговца', documentName: 'RollTable' };
        const quest = { uuid: 'JournalEntry.quests.JournalEntryPage.quest', name: 'Пропавший курьер', documentName: 'JournalEntryPage', parent: { name: 'Квесты' } };
        const users = new Map([['gm', gm]]); users.contents = [gm]; users.activeGM = gm;
        window.game = {
          user: gm, users, i18n: { lang: 'ru', localize: key => translations[key] || key },
          modules: new Map(['unicanvas', 'city-viewer', 'dialogue-stage', 'mind-palace', 'chronicle'].map(id => [id, { id, active: true }])),
          tables: { contents: [rollTable] }, actors: { contents: [] }, journal: { contents: [{ uuid: 'JournalEntry.quests', documentName: 'JournalEntry', name: 'Квесты', pages: [quest] }] },
          settings: { settings: registered, register(id,key,config) { registered.set(`${id}.${key}`,config); values.set(`${id}.${key}`,structuredClone(config.default)); }, registerMenu() {}, get(id,key) { return structuredClone(values.get(`${id}.${key}`)); }, async set(id,key,value) { values.set(`${id}.${key}`,structuredClone(value)); registered.get(`${id}.${key}`)?.onChange?.(value); return value; } },
          socket: { emit() {}, on() {} }, keybindings: { register() {} }, system: { id: 'test' },
        };
        window.foundry = { utils: { deepClone: value => structuredClone(value), randomID: () => crypto.randomUUID().replaceAll('-','').slice(0,12), mergeObject: (a,b) => ({ ...a, ...b }) }, applications: { apps: {} } };
        window.ui = { notifications: { info() {}, warn() {}, error(message) { throw Error(message); } }, controls: { render() {} } };
        window.canvas = { ready: false }; window.CONFIG = {};
        window.fromUuid = async uuid => [rollTable,quest].find(doc => doc.uuid === uuid) || null;
      }, { moduleId, translations });
      for (const style of ['unicanvas/styles/unicanvas.css', 'unicanvas/styles/ui-kit.css', `${moduleId}/styles/${moduleId}.css`]) await page.addStyleTag({ content: read(style) });
      await page.addScriptTag({ content: read('unicanvas/scripts/unicanvas.js') });
      await page.addScriptTag({ content: read('unicanvas/scripts/editor-ui.js') });
      await page.addScriptTag({ content: `(() => { ${read(`${moduleId}/scripts/main.js`)}\nwindow.fixture = { openEditor, renderEditor, S }; })();` });
      await page.evaluate(async ({ moduleId, translations }) => {
        await runInit();
        await runEditorReady();
        if (moduleId === 'city-viewer') { fixture.S.locale = 'ru'; fixture.S.messages = translations; }
        await window.fixture.openEditor();
      }, { moduleId, translations });
      const editor = page.locator('#cv-editor, #ds-editor, #mp-editor, #chronicle-editor');
      await editor.locator('[data-uc-search]').waitFor();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#cv-editor, #ds-editor, #mp-editor, #chronicle-editor')).backgroundColor === 'rgb(255, 255, 255)');
      assert.equal(await editor.locator('[data-uc-theme]').count(), 1);
      assert.equal(await editor.locator('[data-uc-menu="more"]').count(), 1);
      await page.keyboard.press('Control+k');
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-uc-search')), true);
      await editor.locator('[data-uc-search]').fill('zzzz-unmatched');
      assert.equal(await editor.locator('[data-uc-search-empty]').isVisible(), true);
      await page.evaluate(() => window.fixture.renderEditor());
      await page.waitForFunction(() => document.querySelector('[data-uc-search]')?.value === 'zzzz-unmatched');
      await editor.locator('[data-uc-search]').focus();
      await page.keyboard.press('Escape');
      assert.equal(await editor.locator('[data-uc-search]').inputValue(), '');
      await editor.locator('[data-uc-menu="more"] > summary').click();
      assert.equal(await editor.locator('[data-uc-menu="more"]').getAttribute('open'), '');
      await page.keyboard.press('Escape');
      assert.equal(await editor.locator('[data-uc-menu="more"]').getAttribute('open'), null);
      if (moduleId === 'dialogue-stage') {
        await editor.locator('[data-ed="scene-settings"]').click();
        const input = editor.locator('[data-scene-field="greetingTableUuid"]');
        await input.locator('..').locator('.uc-reference-tools select').waitFor();
        await input.locator('..').locator('.uc-reference-tools select').selectOption('RollTable.greeting');
        assert.equal(await input.inputValue(), 'RollTable.greeting');
        assert.equal(await page.evaluate(() => fixture.S.draft.scenes.find(scene => scene.id === fixture.S.scene).greetingTableUuid), 'RollTable.greeting');
        await input.fill('Actor.wrong'); await input.dispatchEvent('change');
        await page.waitForFunction(() => document.querySelector('[data-scene-field="greetingTableUuid"]').getAttribute('aria-invalid') === 'true');
        await input.locator('..').locator('.uc-reference-tools select').selectOption('RollTable.greeting');
        await editor.locator('.ds-graph-node').first().locator('header').click();
        await editor.locator('.ds-choice-rules').first().evaluate(element => { element.open = true; });
        const questInput = editor.locator('[data-choice-field="questUuid"]').first();
        await questInput.locator('..').locator('.uc-reference-tools select').selectOption('JournalEntry.quests.JournalEntryPage.quest');
        assert.equal(await page.evaluate(() => fixture.S.draft.scenes.find(scene => scene.id === fixture.S.scene).nodes.find(node => node.id === fixture.S.selected).choices[0].questUuid), 'JournalEntry.quests.JournalEntryPage.quest');
        await questInput.evaluate(element => {
          const data = new DataTransfer(); data.setData('text/plain', JSON.stringify({ uuid: 'JournalEntry.quests.JournalEntryPage.quest' }));
          element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
        });
        await page.waitForFunction(() => document.querySelector('[data-choice-field="questUuid"]').getAttribute('aria-invalid') === 'false');
        await editor.locator('[data-ed="scene-settings"]').click();
        await page.keyboard.press('Control+s');
        await page.waitForFunction(() => document.querySelector('[data-uc-save]')?.dataset.state === 'saved', null, { timeout: 3000 }).catch(async error => {
          console.error(await page.evaluate(() => ({ state: fixture.S.editor.dataset.ucSaveState, status: document.querySelector('[data-uc-save]')?.outerHTML, focus: document.activeElement.outerHTML.slice(0,180) })), errors);
          throw error;
        });
      }
      await page.evaluate(() => {
        const editor = fixture.S.editor;
        UniCanvasEditor.setSaveState(editor, 'dirty'); const revision = UniCanvasEditor.revision(editor);
        UniCanvasEditor.setSaveState(editor, 'saving', revision);
        UniCanvasEditor.setSaveState(editor, 'dirty'); UniCanvasEditor.setSaveState(editor, 'saved', revision);
        if (editor.dataset.ucSaveState !== 'dirty') throw Error('Older save hid newer changes');
        UniCanvasEditor.setSaveState(editor, 'saved');
      });
      if (process.env.UC_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.UC_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.UC_SCREENSHOT_DIR, `${moduleId}-light.png`), animations: 'disabled' });
      }
      await editor.locator('[data-uc-theme]').click();
      await page.waitForFunction(() => document.documentElement.dataset.ucEditorTheme === 'dark');
      if (process.env.UC_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.UC_SCREENSHOT_DIR, `${moduleId}-dark.png`), animations: 'disabled' });
      await page.setViewportSize({ width: 720, height: 960 });
      assert.equal(await editor.locator('[data-uc-search]').isVisible(), true);
      const widths = await page.evaluate(() => ({ body: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(widths.scroll <= widths.body + 1, `${moduleId} overflows the viewport`);
      assert.ok(await editor.isVisible());
      await page.evaluate(() => { const editor = fixture.S.editor; UniCanvasEditor.unmount(editor); editor.remove(); });
      await page.close();
      console.log(`${moduleId}: theme, search, menus and responsive layout ok`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
