const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class ClassList {
  constructor() {
    this.values = new Set();
  }
  add(...names) {
    names.forEach((name) => this.values.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }
  contains(name) {
    return this.values.has(name);
  }
  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : Boolean(force);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }
}

class Style {
  constructor() {
    this.properties = new Map();
    this.width = "";
    this.height = "";
    this.transform = "";
  }
  setProperty(name, value) {
    this.properties.set(name, String(value));
  }
  getPropertyValue(name) {
    return this.properties.get(name) || "";
  }
  removeProperty(name) {
    this.properties.delete(name);
  }
}

class Element extends EventTarget {
  constructor(tag = "div") {
    super();
    this.tagName = tag.toUpperCase();
    this.classList = new ClassList();
    this.style = new Style();
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.clientWidth = 1000;
    this.clientHeight = 800;
    this.offsetWidth = 1000;
    this.offsetHeight = 800;
    this.clientLeft = 0;
    this.clientTop = 0;
    this.rect = { left: 0, top: 0, width: 1000, height: 800 };
    this.captures = new Set();
  }
  set className(value) {
    this.classList = new ClassList();
    String(value)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((name) => this.classList.add(name));
  }
  get className() {
    return [...this.classList.values].join(" ");
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  contains(element) {
    if (element === this) return true;
    return this.children.some((child) => child.contains(element));
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this,
    );
    this.parentElement = null;
  }
  closest(selector) {
    let element = this;
    while (element) {
      for (const part of String(selector).split(",")) {
        const token = part.trim();
        if (token.startsWith(".") && element.classList.contains(token.slice(1))) {
          return element;
        }
        if (token.startsWith("[data-")) {
          const name = token
            .slice(6)
            .split(/[=\]]/)[0]
            .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          if (name in element.dataset) return element;
        }
        if (/^[a-z]+$/i.test(token) && element.tagName === token.toUpperCase()) {
          return element;
        }
      }
      element = element.parentElement;
    }
    return null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "tabindex") this.tabIndex = Number(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  getBoundingClientRect() {
    return { ...this.rect };
  }
  querySelectorAll() {
    return [];
  }
  setPointerCapture(pointerId) {
    this.captures.add(pointerId);
  }
  hasPointerCapture(pointerId) {
    return this.captures.has(pointerId);
  }
  releasePointerCapture(pointerId) {
    this.captures.delete(pointerId);
  }
}

class PointerEvent extends Event {
  constructor(type, values = {}) {
    super(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(this, key, { value, configurable: true });
    }
  }
  getCoalescedEvents() {
    return [];
  }
}

class CustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

let nextFrame = 1;
const frames = new Map();
const requestAnimationFrame = (callback) => {
  const id = nextFrame++;
  frames.set(id, callback);
  return id;
};
const cancelAnimationFrame = (id) => frames.delete(id);
const flushFrames = (time = 1000) => {
  const pending = [...frames.entries()];
  frames.clear();
  pending.forEach(([, callback]) => callback(time));
};

const observers = [];
class ResizeObserver {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(element) {
    this.element = element;
  }
  disconnect() {
    this.disconnected = true;
  }
}

const moduleRecord = {};
const context = vm.createContext({
  console,
  Event,
  EventTarget,
  CustomEvent,
  HTMLElement: Element,
  document: {
    createElement: (tag) => new Element(tag),
  },
  requestAnimationFrame,
  cancelAnimationFrame,
  ResizeObserver,
  performance,
  setTimeout,
  clearTimeout,
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
  Hooks: {
    once(name, callback) {
      if (name === "init") callback();
    },
    callAll() {},
  },
  game: {
    modules: {
      get() {
        return moduleRecord;
      },
    },
  },
});
context.globalThis = context;
const source = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "unicanvas.js"),
  "utf8",
);
vm.runInContext(source, context);
const api = moduleRecord.api;

function create(options = {}) {
  const viewport = new Element();
  const world = new Element();
  viewport.append(world);
  const controller = api.create({
    viewport,
    world,
    controls: false,
    initialState: { x: 0, y: 0, scale: 1 },
    ...options,
  });
  flushFrames();
  return { controller, viewport, world };
}

assert.equal(api.version, JSON.parse(fs.readFileSync(path.join(__dirname, "..", "module.json"), "utf8")).version);
assert.equal(typeof api.scope, "function");
assert.equal(typeof api.CanvasController, "function");

{
  const { controller, viewport } = create();
  viewport.rect = { left: 100, top: 50, width: 500, height: 400 };
  viewport.offsetWidth = 1000;
  viewport.offsetHeight = 800;
  viewport.clientWidth = 980;
  viewport.clientHeight = 780;
  viewport.clientLeft = 10;
  viewport.clientTop = 10;
  controller.setState({ x: 50, y: 30, scale: 1.5 });
  flushFrames();
  const screen = controller.worldToScreen(120, 75);
  const before = controller.screenToWorld(screen.x, screen.y);
  controller.zoomAt(2.7, screen.x, screen.y);
  flushFrames();
  const after = controller.screenToWorld(screen.x, screen.y);
  assert.ok(Math.abs(before.x - 120) < 1e-8);
  assert.ok(Math.abs(before.y - 75) < 1e-8);
  assert.ok(Math.abs(after.x - 120) < 1e-8);
  assert.ok(Math.abs(after.y - 75) < 1e-8);
  controller.destroy();
}

{
  const { controller, viewport } = create();
  viewport.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 11,
      button: 0,
      clientX: 100,
      clientY: 100,
    }),
  );
  viewport.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 12,
      button: 0,
      clientX: 300,
      clientY: 100,
    }),
  );
  viewport.dispatchEvent(
    new PointerEvent("pointermove", {
      pointerId: 12,
      button: 0,
      clientX: 500,
      clientY: 100,
    }),
  );
  flushFrames();
  assert.equal(controller.getScale(), 2);
  assert.equal(controller.screenToWorld(300, 100).x, 200);
  viewport.dispatchEvent(
    new PointerEvent("pointerup", {
      pointerId: 12,
      button: 0,
      clientX: 500,
      clientY: 100,
    }),
  );
  viewport.dispatchEvent(
    new PointerEvent("pointermove", {
      pointerId: 11,
      button: 0,
      clientX: 150,
      clientY: 100,
    }),
  );
  flushFrames();
  assert.equal(controller.getPan().x, -50);
  controller.destroy();
}

{
  const { controller, viewport } = create();
  viewport.rect = { left: 0, top: 0, width: 500, height: 400 };
  viewport.offsetWidth = 1000;
  viewport.offsetHeight = 800;
  viewport.clientWidth = 1000;
  viewport.clientHeight = 800;
  viewport.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 50,
      clientY: 50,
    }),
  );
  viewport.dispatchEvent(
    new PointerEvent("pointermove", {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 75,
    }),
  );
  flushFrames();
  assert.equal(controller.getPan().x, 100);
  assert.equal(controller.getPan().y, 50);
  viewport.dispatchEvent(
    new PointerEvent("pointerup", {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 75,
    }),
  );
  controller.destroy();
}

{
  const { controller, viewport } = create();
  viewport.rect = { left: 0, top: 0, width: 500, height: 400 };
  viewport.offsetWidth = 1000;
  viewport.offsetHeight = 800;
  viewport.clientWidth = 1000;
  viewport.clientHeight = 800;
  controller.setState({ x: 0, y: 0, scale: 2 });
  flushFrames();
  const card = new Element("article");
  viewport.children[0].append(card);
  const values = [];
  let ended;
  controller.makeDraggable(card, {
    get: () => ({ x: 10, y: 20 }),
    set: (value) => values.push({ ...value }),
    onEnd: (_value, _event, meta) => {
      ended = meta;
    },
  });
  card.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 4,
      button: 0,
      clientX: 50,
      clientY: 50,
    }),
  );
  card.dispatchEvent(
    new PointerEvent("pointermove", {
      pointerId: 4,
      button: 0,
      clientX: 100,
      clientY: 80,
    }),
  );
  flushFrames();
  card.dispatchEvent(
    new PointerEvent("pointerup", {
      pointerId: 4,
      button: 0,
      clientX: 100,
      clientY: 80,
    }),
  );
  assert.deepEqual(values, [{ x: 60, y: 50 }]);
  assert.equal(ended.moved, true);

  values.length = 0;
  card.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 5,
      button: 0,
      clientX: 20,
      clientY: 20,
    }),
  );
  card.dispatchEvent(
    new PointerEvent("pointerup", {
      pointerId: 5,
      button: 0,
      clientX: 20,
      clientY: 20,
    }),
  );
  assert.equal(values.length, 0);
  controller.destroy();
}

{
  const { controller } = create({
    infinite: false,
    width: 1200,
    height: 900,
    boundsPadding: 20,
  });
  controller.setState({ x: 10000, y: -10000, scale: 1 });
  flushFrames();
  assert.equal(controller.getPan().x, 20);
  assert.equal(controller.getPan().y, -120);
  controller.destroy();
}

{
  const { controller, viewport } = create();
  controller.setState({ x: 100, y: 100, scale: 2 });
  flushFrames();
  viewport.clientWidth = 1200;
  viewport.clientHeight = 1000;
  viewport.offsetWidth = 1200;
  viewport.offsetHeight = 1000;
  viewport.rect = { left: 0, top: 0, width: 1200, height: 1000 };
  observers.at(-1).callback();
  flushFrames();
  assert.equal(controller.getPan().x, 200);
  assert.equal(controller.getPan().y, 200);
  controller.destroy();
}

{
  const { controller, viewport } = create();
  let transforms = 0;
  controller.on("transform", () => {
    transforms += 1;
  });
  controller.batch((canvas) => {
    canvas.panBy(10, 20);
    canvas.panBy(30, 40);
    canvas.centerOn(300, 200, { scale: 1.5 });
  });
  assert.equal(frames.size, 1);
  flushFrames();
  assert.equal(transforms, 1);
  const center = controller.worldToScreen(300, 200);
  assert.equal(center.x, viewport.rect.width / 2);
  assert.equal(center.y, viewport.rect.height / 2);
  controller.destroy();
}

{
  const scope = api.scope();
  const calls = [];
  scope.add(() => calls.push("first"));
  scope.add(() => calls.push("second"));
  scope.destroy();
  assert.deepEqual(calls, ["second", "first"]);
  scope.add(() => calls.push("late"));
  assert.deepEqual(calls, ["second", "first", "late"]);
}

{
  const { controller, viewport } = create({ reducedMotion: true });
  controller.animateTo({ x: 30, y: 40, scale: 1.4 });
  assert.equal(controller.getPan().x, 30);
  assert.equal(controller.getPan().y, 40);
  assert.equal(controller.getScale(), 1.4);

  const card = new Element("article");
  viewport.children[0].append(card);
  let cancelled = false;
  controller.makeDraggable(card, {
    get: () => ({ x: 0, y: 0 }),
    onCancel: () => {
      cancelled = true;
    },
  });
  card.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 33,
      button: 0,
      clientX: 10,
      clientY: 10,
    }),
  );
  assert.equal(controller.activeDrags.size, 1);
  controller.setEnabled(false);
  assert.equal(controller.activeDrags.size, 0);
  assert.equal(cancelled, true);
  controller.destroy();
}

{
  const { controller, viewport, world } = create();
  const observer = observers.at(-1);
  assert.equal(observer.disconnected, undefined);
  controller.destroy();
  assert.equal(observer.disconnected, true);
  assert.equal(viewport.hasAttribute("tabindex"), false);
  assert.equal(viewport.hasAttribute("aria-label"), false);
  assert.equal(viewport.hasAttribute("role"), false);
  assert.equal(world.style.transform, "");
}

{
  const { controller, viewport } = create();
  const card = new Element("article");
  viewport.children[0].append(card);
  let commits = 0;
  controller.makeDraggable(card, {
    get: () => ({ x: 0, y: 0 }),
    set: () => {
      commits += 1;
    },
  });
  card.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 60,
      button: 0,
      clientX: 0,
      clientY: 0,
    }),
  );
  card.dispatchEvent(
    new PointerEvent("pointermove", {
      pointerId: 60,
      button: 0,
      clientX: 20,
      clientY: 20,
    }),
  );
  controller.destroy();
  flushFrames();
  assert.equal(commits, 0);
}

console.log("UniCanvas controller tests: ok");
