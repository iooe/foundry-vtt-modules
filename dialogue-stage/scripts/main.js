const MOD = "dialogue-stage",
  ASSET = (n) => `modules/${MOD}/assets/${n}`;
const S = {
  viewer: null,
  editor: null,
  draft: null,
  scene: null,
  selected: null,
  character: null,
  variable: null,
  panel: "node",
  node: null,
  runtimeState: null,
  choiceBusy: false,
  history: [],
  canvas: null,
  camera: null,
  timer: 0,
  edgeFrame: 0,
  motionFrame: 0,
  motion: null,
  saveChain: Promise.resolve(),
  effectChain: Promise.resolve(),
  undo: [],
  redo: [],
  inputSnapshot: null,
  inputSnapshotArmed: false,
  wireCleanup: null,
  assetCache: new Map(),
  choiceRate: new Map(),
  pendingChoices: new Map(),
};
const uid = () => foundry.utils.randomID(12),
  clone = (v) => foundry.utils.deepClone(v),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>'"]/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#039;",
          '"': "&quot;",
        })[c],
    ),
  t = (key, fallback = key) => {
    const value = game.i18n?.localize?.(key);
    return value && value !== key ? value : fallback;
  },
  cssUrl = (value) =>
    String(value ?? "").replace(/[\\'"()\n\r]/g, (character) =>
      encodeURIComponent(character),
    ),
  safeColor = (value, fallback = "#b96e46") =>
    /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback,
  safeId = (value) => {
    const id = String(value || "");
    return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : uid();
  },
  optimizedAsset = (value) =>
    String(value || "")
      .replace(`modules/${MOD}/assets/ilyan-vey.png`, ASSET("ilyan-vey.webp"))
      .replace(
        `modules/${MOD}/assets/alchemist-lab.png`,
        ASSET("alchemist-lab.webp"),
      );

const STORY_STATE_VERSION = 2,
  VALUE_LIMIT = 1_000_000,
  RECEIPT_LIMIT = 2000,
  CHOICE_TIMEOUT = 10000,
  numberValue = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.max(-VALUE_LIMIT, Math.min(VALUE_LIMIT, parsed))
      : fallback;
  },
  choiceKey = (scene, node, choice) =>
    `${safeId(scene?.id)}:${safeId(node?.id)}:${safeId(choice?.id)}`;

function requestId(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : "";
}

function reportError(context, error) {
  console.error(`${MOD} | ${context}`, error);
  ui.notifications?.error?.(
    t(
      "DS.SaveFailed",
      "Не удалось сохранить диалог. Проверьте консоль Foundry.",
    ),
  );
}

function remember(snapshot = null) {
  if (!S.draft) return;
  S.undo.push(snapshot || clone(S.draft));
  if (S.undo.length > 50) S.undo.shift();
  S.redo.length = 0;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undo = S.editor?.querySelector('[data-ed="undo"]'),
    redo = S.editor?.querySelector('[data-ed="redo"]');
  if (undo) undo.disabled = !S.undo.length;
  if (redo) redo.disabled = !S.redo.length;
}

function restoreHistory(direction) {
  const source = direction === "undo" ? S.undo : S.redo,
    destination = direction === "undo" ? S.redo : S.undo,
    snapshot = source.pop();
  if (!snapshot || !S.draft) return;
  destination.push(clone(S.draft));
  S.draft = normalize(snapshot);
  if (!S.draft.scenes.some((scene) => scene.id === S.scene))
    S.scene = S.draft.activeScene;
  const scene = editScene();
  if (!scene.nodes.some((node) => node.id === S.selected))
    S.selected = scene.start;
  if (!S.draft.characters.some((character) => character.id === S.character))
    S.character = S.draft.characters[0].id;
  renderEditor();
  autosave();
  updateHistoryButtons();
}

function preloadAsset(source, timeout = 6000) {
  const url = String(source || "").trim();
  if (!url || typeof Image === "undefined") return Promise.resolve(false);
  if (S.assetCache.has(url)) return S.assetCache.get(url);
  const promise = new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(loaded);
    };
    const timer = setTimeout(() => finish(false), timeout);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.decoding = "async";
    image.src = url;
  }).then((loaded) => {
    if (!loaded) S.assetCache.delete(url);
    return loaded;
  });
  S.assetCache.set(url, promise);
  if (S.assetCache.size > 128)
    S.assetCache.delete(S.assetCache.keys().next().value);
  return promise;
}

function preloadNextAssets(project, scene, node) {
  const urls = new Set([scene.background]);
  const currentCharacter = findChar(project, node.character);
  if (currentCharacter?.portrait) urls.add(currentCharacter.portrait);
  node.choices.forEach((choice) => {
    const target = scene.nodes.find(
      (candidate) => candidate.id === choice.target,
    );
    if (!target) return;
    const character = findChar(project, target.character);
    if (character?.portrait) urls.add(character.portrait);
  });
  void Promise.allSettled([...urls].map((url) => preloadAsset(url)));
}

function example() {
  const characters = [
    {
      id: "ilyan",
      name: "Ильян Вей",
      role: "Алхимик",
      portrait: ASSET("ilyan-vey.webp"),
      color: "#b96e46",
      relationship: 0,
    },
    {
      id: "inner",
      name: "Внутренний голос",
      role: "Наблюдение",
      portrait: "",
      color: "#4d9aa0",
      relationship: 0,
    },
    {
      id: "mirena",
      name: "Мирена Кросс",
      role: "Городская дознавательница",
      portrait: "",
      color: "#7d6eb2",
      relationship: 0,
    },
  ];
  const choice = (text, target = "", gameplay = {}) => ({
    id: uid(),
    text,
    target,
    ...gameplay,
  });
  return {
    version: 4,
    characters,
    variables: [
      {
        id: "courier-lead",
        name: "След курьера",
        initial: 0,
      },
    ],
    activeScene: "vey-interrogation",
    scenes: [
      {
        id: "vey-interrogation",
        title: "Запах горького миндаля",
        background: ASSET("alchemist-lab.webp"),
        start: "arrival",
        nodes: [
          {
            id: "arrival",
            character: "ilyan",
            line: "Вы пришли из-за письма. Не отрицайте — вы смотрите не на меня, а на печать у горна.",
            voice: "НАБЛЮДАТЕЛЬНОСТЬ",
            inner: "Он заметил взгляд раньше, чем ты успел отвести глаза.",
            x: 180,
            y: 500,
            choices: [
              choice("«Кто принёс письмо?»", "courier", {
                effectVariable: "courier-lead",
                effectOperation: "set",
                effectValue: 1,
                relationshipCharacter: "ilyan",
                relationshipDelta: 1,
                effectOnce: true,
              }),
              choice("«Что вы сожгли в горне?»", "truth", {
                relationshipCharacter: "ilyan",
                relationshipDelta: -1,
                effectOnce: true,
              }),
              choice("Молча осмотреть стол.", "table"),
            ],
          },
          {
            id: "courier",
            character: "ilyan",
            line: "Мальчишка с Речного рынка. Босой, промокший, слишком хорошо заплатили. Имени он не знал.",
            voice: "ЛОГИКА",
            inner: "Не знал имени — но Вей не сказал, что не видел лица.",
            x: 700,
            y: 180,
            choices: [
              choice("«Опишите его».", "mark"),
              choice("Вернуться к горну.", "truth"),
            ],
          },
          {
            id: "table",
            character: "inner",
            line: "Воск на конверте ещё мягкий. Письмо лежит у горячего горна не больше часа — но дождь снаружи идёт всю ночь.",
            voice: "СОМНЕНИЕ",
            inner: "Он перенёс письмо сюда перед вашим приходом.",
            x: 700,
            y: 820,
            choices: [
              choice("«Вы только что положили его сюда».", "truth"),
              choice("Спросить о курьере.", "courier"),
            ],
          },
          {
            id: "mark",
            character: "ilyan",
            line: "На запястье — синяя нить и ожог в форме полумесяца. Теперь вы довольны?",
            voice: "ПАМЯТЬ",
            inner: "Такой ожог оставляет серебряная соль.",
            x: 1220,
            y: 180,
            choices: [choice("«Теперь — правда о горне».", "truth")],
          },
          {
            id: "truth",
            character: "ilyan",
            line: "Я сжёг последнюю страницу формулы. Если бы её прочли вслух, весь северный квартал проснулся бы без памяти.",
            voice: "ИНТУИЦИЯ",
            inner: "Он всё ещё лжёт. Но впервые — не о главном.",
            x: 1220,
            y: 500,
            choices: [
              choice(
                "«Ожог курьера связан с серебряной солью?»",
                "ash",
                {
                  conditionVariable: "courier-lead",
                  conditionOperator: "gte",
                  conditionValue: 1,
                  relationshipCharacter: "ilyan",
                  relationshipDelta: 1,
                  revealMindEvidence: "silver-burn",
                  effectOnce: true,
                },
              ),
              choice("«Кто заставил вас её написать?»", "ash"),
              choice("Закончить разговор."),
            ],
          },
          {
            id: "ash",
            character: "ilyan",
            line: "Найдите человека с серебряным ожогом. И не называйте при нём моё имя.",
            voice: "НОВАЯ ЗАЦЕПКА",
            inner: "Серебряный ожог — мастерские северного квартала.",
            x: 1740,
            y: 500,
            choices: [
              choice("Уйти и проверить северный квартал.", "", {
                revealCityPoint: "north-workshops",
                revealMindEvidence: "silver-burn",
                effectOnce: true,
              }),
            ],
          },
        ],
      },
      {
        id: "watch-followup",
        title: "После допроса",
        background: ASSET("alchemist-lab.webp"),
        start: "report",
        nodes: [
          {
            id: "report",
            character: "mirena",
            line: "Вей заговорил? Тогда у нас есть направление — мастерские северного квартала.",
            voice: "ДЕЛО ПРОДВИНУЛОСЬ",
            inner: "Она ждёт твоего вывода.",
            x: 350,
            y: 500,
            choices: [
              choice("Рассказать про серебряный ожог.", "lead"),
              choice("Пока промолчать."),
            ],
          },
          {
            id: "lead",
            character: "mirena",
            line: "Я подниму записи гильдии. Встретимся у северных ворот до рассвета.",
            voice: "СЛЕДУЮЩИЙ ШАГ",
            inner: "Время работает против вас.",
            x: 950,
            y: 500,
            choices: [choice("Закончить разговор.")],
          },
        ],
      },
    ],
  };
}
function normNode(n = {}, i = 0, chars = []) {
  const x = Number(n.x),
    y = Number(n.y),
    choiceIds = new Set(),
    choices = (Array.isArray(n.choices) ? n.choices : [])
      .filter((choice) => choice && typeof choice === "object")
      .slice(0, 100)
      .map((c) => {
        let id = safeId(c.id);
        if (choiceIds.has(id)) id = uid();
        choiceIds.add(id);
        return {
          id,
          text: String(c.text || "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .slice(0, 2000),
          target: String(c.target || c.success || "").slice(0, 128),
          conditionVariable: String(c.conditionVariable || "").slice(0, 128),
          conditionOperator: ["eq", "neq", "gt", "gte", "lt", "lte"].includes(
            c.conditionOperator,
          )
            ? c.conditionOperator
            : "gte",
          conditionValue: numberValue(c.conditionValue),
          effectVariable: String(c.effectVariable || "").slice(0, 128),
          effectOperation: c.effectOperation === "add" ? "add" : "set",
          effectValue: numberValue(c.effectValue),
          relationshipCharacter: String(
            c.relationshipCharacter || "",
          ).slice(0, 128),
          relationshipDelta: numberValue(c.relationshipDelta),
          revealCityPoint: String(c.revealCityPoint || "").slice(0, 128),
          revealCityId: String(c.revealCityId || "").slice(0, 128),
          revealCityScreen: String(c.revealCityScreen || "").slice(0, 128),
          revealMindEvidence: String(c.revealMindEvidence || "").slice(0, 128),
          revealMindBoard: String(c.revealMindBoard || "").slice(0, 128),
          questUuid: String(c.questUuid || "").slice(0, 512),
          effectOnce: c.effectOnce !== false,
        };
      });
  return {
    id: safeId(n.id),
    character: chars.some((c) => c.id === n.character)
      ? n.character
      : chars[0]?.id || "",
    line: String(n.line || "").slice(0, 10000),
    voice: String(n.voice || "").slice(0, 500),
    inner: String(n.inner || "").slice(0, 5000),
    x: Number.isFinite(x) ? x : 180 + (i % 4) * 470,
    y: Number.isFinite(y) ? y : 180 + Math.floor(i / 4) * 320,
    choices,
  };
}
function normalize(raw) {
  if (!raw || (!raw.scenes?.length && !raw.nodes?.length)) return example();
  let characters = (Array.isArray(raw.characters) ? raw.characters : [])
    .filter((character) => character && typeof character === "object")
    .slice(0, 200)
    .map((c) => ({
      id: safeId(c.id),
      name: String(c.name || t("DS.NewCharacter", "Новый персонаж")).slice(
        0,
        200,
      ),
      role: String(c.role || "").slice(0, 500),
      portrait: optimizedAsset(c.portrait).slice(0, 4096),
      actorUuid: String(c.actorUuid || "").slice(0, 512),
      color: safeColor(c.color),
      relationship: numberValue(c.relationship),
    }));
  if (!characters.length && Array.isArray(raw.nodes) && raw.nodes.length)
    for (const n of raw.nodes.slice(0, 1000)) {
      const narrator = t("DS.Narrator", "Рассказчик"),
        name = String(n.speaker || narrator).slice(0, 200),
        isNarrator = [narrator, "Рассказчик", "Narrator"].includes(name);
      if (!characters.some((c) => c.name === name))
        characters.push({
          id: uid(),
          name,
          role: String(n.role || "").slice(0, 500),
          portrait: isNarrator
            ? ""
            : optimizedAsset(raw.portrait).slice(0, 4096),
          color: isNarrator ? "#4d9aa0" : "#b96e46",
          relationship: 0,
        });
    }
  if (!characters.length)
    characters = [
      {
        id: uid(),
        name: t("DS.Narrator", "Рассказчик"),
        role: "",
        portrait: "",
        color: "#b96e46",
        relationship: 0,
      },
    ];
  const characterIds = new Set();
  characters.forEach((character) => {
    if (!character.id || characterIds.has(character.id)) character.id = uid();
    characterIds.add(character.id);
  });
  const sources =
    Array.isArray(raw.scenes) && raw.scenes.length
      ? raw.scenes
      : [
          {
            id: raw.id,
            title: raw.title,
            background: raw.background,
            start: raw.start,
            nodes: raw.nodes,
          },
        ];
  const scenes = sources
    .filter((scene) => scene && typeof scene === "object")
    .slice(0, 100)
    .map((s) => {
      const byName = new Map(characters.map((c) => [c.name, c.id])),
        nodes = (Array.isArray(s.nodes) ? s.nodes : [])
          .filter((node) => node && typeof node === "object")
          .slice(0, 1000)
          .map((n, i) =>
            normNode(
              { ...n, character: n.character || byName.get(n.speaker) },
              i,
              characters,
            ),
          );
      if (!nodes.length)
        nodes.push(
          normNode(
            { line: t("DS.NewPassage", "Новая реплика") },
            0,
            characters,
          ),
        );
      const uniqueNodeIds = new Set();
      nodes.forEach((node) => {
        if (!node.id || uniqueNodeIds.has(node.id)) node.id = uid();
        uniqueNodeIds.add(node.id);
      });
      const nodeIds = new Set(nodes.map((node) => node.id));
      nodes.forEach((node) =>
        node.choices.forEach((choice) => {
          if (!nodeIds.has(choice.target)) choice.target = "";
        }),
      );
      return {
        id: safeId(s.id),
        title: String(s.title || t("DS.NewScene", "Новая сцена")).slice(
          0,
          200,
        ),
        background: optimizedAsset(s.background).slice(0, 4096),
        greetingTableUuid: String(s.greetingTableUuid || "").slice(0, 512),
        start: nodes.some((n) => n.id === s.start) ? s.start : nodes[0].id,
        nodes,
      };
    });
  if (!scenes.length) return example();
  const sceneIds = new Set();
  scenes.forEach((scene) => {
    if (!scene.id || sceneIds.has(scene.id)) scene.id = uid();
    sceneIds.add(scene.id);
  });
  const variableIds = new Set(),
    variables = (Array.isArray(raw.variables) ? raw.variables : [])
      .filter((variable) => variable && typeof variable === "object")
      .slice(0, 100)
      .map((variable) => {
        let id = safeId(variable.id);
        if (variableIds.has(id)) id = uid();
        variableIds.add(id);
        return {
          id,
          name: String(
            variable.name || t("DS.NewVariable", "Новая переменная"),
          ).slice(0, 120),
          initial: numberValue(variable.initial),
        };
      });
  if (Number(raw.version || 0) < 4) {
    const interrogation = scenes.find(
        (scene) => scene.id === "vey-interrogation",
      ),
      ilyan = characters.find((character) => character.id === "ilyan");
    if (interrogation && ilyan) {
      if (!variables.some((variable) => variable.id === "courier-lead"))
        variables.push({
          id: "courier-lead",
          name: "След курьера",
          initial: 0,
        });
      const arrival = interrogation.nodes.find((node) => node.id === "arrival"),
        truth = interrogation.nodes.find((node) => node.id === "truth"),
        ash = interrogation.nodes.find((node) => node.id === "ash"),
        courierChoice = arrival?.choices.find((choice) =>
          /курьер|письмо/i.test(choice.text),
        );
      if (courierChoice) {
        courierChoice.effectVariable = "courier-lead";
        courierChoice.effectOperation = "set";
        courierChoice.effectValue = 1;
        courierChoice.relationshipCharacter = "ilyan";
        courierChoice.relationshipDelta = 1;
        courierChoice.effectOnce = true;
      }
      if (
        truth &&
        !truth.choices.some(
          (choice) => choice.conditionVariable === "courier-lead",
        )
      )
        truth.choices.unshift(
          normNode(
            {
              choices: [
                {
                  text: "«Ожог курьера связан с серебряной солью?»",
                  target: "ash",
                  conditionVariable: "courier-lead",
                  conditionOperator: "gte",
                  conditionValue: 1,
                  relationshipCharacter: "ilyan",
                  relationshipDelta: 1,
                  revealMindEvidence: "silver-burn",
                  effectOnce: true,
                },
              ],
            },
            0,
            characters,
          ).choices[0],
        );
      const exitChoice = ash?.choices[0];
      if (exitChoice) {
        exitChoice.revealCityPoint = "north-workshops";
        exitChoice.revealMindEvidence = "silver-burn";
        exitChoice.effectOnce = true;
      }
    }
  }
  const validVariables = new Set(variables.map((variable) => variable.id)),
    validCharacters = new Set(characters.map((character) => character.id));
  scenes.forEach((scene) =>
    scene.nodes.forEach((node) =>
      node.choices.forEach((choice) => {
        if (!validVariables.has(choice.conditionVariable))
          choice.conditionVariable = "";
        if (!validVariables.has(choice.effectVariable))
          choice.effectVariable = "";
        if (!validCharacters.has(choice.relationshipCharacter))
          choice.relationshipCharacter = "";
      }),
    ),
  );
  return {
    version: 4,
    characters,
    variables,
    activeScene: scenes.some((s) => s.id === raw.activeScene)
      ? raw.activeScene
      : scenes[0].id,
    scenes,
  };
}
const getProject = () => normalize(game.settings.get(MOD, "scene")),
  findScene = (p, id) => p.scenes.find((s) => s.id === id) || p.scenes[0],
  findNode = (s, id) => s.nodes.find((n) => n.id === id) || s.nodes[0],
  findChar = (p, id) =>
    p.characters.find((c) => c.id === id) || p.characters[0],
  editScene = () => findScene(S.draft, S.scene),
  editNode = () => findNode(editScene(), S.selected);

function normalizeStoryState(raw, project = getProject()) {
  const source = raw && typeof raw === "object" ? raw : {},
    sourceVariables =
      source.variables && typeof source.variables === "object"
        ? source.variables
        : {},
    sourceRelationships =
      source.relationships && typeof source.relationships === "object"
        ? source.relationships
        : {},
    sourceIntegrations =
      source.integrations && typeof source.integrations === "object"
        ? source.integrations
        : {},
    receiptIds = new Set(),
    receipts = (Array.isArray(source.receipts) ? source.receipts : [])
      .slice(-RECEIPT_LIMIT)
      .flatMap((entry) => {
        const id = requestId(typeof entry === "string" ? entry : entry?.id);
        if (!id || receiptIds.has(id)) return [];
        receiptIds.add(id);
        return [
          {
            id,
            accepted: typeof entry === "string" ? true : entry.accepted === true,
            applied: typeof entry === "object" && entry?.applied === true,
            localApplied:
              typeof entry === "object" && entry?.localApplied === true,
            city:
              typeof entry === "object" && typeof entry?.city === "boolean"
                ? entry.city
                : null,
            quest: typeof entry?.quest === "boolean" ? entry.quest : null,
            mind:
              typeof entry === "object" && typeof entry?.mind === "boolean"
                ? entry.mind
                : null,
          },
        ];
      });
  return {
    version: STORY_STATE_VERSION,
    variables: Object.fromEntries(
      project.variables.map((variable) => [
        variable.id,
        numberValue(sourceVariables[variable.id], variable.initial),
      ]),
    ),
    relationships: Object.fromEntries(
      project.characters.map((character) => [
        character.id,
        numberValue(
          sourceRelationships[character.id],
          character.relationship,
        ),
      ]),
    ),
    applied: Array.from(
      new Set(
        (Array.isArray(source.applied) ? source.applied : [])
          .filter(
            (entry) => typeof entry === "string" && entry.length <= 512,
          )
          .slice(-5000),
      ),
    ),
    integrations: Object.fromEntries(
      Object.entries(sourceIntegrations)
        .filter(
          ([key, value]) =>
            key.length <= 512 && value && typeof value === "object",
        )
        .slice(-5000)
        .map(([key, value]) => [
          key,
          {
            city: value.city === true,
            mind: value.mind === true,
            quest: value.quest === true,
          },
        ]),
    ),
    receipts,
  };
}

function getStoryState(project = getProject()) {
  return normalizeStoryState(
    game.settings.get(MOD, "storyState"),
    project,
  );
}

function findReceipt(state, id) {
  const clean = requestId(id);
  return clean
    ? state.receipts.find((receipt) => receipt.id === clean) || null
    : null;
}

function addReceipt(state, id, accepted, details = {}) {
  const clean = requestId(id);
  if (!clean || findReceipt(state, clean)) return;
  state.receipts.push({
    id: clean,
    accepted: accepted === true,
    applied: details.applied === true,
    localApplied: details.localApplied === true,
    city: typeof details.city === "boolean" ? details.city : null,
    mind: typeof details.mind === "boolean" ? details.mind : null,
    quest: typeof details.quest === "boolean" ? details.quest : null,
  });
  state.receipts = state.receipts.slice(-RECEIPT_LIMIT);
}

function choiceAvailable(choice, state) {
  if (!choice.conditionVariable) return true;
  const current = numberValue(state.variables[choice.conditionVariable]),
    expected = numberValue(choice.conditionValue);
  switch (choice.conditionOperator) {
    case "eq":
      return current === expected;
    case "neq":
      return current !== expected;
    case "gt":
      return current > expected;
    case "lt":
      return current < expected;
    case "lte":
      return current <= expected;
    default:
      return current >= expected;
  }
}

function hasChoiceEffects(choice) {
  return Boolean(
    choice.effectVariable ||
      choice.relationshipCharacter ||
      choice.revealCityPoint ||
      choice.revealMindEvidence || choice.questUuid,
  );
}

function hasLocalChoiceEffects(choice) {
  return Boolean(choice.effectVariable || choice.relationshipCharacter);
}

function choiceEffectStatus(scene, node, choice, state) {
  const key = choiceKey(scene, node, choice),
    alreadyApplied = choice.effectOnce && state.applied.includes(key),
    delivered = state.integrations[key] || {};
  return {
    key,
    alreadyApplied,
    localPending: hasLocalChoiceEffects(choice) && !alreadyApplied,
    cityPending:
      Boolean(choice.revealCityPoint) &&
      (!choice.effectOnce || delivered.city !== true),
    questPending: Boolean(choice.questUuid) && (!choice.effectOnce || delivered.quest !== true),
    mindPending:
      Boolean(choice.revealMindEvidence) &&
      (!choice.effectOnce || delivered.mind !== true),
  };
}

function choiceNeedsCommit(scene, node, choice, state) {
  const status = choiceEffectStatus(scene, node, choice, state);
  return status.localPending || status.cityPending || status.mindPending || status.questPending;
}

function isPrimaryGM() {
  const active = game.users?.activeGM;
  if (active) return active.id === game.user.id;
  const activeGMs = game.users?.filter?.(
    (user) => user.active && user.isGM,
  );
  return (
    (Array.isArray(activeGMs) ? activeGMs : [])
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0]?.id ===
    game.user.id
  );
}

async function grantQuest(uuid) {
  if (!game.user.isGM) return false;
  const page = await fromUuid(uuid);
  if (page?.documentName !== "JournalEntryPage" || page.pack || !page.parent)
    throw new Error(t("DS.InvalidQuest", "Укажите UUID страницы квеста из этого мира."));
  const users = game.users.contents.filter(user => !user.isGM);
  if (!users.length) throw new Error(t("DS.NoQuestPlayers", "В мире нет игроков для выдачи квеста."));
  const parent = page.parent, parentUpdate = {}, pageUpdate = {}, siblings = [];
  for (const user of users) {
    if (!parent.testUserPermission(user, "OBSERVER")) {
      // Preserve each sibling's effective ownership before revealing its container.
      for (const sibling of parent.pages) {
        if (sibling.id === page.id) continue;
        const own = sibling.ownership[user.id] ?? sibling.ownership.default ?? -1;
        if (own !== -1) continue;
        let update = siblings.find(change => change._id === sibling.id);
        if (!update) { update = { _id: sibling.id }; siblings.push(update); }
        update["ownership." + user.id] = Math.max(0, parent.ownership[user.id] ?? parent.ownership.default ?? 0);
      }
      parentUpdate["ownership." + user.id] = 2;
    }
    if (!page.testUserPermission(user, "OBSERVER")) pageUpdate["ownership." + user.id] = 2;
  }
  if (siblings.length) await parent.updateEmbeddedDocuments("JournalEntryPage", siblings);
  if (Object.keys(parentUpdate).length) await parent.update(parentUpdate);
  if (Object.keys(pageUpdate).length) await page.update(pageUpdate);
  if (Object.keys(parentUpdate).length || Object.keys(pageUpdate).length) {
    const content = `<p>${esc(t("DS.QuestReceived", "Получен квест"))}: <button type="button" data-ds-quest="${esc(page.uuid)}">${esc(page.name)}</button></p>`;
    await ChatMessage.create({ content, whisper: users.map(user => user.id), speaker: ChatMessage.getSpeaker({ user: game.user }) });
  }
  Hooks.callAll("dialogueStage.questGranted", { uuid: page.uuid, userIds: users.map(user => user.id) });
  return true;
}
async function runChoiceIntegrations(
  choice,
  context,
  pending = { city: true, mind: true, quest: true },
) {
  const results = { city: null, mind: null, quest: null };
  if (choice.questUuid && pending.quest) {
    try { results.quest = await grantQuest(choice.questUuid); }
    catch (error) { results.quest = false; reportError("quest delivery failed", error); }
  }
  if (choice.revealCityPoint && pending.city) {
    const reveal = game.modules.get("city-viewer")?.api?.revealPoint;
    try {
      results.city = reveal
        ? (await (choice.revealCityId && choice.revealCityScreen
            ? reveal(
                choice.revealCityId,
                choice.revealCityScreen,
                choice.revealCityPoint,
                { source: MOD, ...context },
              )
            : reveal(choice.revealCityPoint, {
                source: MOD,
                ...context,
              }))) !== false
        : false;
      if (results.city)
        Hooks.callAll("dialogueStage.cityPointRevealed", {
          pointId: choice.revealCityPoint,
          ...context,
        });
    } catch (error) {
      results.city = false;
      console.error(`${MOD} | city reveal failed`, error);
    }
  }
  if (choice.revealMindEvidence && pending.mind) {
    const api = game.modules.get("mind-palace")?.api;
    try {
      const reveal = api?.revealEvidence || api?.revealNode;
      results.mind = reveal
        ? (await reveal(choice.revealMindEvidence, {
            source: MOD,
            boardId: choice.revealMindBoard,
            ...context,
          })) !== false
        : false;
      if (results.mind)
        Hooks.callAll("dialogueStage.evidenceRevealed", {
          evidenceId: choice.revealMindEvidence,
          ...context,
        });
    } catch (error) {
      results.mind = false;
      console.error(`${MOD} | evidence reveal failed`, error);
    }
  }
  return results;
}

function enqueueStoryWrite(write) {
  S.effectChain = S.effectChain.then(write, write);
  return S.effectChain;
}

function applyChoiceEffects(project, scene, node, choice, userId, receiptId = "") {
  const write = async () => {
    const currentProject = getProject(),
      currentScene = currentProject.scenes.find(
        (candidate) => candidate.id === scene?.id,
      ),
      currentNode = currentScene?.nodes.find(
        (candidate) => candidate.id === node?.id,
      ),
      currentChoice = currentNode?.choices.find(
        (candidate) => candidate.id === choice?.id,
      ),
      state = getStoryState(currentProject),
      existingReceipt = findReceipt(state, receiptId);
    if (!game.user.isGM)
      return {
        accepted: false,
        applied: false,
        localApplied: false,
        reason: "not-gm",
        integrations: { city: null, mind: null },
        state,
      };
    if (existingReceipt)
      return {
        accepted: existingReceipt.accepted,
        applied: existingReceipt.applied,
        localApplied: existingReceipt.localApplied,
        duplicate: true,
        reason: existingReceipt.accepted ? "duplicate" : "condition",
        integrations: {
          city: existingReceipt.city,
          mind: existingReceipt.mind,
          quest: existingReceipt.quest,
        },
        state,
      };
    if (!currentScene || !currentNode || !currentChoice) {
      if (requestId(receiptId)) {
        addReceipt(state, receiptId, false);
        await game.settings.set(MOD, "storyState", state);
        S.runtimeState = state;
      }
      return {
        accepted: false,
        applied: false,
        localApplied: false,
        reason: "missing",
        integrations: { city: null, mind: null },
        state,
      };
    }
    if (!choiceAvailable(currentChoice, state)) {
      if (requestId(receiptId)) {
        addReceipt(state, receiptId, false);
        await game.settings.set(MOD, "storyState", state);
        S.runtimeState = state;
      }
      return {
        accepted: false,
        applied: false,
        localApplied: false,
        reason: "condition",
        integrations: { city: null, mind: null },
        state,
      };
    }
    const status = choiceEffectStatus(
        currentScene,
        currentNode,
        currentChoice,
        state,
      ),
      effectRecorded =
        hasChoiceEffects(currentChoice) && !status.alreadyApplied,
      localApplied = status.localPending;
    if (
      !effectRecorded &&
      !localApplied &&
      !status.cityPending &&
      !status.mindPending && !status.questPending
    ) {
      addReceipt(state, receiptId, true);
      if (requestId(receiptId))
        await game.settings.set(MOD, "storyState", state);
      S.runtimeState = state;
      return {
        accepted: true,
        applied: false,
        localApplied: false,
        reason: status.alreadyApplied ? "already-applied" : "no-effects",
        integrations: { city: null, mind: null },
        state,
      };
    }
    if (localApplied && currentChoice.effectVariable) {
      const current = numberValue(
        state.variables[currentChoice.effectVariable],
      );
      state.variables[currentChoice.effectVariable] =
        currentChoice.effectOperation === "add"
          ? numberValue(current + currentChoice.effectValue)
          : numberValue(currentChoice.effectValue);
    }
    if (localApplied && currentChoice.relationshipCharacter) {
      const current = numberValue(
        state.relationships[currentChoice.relationshipCharacter],
      );
      state.relationships[currentChoice.relationshipCharacter] = numberValue(
        current + currentChoice.relationshipDelta,
      );
    }
    if (effectRecorded && currentChoice.effectOnce)
      state.applied.push(status.key);
    state.applied = state.applied.slice(-5000);
    const context = {
        sceneId: currentScene.id,
        nodeId: currentNode.id,
        choiceId: currentChoice.id,
        userId,
      },
      integrations =
        status.cityPending || status.mindPending || status.questPending
          ? await runChoiceIntegrations(currentChoice, context, {
              city: status.cityPending,
              mind: status.mindPending,
              quest: status.questPending,
            })
          : { city: null, mind: null };
    if (
      currentChoice.effectOnce &&
      (currentChoice.revealCityPoint || currentChoice.revealMindEvidence || currentChoice.questUuid)
    ) {
      const delivered = state.integrations[status.key] || {
        city: false,
        mind: false,
      };
      if (typeof integrations.city === "boolean")
        delivered.city = delivered.city || integrations.city;
      if (typeof integrations.mind === "boolean")
        delivered.mind = delivered.mind || integrations.mind;
      if (typeof integrations.quest === "boolean") delivered.quest = delivered.quest || integrations.quest;
      state.integrations[status.key] = delivered;
    }
    const applied =
      effectRecorded || integrations.city === true || integrations.mind === true || integrations.quest === true;
    addReceipt(state, receiptId, true, {
      applied,
      localApplied,
      city: integrations.city,
      mind: integrations.mind,
      quest: integrations.quest,
    });
    if (
      effectRecorded ||
      status.cityPending ||
      status.mindPending || status.questPending ||
      requestId(receiptId)
    )
      await game.settings.set(MOD, "storyState", state);
    S.runtimeState = state;
    game.socket.emit(`module.${MOD}`, {
      type: "story-state",
      userId: game.user.id,
    });
    Hooks.callAll("dialogueStage.choiceApplied", {
      ...context,
      applied,
      localApplied,
      integrations: { ...integrations },
      state: clone(state),
    });
    return {
      accepted: true,
      applied,
      localApplied,
      reason: status.alreadyApplied ? "integration-retry" : "accepted",
      integrations,
      state,
    };
  };
  return enqueueStoryWrite(write);
}

function relationshipLabel(value) {
  if (value <= -5) return t("DS.Relationship.Hostile", "Враждебность");
  if (value <= -2) return t("DS.Relationship.Wary", "Недоверие");
  if (value < 2) return t("DS.Relationship.Neutral", "Нейтрально");
  if (value < 5) return t("DS.Relationship.Trust", "Доверие");
  return t("DS.Relationship.Devoted", "Преданность");
}

function showConsequence(choice, project, transaction = null) {
  const messages = [];
  if (
    choice.relationshipCharacter &&
    choice.relationshipDelta &&
    transaction?.localApplied !== false
  ) {
    const character = findChar(project, choice.relationshipCharacter),
      direction = choice.relationshipDelta > 0 ? "+" : "−";
    messages.push(
      `<span><i class="fas fa-heart"></i>${esc(character.name)} · ${direction}${Math.abs(choice.relationshipDelta)}</span>`,
    );
  }
  if (
    choice.revealMindEvidence &&
    transaction?.integrations?.mind !== false
  )
    messages.push(
      `<span><i class="fas fa-lightbulb"></i>${t("DS.NewEvidence", "Новая зацепка")}</span>`,
    );
  if (
    choice.revealCityPoint &&
    transaction?.integrations?.city !== false
  )
    messages.push(
      `<span><i class="fas fa-map-location-dot"></i>${t("DS.NewLocation", "Открыто новое место")}</span>`,
    );
  if (
    !messages.length &&
    choice.effectVariable &&
    transaction?.localApplied !== false
  )
    messages.push(
      `<span><i class="fas fa-bookmark"></i>${t("DS.StoryRemembers", "История запомнит это")}</span>`,
    );
  if (choice.questUuid && transaction?.integrations?.quest === true)
    messages.push(`<button type="button" data-ds-quest="${esc(choice.questUuid)}"><i class="fas fa-book"></i>${t("DS.QuestReceived", "Получен квест")}</button>`);
  if (!messages.length || !S.viewer) return;
  S.viewer.querySelector(".ds-consequence")?.remove();
  const notice = document.createElement("div");
  notice.className = "ds-consequence";
  notice.setAttribute("role", "status");
  notice.innerHTML = messages.join("");
  S.viewer.append(notice);
  requestAnimationFrame(() => notice.classList.add("is-visible"));
  setTimeout(() => {
    notice.classList.remove("is-visible");
    setTimeout(() => notice.remove(), 280);
  }, 2200);
}
function resolveScene(p, ref) {
  return (
    p.scenes.find((s) => s.id === ref) ||
    p.scenes.find((s) => s.nodes.some((n) => n.id === ref)) ||
    findScene(p, p.activeScene)
  );
}

function isImportableProject(project) {
  return Boolean(
    project &&
      typeof project === "object" &&
      ((Array.isArray(project.scenes) && project.scenes.length) ||
        (Array.isArray(project.nodes) && project.nodes.length)),
  );
}

function settlePendingChoices(state) {
  const normalized = normalizeStoryState(state);
  S.runtimeState = normalized;
  for (const [id, pending] of S.pendingChoices) {
    const receipt = findReceipt(normalized, id);
    if (!receipt) continue;
    clearTimeout(pending.timer);
    S.pendingChoices.delete(id);
    pending.resolve({
      accepted: receipt.accepted,
      applied: receipt.applied,
      localApplied: receipt.localApplied,
      reason: receipt.accepted ? "accepted" : "condition",
      integrations: { city: receipt.city, mind: receipt.mind, quest: receipt.quest },
      state: normalized,
    });
  }
  return normalized;
}

function cancelPendingChoices(reason = "cancelled") {
  for (const [id, pending] of S.pendingChoices) {
    clearTimeout(pending.timer);
    pending.resolve({
      accepted: false,
      applied: false,
      localApplied: false,
      reason,
      integrations: { city: null, mind: null },
      state: S.runtimeState,
    });
    S.pendingChoices.delete(id);
  }
}

function hasActiveGM() {
  if (game.users?.activeGM?.active) return true;
  const users = game.users?.filter?.((user) => user.active && user.isGM);
  if (Array.isArray(users)) return users.length > 0;
  return Array.from(game.users?.values?.() || []).some(
    (user) => user.active && user.isGM,
  );
}

function requestChoiceEffect(scene, node, choice) {
  if (!hasActiveGM())
    return Promise.resolve({
      accepted: false,
      applied: false,
      localApplied: false,
      reason: "no-gm",
      integrations: { city: null, mind: null },
      state: getStoryState(),
    });
  const id = uid();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      S.pendingChoices.delete(id);
      resolve({
        accepted: false,
        applied: false,
        localApplied: false,
        reason: "timeout",
        integrations: { city: null, mind: null },
        state: getStoryState(),
      });
    }, CHOICE_TIMEOUT);
    S.pendingChoices.set(id, { resolve, timer });
    game.socket.emit(`module.${MOD}`, {
      type: "choice",
      requestId: id,
      sceneId: scene.id,
      nodeId: node.id,
      choiceId: choice.id,
      userId: game.user.id,
    });
  });
}

function closeViewer() {
  S.openRevision = (S.openRevision || 0) + 1;
  S.openingLine = null;
  document.body.classList.remove("ds-chat-open");
  cancelAnimationFrame(S.motionFrame);
  S.motionFrame = 0;
  S.motion = null;
  S.viewer?.remove();
  S.viewer = null;
  S.history = [];
  S.choiceBusy = false;
  cancelPendingChoices();
  S.runtimeState = null;
}
async function openViewer(ref = null, nodeRef = null, sharedGreeting = null) {
  closeViewer();
  const revision = S.openRevision;
  if (String(ref || "").startsWith("JournalEntry.")) {
    const entity = await globalThis.UniCanvasDocuments?.resolve(ref);
    if (revision !== S.openRevision) return;
    if (!entity || entity.moduleId !== MOD) throw new Error(t("DS.InvalidEntity", "Диалог по этому UUID не найден."));
    ref = entity.path[1];
    nodeRef ||= entity.path[3] || null;
  }
  const p = getProject(),
    scene = resolveScene(p, ref),
    node =
      nodeRef ||
      (ref && scene.nodes.some((n) => n.id === ref) ? ref : scene.start),
    e = document.createElement("section");
  e.id = "ds-viewer";
  e.dataset.sceneId = scene.id;
  e.setAttribute("role", "dialog");
  e.setAttribute("aria-modal", "true");
  e.setAttribute("aria-label", t("DS.Title", "Диалог"));
  e.innerHTML = `<div class="ds-bg" style="background-image:url('${esc(cssUrl(scene.background))}')"></div><div class="ds-light"></div><div class="ds-portrait"></div><button class="ds-exit" data-view="close"><i class="fas fa-arrow-left"></i>${t("DS.Exit", "Выйти из диалога")}</button><nav class="ds-tools" aria-label="${esc(t("DS.Tools", "Инструменты диалога"))}"><button data-view="character"><i class="fas fa-user-shield"></i>${t("DS.Character", "Персонаж")}</button><button data-view="chat" aria-pressed="false"><i class="fas fa-comments"></i>${t("DS.Chat", "Чат")}</button><button data-view="history" aria-pressed="false"><i class="fas fa-clock-rotate-left"></i>${t("DS.History", "История")}</button></nav><main class="ds-dialogue" aria-live="polite"></main><aside class="ds-history" aria-label="${esc(t("DS.History", "История"))}"></aside>`;
  document.body.append(e);
  S.viewer = e;
  S.runtimeState = getStoryState(p);
  bindViewer(e, p, scene);
  showNode(p, scene, node);
  if (scene.greetingTableUuid && node === scene.start) {
    try {
      const greeting = typeof sharedGreeting === "string" ? sharedGreeting.slice(0, 10000) : await rollGreeting(scene.greetingTableUuid);
      if (revision !== S.openRevision || S.viewer !== e || S.node !== node) return;
      if (greeting) {
        S.openingLine = { scene: scene.id, node, line: greeting };
        findNode(scene, node).line = greeting;
        S.history.pop();
        showNode(p, scene, node);
      }
    } catch (error) {
      if (revision === S.openRevision) ui.notifications.warn(error.message);
    }
  }
  e.querySelector('[data-view="close"]')?.focus();
}
async function rollGreeting(uuid) {
  const table = await fromUuid(uuid);
  if (table?.documentName !== "RollTable" || !table.testUserPermission(game.user, "OBSERVER"))
    throw new Error(t("DS.TableUnavailable", "Таблица недоступна. Проверьте UUID и права игроков."));
  // roll respects the table formula and ranges, without consuming drawn results or posting to chat.
  const rolled = await table.roll({ recursive: true });
  const text = rolled.results.map(result => {
    const fragment = document.createElement("div");
    fragment.innerHTML = result.description || result.text || result.name || "";
    return fragment.textContent.trim();
  }).filter(Boolean).join("\n");
  if (!text) throw new Error(t("DS.TableEmpty", "Таблица не вернула реплику."));
  return text.slice(0, 10000);
}
function showNode(p, scene, id, { record = true } = {}) {
  const sourceNode = findNode(scene, id),
    n = S.openingLine?.scene === scene.id && S.openingLine.node === id ? { ...sourceNode, line: S.openingLine.line } : sourceNode,
    c = liveCharacter(findChar(p, n.character)),
    host = S.viewer?.querySelector(".ds-dialogue"),
    state = normalizeStoryState(S.runtimeState, p),
    choices = n.choices.filter((choice) => choiceAvailable(choice, state)),
    tracksRelationship = p.scenes.some((candidateScene) =>
      candidateScene.nodes.some((candidateNode) =>
        candidateNode.choices.some(
          (choice) => choice.relationshipCharacter === c.id,
        ),
      ),
    ),
    relationship = numberValue(state.relationships[c.id]);
  S.node = n.id;
  if (record) {
    S.history.push({ speaker: c.name, line: n.line });
    if (S.history.length > 200) S.history.splice(0, S.history.length - 200);
  }
  if (!host) return;
  const portrait = S.viewer.querySelector(".ds-portrait");
  portrait.style.backgroundImage = c.portrait
    ? `url('${cssUrl(c.portrait)}')`
    : "none";
  portrait.classList.toggle("is-empty", !c.portrait);
  S.viewer.style.setProperty("--ds-accent", c.color);
  host.classList.remove("is-ready");
  host.innerHTML = `<div class="ds-speaker"><small>${esc(c.role)}</small><h1>${esc(c.name)}</h1>${tracksRelationship ? `<div class="ds-relationship" style="--relationship:${Math.max(0, Math.min(100, 50 + relationship * 10))}%"><span>${esc(relationshipLabel(relationship))}</span><i></i></div>` : ""}</div><div class="ds-copy"><p>${esc(n.line)}</p>${n.voice || n.inner ? `<blockquote><strong>${esc(n.voice)}</strong><span>${esc(n.inner)}</span></blockquote>` : ""}</div><div class="ds-choices">${choices.length ? choices.map((q, i) => `<button data-choice="${esc(q.id)}" style="--i:${i}"><span>${esc(q.text)}</span></button>`).join("") : `<button data-finish><span>${t("DS.Finish", "Закончить разговор")}</span></button>`}</div>`;
  requestAnimationFrame(() => host.classList.add("is-ready"));
  renderHistory();
  preloadNextAssets(p, scene, n);
}
function liveCharacter(character) {
  if (!character.actorUuid) return character;
  try {
    const actor = globalThis.fromUuidSync?.(character.actorUuid);
    if (actor?.documentName === "Actor" && actor.testUserPermission(game.user, "OBSERVER"))
      return { ...character, name: actor.name, portrait: actor.img || character.portrait };
  } catch (error) { console.warn(MOD + " | Actor binding", error); }
  return character;
}
function renderHistory() {
  const h = S.viewer?.querySelector(".ds-history");
  if (!h) return;
  h.innerHTML = `<header><b>${t("DS.History", "История")}</b><button data-history-close aria-label="${esc(t("DS.Close", "Закрыть"))}"><i class="fas fa-xmark"></i></button></header>${S.history.map((x) => `<article><small>${esc(x.speaker)}</small><p>${esc(x.line)}</p></article>`).join("")}`;
  h.scrollTop = h.scrollHeight;
}
async function actorSheet() {
  const actor = game.user.character;
  if (!actor)
    return ui.notifications.warn(
      t("DS.NoCharacter", "Пользователю не назначен персонаж."),
    );
  const sheet = actor.sheet;
  if (!sheet?.render)
    return ui.notifications.warn(
      t("DS.SheetUnavailable", "Лист персонажа недоступен."),
    );
  try {
    await sheet.render({ force: true });
  } catch {
    await sheet.render(true);
  }
  requestAnimationFrame(() => {
    const e = sheet.element?.[0] || sheet.element;
    e?.classList?.add("ds-elevated");
    if (e?.style) e.style.zIndex = "14100";
  });
}
function bindViewer(e, p, scene) {
  e.onclick = async (x) => {
    const a = x.target.closest("[data-view]")?.dataset.view;
    if (a === "close" || x.target.closest("[data-finish]"))
      return closeViewer();
    if (a === "character") return actorSheet();
    if (a === "chat") {
      const on = document.body.classList.toggle("ds-chat-open");
      const button = x.target.closest("button");
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", String(on));
      if (on) {
        if (typeof ui.sidebar?.changeTab === "function")
          ui.sidebar.changeTab("chat", "primary");
        else ui.sidebar?.activateTab?.("chat");
      }
      return;
    }
    if (a === "history") {
      const open = e.classList.toggle("show-history");
      x.target.closest("button")?.setAttribute("aria-pressed", String(open));
      return;
    }
    if (x.target.closest("[data-history-close]"))
      return e.classList.remove("show-history");
    const choiceId = x.target.closest("[data-choice]")?.dataset.choice;
    if (choiceId === undefined || S.choiceBusy) return;
    const node = findNode(scene, S.node),
      q = node.choices.find((choice) => choice.id === choiceId),
      currentState = normalizeStoryState(S.runtimeState, p);
    if (!q || !choiceAvailable(q, currentState)) return;
    const willApply = choiceNeedsCommit(scene, node, q, currentState);
    S.choiceBusy = true;
    let transaction = null;
    try {
      if (game.user.isGM && willApply)
        transaction = await applyChoiceEffects(
          p,
          scene,
          node,
          q,
          game.user.id,
          uid(),
        );
      else if (!game.user.isGM && willApply)
        transaction = await requestChoiceEffect(scene, node, q);
    } catch (error) {
      reportError("choice consequence failed", error);
      return;
    } finally {
      S.choiceBusy = false;
    }
    if (S.viewer !== e) return;
    if (transaction && !transaction.accepted) {
      S.runtimeState = normalizeStoryState(transaction.state, p);
      showNode(p, scene, node.id, { record: false });
      const key =
        transaction.reason === "no-gm"
          ? "DS.NoActiveGM"
          : transaction.reason === "timeout"
            ? "DS.ChoiceTimeout"
            : "DS.ChoiceUnavailable";
      return ui.notifications.warn(
        t(
          key,
          transaction.reason === "no-gm"
            ? "Нет активного мастера: последствия выбора не применены."
            : transaction.reason === "timeout"
              ? "Мастер не подтвердил выбор вовремя. Попробуйте ещё раз."
              : "Этот вариант ответа больше недоступен.",
        ),
      );
    }
    if (transaction?.integrations?.quest === false) {
      ui.notifications.warn(t("DS.QuestFailed", "Квест не выдан. Мастеру нужно проверить UUID и права. Повторите ответ после исправления."));
      return;
    }
    if (transaction) {
      S.runtimeState = normalizeStoryState(transaction.state, p);
      if (transaction.applied) showConsequence(q, p, transaction);
    }
    q?.target ? showNode(p, scene, q.target) : closeViewer();
  };
  const bg = e.querySelector(".ds-bg"),
    portrait = e.querySelector(".ds-portrait");
  if (!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches)
    e.onpointermove = (x) => {
      S.motion = { x: x.clientX, y: x.clientY };
      if (S.motionFrame) return;
      S.motionFrame = requestAnimationFrame(() => {
        S.motionFrame = 0;
        if (!S.viewer || !S.motion) return;
        const dx = S.motion.x / innerWidth - 0.5,
          dy = S.motion.y / innerHeight - 0.5;
        bg.style.translate = `${dx * -10}px ${dy * -7}px`;
        portrait.style.translate = `${dx * 13}px ${dy * 6}px`;
      });
    };
  e.onkeydown = (event) => {
    if (event.key === "Escape") closeViewer();
  };
}

async function closeEditor({ saveDraft = true } = {}) {
  clearTimeout(S.timer);
  S.timer = 0;
  const pending = saveDraft && S.draft && S.editor ? save(false) : null;
  if (S.canvas) S.camera = S.canvas.getState();
  S.canvas?.destroy();
  S.canvas = null;
  S.wireCleanup?.();
  S.wireCleanup = null;
  cancelAnimationFrame(S.edgeFrame);
  S.edgeFrame = 0;
  S.editor?.remove();
  S.editor = null;
  S.draft = null;
  S.undo.length = 0;
  S.redo.length = 0;
  S.inputSnapshot = null;
  S.inputSnapshotArmed = false;
  if (pending) await pending;
}
function openEditor() {
  if (!game.user.isGM) return;
  if (S.editor?.isConnected) {
    S.editor.querySelector(".ds-graph-viewport")?.focus();
    return;
  }
  closeViewer();
  S.draft = getProject();
  S.scene = S.draft.activeScene;
  S.selected = editScene().start;
  S.character = S.draft.characters[0].id;
  S.variable = S.draft.variables[0]?.id || null;
  S.panel = "node";
  S.undo.length = 0;
  S.redo.length = 0;
  const e = document.createElement("section");
  e.id = "ds-editor";
  e.setAttribute("role", "dialog");
  e.setAttribute("aria-modal", "true");
  e.setAttribute("aria-label", t("DS.Editor", "Редактор диалогов"));
  e.innerHTML = `<header><div><strong>${t("DS.Editor", "Редактор диалогов")}</strong><span class="ds-current-scene"></span></div><nav><button data-ed="undo" aria-label="${esc(t("DS.Undo", "Отменить"))}" title="${esc(t("DS.UndoHint", "Отменить · Ctrl+Z"))}" disabled><i class="fas fa-rotate-left"></i></button><button data-ed="redo" aria-label="${esc(t("DS.Redo", "Повторить"))}" title="${esc(t("DS.RedoHint", "Повторить · Ctrl+Shift+Z"))}" disabled><i class="fas fa-rotate-right"></i></button><button data-ed="export" aria-label="${esc(t("DS.Export", "Экспортировать"))}" title="${esc(t("DS.Export", "Экспортировать"))}"><i class="fas fa-file-export"></i></button><button data-ed="import" aria-label="${esc(t("DS.Import", "Импортировать"))}" title="${esc(t("DS.Import", "Импортировать"))}"><i class="fas fa-file-import"></i></button><button data-ed="presets"><i class="fas fa-box-archive"></i>${t("DS.Presets", "Пресеты")}</button><button data-ed="copy-uuid" title="UUID"><i class="fas fa-link"></i>UUID</button><button data-ed="add-node"><i class="fas fa-plus"></i>${t("DS.Passage", "Реплика")}</button><button data-ed="preview"><i class="fas fa-play"></i>${t("DS.Preview", "Предпросмотр")}</button><button data-ed="show"><i class="fas fa-users"></i>${t("DS.Show", "Открыть всем")}</button><button data-ed="save"><i class="fas fa-floppy-disk"></i>${t("DS.Save", "Сохранить")}</button><button data-ed="close" aria-label="${esc(t("DS.Close", "Закрыть"))}"><i class="fas fa-xmark"></i></button></nav></header><div class="ds-editor-v2"><aside class="ds-library"></aside><main class="ds-graph"><div class="ds-graph-toolbar"><span><i class="fas fa-hand"></i> ${t("DS.GraphHint", "Перетаскивайте поле · колесо — масштаб")}</span><button data-ed="fit"><i class="fas fa-expand"></i>${t("DS.Fit", "Показать всё")}</button></div><div class="ds-graph-viewport" aria-label="${esc(t("DS.Graph", "Граф диалога"))}"><div class="ds-graph-world"><svg class="ds-edges" viewBox="0 0 3000 1800" aria-hidden="true"></svg><div class="ds-nodes"></div></div></div></main><aside class="ds-inspector"></aside></div>`;
  document.body.append(e);
  S.editor = e;
  bindEditor(e);
  renderEditor();
  updateHistoryButtons();
}
function renderLibrary() {
  const scene = editScene(),
    state = getStoryState(S.draft);
  S.editor.querySelector(".ds-current-scene").textContent = scene.title;
  S.editor.querySelector(".ds-library").innerHTML =
    `<section><div class="ds-section-head"><h2>${t("DS.Scenes", "Сцены")}</h2><button data-ed="add-scene" aria-label="${esc(t("DS.AddScene", "Добавить сцену"))}"><i class="fas fa-plus"></i></button></div><div class="ds-scene-list">${S.draft.scenes.map((s) => `<button class="${s.id === scene.id ? "active" : ""}" data-scene-id="${s.id}"><i class="fas fa-clapperboard"></i><span><b>${esc(s.title)}</b><small>${s.nodes.length} ${t("DS.PassagesShort", "реплик")}</small></span></button>`).join("")}</div><div class="ds-library-actions"><button data-ed="scene-settings"><i class="fas fa-sliders"></i>${t("DS.Configure", "Настроить")}</button><button data-ed="copy-scene" aria-label="${esc(t("DS.CopyScene", "Копировать сцену"))}"><i class="fas fa-copy"></i></button><button data-ed="delete-scene" aria-label="${esc(t("DS.DeleteScene", "Удалить сцену"))}"><i class="fas fa-trash"></i></button></div></section><section><div class="ds-section-head"><h2>${t("DS.Characters", "Персонажи")}</h2><button data-ed="add-character" aria-label="${esc(t("DS.AddCharacter", "Добавить персонажа"))}"><i class="fas fa-plus"></i></button></div><div class="ds-character-list">${S.draft.characters.map((c) => `<button class="${S.panel === "character" && c.id === S.character ? "active" : ""}" data-character-id="${c.id}"><span class="ds-character-thumb" style="${c.portrait ? `background-image:url('${esc(cssUrl(c.portrait))}')` : ""};--character-color:${safeColor(c.color)}">${c.portrait ? "" : '<i class="fas fa-user"></i>'}</span><span><b>${esc(c.name)}</b><small>${esc(c.role || t("DS.NoRole", "Без роли"))}</small></span></button>`).join("")}</div></section><section class="ds-story-library"><button class="ds-story-button ${S.panel === "state" ? "active" : ""}" data-ed="story-state"><i class="fas fa-route"></i><span><b>${t("DS.StoryState", "Состояние истории")}</b><small>${S.draft.variables.length} ${t("DS.VariablesShort", "переменных")} · ${state.applied.length} ${t("DS.DecisionsShort", "решений")}</small></span></button></section>`;
}
function nodeOptions(scene, value, empty = true) {
  return `${empty ? `<option value="">${t("DS.Finish", "Закончить разговор")}</option>` : ""}${scene.nodes.map((n, i) => `<option value="${n.id}" ${n.id === value ? "selected" : ""}>${i + 1}. ${esc(findChar(S.draft, n.character).name)} — ${esc(n.line.slice(0, 48))}</option>`).join("")}`;
}
function variableOptions(value, empty = true) {
  return `${empty ? `<option value="">${t("DS.None", "не выбрано")}</option>` : ""}${S.draft.variables.map((variable) => `<option value="${variable.id}" ${variable.id === value ? "selected" : ""}>${esc(variable.name)}</option>`).join("")}`;
}
function cityPointControl(choice) {
  const project = game.modules.get("city-viewer")?.api?.getProject?.(),
    points = (project?.cities || []).flatMap((city) =>
      city.screens.flatMap((screen) =>
        screen.objects
          .filter((object) => object.kind === "poi")
          .map((object) => ({
            id: object.id,
            cityId: city.id,
            screenId: screen.id,
            label: `${city.name} · ${screen.title} · ${object.name}`,
          })),
      ),
    );
  if (!points.length)
    return `<input data-choice-field="revealCityPoint" value="${esc(choice.revealCityPoint)}" placeholder="north-workshops">`;
  const exact = points.find(
      (point) =>
        point.id === choice.revealCityPoint &&
        point.cityId === choice.revealCityId &&
        point.screenId === choice.revealCityScreen,
    ),
    idMatches = points.filter((point) => point.id === choice.revealCityPoint),
    selected = exact ||
      (!choice.revealCityId && !choice.revealCityScreen && idMatches.length === 1
        ? idMatches[0]
        : null),
    selectedValue = selected
      ? `${selected.cityId}|${selected.screenId}|${selected.id}`
      : "";
  return `<select data-choice-city><option value="">${t("DS.None", "не выбрано")}</option>${!selected && choice.revealCityPoint ? `<option value="||${esc(choice.revealCityPoint)}" selected>${esc(choice.revealCityPoint)}</option>` : ""}${points.map((point) => {
    const value = `${point.cityId}|${point.screenId}|${point.id}`;
    return `<option value="${esc(value)}" ${value === selectedValue ? "selected" : ""}>${esc(point.label)}</option>`;
  }).join("")}</select>`;
}
function evidenceControl(choice) {
  const boards = game.modules.get("mind-palace")?.api?.getBoards?.() || [],
    nodes = boards.flatMap((board) =>
      board.nodes.map((node) => ({
        id: node.id,
        boardId: board.id,
        label: `${board.title} · ${node.title}`,
      })),
    );
  if (!nodes.length)
    return `<input data-choice-field="revealMindEvidence" value="${esc(choice.revealMindEvidence)}" placeholder="silver-burn">`;
  const exact = nodes.find(
      (node) =>
        node.id === choice.revealMindEvidence &&
        node.boardId === choice.revealMindBoard,
    ),
    idMatches = nodes.filter((node) => node.id === choice.revealMindEvidence),
    selected = exact ||
      (!choice.revealMindBoard && idMatches.length === 1 ? idMatches[0] : null),
    selectedValue = selected ? `${selected.boardId}|${selected.id}` : "";
  return `<select data-choice-mind><option value="">${t("DS.None", "не выбрано")}</option>${!selected && choice.revealMindEvidence ? `<option value="|${esc(choice.revealMindEvidence)}" selected>${esc(choice.revealMindEvidence)}</option>` : ""}${nodes.map((node) => {
    const value = `${node.boardId}|${node.id}`;
    return `<option value="${esc(value)}" ${value === selectedValue ? "selected" : ""}>${esc(node.label)}</option>`;
  }).join("")}</select>`;
}
function renderInspector() {
  const host = S.editor.querySelector(".ds-inspector"),
    scene = editScene();
  if (S.panel === "state") {
    const state = getStoryState(S.draft);
    host.innerHTML = `<div class="ds-inspector-head"><span class="ds-type-icon"><i class="fas fa-route"></i></span><div><small>${t("DS.CampaignEntity", "КАМПАНИЯ")}</small><h2>${t("DS.StoryState", "Состояние истории")}</h2></div></div><p class="ds-note">${t("DS.StoryStateHelp", "Переменные открывают новые ответы и запоминают последствия решений. Игроки не видят их технических значений.")}</p><div class="ds-variable-list">${S.draft.variables
      .map(
        (variable) =>
          `<section data-variable-id="${variable.id}"><button data-remove-variable="${variable.id}" aria-label="${esc(t("DS.DeleteVariable", "Удалить переменную"))}"><i class="fas fa-xmark"></i></button><label>${t("DS.VariableName", "Название")}<input data-variable-field="name" value="${esc(variable.name)}"></label><div class="ds-two"><label>${t("DS.InitialValue", "Начальное значение")}<input type="number" data-variable-field="initial" value="${variable.initial}"></label><label>${t("DS.CurrentValue", "Сейчас")}<output>${numberValue(state.variables[variable.id], variable.initial)}</output></label></div></section>`,
      )
      .join("")}</div><div class="ds-inspector-actions"><button data-ed="add-variable"><i class="fas fa-plus"></i>${t("DS.AddVariable", "Добавить переменную")}</button><button data-ed="reset-story"><i class="fas fa-arrow-rotate-left"></i>${t("DS.ResetStory", "Сбросить последствия")}</button></div>`;
    return;
  }
  if (S.panel === "scene") {
    host.innerHTML = `<div class="ds-inspector-head"><span class="ds-type-icon"><i class="fas fa-clapperboard"></i></span><div><small>${t("DS.SceneEntity", "СЦЕНА")}</small><h2>${esc(scene.title)}</h2></div></div><label>${t("DS.SceneTitle", "Название")}<input data-scene-field="title" value="${esc(scene.title)}"></label><label>${t("DS.Background", "Фон")}<div class="ds-file-field"><input data-scene-field="background" value="${esc(scene.background)}"><button data-browse="background" aria-label="${esc(t("DS.Browse", "Выбрать файл"))}"><i class="fas fa-folder-open"></i></button></div></label><label>${t("DS.StartNode", "Первая реплика")}<select data-scene-field="start">${nodeOptions(scene, scene.start, false)}</select></label><label>${t("DS.GreetingTable", "Таблица стартовых реплик — UUID")}<input data-scene-field="greetingTableUuid" value="${esc(scene.greetingTableUuid || "")}" placeholder="RollTable.…"></label><p class="ds-note">${t("DS.GreetingHelp", "При открытии бросается таблица; результат заменяет первую реплику. Дайте игрокам доступ к таблице.")}</p><button data-ed="test-greeting">${t("DS.TestGreeting", "Проверить таблицу")}</button><p class="ds-note">${t("DS.SceneHelp", "У сцены собственный фон и граф реплик. Персонажи общие для всех сцен.")}</p>`;
    return;
  }
  if (S.panel === "character") {
    const c = findChar(S.draft, S.character);
    host.innerHTML = `<div class="ds-inspector-head"><span class="ds-character-thumb large" style="${c.portrait ? `background-image:url('${esc(cssUrl(c.portrait))}')` : ""};--character-color:${safeColor(c.color)}">${c.portrait ? "" : '<i class="fas fa-user"></i>'}</span><div><small>${t("DS.CharacterEntity", "ПЕРСОНАЖ")}</small><h2>${esc(c.name)}</h2></div></div><label>${t("DS.CharacterName", "Имя")}<input data-character-field="name" value="${esc(c.name)}"></label><label>${t("DS.Role", "Роль")}<input data-character-field="role" value="${esc(c.role)}"></label><label>${t("DS.Portrait", "Портрет")}<div class="ds-file-field"><input data-character-field="portrait" value="${esc(c.portrait)}"><button data-browse="portrait" aria-label="${esc(t("DS.Browse", "Выбрать файл"))}"><i class="fas fa-folder-open"></i></button></div></label><label>${t("DS.CharacterColor", "Цвет")}<div class="ds-color-field"><input type="color" data-character-field="color" value="${safeColor(c.color)}"><input data-character-field="color" value="${safeColor(c.color)}"></div></label><label>${t("DS.ActorUUID", "Актёр Foundry — UUID")}<input data-character-field="actorUuid" value="${esc(c.actorUuid || "")}" placeholder="Actor.…"></label><label>${t("DS.InitialRelationship", "Начальное отношение")}<input type="number" min="-10" max="10" data-character-field="relationship" value="${numberValue(c.relationship)}"></label><div class="ds-inspector-actions"><button data-ed="copy-character"><i class="fas fa-copy"></i>${t("DS.Copy", "Копировать")}</button><button data-ed="delete-character"><i class="fas fa-trash"></i>${t("DS.Delete", "Удалить")}</button></div>`;
    return;
  }
  const n = editNode(),
    c = findChar(S.draft, n.character);
  host.innerHTML = `<div class="ds-inspector-head"><span class="ds-type-icon" style="--character-color:${safeColor(c.color)}"><i class="fas fa-message"></i></span><div><small>${t("DS.Passage", "РЕПЛИКА")}</small><h2>${esc(c.name)}</h2></div></div><label>${t("DS.Speaker", "Говорящий")}<select data-node-field="character">${S.draft.characters.map((x) => `<option value="${x.id}" ${x.id === n.character ? "selected" : ""}>${esc(x.name)} · ${esc(x.role)}</option>`).join("")}</select></label><label>${t("DS.Line", "Текст")}<textarea data-node-field="line" rows="5">${esc(n.line)}</textarea></label><div class="ds-two"><label>${t("DS.InnerVoice", "Внутренний голос")}<input data-node-field="voice" value="${esc(n.voice)}"></label><label>${t("DS.InnerText", "Комментарий")}<textarea data-node-field="inner" rows="3">${esc(n.inner)}</textarea></label></div><div class="ds-section-head"><h2>${t("DS.Responses", "Ответы игрока")}</h2><button data-ed="add-choice" aria-label="${esc(t("DS.AddChoice", "Добавить ответ"))}"><i class="fas fa-plus"></i></button></div><div class="ds-choice-editor">${n.choices
    .map((q, i) => {
      const target = scene.nodes.find((x) => x.id === q.target);
      return `<section data-choice-index="${i}"><button data-remove-choice="${i}" aria-label="${esc(t("DS.DeleteResponse", "Удалить ответ"))}"><i class="fas fa-xmark"></i></button><label>${t("DS.Response", "Ответ")}<textarea data-choice-field="text" rows="2">${esc(q.text)}</textarea></label><div class="ds-choice-target ${target ? "linked" : ""}"><i class="fas ${target ? "fa-link" : "fa-circle-nodes"}"></i><span>${target ? `${esc(findChar(S.draft, target.character).name)} — ${esc(target.line.slice(0, 42))}` : t("DS.DropConnection", "Потяните линию на графе к нужной реплике")}</span>${target ? `<button data-clear-choice="${i}" title="${esc(t("DS.ClearConnection", "Удалить связь"))}" aria-label="${esc(t("DS.ClearConnection", "Удалить связь"))}"><i class="fas fa-link-slash"></i></button>` : ""}</div><details class="ds-choice-rules" ${q.conditionVariable || hasChoiceEffects(q) ? "open" : ""}><summary><i class="fas fa-bolt"></i>${t("DS.ConditionsEffects", "Условия и последствия")}</summary><div class="ds-rule-block"><h3>${t("DS.ShowWhen", "Показывать ответ, когда")}</h3><label>${t("DS.Variable", "Переменная")}<select data-choice-field="conditionVariable">${variableOptions(q.conditionVariable)}</select></label><div class="ds-rule-row"><label>${t("DS.Comparison", "Сравнение")}<select data-choice-field="conditionOperator"><option value="gte" ${q.conditionOperator === "gte" ? "selected" : ""}>≥</option><option value="gt" ${q.conditionOperator === "gt" ? "selected" : ""}>&gt;</option><option value="eq" ${q.conditionOperator === "eq" ? "selected" : ""}>=</option><option value="neq" ${q.conditionOperator === "neq" ? "selected" : ""}>≠</option><option value="lt" ${q.conditionOperator === "lt" ? "selected" : ""}>&lt;</option><option value="lte" ${q.conditionOperator === "lte" ? "selected" : ""}>≤</option></select></label><label>${t("DS.Value", "Значение")}<input type="number" data-choice-field="conditionValue" value="${q.conditionValue}"></label></div></div><div class="ds-rule-block"><h3>${t("DS.ChangeStory", "Изменить историю")}</h3><label>${t("DS.Variable", "Переменная")}<select data-choice-field="effectVariable">${variableOptions(q.effectVariable)}</select></label><div class="ds-rule-row"><label>${t("DS.Operation", "Операция")}<select data-choice-field="effectOperation"><option value="set" ${q.effectOperation === "set" ? "selected" : ""}>${t("DS.Set", "Задать")}</option><option value="add" ${q.effectOperation === "add" ? "selected" : ""}>${t("DS.Add", "Прибавить")}</option></select></label><label>${t("DS.Value", "Значение")}<input type="number" data-choice-field="effectValue" value="${q.effectValue}"></label></div></div><div class="ds-rule-block"><h3>${t("DS.ChangeRelationship", "Изменить отношение")}</h3><label>${t("DS.Character", "Персонаж")}<select data-choice-field="relationshipCharacter"><option value="">${t("DS.None", "не выбрано")}</option>${S.draft.characters.map((character) => `<option value="${character.id}" ${character.id === q.relationshipCharacter ? "selected" : ""}>${esc(character.name)}</option>`).join("")}</select></label><label>${t("DS.Change", "Изменение")}<input type="number" min="-10" max="10" data-choice-field="relationshipDelta" value="${q.relationshipDelta}"></label></div><div class="ds-rule-block"><h3>${t("DS.Unlocks", "Открыть после выбора")}</h3><label>${t("DS.CityPoint", "Точка города")}${cityPointControl(q)}</label><label>${t("DS.Evidence", "Улика")}${evidenceControl(q)}</label><label>${t("DS.QuestUUID", "Выдать группе квест — UUID страницы")}<input data-choice-field="questUuid" value="${esc(q.questUuid || "")}" placeholder="JournalEntry.….JournalEntryPage.…"></label><p class="ds-note">${t("DS.QuestHelp", "Существующий квест Simple Quest станет доступен игрокам после этого ответа.")}</p></div><label class="ds-check"><input type="checkbox" data-choice-field="effectOnce" ${q.effectOnce ? "checked" : ""}><span>${t("DS.ApplyOnce", "Применить последствия один раз за кампанию")}</span></label></details></section>`;
    })
    .join(
      "",
    )}</div><div class="ds-inspector-actions"><button data-ed="copy-node"><i class="fas fa-copy"></i>${t("DS.Copy", "Копировать")}</button><button data-ed="delete-node"><i class="fas fa-trash"></i>${t("DS.Delete", "Удалить")}</button></div>`;
}
function renderEdges() {
  const scene = editScene(),
    svg = S.editor?.querySelector(".ds-edges");
  if (!svg) return;
  svg.innerHTML = scene.nodes
    .flatMap((n) =>
      n.choices.map((q, i) => {
        const b = scene.nodes.find((x) => x.id === q.target);
        if (!b) return "";
        const x1 = n.x + 280,
          y1 = n.y + 74 + i * 28,
          x2 = b.x,
          y2 = b.y + 70,
          bend = Math.max(90, Math.abs(x2 - x1) * 0.45);
        return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" style="--edge-color:${safeColor(findChar(S.draft, n.character).color)}"></path>`;
      }),
    )
    .join("");
}

function scheduleEdges() {
  if (S.edgeFrame) return;
  S.edgeFrame = requestAnimationFrame(() => {
    S.edgeFrame = 0;
    if (S.editor?.isConnected) renderEdges();
  });
}

function refreshSelection({ library = false } = {}) {
  if (!S.editor) return;
  S.editor
    .querySelectorAll("[data-node-id]")
    .forEach((element) =>
      element.classList.toggle(
        "active",
        S.panel === "node" && element.dataset.nodeId === S.selected,
      ),
    );
  S.canvas?.select?.(S.panel === "node" ? S.selected : []);
  if (library) renderLibrary();
  renderInspector();
  updateHistoryButtons();
}

function refreshNodeCard(nodeId) {
  const element = S.editor?.querySelector(`[data-node-id="${nodeId}"]`),
    node = editScene().nodes.find((candidate) => candidate.id === nodeId);
  if (!element || !node) return;
  const character = findChar(S.draft, node.character);
  element.style.setProperty("--character-color", safeColor(character.color));
  const name = element.querySelector("header b"),
    role = element.querySelector("header small"),
    line = element.querySelector(":scope > p");
  if (name) name.textContent = character.name;
  if (role) role.textContent = character.role || t("DS.NoRole", "Без роли");
  if (line) line.textContent = node.line || t("DS.EmptyLine", "Пустая реплика");
}

function bindGraphConnections(host, scene) {
  host.querySelectorAll("[data-connect-choice]").forEach((port) => {
    port.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const card = port.closest("[data-node-id]"),
        source = findNode(scene, card.dataset.nodeId),
        index = Number(port.dataset.connectChoice),
        svg = S.editor.querySelector(".ds-edges"),
        path = document.createElementNS("http://www.w3.org/2000/svg", "path"),
        start = { x: source.x + 280, y: source.y + 74 + index * 28 };
      path.classList.add("ds-edge-draft");
      svg.append(path);
      port.classList.add("is-wiring");
      const draw = (x, y) => {
        const bend = Math.max(90, Math.abs(x - start.x) * 0.45);
        path.setAttribute(
          "d",
          `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${x - bend} ${y}, ${x} ${y}`,
        );
      };
      draw(start.x + 120, start.y);
      let moveFrame = 0,
        latestMove = null;
      const move = (m) => {
        latestMove = m;
        if (moveFrame) return;
        moveFrame = requestAnimationFrame(() => {
          moveFrame = 0;
          if (!S.canvas || !latestMove) return;
          const p = S.canvas.screenToWorld(
            latestMove.clientX,
            latestMove.clientY,
          );
          draw(p.x, p.y);
          S.editor
            .querySelectorAll(".ds-drop-target")
            .forEach((x) => x.classList.remove("ds-drop-target"));
          document
            .elementFromPoint(latestMove.clientX, latestMove.clientY)
            ?.closest("[data-node-id]")
            ?.classList.add("ds-drop-target");
        });
      };
      const cleanup = () => {
        cancelAnimationFrame(moveFrame);
        moveFrame = 0;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        port.classList.remove("is-wiring");
        S.editor
          ?.querySelectorAll(".ds-drop-target")
          .forEach((x) => x.classList.remove("ds-drop-target"));
        path.remove();
        if (S.wireCleanup === cleanup) S.wireCleanup = null;
      };
      const end = (u) => {
        const target = document
          .elementFromPoint(u.clientX, u.clientY)
          ?.closest("[data-node-id]");
        cleanup();
        if (!target || !S.editor?.contains(target)) return;
        remember();
        source.choices[index].target = target.dataset.nodeId;
        port.classList.add("linked");
        const icon = port.querySelector("i");
        if (icon) icon.className = "fas fa-link";
        renderEdges();
        renderInspector();
        autosave();
      };
      S.wireCleanup?.();
      S.wireCleanup = cleanup;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    };
  });
}
function renderGraph(camera = null) {
  const scene = editScene();
  if (S.canvas) {
    S.camera = S.canvas.getState();
    S.canvas.destroy();
  }
  const host = S.editor.querySelector(".ds-nodes");
  host.innerHTML = scene.nodes
    .map((n, i) => {
      const c = findChar(S.draft, n.character);
      return `<article class="ds-graph-node uc-no-pan ${n.id === S.selected && S.panel === "node" ? "active" : ""}" data-node-id="${n.id}" data-uc-id="${n.id}" tabindex="0" style="transform:translate3d(${n.x}px,${n.y}px,0);--character-color:${safeColor(c.color)}"><header><span>${i + 1}</span><div><b>${esc(c.name)}</b><small>${esc(c.role || t("DS.NoRole", "Без роли"))}</small></div>${scene.start === n.id ? '<i class="fas fa-play"></i>' : ""}</header><p>${esc(n.line || t("DS.EmptyLine", "Пустая реплика"))}</p><footer>${n.choices.length ? n.choices.map((q, choiceIndex) => `<span class="ds-graph-choice"><em>${esc(q.text || t("DS.EmptyResponse", "Пустой ответ"))}</em><small class="ds-choice-flags">${q.conditionVariable ? `<i class="fas fa-filter" title="${esc(t("DS.HasCondition", "Есть условие"))}"></i>` : ""}${hasChoiceEffects(q) ? `<i class="fas fa-bolt" title="${esc(t("DS.HasConsequences", "Есть последствия"))}"></i>` : ""}</small><button data-connect-choice="${choiceIndex}" class="ds-node-port ${q.target ? "linked" : ""}" aria-label="${esc(t("DS.ConnectResponse", "Соединить ответ с репликой"))}" title="${esc(t("DS.ConnectHint", "Потянуть связь"))}"><i class="fas ${q.target ? "fa-link" : "fa-circle-nodes"}"></i></button></span>`).join("") : `<span>${t("DS.ConversationEnd", "Конец разговора")} <i class="fas fa-door-open"></i></span>`}</footer></article>`;
    })
    .join("");
  renderEdges();
  const api = game.modules.get("unicanvas")?.api || globalThis.UniCanvas;
  if (!api?.create)
    return S.editor
      .querySelector(".ds-graph-viewport")
      .classList.add("ds-no-canvas");
  S.canvas = api.create({
    viewport: S.editor.querySelector(".ds-graph-viewport"),
    world: S.editor.querySelector(".ds-graph-world"),
    width: 3000,
    height: 1800,
    minScale: 0.22,
    maxScale: 2.4,
    initialState: camera || S.camera,
  });
  host.querySelectorAll("[data-node-id]").forEach((e) => {
    const n = findNode(scene, e.dataset.nodeId);
    let beforeDrag = null,
      startPosition = null;
    S.canvas.makeDraggable(e, {
      get: () => {
        beforeDrag = clone(S.draft);
        startPosition = { x: n.x, y: n.y };
        return startPosition;
      },
      set: (p) => {
        n.x = p.x;
        n.y = p.y;
        e.style.transform = `translate3d(${n.x}px,${n.y}px,0)`;
        scheduleEdges();
      },
      onEnd: () => {
        if (
          startPosition &&
          (startPosition.x !== n.x || startPosition.y !== n.y)
        ) {
          remember(beforeDrag);
          autosave();
        }
      },
    });
  });
  bindGraphConnections(host, scene);
  if (S.selected) S.canvas.select?.(S.selected);
}
function renderEditor() {
  if (!S.editor) return;
  const camera = S.canvas?.getState() || S.camera;
  renderLibrary();
  renderInspector();
  renderGraph(camera);
  updateHistoryButtons();
}
async function browse(kind) {
  const P =
    foundry.applications?.apps?.FilePicker?.implementation ||
    foundry.applications?.apps?.FilePicker ||
    globalThis.FilePicker;
  if (!P)
    return ui.notifications.error(
      t("DS.FilePickerUnavailable", "Выбор файлов недоступен."),
    );
  const current =
      kind === "background"
        ? editScene().background
        : findChar(S.draft, S.character).portrait,
    app = new P({
      type: "image",
      current,
      callback: (path) => {
        if (kind === "background") editScene().background = path;
        else findChar(S.draft, S.character).portrait = path;
        renderEditor();
        autosave();
      },
    });
  try {
    await app.render({ force: true });
  } catch {
    if (typeof app.browse === "function") await app.browse();
    else await app.render(true);
  }
}
function builtInPresets() {
  return [
    { id: "merchant", name: t("DS.PresetMerchant", "Торговец"), greeting: ["Взгляните на товар. За осмотр денег не беру.", "Покупаете, продаёте или просто прячетесь от дождя?", "Свежая поставка с юга. Пока есть из чего выбрать."], line: "Что вас интересует?", responses: ["Что у вас есть?", "Какие новости?", "До встречи."], replies: ["Лекарства, припасы, инструменты. Скажите, что ищете.", "Последний караван пришёл без охраны. Возчик не говорит почему."] },
    { id: "smith", name: t("DS.PresetSmith", "Кузнец"), greeting: ["Только не трогайте клинок — ещё горячий.", "Заказ или ремонт? Кладите на верстак.", "Если срочно, придётся доплатить за уголь."], line: "Покажите, с чем пришли.", responses: ["Нужно починить оружие.", "Ищу хорошую сталь.", "Не буду отвлекать."], replies: ["Оставьте до утра. Рукоять тоже заменю — эта не выдержит.", "Хорошую сталь привозят из северных шахт. Вот образец."] },
    { id: "quest-giver", name: t("DS.PresetQuestGiver", "Заказчик"), greeting: ["Вы пришли по объявлению?", "Мне нужен человек, который умеет хранить слово.", "Есть работа. Опасная, но оплата честная."], line: "Мой курьер пропал у старой мельницы.", responses: ["Я возьмусь.", "Расскажите подробнее.", "Сейчас не могу."], replies: ["Спасибо. Последний раз его видели на северной дороге.", "Он вёз письмо с синей печатью. Найдите письмо и самого курьера."], quest: true },
  ];
}
function dialoguePresets() {
  return game.settings.get(MOD, "presets") || [];
}
function openDialoguePresets() {
  S.editor.querySelector(".ds-preset-dialog")?.remove();
  const panel = document.createElement("section");
  panel.className = "ds-preset-dialog";
  panel.innerHTML = `<div role="dialog" aria-label="${esc(t("DS.Presets", "Пресеты"))}"><header><h2>${t("DS.Presets", "Пресеты")}</h2><button data-preset-close aria-label="${esc(t("DS.Close", "Закрыть"))}">×</button></header><button data-preset-save>${t("DS.SavePreset", "Сохранить текущую сцену")}</button><div class="ds-preset-list">${[...builtInPresets(), ...dialoguePresets()].map(preset => `<div><button data-preset-use="${esc(preset.id)}">${esc(preset.name)}</button>${preset.scene ? `<button data-preset-delete="${esc(preset.id)}" aria-label="${esc(t("DS.Delete", "Удалить"))}">×</button>` : ""}</div>`).join("")}</div></div>`;
  S.editor.append(panel);
  panel.onclick = async event => {
    event.stopPropagation();
    if (event.target.closest("[data-preset-close]")) return panel.remove();
    try {
      if (event.target.closest("[data-preset-save]")) {
        const scene = clone(editScene()), items = dialoguePresets();
        if (items.length >= 100) throw new Error(t("DS.PresetLimit", "Можно сохранить не более 100 пресетов."));
        const used = new Set(scene.nodes.map(node => node.character));
        items.push({ id: uid(), name: scene.title, scene, characters: clone(S.draft.characters.filter(c => used.has(c.id))), variables: clone(S.draft.variables) });
        await game.settings.set(MOD, "presets", items);
        return openDialoguePresets();
      }
      const removeId = event.target.closest("[data-preset-delete]")?.dataset.presetDelete;
      if (removeId) {
        await game.settings.set(MOD, "presets", dialoguePresets().filter(p => p.id !== removeId));
        return openDialoguePresets();
      }
      const presetId = event.target.closest("[data-preset-use]")?.dataset.presetUse;
      if (!presetId) return;
      event.target.disabled = true;
      await applyDialoguePreset(presetId);
      panel.remove();
    } catch (error) { event.target.disabled = false; ui.notifications.error(error.message); }
  };
}
async function applyDialoguePreset(presetId) {
  if (!game.user.isGM) return false;
  const preset = [...builtInPresets(), ...dialoguePresets()].find(p => p.id === presetId);
  if (!preset) return false;
  if (!S.editor) openEditor();
  if (S.draft.scenes.length >= 100 || S.draft.characters.length >= 195) throw new Error(t("DS.PresetLimit", "Достигнут лимит проекта."));
  const draft = S.draft;
  let scene, chars, variables = [];
  if (preset.scene) {
    scene = clone(preset.scene); chars = clone(preset.characters); variables = clone(preset.variables || []);
  } else {
    const actor = { id: uid(), name: preset.name, role: "", portrait: "", color: "#b96e46" };
    chars = [actor];
    const table = await RollTable.create({ name: preset.name + " — " + t("DS.Greetings", "Приветствия"), formula: "1d3", replacement: true,
      ownership: { default: 2 }, results: preset.greeting.map((description, i) => ({ type: "text", description, range: [i + 1, i + 1], weight: 1 })) });
    scene = { title: preset.name, start: "start", background: "", greetingTableUuid: table.uuid, nodes: [
      { id: "start", character: actor.id, line: preset.line, choices: preset.responses.map((text, i) => ({ id: uid(), text, target: i < 2 ? "reply" + i : "", questUuid: "" })) },
      ...preset.replies.map((line, i) => ({ id: "reply" + i, character: actor.id, line, choices: [{ id: uid(), text: "Ещё один вопрос.", target: "start" }, { id: uid(), text: "До встречи.", target: "" }] })),
    ] };
  }
  if (S.draft !== draft) return false;
  const characterMap = new Map(chars.map(c => [c.id, uid()])), nodeMap = new Map(scene.nodes.map(n => [n.id, uid()]));
  // Reuse campaign variables when they still exist; otherwise import their definitions.
  remember();
  for (const variable of variables) if (!draft.variables.some(v => v.id === variable.id) && draft.variables.length < 100) draft.variables.push(variable);
  for (const c of chars) { c.id = characterMap.get(c.id); draft.characters.push(c); }
  scene.id = uid();
  scene.start = nodeMap.get(scene.start);
  scene.nodes.forEach((node, index) => {
    node.id = nodeMap.get(node.id); node.character = characterMap.get(node.character);
    node.x = 180 + index * 470; node.y = 180;
    node.choices.forEach(choice => {
      choice.id = uid(); choice.target = nodeMap.get(choice.target) || "";
      if (choice.relationshipCharacter) choice.relationshipCharacter = characterMap.get(choice.relationshipCharacter) || "";
    });
  });
  draft.scenes.push(scene);
  S.draft = normalize(draft); S.scene = scene.id; S.draft.activeScene = scene.id;
  S.selected = scene.start; S.character = chars[0].id; S.panel = "scene"; S.camera = null;
  renderEditor(); await save();
  return scene.id;
}
function addNode(source = null) {
  remember();
  const scene = editScene(),
    n = source
      ? { ...clone(source), id: uid(), x: source.x + 80, y: source.y + 80 }
      : normNode(
          {
            character: S.character,
            line: t("DS.NewPassage", "Новая реплика"),
            x: 260 + (scene.nodes.length % 4) * 390,
            y: 260 + Math.floor(scene.nodes.length / 4) * 300,
          },
          scene.nodes.length,
          S.draft.characters,
        );
  n.choices = n.choices.map((q) => ({ ...q, id: uid() }));
  scene.nodes.push(n);
  S.selected = n.id;
  S.panel = "node";
  renderEditor();
  autosave();
}
function deleteNode() {
  const scene = editScene();
  if (scene.nodes.length <= 1)
    return ui.notifications.warn(
      t("DS.LastPassage", "В сцене должна остаться хотя бы одна реплика."),
    );
  if (!window.confirm(t("DS.ConfirmDeletePassage", "Удалить эту реплику?")))
    return;
  remember();
  const id = S.selected;
  scene.nodes = scene.nodes.filter((n) => n.id !== id);
  scene.nodes.forEach((n) =>
    n.choices.forEach((q) => {
      if (q.target === id) q.target = "";
    }),
  );
  if (scene.start === id) scene.start = scene.nodes[0].id;
  S.selected = scene.start;
  renderEditor();
  autosave();
}

function exportProject() {
  if (!S.draft) return;
  const payload = JSON.stringify(
      {
        module: MOD,
        schema: 4,
        exportedAt: new Date().toISOString(),
        project: S.draft,
        storyState: getStoryState(S.draft),
      },
      null,
      2,
    ),
    blob = new Blob([payload], { type: "application/json" }),
    url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dialogue-stage-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function importProject() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024)
      return ui.notifications.error(
        t("DS.ImportTooLarge", "Файл импорта превышает 5 МБ."),
      );
    try {
      const raw = JSON.parse(await file.text()),
        project = raw?.module === MOD ? raw.project : raw,
        importedState = raw?.module === MOD ? raw.storyState : null;
      if (!isImportableProject(project))
        throw new Error("Invalid Dialogue Stage project");
      remember();
      S.draft = normalize(project);
      S.scene = S.draft.activeScene;
      S.selected = editScene().start;
      S.character = S.draft.characters[0].id;
      S.panel = "scene";
      S.camera = null;
      renderEditor();
      await save(true);
      await game.settings.set(
        MOD,
        "storyState",
        normalizeStoryState(importedState, S.draft),
      );
      ui.notifications.info(t("DS.Imported", "Диалог импортирован."));
    } catch (error) {
      console.error(`${MOD} | import failed`, error);
      ui.notifications.error(
        t("DS.ImportFailed", "Не удалось импортировать этот JSON-файл."),
      );
    }
  };
  input.click();
}

function bindEditor(e) {
  e.onclick = async (x) => {
    if (x.target.closest("[data-node-id]")?.dataset.ucDragged) return;
    const cmd = x.target.closest("[data-ed]")?.dataset.ed,
      sid = x.target.closest("[data-scene-id]")?.dataset.sceneId,
      cid = x.target.closest("[data-character-id]")?.dataset.characterId,
      nid = x.target.closest("[data-node-id]")?.dataset.nodeId,
      remove = x.target.closest("[data-remove-choice]")?.dataset.removeChoice,
      removeVariable = x.target.closest("[data-remove-variable]")?.dataset
        .removeVariable,
      clear = x.target.closest("[data-clear-choice]")?.dataset.clearChoice,
      pick = x.target.closest("[data-browse]")?.dataset.browse;
    if (clear !== undefined) {
      remember();
      editNode().choices[Number(clear)].target = "";
      const port = S.editor.querySelector(
        `[data-node-id="${S.selected}"] [data-connect-choice="${Number(clear)}"]`,
      );
      port?.classList.remove("linked");
      const icon = port?.querySelector("i");
      if (icon) icon.className = "fas fa-circle-nodes";
      renderEdges();
      renderInspector();
      return autosave();
    }
    if (sid) {
      S.camera = null;
      S.scene = sid;
      S.draft.activeScene = sid;
      S.selected = editScene().start;
      S.panel = "node";
      renderEditor();
      return autosave();
    }
    if (cid) {
      S.character = cid;
      S.panel = "character";
      return refreshSelection({ library: true });
    }
    if (removeVariable) {
      if (
        !window.confirm(
          t(
            "DS.ConfirmDeleteVariable",
            "Удалить переменную и все условия, которые на неё ссылаются?",
          ),
        )
      )
        return;
      remember();
      S.draft.variables = S.draft.variables.filter(
        (variable) => variable.id !== removeVariable,
      );
      S.draft.scenes.forEach((candidateScene) =>
        candidateScene.nodes.forEach((node) =>
          node.choices.forEach((choice) => {
            if (choice.conditionVariable === removeVariable)
              choice.conditionVariable = "";
            if (choice.effectVariable === removeVariable)
              choice.effectVariable = "";
          }),
        ),
      );
      renderEditor();
      return autosave();
    }
    if (nid) {
      S.selected = nid;
      S.panel = "node";
      S.character = editNode().character;
      return refreshSelection({ library: true });
    }
    if (pick) return browse(pick);
    if (cmd === "copy-uuid") {
      await save();
      const path = S.panel === "character" ? ["characters", S.character] : S.panel === "scene" ? ["scenes", S.scene] : ["scenes", S.scene, "nodes", S.selected];
      return globalThis.UniCanvasDocuments?.copyUuid(MOD, path);
    }
    if (cmd === "test-greeting") {
      try { ui.notifications.info(await rollGreeting(editScene().greetingTableUuid)); }
      catch (error) { ui.notifications.warn(error.message); }
      return;
    }
    if (cmd === "presets") return openDialoguePresets();
    if (cmd === "close") return closeEditor();
    if (cmd === "undo") return restoreHistory("undo");
    if (cmd === "redo") return restoreHistory("redo");
    if (cmd === "export") return exportProject();
    if (cmd === "import") return importProject();
    if (cmd === "save") return save(true);
    if (cmd === "fit") return S.canvas?.fit();
    if (cmd === "preview") {
      await save();
      const scene = S.scene;
      await closeEditor({ saveDraft: false });
      return openViewer(scene);
    }
    if (cmd === "show") {
      await save();
      const scene = S.scene;
      await closeEditor({ saveDraft: false });
      return showAll(scene);
    }
    if (cmd === "scene-settings") {
      S.panel = "scene";
      return refreshSelection({ library: true });
    }
    if (cmd === "story-state") {
      S.panel = "state";
      return refreshSelection({ library: true });
    }
    if (cmd === "add-variable") {
      if (S.draft.variables.length >= 100)
        return ui.notifications.warn(
          t("DS.VariableLimit", "В проекте может быть не больше 100 переменных."),
        );
      remember();
      const variable = {
        id: uid(),
        name: t("DS.NewVariable", "Новая переменная"),
        initial: 0,
      };
      S.draft.variables.push(variable);
      S.variable = variable.id;
      S.panel = "state";
      renderEditor();
      return autosave();
    }
    if (cmd === "reset-story") {
      if (
        !window.confirm(
          t(
            "DS.ConfirmResetStory",
            "Сбросить все решения, отношения и значения переменных?",
          ),
        )
      )
        return;
      const resetProject = clone(S.draft),
        state = await enqueueStoryWrite(async () => {
          const next = normalizeStoryState({}, resetProject);
          await game.settings.set(MOD, "storyState", next);
          return next;
        });
      S.runtimeState = state;
      game.socket.emit(`module.${MOD}`, {
        type: "story-state",
        userId: game.user.id,
      });
      renderEditor();
      Hooks.callAll("dialogueStage.storyReset", clone(state));
      return ui.notifications.info(
        t("DS.StoryReset", "Последствия диалогов сброшены."),
      );
    }
    if (cmd === "add-node") return addNode();
    if (cmd === "copy-node") return addNode(editNode());
    if (cmd === "delete-node") return deleteNode();
    if (cmd === "add-choice") {
      remember();
      editNode().choices.push({
        id: uid(),
        text: t("DS.NewResponse", "Новый ответ"),
        target: "",
        conditionVariable: "",
        conditionOperator: "gte",
        conditionValue: 1,
        effectVariable: "",
        effectOperation: "set",
        effectValue: 1,
        relationshipCharacter: "",
        relationshipDelta: 0,
        revealCityPoint: "",
        revealCityId: "",
        revealCityScreen: "",
        revealMindEvidence: "",
        revealMindBoard: "",
        effectOnce: true,
      });
      renderEditor();
      return autosave();
    }
    if (remove !== undefined) {
      remember();
      editNode().choices.splice(Number(remove), 1);
      renderEditor();
      return autosave();
    }
    if (cmd === "add-scene" || cmd === "copy-scene") {
      remember();
      const source = editScene(),
        scene =
          cmd === "copy-scene"
            ? clone(source)
            : {
                title: t("DS.NewScene", "Новая сцена"),
                background: "",
                nodes: [],
              };
      scene.id = uid();
      scene.title =
        cmd === "copy-scene"
          ? `${scene.title} — ${t("DS.CopySuffix", "копия")}`
          : scene.title;
      const map = new Map();
      scene.nodes = (scene.nodes || []).map((n, i) => {
        const old = n.id,
          c = normNode(n, i, S.draft.characters);
        c.id = uid();
        c.choices.forEach((q) => (q.id = uid()));
        map.set(old, c.id);
        return c;
      });
      if (!scene.nodes.length)
        scene.nodes.push(
          normNode(
            { line: t("DS.FirstPassage", "Первая реплика") },
            0,
            S.draft.characters,
          ),
        );
      scene.nodes.forEach((n) =>
        n.choices.forEach((q) => (q.target = map.get(q.target) || "")),
      );
      scene.start = map.get(source.start) || scene.nodes[0].id;
      S.draft.scenes.push(scene);
      S.scene = scene.id;
      S.draft.activeScene = scene.id;
      S.selected = scene.start;
      S.panel = "scene";
      S.camera = null;
      renderEditor();
      return autosave();
    }
    if (cmd === "delete-scene") {
      if (S.draft.scenes.length <= 1)
        return ui.notifications.warn(
          t("DS.LastScene", "Должна остаться хотя бы одна сцена."),
        );
      if (
        !window.confirm(
          t("DS.ConfirmDeleteScene", "Удалить выбранную сцену целиком?"),
        )
      )
        return;
      remember();
      S.draft.scenes = S.draft.scenes.filter((s) => s.id !== S.scene);
      S.scene = S.draft.scenes[0].id;
      S.draft.activeScene = S.scene;
      S.selected = editScene().start;
      S.panel = "scene";
      S.camera = null;
      renderEditor();
      return autosave();
    }
    if (cmd === "add-character" || cmd === "copy-character") {
      remember();
      const source = findChar(S.draft, S.character),
        c =
          cmd === "copy-character"
            ? {
                ...clone(source),
                id: uid(),
                name: `${source.name} — ${t("DS.CopySuffix", "копия")}`,
              }
            : {
                id: uid(),
                name: t("DS.NewCharacter", "Новый персонаж"),
                role: "",
                portrait: "",
                color: "#b96e46",
                relationship: 0,
              };
      S.draft.characters.push(c);
      S.character = c.id;
      S.panel = "character";
      renderEditor();
      return autosave();
    }
    if (cmd === "delete-character") {
      if (S.draft.characters.length <= 1)
        return ui.notifications.warn(
          t("DS.LastCharacter", "Должен остаться хотя бы один персонаж."),
        );
      if (
        !window.confirm(
          t(
            "DS.ConfirmDeleteCharacter",
            "Удалить персонажа и переназначить его реплики?",
          ),
        )
      )
        return;
      remember();
      const old = S.character,
        fallback = S.draft.characters.find((c) => c.id !== old);
      S.draft.characters = S.draft.characters.filter((c) => c.id !== old);
      S.draft.scenes.forEach((s) =>
        s.nodes.forEach((n) => {
          if (n.character === old) n.character = fallback.id;
          n.choices.forEach((choice) => {
            if (choice.relationshipCharacter === old)
              choice.relationshipCharacter = "";
          });
        }),
      );
      S.character = fallback.id;
      renderEditor();
      return autosave();
    }
  };
  e.onfocusin = (x) => {
    if (
      x.target.matches?.(
        "[data-scene-field],[data-node-field],[data-character-field],[data-choice-field],[data-choice-city],[data-choice-mind],[data-variable-field]",
      )
    ) {
      S.inputSnapshot = clone(S.draft);
      S.inputSnapshotArmed = true;
    }
  };
  e.oninput = (x) => {
    const sf = x.target.dataset.sceneField,
      nf = x.target.dataset.nodeField,
      cf = x.target.dataset.characterField,
      qf = x.target.dataset.choiceField,
      cityRef = x.target.hasAttribute("data-choice-city"),
      mindRef = x.target.hasAttribute("data-choice-mind"),
      vf = x.target.dataset.variableField;
    if (S.inputSnapshotArmed) {
      remember(S.inputSnapshot);
      S.inputSnapshotArmed = false;
    }
    if (sf) editScene()[sf] = x.target.value;
    if (nf) editNode()[nf] = x.target.value;
    if (cf) {
      const character = findChar(S.draft, S.character);
      character[cf] =
        cf === "relationship" ? numberValue(x.target.value) : x.target.value;
    }
    if (qf) {
      const i = Number(
        x.target.closest("[data-choice-index]").dataset.choiceIndex,
      );
      const numeric = new Set([
          "conditionValue",
          "effectValue",
          "relationshipDelta",
        ]),
        value =
          qf === "effectOnce"
            ? x.target.checked
            : numeric.has(qf)
              ? numberValue(x.target.value)
              : x.target.value;
      editNode().choices[i][qf] = value;
      if (qf === "revealCityPoint") {
        editNode().choices[i].revealCityId = "";
        editNode().choices[i].revealCityScreen = "";
      }
      if (qf === "revealMindEvidence")
        editNode().choices[i].revealMindBoard = "";
      if (qf === "text") {
        const choiceLabel = S.editor
          .querySelector(
            `[data-node-id="${S.selected}"] [data-connect-choice="${i}"]`,
          )
          ?.closest(".ds-graph-choice")
          ?.querySelector("em");
        if (choiceLabel)
          choiceLabel.textContent =
            x.target.value || t("DS.EmptyResponse", "Пустой ответ");
      }
    }
    if (cityRef || mindRef) {
      const i = Number(
          x.target.closest("[data-choice-index]").dataset.choiceIndex,
        ),
        choice = editNode().choices[i],
        parts = String(x.target.value || "").split("|");
      if (cityRef) {
        choice.revealCityId = parts[0] || "";
        choice.revealCityScreen = parts[1] || "";
        choice.revealCityPoint = parts[2] || "";
      } else {
        choice.revealMindBoard = parts[0] || "";
        choice.revealMindEvidence = parts[1] || "";
      }
    }
    if (vf) {
      const variableId = x.target.closest("[data-variable-id]")?.dataset
          .variableId,
        variable = S.draft.variables.find(
          (candidate) => candidate.id === variableId,
        );
      if (variable)
        variable[vf] =
          vf === "initial" ? numberValue(x.target.value) : x.target.value;
    }
    if (nf) refreshNodeCard(S.selected);
    if (nf === "character") S.character = editNode().character;
    if (cf) {
      editScene()
        .nodes.filter((node) => node.character === S.character)
        .forEach((node) => refreshNodeCard(node.id));
      if (cf === "name" || cf === "role") renderLibrary();
      const heading = S.editor.querySelector(".ds-inspector-head h2");
      if (heading && cf === "name") heading.textContent = x.target.value;
    }
    if (sf === "title") {
      S.editor.querySelector(".ds-current-scene").textContent = x.target.value;
      const activeTitle = S.editor.querySelector(
        `[data-scene-id="${S.scene}"] b`,
      );
      if (activeTitle) activeTitle.textContent = x.target.value;
    }
    if (vf === "name") renderLibrary();
    autosave();
  };
  e.onchange = (x) => {
    const sf = x.target.dataset.sceneField,
      nf = x.target.dataset.nodeField,
      cf = x.target.dataset.characterField;
    if (sf === "start") {
      const camera = S.canvas?.getState() || S.camera;
      renderGraph(camera);
    } else if (nf === "character") {
      refreshNodeCard(S.selected);
      renderInspector();
      renderEdges();
    } else if (cf === "portrait" || cf === "color") {
      renderLibrary();
      editScene()
        .nodes.filter((node) => node.character === S.character)
        .forEach((node) => refreshNodeCard(node.id));
      renderEdges();
    }
  };
  e.onkeydown = (event) => {
    if (
      event.key === "Escape" &&
      !event.target.closest?.("input,textarea,select")
    ) {
      event.preventDefault();
      void closeEditor();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    restoreHistory(event.shiftKey ? "redo" : "undo");
  };
}
function autosave() {
  clearTimeout(S.timer);
  S.timer = setTimeout(() => {
    S.timer = 0;
    void save();
  }, 450);
}
function queueSave(snapshot, notify = false) {
  const write = async () => {
    try {
      await game.settings.set(MOD, "scene", snapshot);
      if (notify) ui.notifications.info(t("DS.Saved", "Диалоги сохранены."));
      return true;
    } catch (error) {
      reportError("save failed", error);
      return false;
    }
  };
  S.saveChain = S.saveChain.then(write, write);
  return S.saveChain;
}
async function save(notify = false) {
  if (!S.draft) return;
  clearTimeout(S.timer);
  S.timer = 0;
  return queueSave(clone(S.draft), notify);
}
async function showAll(sceneId = null) {
  if (!game.user.isGM) return false;
  const p = getProject(),
    target = p.scenes.some((scene) => scene.id === sceneId)
      ? sceneId
      : p.activeScene;
  p.activeScene = target;
  const tableUuid = findScene(p, target).greetingTableUuid;
  let greeting = "";
  try {
    if (tableUuid) greeting = await rollGreeting(tableUuid);
    await game.settings.set(MOD, "scene", p);
    await game.settings.set(MOD, "visible", true);
  } catch (error) {
    reportError("show failed", error);
    return false;
  }
  game.socket.emit(`module.${MOD}`, {
    type: "open",
    sceneId: target,
    greeting,
    userId: game.user.id,
  });
  await openViewer(target, null, greeting);
  Hooks.callAll("dialogueStage.shown", {
    sceneId: target,
    userId: game.user.id,
  });
  return true;
}

async function hideAll() {
  if (!game.user.isGM) return false;
  try {
    await game.settings.set(MOD, "visible", false);
  } catch (error) {
    reportError("hide failed", error);
    return false;
  }
  game.socket.emit(`module.${MOD}`, { type: "close", userId: game.user.id });
  closeViewer();
  Hooks.callAll("dialogueStage.hidden", { userId: game.user.id });
  return true;
}
function registerSceneControls(controls) {
  const tools = {
    open: {
      name: "open",
      title: t("DS.Open", "Открыть диалог"),
      icon: "fa-solid fa-masks-theater",
      order: 0,
      button: true,
      onChange: () => openViewer(),
    },
  };
  if (game.user.isGM) {
    tools.edit = {
      name: "edit",
      title: t("DS.Editor", "Редактор диалогов"),
      icon: "fa-solid fa-diagram-project",
      order: 1,
      button: true,
      onChange: () => openEditor(),
    };
    tools.show = {
      name: "show",
      title: t("DS.Show", "Открыть текущий диалог всем"),
      icon: "fa-solid fa-users-viewfinder",
      order: 2,
      button: true,
      onChange: () => showAll(),
    };
    tools.close = {
      name: "close",
      title: t("DS.Hide", "Закрыть диалог у всех"),
      icon: "fa-solid fa-eye-slash",
      order: 3,
      button: true,
      onChange: () => hideAll(),
    };
  }
  const control = {
    name: "dialogueStage",
    title: t("DS.Title", "Диалоги"),
    icon: "fa-solid fa-comments",
    order: 77,
    visible: true,
    tools,
  };
  if (Array.isArray(controls))
    controls.push({
      ...control,
      layer: "controls",
      tools: Object.values(tools),
    });
  else controls.dialogueStage = control;
}
Hooks.on("getSceneControlButtons", registerSceneControls);
Hooks.once("init", () => {
  game.settings.register(MOD, "presets", { scope: "world", config: false, type: Array, default: [] });
  game.settings.register(MOD, "scene", {
    name: "Диалоги",
    scope: "world",
    config: false,
    type: Object,
    default: example(),
  });
  game.settings.register(MOD, "visible", {
    name: "Диалог открыт",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });
  game.settings.register(MOD, "storyState", {
    name: "Состояние истории",
    scope: "world",
    config: false,
    type: Object,
    default: {
      version: STORY_STATE_VERSION,
      variables: {},
      relationships: {},
      applied: [],
      integrations: {},
      receipts: [],
    },
    onChange: (value) => {
      const project = getProject();
      S.runtimeState = settlePendingChoices(
        normalizeStoryState(value, project),
      );
      if (S.viewer && S.node && !S.choiceBusy) {
        const scene = findScene(project, S.viewer.dataset.sceneId);
        showNode(project, scene, S.node, { record: false });
      }
      Hooks.callAll("dialogueStage.storyStateChanged", clone(S.runtimeState));
    },
  });
});
Hooks.once("ready", () => {
  document.addEventListener("click", async event => {
    const uuid = event.target.closest?.("[data-ds-quest]")?.dataset.dsQuest;
    if (!uuid) return;
    try {
      const page = await fromUuid(uuid);
      if (!page?.testUserPermission(game.user, "OBSERVER")) return;
      if (game.modules.get("simple-quest")?.active && ui.simpleQuest?.openToPage) await ui.simpleQuest.openToPage(uuid);
      else await page.parent.sheet.render(true, { pageId: page.id });
    } catch (error) { ui.notifications.error(error.message); }
  });
  game.socket.on(`module.${MOD}`, (m) => {
    if (!m || typeof m !== "object") return;
    const sender = game.users.get(m.userId);
    if (m.type === "choice") {
      if (
        !game.user.isGM ||
        !isPrimaryGM() ||
        !sender?.active ||
        sender.isGM ||
        !requestId(m.requestId)
      )
        return;
      const now = Date.now(),
        previous = S.choiceRate.get(sender.id),
        rate =
          previous && now - previous.startedAt < 5000
            ? previous
            : { startedAt: now, count: 0 };
      if (rate.count >= 20) return;
      rate.count += 1;
      S.choiceRate.set(sender.id, rate);
      if (
        ![m.sceneId, m.nodeId, m.choiceId].every((id) =>
          /^[A-Za-z0-9_-]{1,128}$/.test(String(id || "")),
        )
      )
        return;
      const project = getProject(),
        scene =
          project.scenes.find((candidate) => candidate.id === m.sceneId) ||
          { id: m.sceneId },
        node =
          scene.nodes?.find((candidate) => candidate.id === m.nodeId) ||
          { id: m.nodeId },
        choice =
          node.choices?.find((candidate) => candidate.id === m.choiceId) ||
          { id: m.choiceId };
      void applyChoiceEffects(
        project,
        scene,
        node,
        choice,
        sender.id,
        m.requestId,
      )
        .then(() =>
          game.socket.emit(`module.${MOD}`, {
            type: "choice-result",
            requestId: m.requestId,
            targetUserId: sender.id,
            userId: game.user.id,
          }),
        )
        .catch((error) => console.error(`${MOD} | choice failed`, error));
      return;
    }
    if (
      m.type === "choice-result" &&
      m.targetUserId === game.user.id &&
      S.pendingChoices.has(requestId(m.requestId))
    ) {
      settlePendingChoices(getStoryState());
      return;
    }
    if (!sender?.isGM) return;
    if (m.type === "story-state") {
      const project = getProject();
      S.runtimeState = settlePendingChoices(getStoryState(project));
      if (S.viewer && S.node && !S.choiceBusy) {
        const scene = findScene(project, S.viewer.dataset.sceneId);
        showNode(project, scene, S.node, { record: false });
      }
      return;
    }
    const visible = game.settings.get(MOD, "visible"),
      project = getProject();
    if (
      m.type === "open" &&
      visible === true &&
      m.sceneId === project.activeScene
    )
      openViewer(project.activeScene, null, typeof m.greeting === "string" ? m.greeting : null);
    if (m.type === "close" && visible === false) closeViewer();
  });
  if (game.user.isGM) {
    const project = getProject(),
      stored = game.settings.get(MOD, "scene");
    if (Number(stored?.version || 0) < 4)
      void game.settings.set(MOD, "scene", project);
    void game.settings.set(
      MOD,
      "storyState",
      normalizeStoryState(game.settings.get(MOD, "storyState"), project),
    );
  }
  if (!game.user.isGM && game.settings.get(MOD, "visible")) openViewer();
  const emergencyFlush = () => {
    if (game.user.isGM && S.draft) void save(false);
  };
  globalThis.addEventListener?.("pagehide", emergencyFlush);
  globalThis.document?.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "hidden") emergencyFlush();
  });
  game.modules.get(MOD).api = {
    version: "3.1.0",
    open: openViewer,
    close: closeViewer,
    openEditor,
    editEntity(path, setting) {
      if (!game.user.isGM) return false;
      openEditor();
      if (setting === "presets") return openDialoguePresets();
      if (path[0] === "characters") { S.character = path[1]; S.panel = "character"; }
      else {
        const scene = S.draft.scenes.find(scene => scene.id === path[1]);
        if (!scene) return false;
        S.scene = scene.id; S.selected = path[3] || scene.start; S.panel = path[3] ? "node" : "scene"; S.camera = null;
      }
      renderEditor(); return true;
    },
    getEntityUuid: (path) => globalThis.UniCanvasDocuments?.uuid(MOD, path),
    listEntities: () => globalThis.UniCanvasDocuments?.list(MOD) || [],
    getPresets: () => [...builtInPresets(), ...dialoguePresets()],
    applyPreset: applyDialoguePreset,
    rollGreeting,
    show: showAll,
    hide: hideAll,
    getProject,
    getStoryState: () => clone(getStoryState()),
    setVariable: async (variableId, value) => {
      if (!game.user.isGM) return false;
      const state = await enqueueStoryWrite(async () => {
        const project = getProject(),
          variable = project.variables.find(
            (candidate) => candidate.id === variableId,
          );
        if (!variable) return false;
        const next = getStoryState(project);
        next.variables[variable.id] = numberValue(value);
        await game.settings.set(MOD, "storyState", next);
        return next;
      });
      if (!state) return false;
      game.socket.emit(`module.${MOD}`, {
        type: "story-state",
        userId: game.user.id,
      });
      return clone(state);
    },
    changeRelationship: async (characterId, delta) => {
      if (!game.user.isGM) return false;
      const state = await enqueueStoryWrite(async () => {
        const project = getProject();
        if (
          !project.characters.some(
            (character) => character.id === characterId,
          )
        )
          return false;
        const next = getStoryState(project);
        next.relationships[characterId] = numberValue(
          numberValue(next.relationships[characterId]) + numberValue(delta),
        );
        await game.settings.set(MOD, "storyState", next);
        return next;
      });
      if (!state) return false;
      game.socket.emit(`module.${MOD}`, {
        type: "story-state",
        userId: game.user.id,
      });
      return clone(state);
    },
    resetStoryState: async () => {
      if (!game.user.isGM) return false;
      const state = await enqueueStoryWrite(async () => {
        const next = normalizeStoryState({}, getProject());
        await game.settings.set(MOD, "storyState", next);
        return next;
      });
      game.socket.emit(`module.${MOD}`, {
        type: "story-state",
        userId: game.user.id,
      });
      Hooks.callAll("dialogueStage.storyReset", clone(state));
      return clone(state);
    },
    applyChoice: async (sceneId, nodeId, choiceId, options = {}) => {
      if (!game.user.isGM) return false;
      const project = getProject(),
        scene = project.scenes.find((candidate) => candidate.id === sceneId),
        node = scene?.nodes.find((candidate) => candidate.id === nodeId),
        choice = node?.choices.find(
          (candidate) => candidate.id === choiceId,
        );
      if (!scene || !node || !choice) return false;
      const transaction = await applyChoiceEffects(
        project,
        scene,
        node,
        choice,
        options.userId || game.user.id,
        requestId(options.requestId),
      );
      return transaction.accepted ? clone(transaction.state) : false;
    },
    exportProject: () => clone(getProject()),
    importProject: async (project) => {
      if (!game.user.isGM) return false;
      if (!isImportableProject(project))
        throw new TypeError("Invalid Dialogue Stage project");
      const normalized = normalize(project);
      await game.settings.set(MOD, "scene", normalized);
      await game.settings.set(
        MOD,
        "storyState",
        normalizeStoryState({}, normalized),
      );
      return clone(normalized);
    },
  };
  Hooks.callAll("dialogueStage.apiReady", game.modules.get(MOD).api);
  console.info(`${MOD} | ready`);
});
