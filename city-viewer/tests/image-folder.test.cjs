const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/main.js'), 'utf8');
const start = source.indexOf('async function refreshImageFolder(');
const end = source.indexOf('function moveObjectLayer(', start);
let target = { kind: 'poi', imageFolder: 'portraits', imageSource: 's3', imageBucket: 'campaign', markerImage: 'portraits/old.png' };
let files = ['portraits/new.webp', 'portraits/readme.txt', 'portraits/old.png'];
let browsed, undo = 0, saves = 0, pending;
const state = { editor: {} };
const refresh = vm.runInNewContext(`${source.slice(start, end)}; refreshImageFolder`, {
  S: state, selected: () => target, editScreen: () => target,
  foundry: { applications: { apps: {} } },
  FilePicker: { async browse(...args) { browsed = args; if (pending) await pending; return { files }; } },
  recordUndo: () => undo++, renderEditor() {}, autosave: () => saves++,
  tr: (_, fallback) => fallback, ui: { notifications: { warn() {}, error(message) { throw Error(message); } } },
});
(async () => {
  await refresh();
  assert.equal(browsed[0], 's3'); assert.equal(browsed[2].bucket, 'campaign');
  assert.equal(target.markerImage, 'portraits/old.png');
  assert.equal(target.imagePool.join(','), 'portraits/new.webp,portraits/old.png');
  files = ['portraits/replacement.jpg']; await refresh();
  assert.equal(target.markerImage, files[0]);
  let release; pending = new Promise(resolve => release = resolve);
  const previous = target, request = refresh();
  target = { imageFolder: 'elsewhere' }; release(); await request;
  assert.equal(previous.imagePool[0], 'portraits/replacement.jpg');
  assert.equal(undo, 2); assert.equal(saves, 2);
  console.log('City Viewer folders: source, filtering, selection and stale request checks ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
