const MOD = "chronicle";
const VERSION = "1.1.0";
const DATA_VERSION = 1;
const SOCKET = `module.${MOD}`;
const CARD_ICONS = Object.freeze([
  "clock-rotate-left", "envelope", "person-walking", "flask-vial", "wind",
  "fire-flame-curved", "book", "location-dot", "key", "skull", "eye",
]);
const LIMITS = Object.freeze({
  timelines: 40,
  cards: 30,
  effects: 20,
  receipts: 500,
  text: 4000,
  title: 180,
  importBytes: 2_000_000,
  importNodes: 10_000,
});

const S = {
  viewer: null,
  editor: null,
  reveal: null,
  draft: null,
  timelineId: "",
  localTimelineId: "",
  draggedCard: "",
  stateQueue: Promise.resolve(),
  saveQueue: Promise.resolve(),
  deliveryQueue: Promise.resolve(),
  choiceRate: new Map(),
  seenOutcome: "",
  pending: false,
  pendingRequestId: "",
  pendingTimer: null,
  orderPending: null,
  pointerDrag: null,
  restoreFocus: null,
  editorRestoreFocus: null,
};

const clone = (value) => foundry.utils.deepClone(value);
const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
const text = (value, fallback = "", limit = LIMITS.text) =>
  String(value ?? fallback).trim().slice(0, limit) || String(fallback).slice(0, limit);
const number = (value, fallback = 0, min = -999999, max = 999999) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};
const uid = (prefix = "id") => `${prefix}-${foundry.utils.randomID(12)}`;
const validId = (value) => /^[A-Za-z0-9_-]{1,128}$/.test(String(value || ""));
const requestId = (value) => /^[A-Za-z0-9_-]{8,160}$/.test(String(value || ""));
const sameOrder = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((id, index) => id === right[index]);
const t = (key, fallback, data = {}) => {
  const full = `CH.${key}`;
  let localized = game.i18n?.localize?.(full);
  if (!localized || localized === full) localized = fallback;
  for (const [name, value] of Object.entries(data))
    localized = localized.replaceAll(`{${name}}`, String(value));
  return localized;
};
function exampleProject() {
  return {
    version: DATA_VERSION,
    activeTimeline: "silver-burn-night",
    timelines: [
      {
        id: "silver-burn-night",
        title: "Ночь серебряного ожога",
        subtitle: "Восстановите шесть часов, которые исчезли из показаний",
        intro:
          "Письмо, мокрый курьер и холодный след на коже связаны одной ночью. Расставьте события так, чтобы ни одно свидетельство не противоречило следующему.",
        successText:
          "Пар из перегонного куба прошёл по старой шахте раньше, чем тело перенесли. Северные мастерские были не убежищем — они были второй частью установки.",
        public: true,
        maxAttempts: 3,
        feedback: "count",
        cards: [
          {
            id: "sealed-letter-delivered",
            title: "Доставлено запечатанное письмо",
            text: "Промокший курьер оставляет письмо у задней двери алхимической лавки.",
            image: "",
            icon: "envelope",
          },
          {
            id: "courier-seen-north",
            title: "Курьер замечен на севере",
            text: "Сторож видит тот же плащ у закрытых мастерских, но уже без письма.",
            image: "",
            icon: "person-walking",
          },
          {
            id: "still-ignited",
            title: "Зажжён перегонный куб",
            text: "Ильян запускает установку и перекрывает обычную вытяжку.",
            image: "",
            icon: "flask-vial",
          },
          {
            id: "vapour-seventh-shaft",
            title: "Пар уходит в седьмую шахту",
            text: "Нагретый пар проходит по заброшенному каналу под городом.",
            image: "",
            icon: "wind",
          },
          {
            id: "silver-burn-appears",
            title: "Появляется серебряный ожог",
            text: "След проступает уже после смерти и не совпадает ни с одним пламенем в комнате.",
            image: "",
            icon: "fire-flame-curved",
          },
          {
            id: "ledger-hidden",
            title: "Книга учёта спрятана",
            text: "До рассвета из переплёта вырезают записи о поставках в Северные мастерские.",
            image: "",
            icon: "book",
          },
        ],
        effects: [
          {
            id: "reveal-north-workshops",
            type: "city",
            cityId: "",
            screenId: "",
            pointId: "north-workshops",
          },
          {
            id: "reveal-silver-burn",
            type: "mind",
            boardId: "ashcroft-formula",
            evidenceId: "silver-burn",
          },
          {
            id: "advance-courier-lead",
            type: "dialogue",
            variableId: "courier-lead",
            operation: "set",
            value: 2,
          },
        ],
      },
    ],
  };
}

function uniqueId(raw, used, prefix) {
  let result = validId(raw) ? String(raw) : uid(prefix);
  while (used.has(result)) result = uid(prefix);
  used.add(result);
  return result;
}

function normalizeEffect(raw = {}, used = new Set()) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const type = ["city", "mind", "dialogue"].includes(raw.type)
    ? raw.type
    : "city";
  return {
    id: uniqueId(raw.id, used, "effect"),
    type,
    cityId: text(raw.cityId, "", 128),
    screenId: text(raw.screenId, "", 128),
    pointId: text(raw.pointId, "", 128),
    boardId: text(raw.boardId, "", 128),
    evidenceId: text(raw.evidenceId, "", 128),
    variableId: text(raw.variableId, "", 128),
    operation: raw.operation === "add" ? "add" : "set",
    value: number(raw.value, 1),
  };
}

function effectFingerprint(effect) {
  return JSON.stringify([
    effect.type,
    effect.cityId,
    effect.screenId,
    effect.pointId,
    effect.boardId,
    effect.evidenceId,
    effect.variableId,
    effect.operation,
    effect.value,
  ]);
}

function normalizePrepared(raw, effect) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.type !== effect.type)
    return null;
  if (effect.type === "city") {
    const cityId = text(raw.cityId, "", 128);
    const screenId = text(raw.screenId, "", 128);
    const pointId = text(raw.pointId, "", 128);
    return cityId && screenId && pointId ? { type: "city", cityId, screenId, pointId } : null;
  }
  if (effect.type === "mind") {
    const boardId = text(raw.boardId, "", 128);
    const evidenceId = text(raw.evidenceId, "", 128);
    return boardId && evidenceId ? { type: "mind", boardId, evidenceId } : null;
  }
  const variableId = text(raw.variableId, "", 128);
  return variableId
    ? { type: "dialogue", variableId, value: number(raw.value, effect.value) }
    : null;
}

function normalizeDelivery(raw, effect) {
  const fingerprint = effectFingerprint(effect);
  if (raw === true) {
    return { status: "delivered", fingerprint, prepared: null, updatedAt: 0 };
  }
  if (!raw || typeof raw !== "object" || raw.fingerprint !== fingerprint) return null;
  const status = raw.status === "delivered" ? "delivered" : "prepared";
  const prepared = normalizePrepared(raw.prepared, effect);
  if (status === "prepared" && !prepared) return null;
  return {
    status,
    fingerprint,
    prepared,
    updatedAt: number(raw.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeOutcome(raw, project) {
  if (!raw || typeof raw !== "object"
    || !project.timelines.some((timeline) => timeline.id === raw.timelineId)) return null;
  return {
    id: text(raw.id, "", 160),
    timelineId: text(raw.timelineId, "", 128),
    type: ["solved", "failed", "exhausted"].includes(raw.type) ? raw.type : "failed",
    positions: Math.round(number(raw.positions, 0, 0, LIMITS.cards)),
    total: Math.round(number(raw.total, 0, 0, LIMITS.cards)),
    attempts: Math.round(number(raw.attempts, 0, 0, 999)),
    at: number(raw.at, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeRequestResult(raw, project) {
  if (!raw || typeof raw !== "object") return null;
  const timelineId = text(raw.timelineId, "", 128);
  if (!project.timelines.some((timeline) => timeline.id === timelineId)) return null;
  return {
    kind: raw.kind === "order" ? "order" : "submit",
    ok: raw.ok === true,
    timelineId,
    userId: text(raw.userId, "", 128),
    outcome: normalizeOutcome(raw.outcome, project),
    at: number(raw.at, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
}

function storeRequestResult(state, id, result) {
  if (!requestId(id)) return false;
  const entries = Object.entries(state.requestResults || {})
    .filter(([key]) => key !== id)
    .slice(-(LIMITS.receipts - 1));
  state.requestResults = Object.fromEntries([...entries, [id, result]]);
  state.receipts = [...new Set([...(state.receipts || []), id])].slice(-LIMITS.receipts);
  return true;
}

function normalizeTimeline(raw = {}, index = 0, used = new Set()) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const cardIds = new Set();
  const effectIds = new Set();
  const cards = (Array.isArray(raw.cards) ? raw.cards : [])
    .slice(0, LIMITS.cards)
    .map((card) => ({
      id: uniqueId(card?.id, cardIds, "event"),
      title: text(card?.title, t("NewEvent", "Новое событие"), LIMITS.title),
      text: text(card?.text, "", LIMITS.text),
      image: text(card?.image, "", 1000),
      icon: CARD_ICONS.includes(card?.icon) ? card.icon : "clock-rotate-left",
    }));
  return {
    id: uniqueId(raw.id, used, "case"),
    title: text(raw.title, `${t("NewCase", "Новое дело")} ${index + 1}`, LIMITS.title),
    subtitle: text(raw.subtitle, "", 400),
    intro: text(raw.intro, "", LIMITS.text),
    successText: text(raw.successText, "", LIMITS.text),
    public: raw.public !== false,
    maxAttempts: Math.round(number(raw.maxAttempts, 3, 0, 99)),
    feedback: ["none", "count", "positions"].includes(raw.feedback)
      ? raw.feedback
      : "count",
    cards,
    effects: (Array.isArray(raw.effects) ? raw.effects : [])
      .slice(0, LIMITS.effects)
      .map((effect) => normalizeEffect(effect, effectIds)),
  };
}

function normalizeProject(raw = {}) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ids = new Set();
  let timelines = (Array.isArray(raw.timelines) ? raw.timelines : [])
    .slice(0, LIMITS.timelines)
    .map((timeline, index) => normalizeTimeline(timeline, index, ids));
  if (!timelines.length) timelines = exampleProject().timelines.map((timeline, index) =>
    normalizeTimeline(timeline, index, ids));
  return {
    version: DATA_VERSION,
    activeTimeline: timelines.some((timeline) => timeline.id === raw.activeTimeline)
      ? raw.activeTimeline
      : timelines[0].id,
    timelines,
  };
}

function seededOrder(ids, seed) {
  const output = [...ids];
  let hash = 2166136261;
  for (const char of String(seed)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  for (let index = output.length - 1; index > 0; index -= 1) {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822519);
    const target = Math.abs(hash) % (index + 1);
    [output[index], output[target]] = [output[target], output[index]];
  }
  if (output.length > 1 && output.every((id, index) => id === ids[index]))
    output.push(output.shift());
  return output;
}

function normalizeOrder(raw, timeline) {
  const ids = timeline.cards.map((card) => card.id);
  const allowed = new Set(ids);
  const result = [];
  for (const id of Array.isArray(raw) ? raw : [])
    if (allowed.has(id) && !result.includes(id)) result.push(id);
  const missing = seededOrder(ids.filter((id) => !result.includes(id)), timeline.id);
  return [...result, ...missing];
}

function normalizeState(raw = {}, project = getProject()) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const orders = {};
  const attempts = {};
  const solved = {};
  const deliveries = {};
  for (const timeline of project.timelines) {
    orders[timeline.id] = normalizeOrder(raw.orders?.[timeline.id], timeline);
    attempts[timeline.id] = Math.round(number(raw.attempts?.[timeline.id], 0, 0, 999));
    solved[timeline.id] = Boolean(raw.solved?.[timeline.id]);
    const effects = new Map(timeline.effects.map((effect) => [effect.id, effect]));
    deliveries[timeline.id] = Object.fromEntries(
      Object.entries(raw.deliveries?.[timeline.id] || {})
        .map(([id, delivery]) => [id, effects.has(id)
          ? normalizeDelivery(delivery, effects.get(id))
          : null])
        .filter(([, delivery]) => delivery),
    );
  }
  const receipts = [...new Set((Array.isArray(raw.receipts) ? raw.receipts : [])
    .map(String)
    .filter(requestId))].slice(-LIMITS.receipts);
  const activeTimeline = project.timelines.some((timeline) => timeline.id === raw.activeTimeline)
    ? raw.activeTimeline
    : project.activeTimeline;
  const requestResults = Object.fromEntries(
    Object.entries(raw.requestResults || {})
      .filter(([id]) => requestId(id))
      .slice(-LIMITS.receipts)
      .map(([id, result]) => [id, normalizeRequestResult(result, project)])
      .filter(([, result]) => result),
  );
  return {
    version: DATA_VERSION,
    revision: Math.round(number(raw.revision, 0, 0, Number.MAX_SAFE_INTEGER)),
    activeTimeline,
    orders,
    attempts,
    solved,
    deliveries,
    receipts,
    requestResults,
    lastOutcome: normalizeOutcome(raw.lastOutcome, project),
  };
}

function getProject() {
  return normalizeProject(game.settings.get(MOD, "project"));
}

function getState(project = getProject()) {
  return normalizeState(game.settings.get(MOD, "state"), project);
}

function getPublicProject() {
  const project = getProject();
  if (game.user.isGM) return clone(project);
  const state = getState(project);
  const timelines = project.timelines
    .filter((timeline) => timeline.public)
    .map((timeline) => {
      const cards = state.orders[timeline.id]
        .map((id) => timeline.cards.find((card) => card.id === id))
        .filter(Boolean)
        .map((card) => clone(card));
      const { effects: _effects, ...safe } = timeline;
      return {
        ...clone(safe),
        successText: state.solved[timeline.id] ? safe.successText : "",
        cards,
      };
    });
  return {
    version: project.version,
    activeTimeline: timelines.some((timeline) => timeline.id === state.activeTimeline)
      ? state.activeTimeline
      : timelines[0]?.id || "",
    timelines,
  };
}

function getPublicState() {
  const project = getProject();
  const state = getState(project);
  if (game.user.isGM) return clone(state);
  const allowed = new Set(project.timelines.filter((timeline) => timeline.public).map((timeline) => timeline.id));
  return {
    version: state.version,
    revision: state.revision,
    activeTimeline: allowed.has(state.activeTimeline) ? state.activeTimeline : "",
    orders: Object.fromEntries(Object.entries(state.orders).filter(([id]) => allowed.has(id))),
    attempts: Object.fromEntries(Object.entries(state.attempts).filter(([id]) => allowed.has(id))),
    solved: Object.fromEntries(Object.entries(state.solved).filter(([id]) => allowed.has(id))),
    lastOutcome: allowed.has(state.lastOutcome?.timelineId) ? clone(state.lastOutcome) : null,
  };
}

function timelineById(project, id) {
  return project.timelines.find((timeline) => timeline.id === id)
    || project.timelines.find((timeline) => timeline.id === project.activeTimeline)
    || project.timelines[0];
}

function activeGM() {
  if (game.users?.activeGM?.active) return game.users.activeGM;
  const users = game.users?.contents || Array.from(game.users?.values?.() || []);
  return users
    .filter((user) => user.active && user.isGM)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] || null;
}

function isPrimaryGM() {
  return Boolean(game.user.isGM && activeGM()?.id === game.user.id);
}

function requirePrimaryGM(notify = false) {
  const allowed = isPrimaryGM();
  if (!allowed && notify)
    ui.notifications.warn(t("PrimaryGMRequired", "Это действие выполняет активный мастер."));
  return allowed;
}

function validPermutation(order, timeline) {
  if (!Array.isArray(order) || order.length !== timeline.cards.length) return false;
  const expected = new Set(timeline.cards.map((card) => card.id));
  return new Set(order).size === order.length && order.every((id) => expected.has(id));
}

function positionCount(order, timeline) {
  return timeline.cards.reduce(
    (total, card, index) => total + (order[index] === card.id ? 1 : 0),
    0,
  );
}

function enqueueStateMutation(mutator) {
  const task = async () => {
    if (!isPrimaryGM()) return false;
    const project = getProject();
    const state = getState(project);
    const result = await mutator(state, project);
    if (!result || result.changed === false) return { state, result: result || {}, changed: false };
    state.revision += 1;
    await game.settings.set(MOD, "state", state);
    game.socket.emit(SOCKET, { type: "state", userId: game.user.id });
    return { state: clone(state), result, changed: true };
  };
  S.stateQueue = S.stateQueue.catch(() => undefined).then(task);
  return S.stateQueue;
}

async function applyOrder(timelineId, order, userId = game.user.id, options = {}) {
  const receipt = requestId(options.requestId) ? String(options.requestId) : "";
  const mutation = await enqueueStateMutation((state, project) => {
    const timeline = timelineById(project, timelineId);
    const actor = game.users.get(userId);
    const previous = receipt ? state.requestResults?.[receipt] : null;
    if (previous) return { changed: false, ...clone(previous), duplicate: true };
    const valid = timeline?.id === timelineId && validPermutation(order, timeline)
      && (actor?.isGM || timeline.public);
    if (!valid) {
      if (receipt && timeline?.id === timelineId) {
        storeRequestResult(state, receipt, {
          kind: "order", ok: false, timelineId, userId, outcome: null, at: Date.now(),
        });
        return { changed: true, ok: false, invalid: true, timelineId, userId };
      }
      return { changed: false, ok: false, invalid: true };
    }
    if (state.solved[timeline.id]) {
      if (!receipt) return { changed: false, ok: false };
      storeRequestResult(state, receipt, {
        kind: "order", ok: false, timelineId, userId, outcome: null, at: Date.now(),
      });
      return { changed: true, ok: false, timelineId, userId };
    }
    if (timeline.maxAttempts && state.attempts[timeline.id] >= timeline.maxAttempts) {
      if (!receipt) return { changed: false, ok: false };
      storeRequestResult(state, receipt, {
        kind: "order", ok: false, timelineId, userId, outcome: null, at: Date.now(),
      });
      return { changed: true, ok: false, timelineId, userId };
    }
    const orderChanged = !sameOrder(state.orders[timeline.id], order);
    if (orderChanged) {
      state.orders[timeline.id] = [...order];
      if (state.lastOutcome?.timelineId === timeline.id && state.lastOutcome.type === "failed")
        state.lastOutcome = null;
    }
    if (receipt) storeRequestResult(state, receipt, {
      kind: "order", ok: true, timelineId, userId, outcome: null, at: Date.now(),
    });
    return {
      changed: orderChanged || Boolean(receipt),
      orderChanged,
      ok: true,
      timelineId,
      order: [...order],
      userId,
    };
  });
  if (mutation?.result?.orderChanged) {
    Hooks.callAll("chronicle.orderChanged", clone(mutation.result));
    renderViewer();
  }
  return Boolean(mutation?.result?.ok);
}

async function setSharedOrder(timelineId, order, options = {}) {
  const project = getProject();
  const timeline = timelineById(project, timelineId);
  if (!timeline || timeline.id !== timelineId || !validPermutation(order, timeline)) return false;
  if (game.user.isGM) {
    if (!requirePrimaryGM(true)) return false;
    return applyOrder(timelineId, order, options.userId || game.user.id);
  }
  if (!timeline.public) return false;
  if (!activeGM()) {
    ui.notifications.warn(t("GMRequired", "Для изменения общей хронологии нужен активный мастер."));
    return false;
  }
  if (S.orderPending?.timelineId === timelineId) {
    S.orderPending.queuedOrder = [...order];
    return true;
  }
  clearOrderPending(false);
  const receipt = requestId(options.requestId) ? String(options.requestId) : uid("order");
  S.orderPending = {
    requestId: receipt,
    timelineId,
    sentOrder: [...order],
    queuedOrder: null,
    timer: setTimeout(() => {
      if (S.orderPending?.requestId !== receipt) return;
      clearOrderPending(true);
      ui.notifications.warn(t("NoOrderResponse", "Мастер не подтвердил порядок. Изменение отменено."));
    }, 7000),
  };
  game.socket.emit(SOCKET, {
    type: "order",
    userId: game.user.id,
    timelineId,
    order: [...order],
    requestId: receipt,
  });
  return true;
}

function clearOrderPending(render = false) {
  if (S.orderPending?.timer) clearTimeout(S.orderPending.timer);
  S.orderPending = null;
  if (render) renderViewer();
}

function settleRequestResults(state) {
  if (S.pendingRequestId) {
    const result = state.requestResults?.[S.pendingRequestId];
    if (result?.kind === "submit" && result.userId === game.user.id) {
      clearPending();
      if (!result.ok)
        ui.notifications.warn(t("InvalidOrder", "Последовательность событий повреждена."));
    }
  }
  const pending = S.orderPending;
  if (!pending) return;
  const result = state.requestResults?.[pending.requestId];
  if (result?.kind !== "order" || result.userId !== game.user.id) return;
  const queued = pending.queuedOrder;
  const timelineId = pending.timelineId;
  clearOrderPending(false);
  if (!result.ok) {
    ui.notifications.warn(t("OrderRejected", "Мастер отклонил изменение порядка."));
    return;
  }
  if (queued && !sameOrder(queued, state.orders[timelineId]))
    void setSharedOrder(timelineId, queued);
}

function cityPoints(api) {
  let project = null;
  try { project = api?.getProject?.(); } catch (_) { project = null; }
  return (project?.cities || []).flatMap((city) =>
    (city.screens || []).flatMap((screen) =>
      (screen.objects || [])
        .filter((point) => point.kind === "poi")
        .map((point) => ({ cityId: city.id, screenId: screen.id, pointId: point.id })),
    ),
  );
}

function mindNodes(api) {
  let boards = [];
  try {
    const value = api?.getBoards?.();
    boards = Array.isArray(value) ? value : value?.boards || [];
    if (!boards.length) boards = api?.getProject?.()?.boards || [];
  } catch (_) { boards = []; }
  return boards.flatMap((board) => (board.nodes || []).map((node) => ({
    boardId: board.id,
    evidenceId: node.id,
  })));
}

async function prepareEffect(effect) {
  if (effect.type === "city") {
    const api = game.modules.get("city-viewer")?.api;
    if (!api?.revealPoint || !effect.pointId) return null;
    const matches = cityPoints(api).filter((point) =>
      point.pointId === effect.pointId
      && (!effect.cityId || point.cityId === effect.cityId)
      && (!effect.screenId || point.screenId === effect.screenId));
    if (matches.length !== 1) return null;
    return { type: "city", ...matches[0] };
  }
  if (effect.type === "mind") {
    const api = game.modules.get("mind-palace")?.api;
    if (!api?.revealEvidence || !effect.evidenceId) return null;
    const matches = mindNodes(api).filter((node) =>
      node.evidenceId === effect.evidenceId
      && (!effect.boardId || node.boardId === effect.boardId));
    if (matches.length !== 1) return null;
    return { type: "mind", ...matches[0] };
  }
  if (effect.type === "dialogue") {
    const api = game.modules.get("dialogue-stage")?.api;
    if (!api?.setVariable || !effect.variableId) return null;
    let variables = null;
    try { variables = api.getProject?.()?.variables; } catch (_) { variables = null; }
    if (Array.isArray(variables) && !variables.some((variable) => variable.id === effect.variableId))
      return null;
    const current = number(api.getStoryState?.()?.variables?.[effect.variableId], 0);
    return {
      type: "dialogue",
      variableId: effect.variableId,
      value: effect.operation === "add" ? current + effect.value : effect.value,
    };
  }
  return null;
}

async function deliverPrepared(timeline, effect, prepared) {
  try {
    if (prepared.type === "city") {
      const api = game.modules.get("city-viewer")?.api;
      if (!api?.revealPoint) return false;
      return Boolean(await api.revealPoint(
        prepared.cityId,
        prepared.screenId,
        prepared.pointId,
        { source: MOD },
      ));
    }
    if (prepared.type === "mind") {
      const api = game.modules.get("mind-palace")?.api;
      if (!api?.revealEvidence) return false;
      return Boolean(await api.revealEvidence(prepared.evidenceId, {
        boardId: prepared.boardId,
        source: MOD,
      }));
    }
    if (prepared.type === "dialogue") {
      const api = game.modules.get("dialogue-stage")?.api;
      if (!api?.setVariable) return false;
      const result = await api.setVariable(prepared.variableId, prepared.value);
      if (result) return true;
      return Number(api.getStoryState?.()?.variables?.[prepared.variableId]) === prepared.value;
    }
  } catch (error) {
    console.warn(`${MOD} | consequence failed`, timeline.id, effect.id, error);
  }
  return false;
}

function retryConsequences(timelineId) {
  const task = async () => {
    if (!isPrimaryGM()) return false;
    let deliveredAny = false;
    const initialProject = getProject();
    const initialTimeline = timelineById(initialProject, timelineId);
    if (!initialTimeline || initialTimeline.id !== timelineId
      || !getState(initialProject).solved[timelineId]) return false;
    for (const initialEffect of initialTimeline.effects) {
      let project = getProject();
      let timeline = timelineById(project, timelineId);
      let effect = timeline?.effects.find((candidate) => candidate.id === initialEffect.id);
      if (!timeline || timeline.id !== timelineId || !effect) continue;
      const fingerprint = effectFingerprint(effect);
      let delivery = getState(project).deliveries[timeline.id]?.[effect.id];
      if (delivery?.status === "delivered" && delivery.fingerprint === fingerprint) continue;
      let prepared = delivery?.fingerprint === fingerprint ? delivery.prepared : null;
      if (!prepared) {
        prepared = await prepareEffect(effect);
        if (!prepared) continue;
        const preparation = await enqueueStateMutation((state, currentProject) => {
          const currentTimeline = timelineById(currentProject, timelineId);
          const currentEffect = currentTimeline?.effects.find((candidate) => candidate.id === effect.id);
          if (!currentTimeline || currentTimeline.id !== timelineId || !currentEffect
            || !state.solved[timelineId]
            || effectFingerprint(currentEffect) !== fingerprint) return { changed: false };
          const existing = state.deliveries[timelineId]?.[effect.id];
          if (existing?.status === "delivered" || existing?.status === "prepared")
            return { changed: false };
          state.deliveries[timelineId] ||= {};
          state.deliveries[timelineId][effect.id] = {
            status: "prepared",
            fingerprint,
            prepared: clone(prepared),
            updatedAt: Date.now(),
          };
          return { changed: true, prepared: clone(prepared) };
        });
        project = getProject();
        timeline = timelineById(project, timelineId);
        effect = timeline?.effects.find((candidate) => candidate.id === initialEffect.id);
        delivery = getState(project).deliveries[timelineId]?.[initialEffect.id];
        prepared = delivery?.prepared || preparation?.result?.prepared;
      }
      if (!effect || !prepared || effectFingerprint(effect) !== fingerprint
        || delivery?.status === "delivered") continue;
      const delivered = await deliverPrepared(timeline, effect, prepared);
      if (!delivered) continue;
      const mutation = await enqueueStateMutation((state, currentProject) => {
        const currentTimeline = timelineById(currentProject, timelineId);
        const currentEffect = currentTimeline?.effects.find((candidate) => candidate.id === effect.id);
        const current = state.deliveries[timelineId]?.[effect.id];
        if (!currentTimeline || currentTimeline.id !== timelineId || !currentEffect
          || effectFingerprint(currentEffect) !== fingerprint
          || current?.status !== "prepared" || current.fingerprint !== fingerprint)
          return { changed: false };
        state.deliveries[timelineId][effect.id] = {
          ...current,
          status: "delivered",
          updatedAt: Date.now(),
        };
        return {
          changed: true,
          timelineId,
          effect: clone(currentEffect),
          prepared: clone(current.prepared),
        };
      });
      if (mutation?.changed) {
        deliveredAny = true;
        Hooks.callAll("chronicle.effectDelivered", clone(mutation.result));
      }
    }
    return deliveredAny;
  };
  S.deliveryQueue = S.deliveryQueue.catch(() => undefined).then(task);
  return S.deliveryQueue;
}

async function applySubmission(timelineId, order, options = {}) {
  const receipt = requestId(options.requestId) ? String(options.requestId) : uid("submit");
  const userId = text(options.userId, game.user.id, 128);
  const mutation = await enqueueStateMutation((state, project) => {
    const timeline = timelineById(project, timelineId);
    const previous = state.requestResults?.[receipt];
    if (previous) return {
      changed: false,
      ok: previous.ok,
      outcome: clone(previous.outcome),
      solved: previous.outcome?.type === "solved",
      duplicate: true,
    };
    const actor = game.users.get(userId);
    const valid = timeline?.id === timelineId && validPermutation(order, timeline)
      && (actor?.isGM || timeline.public);
    if (state.receipts.includes(receipt)) {
      if (timeline?.id !== timelineId) return { changed: false, ok: false, invalid: true };
      storeRequestResult(state, receipt, {
        kind: "submit", ok: valid, timelineId, userId, outcome: null, at: Date.now(),
      });
      return { changed: true, ok: valid, duplicate: true, invalid: !valid };
    }
    if (!valid) {
      if (timeline?.id === timelineId) {
        storeRequestResult(state, receipt, {
          kind: "submit", ok: false, timelineId, userId, outcome: null, at: Date.now(),
        });
        return { changed: true, ok: false, invalid: true };
      }
      return { changed: false, ok: false, invalid: true };
    }
    if (state.solved[timeline.id]) {
      storeRequestResult(state, receipt, {
        kind: "submit", ok: true, timelineId, userId, outcome: null, at: Date.now(),
      });
      return { changed: true, ok: true, solved: true, duplicate: true };
    }
    const attempts = state.attempts[timeline.id];
    if (timeline.maxAttempts && attempts >= timeline.maxAttempts) {
      const outcome = state.lastOutcome?.timelineId === timelineId
        && state.lastOutcome.type === "exhausted" ? clone(state.lastOutcome) : {
        id: uid("outcome"), timelineId, type: "exhausted",
        positions: positionCount(order, timeline), total: timeline.cards.length,
        attempts, at: Date.now(),
      };
      state.lastOutcome = outcome;
      storeRequestResult(state, receipt, {
        kind: "submit", ok: true, timelineId, userId, outcome: clone(outcome), at: Date.now(),
      });
      return { changed: true, ok: true, outcome };
    }
    state.orders[timeline.id] = [...order];
    const positions = positionCount(order, timeline);
    const solved = positions === timeline.cards.length;
    if (!solved) state.attempts[timeline.id] += 1;
    state.solved[timeline.id] = solved;
    const exhausted = !solved && timeline.maxAttempts > 0
      && state.attempts[timeline.id] >= timeline.maxAttempts;
    const outcome = {
      id: uid("outcome"), timelineId,
      type: solved ? "solved" : exhausted ? "exhausted" : "failed",
      positions, total: timeline.cards.length,
      attempts: state.attempts[timeline.id], at: Date.now(),
    };
    state.lastOutcome = outcome;
    storeRequestResult(state, receipt, {
      kind: "submit", ok: true, timelineId, userId, outcome: clone(outcome), at: Date.now(),
    });
    return { changed: true, ok: true, outcome, solved };
  });
  if (!mutation || mutation.result?.invalid || mutation.result?.ok === false) return false;
  const outcome = mutation.result?.outcome;
  if (mutation.result?.duplicate) {
    return clone(outcome || mutation.result);
  } else if (outcome?.type === "solved") {
    Hooks.callAll("chronicle.solved", clone(outcome));
    void retryConsequences(timelineId);
  } else if (outcome) {
    Hooks.callAll("chronicle.attemptFailed", clone(outcome));
  } else if (mutation.result?.solved) {
    void retryConsequences(timelineId);
  }
  return clone(outcome || mutation.result);
}

async function submitTheory(timelineId, order, options = {}) {
  const project = getProject();
  const timeline = timelineById(project, timelineId);
  if (!timeline || timeline.id !== timelineId || !validPermutation(order, timeline)) {
    ui.notifications.warn(t("InvalidOrder", "Последовательность событий повреждена."));
    return false;
  }
  const receipt = requestId(options.requestId) ? String(options.requestId) : uid("submit");
  if (game.user.isGM) {
    if (!requirePrimaryGM(true)) return false;
    return applySubmission(timelineId, order, { ...options, requestId: receipt });
  }
  if (!timeline.public) return false;
  if (!activeGM()) {
    ui.notifications.warn(t("GMRequired", "Для изменения общей хронологии нужен активный мастер."));
    return false;
  }
  if (S.pending) return false;
  S.pending = true;
  S.pendingRequestId = receipt;
  clearTimeout(S.pendingTimer);
  S.pendingTimer = setTimeout(() => {
    if (!S.pending) return;
    clearPending();
    ui.notifications.warn(t("NoResponse", "Мастер не подтвердил версию. Попробуйте ещё раз."));
  }, 7000);
  updateSubmitState();
  ui.notifications.info(t("Pending", "Мастер проверяет версию…"));
  game.socket.emit(SOCKET, {
    type: "submit",
    userId: game.user.id,
    timelineId,
    order: [...order],
    requestId: receipt,
  });
  return true;
}

async function resetTimeline(timelineId) {
  if (!requirePrimaryGM(true)) return false;
  const result = await enqueueStateMutation((state, project) => {
    const timeline = timelineById(project, timelineId);
    if (!timeline || timeline.id !== timelineId) return { changed: false };
    state.orders[timeline.id] = seededOrder(timeline.cards.map((card) => card.id), `${timeline.id}-${Date.now()}`);
    state.attempts[timeline.id] = 0;
    state.solved[timeline.id] = false;
    state.lastOutcome = null;
    return { changed: true, timelineId };
  });
  if (result?.changed) ui.notifications.info(t("ResetDone", "Попытка сброшена."));
  return Boolean(result?.changed);
}

function mediaHTML(card) {
  if (!card.image) return `<i class="fas fa-${esc(card.icon)}"></i>`;
  const source = esc(card.image);
  if (/\.(?:webm|mp4|ogg)(?:[?#].*)?$/i.test(card.image))
    return `<video src="${source}" autoplay muted loop playsinline></video>`;
  return `<img src="${source}" alt="" loading="eager" decoding="async">`;
}

function attemptsLabel(timeline, state) {
  if (!timeline.maxAttempts) return t("Unlimited", "без ограничений");
  return `${state.attempts[timeline.id]} / ${timeline.maxAttempts}`;
}

function cardHTML(card, index, timeline, state) {
  const last = state.lastOutcome;
  const showPositions = last?.timelineId === timeline.id
    && last.type !== "solved"
    && timeline.feedback === "positions";
  const correct = showPositions && timeline.cards[index]?.id === card.id;
  const positionClass = showPositions ? (correct ? " is-correct" : " is-wrong") : "";
  const positionLabel = correct
    ? t("CorrectPosition", "Событие стоит на верном месте")
    : t("WrongPosition", "Позиция пока не подтверждена");
  const disabled = S.pending || state.solved[timeline.id]
    || (timeline.maxAttempts > 0 && state.attempts[timeline.id] >= timeline.maxAttempts);
  return `<li class="ch-card${positionClass}" data-card-id="${esc(card.id)}" draggable="${disabled ? "false" : "true"}" tabindex="0" aria-disabled="${disabled}" aria-grabbed="false" aria-posinset="${index + 1}" aria-setsize="${state.orders[timeline.id].length}" ${showPositions ? `aria-label="${esc(`${card.title}. ${positionLabel}`)}"` : ""}>
    <div class="ch-card-media">${mediaHTML(card)}<span class="ch-card-index">${index + 1}</span></div>
    <div class="ch-card-copy"><h2>${esc(card.title)}</h2><p>${esc(card.text)}</p></div>
    <div class="ch-card-tools" aria-label="${esc(card.title)}">
      <button type="button" data-card-move="-1" title="${esc(t("MoveEarlier", "Переместить раньше"))}" aria-label="${esc(t("MoveEarlier", "Переместить раньше"))}" ${index === 0 || disabled ? "disabled" : ""}><i class="fas fa-arrow-left"></i></button>
      <button type="button" data-card-move="1" title="${esc(t("MoveLater", "Переместить позже"))}" aria-label="${esc(t("MoveLater", "Переместить позже"))}" ${index === state.orders[timeline.id].length - 1 || disabled ? "disabled" : ""}><i class="fas fa-arrow-right"></i></button>
    </div>
  </li>`;
}

function currentTimelineForViewer(project, state) {
  const requested = S.localTimelineId || state.activeTimeline || project.activeTimeline;
  const timeline = timelineById(project, requested);
  if (!game.user.isGM && !timeline.public) return null;
  return timeline;
}

function viewerHTML(project, state, timeline) {
  if (!timeline) {
    return `<section class="ch-view-header"><div></div><div class="ch-view-title"><small>Chronicle</small><h1 id="chronicle-title">${esc(t("SecretCase", "Это дело пока скрыто мастером."))}</h1></div><div class="ch-view-actions"><button data-view="close"><i class="fas fa-xmark"></i> ${esc(t("Close", "Закрыть"))}</button></div></section>`;
  }
  const order = state.orders[timeline.id] || [];
  const cards = order.map((cardId) => timeline.cards.find((card) => card.id === cardId)).filter(Boolean);
  const solved = state.solved[timeline.id];
  const exhausted = !solved && timeline.maxAttempts > 0
    && state.attempts[timeline.id] >= timeline.maxAttempts;
  return `<header class="ch-view-header">
    <nav class="ch-view-tools">
      <button data-view="character"><i class="fas fa-user-shield"></i> <span>${esc(t("Character", "Персонаж"))}</span></button>
      <button data-view="chat" aria-pressed="${document.body.classList.contains("chronicle-chat-open")}"><i class="fas fa-comments"></i> <span>${esc(t("Chat", "Чат"))}</span></button>
    </nav>
    <div class="ch-view-title"><small>${esc(t("Shared", "Общая версия группы"))}</small><h1 id="chronicle-title">${esc(timeline.title)}</h1><p>${esc(timeline.subtitle)}</p></div>
    <div class="ch-view-actions"><div class="ch-attempts"><span>${esc(t("Attempts", "Попытки"))}</span><strong>${esc(attemptsLabel(timeline, state))}</strong></div><button data-view="close"><i class="fas fa-xmark"></i> ${esc(t("Close", "Закрыть"))}</button></div>
  </header>
  <main class="ch-board"><p class="ch-intro">${esc(timeline.intro)}</p><p class="ch-sr-only" aria-live="polite" data-order-live></p><ol class="ch-timeline" data-timeline-id="${esc(timeline.id)}">${cards.map((card, index) => cardHTML(card, index, timeline, state)).join("") || `<li class="ch-empty">${esc(t("Empty", "В этом деле пока нет событий."))}</li>`}</ol></main>
  <footer class="ch-view-footer"><p><i class="fas fa-hand-pointer"></i> ${esc(t("PlayerHint", "Перетаскивайте карточки или используйте стрелки, затем проверьте общую версию."))}</p><button class="ch-submit" data-view="submit" ${solved || exhausted || cards.length < 2 || S.pending ? "disabled" : ""}><i class="fas fa-scale-balanced"></i> ${esc(S.pending ? t("Pending", "Мастер проверяет версию…") : t("Submit", "Проверить версию"))}</button>${solved ? `<div class="ch-solved-banner"><i class="fas fa-check"></i> ${esc(t("Solved", "Хронология восстановлена"))}</div>` : exhausted ? `<div class="ch-failed-banner"><i class="fas fa-lock"></i> ${esc(t("Exhausted", "Попытки закончились"))}</div>` : "<div></div>"}</footer>`;
}

function openViewer(timelineId = "") {
  const project = getProject();
  const state = getState(project);
  const requested = timelineId || state.activeTimeline || project.activeTimeline;
  const timeline = project.timelines.find((item) => item.id === requested)
    || (!timelineId ? timelineById(project, requested) : null);
  if (!timeline) return false;
  if (!game.user.isGM && !timeline.public) {
    ui.notifications.warn(t("SecretCase", "Это дело пока скрыто мастером."));
    return false;
  }
  const wasOpen = Boolean(S.viewer);
  const previousTimeline = S.localTimelineId;
  S.localTimelineId = timeline.id;
  if (!S.viewer) {
    S.restoreFocus = typeof document.activeElement?.focus === "function" ? document.activeElement : null;
    S.viewer = document.createElement("section");
    S.viewer.id = "chronicle-viewer";
    S.viewer.setAttribute("role", "dialog");
    S.viewer.setAttribute("aria-modal", "true");
    S.viewer.setAttribute("aria-labelledby", "chronicle-title");
    S.viewer.tabIndex = -1;
    document.body.append(S.viewer);
    document.body.classList.add("chronicle-viewer-open");
  }
  renderViewer();
  if (!wasOpen || previousTimeline !== timeline.id)
    S.viewer.querySelector('[data-view="close"]')?.focus?.();
  if (!wasOpen || previousTimeline !== timeline.id)
    Hooks.callAll("chronicle.shown", { timelineId: timeline.id, userId: game.user.id });
  return true;
}

function closeViewer({ clearWorld = false } = {}) {
  const wasOpen = Boolean(S.viewer);
  document.body.classList.remove("chronicle-chat-open");
  document.body.classList.remove("chronicle-viewer-open");
  (document.querySelectorAll?.(".ch-elevated-sheet") || []).forEach((element) =>
    element.classList.remove("ch-elevated-sheet"));
  S.reveal?.remove();
  S.reveal = null;
  S.viewer?.remove();
  S.viewer = null;
  S.localTimelineId = "";
  S.draggedCard = "";
  S.pointerDrag = null;
  clearOrderPending(false);
  clearPending();
  S.restoreFocus?.focus?.();
  S.restoreFocus = null;
  if (wasOpen) Hooks.callAll("chronicle.hidden", { userId: game.user.id });
  // A GM closing the full-screen layer is an explicit stop command. Clear the
  // shared visibility flag so it cannot reopen on the next reload and trap the
  // Foundry sidebar behind the overlay. Player closes remain local.
  if (clearWorld && game.user?.isGM && game.settings?.get?.(MOD, "visible")) {
    void game.settings.set(MOD, "visible", false).catch((error) =>
      console.error(`${MOD} | could not clear shared visibility`, error));
  }
  return true;
}

function renderViewer() {
  if (!S.viewer) return;
  const project = getProject();
  const state = getState(project);
  settleRequestResults(state);
  const timeline = currentTimelineForViewer(project, state);
  if (timeline) S.localTimelineId = timeline.id;
  const optimistic = S.orderPending?.timelineId === timeline?.id
    ? S.orderPending.queuedOrder || S.orderPending.sentOrder
    : null;
  if (optimistic && validPermutation(optimistic, timeline)) {
    state.orders[timeline.id] = [...optimistic];
    if (state.lastOutcome?.timelineId === timeline.id && state.lastOutcome.type === "failed")
      state.lastOutcome = null;
  }
  S.viewer.innerHTML = viewerHTML(project, state, timeline);
  bindViewer(timeline, state);
}

function orderFromDOM() {
  return [...(S.viewer?.querySelectorAll(".ch-card[data-card-id]") || [])]
    .map((element) => element.dataset.cardId);
}

function moveCardDOM(cardId, targetId, after = false) {
  const card = S.viewer?.querySelector(`.ch-card[data-card-id="${CSS.escape(cardId)}"]`);
  const target = S.viewer?.querySelector(`.ch-card[data-card-id="${CSS.escape(targetId)}"]`);
  if (!card || !target || card === target) return false;
  target.parentElement.insertBefore(card, after ? target.nextSibling : target);
  [...target.parentElement.querySelectorAll(".ch-card")].forEach((element, index) => {
    const badge = element.querySelector(".ch-card-index");
    if (badge) badge.textContent = String(index + 1);
    element.classList.remove("is-correct", "is-wrong");
    element.removeAttribute("aria-label");
    element.setAttribute("aria-posinset", String(index + 1));
  });
  const position = orderFromDOM().indexOf(cardId) + 1;
  const live = S.viewer?.querySelector("[data-order-live]");
  if (live) live.textContent = t("MovedPosition", "Событие перемещено на позицию {position}.", { position });
  return true;
}

function commitViewerOrder(timelineId) {
  const order = orderFromDOM();
  void setSharedOrder(timelineId, order).then((accepted) => {
    if (!accepted) renderViewer();
  });
}

function elevateSheet(sheet, attempt = 0) {
  if (!S.viewer || !sheet) return;
  const element = sheet.element?.[0] || sheet.element;
  if (element?.classList) {
    element.classList.add("ch-elevated-sheet");
    return;
  }
  if (attempt < 20) setTimeout(() => elevateSheet(sheet, attempt + 1), 25);
}

function containModalFocus(container, event) {
  if (event.key !== "Tab") return;
  const focusable = [...container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects?.().length !== 0);
  if (!focusable.length) {
    event.preventDefault();
    container.focus?.();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindViewer(timeline, state) {
  if (S.viewer) S.viewer.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeViewer({ clearWorld: game.user?.isGM });
      return;
    }
    containModalFocus(S.viewer, event);
  };
  if (!S.viewer || !timeline) {
    S.viewer?.querySelector('[data-view="close"]')?.addEventListener("click", () =>
      closeViewer({ clearWorld: game.user?.isGM }));
    return;
  }
  const disabled = S.pending || state.solved[timeline.id]
    || (timeline.maxAttempts > 0 && state.attempts[timeline.id] >= timeline.maxAttempts);
  S.viewer.querySelectorAll(".ch-card").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      if (disabled) return event.preventDefault();
      S.draggedCard = card.dataset.cardId;
      card.classList.add("is-dragging");
      card.setAttribute("aria-grabbed", "true");
      event.dataTransfer?.setData("text/plain", S.draggedCard);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      card.setAttribute("aria-grabbed", "false");
      S.draggedCard = "";
    });
    card.addEventListener("dragover", (event) => {
      if (!disabled) event.preventDefault();
    });
    card.addEventListener("drop", (event) => {
      if (disabled) return;
      event.preventDefault();
      const sourceId = S.draggedCard || event.dataTransfer?.getData("text/plain");
      const after = event.clientX > card.getBoundingClientRect().left
        + card.getBoundingClientRect().width / 2;
      if (!sourceId || !moveCardDOM(sourceId, card.dataset.cardId, after)) return;
      commitViewerOrder(timeline.id);
    });
    card.addEventListener("keydown", (event) => {
      if (disabled || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = orderFromDOM();
      const index = current.indexOf(card.dataset.cardId);
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const targetIndex = event.key === "Home" ? 0
        : event.key === "End" ? current.length - 1
          : index + direction;
      const target = current[targetIndex];
      if (!target || target === card.dataset.cardId
        || !moveCardDOM(card.dataset.cardId, target, targetIndex > index)) return;
      card.focus();
      commitViewerOrder(timeline.id);
    });
    card.addEventListener("pointerdown", (event) => {
      if (disabled || event.pointerType === "mouse" || event.button !== 0
        || event.target.closest("button")) return;
      S.pointerDrag = {
        pointerId: event.pointerId,
        cardId: card.dataset.cardId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      card.setPointerCapture?.(event.pointerId);
      card.setAttribute("aria-grabbed", "true");
    });
    card.addEventListener("pointermove", (event) => {
      const drag = S.pointerDrag;
      if (!drag || drag.pointerId !== event.pointerId || drag.cardId !== card.dataset.cardId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 7) return;
      drag.moved = true;
      event.preventDefault();
      card.classList.add("is-dragging");
      const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest?.(".ch-card");
      if (!target || target === card) return;
      const bounds = target.getBoundingClientRect();
      moveCardDOM(card.dataset.cardId, target.dataset.cardId, event.clientX > bounds.left + bounds.width / 2);
    });
    const finishPointer = (event) => {
      const drag = S.pointerDrag;
      if (!drag || drag.pointerId !== event.pointerId || drag.cardId !== card.dataset.cardId) return;
      card.releasePointerCapture?.(event.pointerId);
      card.classList.remove("is-dragging");
      card.setAttribute("aria-grabbed", "false");
      S.pointerDrag = null;
      if (drag.moved) commitViewerOrder(timeline.id);
    };
    card.addEventListener("pointerup", finishPointer);
    card.addEventListener("pointercancel", finishPointer);
  });
  S.viewer.querySelectorAll("[data-card-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const card = button.closest(".ch-card");
      const direction = Number(button.dataset.cardMove);
      const current = orderFromDOM();
      const index = current.indexOf(card.dataset.cardId);
      const target = current[index + direction];
      if (!target || !moveCardDOM(card.dataset.cardId, target, direction > 0)) return;
      commitViewerOrder(timeline.id);
    });
  });
  S.viewer.querySelector('[data-view="submit"]')?.addEventListener("click", () =>
    void submitTheory(timeline.id, orderFromDOM()));
  S.viewer.querySelector('[data-view="close"]')?.addEventListener("click", () =>
    closeViewer({ clearWorld: game.user?.isGM }));
  S.viewer.querySelector('[data-view="character"]')?.addEventListener("click", () => {
    const sheet = game.user.character?.sheet;
    if (!sheet?.render) return;
    sheet.render(true);
    elevateSheet(sheet);
  });
  S.viewer.querySelector('[data-view="chat"]')?.addEventListener("click", (event) => {
    const active = document.body.classList.toggle("chronicle-chat-open");
    event.currentTarget.setAttribute("aria-pressed", String(active));
    if (active) {
      ui.sidebar?.changeTab?.("chat");
      ui.sidebar?.expand?.();
    }
  });
}

function updateSubmitState() {
  const button = S.viewer?.querySelector('[data-view="submit"]');
  if (!button) return;
  button.disabled = S.pending;
  if (S.pending) button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${esc(t("Pending", "Мастер проверяет версию…"))}`;
}

function clearPending() {
  S.pending = false;
  S.pendingRequestId = "";
  clearTimeout(S.pendingTimer);
  S.pendingTimer = null;
  updateSubmitState();
}

function showOutcome(outcome) {
  if (!outcome?.id || S.seenOutcome === outcome.id) return;
  const project = getProject();
  const timeline = timelineById(project, outcome.timelineId);
  if (!timeline || timeline.id !== outcome.timelineId
    || (!game.user.isGM && !timeline.public)
    || (S.localTimelineId && S.localTimelineId !== timeline.id)) return;
  S.seenOutcome = outcome.id;
  clearPending();
  S.reveal?.remove();
  const solved = outcome.type === "solved";
  const exhausted = outcome.type === "exhausted";
  const title = solved
    ? t("Solved", "Хронология восстановлена")
    : exhausted
      ? t("Exhausted", "Попытки закончились")
      : t("Failed", "Версия не сходится");
  const description = solved
    ? timeline.successText
    : timeline.feedback === "none"
      ? t("NoHint", "В последовательности есть противоречие.")
      : t("Positions", "Событий на верных местах: {count} из {total}", {
          count: outcome.positions,
          total: outcome.total,
        });
  const layer = document.createElement("section");
  layer.id = "chronicle-reveal";
  layer.setAttribute("role", "alertdialog");
  layer.setAttribute("aria-modal", "true");
  layer.innerHTML = `<article class="ch-reveal-card"><i class="fas ${solved ? "fa-link" : exhausted ? "fa-hourglass-end" : "fa-triangle-exclamation"}"></i><span class="ch-kicker">Chronicle</span><h2>${esc(title)}</h2><p>${esc(description)}</p><button type="button">${esc(t("CinematicContinue", "Продолжить расследование"))}</button></article>`;
  document.body.append(layer);
  S.reveal = layer;
  const close = () => {
    layer.remove();
    if (S.reveal === layer) S.reveal = null;
    renderViewer();
    S.viewer?.querySelector('[data-view="submit"]')?.focus?.();
  };
  const button = layer.querySelector("button");
  button.addEventListener("click", close);
  layer.addEventListener("click", (event) => {
    if (event.target === layer) close();
  });
  layer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    containModalFocus(layer, event);
  });
  button.focus?.();
}

function draftTimeline() {
  return S.draft?.timelines.find((timeline) => timeline.id === S.timelineId)
    || S.draft?.timelines[0]
    || null;
}

function reconcileStateAfterProjectEdit(previousProject, project, previousState) {
  const state = normalizeState(previousState, project);
  for (const timeline of project.timelines) {
    const previous = previousProject.timelines.find((item) => item.id === timeline.id);
    const before = previous?.cards.map((card) => card.id).join("|") || "";
    const after = timeline.cards.map((card) => card.id).join("|");
    if (before !== after) {
      state.orders[timeline.id] = seededOrder(
        timeline.cards.map((card) => card.id),
        `${timeline.id}-${Date.now()}`,
      );
      state.attempts[timeline.id] = 0;
      state.solved[timeline.id] = false;
      if (state.lastOutcome?.timelineId === timeline.id) state.lastOutcome = null;
    }
    const previousEffects = new Map((previous?.effects || []).map((effect) => [effect.id, effect]));
    for (const effect of timeline.effects) {
      const old = previousEffects.get(effect.id);
      if (!old || effectFingerprint(old) !== effectFingerprint(effect))
        delete state.deliveries[timeline.id]?.[effect.id];
    }
  }
  return state;
}

function saveDraft(notify = false) {
  if (!game.user.isGM || !S.draft) return Promise.resolve(false);
  if (!requirePrimaryGM(notify)) return Promise.resolve(false);
  const draftSnapshot = clone(S.draft);
  const selectedTimeline = S.timelineId;
  const task = async () => {
    if (!isPrimaryGM()) return false;
    const previousProject = getProject();
    const previousState = getState(previousProject);
    const project = normalizeProject(draftSnapshot);
    await game.settings.set(MOD, "project", project);
    const state = reconcileStateAfterProjectEdit(previousProject, project, previousState);
    state.revision = previousState.revision + 1;
    await game.settings.set(MOD, "state", state);
    game.socket.emit(SOCKET, { type: "state", userId: game.user.id });
    if (S.draft && JSON.stringify(S.draft) === JSON.stringify(draftSnapshot)) {
      S.draft = clone(project);
      S.timelineId = timelineById(project, selectedTimeline)?.id || project.activeTimeline;
    }
    const status = S.editor?.querySelector(".ch-save-state");
    if (status) status.textContent = t("Saved", "Сохранено");
    if (notify) ui.notifications.info(t("Saved", "Сохранено"));
    for (const timeline of project.timelines) {
      if (!state.solved[timeline.id]) continue;
      const pending = timeline.effects.some((effect) =>
        state.deliveries[timeline.id]?.[effect.id]?.status !== "delivered");
      if (pending) void retryConsequences(timeline.id);
    }
    return true;
  };
  S.stateQueue = S.stateQueue.catch(() => undefined).then(task);
  S.saveQueue = S.stateQueue.catch((error) => {
    console.error(`${MOD} | save failed`, error);
    ui.notifications.error(t("SaveFailed", "Не удалось сохранить хронологию. Проверьте консоль Foundry."));
    return false;
  });
  return S.saveQueue;
}

function markDirty() {
  const status = S.editor?.querySelector(".ch-save-state");
  if (status) status.textContent = "…";
}

function caseListHTML(project) {
  return project.timelines.map((timeline) => `<button type="button" data-case-select="${esc(timeline.id)}" class="${timeline.id === S.timelineId ? "is-active" : ""}"><span>${esc(timeline.title)}</span><small>${timeline.cards.length}</small></button>`).join("");
}

function cityPointOptions(effect) {
  let project;
  try { project = game.modules.get("city-viewer")?.api?.getProject?.(); } catch (_) { project = null; }
  const points = (project?.cities || []).flatMap((city) =>
    (city.screens || []).flatMap((screen) =>
      (screen.objects || [])
        .filter((point) => point.kind === "poi")
        .map((point) => ({
          value: `${city.id}::${screen.id}::${point.id}`,
          label: `${city.name} / ${screen.title} / ${point.name}`,
          cityId: city.id,
          screenId: screen.id,
          pointId: point.id,
        })),
    ),
  );
  const exact = points.find((point) =>
    point.cityId === effect.cityId && point.screenId === effect.screenId && point.pointId === effect.pointId);
  const unique = !effect.cityId && !effect.screenId
    ? points.filter((point) => point.pointId === effect.pointId)
    : [];
  const selected = exact?.value || (unique.length === 1 ? unique[0].value : "");
  return `<label class="wide">${esc(t("SelectCityPoint", "Выбрать точку из City Viewer"))}<select data-effect-ref="city"><option value="">${esc(t("ManualIds", "Указать ID вручную"))}</option>${points.map((point) => `<option value="${esc(point.value)}" ${point.value === selected ? "selected" : ""}>${esc(point.label)}</option>`).join("")}</select></label>`;
}

function mindEvidenceOptions(effect) {
  let boards = [];
  try {
    const api = game.modules.get("mind-palace")?.api;
    const value = api?.getBoards?.();
    boards = Array.isArray(value) ? value : value?.boards || [];
    if (!boards.length) boards = api?.getProject?.()?.boards || [];
  } catch (_) { boards = []; }
  const nodes = boards.flatMap((board) =>
    (board.nodes || []).map((node) => ({
      value: `${board.id}::${node.id}`,
      label: `${board.name || board.title || board.id} / ${node.title || node.name || node.id}`,
      boardId: board.id,
      evidenceId: node.id,
    })),
  );
  const exact = nodes.find((node) => node.boardId === effect.boardId && node.evidenceId === effect.evidenceId);
  return `<label class="wide">${esc(t("SelectEvidence", "Выбрать улику из Mind Palace"))}<select data-effect-ref="mind"><option value="">${esc(t("ManualIds", "Указать ID вручную"))}</option>${nodes.map((node) => `<option value="${esc(node.value)}" ${node.value === exact?.value ? "selected" : ""}>${esc(node.label)}</option>`).join("")}</select></label>`;
}

function dialogueVariableOptions(effect) {
  let project;
  try { project = game.modules.get("dialogue-stage")?.api?.getProject?.(); } catch (_) { project = null; }
  const variables = project?.variables || [];
  return `<label class="wide">${esc(t("SelectVariable", "Выбрать переменную из Dialogue Stage"))}<select data-effect-ref="dialogue"><option value="">${esc(t("ManualIds", "Указать ID вручную"))}</option>${variables.map((variable) => `<option value="${esc(variable.id)}" ${variable.id === effect.variableId ? "selected" : ""}>${esc(variable.name || variable.id)}</option>`).join("")}</select></label>`;
}

function effectFields(effect) {
  if (effect.type === "city")
    return `<div class="ch-field-grid">${cityPointOptions(effect)}<label>${esc(t("CityId", "ID города (необязательно)"))}<input data-effect-field="cityId" value="${esc(effect.cityId)}"></label><label>${esc(t("ScreenId", "ID экрана (необязательно)"))}<input data-effect-field="screenId" value="${esc(effect.screenId)}"></label><label class="wide">${esc(t("PointId", "ID точки"))}<input data-effect-field="pointId" value="${esc(effect.pointId)}"></label></div>`;
  if (effect.type === "mind")
    return `<div class="ch-field-grid">${mindEvidenceOptions(effect)}<label>${esc(t("BoardId", "ID доски"))}<input data-effect-field="boardId" value="${esc(effect.boardId)}"></label><label>${esc(t("EvidenceId", "ID улики"))}<input data-effect-field="evidenceId" value="${esc(effect.evidenceId)}"></label></div>`;
  return `<div class="ch-field-grid">${dialogueVariableOptions(effect)}<label>${esc(t("VariableId", "ID переменной"))}<input data-effect-field="variableId" value="${esc(effect.variableId)}"></label><label>${esc(t("Operation", "Операция"))}<select data-effect-field="operation"><option value="set" ${effect.operation === "set" ? "selected" : ""}>${esc(t("Set", "Установить"))}</option><option value="add" ${effect.operation === "add" ? "selected" : ""}>${esc(t("Add", "Увеличить"))}</option></select></label><label class="wide">${esc(t("Value", "Значение"))}<input type="number" step="1" data-effect-field="value" value="${effect.value}"></label></div>`;
}

function editorTimelineHTML(timeline) {
  if (!timeline) return `<div class="ch-empty">${esc(t("Empty", "В этом деле пока нет событий."))}</div>`;
  return `<form class="ch-editor-form" autocomplete="off">
    <section class="ch-editor-section"><div class="ch-section-head"><div><span class="ch-kicker">${esc(t("Case", "Дело"))}</span><h2>${esc(timeline.title)}</h2></div></div><div class="ch-field-grid">
      <label>${esc(t("Title", "Название"))}<input data-timeline-field="title" value="${esc(timeline.title)}"></label>
      <label>${esc(t("Subtitle", "Подзаголовок"))}<input data-timeline-field="subtitle" value="${esc(timeline.subtitle)}"></label>
      <label class="wide">${esc(t("Intro", "Вводная"))}<textarea data-timeline-field="intro">${esc(timeline.intro)}</textarea></label>
      <label class="wide">${esc(t("SuccessText", "Текст решения"))}<textarea data-timeline-field="successText">${esc(timeline.successText)}</textarea></label>
      <label>${esc(t("Visibility", "Доступ игрокам"))}<select data-timeline-field="public"><option value="true" ${timeline.public ? "selected" : ""}>${esc(t("Public", "Публичное"))}</option><option value="false" ${!timeline.public ? "selected" : ""}>${esc(t("Secret", "Скрытое"))}</option></select></label>
      <label>${esc(t("MaxAttempts", "Максимум попыток (0 — без лимита)"))}<input type="number" min="0" max="99" data-timeline-field="maxAttempts" value="${timeline.maxAttempts}"></label>
      <label class="wide">${esc(t("Feedback", "Подсказка после ошибки"))}<select data-timeline-field="feedback"><option value="none" ${timeline.feedback === "none" ? "selected" : ""}>${esc(t("FeedbackNone", "Без подсказки"))}</option><option value="count" ${timeline.feedback === "count" ? "selected" : ""}>${esc(t("FeedbackCount", "Число верных позиций"))}</option><option value="positions" ${timeline.feedback === "positions" ? "selected" : ""}>${esc(t("FeedbackPositions", "Подсветить верные позиции"))}</option></select></label>
    </div></section>
    <section class="ch-editor-section"><div class="ch-section-head"><div><span class="ch-kicker">${esc(t("Events", "События в правильном порядке"))}</span><h2>${esc(t("EditorHint", "Расположите события в правильном порядке. Игроки получат перемешанную копию."))}</h2></div><button type="button" class="ch-primary" data-editor-action="add-card"><i class="fas fa-plus"></i> ${esc(t("AddCard", "Добавить событие"))}</button></div><div class="ch-editor-items">${timeline.cards.map((card, index) => `<article class="ch-editor-item" data-card-editor="${esc(card.id)}"><div class="ch-item-head"><span class="ch-order-number">${index + 1}</span><h3>${esc(card.title)}</h3><div class="ch-mini-actions"><button type="button" data-card-editor-move="-1" title="${esc(t("MoveEarlier", "Переместить раньше"))}" ${index === 0 ? "disabled" : ""}><i class="fas fa-arrow-up"></i></button><button type="button" data-card-editor-move="1" title="${esc(t("MoveLater", "Переместить позже"))}" ${index === timeline.cards.length - 1 ? "disabled" : ""}><i class="fas fa-arrow-down"></i></button><button type="button" class="ch-danger" data-card-delete title="${esc(t("Delete", "Удалить"))}"><i class="fas fa-trash"></i></button></div></div><div class="ch-field-grid"><label>${esc(t("EventTitle", "Название события"))}<input data-card-field="title" value="${esc(card.title)}"></label><label>${esc(t("EventImage", "Изображение или видео"))}<input data-card-field="image" value="${esc(card.image)}"></label><label class="wide">${esc(t("EventText", "Описание"))}<textarea data-card-field="text">${esc(card.text)}</textarea></label></div></article>`).join("") || `<div class="ch-empty">${esc(t("Empty", "В этом деле пока нет событий."))}</div>`}</div></section>
    <section class="ch-editor-section"><div class="ch-section-head"><div><span class="ch-kicker">${esc(t("Consequences", "Последствия решения"))}</span><h2>${esc(t("Consequences", "Последствия решения"))}</h2></div><button type="button" data-editor-action="add-effect"><i class="fas fa-plus"></i> ${esc(t("AddEffect", "Добавить последствие"))}</button></div><div class="ch-editor-items">${timeline.effects.map((effect) => `<article class="ch-editor-item" data-effect-editor="${esc(effect.id)}"><div class="ch-item-head"><span class="ch-item-type">${esc(effect.type)}</span><h3>${esc({city:t("EffectCity", "Открыть точку города"),mind:t("EffectMind", "Открыть улику"),dialogue:t("EffectDialogue", "Изменить переменную истории")}[effect.type])}</h3><button type="button" class="ch-danger" data-effect-delete><i class="fas fa-trash"></i></button></div><label>${esc(t("EffectType", "Тип последствия"))}<select data-effect-field="type"><option value="city" ${effect.type === "city" ? "selected" : ""}>${esc(t("EffectCity", "Открыть точку города"))}</option><option value="mind" ${effect.type === "mind" ? "selected" : ""}>${esc(t("EffectMind", "Открыть улику"))}</option><option value="dialogue" ${effect.type === "dialogue" ? "selected" : ""}>${esc(t("EffectDialogue", "Изменить переменную истории"))}</option></select></label>${effectFields(effect)}</article>`).join("")}</div></section>
  </form>`;
}

function editorHTML(project) {
  const timeline = timelineById(project, S.timelineId);
  return `<aside class="ch-editor-sidebar"><div class="ch-editor-brand"><span class="ch-kicker">Chronicle</span><h1 id="chronicle-editor-title">${esc(t("Edit", "Редактор хронологий"))}</h1><p>${esc(t("EditorHint", "Расположите события в правильном порядке. Игроки получат перемешанную копию."))}</p></div><nav class="ch-case-list">${caseListHTML(project)}</nav><div class="ch-sidebar-actions"><button type="button" data-editor-action="add-case"><i class="fas fa-plus"></i> ${esc(t("AddCase", "Новое дело"))}</button><button type="button" data-editor-action="duplicate-case"><i class="fas fa-copy"></i> ${esc(t("Duplicate", "Дублировать"))}</button><button type="button" class="ch-danger" data-editor-action="delete-case"><i class="fas fa-trash"></i> ${esc(t("Delete", "Удалить"))}</button></div></aside><main class="ch-editor-main"><header class="ch-editor-toolbar"><button type="button" class="ch-primary" data-editor-action="save"><i class="fas fa-floppy-disk"></i> ${esc(t("Save", "Сохранить"))}</button><button type="button" data-editor-action="copy-uuid" title="UUID"><i class="fas fa-link"></i>UUID</button><span class="ch-save-state"></span><span class="spacer"></span><button type="button" data-editor-action="export"><i class="fas fa-file-export"></i> ${esc(t("Export", "Экспорт JSON"))}</button><button type="button" data-editor-action="import"><i class="fas fa-file-import"></i> ${esc(t("Import", "Импорт JSON"))}</button><button type="button" data-editor-action="retry"><i class="fas fa-rotate"></i> ${esc(t("Retry", "Повторить последствия"))}</button><button type="button" data-editor-action="reset"><i class="fas fa-arrow-rotate-left"></i> ${esc(t("Reset", "Сбросить попытку"))}</button><button type="button" data-editor-action="preview"><i class="fas fa-eye"></i> ${esc(t("Preview", "Предпросмотр"))}</button><button type="button" data-editor-action="show"><i class="fas fa-users"></i> ${esc(t("Show", "Показать группе"))}</button><button type="button" data-editor-action="close"><i class="fas fa-xmark"></i> ${esc(t("Close", "Закрыть"))}</button></header><div class="ch-editor-scroll">${editorTimelineHTML(timeline)}</div></main>`;
}

function openEditor() {
  if (!requirePrimaryGM(true)) return false;
  if (S.editor) return true;
  S.draft = getProject();
  S.timelineId = S.draft.activeTimeline;
  S.editorRestoreFocus = typeof document.activeElement?.focus === "function" ? document.activeElement : null;
  S.editor = document.createElement("section");
  S.editor.id = "chronicle-editor";
  S.editor.setAttribute("role", "dialog");
  S.editor.setAttribute("aria-modal", "true");
  S.editor.setAttribute("aria-labelledby", "chronicle-editor-title");
  S.editor.tabIndex = -1;
  document.body.append(S.editor);
  renderEditor();
  S.editor.querySelector('[data-editor-action="close"]')?.focus?.();
  return true;
}

function closeEditor() {
  if (!S.editor) return true;
  void saveDraft(false);
  S.editor.remove();
  S.editor = null;
  S.draft = null;
  S.timelineId = "";
  S.editorRestoreFocus?.focus?.();
  S.editorRestoreFocus = null;
  return true;
}

function renderEditor() {
  if (!S.editor || !S.draft) return;
  S.editor.innerHTML = editorHTML(S.draft);
  S.editor.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeEditor();
      return;
    }
    containModalFocus(S.editor, event);
  };
  bindEditor();
}

function updateTimelineField(timeline, field, value) {
  if (["title", "subtitle", "intro", "successText"].includes(field))
    timeline[field] = text(value, field === "title" ? t("NewCase", "Новое дело") : "", field === "title" ? LIMITS.title : LIMITS.text);
  else if (field === "public") timeline.public = value === "true";
  else if (field === "maxAttempts") timeline.maxAttempts = Math.round(number(value, 0, 0, 99));
  else if (field === "feedback" && ["none", "count", "positions"].includes(value)) timeline.feedback = value;
}

function bindEditor() {
  const editor = S.editor;
  const timeline = draftTimeline();
  if (!editor || !timeline) return;
  editor.querySelectorAll("[data-case-select]").forEach((button) => button.addEventListener("click", () => {
    S.timelineId = button.dataset.caseSelect;
    S.draft.activeTimeline = S.timelineId;
    renderEditor();
  }));
  editor.querySelectorAll("[data-timeline-field]").forEach((field) => field.addEventListener(
    field.matches("select") ? "change" : "input", () => {
    updateTimelineField(timeline, field.dataset.timelineField, field.value);
    markDirty();
  }));
  editor.querySelectorAll("[data-card-editor]").forEach((item) => {
    const card = timeline.cards.find((candidate) => candidate.id === item.dataset.cardEditor);
    if (!card) return;
    item.querySelectorAll("[data-card-field]").forEach((field) => field.addEventListener("input", () => {
      const key = field.dataset.cardField;
      card[key] = text(field.value, key === "title" ? t("NewEvent", "Новое событие") : "", key === "image" ? 1000 : key === "title" ? LIMITS.title : LIMITS.text);
      markDirty();
    }));
    item.querySelectorAll("[data-card-editor-move]").forEach((button) => button.addEventListener("click", () => {
      const index = timeline.cards.indexOf(card);
      const target = index + Number(button.dataset.cardEditorMove);
      if (target < 0 || target >= timeline.cards.length) return;
      [timeline.cards[index], timeline.cards[target]] = [timeline.cards[target], timeline.cards[index]];
      markDirty();
      renderEditor();
    }));
    item.querySelector("[data-card-delete]")?.addEventListener("click", () => {
      timeline.cards = timeline.cards.filter((candidate) => candidate !== card);
      markDirty();
      renderEditor();
    });
  });
  editor.querySelectorAll("[data-effect-editor]").forEach((item) => {
    const effect = timeline.effects.find((candidate) => candidate.id === item.dataset.effectEditor);
    if (!effect) return;
    item.querySelectorAll("[data-effect-field]").forEach((field) => field.addEventListener(
      field.matches("select") ? "change" : "input", () => {
      const key = field.dataset.effectField;
      if (key === "type") {
        effect.type = ["city", "mind", "dialogue"].includes(field.value) ? field.value : "city";
        markDirty();
        renderEditor();
        return;
      }
      if (key === "value") effect.value = number(field.value, 1);
      else if (key === "operation") effect.operation = field.value === "add" ? "add" : "set";
      else effect[key] = text(field.value, "", 128);
      markDirty();
    }));
    item.querySelector("[data-effect-ref]")?.addEventListener("change", (event) => {
      const kind = event.currentTarget.dataset.effectRef;
      const parts = String(event.currentTarget.value || "").split("::");
      if (kind === "city" && parts.length === 3)
        [effect.cityId, effect.screenId, effect.pointId] = parts;
      else if (kind === "mind" && parts.length === 2)
        [effect.boardId, effect.evidenceId] = parts;
      else if (kind === "dialogue" && parts[0]) effect.variableId = parts[0];
      else return;
      markDirty();
      renderEditor();
    });
    item.querySelector("[data-effect-delete]")?.addEventListener("click", () => {
      timeline.effects = timeline.effects.filter((candidate) => candidate !== effect);
      markDirty();
      renderEditor();
    });
  });
  editor.querySelectorAll("[data-editor-action]").forEach((button) => button.addEventListener("click", async () => {
    const action = button.dataset.editorAction;
    if (action === "copy-uuid") { await saveDraft(false); return globalThis.UniCanvasDocuments?.copyUuid(MOD, ["timelines", S.timelineId]); }
    if (action === "close") return closeEditor();
    if (action === "save") return void saveDraft(true);
    if (action === "add-card") {
      if (timeline.cards.length >= LIMITS.cards) return;
      timeline.cards.push({ id: uid("event"), title: t("NewEvent", "Новое событие"), text: "", image: "", icon: "clock-rotate-left" });
      markDirty();
      return renderEditor();
    }
    if (action === "add-effect") {
      if (timeline.effects.length >= LIMITS.effects) return;
      timeline.effects.push(normalizeEffect({ id: uid("effect"), type: "city" }, new Set(timeline.effects.map((effect) => effect.id))));
      markDirty();
      return renderEditor();
    }
    if (action === "add-case") {
      if (S.draft.timelines.length >= LIMITS.timelines) return;
      const created = normalizeTimeline({ id: uid("case"), title: t("NewCase", "Новое дело"), public: true, maxAttempts: 3, feedback: "count", cards: [] }, S.draft.timelines.length, new Set(S.draft.timelines.map((item) => item.id)));
      S.draft.timelines.push(created);
      S.timelineId = created.id;
      S.draft.activeTimeline = created.id;
      return renderEditor();
    }
    if (action === "duplicate-case") {
      if (S.draft.timelines.length >= LIMITS.timelines) return;
      const copied = clone(timeline);
      copied.id = uid("case");
      copied.title = `${timeline.title} — ${t("Duplicate", "Копия")}`.slice(0, LIMITS.title);
      copied.cards = copied.cards.map((card) => ({ ...card, id: uid("event") }));
      copied.effects = copied.effects.map((effect) => ({ ...effect, id: uid("effect") }));
      S.draft.timelines.push(copied);
      S.timelineId = copied.id;
      S.draft.activeTimeline = copied.id;
      return renderEditor();
    }
    if (action === "delete-case") {
      if (S.draft.timelines.length <= 1 || !window.confirm(t("ConfirmDelete", "Удалить выбранное дело?"))) return;
      S.draft.timelines = S.draft.timelines.filter((candidate) => candidate.id !== timeline.id);
      S.timelineId = S.draft.timelines[0].id;
      S.draft.activeTimeline = S.timelineId;
      return renderEditor();
    }
    if (action === "preview") {
      await saveDraft(false);
      return openViewer(timeline.id);
    }
    if (action === "show") {
      await saveDraft(false);
      return void showAll(timeline.id);
    }
    if (action === "reset") return void resetTimeline(timeline.id);
    if (action === "retry") {
      await retryConsequences(timeline.id);
      return ui.notifications.info(t("EffectsRetried", "Последствия проверены повторно."));
    }
    if (action === "export") return exportProject();
    if (action === "import") return chooseImport();
  }));
}

function exportProject() {
  if (!game.user.isGM) return false;
  const project = normalizeProject(S.draft || getProject());
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `chronicle-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return project;
}

function validateImportedProject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.timelines)) return false;
  if (raw.timelines.length < 1 || raw.timelines.length > LIMITS.timelines) return false;
  const seen = new Set();
  const stack = [{ value: raw, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > LIMITS.importNodes || depth > 8) return false;
    if (typeof value === "string") {
      bytes += value.length * 2;
      if (bytes > LIMITS.importBytes) return false;
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) return false;
    seen.add(value);
    const keys = Array.isArray(value) ? [] : Object.keys(value);
    bytes += keys.reduce((total, key) => total + key.length * 2, 0);
    if (bytes > LIMITS.importBytes) return false;
    const entries = Array.isArray(value) ? value : keys.map((key) => value[key]);
    if (entries.length > LIMITS.importNodes) return false;
    for (const entry of entries) stack.push({ value: entry, depth: depth + 1 });
  }
  return raw.timelines.every((timeline) => timeline && typeof timeline === "object"
    && !Array.isArray(timeline)
    && Array.isArray(timeline.cards) && timeline.cards.length <= LIMITS.cards
    && timeline.cards.every((card) => card && typeof card === "object" && !Array.isArray(card))
    && (!timeline.effects || (Array.isArray(timeline.effects)
      && timeline.effects.length <= LIMITS.effects
      && timeline.effects.every((effect) => effect && typeof effect === "object" && !Array.isArray(effect)))));
}

async function replaceProject(raw) {
  if (!requirePrimaryGM(true) || !validateImportedProject(raw)) return false;
  const project = normalizeProject(raw);
  const task = async () => {
    if (!isPrimaryGM()) return false;
    await game.settings.set(MOD, "project", project);
    await game.settings.set(MOD, "state", normalizeState({}, project));
    game.socket.emit(SOCKET, { type: "state", userId: game.user.id });
    if (S.editor) {
      S.draft = clone(project);
      S.timelineId = project.activeTimeline;
      renderEditor();
    }
    return clone(project);
  };
  S.stateQueue = S.stateQueue.catch(() => undefined).then(task);
  return S.stateQueue;
}

function chooseImport() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file || file.size > LIMITS.importBytes) {
      ui.notifications.error(t("ImportFailed", "Файл не похож на проект Chronicle."));
      return;
    }
    try {
      const raw = JSON.parse(await file.text());
      const imported = await replaceProject(raw);
      if (!imported) throw new Error("invalid project");
      ui.notifications.info(t("Imported", "Проект импортирован."));
    } catch (error) {
      console.warn(`${MOD} | import failed`, error);
      ui.notifications.error(t("ImportFailed", "Файл не похож на проект Chronicle."));
    }
  }, { once: true });
  input.click();
}

async function showAll(timelineId = "") {
  if (!requirePrimaryGM(true)) return false;
  const project = getProject();
  const requested = timelineId || project.activeTimeline;
  const timeline = project.timelines.find((item) => item.id === requested);
  if (!timeline) return false;
  const selection = await enqueueStateMutation((state) => {
    if (state.activeTimeline === timeline.id) return { changed: false };
    state.activeTimeline = timeline.id;
    return { changed: true, timelineId: timeline.id };
  });
  if (!selection || !isPrimaryGM()) return false;
  await game.settings.set(MOD, "visible", true);
  game.socket.emit(SOCKET, { type: "show", userId: game.user.id, timelineId: timeline.id });
  openViewer(timeline.id);
  return true;
}

async function hideAll() {
  if (!requirePrimaryGM(true)) return false;
  await game.settings.set(MOD, "visible", false);
  game.socket.emit(SOCKET, { type: "hide", userId: game.user.id });
  closeViewer();
  return true;
}

function allowedPlayerRequest(message) {
  const sender = game.users.get(message.userId);
  if (!sender?.active || sender.isGM || !requestId(message.requestId)) return null;
  const now = Date.now();
  const previous = S.choiceRate.get(sender.id);
  const rate = previous && now - previous.startedAt < 5000
    ? previous
    : { startedAt: now, count: 0 };
  if (rate.count >= 20) return null;
  rate.count += 1;
  S.choiceRate.set(sender.id, rate);
  return sender;
}

function authoritativeMessage(message) {
  const sender = game.users.get(message.userId);
  return Boolean(sender?.active && sender.isGM && sender.id === activeGM()?.id);
}

async function onSocket(message) {
  if (!message || typeof message !== "object") return;
  if (["state", "show", "hide", "receipt"].includes(message.type)) {
    if (!authoritativeMessage(message)) return;
    if (message.type === "hide") {
      if (!game.settings.get(MOD, "visible")) closeViewer();
      return;
    }
    if (message.type === "show") {
      if (game.settings.get(MOD, "visible")) openViewer();
      return;
    }
    if (message.type === "receipt") {
      if (message.targetId !== game.user.id) return;
      const state = getState();
      settleRequestResults(state);
      renderViewer();
      return;
    }
    const state = getState();
    renderViewer();
    if (S.viewer && state.lastOutcome) showOutcome(state.lastOutcome);
    return;
  }
  if (!game.user.isGM || !isPrimaryGM()) return;
  const sender = allowedPlayerRequest(message);
  if (!sender || !validId(message.timelineId)) return;
  if (message.type === "order") {
    await applyOrder(message.timelineId, message.order, sender.id, {
      requestId: message.requestId,
    });
    game.socket.emit(SOCKET, {
      type: "receipt",
      userId: game.user.id,
      targetId: sender.id,
      requestId: message.requestId,
    });
    return;
  }
  if (message.type === "submit") {
    const project = getProject();
    const timeline = timelineById(project, message.timelineId);
    const validTimeline = timeline?.id === message.timelineId;
    const result = validTimeline
      ? await applySubmission(message.timelineId, message.order, {
          requestId: message.requestId,
          userId: sender.id,
        })
      : false;
    game.socket.emit(SOCKET, {
      type: "receipt",
      userId: game.user.id,
      targetId: sender.id,
      requestId: message.requestId,
      ok: Boolean(result),
    });
  }
}

function registerSceneControls(controls) {
  const tools = {
    open: {
      name: "open",
      title: t("Open", "Открыть хронологию"),
      icon: "fa-solid fa-timeline",
      order: 1,
      button: true,
      onChange: () => openViewer(),
    },
  };
  if (game.user.isGM) {
    tools.edit = {
      name: "edit",
      title: t("Edit", "Редактор хронологий"),
      icon: "fa-solid fa-pen-ruler",
      order: 2,
      button: true,
      onChange: () => openEditor(),
    };
    tools.show = {
      name: "show",
      title: t("Show", "Показать группе"),
      icon: "fa-solid fa-users-viewfinder",
      order: 3,
      button: true,
      onChange: () => showAll(),
    };
    tools.hide = {
      name: "hide",
      title: t("Hide", "Закрыть у всех"),
      icon: "fa-solid fa-eye-slash",
      order: 4,
      button: true,
      onChange: () => hideAll(),
    };
  }
  const control = {
    name: "chronicle",
    title: t("Control", "Хронология"),
    icon: "fa-solid fa-clock-rotate-left",
    order: 78,
    visible: true,
    tools,
  };
  if (Array.isArray(controls))
    controls.push({ ...control, layer: "controls", tools: Object.values(tools) });
  else controls.chronicle = control;
}

// A broken optional module must never prevent other modules from adding their
// controls to Foundry's sidebar. Foundry invokes all callbacks from one hook;
// contain Chronicle-only failures here and leave the rest of the UI usable.
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    registerSceneControls(controls);
  } catch (error) {
    console.error(`${MOD} | scene controls unavailable`, error);
  }
});
Hooks.on("userConnected", () => {
  if (!isPrimaryGM()) return;
  const project = getProject();
  const state = getState(project);
  for (const timeline of project.timelines)
    if (state.solved[timeline.id]) void retryConsequences(timeline.id);
});

Hooks.once("init", () => {
  const project = normalizeProject(exampleProject());
  game.settings.register(MOD, "project", {
    name: "Chronicle project",
    scope: "world",
    config: false,
    type: Object,
    default: project,
    onChange: () => {
      if (S.viewer) renderViewer();
    },
  });
  game.settings.register(MOD, "state", {
    name: "Chronicle state",
    scope: "world",
    config: false,
    type: Object,
    default: normalizeState({}, project),
    onChange: (value) => {
      const state = normalizeState(value, getProject());
      if (S.viewer) renderViewer();
      if (S.viewer && state.lastOutcome) showOutcome(state.lastOutcome);
    },
  });
  game.settings.register(MOD, "visible", {
    name: "Chronicle visible",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    onChange: (visible) => {
      if (visible) openViewer();
      else closeViewer();
    },
  });
});

Hooks.once("ready", async () => {
  game.socket.on(SOCKET, onSocket);
  const project = getProject();
  const state = getState(project);
  S.seenOutcome = state.lastOutcome?.id || "";
  if (isPrimaryGM()) {
    const storedProject = game.settings.get(MOD, "project");
    const storedState = game.settings.get(MOD, "state");
    const normalizeStoredData = async () => {
      if (!isPrimaryGM()) return false;
      if (JSON.stringify(storedProject) !== JSON.stringify(project))
        await game.settings.set(MOD, "project", project);
      if (JSON.stringify(storedState) !== JSON.stringify(state))
        await game.settings.set(MOD, "state", state);
      return true;
    };
    S.stateQueue = S.stateQueue.catch(() => undefined).then(normalizeStoredData);
    await S.stateQueue;
    for (const timeline of project.timelines)
      if (state.solved[timeline.id]) void retryConsequences(timeline.id);
  }
  if (game.settings.get(MOD, "visible")) openViewer();
  const module = game.modules.get(MOD);
  module.api = {
    version: "1.1.0",
    open: openViewer,
    close: closeViewer,
    openEditor,
    editEntity(path) {
      if (!game.user.isGM || !openEditor()) return false;
      if (!S.draft.timelines.some(timeline => timeline.id === path[1])) return false;
      S.timelineId = path[1]; renderEditor(); return true;
    },
    getEntityUuid: path => globalThis.UniCanvasDocuments?.uuid(MOD, path),
    listEntities: () => globalThis.UniCanvasDocuments?.list(MOD) || [],
    show: showAll,
    hide: hideAll,
    getProject: getPublicProject,
    getPublicProject,
    getState: getPublicState,
    getPublicState,
    setOrder: setSharedOrder,
    submit: submitTheory,
    resetTimeline,
    retryConsequences,
    replaceProject,
    importProject: replaceProject,
    exportProject,
    validateProject: validateImportedProject,
  };
  Hooks.callAll("chronicle.apiReady", module.api);
  console.log(`${MOD} | ready v${VERSION}`);
});

globalThis.addEventListener?.("pagehide", () => {
  if (game.user?.isGM && S.draft) void saveDraft(false);
});
