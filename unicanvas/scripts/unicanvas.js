const MOD = "unicanvas";
const VERSION = "2.5.0";

const clamp = (value, min, max) => {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
};
const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};
const raf = (callback) => requestAnimationFrame(callback);
const caf = (frame) => {
  if (frame) cancelAnimationFrame(frame);
};
const INTERACTIVE =
  "input,textarea,select,button,a,[contenteditable='true'],[contenteditable='']";
const DEFAULT_LABELS = Object.freeze({
  canvas: "Interactive canvas",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  fit: "Fit canvas to view",
  scale: "Canvas scale",
});

function safely(callback, ...args) {
  if (typeof callback !== "function") return undefined;
  try {
    return callback(...args);
  } catch (error) {
    console.error(MOD + " | callback failed", error);
    return undefined;
  }
}

class CleanupScope {
  constructor() {
    this.cleanups = new Set();
    this.destroyed = false;
    this.abortController =
      typeof AbortController === "function" ? new AbortController() : null;
    this.signal = this.abortController?.signal;
  }

  add(cleanup) {
    if (typeof cleanup !== "function") return () => {};
    if (this.destroyed) {
      safely(cleanup);
      return () => {};
    }
    this.cleanups.add(cleanup);
    return () => {
      if (!this.cleanups.delete(cleanup)) return false;
      safely(cleanup);
      return true;
    };
  }

  listen(target, type, listener, options) {
    if (!target?.addEventListener) return () => {};
    target.addEventListener(type, listener, options);
    return this.add(() => target.removeEventListener(type, listener, options));
  }

  child() {
    const child = new CleanupScope();
    this.add(() => child.destroy());
    return child;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController?.abort();
    const cleanups = [...this.cleanups].reverse();
    this.cleanups.clear();
    cleanups.forEach((cleanup) => safely(cleanup));
  }
}

class CanvasController {
  constructor(options = {}) {
    this.viewport = options.viewport;
    this.world = options.world;
    if (
      !(this.viewport instanceof HTMLElement) ||
      !(this.world instanceof HTMLElement)
    ) {
      throw new TypeError("UniCanvas requires viewport and world elements.");
    }
    if (!this.viewport.contains(this.world)) {
      throw new TypeError("UniCanvas world must be inside its viewport.");
    }

    this.width = positive(options.width, 2400);
    this.height = positive(options.height, 1400);
    this.minScale = positive(options.minScale, 0.12);
    this.maxScale = Math.max(this.minScale, positive(options.maxScale, 4));
    this.padding = Math.max(0, finite(options.padding, 40));
    this.boundsPadding = Math.max(
      0,
      finite(options.boundsPadding, this.padding),
    );
    this.wheelSpeed = clamp(options.wheelSpeed ?? 0.0015, 0.0001, 0.01);
    this.keyboardPanStep = positive(options.keyboardPanStep, 56);
    this.readOnly = Boolean(options.readOnly);
    this.enabled = options.enabled !== false;
    this.infinite = options.infinite !== false;
    this.panEnabled = options.pan !== false;
    this.zoomEnabled = options.zoom !== false;
    this.keyboardEnabled = options.keyboard !== false;
    this.resizeBehavior = ["preserve-center", "fit", "none"].includes(
      options.resizeBehavior,
    )
      ? options.resizeBehavior
      : "preserve-center";
    this.panExclude = options.panExclude || ".uc-no-pan,[data-uc-no-pan]";
    this.zoomExclude =
      options.zoomExclude ||
      ".uc-no-zoom,[data-uc-no-zoom],input,textarea,select,[contenteditable='true'],[contenteditable='']";
    this.labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };
    this.onTransform =
      typeof options.onTransform === "function" ? options.onTransform : null;

    this.state = { x: 0, y: 0, scale: 1 };
    this.pointers = new Map();
    this.draggables = new Set();
    this.activeDrags = new Set();
    this.selected = new Set();
    this.listeners = new Map();
    this.pendingReasons = new Set();
    this.scope = new CleanupScope();
    this.destroyed = false;
    this.hasFitted = false;
    this.spacePressed = false;
    this.batchDepth = 0;
    this.batchPending = false;
    this.viewportSize = this.getViewportSize();

    this.motionQuery = globalThis.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    this.reducedMotion =
      typeof options.reducedMotion === "boolean"
        ? options.reducedMotion
        : Boolean(this.motionQuery?.matches);
    if (typeof options.reducedMotion !== "boolean" && this.motionQuery) {
      const updateMotion = (event) => {
        this.reducedMotion = Boolean(event.matches);
        this.emit("motionchange", { reducedMotion: this.reducedMotion });
      };
      this.motionQuery.addEventListener?.("change", updateMotion);
      this.scope.add(() =>
        this.motionQuery.removeEventListener?.("change", updateMotion),
      );
    }

    this.original = {
      viewportTabIndex: this.viewport.getAttribute("tabindex"),
      viewportAriaLabel: this.viewport.getAttribute("aria-label"),
      viewportAriaDisabled: this.viewport.getAttribute("aria-disabled"),
      viewportAriaReadonly: this.viewport.getAttribute("aria-readonly"),
      viewportRole: this.viewport.getAttribute("role"),
      viewportScale: this.viewport.style.getPropertyValue("--uc-scale"),
      worldWidth: this.world.style.width,
      worldHeight: this.world.style.height,
      worldTransform: this.world.style.transform,
    };
    this.addedViewportClass = !this.viewport.classList.contains("uc-viewport");
    this.hadInfiniteClass = this.viewport.classList.contains("uc-infinite");
    this.addedWorldClass = !this.world.classList.contains("uc-world");

    this.viewport.classList.add("uc-viewport");
    this.viewport.classList.toggle("uc-infinite", this.infinite);
    this.world.classList.add("uc-world");
    this.world.style.width = this.width + "px";
    this.world.style.height = this.height + "px";
    if (!this.viewport.hasAttribute("tabindex")) this.viewport.tabIndex = 0;
    if (!this.viewport.hasAttribute("aria-label")) {
      this.viewport.setAttribute("aria-label", this.labels.canvas);
    }
    if (!this.viewport.hasAttribute("role")) {
      this.viewport.setAttribute("role", "region");
    }
    this.setEnabled(this.enabled);
    this.setReadOnly(this.readOnly);

    this.bindCamera();
    if (options.controls !== false) this.createControls();
    this.observeResize();

    if (options.initialState) {
      this.setState(options.initialState, { reason: "initial" });
    } else {
      this.initialFrame = raf(() => {
        this.initialFrame = 0;
        this.fit({ reason: "initial-fit" });
      });
    }
  }

  getViewportSize() {
    const rect = this.viewport.getBoundingClientRect();
    return {
      width: positive(this.viewport.clientWidth, Math.max(0, rect.width)),
      height: positive(this.viewport.clientHeight, Math.max(0, rect.height)),
    };
  }

  clientToViewport(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    const offsetWidth = positive(this.viewport.offsetWidth, rect.width || 1);
    const offsetHeight = positive(this.viewport.offsetHeight, rect.height || 1);
    const screenScaleX = positive(rect.width / offsetWidth, 1);
    const screenScaleY = positive(rect.height / offsetHeight, 1);
    return {
      x:
        (finite(clientX) - rect.left) / screenScaleX -
        finite(this.viewport.clientLeft),
      y:
        (finite(clientY) - rect.top) / screenScaleY -
        finite(this.viewport.clientTop),
    };
  }

  viewportToClient(x, y) {
    const rect = this.viewport.getBoundingClientRect();
    const offsetWidth = positive(this.viewport.offsetWidth, rect.width || 1);
    const offsetHeight = positive(this.viewport.offsetHeight, rect.height || 1);
    return {
      x:
        rect.left +
        (finite(x) + finite(this.viewport.clientLeft)) *
          positive(rect.width / offsetWidth, 1),
      y:
        rect.top +
        (finite(y) + finite(this.viewport.clientTop)) *
          positive(rect.height / offsetHeight, 1),
    };
  }

  local(clientX, clientY) {
    return this.clientToViewport(clientX, clientY);
  }

  observeResize() {
    if (typeof ResizeObserver !== "function") return;
    this.resizeObserver = new ResizeObserver(() => {
      caf(this.resizeFrame);
      this.resizeFrame = raf(() => {
        this.resizeFrame = 0;
        this.handleResize();
      });
    });
    this.resizeObserver.observe(this.viewport);
    this.scope.add(() => this.resizeObserver?.disconnect());
  }

  handleResize() {
    if (this.destroyed) return;
    const previous = this.viewportSize;
    const current = this.getViewportSize();
    if (!current.width || !current.height) return;
    this.viewportSize = current;

    if (!this.hasFitted || this.resizeBehavior === "fit") {
      this.fit({ reason: "resize-fit" });
    } else if (
      this.resizeBehavior === "preserve-center" &&
      previous.width &&
      previous.height &&
      (previous.width !== current.width || previous.height !== current.height)
    ) {
      const worldX = (previous.width / 2 - this.state.x) / this.state.scale;
      const worldY = (previous.height / 2 - this.state.y) / this.state.scale;
      this.state.x = current.width / 2 - worldX * this.state.scale;
      this.state.y = current.height / 2 - worldY * this.state.scale;
      this.apply("resize");
    }
    this.emit("resize", {
      previous,
      current,
      state: this.getState(),
    });
  }

  bindCamera() {
    let pan = null;
    let pinch = null;

    const beginPinch = () => {
      const points = [...this.pointers.values()].slice(0, 2);
      if (points.length !== 2) return null;
      const midpoint = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
      };
      return {
        distance: Math.max(
          1,
          Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
        ),
        scale: this.state.scale,
        worldX: (midpoint.x - this.state.x) / this.state.scale,
        worldY: (midpoint.y - this.state.y) / this.state.scale,
      };
    };

    const down = (event) => {
      if (
        this.destroyed ||
        !this.enabled ||
        (!this.panEnabled && !this.zoomEnabled)
      ) {
        return;
      }
      if (event.button !== 0 && event.button !== 1) return;
      if (this.pointers.size >= 2) return;
      const excluded = event.target.closest?.(this.panExclude);
      if (excluded && event.button !== 1 && !this.spacePressed) return;

      this.cancelAnimation();
      const point = this.clientToViewport(event.clientX, event.clientY);
      this.pointers.set(event.pointerId, point);
      try {
        this.viewport.setPointerCapture?.(event.pointerId);
      } catch (_error) {
        // Capture can fail if the pointer was cancelled before this handler.
      }

      if (this.pointers.size === 2 && this.zoomEnabled) {
        pinch = beginPinch();
        pan = null;
      } else if (this.panEnabled) {
        pan = {
          cx: point.x,
          cy: point.y,
          x: this.state.x,
          y: this.state.y,
        };
      }
      this.viewport.classList.add("uc-panning");
      this.emit("interactionstart", {
        type: this.pointers.size === 2 ? "pinch" : "pan",
        event,
        state: this.getState(),
      });
      if (event.cancelable) event.preventDefault();
    };

    const move = (event) => {
      if (!this.pointers.has(event.pointerId)) return;
      const samples = event.getCoalescedEvents?.();
      const sample = samples?.length ? samples[samples.length - 1] : event;
      const point = this.clientToViewport(sample.clientX, sample.clientY);
      this.pointers.set(event.pointerId, point);

      if (this.pointers.size === 2 && pinch && this.zoomEnabled) {
        const points = [...this.pointers.values()].slice(0, 2);
        const midpoint = {
          x: (points[0].x + points[1].x) / 2,
          y: (points[0].y + points[1].y) / 2,
        };
        const distance = Math.max(
          1,
          Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
        );
        const scale = clamp(
          (pinch.scale * distance) / pinch.distance,
          this.minScale,
          this.maxScale,
        );
        this.state.scale = scale;
        this.state.x = midpoint.x - pinch.worldX * scale;
        this.state.y = midpoint.y - pinch.worldY * scale;
        this.hasFitted = true;
        this.apply("pinch");
      } else if (pan && this.panEnabled) {
        this.state.x = pan.x + point.x - pan.cx;
        this.state.y = pan.y + point.y - pan.cy;
        this.hasFitted = true;
        this.apply("pan");
      }
      if (event.cancelable) event.preventDefault();
    };

    const up = (event) => {
      if (!this.pointers.has(event.pointerId)) return;
      this.pointers.delete(event.pointerId);
      try {
        if (this.viewport.hasPointerCapture?.(event.pointerId)) {
          this.viewport.releasePointerCapture(event.pointerId);
        }
      } catch (_error) {
        // Capture may already be gone after pointercancel.
      }

      pinch = this.pointers.size === 2 ? beginPinch() : null;
      if (this.pointers.size === 1 && this.panEnabled) {
        const point = this.pointers.values().next().value;
        pan = {
          cx: point.x,
          cy: point.y,
          x: this.state.x,
          y: this.state.y,
        };
      } else if (!this.pointers.size) {
        pan = null;
        this.viewport.classList.remove("uc-panning");
      }
      this.emit("interactionend", {
        event,
        state: this.getState(),
        activePointers: this.pointers.size,
      });
    };

    const wheel = (event) => {
      if (this.destroyed || !this.enabled || !this.zoomEnabled) return;
      if (event.target.closest?.(this.zoomExclude)) return;
      const page = this.getViewportSize().height || 800;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page : 1;
      const delta = clamp(event.deltaY * unit, -240, 240);
      if (!delta) return;
      if (event.cancelable) event.preventDefault();
      this.cancelAnimation();
      this.zoomAt(
        this.state.scale * Math.exp(-delta * this.wheelSpeed),
        event.clientX,
        event.clientY,
        { reason: "wheel" },
      );
    };

    const resetSpace = () => {
      this.spacePressed = false;
      this.viewport.classList.remove("uc-space");
    };
    const keydown = (event) => {
      if (
        !this.enabled ||
        !this.keyboardEnabled ||
        event.defaultPrevented ||
        (event.target !== this.viewport &&
          event.target.closest?.(INTERACTIVE))
      ) {
        return;
      }
      if (event.code === "Space") {
        this.spacePressed = true;
        this.viewport.classList.add("uc-space");
        event.preventDefault();
        return;
      }
      if (event.key === "0" || event.key === "Home") {
        event.preventDefault();
        this.fit({ reason: "keyboard-fit" });
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        this.zoomBy(1.16, null, { reason: "keyboard-zoom" });
      } else if (event.key === "-") {
        event.preventDefault();
        this.zoomBy(1 / 1.16, null, { reason: "keyboard-zoom" });
      } else if (event.key.startsWith("Arrow") && this.panEnabled) {
        const direction = {
          ArrowLeft: [this.keyboardPanStep, 0],
          ArrowRight: [-this.keyboardPanStep, 0],
          ArrowUp: [0, this.keyboardPanStep],
          ArrowDown: [0, -this.keyboardPanStep],
        }[event.key];
        if (direction) {
          event.preventDefault();
          this.panBy(direction[0], direction[1], {
            reason: "keyboard-pan",
          });
        }
      }
    };
    const keyup = (event) => {
      if (event.code === "Space") resetSpace();
    };

    this.scope.listen(this.viewport, "pointerdown", down, { passive: false });
    this.scope.listen(this.viewport, "pointermove", move, { passive: false });
    this.scope.listen(this.viewport, "pointerup", up);
    this.scope.listen(this.viewport, "pointercancel", up);
    this.scope.listen(this.viewport, "lostpointercapture", up);
    this.scope.listen(this.viewport, "wheel", wheel, { passive: false });
    this.scope.listen(this.viewport, "keydown", keydown);
    this.scope.listen(globalThis, "keyup", keyup);
    this.scope.listen(globalThis, "blur", resetSpace);
  }

  constrainState(state = this.state) {
    state.scale = clamp(state.scale, this.minScale, this.maxScale);
    if (this.infinite) return state;
    const viewport = this.getViewportSize();
    if (!viewport.width || !viewport.height) return state;
    const contentWidth = this.width * state.scale;
    const contentHeight = this.height * state.scale;
    const padding = this.boundsPadding;

    if (contentWidth + padding * 2 <= viewport.width) {
      state.x = (viewport.width - contentWidth) / 2;
    } else {
      state.x = clamp(
        state.x,
        viewport.width - contentWidth - padding,
        padding,
      );
    }
    if (contentHeight + padding * 2 <= viewport.height) {
      state.y = (viewport.height - contentHeight) / 2;
    } else {
      state.y = clamp(
        state.y,
        viewport.height - contentHeight - padding,
        padding,
      );
    }
    return state;
  }

  zoomAt(scale, clientX, clientY, { reason = "zoom" } = {}) {
    if (this.destroyed || !this.zoomEnabled) return this.getState();
    const next = clamp(scale, this.minScale, this.maxScale);
    const point = this.clientToViewport(clientX, clientY);
    const worldX = (point.x - this.state.x) / this.state.scale;
    const worldY = (point.y - this.state.y) / this.state.scale;
    this.state.scale = next;
    this.state.x = point.x - worldX * next;
    this.state.y = point.y - worldY * next;
    this.hasFitted = true;
    this.apply(reason);
    return this.getState();
  }

  apply(reason = "transform") {
    if (this.destroyed) return;
    this.constrainState(this.state);
    this.pendingReasons.add(reason);
    if (this.batchDepth) {
      this.batchPending = true;
      return;
    }
    if (this.frame) return;
    this.frame = raf(() => {
      this.frame = 0;
      this.renderTransform();
    });
  }

  renderTransform() {
    if (this.destroyed) return;
    this.constrainState(this.state);
    const state = this.getState();
    this.world.style.transform =
      "translate3d(" +
      state.x +
      "px," +
      state.y +
      "px,0) scale(" +
      state.scale +
      ")";
    this.viewport.style.setProperty("--uc-scale", String(state.scale));
    if (this.scaleLabel) {
      const percentage = Math.round(state.scale * 100) + "%";
      this.scaleLabel.textContent = percentage;
      this.scaleLabel.setAttribute(
        "aria-label",
        this.labels.scale + ": " + percentage,
      );
    }
    const detail = {
      ...state,
      reasons: [...this.pendingReasons],
    };
    this.pendingReasons.clear();
    safely(this.onTransform, detail);
    this.emit("transform", detail);
    this.dispatch("unicanvastransform", detail);
  }

  flush(reason = "flush") {
    if (this.destroyed) return this.getState();
    caf(this.frame);
    this.frame = 0;
    this.pendingReasons.add(reason);
    this.renderTransform();
    return this.getState();
  }

  batch(callback, { reason = "batch", flush = false } = {}) {
    if (this.destroyed || typeof callback !== "function") {
      return undefined;
    }
    this.batchDepth += 1;
    try {
      return callback(this);
    } finally {
      this.batchDepth -= 1;
      if (!this.batchDepth && this.batchPending) {
        this.batchPending = false;
        if (flush) this.flush(reason);
        else this.apply(reason);
      }
    }
  }

  createControls() {
    const controls = document.createElement("div");
    controls.className = "uc-controls uc-no-pan uc-no-zoom";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", this.labels.scale);

    const makeButton = (action, label, text) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.ucZoom = action;
      button.setAttribute("aria-label", label);
      button.title = label;
      button.textContent = text;
      return button;
    };

    controls.append(makeButton("out", this.labels.zoomOut, "−"));
    const label = document.createElement("span");
    label.textContent = "100%";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    controls.append(label);
    controls.append(makeButton("in", this.labels.zoomIn, "+"));
    controls.append(makeButton("fit", this.labels.fit, "⌂"));

    const click = (event) => {
      if (!this.enabled) return;
      const action = event.target.closest?.("[data-uc-zoom]")?.dataset.ucZoom;
      if (action === "out") this.zoomBy(1 / 1.16);
      if (action === "in") this.zoomBy(1.16);
      if (action === "fit") this.fit();
    };
    this.scope.listen(controls, "click", click);
    this.viewport.append(controls);
    this.controls = controls;
    this.scaleLabel = label;
    controls
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = !this.enabled));
  }

  fit({ padding = this.padding, reason = "fit" } = {}) {
    return this.fitBounds(
      { x: 0, y: 0, width: this.width, height: this.height },
      { padding, reason },
    );
  }

  fitBounds(
    bounds = {},
    { padding = this.padding, reason = "fit-bounds" } = {},
  ) {
    if (this.destroyed) return this.getState();
    const viewport = this.getViewportSize();
    if (!viewport.width || !viewport.height) return this.getState();
    const x = finite(bounds.x);
    const y = finite(bounds.y);
    const width = positive(bounds.width, this.width);
    const height = positive(bounds.height, this.height);
    const safePadding = Math.max(0, finite(padding, this.padding));
    const scale = clamp(
      Math.min(
        Math.max(1, viewport.width - safePadding * 2) / width,
        Math.max(1, viewport.height - safePadding * 2) / height,
      ),
      this.minScale,
      this.maxScale,
    );
    this.state = {
      scale,
      x: (viewport.width - width * scale) / 2 - x * scale,
      y: (viewport.height - height * scale) / 2 - y * scale,
    };
    this.viewportSize = viewport;
    this.hasFitted = true;
    this.apply(reason);
    return this.getState();
  }

  reset() {
    return this.fit({ reason: "reset" });
  }

  zoomBy(factor, point = null, options = {}) {
    const viewport = this.getViewportSize();
    const client =
      point || this.viewportToClient(viewport.width / 2, viewport.height / 2);
    return this.zoomAt(
      this.state.scale * positive(factor, 1),
      client.clientX ?? client.x,
      client.clientY ?? client.y,
      options,
    );
  }

  panBy(x, y, { reason = "pan-by" } = {}) {
    if (this.destroyed || !this.panEnabled) return this.getState();
    this.state.x += finite(x);
    this.state.y += finite(y);
    this.hasFitted = true;
    this.apply(reason);
    return this.getState();
  }

  panTo(x, y, { reason = "pan-to" } = {}) {
    if (this.destroyed || !this.panEnabled) return this.getState();
    this.state.x = finite(x);
    this.state.y = finite(y);
    this.hasFitted = true;
    this.apply(reason);
    return this.getState();
  }

  centerOn(x, y, { scale = this.state.scale, reason = "center" } = {}) {
    const viewport = this.getViewportSize();
    this.state.scale = clamp(scale, this.minScale, this.maxScale);
    this.state.x = viewport.width / 2 - finite(x) * this.state.scale;
    this.state.y = viewport.height / 2 - finite(y) * this.state.scale;
    this.hasFitted = true;
    this.apply(reason);
    return this.getState();
  }

  animateTo(
    target = {},
    {
      duration = 240,
      easing = (progress) => 1 - (1 - progress) ** 3,
      reason = "animate",
    } = {},
  ) {
    if (this.destroyed) return Promise.resolve(this.getState());
    this.cancelAnimation();
    const from = this.getState();
    const to = this.constrainState({
      x: finite(target.x, from.x),
      y: finite(target.y, from.y),
      scale: clamp(
        target.scale ?? from.scale,
        this.minScale,
        this.maxScale,
      ),
    });
    const milliseconds = Math.max(0, finite(duration, 240));
    if (!milliseconds || this.reducedMotion) {
      this.setState(to, { reason });
      this.flush(reason);
      return Promise.resolve(this.getState());
    }

    return new Promise((resolve) => {
      const started = performance.now();
      this.animationResolve = resolve;
      const step = (time) => {
        if (this.destroyed || !this.animationFrame) return;
        const progress = clamp((time - started) / milliseconds, 0, 1);
        const amount = clamp(
          safely(easing, progress) ?? progress,
          0,
          1,
        );
        this.state.x = from.x + (to.x - from.x) * amount;
        this.state.y = from.y + (to.y - from.y) * amount;
        this.state.scale =
          from.scale + (to.scale - from.scale) * amount;
        this.hasFitted = true;
        this.apply(reason);
        if (progress < 1) {
          this.animationFrame = raf(step);
        } else {
          this.animationFrame = 0;
          this.flush(reason);
          this.animationResolve = null;
          resolve(this.getState());
        }
      };
      this.animationFrame = raf(step);
    });
  }

  cancelAnimation() {
    if (!this.animationFrame) return false;
    caf(this.animationFrame);
    this.animationFrame = 0;
    const resolve = this.animationResolve;
    this.animationResolve = null;
    resolve?.(this.getState());
    return true;
  }

  getScale() {
    return this.state.scale;
  }

  getPan() {
    return { x: this.state.x, y: this.state.y };
  }

  getState() {
    return { ...this.state };
  }

  getStatus() {
    return {
      enabled: this.enabled,
      readOnly: this.readOnly,
      infinite: this.infinite,
      reducedMotion: this.reducedMotion,
      destroyed: this.destroyed,
      size: { width: this.width, height: this.height },
      viewport: { ...this.viewportSize },
      transform: this.getState(),
    };
  }

  setState(state = {}, { reason = "set-state" } = {}) {
    if (this.destroyed) return this.getState();
    this.cancelAnimation();
    this.state = {
      scale: clamp(
        state.scale ?? this.state.scale,
        this.minScale,
        this.maxScale,
      ),
      x: finite(state.x, this.state.x),
      y: finite(state.y, this.state.y),
    };
    this.hasFitted = true;
    this.apply(reason);
    return this.getState();
  }

  setSize(width, height, { fit = false, reason = "resize-world" } = {}) {
    this.width = positive(width, this.width);
    this.height = positive(height, this.height);
    this.world.style.width = this.width + "px";
    this.world.style.height = this.height + "px";
    if (fit) return this.fit({ reason });
    this.apply(reason);
    return { width: this.width, height: this.height };
  }

  setInfinite(infinite, { reason = "bounds-mode" } = {}) {
    this.infinite = Boolean(infinite);
    this.viewport.classList.toggle("uc-infinite", this.infinite);
    this.apply(reason);
    return this.infinite;
  }

  setReadOnly(readOnly) {
    this.readOnly = Boolean(readOnly);
    this.viewport.classList.toggle("uc-readonly", this.readOnly);
    this.viewport.setAttribute("aria-readonly", String(this.readOnly));
    if (this.readOnly) [...this.activeDrags].forEach((cancel) => cancel());
    return this.readOnly;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.viewport.classList.toggle("uc-disabled", !this.enabled);
    this.viewport.setAttribute("aria-disabled", String(!this.enabled));
    this.controls
      ?.querySelectorAll("button")
      .forEach((button) => (button.disabled = !this.enabled));
    if (!this.enabled) {
      this.cancelAnimation();
      this.spacePressed = false;
      for (const pointerId of this.pointers.keys()) {
        try {
          if (this.viewport.hasPointerCapture?.(pointerId)) {
            this.viewport.releasePointerCapture(pointerId);
          }
        } catch (_error) {
          // Capture may already have been released by the browser.
        }
      }
      this.pointers.clear();
      [...this.activeDrags].forEach((cancel) => cancel());
      this.viewport.classList.remove("uc-space", "uc-panning");
    }
    return this.enabled;
  }

  setReducedMotion(reducedMotion) {
    this.reducedMotion = Boolean(reducedMotion);
    if (this.reducedMotion) this.cancelAnimation();
    this.emit("motionchange", { reducedMotion: this.reducedMotion });
    return this.reducedMotion;
  }

  screenToWorld(clientX, clientY) {
    const point = this.clientToViewport(clientX, clientY);
    return {
      x: (point.x - this.state.x) / this.state.scale,
      y: (point.y - this.state.y) / this.state.scale,
    };
  }

  worldToScreen(x, y) {
    return this.viewportToClient(
      this.state.x + finite(x) * this.state.scale,
      this.state.y + finite(y) * this.state.scale,
    );
  }

  select(ids = []) {
    this.selected = new Set(Array.isArray(ids) ? ids : [ids]);
    this.world
      .querySelectorAll("[data-uc-id]")
      .forEach((element) =>
        element.classList.toggle(
          "uc-selected",
          this.selected.has(element.dataset.ucId),
        ),
      );
    const detail = { ids: [...this.selected] };
    this.emit("selection", detail);
    this.dispatch("unicanvasselection", detail, this.world);
    return detail.ids;
  }

  constrainDragPoint(point, options, startValue) {
    let next = { x: finite(point.x), y: finite(point.y) };
    if (options.axis === "x") next.y = startValue.y;
    if (options.axis === "y") next.x = startValue.x;

    const grid = options.grid;
    if (grid) {
      const gridX = positive(
        typeof grid === "number" ? grid : grid.x,
        1,
      );
      const gridY = positive(
        typeof grid === "number" ? grid : grid.y,
        gridX,
      );
      next.x = Math.round(next.x / gridX) * gridX;
      next.y = Math.round(next.y / gridY) * gridY;
    }

    const snapped = safely(options.snap, next);
    if (
      snapped &&
      Number.isFinite(Number(snapped.x)) &&
      Number.isFinite(Number(snapped.y))
    ) {
      next = { x: Number(snapped.x), y: Number(snapped.y) };
    }
    const bounds =
      typeof options.bounds === "function"
        ? safely(options.bounds, next)
        : options.bounds;
    if (bounds) {
      const minX = finite(bounds.minX, -Number.MAX_VALUE);
      const maxX = finite(bounds.maxX, Number.MAX_VALUE);
      const minY = finite(bounds.minY, -Number.MAX_VALUE);
      const maxY = finite(bounds.maxY, Number.MAX_VALUE);
      next.x = clamp(next.x, Math.min(minX, maxX), Math.max(minX, maxX));
      next.y = clamp(next.y, Math.min(minY, maxY), Math.max(minY, maxY));
    }
    return next;
  }

  makeDraggable(element, options = {}) {
    if (!(element instanceof HTMLElement) || this.destroyed) return () => {};
    element.classList.add("uc-draggable", "uc-no-pan");
    let session = null;
    let draggedTimer = 0;

    const removeSessionListeners = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", lost);
    };

    const commit = (current, event = current?.lastEvent) => {
      if (!current?.moved || !current.dirty) return;
      current.dirty = false;
      safely(options.set, current.last);
      safely(options.onMove, current.last, event, {
        start: { ...current.startValue },
      });
      this.emit("dragmove", {
        element,
        position: { ...current.last },
        event,
      });
    };

    const update = (event) => {
      if (!session || event.pointerId !== session.pointerId) return;
      const samples = event.getCoalescedEvents?.();
      const sample = samples?.length ? samples[samples.length - 1] : event;
      const point = this.screenToWorld(sample.clientX, sample.clientY);
      const clientDistance = Math.hypot(
        sample.clientX - session.startClient.x,
        sample.clientY - session.startClient.y,
      );
      if (!session.moved && clientDistance < session.threshold) return;
      if (!session.moved) {
        session.moved = true;
        element.dataset.ucDragged = "1";
        element.classList.add("uc-dragging");
      }
      const next = this.constrainDragPoint(
        {
          x:
            session.startValue.x +
            point.x -
            session.startWorld.x,
          y:
            session.startValue.y +
            point.y -
            session.startWorld.y,
        },
        options,
        session.startValue,
      );
      if (
        session.moved &&
        next.x === session.last.x &&
        next.y === session.last.y
      ) {
        session.lastEvent = sample;
        return;
      }
      session.last = next;
      session.lastEvent = sample;
      session.dirty = true;
      if (!session.frame) {
        session.frame = raf(() => {
          if (!session) return;
          session.frame = 0;
          commit(session);
        });
      }
      if (event.cancelable) event.preventDefault();
    };

    const finish = (event, cancelled = false, silent = false) => {
      if (
        !session ||
        (event?.pointerId != null && event.pointerId !== session.pointerId)
      ) {
        return;
      }
      const current = session;
      if (event && !cancelled) update(event);
      session = null;
      this.activeDrags.delete(current.cancel);
      caf(current.frame);
      current.frame = 0;
      if (!silent) commit(current, event || current.lastEvent);
      else current.dirty = false;
      removeSessionListeners();
      element.classList.remove("uc-dragging");
      try {
        if (element.hasPointerCapture?.(current.pointerId)) {
          element.releasePointerCapture(current.pointerId);
        }
      } catch (_error) {
        // Capture may already be gone after lostpointercapture.
      }

      if (!silent) {
        const meta = {
          moved: current.moved,
          cancelled,
          start: { ...current.startValue },
        };
        if (cancelled) safely(options.onCancel, current.last, event, meta);
        safely(options.onEnd, current.last, event, meta);
        this.emit("dragend", {
          element,
          position: { ...current.last },
          event,
          ...meta,
        });
      }

      clearTimeout(draggedTimer);
      if (current.moved) {
        draggedTimer = globalThis.setTimeout(() => {
          delete element.dataset.ucDragged;
          draggedTimer = 0;
        }, 80);
      } else {
        delete element.dataset.ucDragged;
      }
    };

    const move = (event) => update(event);
    const end = (event) => finish(event, false);
    const cancel = (event) => finish(event, true);
    const lost = (event) => finish(event, true);
    const down = (event) => {
      if (
        session ||
        !this.enabled ||
        (this.readOnly && !options.force) ||
        safely(options.disabled) ||
        event.button !== 0 ||
        event.target.closest?.(
          options.ignore ||
            "button,input,textarea,select,a,[contenteditable='true']",
        )
      ) {
        return;
      }

      const value = safely(options.get) || { x: 0, y: 0 };
      const startValue = {
        x: finite(value.x),
        y: finite(value.y),
      };
      const startWorld = this.screenToWorld(
        event.clientX,
        event.clientY,
      );
      const candidate = {
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        startWorld,
        startValue,
        last: { ...startValue },
        lastEvent: event,
        threshold: Math.max(0, finite(options.threshold, 2)),
        frame: 0,
        dirty: false,
        moved: false,
        cancel: null,
      };
      if (safely(options.onStart, startValue, event) === false) return;

      session = candidate;
      candidate.cancel = () => finish(null, true);
      this.activeDrags.add(candidate.cancel);
      this.cancelAnimation();
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      try {
        element.setPointerCapture?.(event.pointerId);
      } catch (_error) {
        // Capture may fail if onStart detached the element.
      }
      element.addEventListener("pointermove", move, { passive: false });
      element.addEventListener("pointerup", end);
      element.addEventListener("pointercancel", cancel);
      element.addEventListener("lostpointercapture", lost);
      this.emit("dragstart", {
        element,
        position: { ...startValue },
        event,
      });
    };

    element.addEventListener("pointerdown", down, { passive: false });
    const dispose = () => {
      if (!this.draggables.has(dispose)) return;
      if (session) finish(null, true, true);
      clearTimeout(draggedTimer);
      draggedTimer = 0;
      element.removeEventListener("pointerdown", down);
      removeSessionListeners();
      delete element.dataset.ucDragged;
      element.classList.remove("uc-draggable", "uc-no-pan", "uc-dragging");
      this.draggables.delete(dispose);
    };
    this.draggables.add(dispose);
    return dispose;
  }

  on(type, listener) {
    if (typeof listener !== "function" || this.destroyed) return () => {};
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.off(type, listener);
  }

  off(type, listener) {
    const listeners = this.listeners.get(type);
    if (!listeners) return false;
    const removed = listeners.delete(listener);
    if (!listeners.size) this.listeners.delete(type);
    return removed;
  }

  emit(type, detail) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      safely(listener, detail, this);
    }
  }

  dispatch(type, detail, target = this.viewport) {
    if (typeof CustomEvent !== "function") return;
    target.dispatchEvent(new CustomEvent(type, { detail }));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelAnimation();
    caf(this.frame);
    caf(this.resizeFrame);
    caf(this.initialFrame);
    this.frame = this.resizeFrame = this.initialFrame = 0;
    this.pointers.clear();
    this.activeDrags.clear();
    this.scope.destroy();
    [...this.draggables].forEach((dispose) => safely(dispose));
    this.draggables.clear();
    this.listeners.clear();
    this.controls?.remove();

    this.viewport.classList.remove(
      "uc-panning",
      "uc-space",
      "uc-readonly",
      "uc-disabled",
    );
    if (this.addedViewportClass) this.viewport.classList.remove("uc-viewport");
    this.viewport.classList.toggle("uc-infinite", this.hadInfiniteClass);
    if (this.addedWorldClass) this.world.classList.remove("uc-world");

    if (this.original.viewportTabIndex == null) {
      this.viewport.removeAttribute("tabindex");
    } else {
      this.viewport.setAttribute("tabindex", this.original.viewportTabIndex);
    }
    if (this.original.viewportAriaLabel == null) {
      this.viewport.removeAttribute("aria-label");
    } else {
      this.viewport.setAttribute(
        "aria-label",
        this.original.viewportAriaLabel,
      );
    }
    if (this.original.viewportAriaDisabled == null) {
      this.viewport.removeAttribute("aria-disabled");
    } else {
      this.viewport.setAttribute(
        "aria-disabled",
        this.original.viewportAriaDisabled,
      );
    }
    if (this.original.viewportAriaReadonly == null) {
      this.viewport.removeAttribute("aria-readonly");
    } else {
      this.viewport.setAttribute(
        "aria-readonly",
        this.original.viewportAriaReadonly,
      );
    }
    if (this.original.viewportRole == null) {
      this.viewport.removeAttribute("role");
    } else {
      this.viewport.setAttribute("role", this.original.viewportRole);
    }
    if (this.original.viewportScale) {
      this.viewport.style.setProperty(
        "--uc-scale",
        this.original.viewportScale,
      );
    } else {
      this.viewport.style.removeProperty("--uc-scale");
    }
    this.world.style.width = this.original.worldWidth;
    this.world.style.height = this.original.worldHeight;
    this.world.style.transform = this.original.worldTransform;
    this.dispatch("unicanvasdestroy", {});
  }
}

const api = Object.freeze({
  version: VERSION,
  get documents() { return globalThis.UniCanvasDocuments; },
  create: (options) => new CanvasController(options),
  scope: () => new CleanupScope(),
  CanvasController,
  CleanupScope,
  ui: Object.freeze({
    version: "1.1.0",
    classes: Object.freeze({
      overlay: "ucx-overlay",
      dialog: "ucx-dialog",
      viewport: "uc-viewport",
      world: "uc-world",
      controls: "uc-controls",
    }),
  }),
});

Hooks.once("init", () => {
  game.modules.get(MOD).api = api;
  globalThis.UniCanvas = api;
  Hooks.callAll("unicanvas.apiReady", api);
  Hooks.callAll("unicanvas.uiReady", api.ui);
  console.info(MOD + " | ready v" + VERSION);
});
