const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const moduleRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(moduleRoot, "scripts", "main.js"), "utf8");
let sequence = 0;
const hooks = { on() {}, once() {}, callAll() {} };
const context = vm.createContext({
  console,
  structuredClone,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  Hooks: hooks,
  game: {
    user: { id: "gm", isGM: true },
    i18n: { localize: (key) => key },
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
  `${source}\n;globalThis.__deductionTest = { exampleCase, normalizeProject, rekeyBoard, deductionProgress, deductionView, revealRuleOnBoard, resetRuleOnBoard, edgeKey };`,
  { filename: "mind-palace/scripts/main.js" },
).runInContext(context);

const api = context.__deductionTest;
const plain = (value) => JSON.parse(JSON.stringify(value));
const project = api.normalizeProject(api.exampleCase());
const board = project.boards[0];
const rule = board.deductions[0];
const reward = board.nodes.find((node) => node.id === rule.rewardNodeId);

assert.equal(project.version, 4, "current schema");
assert.equal(board.playerLinks.length, 0, "template starts without player links");
assert.ok(rule, "template contains a deduction rule");
assert.equal(rule.requiredLinks.length, 2, "template has a playable connection pattern");
assert.equal(reward.revealed, false, "template reward starts hidden");
assert.equal(reward.id, "silver-burn", "cross-module reward id is stable");
assert.deepEqual(
  plain(rule.consequences.map((consequence) => consequence.type)),
  ["evidence", "city", "dialogue", "chronicle", "narrative"],
  "template contains a complete cross-module continuation",
);
assert.ok(
  rule.consequences.every((consequence) => consequence.status === "pending"),
  "template consequences start pending",
);
const copiedBoard = api.rekeyBoard(board);
assert.equal(
  copiedBoard.nodes.some((node) => node.id === "silver-burn"),
  false,
  "additional template copies receive unique node ids",
);
assert.notEqual(
  copiedBoard.deductions[0].consequences[0].evidenceId,
  "silver-burn",
  "copied evidence consequences follow the rekeyed card",
);
assert.ok(
  copiedBoard.deductions[0].consequences.every(
    (consequence) => consequence.status === "pending",
  ),
  "copied consequences do not inherit delivery receipts",
);

let progress = api.deductionProgress(board, rule);
assert.equal(progress.total, 5);
assert.equal(progress.completed, 3, "visible required cards count toward progress");
assert.equal(progress.complete, false);

const hiddenView = api.deductionView(board, rule, false);
assert.equal(hiddenView.title, undefined, "unresolved title is not exposed");
assert.equal(hiddenView.description, undefined, "unresolved description is not exposed");
assert.equal(hiddenView.requiredLinks, undefined, "unresolved pattern is not exposed");
assert.deepEqual(
  Object.keys(hiddenView).sort(),
  ["id", "progress", "revealed"],
  "player projection only contains spoiler-free progress",
);

rule.requiredLinks.forEach((link, index) => {
  board.playerLinks.push({
    id: `player-link-${index}`,
    from: link.to,
    to: link.from,
    createdBy: "player",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});
progress = api.deductionProgress(board, rule);
assert.equal(progress.complete, true, "connection direction does not affect matching");
assert.equal(api.revealRuleOnBoard(board, rule, "player", false), true);
assert.equal(rule.revealed, true);
assert.equal(rule.unlockApplied, true);
assert.equal(reward.revealed, true, "completed deduction reveals its reward");
const revealedView = api.deductionView(board, rule, false);
assert.equal(revealedView.title, rule.title, "revealed title is public");
assert.equal(revealedView.reward.title, reward.title, "revealed reward is public");
assert.equal(revealedView.reward.id, undefined, "player reward feedback hides technical ids");
assert.deepEqual(plain(revealedView.outcomes), [], "pending outcomes are not promised to players");
rule.consequences.at(-1).status = "delivered";
const outcomeView = api.deductionView(board, rule, false).outcomes[0];
assert.deepEqual(
  Object.keys(plain(outcomeView)).sort(),
  ["body", "title", "type"],
  "player outcome contains narrative copy without technical references",
);

assert.equal(api.resetRuleOnBoard(board, rule), true);
assert.equal(rule.revealed, false);
assert.equal(reward.revealed, false, "reset hides a reward unlocked only by this rule");
assert.equal(board.playerLinks.length, 0, "reset removes the rule's assembled links");

const migrated = api.normalizeProject({
  version: 2,
  activeBoard: "legacy",
  boards: [
    {
      id: "legacy",
      title: "Legacy",
      nodes: [
        { id: "a", title: "A", revealed: true },
        { id: "b", title: "B", revealed: false },
      ],
      links: [],
    },
  ],
});
assert.equal(migrated.version, 4);
assert.deepEqual(plain(migrated.boards[0].playerLinks), []);
assert.deepEqual(plain(migrated.boards[0].deductions), []);
assert.equal(migrated.boards[0].nodes[0].w, 14, "v2 cards are not rescaled again");

const oldDemo = api.exampleCase();
oldDemo.version = 2;
oldDemo.boards[0].nodes = oldDemo.boards[0].nodes.filter(
  (node) => node.id !== "silver-burn",
);
oldDemo.boards[0].deductions = [];
const upgradedDemo = api.normalizeProject(oldDemo),
  upgradedBoard = upgradedDemo.boards[0],
  upgradedReward = upgradedBoard.nodes.find((node) => node.id === "silver-burn"),
  upgradedRule = upgradedBoard.deductions.find(
    (entry) => entry.id === "seventh-shaft-deduction",
  );
assert.ok(upgradedReward, "v2 bundled demo receives its missing reward card");
assert.equal(upgradedReward.revealed, false, "migrated reward remains hidden");
assert.ok(upgradedRule, "v2 bundled demo receives its deduction rule");
assert.equal(upgradedRule.rewardNodeId, "silver-burn");
assert.deepEqual(plain(upgradedRule.requiredNodes), [
  "sealed-letter",
  "cobalt-vial",
  "star-chart",
]);
assert.equal(upgradedRule.requiredLinks.length, 2);
assert.equal(upgradedRule.consequences.length, 5, "v2 demo receives v4 consequences");
assert.equal(
  upgradedRule.consequences.find((entry) => entry.type === "city").pointId,
  "north-workshops",
);
assert.equal(
  upgradedRule.consequences.find((entry) => entry.type === "dialogue").variableId,
  "courier-lead",
);
assert.equal(
  upgradedRule.consequences.find((entry) => entry.type === "chronicle").timelineId,
  "silver-burn-night",
);

const versionThreeDemo = api.exampleCase();
versionThreeDemo.version = 3;
versionThreeDemo.boards[0].deductions[0].consequences = [];
const upgradedV3Rule = api.normalizeProject(versionThreeDemo).boards[0].deductions[0];
assert.equal(
  upgradedV3Rule.consequences.length,
  5,
  "recognizable v3 demo receives only the new gameplay continuation",
);

const unrelatedLookalike = structuredClone(oldDemo);
unrelatedLookalike.boards[0].id = "user-investigation";
unrelatedLookalike.activeBoard = "user-investigation";
const untouchedLookalike = api.normalizeProject(unrelatedLookalike).boards[0];
assert.equal(
  untouchedLookalike.nodes.some((node) => node.id === "silver-burn"),
  false,
  "migration does not add sample content to a user board",
);
assert.equal(untouchedLookalike.deductions.length, 0);

const currentDemoWithoutFeature = structuredClone(oldDemo);
currentDemoWithoutFeature.version = 3;
const untouchedCurrent = api.normalizeProject(currentDemoWithoutFeature).boards[0];
assert.equal(
  untouchedCurrent.nodes.some((node) => node.id === "silver-burn"),
  false,
  "v4 migration does not reconstruct unrelated missing v3 content",
);
assert.equal(untouchedCurrent.deductions.length, 0);

const validated = api.normalizeProject({
  version: 4,
  activeBoard: "validated",
  boards: [
    {
      id: "validated",
      nodes: [
        { id: "a", title: "A", revealed: true },
        { id: "b", title: "B", revealed: true },
      ],
      links: [],
      playerLinks: [
        { id: "one", from: "a", to: "b" },
        { id: "two", from: "b", to: "a" },
        { id: "bad", from: "a", to: "missing" },
      ],
      deductions: [
        {
          id: "rule",
          title: "Validated",
          requiredNodes: ["a", "missing", "a"],
          requiredLinks: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
            { from: "a", to: "missing" },
          ],
          rewardNodeId: "missing",
          consequences: [
            { id: "same", type: "evidence", evidenceId: "missing" },
            { id: "same", type: "dialogue", variableId: "x", value: "NaN" },
          ],
        },
      ],
    },
  ],
});
const validatedBoard = validated.boards[0];
assert.equal(validatedBoard.playerLinks.length, 1, "duplicate and invalid player links are pruned");
assert.deepEqual(plain(validatedBoard.deductions[0].requiredNodes), ["a"]);
assert.equal(validatedBoard.deductions[0].requiredLinks.length, 1);
assert.equal(validatedBoard.deductions[0].rewardNodeId, "");
assert.equal(validatedBoard.deductions[0].consequences.length, 2);
assert.equal(validatedBoard.deductions[0].consequences[0].evidenceId, "");
assert.equal(validatedBoard.deductions[0].consequences[1].value, 0);
assert.notEqual(
  validatedBoard.deductions[0].consequences[0].id,
  validatedBoard.deductions[0].consequences[1].id,
  "duplicate consequence ids are rekeyed",
);

const cappedConsequences = api.normalizeProject({
  version: 4,
  activeBoard: "limits",
  boards: [
    {
      id: "limits",
      nodes: [{ id: "a", title: "A" }],
      deductions: [
        {
          id: "rule",
          consequences: Array.from({ length: 30 }, (_, index) => ({
            id: `outcome-${index}`,
            type: "unknown",
            title: `Outcome ${index}`,
          })),
        },
      ],
    },
  ],
}).boards[0].deductions[0].consequences;
assert.equal(cappedConsequences.length, 20, "consequence count is capped");
assert.ok(
  cappedConsequences.every((consequence) => consequence.type === "narrative"),
  "unknown consequence types normalize to a safe local narrative",
);
assert.equal(api.edgeKey("a", "b"), api.edgeKey("b", "a"));

console.log("Mind Palace deduction tests: ok");
