import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const base = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(base, "scripts", "main.js"), "utf8");

const merge = (left, right) => {
  const output = structuredClone(left ?? {});
  for (const [key, value] of Object.entries(right || {}))
    output[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? merge(output[key] || {}, value)
        : structuredClone(value);
  return output;
};

class HookRuntime {
  handlers = new Map();
  calls = [];
  on(name, callback) {
    const list = this.handlers.get(name) || [];
    list.push({ callback, once: false });
    this.handlers.set(name, list);
  }
  once(name, callback) {
    const list = this.handlers.get(name) || [];
    list.push({ callback, once: true });
    this.handlers.set(name, list);
  }
  callAll(name, ...args) {
    this.calls.push({ name, args });
    for (const entry of [...(this.handlers.get(name) || [])])
      entry.callback(...args);
  }
  call(name, ...args) {
    this.callAll(name, ...args);
    return true;
  }
  async run(name, ...args) {
    const entries = [...(this.handlers.get(name) || [])];
    this.handlers.set(
      name,
      entries.filter((entry) => !entry.once),
    );
    for (const entry of entries) await entry.callback(...args);
  }
}

const hooks = new HookRuntime();
const values = new Map();
const registrations = new Map();
const settings = {
  register(moduleId, key, config) {
    const full = `${moduleId}.${key}`;
    registrations.set(full, config);
    if (!values.has(full)) values.set(full, structuredClone(config.default));
  },
  get(moduleId, key) {
    return values.get(`${moduleId}.${key}`);
  },
  async set(moduleId, key, value) {
    values.set(`${moduleId}.${key}`, structuredClone(value));
    return value;
  },
};

const user = (id, isGM = false) => ({
  id,
  name: id,
  isGM,
  active: true,
  flags: {},
  getFlag(moduleId, key) {
    return this.flags[moduleId]?.[key];
  },
  async setFlag(moduleId, key, value) {
    (this.flags[moduleId] ||= {})[key] = structuredClone(value);
    return value;
  },
});
const gm = user("gm", true);
const playerOne = user("player-one");
const playerTwo = user("player-two");
const users = new Map([
  [gm.id, gm],
  [playerOne.id, playerOne],
  [playerTwo.id, playerTwo],
]);
users.contents = [gm, playerOne, playerTwo];
users.activeGM = gm;

let storyValue = 0;
let mindCalls = 0;
let chronicleCalls = 0;
let random = 0;
const chronicleState = { activeTimeline: "" };
const modules = new Map([
  ["city-viewer", { id: "city-viewer", active: true, api: null }],
  [
    "mind-palace",
    {
      id: "mind-palace",
      active: true,
      api: {
        getBoards: () => [
          {
            id: "case-board",
            title: "Case",
            nodes: [{ id: "silver-clue", title: "Silver clue" }],
          },
        ],
        async revealEvidence() {
          mindCalls += 1;
          return true;
        },
      },
    },
  ],
  [
    "dialogue-stage",
    {
      id: "dialogue-stage",
      active: true,
      api: {
        getProject: () => ({ variables: [{ id: "lead", name: "Lead" }] }),
        getStoryState: () => ({ variables: { lead: storyValue } }),
        async setVariable(variableId, value) {
          assert.equal(variableId, "lead");
          storyValue = value;
          return true;
        },
      },
    },
  ],
  [
    "chronicle",
    {
      id: "chronicle",
      active: true,
      api: {
        getProject: () => ({
          timelines: [{ id: "silver-burn-night", title: "Silver Burn Night" }],
        }),
        getState: () => structuredClone(chronicleState),
        async show(timelineId) {
          chronicleCalls += 1;
          chronicleState.activeTimeline = timelineId;
          values.set("chronicle.visible", true);
          return true;
        },
      },
    },
  ],
]);

const sandbox = {
  console: {
    log: console.log,
    info: console.info,
    error: console.error,
    warn() {},
  },
  structuredClone,
  Event,
  Blob,
  URL,
  CSS: { escape: String },
  document: {
    body: { append() {}, classList: { add() {}, remove() {}, toggle() {} } },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
  },
  Image: undefined,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  Hooks: {
    on: hooks.on.bind(hooks),
    once: hooks.once.bind(hooks),
    call: hooks.call.bind(hooks),
    callAll: hooks.callAll.bind(hooks),
  },
  foundry: {
    utils: {
      deepClone: structuredClone,
      mergeObject: (left, right) => merge(left, right),
      randomID: (length = 16) =>
        (`test${++random}`).padEnd(length, "0").slice(0, length),
    },
  },
  game: {
    user: gm,
    users,
    modules,
    settings,
    socket: { on() {}, emit() {} },
    macros: { contents: [] },
    messages: new Map(),
  },
  ui: { notifications: { info() {}, warn() {}, error() {} } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
new vm.Script(
  `${source}\n;globalThis.__visitTest = {city, normalizeVisitEffect, normalizeVisitEffectLedger, triggerVisitEffect, retryVisitEffects, resetVisitEffect, getVisitEffectState, requestVisitEffect, processUserEffectRequests, S};`,
  { filename: "city-viewer/scripts/main.js" },
).runInContext(context);
await hooks.run("init");
assert.equal(registrations.get("city-viewer.visitEffects")?.scope, "world");
values.set("chronicle.visible", false);

const migrated = context.__visitTest.city({
  version: 8,
  activeCity: "silver",
  activeScreen: "market",
  cities: [
    {
      id: "silver",
      name: "Silver Reach",
      startScreen: "market",
      screens: [
        {
          id: "market",
          title: "Market",
          objects: [
            {
              id: "north-workshops",
              kind: "poi",
              action: "info",
              pointState: "secret",
              visitMode: "group",
            },
          ],
        },
      ],
    },
  ],
});
const migratedPoint = migrated.cities[0].screens[0].objects.find(
  (point) => point.id === "north-workshops",
);
assert.equal(migrated.version, 9);
assert.equal(migratedPoint.visitEffect.enabled, true);
assert.equal(migratedPoint.visitEffect.chronicle.timelineId, "silver-burn-night");
const unrelated = context.__visitTest.city({
  version: 8,
  activeCity: "custom",
  activeScreen: "custom-screen",
  cities: [
    {
      id: "custom",
      name: "My campaign city",
      startScreen: "custom-screen",
      screens: [
        {
          id: "custom-screen",
          title: "Custom",
          objects: [
            {
              id: "north-workshops",
              kind: "poi",
              action: "info",
              pointState: "secret",
              visitMode: "group",
            },
          ],
        },
      ],
    },
  ],
});
assert.equal(
  unrelated.cities[0].screens[0].objects[0].visitEffect.enabled,
  false,
  "the narrow migration must not modify an unrelated city",
);

const targetEffect = {
  id: "source-first",
  enabled: true,
  scope: "group",
  repeatable: false,
  narrative: { enabled: true, title: "Found", text: "A trail appears." },
  city: { enabled: true, cityId: "city", screenId: "screen", pointId: "target" },
  mind: { enabled: true, boardId: "case-board", nodeId: "silver-clue" },
  story: { enabled: true, variableId: "lead", operation: "add", value: 2 },
  chronicle: { enabled: true, timelineId: "silver-burn-night" },
};
const project = context.__visitTest.city({
  version: 9,
  activeCity: "city",
  activeScreen: "screen",
  cities: [
    {
      id: "city",
      name: "Test",
      startScreen: "screen",
      screens: [
        {
          id: "screen",
          title: "Test",
          objects: [
            {
              id: "source",
              kind: "poi",
              name: "Source",
              pointState: "visible",
              visitEffect: targetEffect,
            },
            {
              id: "target",
              kind: "poi",
              name: "Target",
              pointState: "secret",
            },
          ],
        },
      ],
    },
  ],
});
values.set("city-viewer.city", project);

const first = await context.__visitTest.triggerVisitEffect(
  "city",
  "screen",
  "source",
  { userId: playerOne.id, requestId: "request.group.0001" },
);
assert.equal(first.status, "delivered");
assert.deepEqual(Array.from(first.audience).sort(), [playerOne.id, playerTwo.id].sort());
assert.equal(storyValue, 2);
assert.equal(mindCalls, 1);
assert.equal(chronicleCalls, 1);
assert.equal(first.delivery.city.status, "delivered");
assert.equal(first.delivery.mind.status, "delivered");
assert.equal(first.delivery.story.target, 2);
assert.equal(first.delivery.chronicle.status, "delivered");

const duplicateRequest = await context.__visitTest.triggerVisitEffect(
  "city",
  "screen",
  "source",
  { userId: playerOne.id, requestId: "request.group.0001" },
);
assert.equal(duplicateRequest.status, "delivered");
assert.equal(storyValue, 2);
assert.equal(mindCalls, 1);
assert.equal(chronicleCalls, 1);

const secondGroupRequest = await context.__visitTest.triggerVisitEffect(
  "city",
  "screen",
  "source",
  { userId: playerTwo.id, requestId: "request.group.0002" },
);
assert.equal(secondGroupRequest.status, "skipped");
assert.equal(storyValue, 2);

const sourcePoint = project.cities[0].screens[0].objects[0];
sourcePoint.visitEffect = context.__visitTest.normalizeVisitEffect({
  id: "personal-repeat",
  enabled: true,
  scope: "personal",
  repeatable: true,
  story: { enabled: true, variableId: "lead", operation: "add", value: 1 },
});
values.set("city-viewer.city", project);
await context.__visitTest.triggerVisitEffect("city", "screen", "source", {
  userId: playerOne.id,
  requestId: "request.repeat.0001",
});
await context.__visitTest.triggerVisitEffect("city", "screen", "source", {
  userId: playerOne.id,
  requestId: "request.repeat.0002",
});
assert.equal(storyValue, 4);
await context.__visitTest.triggerVisitEffect("city", "screen", "source", {
  userId: playerOne.id,
  requestId: "request.repeat.0002",
});
assert.equal(storyValue, 4, "same requestId must not deliver twice");

sourcePoint.visitEffect = context.__visitTest.normalizeVisitEffect({
  id: "retry-mind",
  enabled: true,
  scope: "group",
  mind: { enabled: true, boardId: "case-board", nodeId: "silver-clue" },
});
values.set("city-viewer.city", project);
const mindModule = modules.get("mind-palace");
const mindApi = mindModule.api;
mindModule.api = null;
const pending = await context.__visitTest.triggerVisitEffect(
  "city",
  "screen",
  "source",
  { userId: playerOne.id, requestId: "request.retry.0001" },
);
assert.equal(pending.status, "pending");
mindModule.api = mindApi;
await context.__visitTest.retryVisitEffects({ force: true });
assert.equal(
  context.__visitTest.getVisitEffectState().receipts["request.retry.0001"].status,
  "delivered",
);

sourcePoint.visitEffect = context.__visitTest.normalizeVisitEffect({
  id: "bad-target",
  enabled: true,
  scope: "group",
  city: { enabled: true, cityId: "city", screenId: "screen", pointId: "missing" },
});
values.set("city-viewer.city", project);
const blocked = await context.__visitTest.triggerVisitEffect(
  "city",
  "screen",
  "source",
  { userId: playerOne.id, requestId: "request.blocked.0001" },
);
assert.equal(blocked.status, "blocked");
const reset = await context.__visitTest.resetVisitEffect(
  "city",
  "screen",
  "source",
);
assert.ok(reset.removed.includes("request.blocked.0001"));
assert.equal(
  context.__visitTest.getVisitEffectState().receipts["request.blocked.0001"],
  undefined,
);

sourcePoint.visitEffect = context.__visitTest.normalizeVisitEffect({
  id: "durable-outbox",
  enabled: true,
  scope: "personal",
  narrative: { enabled: true, title: "Message", text: "Persisted." },
});
values.set("city-viewer.city", project);
sandbox.game.user = playerOne;
const durableRequest = await context.__visitTest.requestVisitEffect(
  sourcePoint,
  "city",
  "screen",
);
assert.ok(
  playerOne.flags["city-viewer"].visitEffectRequests.requests.some(
    (request) => request.id === durableRequest.id,
  ),
  "player request was not persisted to the User flag",
);
sandbox.game.user = gm;
assert.deepEqual(
  Array.from(
    await context.__visitTest.processUserEffectRequests(
      playerTwo,
      durableRequest.id,
    ),
  ),
  [],
  "a request must not be accepted from another user's outbox",
);
const durableResult = await context.__visitTest.processUserEffectRequests(
  playerOne,
  durableRequest.id,
);
assert.equal(durableResult[0].status, "delivered");

sourcePoint.pointState = "secret";
sourcePoint.visitEffect = context.__visitTest.normalizeVisitEffect({
  id: "forged-secret",
  enabled: true,
  scope: "personal",
  narrative: { enabled: true, title: "Hidden", text: "Must not run." },
});
values.set("city-viewer.city", project);
sandbox.game.user = playerOne;
const forgedRequest = await context.__visitTest.requestVisitEffect(
  sourcePoint,
  "city",
  "screen",
);
sandbox.game.user = gm;
const forgedResult = await context.__visitTest.processUserEffectRequests(
  playerOne,
  forgedRequest.id,
);
assert.equal(
  forgedResult[0].status,
  "skipped",
  "the active GM must reject a request for a secret point",
);
sourcePoint.pointState = "visible";
values.set("city-viewer.city", project);

const state = context.__visitTest.getVisitEffectState({ pointId: "source" });
assert.ok(Object.keys(state.receipts).length >= 6);
assert.ok(Object.keys(state.claims).length >= 2);
sandbox.game.user = playerTwo;
const playerState = context.__visitTest.getVisitEffectState();
assert.deepEqual(Object.keys(playerState.claims), []);
assert.equal(
  Object.values(playerState.receipts).some(
    (receipt) => receipt.effectKey.endsWith("#durable-outbox"),
  ),
  false,
  "personal receipts must not be exposed through the player API",
);
sandbox.game.user = gm;
clearTimeout(context.__visitTest.S.visitEffectRetryTimer);

console.log("city-viewer visit effects: migration, once/repeatable claims, exact delivery and retry ok");
