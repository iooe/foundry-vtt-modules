const MOD = "city-viewer";
const DATA_VERSION = 9;
const EXPLORATION_VERSION = 1;
const VISIT_EFFECT_VERSION = 1;
const LIMITS = Object.freeze({
  cities: 50,
  screens: 200,
  objects: 750,
  projectObjects: 20_000,
  presets: 500,
  exploration: 20_000,
  visits: 2_000,
  effectReceipts: 1_000,
  effectClaims: 20_000,
  effectRequests: 100,
  narrativeReceipts: 1_000,
  targetOptions: 1_000,
  history: 100,
  undo: 30,
  importBytes: 10 * 1024 * 1024,
});
const EMPTY_SCREEN = {
  title: "Silver Reach",
  subtitle: "The city awaits its heroes",
  showTitle: true,
  showSubtitle: true,
  background: "",
  fit: "cover",
  ambience: "",
  weather: "none",
  weatherIntensity: 1,
  parallax: false,
  parallaxStrength: 14,
  pan: "none",
  cameraZoom: 1.5,
  cameraFollow: true,
  pointStyle: "pin",
  mindPalace: false,
  transition: "fade",
  objects: [],
};
const ACTIONS = {
  info: "Action.Info",
  screen: "Action.Screen",
  macro: "Action.Macro",
  dialogue: "Action.Dialogue",
  check: "Action.Check",
  actor: "Action.Actor",
  chat: "Action.Chat",
  journal: "Action.Journal",
  url: "Action.Url",
};
const S = {
  editor: null,
  viewer: null,
  draft: null,
  city: null,
  screen: null,
  viewCity: null,
  viewScreen: null,
  selected: null,
  clipboard: null,
  history: [],
  viewStates: new Map(),
  weather: null,
  particlesReady: false,
  preview: false,
  timer: null,
  locale: "en",
  messages: {},
  presence: new Map(),
  customActions: new Map(),
  saveQueue: Promise.resolve(),
  saveRevision: 0,
  savedRevision: 0,
  viewerEpoch: 0,
  editorHistory: { undo: [], redo: [], fieldSnapshot: null },
  editorPointerCleanup: null,
  assetPreloads: new Map(),
  navigationToken: 0,
  locationQueue: Promise.resolve(),
  explorationQueue: Promise.resolve(),
  visitQueue: Promise.resolve(),
  visitEffectQueue: Promise.resolve(),
  visitRequestQueue: Promise.resolve(),
  visitEffectRetryTimer: null,
  narrativeQueue: [],
  narrativeActive: false,
  narrativeSeen: new Set(),
  narrativeFlagQueue: Promise.resolve(),
};
const copy = (value) => foundry.utils.deepClone(value);
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
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));
const id = () => foundry.utils.randomID(16);
const tr = (key, fallback = key) => S.messages[key] ?? fallback;
const text = (value, fallback = "", max = 4000) => {
  const result = String(value ?? "").trim();
  return (result || fallback).slice(0, max);
};
const iconClass = (value) =>
  /^fa-[a-z0-9-]{1,48}$/i.test(String(value || ""))
    ? String(value)
    : "fa-location-dot";
const cssColor = (value) =>
  /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%+-]+\)|[a-z]{1,24})$/i.test(
    String(value || ""),
  )
    ? String(value)
    : "#e5bb68";
const cssUrl = (value) => {
  const url = text(value, "", 2048);
  return url ? `url(${JSON.stringify(url)})` : "";
};
const actionId = (value) =>
  /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(value || ""))
    ? String(value)
    : "info";
const TEMPLATE_ASSET_NAMES = new Set([
  "amberwind",
  "bank-v4",
  "city-v4",
  "cursed-cabin",
  "cursed-deck",
  "cursed-hold",
  "dining-v4",
  "docks-v4",
  "fortress-v4",
  "gate-v4",
  "house-v4",
  "market-v4",
  "merchant-v4",
  "murder-cellar",
  "murder-room",
  "murder-tavern",
  "ridge-v4",
  "slums-v4",
  "stonegate-v4",
  "study-v4",
  "topdown",
]);
function migrateTemplateAssetPath(value) {
  const source = text(value, "", 2048),
    match = source.match(
      /^modules\/city-viewer\/assets\/templates\/([^/?#]+)\.png([?#].*)?$/i,
    ),
    baseName = match?.[1]?.toLowerCase();
  if (!baseName || !TEMPLATE_ASSET_NAMES.has(baseName)) return source;
  return `modules/${MOD}/assets/templates/${baseName}.webp${match[2] || ""}`;
}
const TEMPLATE_ASSET = (name) => {
  const cleanName = text(name, "", 160),
    match = cleanName.match(/^([^/?#]+)\.(?:png|webp)$/i),
    baseName = match?.[1]?.toLowerCase(),
    file = baseName && TEMPLATE_ASSET_NAMES.has(baseName)
      ? `${baseName}.webp`
      : cleanName;
  return `modules/${MOD}/assets/templates/${file}`;
};
function registerCleanup(owner, cleanup) {
  if (!owner || typeof cleanup !== "function") return cleanup;
  (owner._cvCleanup ||= new Set()).add(cleanup);
  return cleanup;
}
function cleanupViewerElement(owner) {
  if (!owner || owner._cvCleaned) return;
  owner._cvCleaned = true;
  for (const cleanup of owner._cvCleanup || []) {
    try {
      cleanup();
    } catch (error) {
      console.warn(`${MOD} | Viewer cleanup`, error);
    }
  }
  owner._cvCleanup?.clear?.();
  owner._cvWeather?.destroy?.();
  owner._cvWeather = null;
}
function pushViewerHistory(entry) {
  if (!entry) return;
  const previous = S.history.at(-1);
  const same =
    typeof entry === "object" && typeof previous === "object"
      ? entry.cityId === previous.cityId && entry.screenId === previous.screenId
      : entry === previous;
  if (!same) S.history.push(entry);
  if (S.history.length > LIMITS.history)
    S.history.splice(0, S.history.length - LIMITS.history);
}
function preloadAsset(src, video = false) {
  src = text(src, "", 2048);
  if (!src) return Promise.resolve(false);
  const cached = S.assetPreloads.get(src);
  if (cached) return cached;
  const promise = new Promise((resolve) => {
    const asset = video ? document.createElement("video") : new Image(),
      finish = (loaded) => {
        asset.onload = asset.onerror = asset.onloadedmetadata = null;
        if (!loaded) S.assetPreloads.delete(src);
        resolve(loaded);
      };
    if (video) {
      asset.preload = "metadata";
      asset.onloadedmetadata = () => finish(true);
    } else asset.onload = () => finish(true);
    asset.onerror = () => finish(false);
    asset.src = src;
  });
  S.assetPreloads.set(src, promise);
  if (S.assetPreloads.size > 500)
    S.assetPreloads.delete(S.assetPreloads.keys().next().value);
  return promise;
}
async function preloadScreenAssets(screen, timeout = 2500) {
  if (!screen) return false;
  const jobs = [preloadAsset(screen.background)];
  for (const object of screen.objects || [])
    if (object.kind === "asset") jobs.push(preloadAsset(object.src, object.media === "video"));
  const completed = Promise.allSettled(jobs);
  let timerId;
  const timer = new Promise((resolve) => {
    timerId = setTimeout(() => resolve("timeout"), timeout);
  });
  const result = await Promise.race([completed, timer]);
  clearTimeout(timerId);
  return result !== "timeout";
}
async function loadLanguage(code = "en") {
  S.locale = ["en", "ru"].includes(code) ? code : "en";
  try {
    const response = await fetch(`modules/${MOD}/lang/${S.locale}.json`);
    S.messages = response.ok ? await response.json() : {};
  } catch (error) {
    console.warn(`${MOD} | Language`, error);
    S.messages = {};
  }
}
async function setLanguage(code) {
  await game.settings.set(MOD, "language", code);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(1_000_000_000, Math.max(-1_000_000_000, number))
    : fallback;
}
function normalizeVisitEffect(raw = {}) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const narrative =
      raw.narrative && typeof raw.narrative === "object"
        ? raw.narrative
        : {},
    cityTarget =
      raw.city && typeof raw.city === "object" ? raw.city : {},
    mindTarget =
      raw.mind && typeof raw.mind === "object" ? raw.mind : {},
    storyTarget =
      raw.story && typeof raw.story === "object" ? raw.story : {},
    chronicleTarget =
      raw.chronicle && typeof raw.chronicle === "object"
        ? raw.chronicle
        : {};
  return {
    id: text(raw.id, "default", 128),
    enabled: raw.enabled === true,
    scope: raw.scope === "personal" ? "personal" : "group",
    repeatable: raw.repeatable === true,
    narrative: {
      enabled: narrative.enabled === true,
      title: text(narrative.title, "", 240),
      text: text(narrative.text, "", 4000),
    },
    city: {
      enabled: cityTarget.enabled === true,
      cityId: text(cityTarget.cityId, "", 128),
      screenId: text(cityTarget.screenId, "", 128),
      pointId: text(cityTarget.pointId, "", 128),
    },
    mind: {
      enabled: mindTarget.enabled === true,
      boardId: text(mindTarget.boardId, "", 128),
      nodeId: text(mindTarget.nodeId, "", 128),
    },
    story: {
      enabled: storyTarget.enabled === true,
      variableId: text(storyTarget.variableId, "", 128),
      operation: storyTarget.operation === "add" ? "add" : "set",
      value: finiteNumber(storyTarget.value),
    },
    chronicle: {
      enabled: chronicleTarget.enabled === true,
      timelineId: text(chronicleTarget.timelineId, "", 128),
    },
  };
}
function visitEffectOutputs(effect) {
  if (!effect?.enabled) return [];
  const outputs = [];
  if (effect.narrative.enabled && (effect.narrative.title || effect.narrative.text))
    outputs.push("narrative");
  if (
    effect.city.enabled &&
    effect.city.cityId &&
    effect.city.screenId &&
    effect.city.pointId
  )
    outputs.push("city");
  if (effect.mind.enabled && effect.mind.boardId && effect.mind.nodeId)
    outputs.push("mind");
  if (effect.story.enabled && effect.story.variableId) outputs.push("story");
  if (effect.chronicle.enabled && effect.chronicle.timelineId)
    outputs.push("chronicle");
  return outputs;
}

function normalizeScreen(raw = {}) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const data = foundry.utils.mergeObject(copy(EMPTY_SCREEN), copy(raw), {
    inplace: false,
    insertKeys: true,
    overwrite: true,
  });
  data.id = text(data.id, id(), 128);
  data.title = text(data.title, tr("Default.NewScreen", "New screen"), 160);
  data.subtitle = text(data.subtitle, "", 500);
  data.background = migrateTemplateAssetPath(data.background);
  data.ambience = text(data.ambience, "", 2048);
  data.fit = ["cover", "contain"].includes(data.fit) ? data.fit : "cover";
  data.weather = ["none", "rain", "snow", "fog", "embers"].includes(data.weather)
    ? data.weather
    : "none";
  data.weatherIntensity = clamp(data.weatherIntensity ?? 1, 0.5, 2);
  data.parallaxStrength = clamp(data.parallaxStrength ?? 14, 0, 40);
  data.pan = ["none", "vertical", "horizontal", "free"].includes(data.pan)
    ? data.pan
    : "none";
  data.pointStyle = ["pin", "map"].includes(data.pointStyle)
    ? data.pointStyle
    : "pin";
  data.transition = ["fade", "slide", "zoom", "blur", "iris"].includes(
    data.transition,
  )
    ? data.transition
    : "fade";
  data.objects = (Array.isArray(data.objects) ? data.objects : [])
    .filter((object) => object && typeof object === "object" && !Array.isArray(object))
    .slice(0, LIMITS.objects)
    .map(
    (o, i) => ({
      id: text(o.id, id(), 128),
      name: text(o.name, `${tr("Default.Object", "New object")} ${i + 1}`, 160),
      kind: o.kind === "poi" ? "poi" : "asset",
      src: migrateTemplateAssetPath(text(o.src, "icons/svg/castle.svg", 2048)),
      media: o.media === "video" ? "video" : "image",
      markerImage: text(o.markerImage, "", 2048),
      imageFolder: text(o.imageFolder, "", 2048),
      imageSource: ["data", "public", "s3"].includes(o.imageSource) ? o.imageSource : "data",
      imageBucket: text(o.imageBucket, "", 256),
      imagePool: (Array.isArray(o.imagePool) ? o.imagePool : []).filter(v => typeof v === "string" && /\.(png|jpe?g|webp|gif|avif|svg)(?:\?.*)?$/i.test(v)).slice(0, 1000),
      markerIcon: iconClass(o.markerIcon),
      markerColor: cssColor(o.markerColor),
      x: clamp(o.x ?? 38, 0, 100),
      y: clamp(o.y ?? 31, 0, 100),
      w: clamp(o.w ?? 22, 2, 100),
      h: clamp(o.h ?? 30, 2, 100),
      rotation: Number(o.rotation) || 0,
      opacity: clamp(o.opacity ?? 1, 0.05, 1),
      z: Number.isFinite(Number(o.z)) ? clamp(Math.trunc(Number(o.z)), -10000, 10000) : i + 1,
      interactive: o.interactive !== false,
      action: actionId(o.action || "info"),
      actionTitle: text(o.actionTitle, o.name || tr("Default.Inspect", "Inspect"), 240),
      hint: text(o.hint, tr("Default.Hint", "Click to inspect this place."), 1200),
      value: text(o.value, "", 10000),
      sound: text(o.sound, "", 2048),
      actorUuid: text(o.actorUuid, "", 512),
      journalUuid: text(o.journalUuid, "", 512),
      checkType: ["skill", "ability", "save"].includes(o.checkType) ? o.checkType : "skill",
      checkKey: text(o.checkKey, "prc", 32),
      checkDC: clamp(o.checkDC ?? 10, 0, 99),
      checkTarget: o.checkTarget === "all" ? "all" : "self",
      pointState: ["visible", "secret", "locked"].includes(
        o.pointState || o.visibility,
      )
        ? o.pointState || o.visibility
        : o.locked === true
          ? "locked"
          : o.secret === true
            ? "secret"
            : "visible",
      lockReason: text(o.lockReason, "", 1000),
      visitMode: ["none", "personal", "group"].includes(
        o.visitMode || o.visitedMode,
      )
        ? o.visitMode || o.visitedMode
        : "none",
      visitEffect: normalizeVisitEffect(o.visitEffect || o.firstVisit),
    }),
  );
  data.cameraZoom = clamp(data.cameraZoom ?? 1.5, 1, 3);
  data.cameraFollow = data.cameraFollow !== false;
  return {
    id: data.id,
    title: data.title,
    subtitle: data.subtitle,
    showTitle: data.showTitle !== false,
    showSubtitle: data.showSubtitle !== false,
    background: data.background,
    backgroundFolder: text(data.backgroundFolder, "", 2048),
    backgroundPool: (Array.isArray(data.backgroundPool) ? data.backgroundPool : []).filter(v => typeof v === "string" && /\.(png|jpe?g|webp|gif|avif|svg)(?:\?.*)?$/i.test(v)).slice(0, 1000),
    backgroundSource: ["data", "public", "s3"].includes(data.backgroundSource) ? data.backgroundSource : "data",
    backgroundBucket: text(data.backgroundBucket, "", 256),
    fit: data.fit,
    ambience: data.ambience,
    weather: data.weather,
    weatherIntensity: data.weatherIntensity,
    parallax: data.parallax === true,
    parallaxStrength: data.parallaxStrength,
    pan: data.pan,
    cameraZoom: data.cameraZoom,
    cameraFollow: data.cameraFollow,
    pointStyle: data.pointStyle,
    mindPalace: data.mindPalace === true,
    transition: data.transition,
    objects: data.objects,
  };
}

function normalizeCity(raw = {}) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const validScreens = Array.isArray(raw.screens)
    ? raw.screens.filter((screen) => screen && typeof screen === "object" && !Array.isArray(screen))
    : [];
  if (validScreens.length) {
    const screens = validScreens.slice(0, LIMITS.screens).map(normalizeScreen);
    return {
      id: text(raw.id, id(), 128),
      name: text(raw.name, screens[0].title || tr("Default.NewCity", "New city"), 160),
      startScreen: screens.some((s) => s.id === raw.startScreen)
        ? raw.startScreen
        : screens[0].id,
      screens,
    };
  }
  const first = normalizeScreen(raw);
  return {
    id: raw.id || id(),
    name: raw.name || first.title || tr("Default.NewCity", "New city"),
    startScreen: first.id,
    screens: [first],
  };
}

function addDialogueExample(project) {
  for (const c of project.cities) {
    if (!/silver reach|серебряный предел|alchemist|алхим/i.test(c.name))
      continue;
    if (c.screens.some((screen) => screen.objects.some((o) => o.action === "dialogue")))
      continue;
    const screen =
      c.screens.find((item) => /market|рын|study|кабинет/i.test(item.title)) ||
      c.screens[0];
    screen.objects.push(
      normalizeScreen({
        objects: [
          {
            id: "dialogue-ilyan-vey",
            kind: "poi",
            name: "Алхимик Ильян",
            x: 68,
            y: 49,
            w: 5,
            h: 9,
            markerIcon: "fa-user",
            markerColor: "#b96e46",
            action: "dialogue",
            actionTitle: "Поговорить с Ильяном",
            hint: "Расспросить алхимика о запечатанном письме",
            value: "arrival",
          },
        ],
      }).objects[0],
    );
  }
  return project;
}
function addExplorationExample(project) {
  for (const c of project.cities) {
    if (
      c.screens.some((screen) =>
        screen.objects.some((object) => object.id === "north-workshops"),
      )
    )
      continue;
    const hasExampleDialogue = c.screens.some((screen) =>
      screen.objects.some(
        (object) =>
          object.id === "dialogue-ilyan-vey" ||
          (object.kind === "poi" &&
            object.action === "dialogue" &&
            object.value === "arrival" &&
            /ilyan|ильян/i.test(object.name)),
      ),
    );
    if (
      !hasExampleDialogue &&
      !/^(?:silver reach|серебряный предел)$/i.test(c.name)
    )
      continue;
    const target =
      c.screens.find((screen) => screen.id === c.startScreen) || c.screens[0];
    if (!target || target.objects.length >= LIMITS.objects) continue;
    target.objects.push(
      normalizeScreen({ objects: [northWorkshopsPoint()] }).objects[0],
    );
  }
  return project;
}
function addVisitEffectExample(project) {
  const exampleEffect = normalizeVisitEffect(northWorkshopsPoint().visitEffect);
  for (const c of project.cities) {
    const recognized =
      /^(?:silver reach|серебряный предел)$/i.test(c.name) ||
      c.screens.some((screen) =>
        screen.objects.some(
          (object) =>
            object.id === "dialogue-ilyan-vey" ||
            (object.action === "dialogue" &&
              object.value === "arrival" &&
              /ilyan|ильян/i.test(object.name)),
        ),
      );
    if (!recognized) continue;
    const point = c.screens
      .flatMap((screen) => screen.objects)
      .find((object) => object.id === "north-workshops");
    if (
      !point ||
      point.kind !== "poi" ||
      point.action !== "info" ||
      point.pointState !== "secret" ||
      point.visitMode !== "group" ||
      point.visitEffect?.enabled
    )
      continue;
    point.visitEffect = exampleEffect;
  }
  return project;
}

function city(raw = {}) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const validCities = Array.isArray(raw.cities)
    ? raw.cities.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
  if (validCities.length) {
    const cities = validCities.slice(0, LIMITS.cities).map(normalizeCity);
    const activeCity = cities.some((c) => c.id === raw.activeCity)
      ? raw.activeCity
      : cities[0].id;
    const active = cities.find((c) => c.id === activeCity);
    const project = {
      version: DATA_VERSION,
      activeCity,
      activeScreen: active.screens.some((screen) => screen.id === raw.activeScreen)
        ? raw.activeScreen
        : active.startScreen,
      cities,
    };
    const version = Number(raw.version || 0);
    if (version < 4) addDialogueExample(project);
    if (version < 8) {
      // The first dialogue demo shipped before every saved Silver Reach example
      // contained its Ilyan point. Re-run the narrow, idempotent migration while
      // upgrading to v8 so those existing examples receive the gameplay loop too.
      addDialogueExample(project);
      addExplorationExample(project);
    }
    if (version < 9) addVisitEffectExample(project);
    return project;
  }
  const first = normalizeCity(raw);
  const project = addDialogueExample({
    version: DATA_VERSION,
    activeCity: first.id,
    activeScreen: first.startScreen,
    cities: [first],
  });
  return addVisitEffectExample(addExplorationExample(project));
}
function editCity() {
  return S.draft?.cities.find((c) => c.id === S.city) || S.draft?.cities[0];
}
function editScreen() {
  const c = editCity();
  return c?.screens.find((s) => s.id === S.screen) || c?.screens[0];
}
function projectCity(project, cityId) {
  return (
    project.cities.find((c) => c.id === cityId) ||
    project.cities.find((c) => c.id === project.activeCity) ||
    project.cities[0]
  );
}
function projectScreen(projectCity, screenId) {
  return (
    projectCity.screens.find((s) => s.id === screenId) ||
    projectCity.screens.find((s) => s.id === projectCity.startScreen) ||
    projectCity.screens[0]
  );
}

function pointKey(cityId, screenId, pointId) {
  return [cityId, screenId, pointId]
    .map((part) => {
      const value = text(part, "", 128),
        wellFormed = value.toWellFormed
          ? value.toWellFormed()
          : value.replace(
              /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
              "\uFFFD",
            );
      return encodeURIComponent(wellFormed);
    })
    .join("/");
}
function findPoint(project, cityId, screenId, pointId) {
  const targetCity = project?.cities?.find((item) => item.id === cityId),
    targetScreen = targetCity?.screens?.find((item) => item.id === screenId),
    point = targetScreen?.objects?.find(
      (item) => item.id === pointId && item.kind === "poi",
    );
  return point ? { city: targetCity, screen: targetScreen, point } : null;
}
function validPointKeys(project) {
  const keys = new Set();
  for (const targetCity of project?.cities || [])
    for (const targetScreen of targetCity.screens || [])
      for (const point of targetScreen.objects || [])
        if (point.kind === "poi")
          keys.add(pointKey(targetCity.id, targetScreen.id, point.id));
  return keys;
}
function normalizeExplorationStore(raw = {}, project = null, prune = false) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const source =
      raw.points && typeof raw.points === "object" && !Array.isArray(raw.points)
        ? raw.points
        : {},
    valid = prune && project ? validPointKeys(project) : null,
    entries = [];
  for (const [key, value] of Object.entries(source)) {
    if (
      !key ||
      key.length > 512 ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (valid && !valid.has(key))
    )
      continue;
    const state = ["visible", "secret", "locked"].includes(value.state)
      ? value.state
      : "visible";
    entries.push([
      key,
      {
        state,
        lockReason: state === "locked" ? text(value.lockReason, "", 1000) : "",
        updatedAt: Math.max(0, Number(value.updatedAt) || 0),
        updatedBy: text(value.updatedBy, "", 128),
      },
    ]);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return {
    version: EXPLORATION_VERSION,
    points: Object.fromEntries(entries.slice(0, LIMITS.exploration)),
  };
}
function normalizeVisitRecord(raw = {}, project = null) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const source =
      raw.points && typeof raw.points === "object" && !Array.isArray(raw.points)
        ? raw.points
        : raw,
    valid = project ? validPointKeys(project) : null,
    entries = Object.entries(source)
      .filter(
        ([key, at]) =>
          key !== "version" &&
          key.length <= 512 &&
          Number.isFinite(Number(at)) &&
          (!valid || valid.has(key)),
      )
      .map(([key, at]) => [key, Math.max(0, Number(at))])
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIMITS.visits);
  return { version: 1, points: Object.fromEntries(entries) };
}
function userVisitRecord(user, project = null) {
  let raw = {};
  try {
    raw = user?.getFlag?.(MOD, "visitedPoints") ||
      user?.flags?.[MOD]?.visitedPoints ||
      {};
  } catch {
    raw = {};
  }
  return normalizeVisitRecord(raw, project);
}
function worldUsers() {
  if (Array.isArray(game.users?.contents)) return game.users.contents;
  try {
    return [...(game.users || [])];
  } catch {
    return [];
  }
}
function buildExplorationContext(
  project,
  cityId,
  screenId,
  userId = game.user?.id,
  store = null,
) {
  const exploration =
      store ||
      normalizeExplorationStore(
        game.settings.get(MOD, "exploration"),
        project,
        false,
      ),
    visitedBy = new Map();
  for (const user of worldUsers().filter((candidate) => !candidate?.isGM))
    for (const key of Object.keys(userVisitRecord(user, project).points)) {
      const users = visitedBy.get(key) || [];
      users.push(user.id);
      visitedBy.set(key, users);
    }
  return { project, cityId, screenId, userId, exploration, visitedBy };
}
function explorationForPoint(point, context) {
  const key = pointKey(context.cityId, context.screenId, point.id),
    override = context.exploration.points[key],
    state = override?.state || point.pointState || "visible",
    visitedBy = context.visitedBy.get(key) || [],
    groupVisited = visitedBy.length > 0,
    personalVisited = visitedBy.includes(context.userId),
    visited =
      point.visitMode === "group"
        ? groupVisited
        : point.visitMode === "personal"
          ? personalVisited
          : false;
  return {
    key,
    cityId: context.cityId,
    screenId: context.screenId,
    pointId: point.id,
    configuredState: point.pointState || "visible",
    state,
    lockReason:
      state === "locked"
        ? override?.lockReason ||
          point.lockReason ||
          tr("Exploration.LockedDefault", "This place is currently inaccessible.")
        : "",
    visitMode: point.visitMode || "none",
    visited,
    personalVisited,
    groupVisited,
    visitedBy: [...visitedBy],
    updatedAt: override?.updatedAt || 0,
    updatedBy: override?.updatedBy || "",
  };
}
function getExplorationState(
  cityId = S.viewCity,
  screenId = S.viewScreen,
  pointId = null,
  options = {},
) {
  if (cityId && typeof cityId === "object") {
    options = cityId;
    cityId = options.cityId || S.viewCity;
    screenId = options.screenId || S.viewScreen;
    pointId = options.pointId || null;
  }
  if (!options || typeof options !== "object" || Array.isArray(options))
    options = {};
  const project = city(game.settings.get(MOD, "city")),
    targetCity = project.cities.find((item) => item.id === cityId),
    targetScreen = targetCity?.screens.find((item) => item.id === screenId);
  if (!targetCity || !targetScreen) return pointId ? null : [];
  const requestedUserId = text(options.userId, game.user?.id, 128),
    effectiveUserId = game.user?.isGM ? requestedUserId : game.user?.id;
  const context = buildExplorationContext(
    project,
    targetCity.id,
    targetScreen.id,
    effectiveUserId,
  );
  if (pointId) {
    const point = targetScreen.objects.find(
      (item) => item.id === pointId && item.kind === "poi",
    );
    return point ? explorationForPoint(point, context) : null;
  }
  return targetScreen.objects
    .filter((item) => item.kind === "poi")
    .map((point) => explorationForPoint(point, context));
}
function findUniquePointReference(pointId, options = {}) {
  const project = city(game.settings.get(MOD, "city")),
    cleanPointId = text(pointId, "", 128),
    cityId = text(options.cityId, "", 128),
    screenId = text(options.screenId, "", 128),
    matches = [];
  if (!cleanPointId) throw new TypeError("A point id is required.");
  for (const targetCity of project.cities) {
    if (cityId && targetCity.id !== cityId) continue;
    for (const targetScreen of targetCity.screens) {
      if (screenId && targetScreen.id !== screenId) continue;
      for (const point of targetScreen.objects.filter(
        (item) => item.kind === "poi" && item.id === cleanPointId,
      ))
        matches.push({
          cityId: targetCity.id,
          screenId: targetScreen.id,
          pointId: point.id,
        });
    }
  }
  if (!matches.length)
    throw new RangeError("The requested point does not exist.");
  if (matches.length > 1)
    throw new RangeError(
      "The point id is ambiguous; provide cityId and screenId in options.",
    );
  return { ...matches[0], options };
}
function resolvePointMutation(cityId, screenId, pointId, options = {}) {
  if (
    pointId === undefined &&
    (screenId === undefined ||
      (screenId && typeof screenId === "object" && !Array.isArray(screenId)))
  )
    return findUniquePointReference(cityId, screenId || {});
  return {
    cityId: text(cityId, "", 128),
    screenId: text(screenId, "", 128),
    pointId: text(pointId, "", 128),
    options:
      options && typeof options === "object" && !Array.isArray(options)
        ? options
        : {},
  };
}
async function updatePointAccess(
  cityId,
  screenId,
  pointId,
  state,
  reason = "",
  options = {},
) {
  if (!game.user.isGM)
    throw new Error("Only a Game Master may change point access.");
  if (!["visible", "secret", "locked"].includes(state))
    throw new TypeError("Invalid exploration state.");
  const task = async () => {
    const project = city(game.settings.get(MOD, "city")),
      location = findPoint(project, cityId, screenId, pointId);
    if (!location) throw new RangeError("The requested point does not exist.");
    const store = normalizeExplorationStore(
        game.settings.get(MOD, "exploration"),
        project,
        true,
      ),
      key = pointKey(cityId, screenId, pointId),
      previous = explorationForPoint(
        location.point,
        buildExplorationContext(project, cityId, screenId, game.user.id, store),
      ),
      nextReason =
        state === "locked"
          ? text(reason, location.point.lockReason, 1000)
          : "",
      nextEffectiveReason =
        state === "locked"
          ? nextReason ||
            location.point.lockReason ||
            tr(
              "Exploration.LockedDefault",
              "This place is currently inaccessible.",
            )
          : "";
    if (
      previous.state === state &&
      (state !== "locked" || previous.lockReason === nextEffectiveReason)
    )
      return { ...previous, changed: false };
    store.points[key] = {
      state,
      lockReason: nextReason,
      updatedAt: Date.now(),
      updatedBy: game.user.id,
    };
    const limited = normalizeExplorationStore(store, project, true);
    await game.settings.set(MOD, "exploration", limited);
    const current = explorationForPoint(
      location.point,
      buildExplorationContext(project, cityId, screenId, game.user.id, limited),
    );
    const payload = {
      ...current,
      previous,
      changed: true,
      source: text(options.source, "", 128),
    };
    Hooks.callAll("cityViewer.explorationChanged", copy(payload));
    Hooks.callAll(
      {
        visible: "cityViewer.pointRevealed",
        secret: "cityViewer.pointHidden",
        locked: "cityViewer.pointLocked",
      }[state],
      copy(payload),
    );
    return { ...current, changed: true };
  };
  S.explorationQueue = S.explorationQueue.catch(() => undefined).then(task);
  return S.explorationQueue;
}
async function revealPoint(cityId, screenId, pointId, options = {}) {
  const ref = resolvePointMutation(cityId, screenId, pointId, options);
  return updatePointAccess(
    ref.cityId,
    ref.screenId,
    ref.pointId,
    "visible",
    "",
    ref.options,
  );
}
async function hidePoint(cityId, screenId, pointId, options = {}) {
  const ref = resolvePointMutation(cityId, screenId, pointId, options);
  return updatePointAccess(
    ref.cityId,
    ref.screenId,
    ref.pointId,
    "secret",
    "",
    ref.options,
  );
}
async function lockPoint(cityId, screenId, pointId, reason = "", options = {}) {
  if (typeof pointId !== "string") {
    const compactOptions =
        pointId && typeof pointId === "object" && !Array.isArray(pointId)
          ? pointId
          : screenId && typeof screenId === "object" && !Array.isArray(screenId)
            ? screenId
          : {},
      compactReason = typeof screenId === "string" ? screenId : "",
      ref = findUniquePointReference(cityId, compactOptions);
    return updatePointAccess(
      ref.cityId,
      ref.screenId,
      ref.pointId,
      "locked",
      compactReason,
      compactOptions,
    );
  }
  return updatePointAccess(
    cityId,
    screenId,
    pointId,
    "locked",
    reason,
    options,
  );
}
async function unlockPoint(cityId, screenId, pointId, options = {}) {
  const ref = resolvePointMutation(cityId, screenId, pointId, options);
  const result = await updatePointAccess(
    ref.cityId,
    ref.screenId,
    ref.pointId,
    "visible",
    "",
    ref.options,
  );
  if (result?.changed)
    Hooks.callAll("cityViewer.pointUnlocked", copy(result));
  return result;
}
function markPointVisited(point, cityId = S.viewCity, screenId = S.viewScreen) {
  if (
    game.user?.isGM ||
    !point ||
    point.kind !== "poi" ||
    !["personal", "group"].includes(point.visitMode)
  )
    return Promise.resolve(null);
  const task = async () => {
    const project = city(game.settings.get(MOD, "city")),
      location = findPoint(project, cityId, screenId, point.id);
    if (!location || typeof game.user?.setFlag !== "function") return null;
    const key = pointKey(cityId, screenId, point.id),
      visits = userVisitRecord(game.user, project);
    if (visits.points[key]) return getExplorationState(cityId, screenId, point.id);
    visits.points[key] = Date.now();
    const normalized = normalizeVisitRecord(visits, project);
    await game.user.setFlag(MOD, "visitedPoints", normalized);
    const current = getExplorationState(cityId, screenId, point.id);
    refreshExplorationViewer();
    Hooks.callAll("cityViewer.pointVisited", copy(current));
    return current;
  };
  S.visitQueue = S.visitQueue.catch(() => undefined).then(task);
  return S.visitQueue;
}
function refreshExplorationViewer() {
  const view = S.viewer?.querySelector?.(".cv-view");
  if (!view || !S.viewCity || !S.viewScreen) return;
  const project = city(game.settings.get(MOD, "city")),
    targetCity = project.cities.find((item) => item.id === S.viewCity),
    targetScreen = targetCity?.screens.find((item) => item.id === S.viewScreen);
  if (!targetCity || !targetScreen) return;
  const context = buildExplorationContext(
      project,
      targetCity.id,
      targetScreen.id,
    ),
    template = document.createElement("template"),
    container = view.querySelector(".cv-pan-world") || view;
  S.viewer._cvExplorationContext = context;
  container
    .querySelectorAll(":scope > .cv-object.is-poi")
    .forEach((node) => node.remove());
  template.innerHTML = targetScreen.objects
    .filter((item) => item.kind === "poi")
    .map((point) => objectHTML(point, false, context))
    .join("");
  const card = view.querySelector(".cv-card");
  if (container === view && card) card.before(template.content);
  else container.append(template.content);
  view.querySelector(".cv-card")?.classList.remove("visible");
}

function isPrimaryGM() {
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM;
  if (active) return active.id === game.user.id;
  const candidates = worldUsers()
    .filter((user) => user?.active && user?.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return !candidates.length || candidates[0].id === game.user.id;
}
function effectRequestId(value) {
  const clean = text(value, "", 200);
  if (["__proto__", "prototype", "constructor"].includes(clean.toLowerCase()))
    return "";
  return /^[A-Za-z0-9._:-]{8,200}$/.test(clean) ? clean : "";
}
function normalizeVisitEffectRequests(raw = {}) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seen = new Set(),
    requests = (Array.isArray(raw.requests) ? raw.requests : [])
      .slice(-LIMITS.effectRequests * 2)
      .flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const id = effectRequestId(entry.id),
          cityId = text(entry.cityId, "", 128),
          screenId = text(entry.screenId, "", 128),
          pointId = text(entry.pointId, "", 128),
          source = text(entry.source, "viewer", 128),
          at = Math.max(0, Number(entry.at) || 0),
          now = Date.now();
        if (
          !id ||
          seen.has(id) ||
          !cityId ||
          !screenId ||
          !pointId ||
          !at ||
          at > now + 60_000 ||
          at < now - 180 * 24 * 60 * 60_000
        )
          return [];
        seen.add(id);
        return [{ id, cityId, screenId, pointId, source, at }];
      })
      .sort((a, b) => a.at - b.at)
      .slice(-LIMITS.effectRequests);
  return { version: VISIT_EFFECT_VERSION, requests };
}
function userEffectRequests(user) {
  let raw = {};
  try {
    raw =
      user?.getFlag?.(MOD, "visitEffectRequests") ||
      user?.flags?.[MOD]?.visitEffectRequests ||
      {};
  } catch {
    raw = {};
  }
  return normalizeVisitEffectRequests(raw);
}
function normalizeNarrativeReceipts(raw = {}) {
  const values = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.ids)
      ? raw.ids
      : [];
  return {
    version: VISIT_EFFECT_VERSION,
    ids: Array.from(
      new Set(values.map(effectRequestId).filter(Boolean).slice(-LIMITS.narrativeReceipts)),
    ),
  };
}
function normalizeDeliveryPart(raw = {}, type = "") {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const status = ["pending", "delivered", "blocked", "skipped"].includes(
    raw.status,
  )
    ? raw.status
    : "pending";
  if (type === "narrative")
    return {
      status,
      title: text(raw.title, "", 240),
      text: text(raw.text, "", 4000),
      deliveredAt: Math.max(0, Number(raw.deliveredAt) || 0),
      error: text(raw.error, "", 500),
    };
  if (type === "city")
    return {
      status,
      cityId: text(raw.cityId, "", 128),
      screenId: text(raw.screenId, "", 128),
      pointId: text(raw.pointId, "", 128),
      error: text(raw.error, "", 500),
    };
  if (type === "mind")
    return {
      status,
      boardId: text(raw.boardId, "", 128),
      nodeId: text(raw.nodeId, "", 128),
      error: text(raw.error, "", 500),
    };
  if (type === "chronicle")
    return {
      status,
      timelineId: text(raw.timelineId, "", 128),
      error: text(raw.error, "", 500),
    };
  return {
    status,
    variableId: text(raw.variableId, "", 128),
    operation: raw.operation === "add" ? "add" : "set",
    value: finiteNumber(raw.value),
    base:
      raw.base === null || raw.base === undefined
        ? null
        : finiteNumber(raw.base),
    target:
      raw.target === null || raw.target === undefined
        ? null
        : finiteNumber(raw.target),
    error: text(raw.error, "", 500),
  };
}
function normalizeVisitEffectLedger(raw = {}) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const sourceReceipts =
      raw.receipts && typeof raw.receipts === "object" && !Array.isArray(raw.receipts)
        ? raw.receipts
        : {},
    receipts = [];
  for (const [key, value] of Object.entries(sourceReceipts)) {
    const id = effectRequestId(key);
    if (!id || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const ref = value.ref && typeof value.ref === "object" ? value.ref : {},
      scope = value.scope === "personal" ? "personal" : "group",
      status = ["pending", "waiting", "delivered", "blocked", "skipped"].includes(
        value.status,
      )
        ? value.status
        : "pending";
    receipts.push([
      id,
      {
        id,
        effectKey: text(value.effectKey, "", 512),
        claimKey: text(value.claimKey, "", 768),
        userId: text(value.userId, "", 128),
        audience: Array.from(
          new Set(
            (Array.isArray(value.audience) ? value.audience : [value.userId])
              .map((candidate) => text(candidate, "", 128))
              .filter(Boolean),
          ),
        ).slice(0, 100),
        scope,
        repeatable: value.repeatable === true,
        ref: {
          cityId: text(ref.cityId, "", 128),
          screenId: text(ref.screenId, "", 128),
          pointId: text(ref.pointId, "", 128),
        },
        source: text(value.source, "viewer", 128),
        status,
        attempt: clamp(value.attempt, 0, 10_000),
        nextRetryAt: Math.max(0, Number(value.nextRetryAt) || 0),
        createdAt: Math.max(0, Number(value.createdAt) || 0),
        updatedAt: Math.max(0, Number(value.updatedAt) || 0),
        error: text(value.error, "", 500),
        delivery: {
          narrative: value.delivery?.narrative
            ? normalizeDeliveryPart(value.delivery.narrative, "narrative")
            : null,
          city: value.delivery?.city
            ? normalizeDeliveryPart(value.delivery.city, "city")
            : null,
          mind: value.delivery?.mind
            ? normalizeDeliveryPart(value.delivery.mind, "mind")
            : null,
          story: value.delivery?.story
            ? normalizeDeliveryPart(value.delivery.story, "story")
            : null,
          chronicle: value.delivery?.chronicle
            ? normalizeDeliveryPart(value.delivery.chronicle, "chronicle")
            : null,
        },
      },
    ]);
  }
  receipts.sort((a, b) => {
    const pendingA = ["pending", "waiting"].includes(a[1].status) ? 1 : 0,
      pendingB = ["pending", "waiting"].includes(b[1].status) ? 1 : 0;
    return pendingB - pendingA || b[1].updatedAt - a[1].updatedAt;
  });
  const limitedReceipts = Object.fromEntries(receipts.slice(0, LIMITS.effectReceipts)),
    sourceClaims =
      raw.claims && typeof raw.claims === "object" && !Array.isArray(raw.claims)
        ? raw.claims
        : {},
    claims = Object.fromEntries(
      Object.entries(sourceClaims)
        .filter(
          ([key, value]) =>
            key &&
            key.length <= 768 &&
            value &&
            typeof value === "object" &&
            effectRequestId(value.requestId),
        )
        .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
        .slice(0, LIMITS.effectClaims)
        .map(([key, value]) => [
          key,
          {
            requestId: effectRequestId(value.requestId),
            userId: text(value.userId, "", 128),
            at: Math.max(0, Number(value.at) || 0),
          },
        ]),
    );
  return { version: VISIT_EFFECT_VERSION, claims, receipts: limitedReceipts };
}
function visitEffectKey(cityId, screenId, pointId, effect) {
  return `${pointKey(cityId, screenId, pointId)}#${encodeURIComponent(
    text(effect?.id, "default", 128),
  )}`;
}
function visitEffectClaimKey(effectKey, effect, userId, requestId = "") {
  const encodedUser = encodeURIComponent(text(userId, "", 128));
  return effect.repeatable
    ? `request/${encodedUser}/${effectKey}/${encodeURIComponent(
        effectRequestId(requestId),
      )}`
    : effect.scope === "personal"
      ? `user/${encodedUser}/${effectKey}`
      : `group/${effectKey}`;
}
function visitEffectRetryDelay(attempt) {
  return [1_000, 5_000, 15_000, 30_000, 60_000][
    Math.min(4, Math.max(0, Number(attempt) || 0))
  ];
}
function scheduleVisitEffectRetry(delay = 1_000) {
  if (!isPrimaryGM()) return;
  clearTimeout(S.visitEffectRetryTimer);
  S.visitEffectRetryTimer = setTimeout(() => {
    S.visitEffectRetryTimer = null;
    void retryVisitEffects();
  }, clamp(delay, 500, 60_000));
}
async function writeVisitEffectLedger(ledger) {
  const normalized = normalizeVisitEffectLedger(ledger);
  await game.settings.set(MOD, "visitEffects", normalized);
  return normalized;
}
function createVisitEffectReceipt(request, userId, effect) {
  const now = Date.now(),
    effectKey = visitEffectKey(
      request.cityId,
      request.screenId,
      request.pointId,
      effect,
    ),
    claimKey = visitEffectClaimKey(effectKey, effect, userId, request.id),
    outputs = new Set(visitEffectOutputs(effect)),
    audience =
      effect.scope === "group"
        ? Array.from(
            new Set([
              userId,
              ...worldUsers()
                .filter((user) => user?.active && !user?.isGM)
                .map((user) => user.id),
            ]),
          )
        : [userId];
  return {
    id: request.id,
    effectKey,
    claimKey,
    userId,
    audience,
    scope: effect.scope,
    repeatable: effect.repeatable,
    source: request.source,
    ref: {
      cityId: request.cityId,
      screenId: request.screenId,
      pointId: request.pointId,
    },
    status: "pending",
    attempt: 0,
    nextRetryAt: 0,
    createdAt: now,
    updatedAt: now,
    error: "",
    delivery: {
      narrative: outputs.has("narrative")
        ? {
            status: "delivered",
            title: effect.narrative.title,
            text: effect.narrative.text,
            deliveredAt: now,
            error: "",
          }
        : null,
      city: outputs.has("city")
        ? { status: "pending", ...effect.city, error: "" }
        : null,
      mind: outputs.has("mind")
        ? { status: "pending", ...effect.mind, error: "" }
        : null,
      story: outputs.has("story")
        ? {
            status: "pending",
            ...effect.story,
            base: null,
            target: null,
            error: "",
          }
        : null,
      chronicle: outputs.has("chronicle")
        ? { status: "pending", ...effect.chronicle, error: "" }
        : null,
    },
  };
}
function pendingDeliveryParts(receipt) {
  return Object.values(receipt.delivery || {}).filter(
    (part) => part && part.status === "pending",
  );
}
async function deliverVisitEffectReceipt(ledger, receipt) {
  if (!receipt || !["pending", "waiting"].includes(receipt.status))
    return receipt || null;
  receipt.status = "pending";
  receipt.attempt += 1;
  receipt.updatedAt = Date.now();
  receipt.error = "";
  const source = text(
      `${MOD}:visit-effect:${receipt.source || "viewer"}`,
      `${MOD}:visit-effect`,
      160,
    ),
    cityPart = receipt.delivery.city,
    mindPart = receipt.delivery.mind,
    storyPart = receipt.delivery.story,
    chroniclePart = receipt.delivery.chronicle;
  if (cityPart?.status === "pending") {
    const target = findPoint(
      city(game.settings.get(MOD, "city")),
      cityPart.cityId,
      cityPart.screenId,
      cityPart.pointId,
    );
    if (!target) {
      cityPart.status = "blocked";
      cityPart.error = "The exact City Viewer point no longer exists.";
    } else {
      try {
        const result = await revealPoint(
          cityPart.cityId,
          cityPart.screenId,
          cityPart.pointId,
          { source, requestId: receipt.id },
        );
        if (result === false) throw new Error("City target was not accepted.");
        cityPart.status = "delivered";
        cityPart.error = "";
      } catch (error) {
        cityPart.error = text(
          error?.message,
          "City target is unavailable.",
          500,
        );
      }
    }
  }
  if (mindPart?.status === "pending") {
    try {
      const mindApi = game.modules.get("mind-palace")?.api,
        reveal = mindApi?.revealEvidence || mindApi?.revealNode;
      if (typeof reveal !== "function")
        throw new Error("Mind Palace is unavailable.");
      const boards = mindApi.getBoards?.();
      if (
        Array.isArray(boards) &&
        !boards.some(
          (board) =>
            board.id === mindPart.boardId &&
            board.nodes?.some((node) => node.id === mindPart.nodeId),
        )
      ) {
        mindPart.status = "blocked";
        mindPart.error = "The exact Mind Palace evidence no longer exists.";
      } else {
        const result = await reveal(mindPart.nodeId, {
          boardId: mindPart.boardId,
          source,
          requestId: receipt.id,
        });
        if (result === false)
          throw new Error("Mind Palace target was not accepted.");
        mindPart.status = "delivered";
        mindPart.error = "";
      }
    } catch (error) {
      if (mindPart.status !== "blocked")
        mindPart.error = text(
          error?.message,
          "Mind Palace target is unavailable.",
          500,
        );
    }
  }
  if (storyPart?.status === "pending") {
    try {
      const dialogueApi = game.modules.get("dialogue-stage")?.api;
      if (
        typeof dialogueApi?.getStoryState !== "function" ||
        typeof dialogueApi?.getProject !== "function" ||
        typeof dialogueApi?.setVariable !== "function"
      )
        throw new Error("Dialogue Stage is unavailable.");
      const dialogueProject = dialogueApi.getProject(),
        variable = dialogueProject?.variables?.find(
          (candidate) => candidate.id === storyPart.variableId,
        );
      if (!variable) {
        storyPart.status = "blocked";
        storyPart.error = "The exact Dialogue Stage variable no longer exists.";
        throw new Error(storyPart.error);
      }
      let storyState = dialogueApi.getStoryState(),
        current = finiteNumber(storyState?.variables?.[storyPart.variableId]);
      if (storyPart.base === null || storyPart.target === null) {
        storyPart.base = current;
        storyPart.target =
          storyPart.operation === "add"
            ? finiteNumber(current + storyPart.value)
            : finiteNumber(storyPart.value);
        receipt.updatedAt = Date.now();
        ledger.receipts[receipt.id] = receipt;
        await writeVisitEffectLedger(ledger);
      }
      if (current !== storyPart.target) {
        if (current !== storyPart.base) {
          storyPart.status = "blocked";
          storyPart.error = "Dialogue variable changed after delivery was prepared.";
        } else {
          const result = await dialogueApi.setVariable(
            storyPart.variableId,
            storyPart.target,
            { source, requestId: receipt.id },
          );
          if (result === false)
            throw new Error("Dialogue variable update was not accepted.");
          storyState = dialogueApi.getStoryState();
          current = finiteNumber(storyState?.variables?.[storyPart.variableId]);
          if (current !== storyPart.target)
            throw new Error("Dialogue variable update was not confirmed.");
        }
      }
      if (current === storyPart.target) {
        storyPart.status = "delivered";
        storyPart.error = "";
      }
    } catch (error) {
      if (storyPart.status !== "blocked")
        storyPart.error = text(
          error?.message,
          "Dialogue variable is unavailable.",
          500,
        );
    }
  }
  if (chroniclePart?.status === "pending") {
    try {
      const chronicleApi = game.modules.get("chronicle")?.api;
      if (
        typeof chronicleApi?.show !== "function" ||
        typeof chronicleApi?.getProject !== "function" ||
        typeof chronicleApi?.getState !== "function"
      )
        throw new Error("Chronicle is unavailable.");
      const chronicleProject = chronicleApi.getProject(),
        timeline = chronicleProject?.timelines?.find(
          (candidate) => candidate.id === chroniclePart.timelineId,
        );
      if (!timeline) {
        chroniclePart.status = "blocked";
        chroniclePart.error = "The exact Chronicle timeline no longer exists.";
      } else {
        const chronicleState = chronicleApi.getState(),
          alreadyShown =
            game.modules.get("chronicle")?.active === true &&
            chronicleState?.activeTimeline === chroniclePart.timelineId;
        if (!alreadyShown) {
          const result = await chronicleApi.show(chroniclePart.timelineId, {
            source,
            requestId: receipt.id,
          });
          if (result === false)
            throw new Error("Chronicle timeline was not accepted.");
        }
        chroniclePart.status = "delivered";
        chroniclePart.error = "";
      }
    } catch (error) {
      if (chroniclePart.status !== "blocked")
        chroniclePart.error = text(
          error?.message,
          "Chronicle timeline is unavailable.",
          500,
        );
    }
  }
  const blocked = Object.values(receipt.delivery).some(
      (part) => part?.status === "blocked",
    ),
    pending = pendingDeliveryParts(receipt);
  receipt.updatedAt = Date.now();
  if (!pending.length && !blocked) {
    receipt.status = "delivered";
    receipt.nextRetryAt = 0;
  } else if (blocked) {
    receipt.status = "blocked";
    receipt.nextRetryAt = 0;
    receipt.error = Object.values(receipt.delivery)
      .filter((part) => part?.status === "blocked" && part.error)
      .map((part) => part.error)
      .join(" ");
  } else {
    const defer = receipt.attempt >= 5;
    receipt.status = defer ? "waiting" : "pending";
    receipt.nextRetryAt = defer
      ? 0
      : Date.now() + visitEffectRetryDelay(receipt.attempt);
    receipt.error = pending
      .map((part) => part.error)
      .filter(Boolean)
      .join(" ");
  }
  ledger.receipts[receipt.id] = receipt;
  await writeVisitEffectLedger(ledger);
  game.socket.emit(`module.${MOD}`, {
    type: "visit-effect-ready",
    requestId: receipt.id,
    userId: game.user.id,
  });
  if (receipt.status === "delivered")
    Hooks.callAll("cityViewer.visitEffectDelivered", copy(receipt));
  else if (receipt.status === "blocked") {
    console.warn(`${MOD} | Visit effect blocked`, copy(receipt));
    ui.notifications.warn(
      tr(
        "VisitEffect.DeliveryBlocked",
        "A visit event could not be delivered. Check its exact references.",
      ),
    );
    Hooks.callAll("cityViewer.visitEffectFailed", copy(receipt));
  }
  else if (receipt.status === "waiting")
    Hooks.callAll("cityViewer.visitEffectRetryDeferred", copy(receipt));
  else {
    Hooks.callAll("cityViewer.visitEffectRetryScheduled", copy(receipt));
    scheduleVisitEffectRetry(receipt.nextRetryAt - Date.now());
  }
  return receipt;
}
function acceptVisitEffectRequest(user, request, { trusted = false } = {}) {
  const task = async () => {
    if (!isPrimaryGM()) return false;
    request = normalizeVisitEffectRequests({ requests: [request] }).requests[0];
    if (!request || !user?.id) return false;
    if (
      !trusted &&
      !userEffectRequests(user).requests.some((entry) => entry.id === request.id)
    )
      return false;
    const project = city(game.settings.get(MOD, "city")),
      location = findPoint(
        project,
        request.cityId,
        request.screenId,
        request.pointId,
      );
    if (!location) return false;
    const effect = normalizeVisitEffect(location.point.visitEffect),
      outputs = visitEffectOutputs(effect);
    if (!outputs.length) return false;
    let ledger = normalizeVisitEffectLedger(
      game.settings.get(MOD, "visitEffects"),
    );
    const existing = ledger.receipts[request.id];
    if (existing)
      return existing.status === "pending"
        ? deliverVisitEffectReceipt(ledger, existing)
        : copy(existing);
    const receipt = createVisitEffectReceipt(request, user.id, effect),
      existingClaim = receipt.claimKey
        ? ledger.claims[receipt.claimKey]
        : null;
    const access = explorationForPoint(
      location.point,
      buildExplorationContext(
        project,
        request.cityId,
        request.screenId,
        user.id,
      ),
    );
    if (!trusted && access.state !== "visible") {
      receipt.status = "skipped";
      receipt.error = "The point was not accessible to the requesting player.";
      for (const part of Object.values(receipt.delivery))
        if (part) part.status = "skipped";
      ledger.receipts[receipt.id] = receipt;
      await writeVisitEffectLedger(ledger);
      Hooks.callAll("cityViewer.visitEffectSkipped", copy(receipt));
      return receipt;
    }
    if (existingClaim) {
      receipt.status = "skipped";
      receipt.error = "The first-visit reward was already claimed.";
      for (const part of Object.values(receipt.delivery))
        if (part) part.status = "skipped";
      ledger.receipts[receipt.id] = receipt;
      await writeVisitEffectLedger(ledger);
      Hooks.callAll("cityViewer.visitEffectSkipped", copy(receipt));
      return receipt;
    }
    const hookContext = {
      request: copy(request),
      userId: user.id,
      point: copy(location.point),
      effect: copy(effect),
    };
    if (Hooks.call("cityViewer.preVisitEffect", hookContext) === false) {
      receipt.status = "skipped";
      receipt.error = "Cancelled by cityViewer.preVisitEffect.";
      for (const part of Object.values(receipt.delivery))
        if (part) part.status = "skipped";
      ledger.receipts[receipt.id] = receipt;
      await writeVisitEffectLedger(ledger);
      return receipt;
    }
    if (receipt.claimKey)
      ledger.claims[receipt.claimKey] = {
        requestId: receipt.id,
        userId: user.id,
        at: receipt.createdAt,
      };
    ledger.receipts[receipt.id] = receipt;
    ledger = await writeVisitEffectLedger(ledger);
    Hooks.callAll("cityViewer.visitEffectAccepted", copy(receipt));
    game.socket.emit(`module.${MOD}`, {
      type: "visit-effect-ready",
      requestId: receipt.id,
      userId: game.user.id,
    });
    return deliverVisitEffectReceipt(ledger, ledger.receipts[receipt.id]);
  };
  S.visitEffectQueue = S.visitEffectQueue.catch(() => undefined).then(task);
  return S.visitEffectQueue;
}
async function requestVisitEffect(point, cityId = S.viewCity, screenId = S.viewScreen) {
  if (game.user?.isGM || !point || point.kind !== "poi") return null;
  const effect = normalizeVisitEffect(point.visitEffect);
  if (!visitEffectOutputs(effect).length) return null;
  const request = {
      id: `${Date.now().toString(36)}.${id()}`,
      cityId: text(cityId, "", 128),
      screenId: text(screenId, "", 128),
      pointId: text(point.id, "", 128),
      source: "viewer",
      at: Date.now(),
    },
    task = async () => {
      const outbox = userEffectRequests(game.user);
      outbox.requests.push(request);
      const normalized = normalizeVisitEffectRequests(outbox);
      await game.user.setFlag(MOD, "visitEffectRequests", normalized);
      Hooks.callAll("cityViewer.visitEffectRequested", {
        request: copy(request),
        userId: game.user.id,
      });
      game.socket.emit(`module.${MOD}`, {
        type: "visit-effect-request",
        requestId: request.id,
        userId: game.user.id,
      });
      return request;
    };
  S.visitRequestQueue = S.visitRequestQueue.catch(() => undefined).then(task);
  return S.visitRequestQueue;
}
async function processUserEffectRequests(user, requestId = "") {
  if (!isPrimaryGM() || !user) return [];
  const cleanId = effectRequestId(requestId),
    requests = userEffectRequests(user).requests.filter(
      (request) => !cleanId || request.id === cleanId,
    ),
    results = [];
  for (const request of requests)
    results.push(await acceptVisitEffectRequest(user, request));
  return results;
}
async function reconcileVisitEffectRequests() {
  if (!isPrimaryGM()) return [];
  const results = [];
  for (const user of worldUsers())
    if (!user.isGM)
      results.push(...(await processUserEffectRequests(user)));
  return results;
}
function retryVisitEffects({ force = false, limit = 25 } = {}) {
  const task = async () => {
    if (!isPrimaryGM()) return [];
    let ledger = normalizeVisitEffectLedger(
      game.settings.get(MOD, "visitEffects"),
    );
    const now = Date.now(),
      pending = Object.values(ledger.receipts)
        .filter(
          (receipt) =>
            ((receipt.status === "pending" &&
              (force || !receipt.nextRetryAt || receipt.nextRetryAt <= now)) ||
              (force && receipt.status === "waiting")),
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, clamp(limit, 1, 100)),
      results = [];
    for (const receipt of pending) {
      results.push(await deliverVisitEffectReceipt(ledger, receipt));
      ledger = normalizeVisitEffectLedger(
        game.settings.get(MOD, "visitEffects"),
      );
    }
    const next = Object.values(ledger.receipts)
      .filter((receipt) => receipt.status === "pending" && receipt.nextRetryAt)
      .sort((a, b) => a.nextRetryAt - b.nextRetryAt)[0];
    if (next) scheduleVisitEffectRetry(next.nextRetryAt - Date.now());
    else {
      clearTimeout(S.visitEffectRetryTimer);
      S.visitEffectRetryTimer = null;
    }
    return results;
  };
  S.visitEffectQueue = S.visitEffectQueue.catch(() => undefined).then(task);
  return S.visitEffectQueue;
}
function getVisitEffectState(options = {}) {
  options = options && typeof options === "object" && !Array.isArray(options)
    ? options
    : {};
  const ledger = normalizeVisitEffectLedger(
      game.settings.get(MOD, "visitEffects"),
    ),
    receipts = Object.fromEntries(
      Object.entries(ledger.receipts).filter(([, receipt]) => {
        if (
          !game.user?.isGM &&
          !(receipt.audience || [receipt.userId]).includes(game.user?.id)
        )
          return false;
        if (options.cityId && receipt.ref.cityId !== options.cityId) return false;
        if (options.screenId && receipt.ref.screenId !== options.screenId)
          return false;
        if (options.pointId && receipt.ref.pointId !== options.pointId) return false;
        if (options.userId && receipt.userId !== options.userId) return false;
        if (options.status && receipt.status !== options.status) return false;
        return true;
      }),
    );
  return copy({
    version: ledger.version,
    claims: game.user?.isGM ? ledger.claims : {},
    receipts,
  });
}
async function triggerVisitEffect(
  cityId,
  screenId,
  pointId,
  options = {},
) {
  if (cityId && typeof cityId === "object" && !Array.isArray(cityId)) {
    options = screenId || {};
    ({ cityId, screenId, pointId } = cityId);
  }
  if (!isPrimaryGM())
    throw new Error("Only the active Game Master may trigger visit effects.");
  const project = city(game.settings.get(MOD, "city")),
    location = findPoint(project, cityId, screenId, pointId);
  if (!location)
    throw new RangeError("An exact City Viewer point reference is required.");
  const players = worldUsers().filter((user) => !user?.isGM),
    requestedUserId = text(options?.userId, "", 128),
    user = requestedUserId
      ? players.find((candidate) => candidate.id === requestedUserId)
      : players.length === 1
        ? players[0]
        : null;
  if (!user)
    throw new RangeError(
      "Provide options.userId when the world does not contain exactly one player.",
    );
  const suppliedId = text(options?.requestId, "", 200),
    requestedId = effectRequestId(suppliedId);
  if (suppliedId && !requestedId)
    throw new TypeError("options.requestId contains unsupported characters.");
  const request = {
      id: requestedId || `${Date.now().toString(36)}.${id()}`,
      cityId: location.city.id,
      screenId: location.screen.id,
      pointId: location.point.id,
      source: text(options?.source, "api", 128),
      at: Date.now(),
    };
  return acceptVisitEffectRequest(user, request, { trusted: true });
}
function resetVisitEffect(cityId, screenId, pointId, options = {}) {
  const task = async () => {
    if (!isPrimaryGM())
      throw new Error("Only the active Game Master may reset visit effects.");
    const project = city(game.settings.get(MOD, "city")),
      location = findPoint(project, cityId, screenId, pointId);
    if (!location)
      throw new RangeError("An exact City Viewer point reference is required.");
    const effect = normalizeVisitEffect(location.point.visitEffect),
      key = visitEffectKey(cityId, screenId, pointId, effect),
      userId = text(options?.userId, "", 128);
    let ledger = normalizeVisitEffectLedger(
      game.settings.get(MOD, "visitEffects"),
    );
    const removed = [],
      removedSet = new Set();
    for (const [requestId, receipt] of Object.entries(ledger.receipts))
      if (
        receipt.effectKey === key &&
        (!userId || receipt.userId === userId)
      ) {
        removed.push(requestId);
        removedSet.add(requestId);
        delete ledger.receipts[requestId];
      }
    for (const [claimKey, claim] of Object.entries(ledger.claims))
      if (
        removedSet.has(claim.requestId) ||
        (!userId &&
          (claimKey === `group/${key}` ||
            claimKey.endsWith(`/${key}`) ||
            (claimKey.startsWith("request/") &&
              claimKey.includes(`/${key}/`)))) ||
        (userId &&
          (claimKey === `user/${encodeURIComponent(userId)}/${key}` ||
            claimKey.startsWith(
              `request/${encodeURIComponent(userId)}/${key}/`,
            )))
      )
        delete ledger.claims[claimKey];
    ledger = await writeVisitEffectLedger(ledger);
    const payload = {
      ref: { cityId, screenId, pointId },
      effectId: effect.id,
      userId,
      removed,
    };
    Hooks.callAll("cityViewer.visitEffectReset", copy(payload));
    return copy({ ...payload, state: ledger });
  };
  S.visitEffectQueue = S.visitEffectQueue.catch(() => undefined).then(task);
  return S.visitEffectQueue;
}
function showVisitNarrative(receipt) {
  return new Promise((resolve) => {
    const narrative = receipt.delivery?.narrative,
      layer = document.createElement("div"),
      previousFocus = document.activeElement;
    layer.className = "cv-visit-reveal";
    layer.innerHTML = `<article role="dialog" aria-modal="true" aria-labelledby="cv-visit-reveal-title"><div class="cv-visit-reveal-mark"><i class="fas fa-compass"></i></div><small>${esc(tr("VisitEffect.Discovery", "Discovery"))}</small><h2 id="cv-visit-reveal-title">${esc(narrative?.title || tr("VisitEffect.Discovery", "Discovery"))}</h2><p>${esc(narrative?.text || "")}</p><button type="button" data-visit-reveal-close><span>${esc(tr("VisitEffect.Continue", "Continue"))}</span><i class="fas fa-arrow-right"></i></button></article>`;
    const finish = () => {
      layer.remove();
      previousFocus?.focus?.();
      resolve();
    };
    layer.onclick = (event) => {
      if (
        event.target === layer ||
        event.target.closest?.("[data-visit-reveal-close]")
      )
        finish();
    };
    layer.onkeydown = (event) => {
      if (event.key === "Escape") finish();
    };
    layer.tabIndex = -1;
    document.body.append(layer);
    layer.querySelector("[data-visit-reveal-close]")?.focus();
    Hooks.callAll("cityViewer.visitNarrativeShown", {
      requestId: receipt.id,
      userId: game.user.id,
      ref: copy(receipt.ref),
    });
  });
}
async function runNarrativeQueue() {
  if (S.narrativeActive) return;
  const receipt = S.narrativeQueue.shift();
  if (!receipt) return;
  S.narrativeActive = true;
  try {
    await showVisitNarrative(receipt);
  } finally {
    S.narrativeActive = false;
    void runNarrativeQueue();
  }
}
async function offerPendingNarratives(raw = null) {
  if (game.user?.isGM || !game.user?.id) return [];
  let storedRaw = {};
  try {
    storedRaw =
      game.user.getFlag?.(MOD, "visitEffectNarratives") ||
      game.user.flags?.[MOD]?.visitEffectNarratives ||
      {};
  } catch {
    storedRaw = {};
  }
  const ledger = normalizeVisitEffectLedger(
      raw || game.settings.get(MOD, "visitEffects"),
    ),
    stored = normalizeNarrativeReceipts(storedRaw),
    seen = new Set([...stored.ids, ...S.narrativeSeen]),
    eligible = Object.values(ledger.receipts)
      .filter((receipt) => {
        const narrative = receipt.delivery?.narrative;
        return (
          narrative?.status === "delivered" &&
          !seen.has(receipt.id) &&
          (receipt.audience || [receipt.userId]).includes(game.user.id)
        );
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  if (!eligible.length) return [];
  for (const receipt of eligible) {
    S.narrativeSeen.add(receipt.id);
  }
  const nextSeen = normalizeNarrativeReceipts({
    ids: [...stored.ids, ...S.narrativeSeen],
  });
  if (typeof game.user.setFlag !== "function") {
    for (const receipt of eligible) S.narrativeSeen.delete(receipt.id);
    return [];
  }
  const persist = () =>
    game.user.setFlag(MOD, "visitEffectNarratives", nextSeen);
  try {
    S.narrativeFlagQueue = S.narrativeFlagQueue
      .catch(() => undefined)
      .then(persist);
    await S.narrativeFlagQueue;
  } catch (error) {
    console.warn(`${MOD} | Narrative receipt`, error);
    for (const receipt of eligible) S.narrativeSeen.delete(receipt.id);
    return [];
  }
  S.narrativeQueue.push(...eligible);
  void runNarrativeQueue();
  return eligible.map((receipt) => receipt.id);
}

const templateMeta = () => [
  {
    id: "district-city",
    name: tr("Template.City.Name", "Fantasy city"),
    description: tr(
      "Template.City.Description",
      "City districts, market and merchant.",
    ),
    image: "city-v4.webp",
  },
  {
    id: "topdown-city",
    name: tr("Template.Map.Name", "Amberwind district map"),
    description: tr(
      "Template.Map.Description",
      "A draggable map with district entrances.",
    ),
    image: "amberwind.webp",
  },
  {
    id: "quest-house",
    name: tr("Template.House.Name", "Fantasy house"),
    description: tr(
      "Template.House.Description",
      "Point-and-click house interior.",
    ),
    image: "house-v4.webp",
  },
  {
    id: "murder-tavern",
    name: tr("Template.Murder.Name", "Murder at the Inn"),
    description: tr("Template.Murder.Description", "Investigate the crime scene, cellar and suspect's room."),
    image: "murder-tavern.webp",
  },
  {
    id: "cursed-ship",
    name: tr("Template.Ship.Name", "The Cursed Ship"),
    description: tr("Template.Ship.Description", "Explore the deck, captain's cabin and flooded hold."),
    image: "cursed-deck.webp",
  },
];
function templatePoint(
  name,
  target,
  x,
  y,
  icon = "fa-location-dot",
  hint = tr("Default.GoToLocation", "Go to this location"),
) {
  return {
    kind: "poi",
    name,
    x,
    y,
    w: 5,
    h: 9,
    markerIcon: icon,
    action: "screen",
    actionTitle: name,
    hint,
    value: target,
  };
}
function northWorkshopsPoint() {
  return {
    id: "north-workshops",
    kind: "poi",
    name: tr("City.Workshops", "Northern workshops"),
    x: 69,
    y: 65,
    w: 5,
    h: 9,
    markerIcon: "fa-hammer",
    markerColor: "#aeb8c2",
    action: "info",
    actionTitle: tr("City.WorkshopsAction", "Investigate the workshops"),
    hint: tr("City.WorkshopsHint", "Follow the lead from the alchemist"),
    value: tr(
      "City.WorkshopsText",
      "Silver residue marks the doors of a shuttered workshop in the northern quarter.",
    ),
    pointState: "secret",
    visitMode: "group",
    visitEffect: {
      id: "north-workshops-first-visit",
      enabled: true,
      scope: "group",
      repeatable: false,
      narrative: {
        enabled: true,
        title: tr("VisitEffect.Example.Title", "A trail of silver"),
        text: tr(
          "VisitEffect.Example.Text",
          "The residue on the workshop doors matches the courier's burn. The northern quarter is now part of the investigation.",
        ),
      },
      city: { enabled: false },
      mind: {
        enabled: true,
        boardId: "ashcroft-formula",
        nodeId: "silver-burn",
      },
      story: {
        enabled: true,
        variableId: "courier-lead",
        operation: "set",
        value: 2,
      },
      chronicle: {
        enabled: true,
        timelineId: "silver-burn-night",
      },
    },
  };
}
function buildTemplate(key) {
  const cityId = id(),
    a = id(),
    b = id(),
    c = id(),
    d = id(),
    e = id(),
    f = id(),
    g = id(),
    base = {
      fit: "cover",
      transition: "fade",
      parallax: true,
      parallaxStrength: 8,
      pan: "none",
      pointStyle: "pin",
      showTitle: true,
      showSubtitle: true,
    };
  if (key === "murder-tavern")
    return normalizeCity({
      id: cityId,
      name: "Дело «Синяя пыль»",
      startScreen: a,
      screens: [
        {
          ...base,
          id: a,
          title: "Трактир «Сломанный колокол»",
          subtitle: "Ночь убийства",
          background: TEMPLATE_ASSET("murder-tavern.webp"),
          weather: "rain",
          weatherIntensity: 0.55,
          parallaxStrength: 5,
          objects: [
            templatePoint("Спуститься в погреб", b, 18, 54, "fa-stairs"),
            templatePoint("Осмотреть комнату постояльца", c, 72, 35, "fa-door-open"),
            {kind:"poi",name:"Перевёрнутый стул",x:38,y:66,w:5,h:9,markerIcon:"fa-magnifying-glass",action:"info",actionTitle:"След борьбы",hint:"Осмотреть пол",value:"На мокром полу остался след сапога с расколотой подковой."},
          ],
        },
        {
          ...base,
          id: b,
          title: "Погреб",
          subtitle: "След уходит под землю",
          background: TEMPLATE_ASSET("murder-cellar.webp"),
          transition: "iris",
          objects: [
            {kind:"poi",name:"Синяя пыль",x:70,y:68,w:5,h:9,markerIcon:"fa-flask",markerColor:"#63a9d1",action:"info",actionTitle:"Алхимический след",hint:"Собрать образец",value:"Порошок светится в воде. Такой состав используют для снятия магических печатей."},
            {kind:"poi",name:"Тайная дверь",x:72,y:33,w:5,h:9,markerIcon:"fa-dungeon",action:"info",actionTitle:"Выход контрабандистов",hint:"Проверить дверь",value:"За дверью — свежие следы и запах речной воды."},
          ],
        },
        {
          ...base,
          id: c,
          title: "Комната постояльца",
          subtitle: "Кто-то ушёл в спешке",
          background: TEMPLATE_ASSET("murder-room.webp"),
          transition: "blur",
          objects: [
            {kind:"poi",name:"Запечатанное письмо",x:29,y:67,w:5,h:9,markerIcon:"fa-envelope",action:"info",actionTitle:"Письмо без подписи",hint:"Осмотреть печать",value:"На воске тот же синий порошок, что найден в погребе."},
            {kind:"poi",name:"Дорожный сундук",x:48,y:49,w:5,h:9,markerIcon:"fa-box-open",action:"info",actionTitle:"Собранные вещи",hint:"Обыскать сундук",value:"Одежда сухая. Постоялец не приходил с улицы — он покинул трактир другим путём."},
          ],
        },
      ],
    });
  if (key === "cursed-ship")
    return normalizeCity({
      id: cityId,
      name: "Проклятие «Чёрной чайки»",
      startScreen: a,
      screens: [
        {
          ...base,
          id: a,
          title: "Палуба «Чёрной чайки»",
          subtitle: "Корабль идёт без команды",
          background: TEMPLATE_ASSET("cursed-deck.webp"),
          weather: "fog",
          weatherIntensity: 0.8,
          parallaxStrength: 6,
          objects: [
            templatePoint("Каюта капитана", b, 72, 38, "fa-compass"),
            templatePoint("Спуститься в трюм", c, 58, 72, "fa-water"),
            {kind:"poi",name:"Штурвал",x:19,y:58,w:5,h:9,markerIcon:"fa-dharmachakra",action:"info",actionTitle:"Курс корабля",hint:"Проверить штурвал",value:"Штурвал поворачивается сам и держит курс на скалы, которых нет ни на одной карте."},
          ],
        },
        {
          ...base,
          id: b,
          title: "Каюта капитана",
          subtitle: "Последняя запись в журнале",
          background: TEMPLATE_ASSET("cursed-cabin.webp"),
          transition: "zoom",
          objects: [
            {kind:"poi",name:"Прикованный сундук",x:76,y:65,w:5,h:9,markerIcon:"fa-lock",action:"info",actionTitle:"Сундук капитана",hint:"Осмотреть цепи",value:"Цепи удерживают не крышку, а сам сундук. Изнутри слышен размеренный стук."},
            {kind:"poi",name:"Разбитое зеркало",x:72,y:32,w:5,h:9,markerIcon:"fa-eye",action:"info",actionTitle:"Чужое отражение",hint:"Посмотреть в зеркало",value:"В отражении за вашей спиной стоит капитан. В самой каюте никого нет."},
          ],
        },
        {
          ...base,
          id: c,
          title: "Затопленный трюм",
          subtitle: "Источник проклятия",
          background: TEMPLATE_ASSET("cursed-hold.webp"),
          weather: "fog",
          transition: "slide",
          objects: [
            {kind:"poi",name:"Каменный идол",x:64,y:47,w:5,h:9,markerIcon:"fa-skull",markerColor:"#72c9a4",action:"info",actionTitle:"Сердце проклятия",hint:"Изучить идол",value:"Руны обещают безопасный путь через любой шторм — в обмен на имена всей команды."},
            {kind:"poi",name:"Лестница на палубу",x:84,y:30,w:5,h:9,markerIcon:"fa-arrow-up",action:"screen",actionTitle:"Вернуться на палубу",hint:"Подняться",value:a},
          ],
        },
      ],
    });
  if (key === "topdown-city")
    return normalizeCity({
      id: cityId,
      name: tr("Map.City", "Amberwind"),
      startScreen: a,
      screens: [
        {
          ...base,
          id: a,
          title: "Amberwind",
          subtitle: tr("Map.Choose", "Choose a district"),
          background: TEMPLATE_ASSET("amberwind.webp"),
          fit: "contain",
          pan: "vertical",
          pointStyle: "map",
          parallax: false,
          showTitle: false,
          showSubtitle: false,
          objects: [
            templatePoint(
              tr("Map.Bank", "Ghost Bank"),
              b,
              31,
              20,
              "fa-building-columns",
            ),
            templatePoint(
              tr("Map.Slums", "Northern Slums"),
              c,
              72,
              22,
              "fa-house",
            ),
            templatePoint(
              tr("Map.Ridge", "Ridge"),
              d,
              48,
              43,
              "fa-mountain-city",
            ),
            templatePoint(
              tr("Map.Stonegate", "Stonegate"),
              e,
              76,
              63,
              "fa-dungeon",
            ),
            templatePoint(tr("Map.Docks", "The Docks"), f, 42, 81, "fa-anchor"),
            templatePoint(
              tr("Map.Fortress", "Fortress"),
              g,
              70,
              91,
              "fa-shield-halved",
            ),
          ],
        },
        {
          ...base,
          id: b,
          title: tr("Map.Bank", "Ghost Bank"),
          subtitle: tr("Map.BankSub", "Old money and older secrets"),
          background: TEMPLATE_ASSET("bank-v4.webp"),
          objects: [],
        },
        {
          ...base,
          id: c,
          title: tr("Map.Slums", "Northern Slums"),
          subtitle: tr("Map.SlumsSub", "A maze beyond the old road"),
          background: TEMPLATE_ASSET("slums-v4.webp"),
          objects: [],
        },
        {
          ...base,
          id: d,
          title: tr("Map.Ridge", "Ridge"),
          subtitle: tr("Map.RidgeSub", "The crowded heart of Amberwind"),
          background: TEMPLATE_ASSET("ridge-v4.webp"),
          objects: [],
        },
        {
          ...base,
          id: e,
          title: tr("Map.Stonegate", "Stonegate"),
          subtitle: tr("Map.StonegateSub", "Stone walls and watchful guards"),
          background: TEMPLATE_ASSET("stonegate-v4.webp"),
          objects: [],
        },
        {
          ...base,
          id: f,
          title: tr("Map.Docks", "The Docks"),
          subtitle: tr("Map.DocksSub", "Warehouses, ships and rumours"),
          background: TEMPLATE_ASSET("docks-v4.webp"),
          objects: [],
        },
        {
          ...base,
          id: g,
          title: tr("Map.Fortress", "Fortress"),
          subtitle: tr("Map.FortressSub", "The seat of power"),
          background: TEMPLATE_ASSET("fortress-v4.webp"),
          objects: [],
        },
      ],
    });
  if (key === "quest-house")
    return normalizeCity({
      id: cityId,
      name: tr("House.Main", "The Old Alchemist's House"),
      startScreen: a,
      screens: [
        {
          ...base,
          id: a,
          title: tr("House.Main", "The Old Alchemist's House"),
          subtitle: tr("House.MainSub", "Every object may hide a secret"),
          background: TEMPLATE_ASSET("house-v4.webp"),
          mindPalace: true,
          parallaxStrength: 5,
          objects: [
            {
              ...templatePoint(
                tr("House.Dining", "Dining room"),
                b,
                23,
                49,
                "fa-utensils",
              ),
              visitMode: "group",
            },
            {
              ...templatePoint(
                tr("House.Study", "Study"),
                c,
                73,
                38,
                "fa-book-open",
              ),
              pointState: "locked",
              lockReason: tr(
                "Exploration.Example.StudyLocked",
                "The alchemical lock needs a three-part sigil.",
              ),
              visitMode: "group",
            },
            {
              kind: "poi",
              name: tr("House.Chest", "Old chest"),
              x: 82,
              y: 67,
              w: 5,
              h: 9,
              markerIcon: "fa-box-archive",
              action: "info",
              actionTitle: tr("House.Chest", "Old chest"),
              hint: tr("House.Inspect", "Inspect"),
              pointState: "secret",
              visitMode: "personal",
              value: tr(
                "House.ChestText",
                "A forgotten coat of arms is carved into the lid.",
              ),
            },
          ],
        },
        {
          ...base,
          id: b,
          title: tr("House.Dining", "Dining room"),
          subtitle: tr("House.DiningSub", "The hearth is still warm"),
          background: TEMPLATE_ASSET("dining-v4.webp"),
          mindPalace: true,
          objects: [],
        },
        {
          ...base,
          id: c,
          title: tr("House.Study", "Alchemist's study"),
          subtitle: tr("House.StudySub", "Notes, reagents and unfinished work"),
          background: TEMPLATE_ASSET("study-v4.webp"),
          mindPalace: true,
          objects: [],
        },
      ],
    });
  return normalizeCity({
    id: cityId,
    name: tr("City.Main", "Silver Reach"),
    startScreen: a,
    screens: [
      {
        ...base,
        id: a,
        title: tr("City.Main", "Silver Reach"),
        subtitle: tr("City.MainSub", "The city opens its gates"),
        background: TEMPLATE_ASSET("city-v4.webp"),
        objects: [
          templatePoint(
            tr("City.Market", "Market district"),
            b,
            35,
            48,
            "fa-store",
          ),
          templatePoint(
            tr("City.Merchant", "Merchant shop"),
            c,
            57,
            45,
            "fa-flask",
          ),
          templatePoint(
            tr("City.Gates", "Upper gates"),
            d,
            78,
            34,
            "fa-dungeon",
          ),
          northWorkshopsPoint(),
        ],
      },
      {
        ...base,
        id: b,
        title: tr("City.Market", "Market square"),
        subtitle: tr("City.MarketSub", "Voices, spices and ringing coin"),
        background: TEMPLATE_ASSET("market-v4.webp"),
        objects: [
          templatePoint(
            tr("City.MerchantAction", "Visit the merchant"),
            c,
            25,
            48,
            "fa-user-tie",
          ),
        ],
      },
      {
        ...base,
        id: c,
        title: tr("City.Merchant", "Merchant shop"),
        subtitle: tr("City.MerchantSub", "Rare goods from distant lands"),
        background: TEMPLATE_ASSET("merchant-v4.webp"),
        objects: [
          {
            kind: "poi",
            name: "Алхимик Ильян",
            x: 45,
            y: 48,
            w: 5,
            h: 9,
            markerIcon: "fa-user",
            markerColor: "#b96e46",
            action: "dialogue",
            actionTitle: "Поговорить с Ильяном",
            hint: "Расспросить алхимика о запечатанном письме",
            value: "arrival",
          },
          {
            kind: "poi",
            name: tr("City.Merchant", "Merchant"),
            x: 63,
            y: 52,
            w: 5,
            h: 9,
            markerIcon: "fa-scroll",
            action: "info",
            actionTitle: tr("City.MerchantAction", "Speak with the merchant"),
            hint: tr("City.MerchantHint", "Ask what is for sale"),
            value: tr(
              "City.MerchantText",
              "The merchant welcomes the party and lays out several rare goods.",
            ),
          },
        ],
      },
      {
        ...base,
        id: d,
        title: tr("City.Gates", "Upper gates"),
        subtitle: tr("City.GatesSub", "The road begins here"),
        background: TEMPLATE_ASSET("gate-v4.webp"),
        objects: [],
      },
    ],
  });
}

async function picker(type, current, callback) {
  const Picker =
    foundry.applications?.apps?.FilePicker?.implementation ||
    foundry.applications?.apps?.FilePicker ||
    globalThis.FilePicker;
  if (!Picker)
    return ui.notifications.error(
      tr("Files.PickerUnavailable", "The Foundry file picker is unavailable."),
    );
  const app = new Picker({ type, current: current || "", callback });
  try {
    await app.render({ force: true });
  } catch (_error) {
    await app.render(true);
  }
  const element = app.element?.jquery ? app.element[0] : app.element;
  if (element instanceof HTMLElement)
    element.style.setProperty("z-index", "10050", "important");
}

function applyResource(
  kind,
  value,
  target = { cityId: S.city, screenId: S.screen, objectId: S.selected },
) {
  recordUndo();
  const targetCity = S.draft?.cities.find((item) => item.id === target.cityId),
    d = targetCity?.screens.find((item) => item.id === target.screenId),
    o = d?.objects.find((item) => item.id === target.objectId);
  if (!d) return;
  if (kind === "markerImage" && o) o.markerImage = value;
  if (kind === "background") d.background = value;
  if (kind === "ambience") d.ambience = value;
  if (kind === "object" && o) {
    o.src = value;
    o.media = /\.(webm|mp4|m4v|ogv)$/i.test(value) ? "video" : "image";
  }
  if (kind === "sound" && o) o.sound = value;
  renderEditor();
  autosave();
}

async function uploadFromComputer(kind) {
  const target = { cityId: S.city, screenId: S.screen, objectId: S.selected };
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ["ambience", "sound"].includes(kind)
    ? "audio/*,.ogg,.mp3,.wav,.flac,.m4a,.webm"
    : "image/*,video/*,.webp,.gif,.webm,.mp4,.m4v,.ogv";
  input.hidden = true;
  document.body.append(input);
  input.addEventListener("cancel", () => input.remove(), { once: true });
  input.addEventListener(
    "change",
    async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const Picker =
        foundry.applications?.apps?.FilePicker?.implementation ||
        foundry.applications?.apps?.FilePicker ||
        globalThis.FilePicker;
      if (!Picker?.upload)
        return ui.notifications.error(
          tr("Files.UploadUnavailable", "File upload is unavailable in this Foundry version."),
        );
      const directory = "assets/city-viewer";
      try {
        await Picker.browse("data", directory);
      } catch (_error) {
        try {
          await Picker.createDirectory("data", directory);
        } catch (_createError) {
          /* The directory already exists or the current user cannot create it. */
        }
      }
      try {
        ui.notifications.info(
          `${tr("Files.Uploading", "Uploading")}: ${file.name}`,
        );
        const response = await Picker.upload(
          "data",
          directory,
          file,
          {},
          { notify: true },
        );
        applyResource(
          kind,
          response?.path || response?.files?.[0] || `${directory}/${file.name}`,
          target,
        );
      } catch (error) {
        console.error(`${MOD} | Upload failed`, error);
        ui.notifications.error(
          tr(
            "Files.UploadFailed",
            "The file could not be uploaded. Check this user's Foundry permissions.",
          ),
        );
      }
    },
    { once: true },
  );
  input.click();
}

function objectHTML(source, editing = false, explorationContext = null) {
  const o = resolveBoundObject(source),
    isPoint = o.kind === "poi",
    isGM = Boolean(game.user?.isGM),
    exploration = isPoint
      ? explorationContext
        ? explorationForPoint(o, explorationContext)
        : {
            state: o.pointState || "visible",
            visited: false,
            visitMode: o.visitMode || "none",
          }
      : null;
  if (isPoint && exploration.state === "secret" && !isGM && !editing)
    return "";
  const stateLabel = exploration
      ? tr(
          {
            visible: "Exploration.Visible",
            secret: "Exploration.Secret",
            locked: "Exploration.Locked",
          }[exploration.state],
          exploration.state,
        )
      : "",
    stateIcon = {
      visible: "fa-eye",
      secret: "fa-eye-slash",
      locked: "fa-lock",
    }[exploration?.state],
    stateBadge =
      isPoint && (editing || isGM)
        ? `<span class="cv-poi-state-badge is-${esc(exploration.state)}" title="${esc(stateLabel)}"><i class="fas ${stateIcon}"></i><span>${esc(stateLabel)}</span></span>`
        : "",
    visitedBadge =
      isPoint && exploration.visited
        ? `<span class="cv-poi-visited-badge" title="${esc(tr("Exploration.Visited", "Visited"))}"><i class="fas fa-check"></i></span>`
        : "",
    lockBadge =
      isPoint && exploration.state === "locked" && !editing
        ? `<span class="cv-poi-lock-badge"><i class="fas fa-lock"></i></span>`
        : "",
    gmControls =
      isPoint && !editing && isGM
        ? `<nav class="cv-poi-gm-controls" aria-label="${esc(tr("Exploration.Controls", "Point access"))}"><button type="button" data-point-state="visible" class="${exploration.state === "visible" ? "active" : ""}" title="${esc(tr("Exploration.Reveal", "Reveal to players"))}"><i class="fas fa-eye"></i></button><button type="button" data-point-state="secret" class="${exploration.state === "secret" ? "active" : ""}" title="${esc(tr("Exploration.Hide", "Hide from players"))}"><i class="fas fa-eye-slash"></i></button><button type="button" data-point-state="locked" class="${exploration.state === "locked" ? "active" : ""}" title="${esc(tr("Exploration.Lock", "Lock for players"))}"><i class="fas fa-lock"></i></button></nav>`
        : "";
  const media =
    isPoint
      ? `<span class="cv-poi-marker" style="--marker:${esc(o.markerColor)}">${o.markerImage ? `<img class="cv-marker-image" src="${esc(o.markerImage)}" alt="" draggable="false">` : `<i class="fas ${esc(o.markerIcon)}"></i>`}<span class="cv-poi-ripple one"></span><span class="cv-poi-ripple two"></span></span><span class="cv-poi-label">${esc(o.name)}</span>${stateBadge}${visitedBadge}${lockBadge}${gmControls}`
      : o.media === "video"
        ? `<video src="${esc(o.src)}" autoplay loop muted playsinline draggable="false"></video>`
        : `<img src="${esc(o.src)}" alt="${esc(o.name)}" draggable="false">`;
  const interactive = !editing && o.interactive;
  return `<div class="cv-object ${isPoint ? `is-poi${o.markerImage ? " has-marker-image" : ""}` : "is-asset"} ${editing ? "editing" : interactive ? "interactive" : ""} ${isPoint ? `is-exploration-${exploration.state}${exploration.visited ? " is-visited" : ""}` : ""}" data-id="${esc(o.id)}" ${isPoint ? `data-point-state="${esc(exploration.state)}" data-visit-mode="${esc(exploration.visitMode)}"` : ""}
    style="--x:${o.x};--y:${o.y};--w:${o.w};--h:${o.h};--r:${o.rotation};--op:${o.opacity};--z:${o.z}"
    tabindex="${interactive ? 0 : -1}" role="${interactive ? "button" : "img"}" aria-label="${esc(isPoint ? `${o.name} — ${stateLabel}` : o.name)}">
    ${media}${editing ? `<b>${esc(o.name)}</b><i class="cv-resize"></i>` : ""}</div>`;
}

function setSaveStatus(state) {
  const status = S.editor?.querySelector(".cv-save-status");
  if (!status) return;
  const labels = {
    dirty: tr("Editor.Unsaved", "Unsaved changes"),
    saving: tr("Editor.Saving", "Saving…"),
    saved: tr("Editor.Saved", "Saved"),
    error: tr("Editor.SaveFailed", "Save failed"),
  };
  status.dataset.state = state;
  status.textContent = labels[state] || labels.saved;
}
async function save(notify = false) {
  if (!game.user.isGM || !S.draft) return null;
  clearTimeout(S.timer);
  const snapshot = city(copy(S.draft)),
    revision = ++S.saveRevision;
  S.draft = snapshot;
  setSaveStatus("saving");
  const task = async () => {
    try {
      await game.settings.set(MOD, "city", copy(snapshot));
      S.savedRevision = Math.max(S.savedRevision, revision);
      if (S.savedRevision === S.saveRevision) setSaveStatus("saved");
      if (notify) ui.notifications.info(tr("Notify.Saved", "City saved."));
      return snapshot;
    } catch (error) {
      console.error(`${MOD} | Save`, error);
      setSaveStatus("error");
      if (notify)
        ui.notifications.error(tr("Notify.SaveFailed", "The city could not be saved."));
      throw error;
    }
  };
  S.saveQueue = S.saveQueue.catch(() => undefined).then(task);
  return S.saveQueue;
}
function autosave() {
  clearTimeout(S.timer);
  setSaveStatus("dirty");
  S.timer = setTimeout(() => save().catch(() => undefined), 650);
}
function selected() {
  return editScreen()?.objects.find((o) => o.id === S.selected);
}

function editorSnapshot() {
  if (!S.draft) return null;
  return {
    draft: copy(S.draft),
    city: S.city,
    screen: S.screen,
    selected: S.selected,
  };
}
function snapshotKey(snapshot) {
  if (snapshot?._key) return snapshot._key;
  try {
    const key = JSON.stringify(snapshot?.draft);
    if (snapshot)
      Object.defineProperty(snapshot, "_key", { value: key, configurable: true });
    return key;
  } catch {
    return "";
  }
}
function recordUndo(snapshot = editorSnapshot()) {
  if (!snapshot) return;
  const stack = S.editorHistory.undo,
    key = snapshotKey(snapshot);
  if (key && key === snapshotKey(stack.at(-1))) return;
  stack.push(snapshot);
  const limit = key.length > 2_000_000 ? 5 : LIMITS.undo;
  if (stack.length > limit) stack.splice(0, stack.length - limit);
  S.editorHistory.redo.length = 0;
  updateHistoryButtons();
}
function restoreEditorSnapshot(snapshot) {
  if (!snapshot) return;
  S.draft = city(copy(snapshot.draft));
  S.city = S.draft.cities.some((item) => item.id === snapshot.city)
    ? snapshot.city
    : S.draft.activeCity;
  const currentCity = editCity();
  S.screen = currentCity.screens.some((item) => item.id === snapshot.screen)
    ? snapshot.screen
    : currentCity.startScreen;
  S.selected = editScreen().objects.some((item) => item.id === snapshot.selected)
    ? snapshot.selected
    : null;
  renderEditor();
  autosave();
}
function undoEditor() {
  const snapshot = S.editorHistory.undo.pop();
  if (!snapshot) return;
  S.editorHistory.redo.push(editorSnapshot());
  restoreEditorSnapshot(snapshot);
  updateHistoryButtons();
}
function redoEditor() {
  const snapshot = S.editorHistory.redo.pop();
  if (!snapshot) return;
  S.editorHistory.undo.push(editorSnapshot());
  restoreEditorSnapshot(snapshot);
  updateHistoryButtons();
}
function updateHistoryButtons() {
  const undo = S.editor?.querySelector('[data-act="undo"]'),
    redo = S.editor?.querySelector('[data-act="redo"]');
  if (undo) undo.disabled = !S.editorHistory.undo.length;
  if (redo) redo.disabled = !S.editorHistory.redo.length;
}

function openEditor() {
  if (!game.user.isGM)
    return ui.notifications.warn(
      tr("Editor.GMOnly", "Only a Game Master can open the city editor."),
    );
  closeViewer();
  S.draft = city(game.settings.get(MOD, "city"));
  S.city = S.draft.activeCity;
  S.screen = editCity().startScreen;
  S.selected = null;
  S.editorHistory = { undo: [], redo: [], fieldSnapshot: null };
  S.editor?.remove();
  const el = document.createElement("section");
  el.id = "cv-editor";
  el.innerHTML = `<header><div class="cv-brand"><i class="fas fa-chess-rook"></i><div><strong>City Viewer</strong><small>${tr("Editor.Architect", "City architect")}</small></div></div><nav>
    <select class="cv-language" data-language title="${tr("UI.Language", "Language")}"><option value="en" ${S.locale === "en" ? "selected" : ""}>EN</option><option value="ru" ${S.locale === "ru" ? "selected" : ""}>RU</option></select><button data-act="undo" class="icon" title="${tr("Editor.Undo", "Undo")}" disabled><i class="fas fa-rotate-left"></i></button><button data-act="redo" class="icon" title="${tr("Editor.Redo", "Redo")}" disabled><i class="fas fa-rotate-right"></i></button><button data-template-open><i class="fas fa-wand-magic-sparkles"></i> ${tr("Editor.Templates", "Templates")}</button><button data-preset-action="library"><i class="fas fa-box-archive"></i> ${tr("Editor.Presets", "Presets")}</button><button data-act="export"><i class="fas fa-file-export"></i> ${tr("Editor.Export", "Backup")}</button><button data-act="import"><i class="fas fa-file-import"></i> ${tr("Editor.Import", "Restore")}</button><button data-act="newscreen"><i class="fas fa-plus"></i> ${tr("Editor.Screen", "Screen")}</button><button data-act="addpoi"><i class="fas fa-location-dot"></i> ${tr("Editor.Point", "Point")}</button><button data-act="add" class="advanced-only"><i class="fas fa-image"></i> ${tr("Editor.Media", "Media")}</button><button data-act="preview"><i class="fas fa-play"></i> ${tr("Editor.Preview", "Preview")}</button>
    <button data-act="show"><i class="fas fa-users-viewfinder"></i> ${tr("UI.ForceScreen", "Show this screen to everyone")}</button><span class="cv-save-status" role="status" aria-live="polite">${tr("Editor.Saved", "Saved")}</span><button data-act="save" class="gold"><i class="fas fa-floppy-disk"></i> ${tr("UI.Save", "Save")}</button>
    <button data-act="close" class="icon"><i class="fas fa-xmark"></i></button></nav></header>
    <div class="cv-layout"><aside class="cv-scene"></aside><main><div class="cv-stage"></div><footer>${tr("UI.FooterHelp", "Drag — position · Ctrl+C / Ctrl+V — copy point · Delete — remove")}</footer></main><aside class="cv-props"></aside></div>`;
  document.body.append(el);
  S.editor = el;
  bindEditor(el);
  el.querySelector("[data-template-open]").addEventListener(
    "click",
    (event) => {
      event.stopPropagation();
      openTemplates();
    },
  );
  el.querySelector("[data-language]").addEventListener("change", (event) =>
    setLanguage(event.target.value).catch((error) => {
      console.error(`${MOD} | Language`, error);
      ui.notifications.error(
        tr("Notify.SettingSaveFailed", "The setting could not be saved."),
      );
    }),
  );
  renderEditor();
}

function renderEditor() {
  if (!S.editor) return;
  const d = editScreen(),
    o = selected();
  const c = editCity();
  S.editor.querySelector(".cv-scene").innerHTML =
    `<div class="cv-section-head"><h2><i class="fas fa-city"></i> ${tr("UI.Cities", "Cities")} <small>${S.draft.cities.length}</small></h2><button data-act="newcity" title="${tr("UI.NewCity", "New city")}"><i class="fas fa-plus"></i></button></div>
    <div class="cv-cities">${S.draft.cities.map((city) => `<button data-city-id="${esc(city.id)}" class="${city.id === S.city ? "active" : ""}"><i class="fas fa-building-columns"></i><span>${esc(city.name)}</span></button>`).join("")}</div>
    <div class="cv-city-actions"><button data-act="duplicatecity"><i class="fas fa-copy"></i> ${tr("UI.Copy", "Copy")}</button><button data-act="deletecity"><i class="fas fa-trash"></i> ${tr("UI.Delete", "Delete")}</button></div>
    <div class="cv-section-head"><h2><i class="fas fa-panorama"></i> ${tr("UI.Screens", "Screens")} <small>${c.screens.length}</small></h2><button data-act="newscreen" title="${tr("UI.NewScreen", "New screen")}"><i class="fas fa-plus"></i></button></div>
    <div class="cv-screens">${c.screens.map((screen, index) => `<button data-screen="${esc(screen.id)}" class="${screen.id === S.screen ? "active" : ""}"><i class="fas ${screen.id === c.startScreen ? "fa-house" : "fa-panorama"}"></i><span>${esc(screen.title || `${tr("Editor.Screen", "Screen")} ${index + 1}`)}</span></button>`).join("")}</div>
    <div class="cv-screen-actions"><button data-act="duplicatescreen" title="${tr("UI.Duplicate", "Duplicate")}"><i class="fas fa-copy"></i></button><button data-act="startscreen" title="${tr("UI.MakeStart", "Make starting screen")}"><i class="fas fa-house-flag"></i></button><button data-act="deletescreen" title="${tr("UI.Delete", "Delete")}"><i class="fas fa-trash"></i></button></div>
    <h2><i class="fas fa-layer-group"></i> ${tr("UI.Layers", "Layers")} <small>${d.objects.length}</small></h2><div class="cv-layers">${
      [...d.objects]
        .sort((a, b) => b.z - a.z)
        .map(
          (x) =>
            `<button data-select="${esc(x.id)}" class="${x.id === S.selected ? "active" : ""}"><span>${x.kind === "poi" ? x.markerImage ? `<img src="${esc(x.markerImage)}" alt="">` : `<i class="fas ${esc(x.markerIcon)}"></i>` : x.media === "video" ? '<i class="fas fa-film"></i>' : `<img src="${esc(x.src)}">`}</span>${esc(x.name)}<i class="fas fa-grip-lines"></i></button>`,
        )
        .join("") || `<em>${tr("UI.AddFirst", "Add the first object")}</em>`
    }</div>`;
  const stage = S.editor.querySelector(".cv-stage");
  stage.style.backgroundImage = d.background ? cssUrl(d.background) : "none";
  stage.style.backgroundSize = d.fit;
  stage.innerHTML = `<div class="cv-title"><h1>${esc(d.title)}</h1><p>${esc(d.subtitle)}</p></div>${d.objects.map((x) => objectHTML(x, true)).join("")}`;
  previewEditorWeather(stage, d);
  stage.classList.toggle("point-style-map", d.pointStyle === "map");
  stage.classList.toggle("is-pan-editor", d.pan !== "none");
  if (d.pan !== "none" && d.background) {
    const previewImage = new Image();
    previewImage.onload = () => {
      if (stage.isConnected && S.editor && editScreen() === d)
        stage.style.aspectRatio = `${previewImage.naturalWidth}/${previewImage.naturalHeight}`;
    };
    previewImage.src = d.background;
  } else stage.style.aspectRatio = "16/9";
  stage.querySelector(".cv-title h1").hidden = !d.showTitle;
  stage.querySelector(".cv-title p").hidden = !d.showSubtitle;
  if (S.selected)
    stage.querySelector(`[data-id="${CSS.escape(S.selected)}"]`)?.classList.add("selected");
  S.editor.querySelector(".cv-props").innerHTML = o
    ? props(o)
    : screenProps(d, c);
  updateHistoryButtons();
}
function renderEditorSelection() {
  if (!S.editor) return;
  S.editor
    .querySelectorAll(".cv-stage .selected,.cv-layers .active")
    .forEach((element) => element.classList.remove("selected", "active"));
  if (S.selected) {
    const selector = CSS.escape(S.selected);
    S.editor.querySelector(`.cv-stage [data-id="${selector}"]`)?.classList.add("selected");
    S.editor.querySelector(`.cv-layers [data-select="${selector}"]`)?.classList.add("active");
  }
  const object = selected(),
    screen = editScreen(),
    currentCity = editCity(),
    properties = S.editor.querySelector(".cv-props");
  if (properties) properties.innerHTML = object ? props(object) : screenProps(screen, currentCity);
  updateHistoryButtons();
}

function field(label, key, value, scope = "object", type = "text") {
  return `<label>${label}<input type="${type}" data-${scope}="${key}" value="${esc(value)}"></label>`;
}
function fileField(label, key, value, scope, pickName, icon) {
  return `<label>${label}<div class="cv-file"><input data-${scope}="${key}" value="${esc(value)}"><button class="icon" data-pick="${pickName}" title="${tr("Files.Pick", "Choose from Foundry files")}"><i class="fas fa-${icon}"></i></button><button class="icon cv-upload" data-upload="${pickName}" title="${tr("Files.Upload", "Upload from this computer")}"><i class="fas fa-upload"></i></button></div></label>`;
}
function dialogueScenes() {
  try {
    return game.modules.get("dialogue-stage")?.api?.getProject?.()?.scenes || [];
  } catch {
    return [];
  }
}
function dialogueField(value) {
  const scenes = dialogueScenes();
  if (!scenes.length)
    return `<p class="cv-action-note"><i class="fas fa-triangle-exclamation"></i> ${tr("Dialogue.Empty", "Activate Dialogue Stage and create at least one scene.")}</p>`;
  return `<label>${tr("Viewer.Dialogue", "Dialogue")}<select data-object="value">${scenes
    .map((scene) => {
      const selected = scene.id === value || scene.nodes?.some((node) => node.id === value);
      return `<option value="${scene.id}" ${selected ? "selected" : ""}>${esc(scene.title)}</option>`;
    })
    .join("")}</select></label><p class="cv-action-note"><i class="fas fa-masks-theater"></i> ${tr("Dialogue.OpenHint", "Clicking this point opens the selected dialogue scene.")}</p>`;
}
function encodeVisitTarget(value) {
  try {
    return encodeURIComponent(JSON.stringify(value || {}));
  } catch {
    return "";
  }
}
function decodeVisitTarget(value, keys) {
  try {
    const parsed = JSON.parse(decodeURIComponent(String(value || "")));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result = {};
    for (const key of keys) {
      result[key] = text(parsed[key], "", 128);
      if (!result[key]) return null;
    }
    return result;
  } catch {
    return null;
  }
}
function sameVisitTarget(left, right, keys) {
  return keys.every((key) => text(left?.[key], "", 128) === text(right?.[key], "", 128));
}
function visitEffectEditor(object) {
  const effect = normalizeVisitEffect(object.visitEffect),
    project = S.draft || city(game.settings.get(MOD, "city")),
    cityTargets = project.cities
      .flatMap((targetCity) =>
        targetCity.screens.flatMap((targetScreen) =>
          targetScreen.objects
            .filter(
              (point) =>
                point.kind === "poi" &&
                !(
                  targetCity.id === S.city &&
                  targetScreen.id === S.screen &&
                  point.id === object.id
                ),
            )
            .map((point) => ({
              ref: {
                cityId: targetCity.id,
                screenId: targetScreen.id,
                pointId: point.id,
              },
              label: `${targetCity.name} / ${targetScreen.title} / ${point.name}`,
            })),
        ),
      )
      .slice(0, LIMITS.targetOptions);
  let mindTargets = [],
    storyTargets = [],
    chronicleTargets = [];
  try {
    mindTargets = (game.modules.get("mind-palace")?.api?.getBoards?.() || [])
      .flatMap((board) =>
        (board.nodes || []).map((node) => ({
          ref: { boardId: board.id, nodeId: node.id },
          label: `${board.title || board.id} / ${node.title || node.name || node.id}`,
        })),
      )
      .slice(0, LIMITS.targetOptions);
  } catch {
    mindTargets = [];
  }
  try {
    storyTargets = (
      game.modules.get("dialogue-stage")?.api?.getProject?.()?.variables || []
    )
      .slice(0, LIMITS.targetOptions)
      .map((variable) => ({
        ref: { variableId: variable.id },
        label: variable.name || variable.id,
      }));
  } catch {
    storyTargets = [];
  }
  try {
    chronicleTargets = (
      game.modules.get("chronicle")?.api?.getProject?.()?.timelines || []
    )
      .slice(0, LIMITS.targetOptions)
      .map((timeline) => ({
        ref: { timelineId: timeline.id },
        label: timeline.title || timeline.id,
      }));
  } catch {
    chronicleTargets = [];
  }
  const targetSelect = (kind, keys, current, targets, emptyLabel) => {
      const currentComplete = keys.every((key) => current[key]),
        hasCurrent = targets.some((target) =>
          sameVisitTarget(target.ref, current, keys),
        ),
        values = [...targets];
      if (currentComplete && !hasCurrent)
        values.unshift({
          ref: Object.fromEntries(keys.map((key) => [key, current[key]])),
          label: `${tr("VisitEffect.MissingTarget", "Missing target")} · ${keys
            .map((key) => current[key])
            .join(" / ")}`,
        });
      return `<select data-visit-effect="${kind}.target"><option value="">${esc(emptyLabel)}</option>${values
        .map(
          (target) =>
            `<option value="${esc(encodeVisitTarget(target.ref))}" ${sameVisitTarget(target.ref, current, keys) ? "selected" : ""}>${esc(target.label)}</option>`,
        )
        .join("")}</select>`;
    },
    enabled = effect.enabled;
  return `<details class="cv-visit-effect-editor" ${enabled ? "open" : ""}>
    <summary><span><i class="fas fa-gift"></i> ${tr("VisitEffect.Title", "Visit event")}</span><label class="cv-toggle"><input type="checkbox" data-visit-effect="enabled" ${enabled ? "checked" : ""}><span></span></label></summary>
    <div class="cv-visit-effect-body">
      <p class="cv-action-note"><i class="fas fa-compass"></i> ${tr("VisitEffect.EditorHint", "Run rewards when a player enters this point. Exact references are saved for every linked module.")}</p>
      <div class="cv-grid"><label>${tr("VisitEffect.Scope", "Scope")}<select data-visit-effect="scope"><option value="group" ${effect.scope === "group" ? "selected" : ""}>${tr("VisitEffect.Group", "Whole group")}</option><option value="personal" ${effect.scope === "personal" ? "selected" : ""}>${tr("VisitEffect.Personal", "Each player")}</option></select></label><label>${tr("VisitEffect.Frequency", "Frequency")}<select data-visit-effect="repeatable"><option value="once" ${!effect.repeatable ? "selected" : ""}>${tr("VisitEffect.Once", "First visit only")}</option><option value="repeatable" ${effect.repeatable ? "selected" : ""}>${tr("VisitEffect.Repeatable", "Every visit")}</option></select></label></div>
      <p class="cv-visit-scope-note">${tr("VisitEffect.WorldOutputs", "Linked module results change shared world state. Personal scope tracks completion per player and shows the narrative only to that player.")}</p>
      <section class="cv-visit-output"><header><label class="cv-toggle"><input type="checkbox" data-visit-effect="narrative.enabled" ${effect.narrative.enabled ? "checked" : ""}><span></span> ${tr("VisitEffect.Narrative", "Narrative reveal")}</label></header><label>${tr("VisitEffect.RevealTitle", "Title")}<input data-visit-effect="narrative.title" value="${esc(effect.narrative.title)}"></label><label>${tr("VisitEffect.RevealText", "Text")}<textarea rows="3" data-visit-effect="narrative.text">${esc(effect.narrative.text)}</textarea></label></section>
      <section class="cv-visit-output"><header><label class="cv-toggle"><input type="checkbox" data-visit-effect="city.enabled" ${effect.city.enabled ? "checked" : ""}><span></span> ${tr("VisitEffect.CityReveal", "Reveal another city point")}</label></header><label>${tr("VisitEffect.CityTarget", "City point")}${targetSelect("city", ["cityId", "screenId", "pointId"], effect.city, cityTargets, tr("VisitEffect.SelectCity", "Select an exact point"))}</label></section>
      <section class="cv-visit-output"><header><label class="cv-toggle"><input type="checkbox" data-visit-effect="mind.enabled" ${effect.mind.enabled ? "checked" : ""}><span></span> ${tr("VisitEffect.MindReveal", "Reveal a Mind Palace clue")}</label></header><label>${tr("VisitEffect.MindTarget", "Investigation clue")}${targetSelect("mind", ["boardId", "nodeId"], effect.mind, mindTargets, tr("VisitEffect.SelectMind", "Select an exact clue"))}</label></section>
      <section class="cv-visit-output"><header><label class="cv-toggle"><input type="checkbox" data-visit-effect="story.enabled" ${effect.story.enabled ? "checked" : ""}><span></span> ${tr("VisitEffect.StoryChange", "Change a story variable")}</label></header><label>${tr("VisitEffect.StoryTarget", "Dialogue Stage variable")}${targetSelect("story", ["variableId"], effect.story, storyTargets, tr("VisitEffect.SelectStory", "Select an exact variable"))}</label><div class="cv-grid"><label>${tr("VisitEffect.Operation", "Operation")}<select data-visit-effect="story.operation"><option value="set" ${effect.story.operation === "set" ? "selected" : ""}>${tr("VisitEffect.Set", "Set")}</option><option value="add" ${effect.story.operation === "add" ? "selected" : ""}>${tr("VisitEffect.Add", "Add")}</option></select></label><label>${tr("VisitEffect.Value", "Value")}<input type="number" step="any" data-visit-effect="story.value" value="${esc(effect.story.value)}"></label></div></section>
      <section class="cv-visit-output"><header><label class="cv-toggle"><input type="checkbox" data-visit-effect="chronicle.enabled" ${effect.chronicle.enabled ? "checked" : ""}><span></span> ${tr("VisitEffect.ChronicleOpen", "Open a Chronicle timeline")}</label></header><label>${tr("VisitEffect.ChronicleTarget", "Chronicle timeline")}${targetSelect("chronicle", ["timelineId"], effect.chronicle, chronicleTargets, tr("VisitEffect.SelectChronicle", "Select an exact timeline"))}</label></section>
      <details class="cv-advanced"><summary><i class="fas fa-code"></i> ${tr("VisitEffect.ExactReferences", "Exact references")}</summary><div class="cv-grid">${field(tr("VisitEffect.CityId", "City ID"), "city.cityId", effect.city.cityId, "visit-effect")}${field(tr("VisitEffect.ScreenId", "Screen ID"), "city.screenId", effect.city.screenId, "visit-effect")}${field(tr("VisitEffect.PointId", "Point ID"), "city.pointId", effect.city.pointId, "visit-effect")}${field(tr("VisitEffect.BoardId", "Board ID"), "mind.boardId", effect.mind.boardId, "visit-effect")}${field(tr("VisitEffect.EvidenceId", "Evidence ID"), "mind.nodeId", effect.mind.nodeId, "visit-effect")}${field(tr("VisitEffect.VariableId", "Variable ID"), "story.variableId", effect.story.variableId, "visit-effect")}${field(tr("VisitEffect.TimelineId", "Timeline ID"), "chronicle.timelineId", effect.chronicle.timelineId, "visit-effect")}</div></details>
    </div>
  </details>`;
}
function screenProps(d, c) {
  const controls = `<div class="cv-grid"><label>${tr("Editor.Canvas", "Canvas movement")}<select data-city="pan"><option value="none" ${d.pan === "none" ? "selected" : ""}>${tr("Pan.None", "Fixed")}</option><option value="vertical" ${d.pan === "vertical" ? "selected" : ""}>${tr("Pan.Vertical", "Vertical drag")}</option><option value="horizontal" ${d.pan === "horizontal" ? "selected" : ""}>${tr("Pan.Horizontal", "Horizontal drag")}</option><option value="free" ${d.pan === "free" ? "selected" : ""}>${tr("Pan.Free", "Free drag")}</option></select></label><label>${tr("Editor.PointStyle", "Point style")}<select data-city="pointStyle"><option value="pin" ${d.pointStyle === "pin" ? "selected" : ""}>${tr("Point.Pin", "Fantasy pin")}</option><option value="map" ${d.pointStyle === "map" ? "selected" : ""}>${tr("Point.Map", "Map mark")}</option></select></label></div><div class="cv-grid">${field(tr("Editor.CameraZoom", "Starting zoom"), "cameraZoom", d.cameraZoom, "city", "number")}<label class="cv-toggle"><input type="checkbox" data-city="cameraFollow" ${d.cameraFollow ? "checked" : ""}><span></span> ${tr("Editor.CameraFollow", "Camera follows the pointer")}</label></div><label class="cv-toggle"><input type="checkbox" data-city="mindPalace" ${d.mindPalace ? "checked" : ""}><span></span> ${tr("Editor.MindPalace", "Mind Palace journal button")}</label><div class="cv-preset-row"><button data-preset-action="save-location"><i class="fas fa-box-archive"></i> ${tr("Editor.SaveLocationPreset", "Save location as preset")}</button></div>`;
  return `<div class="cv-panel-title"><div><h2>${tr("UI.ScreenSettings", "Screen settings")}</h2><p>${tr("UI.ScreenSettingsSub", "Background and behavior of the current screen")}</p></div></div><button type="button" data-copy-screen-uuid>${tr("Media.CopyUUID", "Copy UUID")}</button>${field(tr("UI.City", "City"), "name", c.name, "collection")}${field(tr("UI.ScreenName", "Screen name"), "title", d.title, "city")}<div class="cv-grid cv-title-toggles"><label class="cv-toggle"><input type="checkbox" data-city="showTitle" ${d.showTitle ? "checked" : ""}><span></span> ${tr("UI.Title", "Title")}</label><label class="cv-toggle"><input type="checkbox" data-city="showSubtitle" ${d.showSubtitle ? "checked" : ""}><span></span> ${tr("UI.Subtitle", "Subtitle")}</label></div>${fileField(tr("UI.Background", "Background"), "background", d.background, "city", "background", "folder-open")}<div class="cv-preset-row"><button type="button" data-background-folder>${tr("Media.RandomFolder", "Random image folder")}</button>${d.backgroundFolder ? `<button type="button" data-background-folder-refresh title="${tr("Media.RefreshFolder", "Refresh folder")}"><i class="fas fa-rotate"></i></button><button type="button" data-background-folder-clear>${tr("Media.ClearFolder", "Clear")}</button>` : ""}</div><div class="cv-grid"><label>${tr("UI.Effect", "Effect")}<select data-city="weather"><option value="none" ${d.weather === "none" ? "selected" : ""}>${tr("UI.None", "None")}</option><option value="rain" ${d.weather === "rain" ? "selected" : ""}>${tr("UI.Rain", "Rain")}</option><option value="snow" ${d.weather === "snow" ? "selected" : ""}>${tr("UI.Snow", "Snow")}</option><option value="fog" ${d.weather === "fog" ? "selected" : ""}>${tr("UI.Fog", "Fog")}</option><option value="embers" ${d.weather === "embers" ? "selected" : ""}>${tr("UI.Embers", "Embers")}</option></select></label><label>${tr("UI.Transition", "Transition")}<select data-city="transition"><option value="fade" ${d.transition === "fade" ? "selected" : ""}>${tr("UI.Fade", "Fade")}</option><option value="slide" ${d.transition === "slide" ? "selected" : ""}>${tr("UI.Slide", "Slide")}</option><option value="zoom" ${d.transition === "zoom" ? "selected" : ""}>${tr("UI.Zoom", "Zoom")}</option><option value="blur" ${d.transition === "blur" ? "selected" : ""}>${tr("UI.Blur", "Blur")}</option><option value="iris" ${d.transition === "iris" ? "selected" : ""}>${tr("UI.Iris", "Iris")}</option></select></label></div>${controls}<label class="cv-toggle"><input type="checkbox" data-city="parallax" ${d.parallax ? "checked" : ""}><span></span> ${tr("UI.Parallax", "Parallax")}</label><details class="cv-advanced"><summary><i class="fas fa-sliders"></i> ${tr("UI.Advanced", "Advanced")}</summary>${field(tr("UI.Subtitle", "Subtitle"), "subtitle", d.subtitle, "city")}<label>${tr("UI.Fit", "Image fit")}<select data-city="fit"><option value="cover" ${d.fit === "cover" ? "selected" : ""}>${tr("UI.Cover", "Fill screen")}</option><option value="contain" ${d.fit === "contain" ? "selected" : ""}>${tr("UI.Contain", "Show entire image")}</option></select></label>${fileField(tr("UI.Music", "Music"), "ambience", d.ambience, "city", "ambience", "music")}${field(tr("UI.ParallaxStrength", "Parallax strength"), "parallaxStrength", d.parallaxStrength, "city", "number")}${field(tr("UI.EffectDensity", "Effect density"), "weatherIntensity", d.weatherIntensity, "city", "number")}</details>`;
}
function props(o) {
  const appearance =
    o.kind === "poi"
      ? `${fileField(tr("Media.MarkerImage", "Custom image"), "markerImage", o.markerImage, "object", "markerImage", "folder-open")}<div class="cv-grid">
      <label>${tr("UI.Icon", "Icon")}<select data-object="markerIcon"><option value="fa-location-dot" ${o.markerIcon === "fa-location-dot" ? "selected" : ""}>${tr("Marker.Pin", "Marker")}</option><option value="fa-compass" ${o.markerIcon === "fa-compass" ? "selected" : ""}>${tr("Marker.Compass", "Compass")}</option><option value="fa-landmark" ${o.markerIcon === "fa-landmark" ? "selected" : ""}>${tr("Marker.Building", "Building")}</option><option value="fa-skull" ${o.markerIcon === "fa-skull" ? "selected" : ""}>${tr("Marker.Danger", "Danger")}</option><option value="fa-gem" ${o.markerIcon === "fa-gem" ? "selected" : ""}>${tr("Marker.Treasure", "Treasure")}</option><option value="fa-question" ${o.markerIcon === "fa-question" ? "selected" : ""}>${tr("Marker.Mystery", "Mystery")}</option></select></label>
      <label>${tr("UI.Color", "Color")}<input type="color" data-object="markerColor" value="${esc(o.markerColor)}"></label></div>`
      : `${fileField(tr("UI.ImageVideo", "Image / video"), "src", o.src, "object", "object", "folder-open")}
    <div class="cv-segments"><button data-media="image" class="${o.media === "image" ? "active" : ""}"><i class="fas fa-image"></i> ${tr("UI.PictureGif", "Image / GIF")}</button><button data-media="video" class="${o.media === "video" ? "active" : ""}"><i class="fas fa-film"></i> ${tr("UI.Video", "Video")}</button></div>`;
  const availableActions =
    o.kind === "poi"
      ? Object.entries(ACTIONS).filter(([key]) =>
          ["info", "screen", "macro", "dialogue", "check", "actor", "journal", "chat"].includes(key) || S.customActions.has(key),
        )
      : Object.entries(ACTIONS);
  if (!availableActions.some(([key]) => key === o.action))
    availableActions.push([o.action, o.action]);
  const actionValue =
    o.action === "screen"
      ? `<label>${tr("UI.TargetScreen", "Target screen")}<select data-object="value">${editCity()
          .screens.map(
            (s) =>
              `<option value="${s.id}" ${o.value === s.id ? "selected" : ""}>${esc(s.title)}</option>`,
          )
          .join("")}</select></label>`
      : o.action === "macro"
        ? `<label>${tr("UI.Macro", "Macro")}<select data-object="value"><option value="">${tr("UI.SelectMacro", "Select macro")}</option>${game.macros.contents.map((m) => `<option value="${m.uuid}" ${o.value === m.uuid ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>`
        : o.action === "dialogue"
          ? dialogueField(o.value)
        : o.action === "check"
          ? `<div class="cv-grid"><label>${tr("Check.Type", "Check type")}<select data-object="checkType"><option value="skill" ${o.checkType === "skill" ? "selected" : ""}>${tr("Check.Skill", "Skill")}</option><option value="ability" ${o.checkType === "ability" ? "selected" : ""}>${tr("Check.Ability", "Ability")}</option><option value="save" ${o.checkType === "save" ? "selected" : ""}>${tr("Check.Save", "Saving throw")}</option></select></label>${field(tr("Check.Key", "Skill / ability key"), "checkKey", o.checkKey)}${field(tr("Check.DC", "Difficulty"), "checkDC", o.checkDC, "object", "number")}<label>${tr("Check.Target", "Who rolls")}<select data-object="checkTarget"><option value="self" ${o.checkTarget === "self" ? "selected" : ""}>${tr("Check.Clicker", "Player who clicked")}</option><option value="all" ${o.checkTarget === "all" ? "selected" : ""}>${tr("Check.Everyone", "All players")}</option></select></label></div><p class="cv-action-note"><i class="fas fa-dice-d20"></i> ${tr("Check.MidiHint", "Midi-QOL will handle the roll automatically when active.")}</p>`
        : o.action === "actor"
          ? `<p class="cv-action-note"><i class="fas fa-user"></i> ${tr("Bindings.ActorHint", "The linked actor sheet will open.")}</p>`
        : `<label>${o.action === "journal" ? tr("UI.JournalUUID", "Journal UUID") : o.action === "url" ? tr("UI.Link", "Link") : o.action === "chat" ? tr("UI.ChatText", "Chat message") : tr("UI.WindowText", "Window text")}<textarea data-object="value" rows="3" placeholder="${o.action === "journal" ? tr("UI.JournalPlaceholder", "JournalEntry.xxxxx or page UUID") : tr("UI.Optional", "Optional")}">${esc(o.value)}</textarea></label>`,
    explorationFields =
      o.kind === "poi"
        ? `<section class="cv-exploration-editor"><h2><i class="fas fa-map-signs"></i> ${tr("Exploration.Title", "Exploration")}</h2><div class="cv-grid"><label>${tr("Exploration.InitialState", "Initial access")}<select data-object="pointState"><option value="visible" ${o.pointState === "visible" ? "selected" : ""}>${tr("Exploration.Visible", "Visible")}</option><option value="secret" ${o.pointState === "secret" ? "selected" : ""}>${tr("Exploration.Secret", "Secret")}</option><option value="locked" ${o.pointState === "locked" ? "selected" : ""}>${tr("Exploration.Locked", "Locked")}</option></select></label><label>${tr("Exploration.VisitTracking", "Visited tracking")}<select data-object="visitMode"><option value="none" ${o.visitMode === "none" ? "selected" : ""}>${tr("Exploration.VisitNone", "Off")}</option><option value="personal" ${o.visitMode === "personal" ? "selected" : ""}>${tr("Exploration.VisitPersonal", "For each player")}</option><option value="group" ${o.visitMode === "group" ? "selected" : ""}>${tr("Exploration.VisitGroup", "For the whole group")}</option></select></label></div><label>${tr("Exploration.LockReason", "Locked reason")}<textarea data-object="lockReason" rows="3" placeholder="${esc(tr("Exploration.LockReasonPlaceholder", "What must the party do to enter?"))}">${esc(o.lockReason)}</textarea></label><p class="cv-action-note"><i class="fas fa-circle-info"></i> ${tr("Exploration.EditorHint", "The Game Master can change live access directly in the viewer.")}</p>${visitEffectEditor(o)}</section>`
        : "";
  return `<h2><i class="fas fa-wand-magic-sparkles"></i> ${tr("UI.Layer", "Layer")}</h2>${field(tr("UI.Name", "Name"), "name", o.name)}
    <div class="cv-kind"><button data-kind="asset" class="${o.kind === "asset" ? "active" : ""}"><i class="fas fa-image"></i> ${tr("UI.Image", "Image")}</button><button data-kind="poi" class="${o.kind === "poi" ? "active" : ""}"><i class="fas fa-location-dot"></i> ${tr("UI.PointOfInterest", "Point of interest")}</button></div>${appearance}${imageFolderControls(o)}<div class="cv-layer-controls">${field(tr("Media.ZOrder", "Layer order"), "z", o.z, "object", "number")}<div class="cv-order"><button type="button" data-order="bottom" title="${tr("Media.Bottom", "To bottom")}" aria-label="${tr("Media.Bottom", "To bottom")}"><i class="fas fa-angles-down"></i></button><button type="button" data-order="down" title="${tr("UI.Lower", "Lower")}" aria-label="${tr("UI.Lower", "Lower")}"><i class="fas fa-arrow-down"></i></button><button type="button" data-order="up" title="${tr("UI.Higher", "Higher")}" aria-label="${tr("UI.Higher", "Higher")}"><i class="fas fa-arrow-up"></i></button><button type="button" data-order="top" title="${tr("UI.Top", "To top")}" aria-label="${tr("UI.Top", "To top")}"><i class="fas fa-angles-up"></i></button></div></div><button type="button" data-copy-entity-uuid>${tr("Media.CopyUUID", "Copy UUID")}</button>${explorationFields}
    <h2><i class="fas fa-bolt"></i> ${tr("UI.ActiveAction", "Active action")}</h2><label class="cv-toggle"><input type="checkbox" data-object="interactive" ${o.interactive ? "checked" : ""}><span></span> ${tr("UI.PlayerAvailable", "Available to players")}</label>
    ${field(tr("UI.ActionTitle", "Action title"), "actionTitle", o.actionTitle)}<label>${tr("UI.Hint", "Hint")}<textarea data-object="hint" rows="3">${esc(o.hint)}</textarea></label>
    <label>${tr("UI.Action", "Action")}<select data-object="action">${availableActions.map(([v, l]) => `<option value="${v}" ${o.action === v ? "selected" : ""}>${tr(l, l)}</option>`).join("")}</select></label>${actionValue}
    <details class="cv-bindings" open><summary><i class="fas fa-link"></i> ${tr("Bindings.Title", "Linked documents")}</summary><p class="cv-action-note">${tr("Bindings.Help", "Drag an Actor or Journal from the sidebar into the editor, or paste its UUID.")}</p>${field(tr("Bindings.ActorUUID", "Actor UUID"), "actorUuid", o.actorUuid)}${field(tr("Bindings.JournalUUID", "Journal UUID"), "journalUuid", o.journalUuid)}</details>
    <details class="cv-advanced"><summary><i class="fas fa-sliders"></i> ${tr("UI.Advanced", "Advanced")}</summary><div class="cv-grid">${field("X, %", "x", o.x, "object", "number")}${field("Y, %", "y", o.y, "object", "number")}${field(tr("UI.WidthPct", "Width, %"), "w", o.w, "object", "number")}${field(tr("UI.HeightPct", "Height, %"), "h", o.h, "object", "number")}${field(tr("UI.Rotation", "Rotation"), "rotation", o.rotation, "object", "number")}${field(tr("UI.Opacity", "Opacity"), "opacity", o.opacity, "object", "number")}</div>${fileField(tr("UI.ClickSound", "Click sound"), "sound", o.sound, "object", "sound", "volume-high")}</details><div class="cv-preset-row"><button data-preset-action="save-object"><i class="fas fa-box-archive"></i> ${tr("Editor.SaveObjectPreset", "Save as preset")}</button></div><button class="danger" data-act="delete"><i class="fas fa-trash"></i> ${tr("UI.DeleteObject", "Delete object")}</button>`;
}

function imageFolderControls(o) {
  return `<div class="cv-preset-row"><button type="button" data-image-folder><i class="fas fa-folder-open"></i> ${tr("Media.RandomFolder", "Random image folder")}</button>${o.imageFolder ? `<button type="button" data-image-folder-refresh title="${tr("Media.RefreshFolder", "Refresh folder")}"><i class="fas fa-rotate"></i></button><button type="button" data-image-folder-clear>${tr("Media.ClearFolder", "Clear")}</button>` : ""}</div>${o.imageFolder ? `<p class="cv-action-note">${esc(o.imageFolder)} · ${o.imagePool.length}</p>` : ""}`;
}

async function refreshImageFolder(background = false) {
  const object = background ? editScreen() : selected(), editor = S.editor;
  if (!object) return;
  const prefix = background ? "background" : "image";
  const folder = object[`${prefix}Folder`];
  if (!folder) return;
  const source = object[`${prefix}Source`] || "data", bucket = object[`${prefix}Bucket`];
  const Picker = foundry.applications?.apps?.FilePicker?.implementation || globalThis.FilePicker;
  try {
    const result = await Picker.browse(source, folder, source === "s3" ? { bucket } : {});
    const files = result.files.filter(file => /\.(png|jpe?g|webp|gif|avif|svg)(?:\?.*)?$/i.test(file)).slice(0, 1000);
    if (!files.length) return ui.notifications.warn(tr("Media.EmptyFolder", "No images in this folder."));
    if (S.editor !== editor || (background ? editScreen() : selected()) !== object || object[`${prefix}Folder`] !== folder) return;
    recordUndo();
    object[`${prefix}Pool`] = files;
    const field = background ? "background" : object.kind === "poi" ? "markerImage" : "src";
    if (!files.includes(object[field])) object[field] = files[0];
    renderEditor(); autosave();
  } catch (error) { ui.notifications.error(error.message); }
}

function moveObjectLayer(screen, object, direction) {
  const layers = [...screen.objects].sort((a, b) => a.z - b.z);
  const index = layers.indexOf(object);
  if (index < 0) return;
  const target = direction === "top" ? layers.length - 1 : direction === "bottom" ? 0 :
    Math.max(0, Math.min(layers.length - 1, index + (direction === "up" ? 1 : -1)));
  layers.splice(index, 1); layers.splice(target, 0, object);
  layers.forEach((layer, index) => { layer.z = index + 1; });
}
async function chooseImageFolder(background = false) {
  let object = background ? editScreen() : selected();
  const editor = S.editor, target = { city: S.city, screen: S.screen, object: S.selected };
  if (!object) return;
  const Picker = foundry.applications?.apps?.FilePicker?.implementation || globalThis.FilePicker;
  return picker("folder", (background ? object.backgroundFolder : object.imageFolder) || "", async (folder, selection) => {
      try {
        const result = await Picker.browse(selection?.activeSource || "data", folder, selection?.activeSource === "s3" ? { bucket: selection.sources?.s3?.bucket } : {});
        const files = result.files.filter(file => /\.(png|jpe?g|webp|gif|avif|svg)(?:\?.*)?$/i.test(file)).slice(0, 1000);
        if (!files.length) return ui.notifications.warn(tr("Media.EmptyFolder", "No images in this folder."));
        if (S.editor !== editor) return;
        const screen = S.draft?.cities.find(c => c.id === target.city)?.screens.find(s => s.id === target.screen);
        object = background ? screen : screen?.objects.find(o => o.id === target.object);
        if (!object) return;
        recordUndo();
        const source = selection?.activeSource || "data", bucket = source === "s3" ? selection.sources?.s3?.bucket || "" : "";
        if (background) Object.assign(object, { backgroundFolder: folder, backgroundPool: files, background: files[0], backgroundSource: source, backgroundBucket: bucket });
        else {
          object.imageFolder = folder;
          object.imageSource = source;
          object.imageBucket = bucket;
          object.imagePool = files;
          object[object.kind === "poi" ? "markerImage" : "src"] = files[0];
          if (object.kind !== "poi") object.media = "image";
        }
        renderEditor(); autosave();
      } catch (error) { ui.notifications.error(error.message); }
  });
}
function randomizeScreenImages(screen) {
  const result = copy(screen);
  if (result.backgroundFolder && result.backgroundPool?.length)
    result.background = result.backgroundPool[Math.floor(Math.random() * result.backgroundPool.length)];
  for (const object of result.objects) {
    if (!object.imageFolder || !object.imagePool?.length) continue;
    const source = object.imagePool[Math.floor(Math.random() * object.imagePool.length)];
    object[object.kind === "poi" ? "markerImage" : "src"] = source;
    if (object.kind !== "poi") object.media = "image";
  }
  return result;
}
function addObject(kind = "asset") {
  const d = editScreen();
  if (d.objects.length >= LIMITS.objects)
    return ui.notifications.warn(tr("Limits.Objects", "This screen has reached the element limit."));
  recordUndo();
  const poi = kind === "poi";
  const o = normalizeScreen({
    objects: [
      {
        id: id(),
        kind,
        name: `${poi ? tr("Default.Point", "Point of interest") : tr("Default.Object", "New object")} ${d.objects.length + 1}`,
        w: poi ? 5 : 22,
        h: poi ? 9 : 30,
        x: poi ? 47.5 : 38,
        y: poi ? 45 : 31,
        actionTitle: tr("Default.Inspect", "Inspect"),
        hint: poi
          ? tr("Default.PointHint", "Click to learn more about this place.")
          : tr("Default.Hint", "Click to inspect this place."),
        z: Math.max(0, ...d.objects.map((x) => x.z)) + 1,
      },
    ],
  }).objects[0];
  d.objects.push(o);
  S.selected = o.id;
  renderEditor();
  autosave();
}
function removeObject() {
  if (!selected()) return;
  recordUndo();
  const d = editScreen();
  d.objects = d.objects.filter((o) => o.id !== S.selected);
  S.selected = d.objects.at(-1)?.id || null;
  renderEditor();
  autosave();
}

function remapCopiedVisitTarget(
  object,
  { sourceCityId, targetCityId, screenIds, pointIds },
) {
  const effect = normalizeVisitEffect(object.visitEffect),
    target = effect.city;
  if (
    target.cityId !== sourceCityId ||
    !screenIds.has(target.screenId)
  ) {
    object.visitEffect = effect;
    return object;
  }
  const mappedPoint = pointIds.get(`${target.screenId}/${target.pointId}`);
  if (!mappedPoint) {
    object.visitEffect = effect;
    return object;
  }
  target.cityId = targetCityId;
  target.screenId = screenIds.get(target.screenId);
  target.pointId = mappedPoint;
  object.visitEffect = effect;
  return object;
}

function createScreen(duplicate = false) {
  const source = editScreen(),
    c = editCity();
  if (c.screens.length >= LIMITS.screens)
    return ui.notifications.warn(tr("Limits.Screens", "This city has reached the screen limit."));
  recordUndo();
  let next;
  if (duplicate) {
    const nextScreenId = id(),
      screenIds = new Map([[source.id, nextScreenId]]),
      pointIds = new Map(
        source.objects.map((object) => [
          `${source.id}/${object.id}`,
          id(),
        ]),
      ),
      objects = source.objects.map((object) =>
        remapCopiedVisitTarget(
          {
            ...copy(object),
            id: pointIds.get(`${source.id}/${object.id}`),
          },
          {
            sourceCityId: c.id,
            targetCityId: c.id,
            screenIds,
            pointIds,
          },
        ),
      );
    next = normalizeScreen({
      ...copy(source),
      id: nextScreenId,
      title: `${source.title} — ${tr("Default.Copy", "copy")}`,
      objects,
    });
  } else
    next = normalizeScreen({
        id: id(),
        title: `${tr("Default.NewScreen", "New screen")} ${c.screens.length + 1}`,
        subtitle: tr("Default.ChooseDestination", "Choose a destination"),
        objects: [],
      });
  c.screens.push(next);
  S.screen = next.id;
  S.selected = null;
  renderEditor();
  autosave();
}
function deleteScreen() {
  const c = editCity();
  if (c.screens.length <= 1)
    return ui.notifications.warn(
      tr("Limits.OneScreen", "A city must contain at least one screen."),
    );
  const index = c.screens.findIndex((s) => s.id === S.screen),
    removed = S.screen;
  if (index < 0) return;
  recordUndo();
  c.screens.splice(index, 1);
  S.screen = c.screens[Math.max(0, index - 1)].id;
  if (c.startScreen === removed) c.startScreen = S.screen;
  for (const screen of c.screens)
    for (const o of screen.objects)
      if (o.action === "screen" && o.value === removed) {
        o.action = "info";
        o.value = "";
      }
  S.selected = null;
  renderEditor();
  autosave();
}
function createCity(duplicate = false) {
  if (S.draft.cities.length >= LIMITS.cities)
    return ui.notifications.warn(tr("Limits.Cities", "This project has reached the city limit."));
  recordUndo();
  const source = editCity();
  let next;
  if (duplicate) {
    const nextCityId = id(),
      screenIds = new Map(source.screens.map((s) => [s.id, id()])),
      pointIds = new Map(
        source.screens.flatMap((screen) =>
          screen.objects.map((object) => [
            `${screen.id}/${object.id}`,
            id(),
          ]),
        ),
      );
    const screens = source.screens.map((s) => ({
      ...copy(s),
      id: screenIds.get(s.id),
      objects: s.objects.map((o) =>
        remapCopiedVisitTarget(
          {
            ...copy(o),
            id: pointIds.get(`${s.id}/${o.id}`),
            value:
              o.action === "screen" ? screenIds.get(o.value) || "" : o.value,
          },
          {
            sourceCityId: source.id,
            targetCityId: nextCityId,
            screenIds,
            pointIds,
          },
        ),
      ),
    }));
    next = normalizeCity({
      id: nextCityId,
      name: `${source.name} — ${tr("Default.Copy", "copy")}`,
      startScreen: screenIds.get(source.startScreen),
      screens,
    });
  } else
    next = normalizeCity({
      id: id(),
      name: `${tr("Default.NewCity", "New city")} ${S.draft.cities.length + 1}`,
      title: tr("Default.NewCity", "New city"),
    });
  S.draft.cities.push(next);
  S.city = next.id;
  S.screen = next.startScreen;
  S.selected = editScreen().objects[0]?.id || null;
  renderEditor();
  autosave();
}
function openTemplates() {
  const host = S.editor;
  if (!host) return;
  host.querySelector(".cv-template-layer")?.remove();
  const layer = document.createElement("div");
  layer.className = "cv-template-layer";
  layer.innerHTML = `<section class="cv-template-dialog"><header><div><h2>${tr("Templates.Title", "Ready-made cities")}</h2><p>${tr("Templates.Subtitle", "Create a working structure and customize it.")}</p></div><button class="icon" data-template-close><i class="fas fa-xmark"></i></button></header><div class="cv-template-grid">${templateMeta()
    .map(
      (t) =>
        `<button data-template="${t.id}"><img src="${TEMPLATE_ASSET(t.image)}" alt=""><span><strong>${t.name}</strong><small>${t.description}</small><b>${tr("Templates.Use", "Use template")} <i class="fas fa-arrow-right"></i></b></span></button>`,
    )
    .join(
      "",
    )}</div><footer><i class="fas fa-circle-info"></i> ${tr("Templates.Local", "Images are stored locally inside the module.")}</footer></section>`;
  layer.onclick = (event) => {
    if (event.target === layer || event.target.closest("[data-template-close]"))
      return layer.remove();
    const key = event.target.closest("[data-template]")?.dataset.template;
    if (!key) return;
    if (S.draft.cities.length >= LIMITS.cities)
      return ui.notifications.warn(tr("Limits.Cities", "This project has reached the city limit."));
    const next = buildTemplate(key);
    recordUndo();
    S.draft.cities.push(next);
    S.city = next.id;
    S.screen = next.startScreen;
    S.selected = null;
    layer.remove();
    renderEditor();
    autosave();
    ui.notifications.info(
      `${tr("Templates.Created", "Created")}: ${next.name}`,
    );
  };
  host.append(layer);
}
async function deleteCity() {
  if (S.draft.cities.length <= 1)
    return ui.notifications.warn(
      tr("Limits.OneCity", "A project must contain at least one city."),
    );
  const name = editCity().name,
    D = foundry.applications?.api?.DialogV2,
    confirmed = D
      ? await D.confirm({
          window: { title: tr("Confirm.DeleteCity.Title", "Delete city?") },
          content: `<p>${tr("Confirm.DeleteCity.Body", "City {name} and all of its screens will be deleted.").replace("{name}", `<strong>${esc(name)}</strong>`)}</p>`,
          yes: { label: tr("UI.Delete", "Delete") },
          no: { label: tr("UI.Cancel", "Cancel") },
        })
      : window.confirm(
          tr("Confirm.DeleteCity.Plain", "Delete city “{name}”?").replace(
            "{name}",
            name,
          ),
        );
  if (!confirmed) return;
  const removed = S.city,
    index = S.draft.cities.findIndex((c) => c.id === removed);
  if (index < 0) return;
  recordUndo();
  S.draft.cities.splice(index, 1);
  S.city = S.draft.cities[Math.max(0, index - 1)].id;
  if (
    S.draft.activeCity === removed ||
    !S.draft.cities.some((c) => c.id === S.draft.activeCity)
  )
    S.draft.activeCity = S.city;
  S.screen = editCity().startScreen;
  S.selected = editScreen().objects[0]?.id || null;
  renderEditor();
  autosave();
}
function copyPoint() {
  const o = selected();
  if (o?.kind !== "poi")
    return ui.notifications.warn(
      tr("Notify.SelectPoint", "Select a point of interest first."),
    );
  S.clipboard = copy(o);
  ui.notifications.info(
    tr("Notify.PointCopied", "Point copied — press Ctrl+V to paste it."),
  );
}
function pastePoint() {
  if (!S.clipboard) return;
  if (editScreen().objects.length >= LIMITS.objects)
    return ui.notifications.warn(tr("Limits.Objects", "This screen has reached the element limit."));
  recordUndo();
  const d = editScreen(),
    o = {
      ...copy(S.clipboard),
      id: id(),
      name: `${S.clipboard.name} — ${tr("Default.Copy", "copy")}`,
      x: clamp(S.clipboard.x + 2, 0, 95),
      y: clamp(S.clipboard.y + 2, 0, 95),
      z: Math.max(0, ...d.objects.map((x) => x.z)) + 1,
    };
  d.objects.push(o);
  S.selected = o.id;
  renderEditor();
  autosave();
}

function validateImportedProject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new TypeError(tr("Import.Invalid", "The backup is not a City Viewer project."));
  if (!Array.isArray(raw.cities) || !raw.cities.length)
    throw new TypeError(tr("Import.NoCities", "The backup does not contain any cities."));
  if (raw.cities.length > LIMITS.cities)
    throw new RangeError(tr("Import.TooManyCities", "The backup contains too many cities."));
  let objectCount = 0;
  for (const item of raw.cities) {
    if (!item || typeof item !== "object" || !Array.isArray(item.screens) || !item.screens.length)
      throw new TypeError(tr("Import.InvalidCity", "A city in the backup has no screens."));
    if (item.screens.length > LIMITS.screens)
      throw new RangeError(tr("Import.TooManyScreens", "A city contains too many screens."));
    for (const screen of item.screens) {
      if (!screen || typeof screen !== "object")
        throw new TypeError(tr("Import.InvalidScreen", "The backup contains an invalid screen."));
      if (Array.isArray(screen.objects) && screen.objects.length > LIMITS.objects)
        throw new RangeError(tr("Import.TooManyObjects", "A screen contains too many elements."));
      objectCount += Array.isArray(screen.objects) ? screen.objects.length : 0;
      if (objectCount > LIMITS.projectObjects)
        throw new RangeError(tr("Import.TooManyProjectObjects", "The project contains too many elements."));
    }
  }
  return city(raw);
}
function exportProject() {
  if (!game.user.isGM || !S.draft) return;
  const project = city(copy(S.draft)),
    blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }),
    url = URL.createObjectURL(blob),
    anchor = document.createElement("a"),
    cityName = text(editCity()?.name, "city-viewer", 80).replace(/[^\p{L}\p{N}._-]+/gu, "-");
  anchor.href = url;
  anchor.download = `${cityName || "city-viewer"}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  ui.notifications.info(tr("Export.Done", "Backup downloaded."));
}
function importProject() {
  if (!game.user.isGM) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.hidden = true;
  document.body.append(input);
  input.addEventListener("cancel", () => input.remove(), { once: true });
  input.addEventListener(
    "change",
    async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (file.size > LIMITS.importBytes)
        return ui.notifications.error(tr("Import.TooLarge", "The backup is larger than 10 MB."));
      try {
        const imported = validateImportedProject(JSON.parse(await file.text()));
        recordUndo();
        S.draft = imported;
        S.city = imported.activeCity;
        S.screen = projectScreen(editCity(), imported.activeScreen).id;
        S.selected = null;
        renderEditor();
        await save();
        ui.notifications.info(tr("Import.Done", "Backup restored."));
      } catch (error) {
        console.error(`${MOD} | Import`, error);
        ui.notifications.error(error.message || tr("Import.Failed", "The backup could not be restored."));
      }
    },
    { once: true },
  );
  input.click();
}

function bindEditor(el) {
  el.onclick = async (e) => {
    if (e.target.closest("[data-copy-screen-uuid]")) {
      await save(); return globalThis.UniCanvasDocuments?.copyUuid(MOD, ["cities", S.city, "screens", S.screen]);
    }
    if (e.target.closest("[data-copy-entity-uuid]")) {
      await save();
      return globalThis.UniCanvasDocuments?.copyUuid(MOD, ["cities", S.city, "screens", S.screen, "objects", S.selected]);
    }
    if (e.target.closest("[data-background-folder]")) return chooseImageFolder(true);
    if (e.target.closest("[data-background-folder-refresh]")) return refreshImageFolder(true);
    if (e.target.closest("[data-background-folder-clear]")) {
      recordUndo(); Object.assign(editScreen(), { backgroundFolder: "", backgroundPool: [] }); renderEditorSelection(); return autosave();
    }
    if (e.target.closest("[data-image-folder]")) return chooseImageFolder();
    if (e.target.closest("[data-image-folder-refresh]")) return refreshImageFolder();
    if (e.target.closest("[data-image-folder-clear]")) {
      recordUndo();
      Object.assign(selected(), { imageFolder: "", imagePool: [] });
      renderEditorSelection();
      return autosave();
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") return closeEditor();
    if (act === "undo") return undoEditor();
    if (act === "redo") return redoEditor();
    if (act === "export") return exportProject();
    if (act === "import") return importProject();
    if (act === "newcity") return createCity();
    if (act === "duplicatecity") return createCity(true);
    if (act === "deletecity") return deleteCity();
    if (act === "newscreen") return createScreen();
    if (act === "duplicatescreen") return createScreen(true);
    if (act === "deletescreen") return deleteScreen();
    if (act === "startscreen") {
      recordUndo();
      editCity().startScreen = S.screen;
      renderEditor();
      autosave();
      return;
    }
    if (act === "add") return addObject();
    if (act === "addpoi") return addObject("poi");
    if (act === "delete") return removeObject();
    if (act === "save") return save(true).catch(() => undefined);
    if (act === "preview") {
      const screenId = S.screen,
        cityId = S.city;
      try {
        await save(true);
      } catch {
        return;
      }
      closeEditor();
      return openViewer(true, screenId, false, cityId);
    }
    if (act === "show") {
      const screenId = S.screen,
        cityId = S.city;
      try {
        await save(true);
      } catch {
        return;
      }
      closeEditor();
      return forceScreenForAll(cityId, screenId);
    }
    const cityId = e.target.closest("[data-city-id]")?.dataset.cityId;
    if (cityId && cityId !== S.city) {
      S.city = cityId;
      S.screen = editCity().startScreen;
      S.selected = null;
      return renderEditor();
    }
    const screen = e.target.closest("[data-screen]")?.dataset.screen;
    if (screen && screen !== S.screen) {
      S.screen = screen;
      S.selected = null;
      return renderEditor();
    }
    const sid =
      e.target.closest("[data-select]")?.dataset.select ||
      e.target.closest("[data-id]")?.dataset.id;
    if (sid && sid !== S.selected) {
      S.selected = sid;
      return renderEditorSelection();
    }
    if (
      e.target.closest(".cv-stage") &&
      !e.target.closest("[data-id]") &&
      S.selected
    ) {
      S.selected = null;
      return renderEditorSelection();
    }
    const upload = e.target.closest("[data-upload]")?.dataset.upload;
    if (upload) return uploadFromComputer(upload);
    const p = e.target.closest("[data-pick]")?.dataset.pick,
      o = selected();
    const d = editScreen();
    const target = { cityId: S.city, screenId: S.screen, objectId: S.selected };
    const picks = {
      background: [
        "imagevideo",
        d.background,
        (v) => applyResource("background", v, target),
      ],
      ambience: ["audio", d.ambience, (v) => applyResource("ambience", v, target)],
      object: ["imagevideo", o?.src, (v) => applyResource("object", v, target)],
      markerImage: ["image", o?.markerImage, (v) => {
        const item = projectScreen(projectCity(S.draft, target.cityId), target.screenId)?.objects.find(item => item.id === target.objectId);
        if (!item) return;
        recordUndo(); item.markerImage = v; renderEditor(); autosave();
      }],
      sound: ["audio", o?.sound, (v) => applyResource("sound", v, target)],
    };
    if (p) {
      const [t, c, cb] = picks[p];
      return picker(t, c, cb);
    }
    const media = e.target.closest("[data-media]")?.dataset.media;
    if (media && o) {
      recordUndo();
      o.media = media;
      renderEditor();
      autosave();
      return;
    }
    const kind = e.target.closest("[data-kind]")?.dataset.kind;
    if (kind && o && kind !== o.kind) {
      recordUndo();
      o.kind = kind;
      if (kind === "poi") {
        o.w = 5;
        o.h = 9;
        if (!["info", "screen", "macro", "dialogue", "check", "actor", "journal", "chat"].includes(o.action)) {
          o.action = "info";
          o.value = "";
        }
      } else {
        o.w = 22;
        o.h = 30;
      }
      renderEditor();
      autosave();
      return;
    }
    const order = e.target.closest("[data-order]")?.dataset.order;
    if (order && o) {
      recordUndo();
      moveObjectLayer(editScreen(), o, order);
      renderEditor();
      autosave();
    }
  };
  el.onfocusin = (event) => {
    if (event.target.matches?.("input,textarea,select"))
      S.editorHistory.fieldSnapshot ||= editorSnapshot();
  };
  el.oninput = (e) => {
    const ck = e.target.dataset.city,
      collectionKey = e.target.dataset.collection,
      ok = e.target.dataset.object,
      visitKey = e.target.dataset.visitEffect,
      o = selected();
    if (ck) {
      const cityNumbers = ["parallaxStrength", "weatherIntensity", "cameraZoom"];
      editScreen()[ck] =
        e.target.type === "checkbox"
          ? e.target.checked
          : cityNumbers.includes(ck)
            ? Number(e.target.value)
            : e.target.value;
      if (ck === "cameraZoom") editScreen()[ck] = clamp(editScreen()[ck], 1, 3);
      if (ck === "weatherIntensity") editScreen()[ck] = clamp(editScreen()[ck], 0.5, 2);
      if (ck === "parallaxStrength") editScreen()[ck] = clamp(editScreen()[ck], 0, 40);
    }
    if (collectionKey) editCity()[collectionKey] = e.target.value;
    if (ok && o) {
      const nums = ["x", "y", "w", "h", "rotation", "opacity", "checkDC", "z"];
      o[ok] =
        e.target.type === "checkbox"
          ? e.target.checked
          : nums.includes(ok)
            ? Number(e.target.value)
            : e.target.value;
      if (["x", "y"].includes(ok)) o[ok] = clamp(o[ok], 0, 100);
      if (["w", "h"].includes(ok)) o[ok] = clamp(o[ok], 2, 100);
      if (ok === "opacity") o.opacity = clamp(o.opacity, 0.05, 1);
      if (ok === "z") o.z = clamp(Math.trunc(o.z), -10000, 10000);
      if (ok === "checkDC") o.checkDC = clamp(o.checkDC, 0, 99);
      if (
        ok === "action" &&
        o.action === "screen" &&
        !editCity().screens.some((s) => s.id === o.value)
      )
        o.value =
          editCity().screens.find((s) => s.id !== S.screen)?.id || S.screen;
      if (ok === "action" && o.action === "dialogue") {
        const scenes = dialogueScenes();
        if (!scenes.some((scene) => scene.id === o.value || scene.nodes?.some((node) => node.id === o.value)))
          o.value = scenes[0]?.id || "";
      }
    }
    if (visitKey && o?.kind === "poi") {
      const effect = normalizeVisitEffect(o.visitEffect),
        targetType = visitKey.endsWith(".target")
          ? visitKey.split(".")[0]
          : "";
      if (targetType) {
        const keys = {
            city: ["cityId", "screenId", "pointId"],
            mind: ["boardId", "nodeId"],
            story: ["variableId"],
            chronicle: ["timelineId"],
          }[targetType],
          target = decodeVisitTarget(e.target.value, keys);
        for (const key of keys) effect[targetType][key] = target?.[key] || "";
      } else {
        const [section, key] = visitKey.split("."),
          value =
            e.target.type === "checkbox"
              ? e.target.checked
              : visitKey === "repeatable"
                ? e.target.value === "repeatable"
                : visitKey === "story.value"
                  ? finiteNumber(e.target.value)
                  : e.target.value;
        if (key && effect[section] && typeof effect[section] === "object")
          effect[section][key] = value;
        else if (!key) effect[section] = value;
      }
      o.visitEffect = normalizeVisitEffect(effect);
    }
    if (ck || collectionKey || ok || visitKey) {
      quickRender();
      autosave();
    }
  };
  el.onchange = (e) => {
    if (S.editorHistory.fieldSnapshot) {
      recordUndo(S.editorHistory.fieldSnapshot);
      S.editorHistory.fieldSnapshot = null;
    }
    if (e.target.dataset.object === "action") return renderEditorSelection();
    if (
      e.target.dataset.visitEffect &&
      (e.target.type === "checkbox" || e.target.tagName === "SELECT")
    )
      return renderEditorSelection();
    if (["pointState", "visitMode"].includes(e.target.dataset.object))
      return renderEditor();
    if (
      [
        "showTitle",
        "showSubtitle",
        "pan",
        "pointStyle",
        "weather",
        "weatherIntensity",
      ].includes(e.target.dataset.city)
    )
      renderEditor();
  };
  el.querySelector(".cv-stage").onpointerdown = transform;
  el.onkeydown = (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName),
      mod = e.ctrlKey || e.metaKey;
    if (!typing && mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyPoint();
    }
    if (!typing && mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      pastePoint();
    }
    if (!typing && mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      if (selected()?.kind === "poi") {
        S.clipboard = copy(selected());
        pastePoint();
      } else
        ui.notifications.warn(
          tr("Notify.SelectPoint", "Select a point of interest first."),
        );
    }
    if (!typing && mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      undoEditor();
    }
    if (
      !typing &&
      mod &&
      (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))
    ) {
      e.preventDefault();
      redoEditor();
    }
    if (e.key === "Delete" && !typing) removeObject();
  };
}

function quickRender() {
  const st = S.editor?.querySelector(".cv-stage"),
    d = editScreen();
  if (!st || !d) return;
  st.style.backgroundImage = d.background
    ? cssUrl(d.background)
    : "none";
  st.style.backgroundSize = d.fit;
  st.querySelector("h1").textContent = d.title;
  st.querySelector("p").textContent = d.subtitle;
  const screenLabel = S.editor.querySelector(`[data-screen="${CSS.escape(S.screen)}"] span`),
    cityLabel = S.editor.querySelector(`[data-city-id="${CSS.escape(S.city)}"] span`);
  if (screenLabel) screenLabel.textContent = d.title;
  if (cityLabel) cityLabel.textContent = editCity().name;
  for (const o of d.objects) {
    const e = st.querySelector(`[data-id="${CSS.escape(o.id)}"]`);
    if (!e) continue;
    for (const [k, v] of Object.entries({
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      r: o.rotation,
      op: o.opacity,
      z: o.z,
    }))
      e.style.setProperty(`--${k}`, v);
    e.querySelector("b").textContent = o.name;
    const label = e.querySelector(".cv-poi-label");
    if (label) label.textContent = o.name;
    const marker = e.querySelector(".cv-poi-marker");
    if (marker) marker.style.setProperty("--marker", o.markerColor);
    if (marker && e.classList.contains("has-marker-image") !== Boolean(o.markerImage)) {
      e.classList.toggle("has-marker-image", Boolean(o.markerImage));
      marker.querySelector(":scope > i, .cv-marker-image")?.remove();
      const content = document.createElement(o.markerImage ? "img" : "i");
      content.className = o.markerImage ? "cv-marker-image" : `fas ${o.markerIcon}`;
      if (o.markerImage) { content.alt = ""; content.draggable = false; }
      marker.prepend(content);
    }
    const icon = marker?.querySelector(":scope > i");
    if (icon) icon.className = `fas ${o.markerIcon}`;
    const media = e.querySelector("img,video");
    const source = o.kind === "poi" ? o.markerImage : o.src;
    if (media && media.getAttribute("src") !== source) media.setAttribute("src", source);
  }
}
function transform(e) {
  const node = e.target.closest("[data-id]");
  if (!node || e.button !== 0) return;
  e.preventDefault();
  const undoSnapshot = editorSnapshot();
  S.selected = node.dataset.id;
  const o = selected(),
    rect = e.currentTarget.getBoundingClientRect(),
    resize = e.target.classList.contains("cv-resize"),
    start = { cx: e.clientX, cy: e.clientY, x: o.x, y: o.y, w: o.w, h: o.h };
  let changed = false;
  e.currentTarget
    .querySelectorAll(".selected")
    .forEach((x) => x.classList.remove("selected"));
  node.classList.add("selected");
  const move = (m) => {
    const dx = ((m.clientX - start.cx) / rect.width) * 100,
      dy = ((m.clientY - start.cy) / rect.height) * 100;
    if (!changed && Math.abs(dx) + Math.abs(dy) > 0.05) {
      changed = true;
      recordUndo(undoSnapshot);
    }
    if (!changed) return;
    if (resize) {
      o.w = clamp(start.w + dx, 2, 100 - o.x);
      o.h = clamp(start.h + dy, 2, 100 - o.y);
    } else {
      o.x = clamp(start.x + dx, 0, 100 - o.w);
      o.y = clamp(start.y + dy, 0, 100 - o.h);
    }
    quickRender();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    S.editorPointerCleanup = null;
    if (changed) autosave();
    renderEditorSelection();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  S.editorPointerCleanup = up;
}
function closeEditor() {
  clearTimeout(S.timer);
  S.editorPointerCleanup?.();
  if (S.draft) save().catch(() => undefined);
  S.editor?.remove();
  S.editor = null;
  S.editorHistory.fieldSnapshot = null;
}

async function setVisible(show) {
  if (!game.user.isGM) return;
  try {
    if (show && S.draft && S.city) {
      S.draft.activeCity = S.city;
      S.draft.activeScreen = S.screen || editCity()?.startScreen;
      await save();
    }
    await game.settings.set(MOD, "visible", show);
    if (show) {
      S.history = [];
      closeEditor();
      ui.notifications.info(
        tr("Notify.Shown", "The city is now visible to all players."),
      );
    } else {
      await game.settings.set(MOD, "gmLocation", {});
      ui.notifications.info(tr("Notify.Hidden", "The city is now hidden."));
    }
  } catch (error) {
    console.error(`${MOD} | Visibility`, error);
    ui.notifications.error(tr("Notify.VisibilityFailed", "Visibility could not be changed."));
  }
}
async function forceScreenForAll(cityId, screenId) {
  if (!game.user.isGM) return;
  const project = city(game.settings.get(MOD, "city")),
    c = cityId
      ? project.cities.find((item) => item.id === cityId)
      : projectCity(project, project.activeCity),
    d = c
      ? screenId
        ? c.screens.find((item) => item.id === screenId)
        : projectScreen(c)
      : null;
  if (!c || !d)
    return ui.notifications.warn(tr("Presence.InvalidLocation", "The requested location no longer exists."));
  try {
    project.activeCity = c.id;
    project.activeScreen = d.id;
    await game.settings.set(MOD, "city", copy(project));
    await game.settings.set(MOD, "visible", true);
    S.history = [];
    S.viewStates.clear();
    if (!S.viewer) openViewer(false, d.id, false, c.id);
    ui.notifications.info(
      tr("Notify.ForcedScreen", "All players were moved to this screen."),
    );
  } catch (error) {
    console.error(`${MOD} | Force screen`, error);
    ui.notifications.error(tr("Notify.ForceFailed", "Players could not be moved."));
  }
}
async function startWeather(d, owner = S.viewer) {
  const root = owner?.querySelector?.(".cv-weather");
  if (!root || d.weather === "none") return null;
  if (d.weather === "rain" || !globalThis.tsParticles) {
    fillWeather(root, d, false);
    return null;
  }
  try {
    if (!S.particlesReady && globalThis.loadSlim) {
      await globalThis.loadSlim(globalThis.tsParticles);
      S.particlesReady = true;
    }
  } catch (error) {
    console.warn(`${MOD} | Particle engine`, error);
    fillWeather(root, d, false);
    return null;
  }
  if (!owner.isConnected || S.viewer !== owner) return null;
  root.id = `cv-weather-${++S.viewerEpoch}`;
  const intensity = clamp(d.weatherIntensity || 1, 0.5, 2),
    base = {
      fullScreen: { enable: false },
      background: { color: { value: "transparent" } },
      detectRetina: true,
      fpsLimit: 60,
      interactivity: { events: {} },
      particles: { links: { enable: false }, collisions: { enable: false } },
    };
  const configs = {
    rain: {
      particles: {
        number: { value: Math.round(150 * intensity) },
        color: { value: "#b9d9f3" },
        opacity: { value: { min: 0.16, max: 0.42 } },
        size: { value: { min: 0.7, max: 1.5 } },
        move: {
          enable: true,
          direction: "bottom",
          speed: { min: 14, max: 24 },
          straight: true,
          outModes: { default: "out" },
        },
      },
    },
    snow: {
      particles: {
        number: { value: Math.round(90 * intensity) },
        color: { value: "#ffffff" },
        opacity: { value: { min: 0.35, max: 0.9 } },
        size: { value: { min: 1, max: 4 } },
        move: {
          enable: true,
          direction: "bottom",
          speed: { min: 0.6, max: 2.2 },
          straight: false,
          random: true,
          outModes: { default: "out" },
        },
      },
    },
    fog: {
      particles: {
        number: { value: Math.round(22 * intensity) },
        color: { value: "#dce4e8" },
        opacity: { value: { min: 0.025, max: 0.09 } },
        size: { value: { min: 60, max: 170 } },
        move: {
          enable: true,
          direction: "right",
          speed: { min: 0.15, max: 0.5 },
          straight: false,
          outModes: { default: "out" },
        },
      },
    },
    embers: {
      particles: {
        number: { value: Math.round(55 * intensity) },
        color: { value: ["#ffb347", "#ff6b35", "#ffd27d"] },
        opacity: { value: { min: 0.25, max: 0.85 } },
        size: { value: { min: 1, max: 3 } },
        move: {
          enable: true,
          direction: "top",
          speed: { min: 0.5, max: 2.2 },
          straight: false,
          random: true,
          outModes: { default: "out" },
        },
      },
    },
  };
  try {
    const weather = await globalThis.tsParticles.load({
      id: root.id,
      options: foundry.utils.mergeObject(
        base,
        configs[d.weather] || configs.snow,
        { inplace: false },
      ),
    });
    if (!owner.isConnected || S.viewer !== owner) {
      weather?.destroy?.();
      return null;
    }
    owner._cvWeather = weather;
    S.weather = weather;
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    if (!owner.isConnected || S.viewer !== owner) return null;
    if (!root.querySelector("canvas")) fillWeather(root, d, false);
    return weather;
  } catch (error) {
    console.warn(`${MOD} | Weather effect`, error);
    if (owner.isConnected && S.viewer === owner) fillWeather(root, d, false);
    return null;
  }
}
function bindParallax(view, strength) {
  const owner = view.closest("#cv-viewer"),
    background = document.createElement("div");
  background.className = "cv-parallax-background";
  background.style.backgroundImage = view.style.backgroundImage;
  background.style.backgroundSize = view.style.backgroundSize || "cover";
  view.style.backgroundImage = "none";
  view.prepend(background);
  let frame = 0;
  const reset = () => {
      background.style.transform = "translate3d(0,0,0) scale(1.08)";
      view
        .querySelectorAll(".cv-object")
        .forEach((object) => (object.style.translate = "0 0"));
    },
    move = (event) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const x = (event.clientX / window.innerWidth - 0.5) * strength,
        y = (event.clientY / window.innerHeight - 0.5) * strength;
      background.style.transform = `translate3d(${-x}px,${-y}px,0) scale(1.08)`;
      view.querySelectorAll(".cv-object").forEach((object, index) => {
        const depth =
          0.18 +
          ((Number(object.style.getPropertyValue("--z")) || index) % 6) * 0.06;
        object.style.translate = `${x * depth}px ${y * depth}px`;
      });
    });
  };
  view.addEventListener("pointermove", move, { passive: true });
  view.addEventListener("pointerleave", reset);
  registerCleanup(owner, () => {
    cancelAnimationFrame(frame);
    view.removeEventListener("pointermove", move);
    view.removeEventListener("pointerleave", reset);
  });
  reset();
}
function ambience(src, owner = S.viewer) {
  stopAudio();
  if (!src || !owner) return;
  const a = document.createElement("audio");
  a.className = "cv-audio";
  a.src = src;
  a.loop = true;
  a.volume = 0.35;
  document.body.append(a);
  const unlock = () => a.isConnected && a.play().catch(() => undefined);
  a.play().catch(() => document.addEventListener("pointerdown", unlock, { once: true }));
  registerCleanup(owner, () => {
    document.removeEventListener("pointerdown", unlock);
    a.pause();
    a.remove();
  });
}
function stopAudio() {
  document.querySelectorAll(".cv-audio,#cv-audio").forEach((a) => {
    a.pause();
    a.remove();
  });
}
function closeViewer() {
  document.body.classList.remove("cv-chat-open");
  S.navigationToken++;
  S.viewerEpoch++;
  cleanupViewerElement(S.viewer);
  S.weather?.destroy?.();
  S.weather = null;
  S.viewer?.remove();
  S.viewer = null;
  S.preview = false;
  stopAudio();
}

async function openCityCharacterSheet() {
  const actor = game.user.character;
  if (!actor)
    return ui.notifications.warn(
      tr("Viewer.NoCharacter", "No character is assigned to this user."),
    );
  const sheet = actor.sheet;
  await sheet?.render?.(true);
  requestAnimationFrame(() => {
    const element = sheet?.element?.[0] || sheet?.element;
    element?.classList?.add("cv-elevated-sheet");
    if (element?.style) element.style.zIndex = "13050";
  });
}
function toggleCityChat(button) {
  const open = document.body.classList.toggle("cv-chat-open");
  button?.classList.toggle("active", open);
  button?.setAttribute("aria-pressed", String(open));
  if (open) {
    if (typeof ui.sidebar?.changeTab === "function")
      ui.sidebar.changeTab("chat", "primary");
    else ui.sidebar?.activateTab?.("chat");
  }
}

function fillWeather(root, d, editor = false) {
  if (!root || d.weather === "none") return;
  root.replaceChildren();
  root.className = `${editor ? "cv-editor-weather" : "cv-weather"} cv-weather-fallback ${d.weather}`;
  const intensity = clamp(d.weatherIntensity || 1, 0.5, 2),
    scale = editor ? 0.55 : 1,
    count =
      d.weather === "fog"
        ? Math.round(10 * scale)
        : d.weather === "rain"
          ? Math.round(125 * intensity * scale)
          : d.weather === "snow"
            ? Math.round(65 * intensity * scale)
            : Math.round(45 * intensity * scale);
  for (let i = 0; i < count; i++) {
    const particle = document.createElement("i"),
      depth = 0.35 + Math.random() * 0.65;
    particle.style.setProperty("--x", `${-8 + Math.random() * 108}%`);
    particle.style.setProperty("--y", `${Math.random() * 70}%`);
    particle.style.setProperty("--delay", `${-Math.random() * 8}s`);
    particle.style.setProperty(
      "--duration",
      d.weather === "rain"
        ? `${0.48 + (1 - depth) * 0.62}s`
        : `${2 + Math.random() * 6}s`,
    );
    particle.style.setProperty("--size", `${1 + Math.random() * 4}px`);
    particle.style.setProperty(
      "--length",
      editor ? `${12 + depth * 30}%` : `${9 + depth * 25}vh`,
    );
    particle.style.setProperty("--drop-opacity", `${0.18 + depth * 0.52}`);
    particle.style.setProperty("--drop-width", `${0.55 + depth * 0.75}px`);
    particle.style.setProperty("--blur", `${(1 - depth) * 0.7}px`);
    root.append(particle);
  }
}
function previewEditorWeather(stage, d) {
  if (!stage || d.weather === "none") return;
  const root = document.createElement("div");
  stage.prepend(root);
  fillWeather(root, d, true);
}
function enablePan(view, d) {
  const mode = ["vertical", "horizontal", "free"].includes(d.pan)
    ? d.pan
    : "none";
  if (mode === "none" || !d.background) return;
  const owner = view.closest("#cv-viewer");
  view.classList.add("is-pannable", `pan-${mode}`);
  const world = document.createElement("div"),
    background = document.createElement("div");
  world.className = "cv-pan-world";
  background.className = "cv-pan-background";
  background.style.backgroundImage = cssUrl(d.background);
  world.append(background);
  view
    .querySelectorAll(":scope > .cv-object")
    .forEach((node) => world.append(node));
  view.prepend(world);
  view.style.backgroundImage = "none";
  const stateKey = `${S.viewCity}:${d.id}`,
    saved = S.viewStates.get(stateKey),
    state = { x: 0, y: 0, maxX: 0, maxY: 0, moved: false, restored: false, dragging: false },
    image = new Image(),
    apply = () =>
      (world.style.transform = `translate3d(${-state.x}px,${-state.y}px,0)`);
  const layout = () => {
    const oldMaxX = state.maxX,
      oldMaxY = state.maxY,
      oldRatioX = oldMaxX ? state.x / oldMaxX : 0,
      oldRatioY = oldMaxY ? state.y / oldMaxY : 0,
      rect = view.getBoundingClientRect(),
      ratio =
        (image.naturalWidth || rect.width) /
        (image.naturalHeight || rect.height);
    let width = rect.width,
      height = width / ratio;
    if (mode === "horizontal") {
      height = rect.height;
      width = height * ratio;
    } else if (mode === "free") {
      const scale = Math.max(
        rect.width / (image.naturalWidth || rect.width),
        rect.height / (image.naturalHeight || rect.height),
      );
      width = (image.naturalWidth || rect.width) * scale;
      height = (image.naturalHeight || rect.height) * scale;
    }
    if (mode === "vertical" && height < rect.height) {
      height = rect.height;
      width = height * ratio;
    }
    if (mode === "horizontal" && width < rect.width) {
      width = rect.width;
      height = width / ratio;
    }
    const cameraZoom = clamp(d.cameraZoom ?? 1.5, 1, 3);
    width *= cameraZoom;
    height *= cameraZoom;
    world.style.width = `${width}px`;
    world.style.height = `${height}px`;
    world.style.left = "0";
    world.style.top = "0";
    state.maxX = Math.max(0, width - rect.width);
    state.maxY = Math.max(0, height - rect.height);
    if (!state.restored) {
      state.x = saved ? (saved.xRatio || 0) * state.maxX : state.maxX / 2;
      state.y = saved ? (saved.yRatio || 0) * state.maxY : state.maxY / 2;
      state.restored = true;
    } else {
      state.x = oldRatioX * state.maxX;
      state.y = oldRatioY * state.maxY;
    }
    state.x = clamp(state.x, 0, state.maxX);
    state.y = clamp(state.y, 0, state.maxY);
    apply();
  };
  image.onload = layout;
  image.onerror = layout;
  image.src = d.background;
  window.addEventListener("resize", layout, { passive: true });
  registerCleanup(owner, () => {
    window.removeEventListener("resize", layout);
    image.onload = null;
    image.onerror = null;
  });
  layout();
  view.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".interactive,button"))
      return;
    event.preventDefault();
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      x: state.x,
      y: state.y,
    };
    state.moved = false;
    state.dragging = true;
    view.classList.add("is-dragging");
    view.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - start.clientX,
        dy = moveEvent.clientY - start.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 4) state.moved = true;
      if (mode !== "vertical") state.x = clamp(start.x - dx, 0, state.maxX);
      if (mode !== "horizontal") state.y = clamp(start.y - dy, 0, state.maxY);
      apply();
    };
    const up = () => {
      state.dragging = false;
      view.classList.remove("is-dragging");
      view.removeEventListener("pointermove", move);
    };
    view.addEventListener("pointermove", move);
    view.addEventListener("pointerup", up, { once: true });
    view.addEventListener("pointercancel", up, { once: true });
  });
  let followFrame = 0;
  view.addEventListener("pointermove", (event) => {
    if (!d.cameraFollow || state.dragging || event.target.closest(".interactive,button")) return;
    const rect = view.getBoundingClientRect(),
      ratioX = clamp((event.clientX - rect.left) / rect.width, 0, 1),
      ratioY = clamp((event.clientY - rect.top) / rect.height, 0, 1),
      targetX = mode === "vertical" ? state.x : ratioX * state.maxX,
      targetY = mode === "horizontal" ? state.y : ratioY * state.maxY;
    cancelAnimationFrame(followFrame);
    const glide = () => {
      state.x += (targetX - state.x) * 0.14;
      state.y += (targetY - state.y) * 0.14;
      apply();
      if (Math.abs(targetX - state.x) + Math.abs(targetY - state.y) > 0.7)
        followFrame = requestAnimationFrame(glide);
    };
    followFrame = requestAnimationFrame(glide);
  });
  registerCleanup(owner, () => cancelAnimationFrame(followFrame));
  view.addEventListener(
    "wheel",
    (event) => {
      if (!state.maxX && !state.maxY) return;
      event.preventDefault();
      if (mode === "horizontal")
        state.x = clamp(state.x + event.deltaY + event.deltaX, 0, state.maxX);
      else if (mode === "vertical")
        state.y = clamp(state.y + event.deltaY, 0, state.maxY);
      else {
        state.x = clamp(state.x + event.deltaX, 0, state.maxX);
        state.y = clamp(state.y + event.deltaY, 0, state.maxY);
      }
      apply();
    },
    { passive: false },
  );
  view._cvGetViewState = () => ({
    xRatio: state.maxX ? state.x / state.maxX : 0,
    yRatio: state.maxY ? state.y / state.maxY : 0,
  });
}

const TRANSITION_CLASSES = [
  "cv-transition-fade",
  "cv-transition-slide",
  "cv-transition-zoom",
  "cv-transition-blur",
  "cv-transition-iris",
  "cv-transition-reverse",
];
function openViewer(
  preview = false,
  screenId = null,
  animate = false,
  cityId = null,
  reverse = false,
) {
  preview = Boolean(preview && game.user.isGM);
  if (!game.user.isGM && !game.settings.get(MOD, "visible")) {
    closeViewer();
    return null;
  }
  const old = animate ? S.viewer : null;
  if (!animate) closeViewer();
  else {
    S.weather = null;
    stopAudio();
  }
  const project = city(game.settings.get(MOD, "city")),
    requestedCity = cityId || (animate ? S.viewCity : null) || project.activeCity,
    c = projectCity(project, requestedCity),
    requestedScreen =
      screenId ||
      (c.id === project.activeCity ? project.activeScreen : null) ||
      (animate ? S.viewScreen : null),
    d = randomizeScreenImages(projectScreen(c, requestedScreen)),
    transition = ["fade", "slide", "zoom", "blur", "iris"].includes(
      d.transition,
    )
      ? d.transition
      : "fade";
  if (!animate) {
    S.history = [];
    S.viewStates.clear();
  }
  S.preview = preview;
  S.viewCity = c.id;
  S.viewScreen = d.id;
  const canBack = S.history.length > 0 || d.id !== c.startScreen,
    el = document.createElement("section");
  el.id = "cv-viewer";
  el.classList.add("cv-assets-loading");
  el.classList.add(`cv-transition-${transition}`);
  if (animate) el.classList.add("cv-screen-enter");
  if (reverse) el.classList.add("cv-transition-reverse");
  if (old) {
    old.classList.remove(...TRANSITION_CLASSES);
    old.classList.add(`cv-transition-${transition}`, "cv-screen-leave");
    if (reverse) old.classList.add("cv-transition-reverse");
    old.style.pointerEvents = "none";
  }
  const mindModule = game.modules.get("mind-palace"),
    mindEnabled =
      mindModule?.active &&
      (d.mindPalace || /alchemist|алхим/i.test(`${c.name} ${d.title}`)),
    dialogueEnabled =
      game.modules.get("dialogue-stage")?.active &&
      /alchemist|алхим/i.test(`${c.name} ${d.title}`),
    explorationContext = buildExplorationContext(project, c.id, d.id);
  el.innerHTML = `<div class="cv-view ${d.parallax ? "is-parallax" : ""}"><div class="cv-weather"></div><div class="cv-vignette"></div><div class="cv-transition-curtain"><i class="fas fa-compass"></i></div><div class="cv-heading"><span>${esc(c.name)}</span><h1>${esc(d.title)}</h1><p>${esc(d.subtitle)}</p></div>${d.objects.map((o) => objectHTML(o, false, explorationContext)).join("")}<div class="cv-card"><small>${tr("Viewer.Action", "Available action")}</small><h2></h2><p></p><b><i class="fas fa-computer-mouse"></i> ${tr("Viewer.Click", "Click to interact")}</b></div><nav class="cv-player-tools"><button data-view="character"><i class="fas fa-user-shield"></i><span>${tr("Viewer.Character", "Character")}</span></button><button data-view="chat" aria-pressed="false"><i class="fas fa-comments"></i><span>${tr("Viewer.Chat", "Chat")}</span></button><button data-view="presence"><i class="fas ${game.user.isGM ? "fa-people-arrows" : "fa-location-arrow"}"></i><span>${game.user.isGM ? tr("Presence.Group", "Group") : tr("Presence.ToGM", "To Game Master")}</span></button></nav>${dialogueEnabled ? `<button class="cv-dialogue-stage" data-view="dialogue-stage"><i class="fas fa-masks-theater"></i><span>${tr("Viewer.Dialogue", "Dialogue")}</span></button>` : ""}${mindEnabled ? `<button class="cv-mind-palace ${dialogueEnabled ? "has-dialogue" : ""}" data-view="mind-palace"><i class="fas fa-brain"></i><span>${tr("Viewer.MindPalace", "Mind Palace")}</span></button>` : ""}<button class="cv-back ${canBack ? "" : "is-hidden"}" data-view="back"><i class="fas fa-arrow-left"></i><span>${tr("Viewer.Back", "Back")}</span></button>${game.user.isGM || preview ? `<nav class="cv-gm">${game.user.isGM ? `<button data-view="force"><i class="fas fa-users-viewfinder"></i> ${tr("UI.ForceScreen", "Show this screen to everyone")}</button>` : ""}<button data-view="edit"><i class="fas fa-pen-ruler"></i> ${tr("Viewer.Editor", "Editor")}</button><button data-view="close"><i class="fas fa-eye-slash"></i> ${preview ? tr("Viewer.ClosePreview", "Close preview") : tr("Viewer.Hide", "Hide from players")}</button></nav>` : ""}</div>`;
  document.body.append(el);
  const view = el.querySelector(".cv-view");
  view.style.backgroundImage = cssUrl(d.background);
  view.style.backgroundSize = d.fit;
  view.classList.toggle("point-style-map", d.pointStyle === "map");
  el.querySelector(".cv-heading h1").hidden = !d.showTitle;
  el.querySelector(".cv-heading p").hidden = !d.showSubtitle;
  if (!d.showTitle && !d.showSubtitle)
    el.querySelector(".cv-heading").hidden = true;
  el._cvExplorationContext = explorationContext;
  S.viewer = el;
  bindViewer(el, d, c);
  ambience(d.ambience);
  startWeather(d, el);
  preloadScreenAssets(d).finally(() => el.classList.remove("cv-assets-loading"));
  if (d.pan !== "none") enablePan(view, d);
  else if (d.parallax) bindParallax(view, Number(d.parallaxStrength) || 14);
  if (animate) {
    void el.offsetWidth;
    const firstFrame = requestAnimationFrame(() => {
      const secondFrame = requestAnimationFrame(() =>
        el.classList.remove("cv-screen-enter"),
      );
      registerCleanup(el, () => cancelAnimationFrame(secondFrame));
    });
    registerCleanup(el, () => cancelAnimationFrame(firstFrame));
    setTimeout(
      () => {
        cleanupViewerElement(old);
        old?.remove();
      },
      reverse ? 760 : 560,
    );
  }
  const presenceFrame = requestAnimationFrame(publishPresence);
  registerCleanup(el, () => cancelAnimationFrame(presenceFrame));
  Hooks.callAll("cityViewer.viewerOpened", { cityId: c.id, screenId: d.id, preview });
  return el;
}
function captureViewerState() {
  const state = S.viewer?.querySelector(".cv-view")?._cvGetViewState?.();
  if (state && S.viewCity && S.viewScreen)
    S.viewStates.set(`${S.viewCity}:${S.viewScreen}`, state);
}
async function navigateScreen(screenId, push = true) {
  const project = city(game.settings.get(MOD, "city")),
    c = projectCity(project, S.viewCity);
  if (!c.screens.some((s) => s.id === screenId))
    return ui.notifications.warn(
      tr("Notify.TargetMissing", "The target screen could not be found."),
    );
  const target = c.screens.find((screen) => screen.id === screenId),
    token = ++S.navigationToken;
  S.viewer?.classList.add("cv-navigation-pending");
  await preloadScreenAssets(target);
  if (token !== S.navigationToken) return null;
  S.viewer?.classList.remove("cv-navigation-pending");
  captureViewerState();
  if (push && S.viewScreen !== screenId) pushViewerHistory(S.viewScreen);
  openViewer(S.preview, screenId, true, c.id, !push);
}
async function navigateBack() {
  const project = city(game.settings.get(MOD, "city")),
    currentCity = projectCity(project, S.viewCity),
    previous = S.history.pop(),
    token = ++S.navigationToken;
  captureViewerState();
  if (previous && typeof previous === "object") {
    const targetCity = project.cities.find((item) => item.id === previous.cityId),
      targetScreen = targetCity?.screens.find((item) => item.id === previous.screenId);
    await preloadScreenAssets(targetScreen);
    if (token !== S.navigationToken) return null;
    return openViewer(S.preview, previous.screenId, true, previous.cityId, true);
  }
  const target = previous || currentCity.startScreen;
  if (target !== S.viewScreen) {
    await preloadScreenAssets(currentCity.screens.find((item) => item.id === target));
    if (token !== S.navigationToken) return null;
    return openViewer(S.preview, target, true, currentCity.id, true);
  }
  return null;
}
async function activatePoint(object, c, d) {
  if (!object || object.kind !== "poi" || !c || !d) return null;
  const exploration = getExplorationState(c.id, d.id, object.id),
    context = {
      object: copy(object),
      cityId: c.id,
      screenId: d.id,
      pointId: object.id,
      userId: game.user?.id,
      exploration: exploration ? copy(exploration) : null,
    };
  if (
    !game.user.isGM &&
    (!exploration || ["secret", "locked"].includes(exploration.state))
  ) {
    Hooks.callAll("cityViewer.pointBlocked", {
      ...context,
      reason: exploration?.state || "secret",
    });
    return exploration?.state === "locked"
      ? viewerLocked(object, exploration)
      : null;
  }
  if (Hooks.call("cityViewer.prePointActivate", context) === false) return null;
  const persistence = await Promise.allSettled([
    markPointVisited(object, c.id, d.id),
    requestVisitEffect(object, c.id, d.id),
  ]);
  const rejected = persistence.filter((entry) => entry.status === "rejected");
  if (rejected.length) {
    console.warn(
      `${MOD} | Visit persistence`,
      ...rejected.map((entry) => entry.reason),
    );
    ui.notifications.warn(
      tr("Exploration.VisitFailed", "The visit could not be saved."),
    );
  }
  const result =
    object.action === "screen"
      ? await navigateScreen(object.value)
      : await execute(object);
  Hooks.callAll("cityViewer.pointActivated", { ...context, result });
  return result;
}
function bindViewer(el, d, c) {
  const card = el.querySelector(".cv-card"),
    show = (event) => {
      const node = event.target.closest?.(".interactive");
      if (!node) return;
      const object = d.objects.find((item) => item.id === node.dataset.id),
        exploration =
          object?.kind === "poi"
            ? explorationForPoint(
                object,
                el._cvExplorationContext ||
                  buildExplorationContext(
                    city(game.settings.get(MOD, "city")),
                    c.id,
                    d.id,
                  ),
              )
            : null;
      if (!object) return;
      if (exploration?.state === "locked" && !game.user.isGM) {
        card.querySelector("small").textContent = tr(
          "Exploration.Locked",
          "Locked",
        );
        card.querySelector("h2").textContent = object.name;
        card.querySelector("p").textContent = exploration.lockReason;
        card.querySelector("b").innerHTML = `<i class="fas fa-lock"></i> ${esc(tr("Exploration.LockedHint", "Click to inspect the lock"))}`;
      } else {
        card.querySelector("small").textContent =
          game.user.isGM && exploration
            ? tr(
                {
                  visible: "Exploration.Visible",
                  secret: "Exploration.Secret",
                  locked: "Exploration.Locked",
                }[exploration.state],
                exploration.state,
              )
            : tr("Viewer.Action", "Available action");
        card.querySelector("h2").textContent = object.actionTitle;
        card.querySelector("p").textContent =
          object.hint ||
          tr(ACTIONS[object.action], ACTIONS[object.action] || object.action);
        card.querySelector("b").innerHTML = `<i class="fas fa-computer-mouse"></i> ${esc(tr("Viewer.Click", "Click to interact"))}`;
      }
      card.classList.add("visible");
    },
    hide = (event) => {
      if (!event.relatedTarget?.closest?.(".interactive"))
        card.classList.remove("visible");
    };
  el.onpointerover = show;
  el.onfocusin = show;
  el.onpointerout = hide;
  el.onfocusout = hide;
  el.onclick = async (event) => {
    const accessButton = event.target.closest?.("[data-point-state]");
    if (accessButton && game.user.isGM) {
      const node = accessButton.closest(".cv-object"),
        point = d.objects.find((item) => item.id === node?.dataset.id),
        state = accessButton.dataset.pointState;
      if (!point || point.kind !== "poi") return null;
      try {
        if (state === "locked") {
          const current = getExplorationState(c.id, d.id, point.id),
            reason = await lockReasonPrompt(point, current?.lockReason || "");
          if (reason === null) return null;
          return lockPoint(c.id, d.id, point.id, reason);
        }
        if (state === "secret") return hidePoint(c.id, d.id, point.id);
        const current = getExplorationState(c.id, d.id, point.id);
        return current?.state === "locked"
          ? unlockPoint(c.id, d.id, point.id)
          : revealPoint(c.id, d.id, point.id);
      } catch (error) {
        console.error(`${MOD} | Exploration control`, error);
        return ui.notifications.error(
          tr("Exploration.UpdateFailed", "Point access could not be changed."),
        );
      }
    }
    const action = event.target.closest?.("[data-view]")?.dataset.view;
    if (action === "edit") {
      const cityId = S.viewCity,
        screenId = S.viewScreen;
      closeViewer();
      openEditor();
      S.city = cityId;
      S.screen = screenId;
      S.selected = null;
      return renderEditor();
    }
    if (action === "close") return S.preview ? closeViewer() : setVisible(false);
    if (action === "back") return navigateBack();
    if (action === "character") return openCityCharacterSheet();
    if (action === "chat")
      return toggleCityChat(event.target.closest('[data-view="chat"]'));
    if (action === "force") return forceScreenForAll(c.id, d.id);
    if (action === "presence") return openPresencePanel();
    if (action === "dialogue-stage") {
      document.body.classList.remove("cv-chat-open");
      return game.modules.get("dialogue-stage")?.api?.open?.();
    }
    if (action === "mind-palace") {
      document.body.classList.remove("cv-chat-open");
      return game.modules.get("mind-palace")?.api?.open?.();
    }
    const node = event.target.closest?.(".interactive"),
      object = d.objects.find((item) => item.id === node?.dataset.id);
    if (!object) return null;
    if (object.kind === "poi") return activatePoint(object, c, d);
    return execute(object);
  };
  el.onkeydown = (event) => {
    if (["Enter", " "].includes(event.key) && event.target.matches(".interactive")) {
      event.preventDefault();
      event.target.click();
    }
    if (event.key === "Escape" && (game.user.isGM || S.preview)) closeViewer();
  };
}
function viewerInfo(o) {
  const host = S.viewer;
  if (!host) return;
  host.querySelector(".cv-info-layer")?.remove();
  const layer = document.createElement("div");
  layer.className = "cv-info-layer";
  layer.innerHTML =
    '<section class="cv-info-dialog"><button class="cv-info-close"><i class="fas fa-xmark"></i></button><div class="cv-info-icon"><i class="fas fa-scroll"></i></div><small></small><h2></h2><p></p><button class="cv-info-done"></button></section>';
  layer.querySelector(".cv-info-close").ariaLabel = tr("Info.Close", "Close");
  layer.querySelector("small").textContent = tr(
    "Info.Point",
    "Point of interest",
  );
  layer.querySelector(".cv-info-done").textContent = tr(
    "Info.Continue",
    "Continue",
  );
  layer.querySelector("h2").textContent = o.actionTitle || o.name;
  layer.querySelector("p").textContent =
    o.value || o.hint || tr("Info.Empty", "There is no description yet.");
  const close = () => {
    layer.remove();
    host.focus();
  };
  layer.onclick = (event) => {
    if (
      event.target === layer ||
      event.target.closest(".cv-info-close,.cv-info-done")
    )
      close();
  };
  layer.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  host.append(layer);
  layer.tabIndex = -1;
  layer.focus();
}
function viewerLocked(point, exploration) {
  const host = S.viewer;
  if (!host) return null;
  host.querySelector(".cv-info-layer")?.remove();
  const layer = document.createElement("div");
  layer.className = "cv-info-layer";
  layer.innerHTML =
    '<section class="cv-info-dialog is-locked"><button class="cv-info-close"><i class="fas fa-xmark"></i></button><div class="cv-info-icon"><i class="fas fa-lock"></i></div><small></small><h2></h2><p></p><button class="cv-info-done"></button></section>';
  layer.querySelector(".cv-info-close").ariaLabel = tr("Info.Close", "Close");
  layer.querySelector("small").textContent = tr(
    "Exploration.Locked",
    "Locked",
  );
  layer.querySelector("h2").textContent = point.name;
  layer.querySelector("p").textContent =
    exploration.lockReason ||
    tr("Exploration.LockedDefault", "This place is currently inaccessible.");
  layer.querySelector(".cv-info-done").textContent = tr(
    "Exploration.Understood",
    "Understood",
  );
  const close = () => {
    layer.remove();
    host.focus();
  };
  layer.onclick = (event) => {
    if (
      event.target === layer ||
      event.target.closest(".cv-info-close,.cv-info-done")
    )
      close();
  };
  layer.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  host.append(layer);
  layer.tabIndex = -1;
  layer.focus();
  return layer;
}
function lockReasonPrompt(point, current = "") {
  return featurePrompt(
    tr("Exploration.LockPoint", "Lock point"),
    current || point.lockReason || "",
    {
      label: tr("Exploration.LockReason", "Locked reason"),
      multiline: true,
      allowEmpty: true,
    },
  );
}
async function execute(object) {
  if (!object || typeof object !== "object") return null;
  const context = {
    object,
    cityId: S.viewCity,
    screenId: S.viewScreen,
    user: game.user,
  };
  if (Hooks.call("cityViewer.preAction", context) === false) return null;
  const Audio = foundry.audio?.AudioHelper || globalThis.AudioHelper;
  if (object.sound && Audio)
    Audio.play(
      { src: object.sound, volume: 0.8, autoplay: true, loop: false },
      true,
    );
  const value = text(object.value, "", 10000);
  let result = null;
  try {
    if (S.customActions.has(object.action))
      result = await S.customActions.get(object.action).execute(context);
    else if (object.action === "info") result = viewerInfo(object);
    else if (object.action === "check") result = await requestCheck(object);
    else if (object.action === "actor") {
      const actor = await resolveDocumentAsync(object.actorUuid || value);
      if (!actor?.sheet?.render)
        ui.notifications.warn(tr("Bindings.ActorMissing", "The linked actor is unavailable."));
      else result = actor.sheet.render(true);
    } else if (object.action === "journal") {
      const journal = await resolveDocumentAsync(object.journalUuid || value);
      if (!journal)
        ui.notifications.warn(tr("Bindings.JournalMissing", "The linked journal is unavailable."));
      else if (journal.sheet?.render) result = journal.sheet.render(true);
      else if (journal.parent?.sheet?.render)
        result = journal.parent.sheet.render(true, { pageId: journal.id });
      else ui.notifications.warn(tr("Bindings.JournalMissing", "The linked journal is unavailable."));
    } else if (object.action === "dialogue") {
      const api = game.modules.get("dialogue-stage")?.api;
      if (!api?.open)
        ui.notifications.warn(tr("Action.DialogueMissing", "Activate Dialogue Stage to open this conversation."));
      else {
        document.body.classList.remove("cv-chat-open");
        result = await api.open(value || null);
      }
    } else if (object.action === "macro") {
      const macro = value ? await resolveDocumentAsync(value) : null;
      if (!macro?.execute)
        ui.notifications.warn(tr("Action.MacroMissing", "The macro is unavailable."));
      else
        result = await macro.execute({
          cityViewer: {
            cityId: S.viewCity,
            screenId: S.viewScreen,
            pointId: object.id,
          },
        });
    } else if (object.action === "chat")
      result = await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ user: game.user }),
        content: `<h3>${esc(object.actionTitle)}</h3><p>${esc(value || object.hint)}</p>`,
      });
    else if (object.action === "url") {
      if (!/^https?:\/\//i.test(value))
        ui.notifications.warn(tr("Action.UrlInvalid", "Only http/https links are allowed."));
      else result = window.open(value, "_blank", "noopener,noreferrer");
    } else {
      const content = `<div class="cv-dialog"><h2>${esc(object.actionTitle)}</h2><p>${esc(value || object.hint)}</p></div>`,
        DialogV2 = foundry.applications?.api?.DialogV2;
      result = DialogV2
        ? await DialogV2.prompt({
            window: { title: object.name },
            content,
            ok: { label: tr("Info.Close", "Close") },
          })
        : new Dialog({
            title: object.name,
            content,
            buttons: { ok: { label: tr("Info.Close", "Close") } },
          }).render(true);
    }
  } catch (error) {
    console.error(`${MOD} | Action ${object.action}`, error);
    ui.notifications.error(tr("Action.Failed", "The action could not be completed."));
  }
  Hooks.callAll("cityViewer.postAction", { ...context, result });
  return result;
}

Hooks.once("init", () => {
  game.settings.register(MOD, "city", {
    name: "City data",
    scope: "world",
    config: false,
    type: Object,
    default: copy(EMPTY_SCREEN),
    onChange: async (value) => {
      if (S.viewer && !S.preview) {
        const project = city(value),
          targetCity = projectCity(project, project.activeCity),
          targetScreen = projectScreen(targetCity, project.activeScreen);
        const token = ++S.navigationToken;
        S.viewer.classList.add("cv-navigation-pending");
        await preloadScreenAssets(targetScreen);
        if (token !== S.navigationToken || !S.viewer) return;
        captureViewerState();
        openViewer(false, targetScreen.id, true, targetCity.id);
      }
    },
  });
  game.settings.register(MOD, "visible", {
    name: "City visible",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    onChange: (v) => {
      v ? openViewer() : closeViewer();
    },
  });
  game.settings.register(MOD, "language", {
    name: "Language",
    scope: "world",
    config: false,
    type: String,
    default: "en",
    onChange: async (code) => {
      await loadLanguage(code);
      if (S.editor) {
        await save().catch(() => undefined);
        S.editor.remove();
        S.editor = null;
        openEditor();
      }
      if (S.viewer) openViewer(S.preview, S.viewScreen, true, S.viewCity);
    },
  });
  game.settings.register(MOD, "presets", {
    name: "City Viewer presets",
    scope: "world",
    config: false,
    type: Object,
    default: { locations: [], objects: [] },
  });
  game.settings.register(MOD, "exploration", {
    name: "City Viewer exploration state",
    scope: "world",
    config: false,
    type: Object,
    default: { version: EXPLORATION_VERSION, points: {} },
    onChange: (value) => {
      refreshExplorationViewer();
      Hooks.callAll(
        "cityViewer.explorationStateUpdated",
        copy(normalizeExplorationStore(value)),
      );
    },
  });
  game.settings.register(MOD, "visitEffects", {
    name: "City Viewer visit effect ledger",
    scope: "world",
    config: false,
    type: Object,
    default: { version: VISIT_EFFECT_VERSION, claims: {}, receipts: {} },
    onChange: (value) => {
      const ledger = normalizeVisitEffectLedger(value);
      Hooks.callAll("cityViewer.visitEffectStateUpdated", copy(ledger));
      if (!game.user?.isGM) {
        void offerPendingNarratives(ledger);
        return;
      }
      if (!isPrimaryGM()) return;
      const next = Object.values(ledger.receipts)
        .filter((receipt) => receipt.status === "pending")
        .sort(
          (left, right) =>
            (left.nextRetryAt || 0) - (right.nextRetryAt || 0),
        )[0];
      if (next)
        scheduleVisitEffectRetry(
          Math.max(500, (next.nextRetryAt || Date.now()) - Date.now()),
        );
      else {
        clearTimeout(S.visitEffectRetryTimer);
        S.visitEffectRetryTimer = null;
      }
    },
  });
  game.settings.register(MOD, "gmLocation", {
    name: "City Viewer GM location",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
  game.settings.register(MOD, "travel", {
    name: "City Viewer travel request",
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: (request) => {
      if (
        Array.isArray(request?.targetUserIds) &&
        request.targetUserIds.includes(game.user.id) &&
        request.cityId &&
        request.screenId
      )
        followLocation(request.cityId, request.screenId, true);
    },
  });
});

/* Production integrations: Foundry controls, reusable presets, document
 * bindings, collaborative navigation, roll requests and the public API. */
function resolveDocument(uuid) {
  if (!uuid) return null;
  try {
    return globalThis.fromUuidSync?.(uuid) || null;
  } catch {
    return null;
  }
}
async function resolveDocumentAsync(uuid) {
  const synchronous = resolveDocument(uuid);
  if (synchronous || !uuid) return synchronous;
  try {
    return (await globalThis.fromUuid?.(uuid)) || null;
  } catch {
    return null;
  }
}
function resolveBoundObject(source) {
  if (!source || typeof source !== "object") return normalizeScreen({ objects: [{}] }).objects[0];
  const result = { ...source },
    actor = resolveDocument(source.actorUuid),
    journal = resolveDocument(source.journalUuid);
  if (actor) {
    result.name = actor.name || result.name;
    if (source.kind === "asset" && actor.img) result.src = actor.img;
    if (!result.actionTitle) result.actionTitle = actor.name;
  }
  if (journal && !actor) result.name = journal.name || result.name;
  return result;
}
function presetStore() {
  const raw = game.settings.get(MOD, "presets") || {};
  const normalizePresets = (items, type) =>
    (Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item === "object" && item.id && item.data && typeof item.data === "object")
      .slice(0, LIMITS.presets)
      .map((item) => ({
        id: text(item.id, "", 128),
        type,
        name: text(item.name, tr("Presets.Saved", "Saved preset"), 160),
        data:
          type === "location"
            ? normalizeScreen(item.data)
            : normalizeScreen({ objects: [item.data] }).objects[0],
        createdAt: Math.max(0, Number(item.createdAt) || 0),
      }));
  return {
    locations: normalizePresets(raw.locations, "location"),
    objects: normalizePresets(raw.objects, "object"),
  };
}
async function writePresetStore(store) {
  if (!game.user.isGM) throw new Error("Only a Game Master may update presets.");
  await game.settings.set(MOD, "presets", copy(store));
}
function featurePrompt(title, value = "", options = {}) {
  return new Promise((resolve) => {
    const host = document.createElement("div"),
      label = options.label || tr("UI.Name", "Name"),
      control = options.multiline
        ? `<textarea name="name" rows="4" maxlength="1000">${esc(value)}</textarea>`
        : `<input name="name" value="${esc(value)}" maxlength="160" autocomplete="off">`;
    host.className = "cv-feature-layer ucx-overlay";
    host.innerHTML = `<form class="cv-feature-dialog ucx-dialog"><header><div><small>City Viewer</small><h2>${esc(title)}</h2></div><button type="button" data-cancel><i class="fas fa-xmark"></i></button></header><label>${esc(label)}${control}</label><footer><button type="button" data-cancel>${tr("UI.Cancel", "Cancel")}</button><button class="primary" type="submit">${tr("UI.Save", "Save")}</button></footer></form>`;
    const finish = (result) => {
      host.remove();
      resolve(result);
    };
    host.addEventListener("click", (event) => {
      if (event.target === host || event.target.closest("[data-cancel]"))
        finish(null);
    });
    host.querySelector("form").onsubmit = (event) => {
      event.preventDefault();
      const next = event.currentTarget.elements.name.value.trim();
      finish(next || (options.allowEmpty ? "" : value));
    };
    document.body.append(host);
    host.querySelector("[name='name']").select();
  });
}
async function saveLocationPreset(name = null, screen = editScreen()) {
  if (!game.user.isGM || !screen) return null;
  name = name || (await featurePrompt(tr("Presets.NewLocation", "New location preset"), screen.title));
  if (!name) return null;
  const store = presetStore(),
    preset = { id: id(), type: "location", name, data: copy(screen), createdAt: Date.now() };
  delete preset.data.id;
  preset.data.objects.forEach((object) => delete object.id);
  store.locations.push(preset);
  if (store.locations.length > LIMITS.presets) store.locations.shift();
  await writePresetStore(store);
  Hooks.callAll("cityViewer.presetCreated", copy(preset));
  ui.notifications.info(`${tr("Presets.LocationSaved", "Location preset saved.")} ${name}`);
  return preset;
}
async function saveObjectPreset(name = null, object = selected()) {
  if (!game.user.isGM || !object) return null;
  name = name || (await featurePrompt(tr("Presets.NewObject", "New element preset"), object.name));
  if (!name) return null;
  const store = presetStore(),
    preset = { id: id(), type: "object", name, data: copy(object), createdAt: Date.now() };
  delete preset.data.id;
  store.objects.push(preset);
  if (store.objects.length > LIMITS.presets) store.objects.shift();
  await writePresetStore(store);
  Hooks.callAll("cityViewer.presetCreated", copy(preset));
  ui.notifications.info(`${tr("Presets.ObjectSaved", "Element preset saved.")} ${name}`);
  return preset;
}
async function applyPreset(presetId) {
  if (!game.user.isGM) return null;
  const store = presetStore(),
    location = store.locations.find((item) => item.id === presetId),
    object = store.objects.find((item) => item.id === presetId);
  if (location) {
    if (editCity().screens.length >= LIMITS.screens)
      return ui.notifications.warn(tr("Limits.Screens", "This city has reached the screen limit."));
    recordUndo();
    const screen = normalizeScreen(copy(location.data));
    screen.id = id();
    screen.title = location.name;
    screen.objects.forEach((item) => (item.id = id()));
    editCity().screens.push(screen);
    S.screen = screen.id;
    S.selected = null;
    renderEditor();
    autosave();
    Hooks.callAll("cityViewer.presetApplied", copy(location), { cityId: S.city, screenId: screen.id });
    return screen;
  }
  if (object) {
    if (editScreen().objects.length >= LIMITS.objects)
      return ui.notifications.warn(tr("Limits.Objects", "This screen has reached the element limit."));
    recordUndo();
    const item = normalizeScreen({ objects: [{ ...copy(object.data), id: id() }] }).objects[0];
    item.x = clamp(item.x + 3, 0, 100 - item.w);
    item.y = clamp(item.y + 3, 0, 100 - item.h);
    editScreen().objects.push(item);
    S.selected = item.id;
    renderEditor();
    autosave();
    Hooks.callAll("cityViewer.presetApplied", copy(object), { cityId: S.city, screenId: S.screen, objectId: item.id });
    return item;
  }
  return null;
}
async function removePreset(presetId) {
  if (!game.user.isGM) return null;
  const store = presetStore(),
    removed = [...store.locations, ...store.objects].find((item) => item.id === presetId);
  store.locations = store.locations.filter((item) => item.id !== presetId);
  store.objects = store.objects.filter((item) => item.id !== presetId);
  await writePresetStore(store);
  if (removed) Hooks.callAll("cityViewer.presetDeleted", copy(removed));
}
function openPresetLibrary() {
  if (!game.user.isGM) return;
  document.querySelector(".cv-preset-library")?.remove();
  const store = presetStore(),
    section = (title, type, items) => `<section><header><div><small>${type === "location" ? tr("UI.Screens", "Screens").toUpperCase() : tr("Presets.Elements", "Elements").toUpperCase()}</small><h3>${title}</h3></div><b>${items.length}</b></header><div class="cv-preset-list">${items.length ? items.map((item) => `<article><div><i class="fas ${type === "location" ? "fa-panorama" : "fa-shapes"}"></i><span><strong>${esc(item.name)}</strong><small>${type === "location" ? `${item.data.objects?.length || 0} ${tr("Presets.Elements", "elements").toLowerCase()}` : item.data.kind === "poi" ? tr("UI.PointOfInterest", "Point of interest") : tr("UI.Layer", "Media layer")}</small></span></div><nav><button data-apply-preset="${esc(item.id)}"><i class="fas fa-plus"></i> ${tr("Presets.Add", "Add")}</button><button data-delete-preset="${esc(item.id)}" title="${tr("UI.Delete", "Delete")}"><i class="fas fa-trash"></i></button></nav></article>`).join("") : `<p class="empty">${tr("Presets.Empty", "No saved presets yet.")}</p>`}</div></section>`;
  const layer = document.createElement("div");
  layer.className = "cv-preset-library ucx-overlay";
  layer.innerHTML = `<div class="cv-preset-window ucx-dialog"><header><div><small>${tr("Presets.Library", "Preset library").toUpperCase()}</small><h2>${tr("Presets.Title", "City Viewer presets")}</h2><p>${tr("Presets.Subtitle", "Locations and elements are stored separately and are available in every city.")}</p></div><button data-close-preset><i class="fas fa-xmark"></i></button></header><main>${section(tr("Presets.Locations", "Locations"), "location", store.locations)}${section(tr("Presets.Elements", "Elements"), "object", store.objects)}</main></div>`;
  layer.onclick = async (event) => {
    if (event.target === layer || event.target.closest("[data-close-preset]")) return layer.remove();
    const apply = event.target.closest("[data-apply-preset]")?.dataset.applyPreset,
      remove = event.target.closest("[data-delete-preset]")?.dataset.deletePreset;
    if (apply) {
      await applyPreset(apply);
      layer.remove();
    }
    if (remove) {
      await removePreset(remove);
      layer.remove();
      openPresetLibrary();
    }
  };
  document.body.append(layer);
}

async function bindDroppedDocument(event) {
  if (!S.editor || !event.target.closest("#cv-editor") || !selected()) return;
  let data = null;
  try {
    data = globalThis.TextEditor?.getDragEventData?.(event) || JSON.parse(event.dataTransfer.getData("text/plain") || "null");
  } catch {
    return;
  }
  const uuid = data?.uuid || (data?.type && data?.id ? `${data.type}.${data.id}` : "");
  if (!uuid || !["Actor", "JournalEntry", "JournalEntryPage"].includes(data.type)) return;
  event.preventDefault();
  const object = selected(), doc = await fromUuid(uuid).catch(() => null);
  if (!doc) return;
  recordUndo();
  if (data.type === "Actor") {
    object.actorUuid = uuid;
    object.name = doc.name || object.name;
    if (object.kind === "asset" && doc.img) object.src = doc.img;
    object.action = "actor";
    object.actionTitle = `${tr("Bindings.OpenPrefix", "Open")}: ${doc.name}`;
  } else {
    object.journalUuid = uuid;
    object.value = uuid;
    object.action = "journal";
    object.actionTitle = `${tr("Bindings.OpenPrefix", "Open")}: ${doc.name}`;
  }
  renderEditor();
  autosave();
}

function checkData(object) {
  return {
    type: ["skill", "ability", "save"].includes(object?.checkType || object?.type)
      ? object.checkType || object.type
      : "skill",
    key: /^[a-z0-9_-]{1,32}$/i.test(object?.checkKey || object?.key)
      ? object.checkKey || object.key
      : "prc",
    dc: clamp(object?.checkDC ?? object?.dc ?? 10, 0, 99),
    title: text(object?.actionTitle || object?.title || object?.name, tr("Check.Request", "Check request"), 160),
  };
}
function checkTypeLabel(type) {
  const key = {
    skill: "Check.Skill",
    ability: "Check.Ability",
    save: "Check.Save",
  }[type];
  return key ? tr(key, type) : text(type, tr("Check.Skill", "Skill"), 32);
}
async function rollRequestedCheck(data) {
  const actor = game.user.character || globalThis.canvas?.tokens?.controlled?.[0]?.actor;
  const options = { event: new Event("click"), configure: true, dialog: true };
  Hooks.callAll("cityViewer.preRoll", { actor, check: copy(data), midi: Boolean(game.modules.get("midi-qol")?.active) });
  try {
    let result;
    if (data.type === "skill" && actor?.rollSkill)
      result = await actor.rollSkill({ skill: data.key }, options);
    else if (data.type === "save" && actor?.rollSavingThrow)
      result = await actor.rollSavingThrow({ ability: data.key }, options);
    else if (data.type === "save" && actor?.rollAbilitySave)
      result = await actor.rollAbilitySave(data.key, options);
    else if (actor?.rollAbilityCheck)
      result = await actor.rollAbilityCheck({ ability: data.key }, options);
    else if (actor?.rollAbilityTest)
      result = await actor.rollAbilityTest(data.key, options);
    else {
      const RollClass = foundry.dice?.Roll || globalThis.Roll;
      if (!RollClass) throw new Error("Foundry Roll API is unavailable.");
      result = await new RollClass("1d20").evaluate();
      const total = Number(result.total),
        passed = Number.isFinite(total) && total >= data.dc,
        flavor = `<h3>${esc(data.title)}</h3><p>${esc(checkTypeLabel(data.type))}: <b>${esc(data.key)}</b> · ${tr("Check.DC", "Difficulty")} <b>${data.dc}</b></p><p><b>${passed ? tr("Check.Success", "Success") : tr("Check.Failure", "Failure")}</b></p>`;
      await result.toMessage?.({
        speaker: ChatMessage.getSpeaker({ actor, user: game.user }),
        flavor,
      });
    }
    Hooks.callAll("cityViewer.rollComplete", { actor, check: copy(data), result });
    return result;
  } catch (error) {
    console.error(`${MOD} | Check`, error);
    return ui.notifications.error(tr("Check.Failed", "The check could not be rolled in the current game system."));
  }
}
async function requestCheck(objectOrData) {
  const data = checkData(objectOrData || {});
  if (!game.user.isGM && objectOrData?.checkTarget !== "all") return rollRequestedCheck(data);
  const midi = game.modules.get("midi-qol")?.active,
    content = `<section class="cv-roll-request"><header><i class="fas fa-dice-d20"></i><div><small>${midi ? "MIDI-QOL" : tr("Check.Request", "Check request").toUpperCase()}</small><h3>${esc(data.title)}</h3></div></header><p>${esc(checkTypeLabel(data.type))}: <b>${esc(data.key)}</b> · ${tr("Check.DC", "Difficulty")} <b>${data.dc}</b></p><button data-cv-roll><i class="fas fa-dice-d20"></i> ${tr("Check.Roll", "Roll check")}</button></section>`;
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ user: game.user }),
    content,
    flags: { [MOD]: { check: data } },
  });
}

function publishPresence() {
  if (!S.viewer || !S.viewCity || !S.viewScreen) return;
  const payload = { type: "presence", userId: game.user.id, cityId: S.viewCity, screenId: S.viewScreen, at: Date.now() };
  S.presence.set(game.user.id, payload);
  game.socket.emit(`module.${MOD}`, payload);
  if (game.user.isGM) {
    S.locationQueue = S.locationQueue
      .catch(() => undefined)
      .then(() => game.settings.set(MOD, "gmLocation", payload))
      .catch((error) => console.warn(`${MOD} | GM location`, error));
  }
  Hooks.callAll("cityViewer.locationChanged", copy(payload));
}
async function followLocation(cityId, screenId, remember = true) {
  const project = city(game.settings.get(MOD, "city")),
    targetCity = project.cities.find((item) => item.id === cityId),
    targetScreen = targetCity?.screens.find((item) => item.id === screenId);
  if (!targetCity || !targetScreen)
    return ui.notifications.warn(tr("Presence.InvalidLocation", "The requested location no longer exists."));
  const token = ++S.navigationToken;
  await preloadScreenAssets(targetScreen);
  if (token !== S.navigationToken) return null;
  if (remember && S.viewCity && S.viewScreen)
    pushViewerHistory({ cityId: S.viewCity, screenId: S.viewScreen });
  return openViewer(false, screenId, Boolean(S.viewer), cityId);
}
function followUser(userId) {
  const location = S.presence.get(userId);
  if (!location)
    return ui.notifications.warn(
      tr("Presence.UserUnknown", "This user's location is not available yet."),
    );
  return followLocation(location.cityId, location.screenId, true);
}
async function bringUsers(userIds, cityId = S.viewCity, screenId = S.viewScreen) {
  if (!game.user.isGM || !cityId || !screenId) return null;
  const targets = [...new Set(userIds)].filter((userId) => game.users.get(userId)?.active);
  if (!targets.length) return null;
  try {
    return await game.settings.set(MOD, "travel", {
      nonce: id(),
      targetUserIds: targets,
      cityId,
      screenId,
      at: Date.now(),
    });
  } catch (error) {
    console.error(`${MOD} | Travel`, error);
    ui.notifications.error(tr("Notify.ForceFailed", "Players could not be moved."));
    return null;
  }
}
function bringUser(userId, cityId = S.viewCity, screenId = S.viewScreen) {
  return bringUsers([userId], cityId, screenId);
}
function presenceLabel(presence) {
  if (!presence) return tr("Presence.Unknown", "Location unknown");
  const project = city(game.settings.get(MOD, "city")),
    targetCity = projectCity(project, presence.cityId),
    targetScreen = targetCity?.screens.find((screen) => screen.id === presence.screenId);
  return `${targetCity?.name || presence.cityId} / ${targetScreen?.title || presence.screenId}`;
}
async function openPresencePanel() {
  if (!game.user.isGM) {
    const location = game.settings.get(MOD, "gmLocation");
    if (location?.cityId && location?.screenId)
      return followLocation(location.cityId, location.screenId, true);
    return ui.notifications.warn(tr("Presence.GMUnknown", "The Game Master's location is not available yet."));
  }
  game.socket.emit(`module.${MOD}`, { type: "presence-query", userId: game.user.id });
  await new Promise((resolve) => {
    setTimeout(resolve, 180);
  });
  for (const [userId, presence] of S.presence)
    if (!game.users.get(userId)?.active || Date.now() - Number(presence.at || 0) > 10 * 60_000)
      S.presence.delete(userId);
  const users = [...(game.users?.contents || game.users || [])].filter((user) => user?.active && user.id !== game.user.id),
    layer = document.createElement("div");
  layer.className = "cv-presence-layer ucx-overlay";
  layer.innerHTML = `<div class="cv-presence-dialog ucx-dialog"><header><div><small>${tr("Presence.Title", "Quick travel").toUpperCase()}</small><h2>${tr("Presence.Title", "Quick travel")}</h2><p>${tr("Presence.Subtitle", "Travel to a player or invite them to the current location.")}</p></div><button data-presence-close><i class="fas fa-xmark"></i></button></header><main>${users.map((user) => {const p=S.presence.get(user.id), location=presenceLabel(p);return`<article><span class="avatar" data-avatar-user="${esc(user.id)}"></span><div><strong>${esc(user.name)}</strong><small>${esc(location)}</small></div><button data-go-user="${esc(user.id)}" ${p?"":"disabled"}><i class="fas fa-arrow-right-to-bracket"></i> ${tr("Presence.Go", "Go")}</button><button data-bring-user="${esc(user.id)}" ${S.viewer?"":"disabled"}><i class="fas fa-user-group"></i> ${tr("Presence.Invite", "Invite")}</button></article>`;}).join("") || `<p class="empty">${tr("Presence.Empty", "No connected players.")}</p>`}</main><footer><button data-bring-all ${S.viewer?"":"disabled"}><i class="fas fa-users-viewfinder"></i> ${tr("Presence.InviteAll", "Invite everyone here")}</button></footer></div>`;
  for (const user of users) {
    const avatar = layer.querySelector(`[data-avatar-user="${CSS.escape(user.id)}"]`);
    if (avatar)
      avatar.style.backgroundImage = cssUrl(user.avatar || "icons/svg/mystery-man.svg");
  }
  layer.onclick = (event) => {
    if (event.target === layer || event.target.closest("[data-presence-close]")) return layer.remove();
    const go = event.target.closest("[data-go-user]")?.dataset.goUser,
      bring = event.target.closest("[data-bring-user]")?.dataset.bringUser;
    if (go) { followUser(go); layer.remove(); }
    if (bring) bringUser(bring);
    if (event.target.closest("[data-bring-all]")) bringUsers(users.map((user) => user.id));
  };
  document.body.append(layer);
}

function registerSceneControls(controls) {
  const tools = {
    open: { name: "open", title: "City Viewer", icon: "fa-solid fa-city", order: 0, button: true, onChange: () => openViewer() },
    group: { name: "group", title: tr("Presence.Title", "Quick travel"), icon: "fa-solid fa-people-arrows", order: 1, button: true, onChange: () => openPresencePanel() },
  };
  if (game.user.isGM) {
    tools.edit = { name: "edit", title: tr("Editor.Architect", "City editor"), icon: "fa-solid fa-pen-ruler", order: 2, button: true, onChange: () => openEditor() };
    tools.presets = { name: "presets", title: tr("Presets.Library", "Preset library"), icon: "fa-solid fa-box-archive", order: 3, button: true, onChange: () => openPresetLibrary() };
    tools.show = { name: "show", title: tr("UI.ForceScreen", "Show this screen to everyone"), icon: "fa-solid fa-users-viewfinder", order: 4, button: true, onChange: () => S.viewer ? forceScreenForAll(S.viewCity, S.viewScreen) : setVisible(true) };
  }
  const control = { name: "cityViewer", title: "City Viewer", icon: "fa-solid fa-map-location-dot", order: 75, visible: true, tools };
  if (Array.isArray(controls)) controls.push({ ...control, layer: "controls", tools: Object.values(tools) });
  else controls.cityViewer = control;
}
// Keep the shared Foundry controls resilient when an optional integration is
// unavailable or a user-supplied project is malformed.
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    registerSceneControls(controls);
  } catch (error) {
    console.error(`${MOD} | scene controls unavailable`, error);
  }
});
Hooks.on("updateUser", (user, changes = {}) => {
  if (Object.prototype.hasOwnProperty.call(changes, "active") && isPrimaryGM())
    void reconcileVisitEffectRequests().then(() => retryVisitEffects());
  const moduleFlags = changes.flags?.[MOD],
    keys = Object.keys(changes),
    changed = (flag) =>
      (moduleFlags && Object.prototype.hasOwnProperty.call(moduleFlags, flag)) ||
      keys.some(
        (key) =>
          key === `flags.${MOD}.${flag}` ||
          key.startsWith(`flags.${MOD}.${flag}.`),
      );
  if (changed("visitedPoints")) {
    refreshExplorationViewer();
    Hooks.callAll("cityViewer.visitsUpdated", {
      userId: user.id,
      visits: copy(userVisitRecord(user)),
    });
  }
  if (changed("visitEffectRequests") && isPrimaryGM() && !user?.isGM)
    void processUserEffectRequests(user);
  if (
    changed("visitEffectNarratives") &&
    user?.id === game.user?.id &&
    !game.user?.isGM
  )
    S.narrativeSeen = new Set(
      normalizeNarrativeReceipts(
        user.flags?.[MOD]?.visitEffectNarratives || {},
      ).ids,
    );
});
Hooks.on("userConnected", (user, connected) => {
  if (connected && isPrimaryGM() && !user?.isGM)
    void processUserEffectRequests(user);
});
Hooks.on("mindPalace.apiReady", () => {
  if (isPrimaryGM()) void retryVisitEffects({ force: true });
});
Hooks.on("dialogueStage.apiReady", () => {
  if (isPrimaryGM()) void retryVisitEffects({ force: true });
});
Hooks.on("chronicle.apiReady", () => {
  if (isPrimaryGM()) void retryVisitEffects({ force: true });
});

Hooks.once("ready", async () => {
  await loadLanguage(game.settings.get(MOD, "language") || "en");
  let currentProject = city(game.settings.get(MOD, "city"));
  if (game.user.isGM) {
    const stored = game.settings.get(MOD, "city");
    currentProject = city(stored);
    if (Number(stored?.version || 0) < DATA_VERSION)
      await game.settings.set(MOD, "city", currentProject);
    const storedPresets = game.settings.get(MOD, "presets") || {},
      migratedPresets = presetStore();
    if (JSON.stringify(storedPresets) !== JSON.stringify(migratedPresets))
      await game.settings.set(MOD, "presets", migratedPresets);
    const storedExploration = game.settings.get(MOD, "exploration") || {},
      migratedExploration = normalizeExplorationStore(
        storedExploration,
        currentProject,
        true,
      );
    if (JSON.stringify(storedExploration) !== JSON.stringify(migratedExploration))
      await game.settings.set(MOD, "exploration", migratedExploration);
    const storedEffects = game.settings.get(MOD, "visitEffects") || {},
      migratedEffects = normalizeVisitEffectLedger(storedEffects);
    if (JSON.stringify(storedEffects) !== JSON.stringify(migratedEffects))
      await game.settings.set(MOD, "visitEffects", migratedEffects);
  }
  const storedVisits =
    game.user.getFlag?.(MOD, "visitedPoints") ||
    game.user.flags?.[MOD]?.visitedPoints ||
    null;
  if (storedVisits && typeof game.user.setFlag === "function") {
    const migratedVisits = normalizeVisitRecord(storedVisits, currentProject);
    if (JSON.stringify(storedVisits) !== JSON.stringify(migratedVisits))
      await game.user.setFlag(MOD, "visitedPoints", migratedVisits);
  }
  let storedRequests = null,
    storedNarratives = null;
  try {
    storedRequests =
      game.user.getFlag?.(MOD, "visitEffectRequests") ||
      game.user.flags?.[MOD]?.visitEffectRequests ||
      null;
    storedNarratives =
      game.user.getFlag?.(MOD, "visitEffectNarratives") ||
      game.user.flags?.[MOD]?.visitEffectNarratives ||
      null;
  } catch {
    storedRequests = storedNarratives = null;
  }
  if (storedRequests && typeof game.user.setFlag === "function") {
    const migratedRequests = normalizeVisitEffectRequests(storedRequests);
    if (JSON.stringify(storedRequests) !== JSON.stringify(migratedRequests))
      await game.user.setFlag(MOD, "visitEffectRequests", migratedRequests);
  }
  if (storedNarratives) {
    const migratedNarratives = normalizeNarrativeReceipts(storedNarratives);
    S.narrativeSeen = new Set(migratedNarratives.ids);
    if (
      typeof game.user.setFlag === "function" &&
      JSON.stringify(storedNarratives) !== JSON.stringify(migratedNarratives)
    )
      await game.user.setFlag(
        MOD,
        "visitEffectNarratives",
        migratedNarratives,
      );
  }
  document.addEventListener("dragover", (event) => { if (event.target.closest?.("#cv-editor")) event.preventDefault(); });
  document.addEventListener("drop", bindDroppedDocument);
  document.addEventListener("click", async (event) => {
    const action = event.target.closest?.("[data-preset-action]")?.dataset.presetAction;
    if (action === "library") return openPresetLibrary();
    if (action === "save-location") return saveLocationPreset();
    if (action === "save-object") return saveObjectPreset();
    const rollButton = event.target.closest?.("[data-cv-roll]");
    if (rollButton) {
      if (rollButton.disabled) return;
      const messageId = rollButton.closest("[data-message-id]")?.dataset.messageId,
        data = game.messages.get(messageId)?.getFlag(MOD, "check");
      if (data) {
        rollButton.disabled = true;
        try {
          return await rollRequestedCheck(data);
        } finally {
          rollButton.disabled = false;
        }
      }
    }
  });
  game.socket.on(`module.${MOD}`, (payload) => {
    const sender = game.users.get(payload?.userId);
    if (!sender) return;
    if (payload.type === "presence") {
      const project = city(game.settings.get(MOD, "city")),
        targetCity = project.cities.find((item) => item.id === payload.cityId),
        targetScreen = targetCity?.screens.find((item) => item.id === payload.screenId);
      if (!targetCity || !targetScreen) return;
      const presence = {
        type: "presence",
        userId: sender.id,
        cityId: targetCity.id,
        screenId: targetScreen.id,
        at: clamp(payload.at || Date.now(), 0, Date.now() + 60_000),
      };
      S.presence.set(sender.id, presence);
      Hooks.callAll("cityViewer.presence", copy(presence));
    }
    if (payload.type === "presence-query") publishPresence();
    if (
      payload.type === "visit-effect-request" &&
      isPrimaryGM() &&
      !sender.isGM
    )
      void processUserEffectRequests(sender, payload.requestId);
    if (payload.type === "visit-effect-ready" && !game.user.isGM)
      void offerPendingNarratives();
  });
  const module = game.modules.get(MOD);
  const api = module.api || (module.api = {});
  Object.assign(api, {
    version: "6.4.0",
    openEditor,
    editEntity(path, setting) {
      if (setting === "presets") return openPresetLibrary();
      if (!game.user.isGM) return false;
      openEditor();
      const targetCity = S.draft.cities.find(c => c.id === path[1]);
      if (!targetCity) return false;
      S.city = targetCity.id;
      S.screen = targetCity.screens.find(screen => screen.id === path[3])?.id || targetCity.startScreen;
      S.selected = path[4] === "objects" ? path[5] : null;
      renderEditor(); return true;
    },
    getEntityUuid: (path) => globalThis.UniCanvasDocuments?.uuid(MOD, path),
    listEntities: () => globalThis.UniCanvasDocuments?.list(MOD) || [],
    open: openViewer,
    openViewer,
    closeViewer,
    show: () => setVisible(true),
    hide: () => setVisible(false),
    forceScreen: forceScreenForAll,
    getProject: () => city(game.settings.get(MOD, "city")),
    getLocation: () => ({ cityId: S.viewCity, screenId: S.viewScreen }),
    navigate: (cityId, screenId, options = {}) => followLocation(cityId, screenId, options.remember !== false),
    followUser,
    bringUser,
    bringUsers,
    openPresencePanel,
    getPresets: presetStore,
    saveLocationPreset,
    saveObjectPreset,
    applyPreset,
    removePreset,
    resolveBinding: resolveBoundObject,
    requestCheck,
    revealPoint,
    hidePoint,
    lockPoint,
    unlockPoint,
    getExplorationState,
    getVisitEffectState,
    triggerVisitEffect,
    retryVisitEffects,
    resetVisitEffect,
    validateProject: validateImportedProject,
    async replaceProject(project) {
      if (!game.user.isGM) throw new Error("Only a Game Master may replace the project.");
      const normalized = validateImportedProject(project);
      await game.settings.set(MOD, "city", normalized);
      return normalized;
    },
    registerAction(definition) {
      const customId = actionId(definition?.id);
      if (customId === "info" || customId in ACTIONS || typeof definition?.execute !== "function")
        throw new TypeError("City Viewer action requires a unique id and execute function.");
      const registered = {
        id: customId,
        label: text(definition.label, customId, 120),
        execute: definition.execute,
      };
      S.customActions.set(customId, registered);
      ACTIONS[customId] = registered.label;
      Hooks.callAll("cityViewer.actionRegistered", customId, registered);
      return () => { S.customActions.delete(customId); delete ACTIONS[customId]; };
    },
    executeAction: (object) => execute(object),
  });
  Hooks.callAll("cityViewer.apiReady", api);
  if (isPrimaryGM())
    void reconcileVisitEffectRequests().then(() =>
      retryVisitEffects({ force: true }),
    );
  else if (!game.user.isGM) void offerPendingNarratives();
  if (game.settings.get(MOD, "visible")) openViewer();
  console.info(`${MOD} | ready v${api.version}`);
});
