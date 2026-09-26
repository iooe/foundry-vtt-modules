const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

(async () => {
const base = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(base, "scripts", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(base, "styles", "chronicle.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(base, "module.json"), "utf8"));
const hooks = new Map();
const hookCalls = [];
const socketHandlers = new Map();
const registrations = new Map();
const values = new Map();
let random = 0;
const integrations = { city: 0, mind: 0, dialogue: 0 };
let mindAvailable = false;
let dialogueThrowAfterWrite = false;
const dialogueValues = { "courier-lead": 0, score: 10 };
let cityLocations = [
  { cityId: "silver-reach", screenId: "district-map", pointId: "north-workshops" },
];
const testConsole = Object.create(console);
testConsole.warn = (...args) => {
  if (dialogueThrowAfterWrite && String(args[0]).includes("consequence failed")) return;
  console.warn(...args);
};

const gm = { id: "gm", name: "GM", isGM: true, active: true, character: null };
const player = { id: "player", name: "Player", isGM: false, active: true, character: null };
const users = new Map([[gm.id, gm], [player.id, player]]);
users.contents = [gm, player];

const modules = new Map([
  ["chronicle", { id: "chronicle", active: true, api: null }],
  ["unicanvas", { id: "unicanvas", active: true, api: { version: "2.4.0" } }],
  ["city-viewer", {
    id: "city-viewer",
    active: true,
    api: {
      getProject() {
        return { cities: cityLocations.reduce((cities, point) => {
          let city = cities.find((item) => item.id === point.cityId);
          if (!city) { city = { id: point.cityId, screens: [] }; cities.push(city); }
          let screen = city.screens.find((item) => item.id === point.screenId);
          if (!screen) { screen = { id: point.screenId, objects: [] }; city.screens.push(screen); }
          screen.objects.push({ id: point.pointId, kind: "poi" });
          return cities;
        }, []) };
      },
      async revealPoint() { integrations.city += 1; return true; },
    },
  }],
  ["mind-palace", {
    id: "mind-palace",
    active: true,
    api: {
      getBoards() {
        return [{ id: "ashcroft-formula", nodes: [{ id: "silver-burn", title: "Silver burn" }] }];
      },
      async revealEvidence() { integrations.mind += 1; return mindAvailable; },
    },
  }],
  ["dialogue-stage", {
    id: "dialogue-stage",
    active: true,
    api: {
      getProject() {
        return { variables: Object.keys(dialogueValues).map((id) => ({ id })) };
      },
      getStoryState() { return { variables: { ...dialogueValues } }; },
      async setVariable(id, value) {
        dialogueValues[id] = value;
        integrations.dialogue += 1;
        if (dialogueThrowAfterWrite) throw new Error("simulated lost acknowledgement");
        return { variables: { [id]: value } };
      },
    },
  }],
]);

const hookApi = {
  on(name, callback) {
    const list = hooks.get(name) || [];
    list.push({ callback, once: false });
    hooks.set(name, list);
  },
  once(name, callback) {
    const list = hooks.get(name) || [];
    list.push({ callback, once: true });
    hooks.set(name, list);
  },
  callAll(name, ...args) {
    hookCalls.push({ name, args });
    for (const entry of [...(hooks.get(name) || [])]) entry.callback(...args);
  },
};

async function runHook(name, ...args) {
  const entries = [...(hooks.get(name) || [])];
  hooks.set(name, entries.filter((entry) => !entry.once));
  for (const entry of entries) await entry.callback(...args);
}

const documentStub = {
  body: { classList: { contains() { return false; }, add() {}, remove() {}, toggle() { return false; } }, append() {} },
  createElement() {
    return {
      classList: { add() {}, remove() {} },
      dataset: {},
      setAttribute() {},
      addEventListener() {},
      append() {},
      remove() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      click() {},
    };
  },
};

const sandbox = {
  console: testConsole,
  structuredClone,
  Blob,
  URL,
  CSS: { escape: String },
  document: documentStub,
  window: { confirm: () => true },
  setTimeout,
  clearTimeout,
  foundry: {
    utils: {
      deepClone: structuredClone,
      randomID(length = 16) {
        return (`test${++random}`).padEnd(length, "0").slice(0, length);
      },
    },
  },
  Hooks: hookApi,
  game: {
    user: gm,
    users,
    modules,
    i18n: { localize: (key) => key },
    settings: {
      register(moduleId, key, config) {
        const full = `${moduleId}.${key}`;
        registrations.set(full, config);
        if (!values.has(full)) values.set(full, structuredClone(config.default));
      },
      get(moduleId, key) { return values.get(`${moduleId}.${key}`); },
      async set(moduleId, key, value) {
        const full = `${moduleId}.${key}`;
        values.set(full, structuredClone(value));
        registrations.get(full)?.onChange?.(structuredClone(value));
        return value;
      },
    },
    socket: {
      on(topic, callback) { socketHandlers.set(topic, callback); },
      emit() {},
    },
  },
  ui: {
    notifications: { info() {}, warn() {}, error() {} },
    sidebar: { changeTab() {}, expand() {} },
  },
  addEventListener() {},
};
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
new vm.Script(`${source}\n;globalThis.__chronicleTest={exampleProject,normalizeProject,normalizeState,validPermutation,positionCount,applyOrder,applySubmission,retryConsequences,resetTimeline,prepareEffect,effectFingerprint,reconcileStateAfterProjectEdit,saveDraft,onSocket,closeViewer,S};`, {
  filename: "chronicle/scripts/main.js",
}).runInContext(context);

await runHook("init");
assert.equal(registrations.get("chronicle.project").scope, "world");
assert.equal(registrations.get("chronicle.state").scope, "world");
assert.equal(registrations.get("chronicle.visible").scope, "world");
await runHook("ready");

const api = modules.get("chronicle").api;
assert.equal(api.version, manifest.version);
for (const method of [
  "open", "close", "openEditor", "show", "hide", "getProject", "getPublicProject",
  "getState", "getPublicState",
  "setOrder", "submit", "resetTimeline", "retryConsequences", "replaceProject",
  "importProject", "exportProject", "validateProject",
]) assert.equal(typeof api[method], "function", `missing API method ${method}`);
assert.ok(socketHandlers.has("module.chronicle"));
assert.ok(hookCalls.some((entry) => entry.name === "chronicle.apiReady"));
values.set("chronicle.visible", true);
assert.equal(sandbox.__chronicleTest.closeViewer({ clearWorld: true }), true);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(values.get("chronicle.visible"), false, "GM close did not clear shared visibility");

const project = api.getProject();
const timeline = project.timelines.find((item) => item.id === "silver-burn-night");
assert.ok(timeline);
assert.equal(timeline.cards.length, 6);
const solution = timeline.cards.map((card) => card.id);
const initial = api.getState();
assert.equal(sandbox.__chronicleTest.validPermutation(initial.orders[timeline.id], timeline), true);
assert.notDeepEqual(initial.orders[timeline.id], solution, "player order should start shuffled");

const wrong = [...solution].reverse();
const first = await sandbox.__chronicleTest.applySubmission(timeline.id, wrong, {
  requestId: "request-wrong-0001",
});
assert.equal(first.type, "failed");
assert.equal(api.getState().attempts[timeline.id], 1);
await sandbox.__chronicleTest.applySubmission(timeline.id, wrong, {
  requestId: "request-wrong-0001",
});
assert.equal(api.getState().attempts[timeline.id], 1, "duplicate receipt consumed another attempt");

const solved = await sandbox.__chronicleTest.applySubmission(timeline.id, solution, {
  requestId: "request-solved-001",
});
assert.equal(solved.type, "solved");
await sandbox.__chronicleTest.S.deliveryQueue;
assert.deepEqual(integrations, { city: 1, mind: 1, dialogue: 1 });
assert.equal(Object.values(api.getState().deliveries[timeline.id])
  .filter((delivery) => delivery.status === "delivered").length, 2);
assert.equal(api.getState().deliveries[timeline.id]["reveal-silver-burn"].status, "prepared");
const solvedHooks = hookCalls.filter((entry) => entry.name === "chronicle.solved").length;
await sandbox.__chronicleTest.applySubmission(timeline.id, solution, {
  requestId: "request-solved-001",
});
assert.equal(hookCalls.filter((entry) => entry.name === "chronicle.solved").length, solvedHooks,
  "duplicate submit emitted chronicle.solved twice");

mindAvailable = true;
await sandbox.__chronicleTest.retryConsequences(timeline.id);
assert.deepEqual(integrations, { city: 1, mind: 2, dialogue: 1 }, "selective retry did not isolate the failed effect");
assert.equal(Object.keys(api.getState().deliveries[timeline.id]).length, 3);
assert.ok(Object.values(api.getState().deliveries[timeline.id])
  .every((delivery) => delivery.status === "delivered"));
await sandbox.__chronicleTest.retryConsequences(timeline.id);
assert.deepEqual(integrations, { city: 1, mind: 2, dialogue: 1 }, "delivered effects repeated");
await sandbox.__chronicleTest.resetTimeline(timeline.id);
assert.equal(api.getState().solved[timeline.id], false);
assert.equal(Object.keys(api.getState().deliveries[timeline.id]).length, 3, "reset repeated campaign rewards");

const exactPoint = await sandbox.__chronicleTest.prepareEffect({
  type: "city", cityId: "silver-reach", screenId: "district-map", pointId: "north-workshops",
});
assert.equal(JSON.stringify(exactPoint), JSON.stringify({
  type: "city", cityId: "silver-reach", screenId: "district-map", pointId: "north-workshops",
}));
cityLocations = [...cityLocations, {
  cityId: "other-city", screenId: "other-screen", pointId: "north-workshops",
}];
assert.equal(await sandbox.__chronicleTest.prepareEffect({
  type: "city", cityId: "", screenId: "", pointId: "north-workshops",
}), null, "ambiguous compact City reference was accepted");
assert.equal(JSON.stringify(await sandbox.__chronicleTest.prepareEffect({
  type: "city", cityId: "silver-reach", screenId: "district-map", pointId: "north-workshops",
})), JSON.stringify(exactPoint), "exact City reference stopped resolving in an ambiguous catalog");
cityLocations = cityLocations.slice(0, 1);

const addProject = {
  version: 1,
  activeTimeline: "add-case",
  timelines: [{
    id: "add-case",
    title: "Add receipt case",
    subtitle: "",
    intro: "",
    successText: "Solved text",
    public: true,
    maxAttempts: 3,
    feedback: "none",
    cards: [
      { id: "first", title: "First", text: "", image: "" },
      { id: "second", title: "Second", text: "", image: "" },
    ],
    effects: [{
      id: "add-score", type: "dialogue", variableId: "score", operation: "add", value: 3,
    }],
  }],
};
assert.ok(await api.replaceProject(addProject));
dialogueThrowAfterWrite = true;
const dialogueBefore = integrations.dialogue;
await sandbox.__chronicleTest.applySubmission("add-case", ["first", "second"], {
  requestId: "request-add-0001",
});
await sandbox.__chronicleTest.S.deliveryQueue;
assert.equal(dialogueValues.score, 13);
assert.equal(api.getState().deliveries["add-case"]["add-score"].status, "prepared");
dialogueThrowAfterWrite = false;
await api.retryConsequences("add-case");
assert.equal(dialogueValues.score, 13, "retry applied an add consequence twice");
assert.equal(integrations.dialogue, dialogueBefore + 2);
assert.equal(api.getState().deliveries["add-case"]["add-score"].status, "delivered");

const previousProject = api.getProject();
const editedProject = structuredClone(previousProject);
editedProject.timelines[0].effects[0].value = 4;
const reconciled = sandbox.__chronicleTest.reconcileStateAfterProjectEdit(
  previousProject,
  sandbox.__chronicleTest.normalizeProject(editedProject),
  api.getState(),
);
assert.equal(reconciled.solved["add-case"], true, "effect edit reset a solved timeline");
assert.equal(reconciled.deliveries["add-case"]["add-score"], undefined,
  "changed effect retained an obsolete delivery receipt");

const savedSnapshot = structuredClone(previousProject);
savedSnapshot.timelines[0].title = "Saved after close";
sandbox.__chronicleTest.S.draft = savedSnapshot;
sandbox.__chronicleTest.S.timelineId = "add-case";
const closingSave = sandbox.__chronicleTest.saveDraft(false);
sandbox.__chronicleTest.S.draft = null;
await closingSave;
assert.equal(api.getProject().timelines[0].title, "Saved after close",
  "closing the editor discarded the asynchronously queued draft");

await api.resetTimeline("add-case");
sandbox.game.user = player;
const publicProject = api.getProject();
const publicState = api.getState();
assert.deepEqual(publicProject.timelines[0].cards.map((card) => card.id), publicState.orders["add-case"]);
assert.equal("effects" in publicProject.timelines[0], false, "player API exposed consequence targets");
assert.equal(publicProject.timelines[0].successText, "", "player API exposed unsolved narrative");
assert.equal("deliveries" in publicState, false, "player API exposed delivery internals");
assert.equal(api.exportProject(), false, "player API exported the hidden solution");
gm.active = false;
assert.equal(await api.setOrder("add-case", ["first", "second"]), false,
  "player reorder succeeded without an active GM");
gm.active = true;

const secondaryGM = { id: "secondary", name: "Secondary", isGM: true, active: true, character: null };
users.set(secondaryGM.id, secondaryGM);
users.contents.push(secondaryGM);
sandbox.game.user = secondaryGM;
assert.equal(await sandbox.__chronicleTest.applyOrder("add-case", ["first", "second"]), false,
  "secondary GM mutated shared state");
sandbox.game.user = gm;

await sandbox.__chronicleTest.onSocket({
  type: "order",
  userId: player.id,
  timelineId: "add-case",
  order: ["second", "first"],
  requestId: "order-network-001",
});
let networkState = api.getState();
assert.equal(networkState.requestResults["order-network-001"].ok, true);
assert.deepEqual(networkState.orders["add-case"], ["second", "first"]);
await sandbox.__chronicleTest.onSocket({
  type: "order",
  userId: player.id,
  timelineId: "add-case",
  order: ["first", "second"],
  requestId: "order-network-001",
});
networkState = api.getState();
assert.deepEqual(networkState.orders["add-case"], ["second", "first"],
  "duplicate order receipt replay changed shared order");

assert.equal(api.validateProject({ timelines: [{ cards: [], effects: Array(21).fill({}) }] }), false);
assert.equal(api.validateProject({ timelines: [{ cards: [], effects: [], intro: "x".repeat(1_100_000) }] }), false);
const cyclic = { timelines: [{ cards: [], effects: [] }] };
cyclic.self = cyclic;
assert.equal(api.validateProject(cyclic), false);

const hiddenProject = structuredClone(addProject);
hiddenProject.timelines[0].public = false;
assert.ok(await api.replaceProject(hiddenProject));
await sandbox.__chronicleTest.onSocket({
  type: "order",
  userId: player.id,
  timelineId: "add-case",
  order: ["first", "second"],
  requestId: "order-hidden-001",
});
assert.equal(api.getState().requestResults["order-hidden-001"].ok, false,
  "player socket request changed a hidden timeline");

assert.equal(styles.includes("body:has(#chronicle-viewer) .application"), false,
  "fullscreen mode elevates every Foundry window above Chronicle");
assert.ok(styles.includes("body.chronicle-viewer-open .ch-elevated-sheet"));
assert.ok(source.includes('card.setPointerCapture?.(event.pointerId)'));
assert.ok(source.includes('["ArrowLeft", "ArrowRight", "Home", "End"]'));
assert.ok(source.includes('aria-live="polite"'));
assert.ok(source.includes('scene controls unavailable'), "Chronicle control errors are not isolated");

const controlsRecord = {};
await runHook("getSceneControlButtons", controlsRecord);
assert.ok(controlsRecord.chronicle);
assert.equal(controlsRecord.chronicle.tools.open.button, true);
assert.equal(controlsRecord.chronicle.tools.edit.button, true);

console.log("Chronicle timeline tests: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
