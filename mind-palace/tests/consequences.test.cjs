const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const moduleRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(moduleRoot, "scripts", "main.js"), "utf8");
let sequence = 0;
let storedProject = null;
let cityCalls = 0;
let dialogueCalls = 0;
let chronicleCalls = 0;
let dialogueValue = 2;
const cityArguments = [];
const hookCalls = [];
const onceHandlers = new Map();

const cityApi = {
  getProject: () => ({
    cities: [
      {
        id: "silver-reach",
        name: "Silver Reach",
        screens: [
          {
            id: "north-quarter",
            title: "North Quarter",
            objects: [
              {
                id: "north-workshops",
                kind: "poi",
                name: "Northern workshops",
              },
            ],
          },
        ],
      },
    ],
  }),
  revealPoint: async (...args) => {
    cityCalls += 1;
    cityArguments.push(args);
    return { state: "visible" };
  },
};

const dialogueApi = {
  getProject: () => ({
    variables: [{ id: "courier-lead", name: "Courier lead" }],
  }),
  getStoryState: () => ({ variables: { "courier-lead": dialogueValue } }),
  setVariable: async (id, value) => {
    assert.equal(id, "courier-lead");
    dialogueCalls += 1;
    dialogueValue = value;
    if (dialogueCalls === 1)
      throw new Error("simulated failure after the external write");
    return { variables: { "courier-lead": dialogueValue } };
  },
};

const chronicleApi = {
  getProject: () => ({
    timelines: [{ id: "silver-burn-night", title: "Night of the Silver Burn" }],
  }),
  show: async (timelineId) => {
    assert.equal(timelineId, "silver-burn-night");
    chronicleCalls += 1;
    return true;
  },
};

const modules = new Map([
  ["city-viewer", { active: true, api: cityApi }],
  ["dialogue-stage", { active: true, api: dialogueApi }],
  ["chronicle", { active: true, api: chronicleApi }],
  ["mind-palace", { active: true, api: null }],
]);
const gmUser = { id: "gm", isGM: true, active: true };
const context = vm.createContext({
  console,
  structuredClone,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  Hooks: {
    on() {},
    once(name, callback) {
      onceHandlers.set(name, callback);
    },
    callAll(name, payload) {
      let copy = payload;
      try {
        copy = structuredClone(payload);
      } catch (_error) {
        // API-ready payload contains functions; the test only needs its name.
      }
      hookCalls.push({ name, payload: copy });
    },
  },
  game: {
    user: gmUser,
    users: new Map([[gmUser.id, gmUser]]),
    i18n: { localize: (key) => key },
    modules,
    socket: { on() {}, emit() {} },
    settings: {
      register() {},
      get(_moduleId, key) {
        if (key === "project") return structuredClone(storedProject);
        return null;
      },
      async set(_moduleId, key, value) {
        if (key === "project") storedProject = structuredClone(value);
        return value;
      },
    },
  },
  foundry: {
    utils: {
      deepClone: structuredClone,
      randomID: (length = 16) => {
        sequence += 1;
        return (`outcome${sequence}`).padEnd(length, "0").slice(0, length);
      },
    },
  },
  ui: { notifications: { info() {}, warn() {}, error() {} } },
  document: {},
  window: {},
});
context.globalThis = context;

new vm.Script(
  `${source}\n;globalThis.__consequenceTest = { S, exampleCase, normalizeProject, revealRuleOnBoard, deliverRevealedConsequences, deductionView, mergeConsequenceRuntime };`,
  { filename: "mind-palace/scripts/main.js" },
).runInContext(context);

const api = context.__consequenceTest;
const plain = (value) => JSON.parse(JSON.stringify(value));

(async () => {
  storedProject = api.normalizeProject(api.exampleCase());
  onceHandlers.get("ready")();
  const publicApi = modules.get("mind-palace").api;
  assert.equal(publicApi.version, JSON.parse(fs.readFileSync(path.join(moduleRoot, "module.json"), "utf8")).version);
  assert.equal(typeof publicApi.getConsequences, "function");
  assert.equal(typeof publicApi.retryConsequences, "function");
  let board = storedProject.boards[0];
  let rule = board.deductions[0];
  assert.equal(api.revealRuleOnBoard(board, rule, "gm", true), true);

  const first = plain(
    await api.deliverRevealedConsequences(board.id, [rule.id]),
  )[0];
  assert.equal(
    first.delivered.length,
    4,
    "internal, City, Chronicle and narrative effects deliver",
  );
  assert.equal(first.failed.length, 1, "the simulated Dialogue failure is retained");
  assert.equal(cityCalls, 1);
  assert.equal(chronicleCalls, 1);
  assert.deepEqual(cityArguments[0].slice(0, 3), [
    "silver-reach",
    "north-quarter",
    "north-workshops",
  ]);

  board = storedProject.boards[0];
  rule = board.deductions[0];
  const city = rule.consequences.find((entry) => entry.type === "city");
  const dialogue = rule.consequences.find((entry) => entry.type === "dialogue");
  assert.equal(city.status, "delivered");
  assert.equal(city.cityId, "silver-reach", "unique legacy point id becomes exact");
  assert.equal(city.screenId, "north-quarter");
  assert.equal(dialogue.status, "failed");
  assert.equal(dialogue.preparedValue, 3, "absolute add target is durable before delivery");
  assert.equal(dialogueValue, 3, "simulated external write happened before failure");

  const second = plain(
    await publicApi.retryConsequences(board.id, rule.id, dialogue.id),
  );
  assert.equal(second.delivered.length, 1);
  assert.equal(second.failed.length, 0);
  assert.equal(second.skipped.length, 0, "targeted retry touches only one consequence");
  assert.equal(cityCalls, 1, "City reveal is not repeated");
  assert.equal(chronicleCalls, 1, "Chronicle show is not repeated");
  assert.equal(dialogueCalls, 2);
  assert.equal(dialogueValue, 3, "retry sets the prepared target instead of adding again");

  const third = plain(
    await api.deliverRevealedConsequences(board.id, [rule.id]),
  )[0];
  assert.equal(third.delivered.length, 0);
  assert.equal(third.skipped.length, 5);
  assert.equal(cityCalls, 1);
  assert.equal(chronicleCalls, 1);
  assert.equal(dialogueCalls, 2);

  board = storedProject.boards[0];
  rule = board.deductions[0];
  const gmConsequences = plain(publicApi.getConsequences(board.id, rule.id));
  assert.equal(gmConsequences[1].cityId, "silver-reach");
  const publicOutcomes = plain(api.deductionView(board, rule, false).outcomes);
  assert.equal(publicOutcomes.length, 5);
  assert.ok(
    publicOutcomes.every(
      (outcome) =>
        !Object.hasOwn(outcome, "id") &&
        !Object.hasOwn(outcome, "pointId") &&
        !Object.hasOwn(outcome, "variableId") &&
        !Object.hasOwn(outcome, "timelineId") &&
        !Object.hasOwn(outcome, "evidenceId"),
    ),
    "player feedback contains no technical references",
  );
  assert.ok(
    hookCalls.some((entry) => entry.name === "mindPalace.consequenceFailed"),
  );
  assert.ok(
    hookCalls.filter((entry) => entry.name === "mindPalace.consequenceDelivered")
      .length >= 5,
  );
  assert.ok(
    hookCalls.some((entry) => entry.name === "mindPalace.deductionOutcomes"),
    "successful retry publishes player-safe outcome feedback",
  );

  const changedWhileDelivering = structuredClone(dialogue);
  changedWhileDelivering.value = 99;
  api.mergeConsequenceRuntime(changedWhileDelivering, dialogue);
  assert.equal(
    changedWhileDelivering.status,
    "pending",
    "an editor change racing a delivery keeps the new definition pending",
  );
  assert.equal(changedWhileDelivering.preparedValue, null);

  context.game.user.isGM = false;
  const playerConsequences = plain(publicApi.getConsequences(board.id, rule.id));
  assert.deepEqual(playerConsequences, publicOutcomes);
  assert.equal(
    await api.deliverRevealedConsequences(board.id, [rule.id]),
    false,
    "delivery is GM-authoritative",
  );

  console.log("Mind Palace consequence delivery tests: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
