const MOD = "mind-palace";
const EDITOR_WIDTH = 3000;
const EDITOR_HEIGHT = 1800;
const MAX_DEDUCTIONS = 50;
const MAX_CONSEQUENCES = 20;
const MAX_PLAYER_LINKS = 200;
const ASSET = (name) => `modules/${MOD}/assets/template/${name}`;
const S = {
  editor: null,
  viewer: null,
  draft: null,
  board: null,
  selected: null,
  connecting: false,
  connectFrom: null,
  timer: null,
  canvas: null,
  canvasBoard: null,
  cameras: new Map(),
  geometryFrame: 0,
  noteTimer: 0,
  layoutTimer: 0,
  saveChain: Promise.resolve(),
  personalChain: Promise.resolve(),
  pendingLayouts: new Map(),
  pendingNotes: new Map(),
  undo: [],
  redo: [],
  inputSnapshot: null,
  inputSnapshotArmed: false,
  geometryNodes: new Set(),
  parallaxFrame: 0,
  parallax: null,
  deductionPanel: false,
  selectedDeduction: null,
  viewerConnecting: false,
  viewerConnectFrom: null,
  socketEvents: new Set(),
  socketRequests: new Set(),
  revealQueue: [],
  revealActive: false,
  pendingChronicle: "",
  collaborationBoards: new Map(),
};
const clone = (value) => foundry.utils.deepClone(value);
const uid = () => foundry.utils.randomID(16);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#039;",
        '"': "&quot;",
      })[c],
  );
const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, Number(value) || 0));
const t = (key, fallback = key) =>
  game.i18n?.localize(key) === key ? fallback : game.i18n.localize(key);
const cssUrl = (value) =>
  String(value ?? "").replace(/[\\'"()\n\r]/g, (character) =>
    encodeURIComponent(character),
  );
const safeColor = (value, fallback = "#b94343") =>
  /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
const safeId = (value) => {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : uid();
};
const edgeKey = (from, to) =>
  [String(from || ""), String(to || "")].sort().join("::");
const boundedNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(1_000_000_000, Math.max(-1_000_000_000, number))
    : fallback;
};
const optimizedAsset = (value) => {
  const source = String(value || ""),
    names = ["professor-voss", "lady-ashcroft", "cobalt-vial", "star-chart"];
  for (const name of names)
    if (source === ASSET(`${name}.png`)) return ASSET(`${name}.webp`);
  return source;
};

function reportError(context, error) {
  console.error(`${MOD} | ${context}`, error);
  ui.notifications?.error?.(
    t("MP.SaveFailed", "Mind Palace could not save its data."),
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
  const undo = S.editor?.querySelector('[data-act="undo"]'),
    redo = S.editor?.querySelector('[data-act="redo"]');
  if (undo) undo.disabled = !S.undo.length;
  if (redo) redo.disabled = !S.redo.length;
}

function restoreHistory(direction) {
  const source = direction === "undo" ? S.undo : S.redo,
    destination = direction === "undo" ? S.redo : S.undo,
    snapshot = source.pop();
  if (!snapshot || !S.draft) return;
  destination.push(clone(S.draft));
  S.draft = normalizeProject(snapshot);
  if (!S.draft.boards.some((board) => board.id === S.board))
    S.board = S.draft.activeBoard;
  if (!activeBoard().nodes.some((node) => node.id === S.selected))
    S.selected = null;
  renderEditor();
  autosave();
  updateHistoryButtons();
}

function ashcroftDemoConsequences() {
  return [
    {
      id: "outcome-silver-burn",
      type: "evidence",
      label: "Silver Burn",
      evidenceId: "silver-burn",
    },
    {
      id: "outcome-north-workshops",
      type: "city",
      label: "Northern workshops",
      cityId: "",
      screenId: "",
      pointId: "north-workshops",
    },
    {
      id: "outcome-courier-lead",
      type: "dialogue",
      label: "The courier trail advances",
      variableId: "courier-lead",
      operation: "add",
      value: 1,
    },
    {
      id: "outcome-silver-burn-night",
      type: "chronicle",
      label: "Reconstruct the night of the silver burn",
      timelineId: "silver-burn-night",
    },
    {
      id: "outcome-northbound",
      type: "narrative",
      title: "The trail turns north",
      body: "The silver scorch and the seventh shaft identify where the vapour was prepared. The shuttered workshops in the northern quarter are no longer a dead end.",
    },
  ];
}

function exampleCase() {
  const board = "ashcroft-formula",
    prof = "professor-voss",
    lady = "lady-ashcroft",
    letter = "sealed-letter",
    vial = "cobalt-vial",
    chart = "star-chart",
    ledger = "night-ledger",
    theory = "silver-burn";
  return {
    version: 4,
    activeBoard: board,
    boards: [
      {
        id: board,
        title: "The Ashcroft Formula",
        subtitle: "A death without a wound. A formula without its final line.",
        nodes: [
          {
            id: prof,
            type: "person",
            title: "Professor Elias Voss",
            caption: "Victim · Royal Alchemical Society",
            body: "Found dead in his locked study at 23:40. No wound, no poison known to the coroner. His right hand smelled faintly of bitter almonds and rain.",
            image: ASSET("professor-voss.webp"),
            x: 8,
            y: 11,
            w: 12,
            h: 19,
            rotation: -1.5,
            revealed: true,
          },
          {
            id: lady,
            type: "person",
            title: "Lady Mirabel Ashcroft",
            caption: "Patron · Last confirmed visitor",
            body: "Financed Voss's private research. Claims she left before ten, yet the west gate register bears her family seal at 23:12.",
            image: ASSET("lady-ashcroft.webp"),
            x: 80,
            y: 10,
            w: 12,
            h: 19,
            rotation: 1.3,
            revealed: true,
          },
          {
            id: letter,
            type: "document",
            title: "The Sealed Letter",
            caption: "Delivered three hours before the death",
            body: "The paper carries Ashcroft wax, but the pressure pattern suggests the seal was applied using a stolen signet cast. One sentence is underlined twice: “Do not complete the seventh distillation.”",
            image: "",
            x: 43,
            y: 9,
            w: 14,
            h: 13,
            rotation: 0.6,
            revealed: true,
          },
          {
            id: vial,
            type: "clue",
            title: "Cobalt Vial",
            caption: "Recovered beneath the furnace",
            body: "The stopper was cracked from the inside. Amber residue reacts to moonlight and evaporates when heated. Voss's fingerprints are absent.",
            image: ASSET("cobalt-vial.webp"),
            x: 11,
            y: 65,
            w: 13,
            h: 17,
            rotation: 1.2,
            revealed: true,
          },
          {
            id: chart,
            type: "clue",
            title: "Burned Star Chart",
            caption: "Fragment from the locked fireplace",
            body: "The seven-point figure is not astronomical. It maps the seven ventilation shafts beneath the laboratory. One point aligns with the servants' passage.",
            image: ASSET("star-chart.webp"),
            x: 77,
            y: 63,
            w: 14,
            h: 18,
            rotation: -1,
            revealed: true,
          },
          {
            id: ledger,
            type: "document",
            title: "Midnight Ledger",
            caption: "Three entries were cut from the binding",
            body: "Cobalt glass, silver salt, and mourning lilies were purchased through an intermediary called M. Rook. Payment originated from the Ashcroft estate office.",
            image: "",
            x: 43,
            y: 76,
            w: 15,
            h: 13,
            rotation: -0.5,
            revealed: true,
          },
          {
            id: theory,
            type: "clue",
            title: "Silver Burn",
            caption: "A mark revealed beneath the soot",
            body: "A narrow silver scorch circles the seventh ventilation grille. The alloy only blooms this way when exposed to heated cobalt vapour, proving the unfinished formula entered through the shaft.",
            image: "",
            x: 43,
            y: 40,
            w: 14,
            h: 14,
            rotation: 0,
            revealed: false,
          },
        ],
        links: [
          {
            id: uid(),
            from: prof,
            to: letter,
            label: "ignored warning",
            color: "#b94343",
            style: "solid",
          },
          {
            id: uid(),
            from: lady,
            to: letter,
            label: "seal copied",
            color: "#b94343",
            style: "dashed",
          },
          {
            id: uid(),
            from: prof,
            to: vial,
            label: "missing fingerprints",
            color: "#d8b56c",
            style: "solid",
          },
          {
            id: uid(),
            from: lady,
            to: ledger,
            label: "estate payment",
            color: "#b94343",
            style: "solid",
          },
          {
            id: uid(),
            from: ledger,
            to: vial,
            label: "cobalt glass",
            color: "#d8b56c",
            style: "solid",
          },
          {
            id: uid(),
            from: chart,
            to: theory,
            label: "seventh shaft",
            color: "#6f9fb2",
            style: "solid",
          },
          {
            id: uid(),
            from: vial,
            to: theory,
            label: "heated vapour",
            color: "#6f9fb2",
            style: "solid",
          },
          {
            id: uid(),
            from: letter,
            to: theory,
            label: "lured to furnace",
            color: "#6f9fb2",
            style: "dashed",
          },
        ],
        playerLinks: [],
        deductionRevision: 0,
        deductions: [
          {
            id: "seventh-shaft-deduction",
            title: "The Seventh Shaft",
            description:
              "The forged warning, the volatile cobalt residue, and the burned ventilation chart point to one method: the formula entered the locked study as heated vapour through the seventh shaft.",
            requiredNodes: [letter, vial, chart],
            requiredLinks: [
              { from: letter, to: vial },
              { from: vial, to: chart },
            ],
            rewardNodeId: theory,
            revealed: false,
            revealedAt: "",
            revealedBy: "",
            unlockApplied: false,
            consequences: ashcroftDemoConsequences(),
          },
        ],
      },
    ],
  };
}

function normalizeNode(raw = {}) {
  const type = ["person", "document", "clue", "note", "text"].includes(raw.type)
    ? raw.type
    : "note";
  return {
    id: safeId(raw.id),
    type,
    title: raw.title || t("MP.Untitled", "Untitled thought"),
    caption: raw.caption || "",
    body: raw.body || "",
    image: optimizedAsset(raw.image),
    x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : 38,
    y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : 34,
    w: clamp(raw.w ?? (type === "text" ? 16 : 14), 7, 28),
    h: clamp(raw.h ?? (type === "text" ? 8 : 16), 5, 30),
    rotation: clamp(raw.rotation ?? 0, -8, 8),
    revealed: raw.revealed !== false,
  };
}

function normalizeRequiredLink(raw, nodeIds) {
  const from = String(raw?.from || ""),
    to = String(raw?.to || "");
  if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) return null;
  return { from, to };
}

function normalizeConsequence(raw = {}, nodeIds = new Set(), index = 0) {
  const type = [
      "evidence",
      "city",
      "dialogue",
      "chronicle",
      "narrative",
    ].includes(raw.type)
      ? raw.type
      : "narrative",
    status = ["pending", "delivered", "failed"].includes(raw.status)
      ? raw.status
      : "pending",
    hasPrepared =
      raw.preparedValue !== null &&
      raw.preparedValue !== "" &&
      Number.isFinite(Number(raw.preparedValue)),
    prepared = hasPrepared ? Number(raw.preparedValue) : null;
  return {
    id: safeId(raw.id),
    type,
    label: String(raw.label || "").slice(0, 160),
    evidenceId:
      type === "evidence" && nodeIds.has(String(raw.evidenceId || ""))
        ? String(raw.evidenceId)
        : "",
    cityId: type === "city" ? String(raw.cityId || "").slice(0, 128) : "",
    screenId:
      type === "city" ? String(raw.screenId || "").slice(0, 128) : "",
    pointId: type === "city" ? String(raw.pointId || "").slice(0, 128) : "",
    variableId:
      type === "dialogue"
        ? String(raw.variableId || "").slice(0, 128)
        : "",
    timelineId:
      type === "chronicle"
        ? String(raw.timelineId || "").slice(0, 128)
        : "",
    operation: type === "dialogue" && raw.operation === "add" ? "add" : "set",
    value: type === "dialogue" ? boundedNumber(raw.value) : 0,
    title:
      type === "narrative"
        ? String(raw.title || `${t("MP.NewOutcome", "New outcome")} ${index + 1}`).slice(0, 160)
        : "",
    body: type === "narrative" ? String(raw.body || "").slice(0, 6000) : "",
    status,
    attempts: Math.min(1000, Math.max(0, Math.floor(Number(raw.attempts) || 0))),
    preparedValue:
      type === "dialogue" && prepared !== null
        ? boundedNumber(prepared)
        : null,
    deliveredAt:
      status === "delivered" ? String(raw.deliveredAt || "").slice(0, 64) : "",
    lastAttemptAt:
      status !== "pending" || raw.lastAttemptAt
        ? String(raw.lastAttemptAt || "").slice(0, 64)
        : "",
    lastError:
      status === "failed" ? String(raw.lastError || "delivery-error").slice(0, 64) : "",
  };
}

function resetConsequenceDelivery(consequence) {
  consequence.status = "pending";
  consequence.attempts = 0;
  consequence.preparedValue = null;
  consequence.deliveredAt = "";
  consequence.lastAttemptAt = "";
  consequence.lastError = "";
  return consequence;
}

function normalizeDeduction(raw = {}, nodeIds, index = 0) {
  const requiredNodes = [
      ...new Set(
        (Array.isArray(raw.requiredNodes) ? raw.requiredNodes : [])
          .map(String)
          .filter((id) => nodeIds.has(id)),
      ),
    ].slice(0, 200),
    requiredLinks = [],
    seenLinks = new Set();
  (Array.isArray(raw.requiredLinks) ? raw.requiredLinks : [])
    .slice(0, 200)
    .forEach((entry) => {
      const link = normalizeRequiredLink(entry, nodeIds);
      if (!link) return;
      const key = edgeKey(link.from, link.to);
      if (seenLinks.has(key)) return;
      seenLinks.add(key);
      requiredLinks.push(link);
    });
  const rewardNodeId = nodeIds.has(String(raw.rewardNodeId || ""))
    ? String(raw.rewardNodeId)
    : "";
  const consequences = (Array.isArray(raw.consequences) ? raw.consequences : [])
      .filter((entry) => entry && typeof entry === "object")
      .slice(0, MAX_CONSEQUENCES)
      .map((entry, consequenceIndex) =>
        normalizeConsequence(entry, nodeIds, consequenceIndex),
      ),
    consequenceIds = new Set();
  consequences.forEach((consequence) => {
    if (!consequence.id || consequenceIds.has(consequence.id)) consequence.id = uid();
    consequenceIds.add(consequence.id);
  });
  return {
    id: safeId(raw.id),
    title: String(raw.title || `${t("MP.NewDeduction", "New deduction")} ${index + 1}`).slice(0, 160),
    description: String(raw.description || "").slice(0, 6000),
    requiredNodes,
    requiredLinks,
    rewardNodeId,
    revealed: raw.revealed === true,
    revealedAt: raw.revealed
      ? String(raw.revealedAt || "").slice(0, 64)
      : "",
    revealedBy: raw.revealed
      ? String(raw.revealedBy || "").slice(0, 128)
      : "",
    unlockApplied: raw.revealed === true && raw.unlockApplied === true,
    consequences,
  };
}

function normalizeBoard(raw = {}) {
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
      .filter((node) => node && typeof node === "object")
      .map(normalizeNode),
    ids = new Set();
  nodes.forEach((node) => {
    if (!node.id || ids.has(node.id)) node.id = uid();
    ids.add(node.id);
  });
  const playerLinks = [],
    seenPlayerLinks = new Set(),
    playerLinkIds = new Set();
  (Array.isArray(raw.playerLinks) ? raw.playerLinks : [])
    .slice(0, MAX_PLAYER_LINKS)
    .forEach((entry) => {
      const link = normalizeRequiredLink(entry, ids);
      if (!link) return;
      const key = edgeKey(link.from, link.to);
      if (seenPlayerLinks.has(key)) return;
      seenPlayerLinks.add(key);
      let id = safeId(entry.id);
      if (playerLinkIds.has(id)) id = uid();
      playerLinkIds.add(id);
      playerLinks.push({
        id,
        ...link,
        createdBy: String(entry.createdBy || "").slice(0, 128),
        createdAt: String(entry.createdAt || "").slice(0, 64),
      });
    });
  const deductions = (Array.isArray(raw.deductions) ? raw.deductions : [])
      .filter((rule) => rule && typeof rule === "object")
      .slice(0, MAX_DEDUCTIONS)
      .map((rule, index) => normalizeDeduction(rule, ids, index)),
    deductionIds = new Set();
  deductions.forEach((rule) => {
    if (!rule.id || deductionIds.has(rule.id)) rule.id = uid();
    deductionIds.add(rule.id);
  });
  return {
    id: safeId(raw.id),
    title: raw.title || t("MP.NewInvestigation", "New investigation"),
    subtitle: raw.subtitle || "",
    nodes,
    links: (Array.isArray(raw.links) ? raw.links : [])
      .filter((link) => link && typeof link === "object")
      .filter((l) => ids.has(l.from) && ids.has(l.to))
      .map((l) => ({
        id: safeId(l.id),
        from: l.from,
        to: l.to,
        label: l.label || "",
        color: safeColor(l.color),
        style: l.style === "dashed" ? "dashed" : "solid",
      })),
    playerLinks,
    deductionRevision: Math.max(0, Math.floor(Number(raw.deductionRevision) || 0)),
    deductions,
  };
}

function isAshcroftDemoBoard(board) {
  const signature = [
    "professor-voss",
    "sealed-letter",
    "cobalt-vial",
    "star-chart",
  ];
  return (
    board.id === "ashcroft-formula" &&
    signature.every((id) => board.nodes.some((node) => node.id === id))
  );
}

/**
 * Upgrade only the bundled Ashcroft demo shipped before deduction rules.
 * Requiring both its stable board id and its characteristic node ids avoids
 * injecting sample content into unrelated user investigations.
 */
function migrateAshcroftDemoV3(board) {
  if (!isAshcroftDemoBoard(board)) return board;

  if (!board.nodes.some((node) => node.id === "silver-burn")) {
    board.nodes.push(
      normalizeNode({
        id: "silver-burn",
        type: "clue",
        title: "Silver Burn",
        caption: "A mark revealed beneath the soot",
        body: "A narrow silver scorch circles the seventh ventilation grille. The alloy only blooms this way when exposed to heated cobalt vapour, proving the unfinished formula entered through the shaft.",
        image: "",
        x: 43,
        y: 40,
        w: 14,
        h: 14,
        rotation: 0,
        revealed: false,
      }),
    );
  }

  if (!board.deductions.some((rule) => rule.id === "seventh-shaft-deduction")) {
    const nodeIds = new Set(board.nodes.map((node) => node.id));
    board.deductions.push(
      normalizeDeduction(
        {
          id: "seventh-shaft-deduction",
          title: "The Seventh Shaft",
          description:
            "The forged warning, the volatile cobalt residue, and the burned ventilation chart point to one method: the formula entered the locked study as heated vapour through the seventh shaft.",
          requiredNodes: ["sealed-letter", "cobalt-vial", "star-chart"],
          requiredLinks: [
            { from: "sealed-letter", to: "cobalt-vial" },
            { from: "cobalt-vial", to: "star-chart" },
          ],
          rewardNodeId: "silver-burn",
          revealed: false,
        },
        nodeIds,
        board.deductions.length,
      ),
    );
  }
  return board;
}

/** Add the v4 gameplay continuation only to the recognizable bundled demo. */
function migrateAshcroftDemoV4(board) {
  if (!isAshcroftDemoBoard(board)) return board;
  const rule = board.deductions.find(
    (candidate) => candidate.id === "seventh-shaft-deduction",
  );
  if (!rule) return board;
  const nodeIds = new Set(board.nodes.map((node) => node.id)),
    existing = new Set(rule.consequences.map((consequence) => consequence.id));
  ashcroftDemoConsequences().forEach((raw, index) => {
    if (!existing.has(raw.id) && rule.consequences.length < MAX_CONSEQUENCES)
      rule.consequences.push(
        normalizeConsequence(raw, nodeIds, rule.consequences.length + index),
      );
  });
  return board;
}

function rekeyBoard(raw) {
  const board = normalizeBoard(clone(raw)),
    nodeIds = new Map();
  board.nodes.forEach((node) => {
    const previous = node.id;
    node.id = uid();
    nodeIds.set(previous, node.id);
  });
  const remapLink = (link) => ({
    ...link,
    id: uid(),
    from: nodeIds.get(link.from),
    to: nodeIds.get(link.to),
  });
  board.links = board.links.map(remapLink);
  board.playerLinks = board.playerLinks.map(remapLink);
  board.deductions = board.deductions.map((rule) => ({
    ...rule,
    id: uid(),
    requiredNodes: rule.requiredNodes.map((id) => nodeIds.get(id)).filter(Boolean),
    requiredLinks: rule.requiredLinks
      .map((link) => ({ from: nodeIds.get(link.from), to: nodeIds.get(link.to) }))
      .filter((link) => link.from && link.to),
    rewardNodeId: nodeIds.get(rule.rewardNodeId) || "",
    consequences: rule.consequences.map((consequence) =>
      resetConsequenceDelivery({
        ...consequence,
        id: uid(),
        evidenceId:
          consequence.type === "evidence"
            ? nodeIds.get(consequence.evidenceId) || ""
            : "",
      }),
    ),
  }));
  board.id = uid();
  return board;
}
function normalizeProject(raw = {}) {
  if (!Array.isArray(raw.boards) || !raw.boards.length) return exampleCase();
  const sourceVersion = Number(raw.version || 1),
    legacy = sourceVersion < 2,
    boards = raw.boards
      .filter((board) => board && typeof board === "object")
      .map(normalizeBoard);
  if (!boards.length) return exampleCase();
  const boardIds = new Set();
  boards.forEach((board) => {
    if (!board.id || boardIds.has(board.id)) board.id = uid();
    boardIds.add(board.id);
  });
  if (legacy)
    boards.forEach((board) =>
      board.nodes.forEach((node) => {
        const cx = node.x + node.w / 2,
          cy = node.y + node.h / 2;
        node.w *= 0.66;
        node.h *= 0.68;
        node.x = clamp(cx - node.w / 2, 0, 100 - node.w);
        node.y = clamp(cy - node.h / 2, 0, 100 - node.h);
      }),
    );
  if (sourceVersion < 3) boards.forEach(migrateAshcroftDemoV3);
  if (sourceVersion < 4) boards.forEach(migrateAshcroftDemoV4);
  return {
    version: 4,
    activeBoard: boards.some((b) => b.id === raw.activeBoard)
      ? raw.activeBoard
      : boards[0].id,
    boards,
  };
}
function activeBoard() {
  return S.draft?.boards.find((b) => b.id === S.board) || S.draft?.boards[0];
}
function activeNode() {
  return activeBoard()?.nodes.find((n) => n.id === S.selected) || null;
}
function isImportableProject(project) {
  return Boolean(
    project &&
      typeof project === "object" &&
      Array.isArray(project.boards) &&
      project.boards.some((board) => board && typeof board === "object"),
  );
}
function boardFromSettings(boardId) {
  const project = normalizeProject(game.settings.get(MOD, "project"));
  return (
    project.boards.find((b) => b.id === boardId) ||
    project.boards.find((b) => b.id === project.activeBoard) ||
    project.boards[0]
  );
}

function deductionProgress(board, rule) {
  const nodes = new Map(board.nodes.map((node) => [node.id, node])),
    playerEdges = new Set(board.playerLinks.map((link) => edgeKey(link.from, link.to))),
    nodeDone = rule.requiredNodes.filter((id) => nodes.get(id)?.revealed).length,
    linkDone = rule.requiredLinks.filter((link) =>
      playerEdges.has(edgeKey(link.from, link.to)),
    ).length,
    total = rule.requiredNodes.length + rule.requiredLinks.length,
    completed = nodeDone + linkDone;
  return {
    completed,
    total,
    ratio: total ? completed / total : 0,
    complete: total > 0 && completed === total,
  };
}

function consequenceLabel(board, consequence) {
  if (consequence.type === "evidence")
    return (
      board.nodes.find((node) => node.id === consequence.evidenceId)?.title ||
      consequence.label ||
      t("MP.ClueUnlocked", "Clue unlocked")
    );
  if (consequence.type === "city")
    return consequence.label || t("MP.CityPathOpened", "A new place is accessible");
  if (consequence.type === "dialogue")
    return consequence.label || t("MP.StoryChanged", "The story has changed");
  if (consequence.type === "chronicle")
    return consequence.label || t("MP.TimelineOpened", "A timeline has opened");
  return consequence.title || t("MP.NewOutcome", "New outcome");
}

function publicConsequenceView(board, consequence) {
  if (consequence.status !== "delivered") return null;
  if (consequence.type === "narrative")
    return {
      type: "narrative",
      title: consequenceLabel(board, consequence),
      body: consequence.body,
    };
  return {
    type: consequence.type,
    label: consequenceLabel(board, consequence),
  };
}

function deductionView(board, rule, includeSecrets = game.user.isGM) {
  const progress = deductionProgress(board, rule),
    reward = board.nodes.find((node) => node.id === rule.rewardNodeId);
  if (!includeSecrets && !rule.revealed)
    return {
      id: rule.id,
      revealed: false,
      progress,
    };
  return {
    id: rule.id,
    title: rule.title,
    description: rule.description,
    requiredNodes: includeSecrets ? clone(rule.requiredNodes) : undefined,
    requiredLinks: includeSecrets ? clone(rule.requiredLinks) : undefined,
    rewardNodeId: includeSecrets ? rule.rewardNodeId : undefined,
    reward:
      rule.revealed && reward
        ? {
            ...(includeSecrets ? { id: reward.id } : {}),
            title: reward.title,
            type: reward.type,
          }
        : null,
    revealed: rule.revealed,
    revealedAt: rule.revealedAt,
    revealedBy: includeSecrets ? rule.revealedBy : undefined,
    consequences: includeSecrets ? clone(rule.consequences) : undefined,
    outcomes: rule.revealed
      ? rule.consequences
          .map((consequence) => publicConsequenceView(board, consequence))
          .filter(Boolean)
      : undefined,
    progress,
  };
}

function revealRuleOnBoard(board, rule, userId, force = false) {
  if (!rule || rule.revealed) return false;
  if (!force && !deductionProgress(board, rule).complete) return false;
  rule.revealed = true;
  rule.revealedAt = new Date().toISOString();
  rule.revealedBy = String(userId || "");
  rule.unlockApplied = false;
  const reward = board.nodes.find((node) => node.id === rule.rewardNodeId);
  if (reward && !reward.revealed) {
    reward.revealed = true;
    rule.unlockApplied = true;
  }
  return true;
}

function revealReadyDeductions(board, userId) {
  const revealedIds = [];
  board.deductions.forEach((rule) => {
    if (revealRuleOnBoard(board, rule, userId, false)) revealedIds.push(rule.id);
  });
  return revealedIds;
}

function resetRuleOnBoard(board, rule) {
  if (!rule) return false;
  const wasRevealed = rule.revealed,
    requiredEdges = new Set(
      rule.requiredLinks.map((link) => edgeKey(link.from, link.to)),
    ),
    beforeLinks = board.playerLinks.length;
  board.playerLinks = board.playerLinks.filter(
    (link) => !requiredEdges.has(edgeKey(link.from, link.to)),
  );
  if (rule.unlockApplied && rule.rewardNodeId) {
    const keptOpen = board.deductions.some(
      (candidate) =>
        candidate.id !== rule.id &&
        candidate.revealed &&
        candidate.unlockApplied &&
        candidate.rewardNodeId === rule.rewardNodeId,
    );
    if (!keptOpen) {
      const reward = board.nodes.find((node) => node.id === rule.rewardNodeId);
      if (reward) reward.revealed = false;
    }
  }
  rule.revealed = false;
  rule.revealedAt = "";
  rule.revealedBy = "";
  rule.unlockApplied = false;
  const changed = wasRevealed || beforeLinks !== board.playerLinks.length;
  if (changed) board.deductionRevision += 1;
  return changed;
}

function consequenceFailure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function consequenceFailureCode(error) {
  const allowed = new Set([
    "module-unavailable",
    "reference-missing",
    "delivery-rejected",
    "delivery-error",
  ]);
  return allowed.has(error?.code) ? error.code : "delivery-error";
}

function cityPointCatalog() {
  try {
    const api = game.modules?.get?.("city-viewer")?.api,
      project = api?.getProject?.();
    if (!api?.revealPoint || !project?.cities) return [];
    return project.cities.flatMap((targetCity) =>
      (targetCity.screens || []).flatMap((screen) =>
        (screen.objects || [])
          .filter((point) => point.kind === "poi")
          .map((point) => ({
            cityId: String(targetCity.id),
            screenId: String(screen.id),
            pointId: String(point.id),
            label: [targetCity.name, screen.title, point.name]
              .filter(Boolean)
              .join(" · "),
          })),
      ),
    );
  } catch (_error) {
    return [];
  }
}

function dialogueVariableCatalog() {
  try {
    const api = game.modules?.get?.("dialogue-stage")?.api,
      project = api?.getProject?.();
    if (!api?.setVariable || !project?.variables) return [];
    return project.variables.map((variable) => ({
      id: String(variable.id),
      label: String(variable.name || t("MP.StoryVariable", "Story variable")),
    }));
  } catch (_error) {
    return [];
  }
}

function chronicleTimelineCatalog() {
  try {
    const api = game.modules?.get?.("chronicle")?.api,
      project = api?.getProject?.();
    if (!api?.show || !project?.timelines) return [];
    return project.timelines.map((timeline) => ({
      id: String(timeline.id),
      label: String(timeline.title || t("MP.Timeline", "Timeline")),
    }));
  } catch (_error) {
    return [];
  }
}

function resolveCityConsequence(consequence) {
  const api = game.modules?.get?.("city-viewer")?.api;
  if (!api?.revealPoint || !api?.getProject)
    throw consequenceFailure("module-unavailable");
  const catalog = cityPointCatalog(),
    exact = Boolean(consequence.cityId && consequence.screenId),
    matches = catalog.filter(
      (entry) =>
        entry.pointId === consequence.pointId &&
        (!exact ||
          (entry.cityId === consequence.cityId &&
            entry.screenId === consequence.screenId)),
    );
  if (matches.length !== 1) throw consequenceFailure("reference-missing");
  const reference = matches[0];
  consequence.cityId = reference.cityId;
  consequence.screenId = reference.screenId;
  consequence.pointId = reference.pointId;
  if (!consequence.label) consequence.label = reference.label;
  return { api, reference };
}

function resolveDialogueConsequence(consequence) {
  const api = game.modules?.get?.("dialogue-stage")?.api;
  if (!api?.setVariable || !api?.getProject || !api?.getStoryState)
    throw consequenceFailure("module-unavailable");
  const variable = dialogueVariableCatalog().find(
    (entry) => entry.id === consequence.variableId,
  );
  if (!variable) throw consequenceFailure("reference-missing");
  if (!consequence.label) consequence.label = variable.label;
  if (consequence.preparedValue === null) {
    const state = api.getStoryState(),
      current = boundedNumber(state?.variables?.[consequence.variableId]);
    consequence.preparedValue =
      consequence.operation === "add"
        ? boundedNumber(current + consequence.value)
        : boundedNumber(consequence.value);
  }
  return api;
}

function resolveChronicleConsequence(consequence) {
  const api = game.modules?.get?.("chronicle")?.api;
  if (!api?.show || !api?.getProject)
    throw consequenceFailure("module-unavailable");
  const timeline = chronicleTimelineCatalog().find(
    (entry) => entry.id === consequence.timelineId,
  );
  if (!timeline) throw consequenceFailure("reference-missing");
  if (!consequence.label) consequence.label = timeline.label;
  return api;
}

async function persistConsequenceProject(project, board, result = {}) {
  board.deductionRevision += 1;
  S.collaborationBoards.set(board.id, clone(board));
  mirrorCollaborativeBoard(board, result);
  await game.settings.set(MOD, "project", project);
}

async function deliverOneConsequence(
  project,
  board,
  rule,
  consequence,
  summary,
) {
  const now = new Date().toISOString(),
    source = `mind-palace:${board.id}:${rule.id}:${consequence.id}`;
  consequence.attempts += 1;
  consequence.lastAttemptAt = now;
  consequence.lastError = "";
  consequence.status = "pending";
  try {
    if (consequence.type === "evidence") {
      const node = board.nodes.find(
        (candidate) => candidate.id === consequence.evidenceId,
      );
      if (!node) throw consequenceFailure("reference-missing");
      const newlyRevealed = !node.revealed;
      node.revealed = true;
      consequence.status = "delivered";
      consequence.deliveredAt = now;
      await persistConsequenceProject(project, board, {
        visibilityIds: [node.id],
      });
      if (newlyRevealed) summary.evidenceIds.push(node.id);
    } else if (consequence.type === "narrative") {
      consequence.status = "delivered";
      consequence.deliveredAt = now;
      await persistConsequenceProject(project, board);
    } else if (consequence.type === "city") {
      const { api, reference } = resolveCityConsequence(consequence);
      // Persist the exact resolved reference before crossing the module boundary.
      await persistConsequenceProject(project, board);
      const delivered = await api.revealPoint(
        reference.cityId,
        reference.screenId,
        reference.pointId,
        { source },
      );
      if (delivered === false) throw consequenceFailure("delivery-rejected");
      consequence.status = "delivered";
      consequence.deliveredAt = new Date().toISOString();
      await persistConsequenceProject(project, board);
    } else if (consequence.type === "dialogue") {
      const api = resolveDialogueConsequence(consequence);
      // `preparedValue` is durable before the call. Retrying an `add` therefore
      // repeats an absolute set instead of applying the delta twice.
      await persistConsequenceProject(project, board);
      const delivered = await api.setVariable(
        consequence.variableId,
        consequence.preparedValue,
      );
      if (delivered === false) throw consequenceFailure("delivery-rejected");
      consequence.status = "delivered";
      consequence.deliveredAt = new Date().toISOString();
      await persistConsequenceProject(project, board);
    } else if (consequence.type === "chronicle") {
      const api = resolveChronicleConsequence(consequence);
      await persistConsequenceProject(project, board);
      const delivered = await api.show(consequence.timelineId);
      if (delivered === false) throw consequenceFailure("delivery-rejected");
      consequence.status = "delivered";
      consequence.deliveredAt = new Date().toISOString();
      await persistConsequenceProject(project, board);
    }
    summary.delivered.push(consequence.id);
    Hooks.callAll("mindPalace.consequenceDelivered", {
      boardId: board.id,
      deductionId: rule.id,
      consequence: clone(consequence),
    });
  } catch (error) {
    consequence.status = "failed";
    consequence.deliveredAt = "";
    consequence.lastError = consequenceFailureCode(error);
    try {
      await persistConsequenceProject(project, board);
    } catch (saveError) {
      reportError("consequence state save failed", saveError);
    }
    summary.failed.push(consequence.id);
    Hooks.callAll("mindPalace.consequenceFailed", {
      boardId: board.id,
      deductionId: rule.id,
      consequence: clone(consequence),
      reason: consequence.lastError,
    });
  }
}

function deliverRevealedConsequences(
  boardId,
  ruleIds,
  { consequenceId = "", includeFailed = true } = {},
) {
  if (!game.user.isGM) return Promise.resolve(false);
  const requested = new Set(
      (Array.isArray(ruleIds) ? ruleIds : [ruleIds]).map(String).filter(Boolean),
    ),
    task = async () => {
      const project = normalizeProject(game.settings.get(MOD, "project")),
        board = project.boards.find((candidate) => candidate.id === boardId),
        summaries = [];
      if (!board) return false;
      for (const rule of board.deductions) {
        if (!requested.has(rule.id) || !rule.revealed) continue;
        const summary = {
          boardId: board.id,
          deductionId: rule.id,
          delivered: [],
          failed: [],
          skipped: [],
          evidenceIds: [],
        };
        for (const consequence of rule.consequences) {
          if (consequenceId && consequence.id !== consequenceId) continue;
          if (
            consequence.status === "delivered" ||
            (consequence.status === "failed" && !includeFailed)
          ) {
            summary.skipped.push(consequence.id);
            continue;
          }
          await deliverOneConsequence(project, board, rule, consequence, summary);
        }
        summaries.push(summary);
      }
      return summaries;
    };
  S.saveChain = S.saveChain.then(task, task);
  return S.saveChain;
}

async function settleRevealedConsequences(boardId, result) {
  const revealedIds = Array.isArray(result?.revealedIds)
    ? result.revealedIds
    : [];
  if (!revealedIds.length) return result;
  const summaries = await deliverRevealedConsequences(boardId, revealedIds, {
    includeFailed: true,
  });
  if (!summaries) return result;
  result.evidenceIds = [
    ...new Set([
      ...(Array.isArray(result.evidenceIds) ? result.evidenceIds : []),
      ...summaries.flatMap((summary) => summary.evidenceIds),
    ]),
  ];
  result.outcomeRuleIds = summaries
    .filter((summary) => summary.delivered.length || summary.failed.length)
    .map((summary) => summary.deductionId);
  result.consequenceSummaries = summaries;
  if (result.evidenceIds.length && !result.source)
    result.source = "deduction-consequence";
  if (summaries.some((summary) => summary.failed.length))
    ui.notifications?.warn?.(
      t(
        "MP.OutcomesNeedRetry",
        "Some consequences could not be delivered. Open the deduction rule to retry them.",
      ),
    );
  return result;
}

async function retryDeductionConsequences(
  boardId,
  ruleId,
  consequenceId = "",
  { includeFailed = true, notify = false } = {},
) {
  if (!game.user.isGM) return false;
  const summaries = await deliverRevealedConsequences(boardId, [ruleId], {
      consequenceId: String(consequenceId || ""),
      includeFailed,
    }),
    summary = summaries?.[0];
  if (!summary) return false;
  const delivered = summary.delivered.length > 0,
    result = {
      revealedIds: [],
      outcomeRuleIds: delivered ? [ruleId] : [],
      evidenceIds: summary.evidenceIds,
      source: "deduction-consequence",
    };
  if (delivered || summary.evidenceIds.length)
    publishDeductionUpdate(boardId, result);
  else if (S.editor && S.board === boardId) renderDeductionPanel();
  if (notify) {
    if (summary.failed.length)
      ui.notifications?.warn?.(
        t("MP.OutcomeRetryFailed", "The consequence is still unavailable."),
      );
    else if (delivered)
      ui.notifications?.info?.(
        t("MP.OutcomeDelivered", "The consequence was delivered."),
      );
  }
  return clone(summary);
}

async function resumePendingConsequences() {
  if (!isPrimaryGM()) return false;
  const project = normalizeProject(game.settings.get(MOD, "project"));
  for (const board of project.boards) {
    const ruleIds = board.deductions
      .filter(
        (rule) =>
          rule.revealed &&
          rule.consequences.some((consequence) => consequence.status === "pending"),
      )
      .map((rule) => rule.id);
    if (!ruleIds.length) continue;
    const summaries = await deliverRevealedConsequences(board.id, ruleIds, {
      includeFailed: false,
    });
    if (!summaries) continue;
    const deliveredRules = summaries
        .filter((summary) => summary.delivered.length)
        .map((summary) => summary.deductionId),
      evidenceIds = summaries.flatMap((summary) => summary.evidenceIds);
    if (deliveredRules.length || evidenceIds.length)
      publishDeductionUpdate(board.id, {
        revealedIds: [],
        outcomeRuleIds: deliveredRules,
        evidenceIds,
        source: "deduction-resume",
      });
  }
  return true;
}

function consequenceDefinitionsMatch(target, source) {
  if (target.type !== source.type) return false;
  if (target.type === "evidence") return target.evidenceId === source.evidenceId;
  if (target.type === "city")
    return (
      target.pointId === source.pointId &&
      (!target.cityId || target.cityId === source.cityId) &&
      (!target.screenId || target.screenId === source.screenId) &&
      (!target.label || target.label === source.label)
    );
  if (target.type === "dialogue")
    return (
      target.variableId === source.variableId &&
      target.operation === source.operation &&
      target.value === source.value &&
      (!target.label || target.label === source.label)
    );
  if (target.type === "chronicle")
    return (
      target.timelineId === source.timelineId &&
      (!target.label || target.label === source.label)
    );
  return target.title === source.title && target.body === source.body;
}

function mergeConsequenceRuntime(target, source) {
  if (!consequenceDefinitionsMatch(target, source)) {
    resetConsequenceDelivery(target);
    return;
  }
  [
    "status",
    "attempts",
    "preparedValue",
    "deliveredAt",
    "lastAttemptAt",
    "lastError",
  ].forEach((field) => {
    target[field] = source[field];
  });
  if (source.type === "city") {
    target.cityId = source.cityId;
    target.screenId = source.screenId;
    target.pointId = source.pointId;
  }
  if (!target.label && source.label) target.label = source.label;
}

function mirrorCollaborativeBoard(source, result = {}) {
  const target = S.draft?.boards.find((board) => board.id === source.id);
  if (!target || source.deductionRevision < target.deductionRevision) return;
  target.playerLinks = clone(source.playerLinks);
  target.deductionRevision = source.deductionRevision;
  const sourceRules = new Map(source.deductions.map((rule) => [rule.id, rule]));
  target.deductions.forEach((rule) => {
    const current = sourceRules.get(rule.id);
    if (!current) return;
    rule.revealed = current.revealed;
    rule.revealedAt = current.revealedAt;
    rule.revealedBy = current.revealedBy;
    rule.unlockApplied = current.unlockApplied;
    const currentConsequences = new Map(
      current.consequences.map((consequence) => [consequence.id, consequence]),
    );
    rule.consequences.forEach((consequence) => {
      const runtime = currentConsequences.get(consequence.id);
      if (!runtime) return;
      mergeConsequenceRuntime(consequence, runtime);
    });
  });
  const visibilityIds = new Set([
    ...(Array.isArray(result.evidenceIds) ? result.evidenceIds : []),
    ...(Array.isArray(result.visibilityIds) ? result.visibilityIds : []),
  ]);
  (Array.isArray(result.revealedIds) ? result.revealedIds : []).forEach((id) => {
    const reward = sourceRules.get(id)?.rewardNodeId;
    if (reward) visibilityIds.add(reward);
  });
  const visibility = new Map(source.nodes.map((node) => [node.id, node.revealed]));
  target.nodes.forEach((node) => {
    if (visibilityIds.has(node.id) && visibility.has(node.id))
      node.revealed = visibility.get(node.id);
  });
}

function applyCachedCollaboration(target, source) {
  if (!source || source.deductionRevision < target.deductionRevision) return;
  target.playerLinks = clone(source.playerLinks);
  target.deductionRevision = source.deductionRevision;
  const rules = new Map(source.deductions.map((rule) => [rule.id, rule]));
  target.deductions.forEach((rule) => {
    const cached = rules.get(rule.id);
    if (!cached) return;
    rule.revealed = cached.revealed;
    rule.revealedAt = cached.revealedAt;
    rule.revealedBy = cached.revealedBy;
    rule.unlockApplied = cached.unlockApplied;
    const cachedConsequences = new Map(
      cached.consequences.map((consequence) => [consequence.id, consequence]),
    );
    rule.consequences.forEach((consequence) => {
      const runtime = cachedConsequences.get(consequence.id);
      if (!runtime) return;
      mergeConsequenceRuntime(consequence, runtime);
    });
  });
  const visibility = new Map(source.nodes.map((node) => [node.id, node.revealed]));
  target.nodes.forEach((node) => {
    if (visibility.has(node.id)) node.revealed = visibility.get(node.id);
  });
}

function rememberEvent(set, id, limit = 200) {
  if (!id || set.has(id)) return false;
  set.add(id);
  if (set.size > limit) set.delete(set.values().next().value);
  return true;
}

function isPrimaryGM() {
  if (!game.user.isGM) return false;
  const users = Array.from(game.users?.contents || game.users?.values?.() || []),
    active = users
      .filter((user) => user?.isGM && user.active !== false)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return !active.length || active[0].id === game.user.id;
}

function enqueueBoardMutation(boardId, operation) {
  if (!game.user.isGM) return Promise.resolve(false);
  const preview = normalizeProject(game.settings.get(MOD, "project")),
    previewBoard = preview.boards.find((board) => board.id === boardId);
  if (!previewBoard) return Promise.resolve(false);
  applyCachedCollaboration(previewBoard, S.collaborationBoards.get(boardId));
  const previewResult = operation(previewBoard);
  if (!previewResult?.changed) return Promise.resolve(false);
  S.collaborationBoards.set(boardId, clone(previewBoard));
  mirrorCollaborativeBoard(previewBoard, previewResult);
  const write = async () => {
    try {
      const project = normalizeProject(game.settings.get(MOD, "project")),
        board = project.boards.find((candidate) => candidate.id === boardId);
      if (!board) return false;
      const result = operation(board);
      if (!result?.changed) return false;
      S.collaborationBoards.set(boardId, clone(board));
      mirrorCollaborativeBoard(board, result);
      await game.settings.set(MOD, "project", project);
      return { project, board, ...result };
    } catch (error) {
      reportError("deduction update failed", error);
      return false;
    }
  };
  S.saveChain = S.saveChain.then(write, write);
  return S.saveChain;
}

function updateOpenDeductionView(
  boardId,
  revealedIds = [],
  resetIds = [],
  {
    linkChanged = false,
    evidenceIds = [],
    outcomeRuleIds = [],
    source = "",
  } = {},
) {
  const project = normalizeProject(game.settings.get(MOD, "project")),
    board = project.boards.find((candidate) => candidate.id === boardId);
  if (!board) return;
  S.collaborationBoards.set(board.id, clone(board));
  const rules = revealedIds
      .map((id) => board.deductions.find((rule) => rule.id === id))
      .filter((rule) => rule?.revealed),
    resetRules = resetIds
      .map((id) => board.deductions.find((rule) => rule.id === id))
      .filter(Boolean),
    outcomeRules = outcomeRuleIds
      .filter((id) => !revealedIds.includes(id))
      .map((id) => board.deductions.find((rule) => rule.id === id))
      .filter((rule) => rule?.revealed);
  if (S.viewer && S.board === boardId) {
    const camera = S.canvas?.getState?.() || null;
    openViewer(boardId, false, camera);
    queueDeductionReveals(S.viewer, [...rules, ...outcomeRules]);
  }
  if (S.editor && S.board === boardId) renderEditor();
  if (linkChanged)
    Hooks.callAll("mindPalace.playerLinksChanged", {
      boardId,
      links: clone(board.playerLinks),
    });
  rules.forEach((rule) =>
    Hooks.callAll("mindPalace.deductionRevealed", {
      boardId,
      deduction: deductionView(board, rule, false),
    }),
  );
  resetRules.forEach((rule) =>
    Hooks.callAll("mindPalace.deductionReset", {
      boardId,
      deduction: deductionView(board, rule, false),
    }),
  );
  outcomeRules.forEach((rule) =>
    Hooks.callAll("mindPalace.deductionOutcomes", {
      boardId,
      deduction: deductionView(board, rule, false),
    }),
  );
  evidenceIds.forEach((nodeId) => {
    const node = board.nodes.find(
      (candidate) => candidate.id === nodeId && candidate.revealed,
    );
    if (node)
      Hooks.callAll("mindPalace.evidenceRevealed", {
        boardId,
        node: clone(node),
        source,
      });
  });
}

function publishDeductionUpdate(boardId, result, resetIds = []) {
  if (!result) return false;
  const eventId = uid(),
    revealedIds = Array.isArray(result.revealedIds) ? result.revealedIds : [],
    evidenceIds = Array.isArray(result.evidenceIds) ? result.evidenceIds : [],
    outcomeRuleIds = Array.isArray(result.outcomeRuleIds)
      ? result.outcomeRuleIds
      : [],
    source = String(result.source || "").slice(0, 160),
    linkChanged = result.linkChanged === true;
  rememberEvent(S.socketEvents, eventId);
  game.socket.emit(`module.${MOD}`, {
    type: "deduction-update",
    eventId,
    boardId,
    revealedIds,
    resetIds,
    evidenceIds,
    outcomeRuleIds,
    source,
    linkChanged,
    userId: game.user.id,
  });
  updateOpenDeductionView(boardId, revealedIds, resetIds, {
    evidenceIds,
    outcomeRuleIds,
    source,
    linkChanged,
  });
  return true;
}

async function applyPlayerLink(boardId, from, to, userId) {
  const linkId = uid(),
    timestamp = new Date().toISOString(),
    key = edgeKey(from, to),
    result = await enqueueBoardMutation(boardId, (board) => {
      const nodes = new Map(board.nodes.map((node) => [node.id, node])),
        left = nodes.get(from),
        right = nodes.get(to);
      if (!left?.revealed || !right?.revealed || from === to)
        return { changed: false };
      const existing = board.playerLinks.findIndex(
        (link) => edgeKey(link.from, link.to) === key,
      );
      if (existing >= 0) board.playerLinks.splice(existing, 1);
      else {
        if (board.playerLinks.length >= MAX_PLAYER_LINKS)
          return { changed: false };
        board.playerLinks.push({
          id: linkId,
          from,
          to,
          createdBy: String(userId || ""),
          createdAt: timestamp,
        });
      }
      board.deductionRevision += 1;
      return {
        changed: true,
        linkChanged: true,
        revealedIds: revealReadyDeductions(board, userId),
      };
    });
  if (!result) return false;
  await settleRevealedConsequences(boardId, result);
  return publishDeductionUpdate(boardId, result);
}

async function requestPlayerLink(boardId, from, to) {
  if (!from || !to || from === to) return false;
  if (game.user.isGM) return applyPlayerLink(boardId, from, to, game.user.id);
  const requestId = uid();
  game.socket.emit(`module.${MOD}`, {
    type: "player-link-request",
    requestId,
    boardId,
    from,
    to,
    userId: game.user.id,
  });
  ui.notifications.info(
    t("MP.LinkSubmitted", "The connection was sent to the Game Master."),
  );
  return true;
}
function pathFor(link, board) {
  const a = board.nodes.find((n) => n.id === link.from),
    b = board.nodes.find((n) => n.id === link.to);
  if (!a || !b) return "";
  const x1 = a.x + a.w / 2,
    y1 = a.y + a.h / 2,
    x2 = b.x + b.w / 2,
    y2 = b.y + b.h / 2,
    bend =
      ((link.id.charCodeAt(0) || 1) % 2 ? 1 : -1) *
      Math.min(9, Math.hypot(x2 - x1, y2 - y1) * 0.12);
  return `M ${x1} ${y1} Q ${(x1 + x2) / 2 - bend * 0.25} ${(y1 + y2) / 2 + bend} ${x2} ${y2}`;
}
function visibleLinks(board, player) {
  const ids = new Set(
    board.nodes.filter((n) => !player || n.revealed).map((n) => n.id),
  );
  return board.links.filter((l) => ids.has(l.from) && ids.has(l.to));
}
function visiblePlayerLinks(board, player) {
  const ids = new Set(
    board.nodes.filter((node) => !player || node.revealed).map((node) => node.id),
  );
  return board.playerLinks.filter(
    (link) => ids.has(link.from) && ids.has(link.to),
  );
}
function linksHTML(board, player = false) {
  return `<svg class="mp-links" viewBox="0 0 100 100" preserveAspectRatio="none">${visibleLinks(
    board,
    player,
  )
    .map(
      (l) =>
        `<g data-link="${l.id}"><path class="shadow" d="${pathFor(l, board)}"></path><path d="${pathFor(l, board)}" stroke="${safeColor(l.color)}" stroke-dasharray="${l.style === "dashed" ? "1.4 1.1" : "none"}"></path></g>`,
    )
    .join("")}${visiblePlayerLinks(board, player)
    .map(
      (link) =>
        `<g class="mp-player-link" data-player-link="${link.id}"><path class="shadow" d="${pathFor(link, board)}"></path><path d="${pathFor(link, board)}"></path></g>`,
    )
    .join("")}</svg>`;
}
function linkLabelsHTML(board, player = false) {
  return visibleLinks(board, player)
    .filter((l) => l.label)
    .map((l) => {
      const a = board.nodes.find((n) => n.id === l.from),
        b = board.nodes.find((n) => n.id === l.to),
        x = (a.x + a.w / 2 + (b.x + b.w / 2)) / 2,
        y = (a.y + a.h / 2 + (b.y + b.h / 2)) / 2;
      return `<span class="mp-link-label-chip" data-label-link="${l.id}" style="--lx:${x};--ly:${y};--lc:${safeColor(l.color)}">${esc(l.label)}</span>`;
    })
    .join("");
}
function nodeHTML(node, editor = false) {
  const interaction = editor
    ? ""
    : ` role="button" tabindex="0" aria-label="${esc(node.title)}"`;
  const placement = editor
    ? `left:0;top:0;width:${Math.max(150, (node.w / 100) * EDITOR_WIDTH)}px;height:${Math.max(90, (node.h / 100) * EDITOR_HEIGHT)}px;transform:translate3d(${(node.x / 100) * EDITOR_WIDTH}px,${(node.y / 100) * EDITOR_HEIGHT}px,0) rotate(${node.rotation}deg);--x:${node.x};--y:${node.y};--w:${node.w};--h:${node.h};--r:${node.rotation}`
    : `--x:${node.x};--y:${node.y};--w:${node.w};--h:${node.h};--r:${node.rotation}`;
  if (node.type === "text")
    return `<article class="mp-node type-text ${editor ? "is-editor" : ""} ${S.selected === node.id ? "selected" : ""}" data-node="${node.id}"${interaction} style="${placement}"><div class="mp-text-copy"><h3>${esc(node.title)}</h3>${node.body || node.caption ? `<p>${esc(node.body || node.caption)}</p>` : ""}</div>${editor && !node.revealed ? '<i class="fas fa-eye-slash mp-secret"></i>' : ""}</article>`;
  const icon =
    node.type === "person"
      ? "fa-user-secret"
      : node.type === "document"
        ? "fa-file-lines"
        : node.type === "clue"
          ? "fa-magnifying-glass"
          : "fa-lightbulb";
  return `<article class="mp-node type-${node.type} ${editor ? "is-editor" : ""} ${S.selected === node.id ? "selected" : ""} ${S.connectFrom === node.id ? "connect-source" : ""}" data-node="${node.id}"${interaction} style="${placement}">${node.image ? `<div class="mp-node-image" style="background-image:url('${esc(cssUrl(node.image))}')"></div>` : `<div class="mp-paper-copy"><i class="fas ${icon}"></i><small>${esc(t(`MP.Type.${node.type}`, node.type))}</small><h3>${esc(node.title)}</h3><p>${esc(node.caption || node.body)}</p></div>`}${node.image ? `<div class="mp-node-copy"><small>${esc(t(`MP.Type.${node.type}`, node.type))}</small><h3>${esc(node.title)}</h3><p>${esc(node.caption)}</p></div>` : ""}${editor && !node.revealed ? '<i class="fas fa-eye-slash mp-secret"></i>' : ""}</article>`;
}
function boardHTML(board, editor = false) {
  return `<div class="mp-board ${editor ? "editor-board" : "player-board"}" data-board="${board.id}">${linksHTML(board, !editor)}<div class="mp-link-labels">${linkLabelsHTML(board, !editor)}</div>${board.nodes
    .filter((n) => editor || n.revealed)
    .map((n) => nodeHTML(n, editor))
    .join("")}</div>`;
}

async function closeEditor({ saveDraft = true } = {}) {
  clearTimeout(S.timer);
  S.timer = null;
  const pending = saveDraft && S.draft && S.editor ? save(false) : null;
  S.canvas?.destroy?.();
  S.canvas = null;
  S.canvasBoard = null;
  cancelAnimationFrame(S.geometryFrame);
  S.geometryFrame = 0;
  S.geometryNodes.clear();
  S.editor?.remove();
  S.editor = null;
  S.draft = null;
  S.undo.length = 0;
  S.redo.length = 0;
  S.inputSnapshot = null;
  S.inputSnapshotArmed = false;
  S.deductionPanel = false;
  S.selectedDeduction = null;
  if (pending) await pending;
}
function closeViewer({ clearWorld = false } = {}) {
  document.body.classList.remove("mp-chat-open");
  clearTimeout(S.layoutTimer);
  clearTimeout(S.noteTimer);
  S.layoutTimer = 0;
  S.noteTimer = 0;
  void flushPersonalLayouts();
  void flushPersonalNotes();
  cancelAnimationFrame(S.parallaxFrame);
  S.parallaxFrame = 0;
  S.parallax = null;
  S.viewerConnecting = false;
  S.viewerConnectFrom = null;
  S.revealQueue.length = 0;
  S.revealActive = false;
  S.pendingChronicle = "";
  S.canvas?.destroy?.();
  S.canvas = null;
  S.canvasBoard = null;
  S.viewer?.remove();
  S.viewer = null;
  // Closing the full-screen board as GM is an explicit stop command. Clear the
  // shared flag so it cannot reopen on the next reload and cover Foundry UI.
  if (clearWorld && game.user?.isGM && game.settings?.get?.(MOD, "visible")) {
    void game.settings.set(MOD, "visible", false).catch((error) =>
      console.error(`${MOD} | could not clear shared visibility`, error));
  }
}

function personalLayout(boardId) {
  const layouts = game.settings.get(MOD, "personalLayouts") || {};
  return clone(S.pendingLayouts.get(boardId) || layouts[boardId] || {});
}
async function savePersonalLayout(boardId, layout) {
  S.pendingLayouts.set(boardId, clone(layout));
  return flushPersonalLayouts();
}
function flushPersonalLayouts() {
  clearTimeout(S.layoutTimer);
  S.layoutTimer = 0;
  if (!S.pendingLayouts.size) return S.personalChain;
  const entries = [...S.pendingLayouts.entries()];
  const write = async () => {
    try {
      const layouts = clone(game.settings.get(MOD, "personalLayouts") || {});
      entries.forEach(([boardId, layout]) => {
        layouts[boardId] = clone(layout);
      });
      await game.settings.set(MOD, "personalLayouts", layouts);
      entries.forEach(([boardId, layout]) => {
        if (S.pendingLayouts.get(boardId) === layout)
          S.pendingLayouts.delete(boardId);
      });
      return true;
    } catch (error) {
      reportError("personal layout save failed", error);
      return false;
    }
  };
  S.personalChain = S.personalChain.then(write, write);
  return S.personalChain;
}
function schedulePersonalLayout(boardId, layout) {
  S.pendingLayouts.set(boardId, clone(layout));
  clearTimeout(S.layoutTimer);
  S.layoutTimer = setTimeout(() => void flushPersonalLayouts(), 250);
}
function syncDroppedPosition(element, x, y) {
  element.classList.add("mp-drop-sync");
  element.style.setProperty("--x", x);
  element.style.setProperty("--y", y);
  element.style.translate = "";
  requestAnimationFrame(() =>
    requestAnimationFrame(() => element.classList.remove("mp-drop-sync")),
  );
}

async function openCharacterSheet() {
  const actor = game.user.character;
  if (!actor)
    return ui.notifications.warn(
      t("MP.NoCharacter", "No character is assigned to this user."),
    );
  const sheet = actor.sheet;
  if (!sheet?.render)
    return ui.notifications.warn(
      t("MP.SheetUnavailable", "The character sheet is unavailable."),
    );
  try {
    await sheet.render({ force: true });
  } catch {
    await sheet.render(true);
  }
  requestAnimationFrame(() => {
    const element = sheet?.element?.[0] || sheet?.element;
    element?.classList?.add("mp-elevated-sheet");
    if (element?.style) element.style.zIndex = "13050";
  });
}
function toggleChat(button) {
  const open = document.body.classList.toggle("mp-chat-open");
  button?.classList.toggle("active", open);
  button?.setAttribute("aria-pressed", String(open));
  if (open) {
    if (typeof ui.sidebar?.changeTab === "function")
      ui.sidebar.changeTab("chat", "primary");
    else ui.sidebar?.activateTab?.("chat");
  }
}

function openEditor() {
  if (!game.user.isGM) return;
  if (S.editor?.isConnected) {
    S.editor.querySelector(".mp-editor-frame")?.focus();
    return;
  }
  closeViewer();
  S.draft = normalizeProject(game.settings.get(MOD, "project"));
  S.collaborationBoards.clear();
  S.draft.boards.forEach((board) =>
    S.collaborationBoards.set(board.id, clone(board)),
  );
  S.board = S.draft.activeBoard;
  S.selected = null;
  S.connecting = false;
  S.connectFrom = null;
  S.deductionPanel = false;
  S.selectedDeduction = null;
  S.undo.length = 0;
  S.redo.length = 0;
  const el = document.createElement("section");
  el.id = "mp-editor";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", t("MP.Editor", "Case editor"));
  el.innerHTML = `<header><div class="mp-brand"><i class="fas fa-brain"></i><div><strong>${t("MP.Title", "Mind Palace")}</strong><small>${t("MP.Editor", "Case editor")}</small></div></div><nav><button class="icon" data-act="undo" aria-label="${esc(t("MP.Undo", "Undo"))}" title="${esc(t("MP.UndoHint", "Undo · Ctrl+Z"))}" disabled><i class="fas fa-rotate-left"></i></button><button class="icon" data-act="redo" aria-label="${esc(t("MP.Redo", "Redo"))}" title="${esc(t("MP.RedoHint", "Redo · Ctrl+Shift+Z"))}" disabled><i class="fas fa-rotate-right"></i></button><button class="icon" data-act="export" aria-label="${esc(t("MP.Export", "Export"))}" title="${esc(t("MP.Export", "Export"))}"><i class="fas fa-file-export"></i></button><button class="icon" data-act="import" aria-label="${esc(t("MP.Import", "Import"))}" title="${esc(t("MP.Import", "Import"))}"><i class="fas fa-file-import"></i></button><button data-act="copy-uuid" title="UUID"><i class="fas fa-link"></i>UUID</button><button data-act="person"><i class="fas fa-user-secret"></i>${t("MP.AddPerson", "Person")}</button><button data-act="document"><i class="fas fa-file-lines"></i>${t("MP.AddDocument", "Document")}</button><button data-act="clue"><i class="fas fa-magnifying-glass"></i>${t("MP.AddClue", "Evidence")}</button><button data-act="note"><i class="fas fa-lightbulb"></i>${t("MP.AddNote", "Note")}</button><button data-act="text"><i class="fas fa-font"></i>${t("MP.AddText", "Text")}</button><button data-act="connect"><i class="fas fa-link"></i>${t("MP.Connect", "Connect thoughts")}</button><button data-act="deductions"><i class="fas fa-lightbulb"></i>${t("MP.Deductions", "Deductions")}</button><button data-act="preview"><i class="fas fa-play"></i>${t("MP.Preview", "Preview")}</button><button class="accent" data-act="show"><i class="fas fa-users-viewfinder"></i>${t("MP.Show", "Open for everyone")}</button><button data-act="save"><i class="fas fa-floppy-disk"></i>${t("MP.Save", "Save")}</button><button class="icon" data-act="close" aria-label="${esc(t("MP.Close", "Close"))}"><i class="fas fa-xmark"></i></button></nav></header><div class="mp-editor-layout"><aside class="mp-board-list"></aside><main><div class="mp-editor-stage"></div><footer>${t("MP.ZoomHint", "Drag the background to move · mouse wheel to zoom")}</footer></main><aside class="mp-properties"></aside></div>`;
  document.body.append(el);
  S.editor = el;
  bindEditor(el);
  renderEditor();
  updateHistoryButtons();
}
function renderEditor() {
  if (!S.editor) return;
  const board = activeBoard(),
    node = activeNode();
  S.editor.classList.toggle("is-connecting", S.connecting);
  S.editor
    .querySelector('[data-act="connect"]')
    .classList.toggle("active", S.connecting);
  S.editor.querySelector(".mp-board-list").innerHTML =
    `<div class="mp-side-title"><h2>${t("MP.Boards", "Investigations")}</h2><button data-act="newboard"><i class="fas fa-plus"></i></button></div><div class="mp-board-buttons">${S.draft.boards.map((b) => `<button class="${b.id === S.board ? "active" : ""}" data-board-select="${b.id}"><i class="fas fa-folder-open"></i><span>${esc(b.title)}</span><small>${b.nodes.length}</small></button>`).join("")}</div><button class="mp-template" data-act="template"><i class="fas fa-file-circle-plus"></i>${t("MP.Template", "Create example case")}</button><button class="mp-delete-board" data-act="deleteboard"><i class="fas fa-trash"></i>${t("MP.DeleteBoard", "Delete investigation")}</button>`;
  S.editor.querySelector(".mp-editor-stage").innerHTML =
    `<div class="mp-editor-frame">${boardHTML(board, true)}${S.connecting ? `<div class="mp-connect-toast"><i class="fas fa-link"></i>${t("MP.ConnectHint", "Select two cards to connect them")}</div>` : ""}</div>`;
  S.editor.querySelector(".mp-properties").innerHTML = node
    ? nodeProperties(node, board)
    : boardProperties(board);
  S.editor.querySelector('[data-act="deductions"]')?.classList.toggle(
    "active",
    S.deductionPanel,
  );
  S.editor.querySelector(".mp-deduction-panel")?.remove();
  if (S.deductionPanel)
    S.editor.insertAdjacentHTML("beforeend", deductionPanelHTML(board));
  mountEditorCanvas();
  updateHistoryButtons();
}

function refreshEditorSelection() {
  if (!S.editor) return;
  const board = activeBoard(),
    node = activeNode();
  S.editor.classList.toggle("is-connecting", S.connecting);
  S.editor
    .querySelector('[data-act="connect"]')
    ?.classList.toggle("active", S.connecting);
  S.editor.querySelectorAll("[data-node]").forEach((element) => {
    element.classList.toggle("selected", element.dataset.node === S.selected);
    element.classList.toggle(
      "connect-source",
      element.dataset.node === S.connectFrom,
    );
  });
  S.canvas?.select?.(S.selected || []);
  S.editor.querySelector(".mp-properties").innerHTML = node
    ? nodeProperties(node, board)
    : boardProperties(board);
  const frame = S.editor.querySelector(".mp-editor-frame"),
    toast = frame?.querySelector(".mp-connect-toast");
  if (S.connecting && !toast)
    frame?.insertAdjacentHTML(
      "beforeend",
      `<div class="mp-connect-toast"><i class="fas fa-link"></i>${t("MP.ConnectHint", "Select two cards to connect them")}</div>`,
    );
  if (!S.connecting) toast?.remove();
  updateHistoryButtons();
}

function canvasApi() {
  const api = game.modules.get("unicanvas")?.api;
  if (!api)
    throw new Error("Mind Palace requires the active UniCanvas module.");
  return api;
}
function mountEditorCanvas() {
  if (S.canvas && S.canvasBoard)
    S.cameras.set(S.canvasBoard, S.canvas.getState());
  S.canvas?.destroy?.();
  const viewport = S.editor?.querySelector(".mp-editor-frame"),
    world = viewport?.querySelector(".mp-board"),
    board = activeBoard();
  if (!viewport || !world) return;
  const remembered = S.cameras.get(board.id),
    W = EDITOR_WIDTH,
    H = EDITOR_HEIGHT;
  S.canvas = canvasApi().create({
    viewport,
    world,
    width: W,
    height: H,
    minScale: 0.16,
    maxScale: 2,
    padding: 70,
    infinite: true,
    controls: false,
    initialState: remembered || undefined,
  });
  S.canvasBoard = board.id;
  world.querySelectorAll("[data-node]").forEach((element) => {
    const node = board.nodes.find((item) => item.id === element.dataset.node);
    if (!node) return;
    const place = () => {
      element.style.left = "0";
      element.style.top = "0";
      element.style.width = `${Math.max(150, (node.w / 100) * W)}px`;
      element.style.height = `${Math.max(90, (node.h / 100) * H)}px`;
      element.style.transform = `translate3d(${(node.x / 100) * W}px, ${(node.y / 100) * H}px, 0) rotate(${node.rotation}deg)`;
    };
    place();
    element.dataset.ucId = node.id;
    let beforeDrag = null,
      startPosition = null;
    S.canvas.makeDraggable(element, {
      disabled: () => S.connecting,
      get: () => {
        beforeDrag = clone(S.draft);
        startPosition = { x: node.x, y: node.y };
        return { x: (node.x / 100) * W, y: (node.y / 100) * H };
      },
      set: (position) => {
        node.x = (position.x / W) * 100;
        node.y = (position.y / H) * 100;
        element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) rotate(${node.rotation}deg)`;
      },
      onMove: () => scheduleGeometry(node.id),
      onEnd: () => {
        updateGeometry(node.id);
        if (
          startPosition &&
          (startPosition.x !== node.x || startPosition.y !== node.y)
        ) {
          remember(beforeDrag);
          autosave();
        }
      },
    });
  });
  if (S.selected) S.canvas.select(S.selected);
}
function boardProperties(board) {
  return `<div class="mp-panel-head"><h2>${t("MP.Investigation", "Investigation")}</h2></div><label>${t("MP.BoardTitle", "Investigation title")}<input data-board-prop="title" value="${esc(board.title)}"></label><label>${t("MP.Subtitle", "Subtitle")}<textarea data-board-prop="subtitle">${esc(board.subtitle)}</textarea></label><div class="mp-empty-select"><p>${t("MP.NoSelection", "Select a card to edit it")}</p></div>`;
}
function nodeProperties(node, board) {
  const links = board.links.filter(
    (l) => l.from === node.id || l.to === node.id,
  );
  return `<div class="mp-panel-head"><small>${t(`MP.Type.${node.type}`, node.type)}</small><h2>${esc(node.title)}</h2></div><label>${t("MP.Name", "Name")}<input data-node-prop="title" value="${esc(node.title)}"></label><label>${t("MP.Caption", "Caption")}<input data-node-prop="caption" value="${esc(node.caption)}"></label><label>${t("MP.Description", "Description")}<textarea class="large" data-node-prop="body">${esc(node.body)}</textarea></label>${node.type !== "text" ? `<label>${t("MP.Image", "Portrait or image")}<div class="mp-file"><input data-node-prop="image" value="${esc(node.image)}"><button data-act="browse"><i class="fas fa-folder-open"></i></button></div></label>` : ""}<label class="mp-switch"><input type="checkbox" data-node-prop="revealed" ${node.revealed ? "checked" : ""}><span></span>${t("MP.Revealed", "Visible to players")}</label><div class="mp-relation-head"><h3>${t("MP.Relations", "Thought connections")}</h3><button data-act="connect"><i class="fas fa-plus"></i></button></div><div class="mp-relations">${
    links.length
      ? links
          .map((l) => {
            const other = board.nodes.find(
              (n) => n.id === (l.from === node.id ? l.to : l.from),
            );
            return `<div><i class="fas fa-link"></i><span>${esc(other?.title || "")}</span><input class="mp-link-label" data-link-label="${l.id}" value="${esc(l.label)}" placeholder="${esc(t("MP.RelationLabel", "Connection label"))}"><input type="color" data-link-color="${l.id}" value="${safeColor(l.color)}"><button data-remove-link="${l.id}" aria-label="${esc(t("MP.Delete", "Delete"))}"><i class="fas fa-xmark"></i></button></div>`;
          })
          .join("")
      : `<p>${t("MP.ConnectHint", "Select two cards to connect them")}</p>`
  }</div><div class="mp-danger-row"><button data-act="duplicate"><i class="fas fa-copy"></i>${t("MP.Duplicate", "Duplicate")}</button><button class="danger" data-act="deletenode"><i class="fas fa-trash"></i>${t("MP.Delete", "Delete")}</button></div>`;
}

function selectedDeduction(board = activeBoard()) {
  return board?.deductions.find((rule) => rule.id === S.selectedDeduction) || null;
}

function deductionLinkChoices(board, rule) {
  const choices = new Map();
  [...board.links, ...rule.requiredLinks].forEach((link) => {
    if (!board.nodes.some((node) => node.id === link.from)) return;
    if (!board.nodes.some((node) => node.id === link.to)) return;
    choices.set(edgeKey(link.from, link.to), { from: link.from, to: link.to });
  });
  return [...choices.values()];
}

function consequenceTypeMeta(type) {
  return {
    evidence: {
      icon: "fa-eye",
      label: t("MP.OutcomeEvidence", "Reveal card"),
    },
    city: {
      icon: "fa-map-location-dot",
      label: t("MP.OutcomeCity", "Reveal City point"),
    },
    dialogue: {
      icon: "fa-comments",
      label: t("MP.OutcomeDialogue", "Change story variable"),
    },
    chronicle: {
      icon: "fa-clock-rotate-left",
      label: t("MP.OutcomeChronicle", "Open timeline"),
    },
    narrative: {
      icon: "fa-clapperboard",
      label: t("MP.OutcomeNarrative", "Story text"),
    },
  }[type];
}

function consequenceStatusText(consequence) {
  return consequence.status === "delivered"
    ? t("MP.OutcomeStatusDelivered", "Delivered")
    : consequence.status === "failed"
      ? t("MP.OutcomeStatusFailed", "Not delivered")
      : t("MP.OutcomeStatusPending", "Waiting");
}

function consequenceErrorText(code) {
  return {
    "module-unavailable": t(
      "MP.OutcomeErrorModule",
      "The connected module is not active.",
    ),
    "reference-missing": t(
      "MP.OutcomeErrorReference",
      "Choose an available target again.",
    ),
    "delivery-rejected": t(
      "MP.OutcomeErrorRejected",
      "The connected module rejected this change.",
    ),
    "delivery-error": t(
      "MP.OutcomeErrorDelivery",
      "Delivery failed. It is safe to retry.",
    ),
  }[code] || "";
}

function consequenceEditorHTML(board, rule, consequence) {
  const meta = consequenceTypeMeta(consequence.type),
    canDeliver = rule.revealed && consequence.status !== "delivered";
  let fields = "";
  if (consequence.type === "evidence") {
    fields = `<label>${t("MP.OutcomeTargetCard", "Card")}<select data-consequence-evidence><option value="">${t("MP.SelectTarget", "Choose a target")}</option>${board.nodes
      .map(
        (node) =>
          `<option value="${node.id}" ${node.id === consequence.evidenceId ? "selected" : ""}>${esc(node.title)}</option>`,
      )
      .join("")}</select></label>`;
  } else if (consequence.type === "city") {
    const points = cityPointCatalog(),
      selectedIndex = points.findIndex(
        (point) =>
          point.cityId === consequence.cityId &&
          point.screenId === consequence.screenId &&
          point.pointId === consequence.pointId,
      ),
      unavailable = selectedIndex < 0 && consequence.pointId;
    fields = `<label>${t("MP.OutcomeTargetPlace", "City point")}<select data-consequence-city><option value="">${unavailable ? t("MP.ReferenceUnavailable", "Previously selected target is unavailable") : t("MP.SelectTarget", "Choose a target")}</option>${points
      .map(
        (point, index) =>
          `<option value="${index}" ${index === selectedIndex ? "selected" : ""}>${esc(point.label)}</option>`,
      )
      .join("")}</select></label><label>${t("MP.PlayerMessage", "Player-facing message")}<input data-consequence-field="label" value="${esc(consequence.label)}" maxlength="160" placeholder="${esc(t("MP.CityPathOpened", "A new place is accessible"))}"></label>`;
  } else if (consequence.type === "dialogue") {
    const variables = dialogueVariableCatalog(),
      available = variables.some((variable) => variable.id === consequence.variableId);
    fields = `<label>${t("MP.OutcomeTargetVariable", "Story variable")}<select data-consequence-dialogue><option value="">${!available && consequence.variableId ? t("MP.ReferenceUnavailable", "Previously selected target is unavailable") : t("MP.SelectTarget", "Choose a target")}</option>${variables
      .map(
        (variable) =>
          `<option value="${esc(variable.id)}" ${variable.id === consequence.variableId ? "selected" : ""}>${esc(variable.label)}</option>`,
      )
      .join("")}</select></label><div class="mp-outcome-operation"><label>${t("MP.Operation", "Operation")}<select data-consequence-operation><option value="set" ${consequence.operation === "set" ? "selected" : ""}>${t("MP.OperationSet", "Set")}</option><option value="add" ${consequence.operation === "add" ? "selected" : ""}>${t("MP.OperationAdd", "Add")}</option></select></label><label>${t("MP.Value", "Value")}<input type="number" step="any" data-consequence-field="value" value="${consequence.value}"></label></div><label>${t("MP.PlayerMessage", "Player-facing message")}<input data-consequence-field="label" value="${esc(consequence.label)}" maxlength="160" placeholder="${esc(t("MP.StoryChanged", "The story has changed"))}"></label>`;
  } else if (consequence.type === "chronicle") {
    const timelines = chronicleTimelineCatalog(),
      available = timelines.some(
        (timeline) => timeline.id === consequence.timelineId,
      );
    fields = `<label>${t("MP.OutcomeTargetTimeline", "Timeline")}<select data-consequence-chronicle><option value="">${!available && consequence.timelineId ? t("MP.ReferenceUnavailable", "Previously selected target is unavailable") : t("MP.SelectTarget", "Choose a target")}</option>${timelines
      .map(
        (timeline) =>
          `<option value="${esc(timeline.id)}" ${timeline.id === consequence.timelineId ? "selected" : ""}>${esc(timeline.label)}</option>`,
      )
      .join("")}</select></label><label>${t("MP.PlayerMessage", "Player-facing message")}<input data-consequence-field="label" value="${esc(consequence.label)}" maxlength="160" placeholder="${esc(t("MP.TimelineOpened", "A timeline has opened"))}"></label>`;
  } else {
    fields = `<label>${t("MP.OutcomeTitle", "Outcome title")}<input data-consequence-field="title" value="${esc(consequence.title)}" maxlength="160"></label><label>${t("MP.OutcomeText", "Text")}<textarea data-consequence-field="body" maxlength="6000">${esc(consequence.body)}</textarea></label>`;
  }
  return `<article class="mp-outcome-card status-${consequence.status}" data-consequence-id="${consequence.id}"><header><span><i class="fas ${meta.icon}"></i><b>${meta.label}</b></span><small>${consequenceStatusText(consequence)}</small><div>${canDeliver ? `<button data-retry-consequence="${consequence.id}" aria-label="${esc(t("MP.DeliverOutcome", "Deliver consequence"))}"><i class="fas fa-rotate"></i></button>` : ""}<button data-remove-consequence="${consequence.id}" aria-label="${esc(t("MP.Delete", "Delete"))}"><i class="fas fa-xmark"></i></button></div></header><div class="mp-outcome-fields">${fields}</div>${consequence.status === "failed" ? `<p class="mp-outcome-error"><i class="fas fa-triangle-exclamation"></i>${esc(consequenceErrorText(consequence.lastError))}</p>` : ""}</article>`;
}

function consequenceSectionHTML(board, rule) {
  return `<section class="mp-outcome-section"><div class="mp-outcome-heading"><div><h4>${t("MP.Consequences", "Consequences")}</h4><p>${t("MP.ConsequencesHelp", "Run several story changes when this deduction is revealed.")}</p></div><span>${rule.consequences.length}/${MAX_CONSEQUENCES}</span></div><div class="mp-outcome-add" role="group" aria-label="${esc(t("MP.AddConsequence", "Add consequence"))}">${["evidence", "city", "dialogue", "chronicle", "narrative"]
    .map((type) => {
      const meta = consequenceTypeMeta(type);
      return `<button data-add-consequence="${type}" ${rule.consequences.length >= MAX_CONSEQUENCES ? "disabled" : ""}><i class="fas ${meta.icon}"></i>${meta.label}</button>`;
    })
    .join("")}</div><div class="mp-outcome-list">${rule.consequences.length ? rule.consequences.map((consequence) => consequenceEditorHTML(board, rule, consequence)).join("") : `<p class="mp-outcome-empty">${t("MP.NoConsequences", "No consequences configured.")}</p>`}</div></section>`;
}

function addConsequence(type) {
  const board = activeBoard(),
    rule = selectedDeduction(board);
  if (!board || !rule || rule.consequences.length >= MAX_CONSEQUENCES) return false;
  const raw = { type };
  if (type === "evidence") {
    raw.evidenceId =
      board.nodes.find((node) => !node.revealed)?.id || board.nodes[0]?.id || "";
  } else if (type === "city") {
    const point = cityPointCatalog()[0];
    if (point) Object.assign(raw, point);
  } else if (type === "dialogue") {
    const variable = dialogueVariableCatalog()[0];
    if (variable) {
      raw.variableId = variable.id;
      raw.label = variable.label;
    }
  } else if (type === "chronicle") {
    const timeline = chronicleTimelineCatalog()[0];
    if (timeline) {
      raw.timelineId = timeline.id;
      raw.label = timeline.label;
    }
  } else {
    raw.title = t("MP.NewOutcome", "New outcome");
    raw.body = "";
  }
  remember();
  rule.consequences.push(
    normalizeConsequence(
      raw,
      new Set(board.nodes.map((node) => node.id)),
      rule.consequences.length,
    ),
  );
  board.deductionRevision += 1;
  renderDeductionPanel();
  autosave();
  return true;
}

function touchConsequence(board, consequence) {
  resetConsequenceDelivery(consequence);
  board.deductionRevision += 1;
}

function deductionPanelHTML(board) {
  if (
    !S.selectedDeduction ||
    !board.deductions.some((rule) => rule.id === S.selectedDeduction)
  )
    S.selectedDeduction = board.deductions[0]?.id || null;
  const rule = selectedDeduction(board),
    list = board.deductions.length
      ? board.deductions
          .map((item) => {
            const progress = deductionProgress(board, item);
            return `<button class="${item.id === rule?.id ? "active" : ""}" data-deduction-select="${item.id}"><span><i class="fas ${item.revealed ? "fa-circle-check" : "fa-circle-nodes"}"></i><b>${esc(item.title)}</b></span><small>${progress.completed}/${progress.total}</small></button>`;
          })
          .join("")
      : `<p class="mp-deduction-empty">${t("MP.NoDeductions", "No deduction rules yet.")}</p>`;
  const editor = !rule
    ? `<div class="mp-deduction-blank"><p>${t("MP.DeductionEmptyHelp", "Add a rule to turn connected evidence into a reveal.")}</p></div>`
    : deductionRuleEditorHTML(board, rule);
  return `<section class="mp-deduction-panel" role="dialog" aria-modal="true" aria-label="${esc(t("MP.Deductions", "Deductions"))}"><header><div><h2>${t("MP.Deductions", "Deductions")}</h2></div><button data-act="close-deductions" aria-label="${esc(t("MP.Close", "Close"))}"><i class="fas fa-xmark"></i></button></header><div class="mp-deduction-layout"><aside><div class="mp-deduction-list">${list}</div><button class="mp-add-deduction" data-act="add-deduction" ${board.deductions.length >= MAX_DEDUCTIONS ? "disabled" : ""}><i class="fas fa-plus"></i>${t("MP.AddDeduction", "Add deduction")}</button></aside><main>${editor}</main></div></section>`;
}

function deductionRuleEditorHTML(board, rule) {
  const progress = deductionProgress(board, rule),
    requiredNodes = new Set(rule.requiredNodes),
    requiredLinks = new Set(
      rule.requiredLinks.map((link) => edgeKey(link.from, link.to)),
    ),
    nodeChoices = board.nodes
      .map(
        (node) =>
          `<label><input type="checkbox" data-deduction-node="${node.id}" ${requiredNodes.has(node.id) ? "checked" : ""}><span><i class="fas ${node.type === "person" ? "fa-user-secret" : node.type === "document" ? "fa-file-lines" : node.type === "clue" ? "fa-magnifying-glass" : "fa-note-sticky"}"></i>${esc(node.title)}</span></label>`,
      )
      .join(""),
    linkChoices = deductionLinkChoices(board, rule)
      .map((link) => {
        const left = board.nodes.find((node) => node.id === link.from),
          right = board.nodes.find((node) => node.id === link.to),
          key = edgeKey(link.from, link.to);
        return `<label><input type="checkbox" data-deduction-link="${esc(key)}" ${requiredLinks.has(key) ? "checked" : ""}><span><i class="fas fa-link"></i>${esc(left?.title || "")} <em>↔</em> ${esc(right?.title || "")}</span></label>`;
      })
      .join(""),
    rewardOptions = [
      `<option value="">${t("MP.NoReward", "No reward card")}</option>`,
      ...board.nodes.map(
        (node) =>
          `<option value="${node.id}" ${rule.rewardNodeId === node.id ? "selected" : ""}>${esc(node.title)}</option>`,
      ),
    ].join("");
  return `<div class="mp-rule-head"><div><small>${rule.revealed ? t("MP.RevealedStatus", "Revealed") : t("MP.HiddenStatus", "Unsolved")}</small><h3>${esc(rule.title)}</h3></div><span>${progress.completed}/${progress.total}</span></div><div class="mp-rule-fields"><label>${t("MP.DeductionName", "Deduction name")}<input data-deduction-prop="title" value="${esc(rule.title)}" maxlength="160"></label><label>${t("MP.DeductionDescription", "Reveal text")}<textarea data-deduction-prop="description" maxlength="6000">${esc(rule.description)}</textarea></label><section><h4>${t("MP.RequiredCards", "Required cards")}</h4><p>${t("MP.RequiredCardsHelp", "These cards must be visible to players.")}</p><div class="mp-rule-checks">${nodeChoices || `<em>${t("MP.NoCards", "Add cards to this investigation first.")}</em>`}</div></section><section><h4>${t("MP.RequiredLinks", "Required connections")}</h4><p>${t("MP.RequiredLinksHelp", "Players must recreate these connections in the board viewer.")}</p><div class="mp-rule-checks">${linkChoices || `<em>${t("MP.NoLinks", "Create card connections on the board first.")}</em>`}</div></section><label>${t("MP.RewardCard", "Card revealed on success")}<select data-deduction-reward>${rewardOptions}</select></label>${consequenceSectionHTML(board, rule)}</div><footer><button class="danger" data-act="delete-deduction"><i class="fas fa-trash"></i>${t("MP.Delete", "Delete")}</button><span></span><button data-act="reset-deduction"><i class="fas fa-rotate-left"></i>${t("MP.ResetDeduction", "Reset")}</button><button class="accent" data-act="reveal-deduction"><i class="fas fa-eye"></i>${t("MP.RevealNow", "Reveal now")}</button></footer>`;
}

function renderDeductionPanel() {
  const current = S.editor?.querySelector(".mp-deduction-panel"),
    board = activeBoard();
  if (!S.editor || !S.deductionPanel || !board) return current?.remove();
  const template = document.createElement("template");
  template.innerHTML = deductionPanelHTML(board);
  const next = template.content.firstElementChild;
  if (current) current.replaceWith(next);
  else S.editor.insertAdjacentElement("beforeend", next);
}

function addDeduction() {
  const board = activeBoard();
  if (!board || board.deductions.length >= MAX_DEDUCTIONS) return false;
  remember();
  const rule = normalizeDeduction(
    {
      title: `${t("MP.NewDeduction", "New deduction")} ${board.deductions.length + 1}`,
    },
    new Set(board.nodes.map((node) => node.id)),
    board.deductions.length,
  );
  board.deductions.push(rule);
  S.selectedDeduction = rule.id;
  renderDeductionPanel();
  autosave();
  return true;
}

async function revealDeductionManually(ruleId) {
  if (!game.user.isGM) return false;
  await save(false);
  const revealed = await revealDeductionById(S.board, ruleId);
  if (revealed)
    ui.notifications.info(t("MP.DeductionRevealed", "Deduction revealed."));
  return revealed;
}

async function resetDeduction(ruleId) {
  if (!game.user.isGM) return false;
  await save(false);
  const reset = await resetDeductionById(S.board, ruleId);
  if (reset)
    ui.notifications.info(t("MP.DeductionReset", "Deduction reset."));
  return reset;
}

async function revealDeductionById(boardId, ruleId) {
  if (!game.user.isGM) return false;
  const result = await enqueueBoardMutation(boardId, (board) => {
    const rule = board.deductions.find((candidate) => candidate.id === ruleId),
      changed = revealRuleOnBoard(board, rule, game.user.id, true);
    if (changed) board.deductionRevision += 1;
    return { changed, revealedIds: changed ? [rule.id] : [] };
  });
  if (!result) return false;
  await settleRevealedConsequences(boardId, result);
  return publishDeductionUpdate(boardId, result);
}

async function resetDeductionById(boardId, ruleId) {
  if (!game.user.isGM) return false;
  const result = await enqueueBoardMutation(boardId, (board) => {
    const rule = board.deductions.find((candidate) => candidate.id === ruleId),
      visibilityIds = rule?.rewardNodeId ? [rule.rewardNodeId] : [];
    return {
      changed: resetRuleOnBoard(board, rule),
      revealedIds: [],
      visibilityIds,
    };
  });
  return result ? publishDeductionUpdate(boardId, result, [ruleId]) : false;
}

async function evaluateDeductionsById(boardId) {
  if (!game.user.isGM) return false;
  const result = await enqueueBoardMutation(boardId, (board) => {
    const revealedIds = revealReadyDeductions(board, game.user.id);
    if (revealedIds.length) board.deductionRevision += 1;
    return { changed: revealedIds.length > 0, revealedIds };
  });
  if (!result) return [];
  await settleRevealedConsequences(boardId, result);
  publishDeductionUpdate(boardId, result);
  return clone(result.revealedIds);
}

async function revealEvidence(nodeId, options = {}) {
  if (!game.user.isGM) return false;
  const id = String(nodeId || ""),
    project = normalizeProject(game.settings.get(MOD, "project")),
    requestedBoard = String(options?.boardId || ""),
    matches = project.boards.flatMap((board) =>
      (!requestedBoard || board.id === requestedBoard) &&
      board.nodes.some((node) => node.id === id)
        ? [board]
        : [],
    );
  if (matches.length !== 1) {
    console.warn(
      `${MOD} | revealEvidence requires one matching node, found ${matches.length}: ${id}`,
    );
    return false;
  }
  const boardId = matches[0].id,
    existing = matches[0].nodes.find((node) => node.id === id);
  if (existing.revealed) return true;
  const source = String(options?.source || "").slice(0, 160),
    result = await enqueueBoardMutation(boardId, (board) => {
      const node = board.nodes.find((candidate) => candidate.id === id);
      if (!node || node.revealed) return { changed: false };
      node.revealed = true;
      board.deductionRevision += 1;
      return {
        changed: true,
        evidenceIds: [id],
        source,
        revealedIds: revealReadyDeductions(board, game.user.id),
      };
    });
  if (!result) return false;
  await settleRevealedConsequences(boardId, result);
  return publishDeductionUpdate(boardId, result);
}

function addNode(type) {
  remember();
  const board = activeBoard(),
    count = board.nodes.length,
    node = normalizeNode({
      type,
      title: t(`MP.Type.${type}`, type),
      x: 32 + (count % 3) * 7,
      y: 30 + (count % 4) * 5,
      w: type === "text" ? 16 : type === "person" ? 12 : 14,
      h: type === "text" ? 8 : type === "person" ? 19 : 14,
      rotation: ((count % 3) - 1) * 1.2,
    });
  board.nodes.push(node);
  S.selected = node.id;
  renderEditor();
  autosave();
}
function newBoard() {
  remember();
  const board = normalizeBoard({
    title: `${t("MP.NewInvestigation", "New investigation")} ${S.draft.boards.length + 1}`,
  });
  S.draft.boards.push(board);
  S.board = board.id;
  S.selected = null;
  S.selectedDeduction = null;
  renderEditor();
  autosave();
}
async function deleteBoard() {
  if (S.draft.boards.length <= 1)
    return ui.notifications.warn("At least one investigation must remain.");
  if (
    !window.confirm(
      `${t("MP.DeleteBoard", "Delete investigation")}: ${activeBoard().title}?`,
    )
  )
    return;
  remember();
  S.draft.boards = S.draft.boards.filter((b) => b.id !== S.board);
  S.board = S.draft.boards[0].id;
  S.selected = null;
  S.selectedDeduction = null;
  renderEditor();
  autosave();
}
function chooseNode(nodeId) {
  const board = activeBoard();
  if (S.connecting) {
    if (!S.connectFrom) {
      S.connectFrom = nodeId;
      S.selected = nodeId;
      return refreshEditorSelection();
    }
    if (
      S.connectFrom !== nodeId &&
      !board.links.some(
        (l) =>
          (l.from === S.connectFrom && l.to === nodeId) ||
          (l.to === S.connectFrom && l.from === nodeId),
      )
    ) {
      remember();
      board.links.push({
        id: uid(),
        from: S.connectFrom,
        to: nodeId,
        label: "",
        color: "#b94343",
        style: "solid",
      });
    }
    S.connecting = false;
    S.connectFrom = null;
    S.selected = nodeId;
    renderEditor();
    return autosave();
  }
  S.selected = nodeId;
  refreshEditorSelection();
}
function toggleConnect() {
  S.connecting = !S.connecting;
  S.connectFrom = S.connecting ? S.selected : null;
  refreshEditorSelection();
}
function updateGeometry(nodeId = null) {
  const board = activeBoard(),
    links = nodeId
      ? board.links.filter((link) => link.from === nodeId || link.to === nodeId)
      : board.links;
  links.forEach((link) => {
    const group = S.editor?.querySelector(`[data-link="${link.id}"]`),
      d = pathFor(link, board);
    group
      ?.querySelectorAll("path")
      .forEach((path) => path.setAttribute("d", d));
    const label = S.editor?.querySelector(`[data-label-link="${link.id}"]`),
      a = board.nodes.find((node) => node.id === link.from),
      b = board.nodes.find((node) => node.id === link.to);
    if (!label || !a || !b) return;
    label.style.setProperty("--lx", (a.x + a.w / 2 + b.x + b.w / 2) / 2);
    label.style.setProperty("--ly", (a.y + a.h / 2 + b.y + b.h / 2) / 2);
  });
}

function scheduleGeometry(nodeId = null) {
  if (nodeId) S.geometryNodes.add(nodeId);
  else S.geometryNodes.add("*");
  if (S.geometryFrame) return;
  S.geometryFrame = requestAnimationFrame(() => {
    S.geometryFrame = 0;
    const ids = [...S.geometryNodes];
    S.geometryNodes.clear();
    if (ids.includes("*")) updateGeometry();
    else ids.forEach((id) => updateGeometry(id));
  });
}
async function browseImage() {
  const Picker =
    foundry.applications?.apps?.FilePicker?.implementation ||
    foundry.applications?.apps?.FilePicker ||
    globalThis.FilePicker;
  if (!Picker) return;
  const node = activeNode(),
    app = new Picker({
      type: "imagevideo",
      current: node?.image || "",
      callback: (value) => {
        if (node) {
          remember();
          node.image = value;
          renderEditor();
          autosave();
        }
      },
    });
  try {
    await app.render({ force: true });
  } catch {
    await app.render(true);
  }
}

function exportProject() {
  if (!S.draft) return;
  const payload = JSON.stringify(
      {
        module: MOD,
        schema: 4,
        exportedAt: new Date().toISOString(),
        project: S.draft,
      },
      null,
      2,
    ),
    blob = new Blob([payload], { type: "application/json" }),
    url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `mind-palace-${new Date().toISOString().slice(0, 10)}.json`;
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
    if (file.size > 8 * 1024 * 1024)
      return ui.notifications.error(
        t("MP.ImportTooLarge", "The import file exceeds 8 MB."),
      );
    try {
      const raw = JSON.parse(await file.text()),
        project = raw?.module === MOD ? raw.project : raw;
      if (!isImportableProject(project))
        throw new Error("Invalid Mind Palace project");
      remember();
      S.draft = normalizeProject(project);
      S.board = S.draft.activeBoard;
      S.selected = null;
      S.connecting = false;
      S.connectFrom = null;
      S.selectedDeduction = null;
      renderEditor();
      await save(true);
      ui.notifications.info(t("MP.Imported", "Mind Palace project imported."));
    } catch (error) {
      console.error(`${MOD} | import failed`, error);
      ui.notifications.error(
        t("MP.ImportFailed", "This JSON file could not be imported."),
      );
    }
  };
  input.click();
}

function refreshEditorNodeContents(node) {
  const element = S.editor?.querySelector(`[data-node="${node.id}"]`);
  if (!element) return;
  const heading = element.querySelector("h3"),
    body = element.querySelector("p"),
    panelHeading = S.editor.querySelector(".mp-properties .mp-panel-head h2");
  if (heading) heading.textContent = node.title;
  if (body)
    body.textContent =
      node.type === "text"
        ? node.body || node.caption
        : node.caption || node.body;
  if (panelHeading) panelHeading.textContent = node.title;
  let secret = element.querySelector(".mp-secret");
  if (!node.revealed && !secret) {
    secret = document.createElement("i");
    secret.className = "fas fa-eye-slash mp-secret";
    element.append(secret);
  } else if (node.revealed) secret?.remove();
}

function bindEditor(el) {
  el.onclick = async (event) => {
    if (event.target.closest("[data-uc-dragged]")) return;
    const act = event.target.closest("[data-act]")?.dataset.act,
      addOutcome = event.target.closest("[data-add-consequence]")?.dataset
        .addConsequence,
      removeOutcome = event.target.closest("[data-remove-consequence]")?.dataset
        .removeConsequence,
      retryOutcome = event.target.closest("[data-retry-consequence]")?.dataset
        .retryConsequence;
    if (act === "copy-uuid") {
      await save(false);
      const path = ["boards", S.board];
      if (S.deductionPanel && S.selectedDeduction) path.push("deductions", S.selectedDeduction);
      else if (S.selected) path.push("nodes", S.selected);
      return globalThis.UniCanvasDocuments?.copyUuid(MOD, path);
    }
    if (addOutcome) return addConsequence(addOutcome);
    if (removeOutcome) {
      const board = activeBoard(),
        rule = selectedDeduction(board);
      if (!rule) return;
      remember();
      rule.consequences = rule.consequences.filter(
        (consequence) => consequence.id !== removeOutcome,
      );
      board.deductionRevision += 1;
      renderDeductionPanel();
      return autosave();
    }
    if (retryOutcome) {
      await save(false);
      return retryDeductionConsequences(
        S.board,
        S.selectedDeduction,
        retryOutcome,
        { notify: true },
      );
    }
    if (["person", "document", "clue", "note", "text"].includes(act))
      return addNode(act);
    if (act === "close") return closeEditor();
    if (act === "undo") return restoreHistory("undo");
    if (act === "redo") return restoreHistory("redo");
    if (act === "export") return exportProject();
    if (act === "import") return importProject();
    if (act === "save") return save(true);
    if (act === "deductions") {
      S.deductionPanel = !S.deductionPanel;
      if (S.deductionPanel && !S.selectedDeduction)
        S.selectedDeduction = activeBoard().deductions[0]?.id || null;
      return renderEditor();
    }
    if (act === "close-deductions") {
      S.deductionPanel = false;
      S.editor.querySelector(".mp-deduction-panel")?.remove();
      S.editor
        .querySelector('[data-act="deductions"]')
        ?.classList.remove("active");
      return;
    }
    if (act === "add-deduction") return addDeduction();
    if (act === "reveal-deduction")
      return revealDeductionManually(S.selectedDeduction);
    if (act === "reset-deduction")
      return resetDeduction(S.selectedDeduction);
    if (act === "delete-deduction") {
      const board = activeBoard(),
        rule = selectedDeduction(board);
      if (!rule) return;
      if (
        !window.confirm(
          `${t("MP.Delete", "Delete")}: ${rule.title}?`,
        )
      )
        return;
      remember();
      if (rule.unlockApplied && rule.rewardNodeId) {
        const reward = board.nodes.find((node) => node.id === rule.rewardNodeId),
          keptOpen = board.deductions.some(
            (candidate) =>
              candidate.id !== rule.id &&
              candidate.revealed &&
              candidate.unlockApplied &&
              candidate.rewardNodeId === rule.rewardNodeId,
          );
        if (reward && !keptOpen) reward.revealed = false;
      }
      board.deductions = board.deductions.filter(
        (candidate) => candidate.id !== rule.id,
      );
      S.selectedDeduction = board.deductions[0]?.id || null;
      renderEditor();
      return autosave();
    }
    if (act === "preview") {
      const boardId = S.board;
      await save();
      await closeEditor({ saveDraft: false });
      return openViewer(boardId, true);
    }
    if (act === "show") {
      const boardId = S.board;
      await save();
      await closeEditor({ saveDraft: false });
      return showAll(boardId);
    }
    if (act === "connect") return toggleConnect();
    if (act === "newboard") return newBoard();
    if (act === "template") {
      remember();
      const sample = rekeyBoard(exampleCase().boards[0]);
      sample.title += ` ${S.draft.boards.length + 1}`;
      S.draft.boards.push(sample);
      S.board = sample.id;
      S.selected = null;
      renderEditor();
      autosave();
      return ui.notifications.info(
        t("MP.Created", "Example investigation created."),
      );
    }
    if (act === "deleteboard") return deleteBoard();
    if (act === "browse") return browseImage();
    if (act === "deletenode") {
      const board = activeBoard(),
        nodeId = S.selected;
      if (!nodeId) return;
      if (
        !window.confirm(
          `${t("MP.Delete", "Delete")}: ${activeNode()?.title || ""}?`,
        )
      )
        return;
      remember();
      board.nodes = board.nodes.filter((node) => node.id !== nodeId);
      board.links = board.links.filter(
        (link) => link.from !== nodeId && link.to !== nodeId,
      );
      board.playerLinks = board.playerLinks.filter(
        (link) => link.from !== nodeId && link.to !== nodeId,
      );
      board.deductions.forEach((rule) => {
        rule.requiredNodes = rule.requiredNodes.filter((id) => id !== nodeId);
        rule.requiredLinks = rule.requiredLinks.filter(
          (link) => link.from !== nodeId && link.to !== nodeId,
        );
        if (rule.rewardNodeId === nodeId) {
          rule.rewardNodeId = "";
          rule.unlockApplied = false;
        }
        rule.consequences.forEach((consequence) => {
          if (
            consequence.type === "evidence" &&
            consequence.evidenceId === nodeId
          ) {
            consequence.evidenceId = "";
            resetConsequenceDelivery(consequence);
          }
        });
      });
      board.deductionRevision += 1;
      S.selected = null;
      renderEditor();
      return autosave();
    }
    if (act === "duplicate") {
      remember();
      const source = activeNode(),
        board = activeBoard(),
        node = normalizeNode({
          ...clone(source),
          id: uid(),
          x: source.x + 3,
          y: source.y + 3,
          title: `${source.title} — copy`,
        });
      board.nodes.push(node);
      S.selected = node.id;
      renderEditor();
      return autosave();
    }
    const remove =
      event.target.closest("[data-remove-link]")?.dataset.removeLink;
    if (remove) {
      remember();
      activeBoard().links = activeBoard().links.filter(
        (link) => link.id !== remove,
      );
      renderEditor();
      return autosave();
    }
    const boardId = event.target.closest("[data-board-select]")?.dataset
      .boardSelect;
    if (boardId) {
      S.board = boardId;
      S.selected = null;
      S.connecting = false;
      S.connectFrom = null;
      S.selectedDeduction = null;
      renderEditor();
      return void save(false);
    }
    const deductionId = event.target.closest("[data-deduction-select]")
      ?.dataset.deductionSelect;
    if (deductionId) {
      S.selectedDeduction = deductionId;
      return renderDeductionPanel();
    }
    const nodeId = event.target.closest("[data-node]")?.dataset.node;
    if (nodeId) return chooseNode(nodeId);
  };
  el.onfocusin = (event) => {
    if (
      event.target.matches?.(
        "[data-board-prop],[data-node-prop],[data-link-color],[data-link-label],[data-deduction-prop],[data-consequence-field]",
      )
    ) {
      S.inputSnapshot = clone(S.draft);
      S.inputSnapshotArmed = true;
    }
  };
  el.oninput = (event) => {
    const board = activeBoard(),
      node = activeNode(),
      boardProp = event.target.dataset.boardProp,
      nodeProp = event.target.dataset.nodeProp,
      colorId = event.target.dataset.linkColor,
      labelId = event.target.dataset.linkLabel,
      deductionProp = event.target.dataset.deductionProp,
      rule = selectedDeduction(board),
      consequenceField = event.target.dataset.consequenceField,
      consequenceId = event.target.closest?.("[data-consequence-id]")?.dataset
        .consequenceId,
      consequence = rule?.consequences.find(
        (candidate) => candidate.id === consequenceId,
      );
    if (S.inputSnapshotArmed) {
      remember(S.inputSnapshot);
      S.inputSnapshotArmed = false;
    }
    if (boardProp) board[boardProp] = event.target.value;
    if (nodeProp && node)
      node[nodeProp] =
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value;
    if (colorId) {
      const link = board.links.find((item) => item.id === colorId);
      if (link) {
        link.color = safeColor(event.target.value);
        S.editor
          .querySelectorAll(`[data-link="${link.id}"] path`)
          .forEach((path) => path.setAttribute("stroke", link.color));
        S.editor
          .querySelector(`[data-label-link="${link.id}"]`)
          ?.style.setProperty("--lc", link.color);
      }
    }
    if (labelId) {
      const link = board.links.find((item) => item.id === labelId);
      if (link) {
        link.label = event.target.value;
        const label = S.editor.querySelector(`[data-label-link="${link.id}"]`);
        if (label) label.textContent = link.label;
      }
    }
    if (deductionProp && rule)
      rule[deductionProp] = String(event.target.value).slice(
        0,
        deductionProp === "title" ? 160 : 6000,
      );
    if (consequenceField && consequence) {
      consequence[consequenceField] =
        consequenceField === "value"
          ? boundedNumber(event.target.value)
          : String(event.target.value).slice(
              0,
              consequenceField === "body" ? 6000 : 160,
            );
      touchConsequence(board, consequence);
    }
    if (nodeProp && node) refreshEditorNodeContents(node);
    if (boardProp === "title") {
      const button = S.editor.querySelector(
        `[data-board-select="${board.id}"] span`,
      );
      if (button) button.textContent = board.title;
    }
    autosave();
  };
  el.onchange = (event) => {
    if (event.target.dataset.nodeProp === "image") renderEditor();
    const board = activeBoard(),
      rule = selectedDeduction(board),
      nodeId = event.target.dataset.deductionNode,
      linkKey = event.target.dataset.deductionLink,
      consequenceId = event.target.closest?.("[data-consequence-id]")?.dataset
        .consequenceId,
      consequence = rule?.consequences.find(
        (candidate) => candidate.id === consequenceId,
      );
    if (consequence && event.target.matches("[data-consequence-evidence]")) {
      remember();
      consequence.evidenceId = board.nodes.some(
        (node) => node.id === event.target.value,
      )
        ? event.target.value
        : "";
      touchConsequence(board, consequence);
      renderDeductionPanel();
      return autosave();
    }
    if (consequence && event.target.matches("[data-consequence-city]")) {
      remember();
      const point =
        event.target.value === ""
          ? null
          : cityPointCatalog()[Number(event.target.value)];
      consequence.cityId = point?.cityId || "";
      consequence.screenId = point?.screenId || "";
      consequence.pointId = point?.pointId || "";
      if (point) consequence.label = point.label;
      touchConsequence(board, consequence);
      renderDeductionPanel();
      return autosave();
    }
    if (consequence && event.target.matches("[data-consequence-dialogue]")) {
      remember();
      const variable = dialogueVariableCatalog().find(
        (candidate) => candidate.id === event.target.value,
      );
      consequence.variableId = variable?.id || "";
      if (variable) consequence.label = variable.label;
      touchConsequence(board, consequence);
      renderDeductionPanel();
      return autosave();
    }
    if (consequence && event.target.matches("[data-consequence-chronicle]")) {
      remember();
      const timeline = chronicleTimelineCatalog().find(
        (candidate) => candidate.id === event.target.value,
      );
      consequence.timelineId = timeline?.id || "";
      if (timeline) consequence.label = timeline.label;
      touchConsequence(board, consequence);
      renderDeductionPanel();
      return autosave();
    }
    if (consequence && event.target.matches("[data-consequence-operation]")) {
      remember();
      consequence.operation = event.target.value === "add" ? "add" : "set";
      touchConsequence(board, consequence);
      renderDeductionPanel();
      return autosave();
    }
    if (consequence && event.target.matches("[data-consequence-field]")) {
      renderDeductionPanel();
      return autosave();
    }
    if (rule && nodeId) {
      remember();
      const required = new Set(rule.requiredNodes);
      if (event.target.checked) required.add(nodeId);
      else required.delete(nodeId);
      rule.requiredNodes = [...required];
      renderDeductionPanel();
      return autosave();
    }
    if (rule && linkKey) {
      remember();
      const [from, to] = linkKey.split("::"),
        links = new Map(
          rule.requiredLinks.map((link) => [edgeKey(link.from, link.to), link]),
        );
      if (event.target.checked) links.set(linkKey, { from, to });
      else links.delete(linkKey);
      rule.requiredLinks = [...links.values()];
      renderDeductionPanel();
      return autosave();
    }
    if (rule && event.target.matches("[data-deduction-reward]")) {
      remember();
      rule.rewardNodeId = board.nodes.some(
        (node) => node.id === event.target.value,
      )
        ? event.target.value
        : "";
      renderDeductionPanel();
      return autosave();
    }
  };
  el.onkeydown = (event) => {
    if (
      event.key === "Escape" &&
      !event.target.closest?.("input,textarea,select")
    ) {
      event.preventDefault();
      if (S.deductionPanel) {
        S.deductionPanel = false;
        renderEditor();
      } else void closeEditor();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    restoreHistory(event.shiftKey ? "redo" : "undo");
  };
}
function autosave() {
  globalThis.UniCanvasEditor?.setSaveState(S.editor, "dirty");
  clearTimeout(S.timer);
  S.timer = setTimeout(() => {
    S.timer = null;
    void save(false);
  }, 450);
}
function queueProjectSave(
  snapshot,
  { notify = false, broadcast = false } = {},
) {
  const editor = S.editor, revision = globalThis.UniCanvasEditor?.revision(editor);
  const write = async () => {
    globalThis.UniCanvasEditor?.setSaveState(editor, "saving", revision);
    try {
      snapshot.boards?.forEach((board) =>
        applyCachedCollaboration(board, S.collaborationBoards.get(board.id)),
      );
      await game.settings.set(MOD, "project", snapshot);
      snapshot.boards?.forEach((board) =>
        S.collaborationBoards.set(board.id, clone(board)),
      );
      if (broadcast)
        game.socket.emit(`module.${MOD}`, {
          type: "refresh",
          boardId: snapshot.activeBoard,
          userId: game.user.id,
        });
      globalThis.UniCanvasEditor?.setSaveState(editor, "saved", revision);
      return true;
    } catch (error) {
      globalThis.UniCanvasEditor?.setSaveState(editor, "error", revision);
      reportError("project save failed", error);
      return false;
    }
  };
  S.saveChain = S.saveChain.then(write, write);
  return S.saveChain;
}
async function save(notify = false, { broadcast = notify } = {}) {
  if (!S.draft) return;
  clearTimeout(S.timer);
  S.timer = null;
  S.draft.activeBoard = S.board;
  return queueProjectSave(clone(S.draft), { notify, broadcast });
}

function personalNotes(boardId) {
  const all = game.settings.get(MOD, "personalNotes") || {};
  const pending = S.pendingNotes.get(boardId);
  const source = Array.isArray(pending)
      ? pending
      : Array.isArray(all[boardId])
        ? all[boardId]
        : [],
    ids = new Set();
  return source
    .filter((note) => note && typeof note === "object")
    .slice(0, 200)
    .map((note) => {
      let id = safeId(note.id);
      if (ids.has(id)) id = uid();
      ids.add(id);
      const x = Number(note.x),
        y = Number(note.y);
      return {
        id,
        x: Number.isFinite(x) ? x : 44,
        y: Number.isFinite(y) ? y : 42,
        text: String(note.text || "").slice(0, 5000),
      };
    });
}
function personalNoteHTML(note) {
  return `<article class="mp-personal-note uc-no-pan" data-personal-note="${note.id}" style="--x:${note.x};--y:${note.y}"><header><i class="fas fa-grip-lines"></i><span>${t("MP.MyNote", "My note")}</span><button data-delete-note="${note.id}" aria-label="${t("MP.Delete", "Delete")}"><i class="fas fa-xmark"></i></button></header><textarea maxlength="5000" placeholder="${t("MP.NotePlaceholder", "Write a note")}">${esc(String(note.text || "").slice(0, 5000))}</textarea></article>`;
}
async function savePersonalNotes(boardId, notes) {
  S.pendingNotes.set(boardId, clone(notes));
  return flushPersonalNotes();
}
function flushPersonalNotes() {
  clearTimeout(S.noteTimer);
  S.noteTimer = 0;
  if (!S.pendingNotes.size) return S.personalChain;
  const entries = [...S.pendingNotes.entries()];
  const write = async () => {
    try {
      const all = clone(game.settings.get(MOD, "personalNotes") || {});
      entries.forEach(([boardId, notes]) => {
        all[boardId] = clone(notes);
      });
      await game.settings.set(MOD, "personalNotes", all);
      entries.forEach(([boardId, notes]) => {
        if (S.pendingNotes.get(boardId) === notes)
          S.pendingNotes.delete(boardId);
      });
      return true;
    } catch (error) {
      reportError("personal notes save failed", error);
      return false;
    }
  };
  S.personalChain = S.personalChain.then(write, write);
  return S.personalChain;
}
function schedulePersonalNotes(boardId, notes) {
  S.pendingNotes.set(boardId, clone(notes));
  clearTimeout(S.noteTimer);
  S.noteTimer = setTimeout(() => void flushPersonalNotes(), 250);
}
function bindPersonalNote(element, boardId, notes) {
  const note = notes.find((item) => item.id === element.dataset.personalNote);
  if (!note) return;
  let dragOrigin = null;
  S.canvas.makeDraggable(element, {
    force: true,
    ignore: "button,textarea",
    get: () => {
      dragOrigin = { x: (note.x / 100) * 2400, y: (note.y / 100) * 1400 };
      return dragOrigin;
    },
    set: (position) => {
      note.x = (position.x / 2400) * 100;
      note.y = (position.y / 1400) * 100;
      element.style.translate = `${position.x - dragOrigin.x}px ${position.y - dragOrigin.y}px`;
    },
    onEnd: () => {
      syncDroppedPosition(element, note.x, note.y);
      schedulePersonalNotes(boardId, notes);
    },
  });
  element.querySelector("textarea").addEventListener("input", (event) => {
    note.text = event.target.value.slice(0, 5000);
    schedulePersonalNotes(boardId, notes);
  });
}

function deductionTrackerHTML(board) {
  if (!board.deductions.length) return "";
  const revealedCount = board.deductions.filter((rule) => rule.revealed).length;
  return `<aside class="mp-deduction-tracker" aria-label="${esc(t("MP.Deductions", "Deductions"))}"><header><span><i class="fas fa-lightbulb"></i>${t("MP.Deductions", "Deductions")}</span><strong>${revealedCount}/${board.deductions.length}</strong></header><div>${board.deductions
    .map((rule, index) => {
      const progress = deductionProgress(board, rule),
        title = rule.revealed || game.user.isGM
          ? rule.title
          : `${t("MP.UnknownDeduction", "Unresolved deduction")} ${index + 1}`,
        percent = Math.round(progress.ratio * 100);
      return `<button class="${rule.revealed ? "revealed" : ""}" ${rule.revealed ? `data-deduction-open="${rule.id}"` : "disabled"}><span><i class="fas ${rule.revealed ? "fa-circle-check" : "fa-circle-notch"}"></i><b>${esc(title)}</b><em>${progress.completed}/${progress.total}</em></span><span class="mp-deduction-meter" role="progressbar" aria-label="${esc(title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></span></button>`;
    })
    .join("")}</div></aside>`;
}

function refreshViewerConnectState() {
  if (!S.viewer) return;
  S.viewer.classList.toggle("is-connecting", S.viewerConnecting);
  const button = S.viewer.querySelector('[data-view="connect"]');
  button?.classList.toggle("active", S.viewerConnecting);
  button?.setAttribute("aria-pressed", String(S.viewerConnecting));
  S.viewer.querySelectorAll("[data-node]").forEach((element) =>
    element.classList.toggle(
      "connect-source",
      S.viewerConnecting && element.dataset.node === S.viewerConnectFrom,
    ),
  );
  const toast = S.viewer.querySelector(".mp-player-connect-toast");
  if (toast) {
    toast.hidden = !S.viewerConnecting;
    toast.querySelector("span").textContent = S.viewerConnectFrom
      ? t("MP.ConnectSecond", "Choose the second card")
      : t("MP.ConnectFirst", "Choose the first card");
  }
}

function queueDeductionReveals(host, rules) {
  if (!host || !rules?.length) return;
  S.revealQueue.push(...rules.map((rule) => ({ host, rule })));
  showNextDeductionReveal();
}

function showNextDeductionReveal() {
  if (S.revealActive) return;
  const entry = S.revealQueue.shift();
  if (!entry || !entry.host?.isConnected) return;
  const { host, rule } = entry,
    board = boardFromSettings(S.board),
    currentRule =
      board.deductions.find((candidate) => candidate.id === rule.id) || rule,
    outcomes = currentRule.consequences
      .map((consequence) => publicConsequenceView(board, consequence))
      .filter(Boolean),
    reward = board.nodes.find((node) => node.id === currentRule.rewardNodeId),
    rewardShown = currentRule.consequences.some(
      (consequence) =>
        consequence.type === "evidence" &&
        consequence.evidenceId === currentRule.rewardNodeId &&
        consequence.status === "delivered",
    ),
    chronicleTimeline = currentRule.consequences.find(
      (consequence) =>
        consequence.type === "chronicle" &&
        consequence.status === "delivered" &&
        consequence.timelineId,
    )?.timelineId,
    outcomeHtml = outcomes.length
      ? `<div class="mp-reveal-outcomes">${outcomes
          .map((outcome) => {
            if (outcome.type === "narrative")
              return `<section class="mp-cinematic-outcome"><h3>${esc(outcome.title)}</h3><p>${esc(outcome.body)}</p></section>`;
            const icon = consequenceTypeMeta(outcome.type)?.icon || "fa-arrow-right";
            return `<div class="mp-reveal-outcome"><i class="fas ${icon}"></i><b>${esc(outcome.label)}</b></div>`;
          })
          .join("")}</div>`
      : "",
    layer = document.createElement("div");
  S.revealActive = true;
  layer.className = "mp-deduction-reveal";
  layer.setAttribute("role", "dialog");
  layer.setAttribute("aria-modal", "true");
  layer.setAttribute("aria-label", rule.title);
  layer.innerHTML = `<article><small>${t("MP.DeductionComplete", "Deduction complete")}</small><h2>${esc(currentRule.title)}</h2><p>${esc(currentRule.description)}</p>${reward && !rewardShown ? `<div class="mp-reward-line"><i class="fas fa-lock-open"></i><span>${t("MP.ClueUnlocked", "Clue unlocked")}</span><b>${esc(reward.title)}</b></div>` : ""}${outcomeHtml}<button data-reveal-close><span>${t("MP.Continue", "Continue")}</span><i class="fas fa-arrow-right"></i></button></article>`;
  const close = () => {
    layer.remove();
    S.revealActive = false;
    if (chronicleTimeline) S.pendingChronicle = chronicleTimeline;
    if (S.revealQueue.length) return showNextDeductionReveal();
    const timelineId = S.pendingChronicle;
    S.pendingChronicle = "";
    if (timelineId) {
      closeViewer();
      game.modules?.get?.("chronicle")?.api?.open?.(timelineId);
    }
  };
  layer.onclick = (event) => {
    if (event.target === layer || event.target.closest("[data-reveal-close]"))
      close();
  };
  layer.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  host.append(layer);
  layer.querySelector("button")?.focus();
}

function openViewer(boardId = null, preview = false, initialState = null) {
  closeViewer();
  const board = boardFromSettings(boardId),
    layout = personalLayout(board.id);
  board.nodes.forEach((node) => {
    const saved = layout[node.id];
    if (saved) {
      if (Number.isFinite(Number(saved.x))) node.x = Number(saved.x);
      if (Number.isFinite(Number(saved.y))) node.y = Number(saved.y);
    }
  });
  S.board = board.id;
  const el = document.createElement("section");
  el.id = "mp-viewer";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", board.title);
  el.innerHTML = `<div class="mp-view-top"><div><h1>${esc(board.title)}</h1><p>${esc(board.subtitle)}</p></div><nav><button data-view="character"><i class="fas fa-user-shield"></i>${t("MP.Character", "Character")}</button><button data-view="chat" aria-pressed="false"><i class="fas fa-comments"></i>${t("MP.Chat", "Chat")}</button><button data-view="add-note"><i class="fas fa-note-sticky"></i>${t("MP.AddMyNote", "Note")}</button><button data-view="connect" aria-pressed="false"><i class="fas fa-link"></i>${t("MP.LinkClues", "Connect clues")}</button><button data-view="reset-layout"><i class="fas fa-rotate-left"></i>${t("MP.ResetLayout", "Reset layout")}</button>${game.user.isGM ? `<button data-view="edit"><i class="fas fa-pen-ruler"></i>${t("MP.Editor", "Case editor")}</button><button data-view="show"><i class="fas fa-users-viewfinder"></i>${t("MP.Show", "Open for everyone")}</button>` : ""}<button data-view="close"><i class="fas fa-xmark"></i>${t("MP.Close", "Close")}</button></nav></div><div class="mp-player-shell">${boardHTML(board, false)}${!board.nodes.some((n) => n.revealed) ? `<div class="mp-empty">${t("MP.Empty", "The mind palace is empty.")}</div>` : ""}</div>${deductionTrackerHTML(board)}<div class="mp-player-connect-toast" hidden><i class="fas fa-link"></i><span></span></div><div class="mp-view-hint"><i class="fas fa-computer-mouse"></i>${t("MP.PlayerMoveHint", "Drag cards and the board · mouse wheel to zoom")}</div>`;
  document.body.append(el);
  S.viewer = el;
  bindViewer(el, board, preview, initialState);
  el.querySelector('[data-view="close"]')?.focus();
}
function bindViewer(el, board, preview, initialState = null) {
  const viewport = el.querySelector(".mp-player-shell"),
    world = el.querySelector(".mp-board"),
    notes = personalNotes(board.id),
    layout = personalLayout(board.id);
  world.insertAdjacentHTML("beforeend", notes.map(personalNoteHTML).join(""));
  world.querySelectorAll(".mp-node").forEach((node, index) => {
    node.classList.add("uc-no-pan");
    node.style.setProperty("--depth", 0.35 + (index % 4) * 0.18);
  });
  S.canvas = canvasApi().create({
    viewport,
    world,
    width: 2400,
    height: 1400,
    minScale: 0.12,
    maxScale: 3.2,
    padding: 90,
    infinite: true,
    readOnly: false,
    initialState: initialState || undefined,
  });
  S.viewerConnecting = false;
  S.viewerConnectFrom = null;
  const updatePlayerGeometry = (nodeId = null) => {
    const allLinks = [...board.links, ...board.playerLinks],
      links = nodeId
        ? allLinks.filter((link) => link.from === nodeId || link.to === nodeId)
        : allLinks;
    links.forEach((link) => {
      const path = pathFor(link, board);
      world
        .querySelectorAll(
          `[data-link="${link.id}"] path,[data-player-link="${link.id}"] path`,
        )
        .forEach((element) => element.setAttribute("d", path));
      const label = world.querySelector(`[data-label-link="${link.id}"]`),
        a = board.nodes.find((node) => node.id === link.from),
        b = board.nodes.find((node) => node.id === link.to);
      if (label && a && b) {
        label.style.setProperty("--lx", (a.x + a.w / 2 + b.x + b.w / 2) / 2);
        label.style.setProperty("--ly", (a.y + a.h / 2 + b.y + b.h / 2) / 2);
      }
    });
  };
  world.querySelectorAll("[data-node]").forEach((element) => {
    const node = board.nodes.find((item) => item.id === element.dataset.node);
    if (!node) return;
    let origin = null;
    S.canvas.makeDraggable(element, {
      force: true,
      // In connection mode a click selects an endpoint. Disabling the drag
      // recognizer prevents the same gesture from nudging a player's layout.
      disabled: () => S.viewerConnecting,
      get: () => {
        origin = { x: (node.x / 100) * 2400, y: (node.y / 100) * 1400 };
        return origin;
      },
      set: (position) => {
        node.x = (position.x / 2400) * 100;
        node.y = (position.y / 1400) * 100;
        element.style.translate = `${(node.x / 100) * 2400 - origin.x}px ${(node.y / 100) * 1400 - origin.y}px`;
      },
      onMove: () => updatePlayerGeometry(node.id),
      onEnd: () => {
        syncDroppedPosition(element, node.x, node.y);
        layout[node.id] = { x: node.x, y: node.y };
        updatePlayerGeometry(node.id);
        schedulePersonalLayout(board.id, layout);
      },
    });
  });
  world
    .querySelectorAll("[data-personal-note]")
    .forEach((element) => bindPersonalNote(element, board.id, notes));
  refreshViewerConnectState();
  const applyParallax = () => {
    S.parallaxFrame = 0;
    if (!S.viewer || !S.parallax) return;
    world.style.setProperty("--parallax-x", S.parallax.x);
    world.style.setProperty("--parallax-y", S.parallax.y);
  };
  if (!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    viewport.addEventListener("pointermove", (event) => {
      if (event.buttons) return;
      const rect = viewport.getBoundingClientRect(),
        px = ((event.clientX - rect.left) / rect.width - 0.5) * 9,
        py = ((event.clientY - rect.top) / rect.height - 0.5) * 7;
      S.parallax = { x: px, y: py };
      if (!S.parallaxFrame)
        S.parallaxFrame = requestAnimationFrame(applyParallax);
    });
    viewport.addEventListener("pointerleave", () => {
      S.parallax = { x: 0, y: 0 };
      if (!S.parallaxFrame)
        S.parallaxFrame = requestAnimationFrame(applyParallax);
    });
  }
  el.onclick = (event) => {
    const action = event.target.closest("[data-view]")?.dataset.view;
    if (event.target.closest("[data-node]")?.dataset.ucDragged) return;
    if (action === "character") return openCharacterSheet();
    if (action === "chat")
      return toggleChat(event.target.closest('[data-view="chat"]'));
    if (action === "connect") {
      S.viewerConnecting = !S.viewerConnecting;
      S.viewerConnectFrom = null;
      return refreshViewerConnectState();
    }
    if (action === "add-note") {
      if (notes.length >= 200)
        return ui.notifications.warn(
          t(
            "MP.NoteLimit",
            "This investigation already has 200 personal notes.",
          ),
        );
      const rect = viewport.getBoundingClientRect(),
        point = S.canvas.screenToWorld(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        ),
        note = {
          id: uid(),
          x: (point.x / 2400) * 100 - 6,
          y: (point.y / 1400) * 100 - 5,
          text: "",
        };
      notes.push(note);
      world.insertAdjacentHTML("beforeend", personalNoteHTML(note));
      const element = world.querySelector(`[data-personal-note="${note.id}"]`);
      bindPersonalNote(element, board.id, notes);
      element.querySelector("textarea").focus();
      return schedulePersonalNotes(board.id, notes);
    }
    if (action === "reset-layout") {
      return savePersonalLayout(board.id, {}).then(() =>
        openViewer(board.id, preview),
      );
    }
    const deleteId =
      event.target.closest("[data-delete-note]")?.dataset.deleteNote;
    if (deleteId) {
      const index = notes.findIndex((note) => note.id === deleteId);
      if (index >= 0) notes.splice(index, 1);
      event.target.closest("[data-personal-note]")?.remove();
      return schedulePersonalNotes(board.id, notes);
    }
    if (action === "close")
      return closeViewer({ clearWorld: game.user?.isGM });
    if (action === "edit") {
      closeViewer();
      return openEditor();
    }
    if (action === "show") return showAll(board.id);
    const deductionId = event.target.closest("[data-deduction-open]")?.dataset
      .deductionOpen;
    if (deductionId) {
      const rule = board.deductions.find(
        (candidate) => candidate.id === deductionId && candidate.revealed,
      );
      if (rule) queueDeductionReveals(el, [rule]);
      return;
    }
    const nodeId = event.target.closest("[data-node]")?.dataset.node;
    if (nodeId) {
      if (S.viewerConnecting) {
        if (!S.viewerConnectFrom) {
          S.viewerConnectFrom = nodeId;
          refreshViewerConnectState();
          return;
        }
        const from = S.viewerConnectFrom;
        S.viewerConnecting = false;
        S.viewerConnectFrom = null;
        refreshViewerConnectState();
        if (from !== nodeId) return requestPlayerLink(board.id, from, nodeId);
        return;
      }
      const node = board.nodes.find((n) => n.id === nodeId);
      if (node) showNodeDetail(el, node);
    }
  };
  el.onkeydown = (event) => {
    if (event.key === "Escape") {
      if (S.viewerConnecting) {
        S.viewerConnecting = false;
        S.viewerConnectFrom = null;
        refreshViewerConnectState();
      } else closeViewer({ clearWorld: game.user?.isGM });
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const nodeId = event.target.closest?.("[data-node]")?.dataset.node;
    if (!nodeId || event.target.closest("textarea,button")) return;
    event.preventDefault();
    const node = board.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    if (S.viewerConnecting) {
      if (!S.viewerConnectFrom) S.viewerConnectFrom = nodeId;
      else {
        const from = S.viewerConnectFrom;
        S.viewerConnecting = false;
        S.viewerConnectFrom = null;
        if (from !== nodeId) void requestPlayerLink(board.id, from, nodeId);
      }
      refreshViewerConnectState();
    } else showNodeDetail(el, node);
  };
}
function showNodeDetail(host, node) {
  host.querySelector(".mp-detail-layer")?.remove();
  const layer = document.createElement("div");
  layer.className = "mp-detail-layer";
  layer.setAttribute("role", "dialog");
  layer.setAttribute("aria-modal", "true");
  layer.setAttribute("aria-label", node.title);
  layer.innerHTML = `<article class="mp-detail type-${node.type}"><button data-detail-close aria-label="${esc(t("MP.Close", "Close"))}"><i class="fas fa-xmark"></i></button>${node.image ? `<div class="mp-detail-image" style="background-image:url('${esc(cssUrl(node.image))}')"></div>` : ""}<div class="mp-detail-copy"><small>${esc(t(`MP.Type.${node.type}`, node.type))}</small><h2>${esc(node.title)}</h2><h3>${esc(node.caption)}</h3><p>${esc(node.body)}</p></div></article>`;
  layer.onclick = (e) => {
    if (e.target === layer || e.target.closest("[data-detail-close]"))
      layer.remove();
  };
  host.append(layer);
}
async function showAll(boardId) {
  if (!game.user.isGM) return false;
  const project = normalizeProject(game.settings.get(MOD, "project"));
  project.activeBoard = project.boards.some((board) => board.id === boardId)
    ? boardId
    : project.activeBoard;
  try {
    await game.settings.set(MOD, "project", project);
    S.collaborationBoards.clear();
    project.boards.forEach((board) =>
      S.collaborationBoards.set(board.id, clone(board)),
    );
    await game.settings.set(MOD, "visible", true);
  } catch (error) {
    reportError("show failed", error);
    return false;
  }
  game.socket.emit(`module.${MOD}`, {
    type: "open",
    boardId: project.activeBoard,
    userId: game.user.id,
  });
  openViewer(project.activeBoard);
  ui.notifications.info(
    t("MP.Shown", "The investigation was opened for all players."),
  );
  Hooks.callAll("mindPalace.shown", {
    boardId: project.activeBoard,
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
  ui.notifications.info(
    t("MP.Hidden", "The investigation was closed for all players."),
  );
  Hooks.callAll("mindPalace.hidden", { userId: game.user.id });
  return true;
}

function registerSceneControls(controls) {
  const tools = {
    open: {
      name: "open",
      title: t("MP.Open", "Open Mind Palace"),
      icon: "fa-solid fa-brain",
      order: 0,
      button: true,
      onChange: () => openViewer(),
    },
  };
  if (game.user.isGM) {
    tools.edit = {
      name: "edit",
      title: t("MP.Editor", "Case editor"),
      icon: "fa-solid fa-diagram-project",
      order: 1,
      button: true,
      onChange: () => openEditor(),
    };
    tools.show = {
      name: "show",
      title: t("MP.Show", "Open for everyone"),
      icon: "fa-solid fa-users-viewfinder",
      order: 2,
      button: true,
      onChange: () => showAll(),
    };
    tools.hide = {
      name: "hide",
      title: t("MP.Hide", "Close for everyone"),
      icon: "fa-solid fa-eye-slash",
      order: 3,
      button: true,
      onChange: () => hideAll(),
    };
  }
  const control = {
    name: "mindPalace",
    title: t("MP.Title", "Mind Palace"),
    icon: "fa-solid fa-brain",
    order: 76,
    visible: true,
    tools,
  };
  if (Array.isArray(controls))
    controls.push({
      ...control,
      layer: "controls",
      tools: Object.values(tools),
    });
  else controls.mindPalace = control;
}

// Isolate optional-module failures so a malformed board or localization entry
// cannot abort Foundry's shared Scene Controls hook for other modules.
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    registerSceneControls(controls);
  } catch (error) {
    console.error(`${MOD} | scene controls unavailable`, error);
  }
});

Hooks.once("init", () => {
  game.settings.register(MOD, "project", {
    name: "Mind Palace data",
    scope: "world",
    config: false,
    type: Object,
    default: exampleCase(),
  });
  game.settings.register(MOD, "visible", {
    name: "Mind Palace visible",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });
  game.settings.register(MOD, "personalNotes", {
    name: "Personal notes",
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });
  game.settings.register(MOD, "personalLayouts", {
    name: "Personal card layouts",
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });
});
Hooks.once("ready", () => {
  game.socket.on(`module.${MOD}`, (message) => {
    if (!message || typeof message !== "object") return;
    const sender = game.users.get(message.userId);
    if (message.type === "player-link-request") {
      if (
        !isPrimaryGM() ||
        !sender ||
        sender.isGM ||
        !rememberEvent(S.socketRequests, message.requestId) ||
        game.settings.get(MOD, "visible") !== true
      )
        return;
      const project = normalizeProject(game.settings.get(MOD, "project")),
        board = project.boards.find((candidate) => candidate.id === message.boardId),
        from = String(message.from || ""),
        to = String(message.to || "");
      if (
        !board ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(from) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(to)
      )
        return;
      void applyPlayerLink(board.id, from, to, sender.id);
      return;
    }
    if (!sender?.isGM) return;
    if (message.type === "deduction-update") {
      if (!rememberEvent(S.socketEvents, message.eventId)) return;
      const revealedIds = (Array.isArray(message.revealedIds)
          ? message.revealedIds
          : [])
          .map(String)
          .slice(0, MAX_DEDUCTIONS),
        resetIds = (Array.isArray(message.resetIds) ? message.resetIds : [])
          .map(String)
          .slice(0, MAX_DEDUCTIONS),
        evidenceIds = (Array.isArray(message.evidenceIds)
          ? message.evidenceIds
          : [])
          .map(String)
          .slice(0, 200),
        outcomeRuleIds = (Array.isArray(message.outcomeRuleIds)
          ? message.outcomeRuleIds
          : [])
          .map(String)
          .slice(0, MAX_DEDUCTIONS);
      updateOpenDeductionView(
        String(message.boardId || ""),
        revealedIds,
        resetIds,
        {
          evidenceIds,
          outcomeRuleIds,
          source: String(message.source || "").slice(0, 160),
          linkChanged: message.linkChanged === true,
        },
      );
      return;
    }
    const visible = game.settings.get(MOD, "visible"),
      project = normalizeProject(game.settings.get(MOD, "project"));
    if (
      message.type === "open" &&
      visible === true &&
      message.boardId === project.activeBoard
    ) {
      if (!S.viewer || S.board !== project.activeBoard)
        openViewer(project.activeBoard);
    }
    if (message.type === "close" && visible === false) closeViewer();
    if (
      message.type === "refresh" &&
      visible === true &&
      S.viewer &&
      message.boardId === project.activeBoard
    ) {
      const camera = S.canvas?.getState?.() || null;
      openViewer(project.activeBoard, false, camera);
    }
  });
  if (!game.user.isGM && game.settings.get(MOD, "visible")) openViewer();
  const emergencyFlush = () => {
    if (game.user.isGM && S.draft) void save(false);
    void flushPersonalLayouts();
    void flushPersonalNotes();
  };
  globalThis.addEventListener?.("pagehide", emergencyFlush);
  globalThis.document?.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "hidden") emergencyFlush();
  });
  game.modules.get(MOD).api = {
    version: "2.8.0",
    open: (boardId) => openViewer(boardId),
    close: closeViewer,
    openEditor,
    editEntity(path) {
      if (!game.user.isGM) return false;
      openEditor();
      if (!S.draft.boards.some(board => board.id === path[1])) return false;
      S.board = path[1]; S.selected = path[2] === "nodes" ? path[3] : null;
      S.deductionPanel = path[2] === "deductions"; S.selectedDeduction = S.deductionPanel ? path[3] : null;
      renderEditor(); return true;
    },
    getEntityUuid: path => globalThis.UniCanvasDocuments?.uuid(MOD, path),
    listEntities: () => globalThis.UniCanvasDocuments?.list(MOD) || [],
    show: showAll,
    hide: hideAll,
    getBoards: () => normalizeProject(game.settings.get(MOD, "project")).boards,
    getDeductions: (boardId) => {
      const board = boardFromSettings(boardId);
      return board.deductions.map((rule) =>
        deductionView(board, rule, game.user.isGM),
      );
    },
    getConsequences: (boardId, ruleId) => {
      const board = boardFromSettings(boardId),
        rule = board.deductions.find((candidate) => candidate.id === ruleId);
      if (!rule) return [];
      return game.user.isGM
        ? clone(rule.consequences)
        : rule.revealed
          ? rule.consequences
              .map((consequence) => publicConsequenceView(board, consequence))
              .filter(Boolean)
          : [];
    },
    connectCards: (boardId, from, to) =>
      requestPlayerLink(boardId || boardFromSettings().id, String(from), String(to)),
    revealDeduction: revealDeductionById,
    resetDeduction: resetDeductionById,
    evaluateDeductions: evaluateDeductionsById,
    retryConsequences: (boardId, ruleId, consequenceId = "") =>
      retryDeductionConsequences(boardId, ruleId, consequenceId),
    revealEvidence,
    revealNode: revealEvidence,
    exportProject: () =>
      clone(normalizeProject(game.settings.get(MOD, "project"))),
    importProject: async (project) => {
      if (!game.user.isGM) return false;
      if (!isImportableProject(project))
        throw new TypeError("Invalid Mind Palace project");
      const normalized = normalizeProject(project);
      await game.settings.set(MOD, "project", normalized);
      S.collaborationBoards.clear();
      normalized.boards.forEach((board) =>
        S.collaborationBoards.set(board.id, clone(board)),
      );
      return clone(normalized);
    },
  };
  Hooks.callAll("mindPalace.apiReady", game.modules.get(MOD).api);
  if (isPrimaryGM()) void resumePendingConsequences();
  console.info(`${MOD} | ready`);
});
