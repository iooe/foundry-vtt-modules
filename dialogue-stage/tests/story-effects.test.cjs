const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const moduleRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(moduleRoot, "scripts", "main.js"),
  "utf8",
);
let sequence = 0;
const store = new Map();
const emitted = [];
const calledHooks = [];
let cityCalls = 0;
let mindCalls = 0;
const cityArguments = [];
const mindArguments = [];
const modules = new Map([
  [
    "city-viewer",
    {
      api: {
        revealPoint: async (...args) => {
          cityCalls += 1;
          cityArguments.push(args);
          return true;
        },
      },
    },
  ],
  [
    "mind-palace",
    {
      api: {
        revealEvidence: async (...args) => {
          mindCalls += 1;
          mindArguments.push(args);
          return mindCalls > 1;
        },
      },
    },
  ],
]);
const context = vm.createContext({
  console,
  structuredClone,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  Hooks: {
    on() {},
    once() {},
    callAll(name, payload) {
      calledHooks.push({ name, payload });
    },
  },
  game: {
    user: { id: "gm", isGM: true },
    i18n: { localize: (key) => key },
    modules,
    settings: {
      get(moduleId, key) {
        return structuredClone(store.get(`${moduleId}.${key}`));
      },
      async set(moduleId, key, value) {
        store.set(`${moduleId}.${key}`, structuredClone(value));
        return value;
      },
    },
    socket: {
      emit(channel, message) {
        emitted.push({ channel, message });
      },
    },
  },
  foundry: {
    utils: {
      deepClone: structuredClone,
      randomID: (length = 16) => {
        sequence += 1;
        return (`test${sequence}`).padEnd(length, "0").slice(0, length);
      },
    },
  },
  ui: { notifications: { info() {}, warn() {}, error() {} } },
  document: {},
  window: {},
});
context.globalThis = context;

new vm.Script(
  `${source}\n;globalThis.__storyTest = { normalize, normalizeStoryState, choiceAvailable, choiceEffectStatus, choiceNeedsCommit, applyChoiceEffects, choiceKey };`,
  { filename: "dialogue-stage/scripts/main.js" },
).runInContext(context);

const api = context.__storyTest;
const plain = (value) => JSON.parse(JSON.stringify(value));
const rawProject = {
  version: 4,
  activeScene: "scene",
  characters: [
    {
      id: "speaker",
      name: "Speaker",
      role: "Witness",
      relationship: 0,
      color: "#b96e46",
    },
  ],
  variables: [
    { id: "score", name: "Score", initial: 0 },
    { id: "gate", name: "Gate", initial: 1 },
  ],
  scenes: [
    {
      id: "scene",
      title: "Test",
      start: "start",
      nodes: [
        {
          id: "start",
          character: "speaker",
          line: "Start",
          choices: [
            {
              id: "story-choice",
              text: "Commit",
              target: "end",
              conditionVariable: "gate",
              conditionOperator: "gte",
              conditionValue: 1,
              effectVariable: "score",
              effectOperation: "add",
              effectValue: 2,
              relationshipCharacter: "speaker",
              relationshipDelta: 1,
              revealCityPoint: "district",
              revealCityId: "city",
              revealCityScreen: "map",
              revealMindEvidence: "evidence",
              revealMindBoard: "case",
              effectOnce: true,
            },
            {
              id: "blocked-choice",
              text: "Blocked",
              target: "end",
              conditionVariable: "score",
              conditionOperator: "gt",
              conditionValue: 99,
              effectVariable: "score",
              effectOperation: "add",
              effectValue: 50,
              effectOnce: true,
            },
            {
              id: "repeat-choice",
              text: "Repeat",
              target: "end",
              effectVariable: "score",
              effectOperation: "add",
              effectValue: 1,
              effectOnce: false,
            },
          ],
        },
        {
          id: "end",
          character: "speaker",
          line: "End",
          choices: [],
        },
      ],
    },
  ],
};
const project = api.normalize(rawProject);
store.set("dialogue-stage.scene", structuredClone(project));
store.set(
  "dialogue-stage.storyState",
  api.normalizeStoryState({ version: 1 }, project),
);

const scene = project.scenes[0];
const node = scene.nodes[0];
const choice = node.choices[0];
let state = api.normalizeStoryState(
  store.get("dialogue-stage.storyState"),
  project,
);
assert.equal(state.version, 2, "v1 story state migrates to schema v2");
assert.deepEqual(plain(state.integrations), {});
assert.deepEqual(plain(state.receipts), []);
assert.equal(api.choiceAvailable(choice, state), true);
assert.equal(api.choiceNeedsCommit(scene, node, choice, state), true);

(async () => {
  const first = await api.applyChoiceEffects(
    project,
    scene,
    node,
    choice,
    "player",
    "request01",
  );
  assert.equal(first.accepted, true);
  assert.equal(first.localApplied, true);
  assert.equal(first.integrations.city, true);
  assert.equal(first.integrations.mind, false);
  assert.equal(first.state.variables.score, 2);
  assert.equal(first.state.relationships.speaker, 1);
  assert.equal(first.state.applied.length, 1);
  assert.equal(cityCalls, 1);
  assert.equal(mindCalls, 1);
  assert.deepEqual(plain(cityArguments[0].slice(0, 3)), [
    "city",
    "map",
    "district",
  ]);
  assert.equal(mindArguments[0][1].boardId, "case");

  const duplicate = await api.applyChoiceEffects(
    project,
    scene,
    node,
    choice,
    "player",
    "request01",
  );
  assert.equal(duplicate.duplicate, true, "same request is idempotent");
  assert.equal(cityCalls, 1);
  assert.equal(mindCalls, 1);
  assert.equal(duplicate.state.variables.score, 2);
  assert.equal(duplicate.state.relationships.speaker, 1);

  state = api.normalizeStoryState(
    store.get("dialogue-stage.storyState"),
    project,
  );
  let status = api.choiceEffectStatus(scene, node, choice, state);
  assert.equal(status.localPending, false);
  assert.equal(status.cityPending, false);
  assert.equal(status.mindPending, true);
  assert.equal(api.choiceNeedsCommit(scene, node, choice, state), true);

  const retry = await api.applyChoiceEffects(
    project,
    scene,
    node,
    choice,
    "player",
    "request02",
  );
  assert.equal(retry.accepted, true);
  assert.equal(retry.localApplied, false, "retry does not repeat local effects");
  assert.equal(retry.integrations.city, null, "successful reveal is not repeated");
  assert.equal(retry.integrations.mind, true, "failed reveal is retried");
  assert.equal(retry.state.variables.score, 2);
  assert.equal(retry.state.relationships.speaker, 1);
  assert.equal(cityCalls, 1);
  assert.equal(mindCalls, 2);
  status = api.choiceEffectStatus(scene, node, choice, retry.state);
  assert.equal(status.cityPending, false);
  assert.equal(status.mindPending, false);
  assert.equal(api.choiceNeedsCommit(scene, node, choice, retry.state), false);

  const blocked = await api.applyChoiceEffects(
    project,
    scene,
    node,
    node.choices[1],
    "player",
    "request03",
  );
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, "condition");
  assert.equal(blocked.state.variables.score, 2);
  assert.equal(
    blocked.state.receipts.find((receipt) => receipt.id === "request03")
      .accepted,
    false,
    "rejection is recorded authoritatively",
  );

  const repeat = node.choices[2];
  const [repeatOne, repeatTwo] = await Promise.all([
    api.applyChoiceEffects(
      project,
      scene,
      node,
      repeat,
      "player-a",
      "request04",
    ),
    api.applyChoiceEffects(
      project,
      scene,
      node,
      repeat,
      "player-b",
      "request05",
    ),
  ]);
  assert.equal(repeatOne.accepted, true);
  assert.equal(repeatTwo.accepted, true);
  assert.equal(repeatTwo.state.variables.score, 4, "concurrent writes serialize");
  assert.ok(
    emitted.some((entry) => entry.message.type === "story-state"),
    "commits publish a state refresh signal",
  );
  assert.equal(
    calledHooks.filter((entry) => entry.name === "dialogueStage.cityPointRevealed")
      .length,
    1,
    "successful city reveal hook fires once",
  );
  assert.equal(
    calledHooks.filter((entry) => entry.name === "dialogueStage.evidenceRevealed")
      .length,
    1,
    "failed evidence does not fire a reveal hook before successful retry",
  );

  const duplicateIds = api.normalize({
    ...rawProject,
    scenes: [
      {
        ...rawProject.scenes[0],
        nodes: [
          {
            ...rawProject.scenes[0].nodes[0],
            choices: [
              { id: "same-choice", text: "One" },
              { id: "same-choice", text: "Two" },
            ],
          },
        ],
      },
    ],
  });
  const ids = duplicateIds.scenes[0].nodes[0].choices.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate choice ids are rekeyed");

  assert.equal(
    source.includes("normalizeStoryState(m.state"),
    false,
    "socket state payload is never trusted",
  );
  console.log("Dialogue Stage story effect tests: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
