# UniCanvas

Version **2.6.0** adds shared editor controls: persistent light/dark themes, sidebar search (Ctrl+K), save (Ctrl+S), compact action menus, document selectors and UUID drops. Dialogue Stage and Mind Palace show revision-aware autosave status. The authoring stylesheet is loaded after module styles during `ready`.

Version 2.5.0 also provides `UniCanvas.documents`: `ensure(moduleId)`, `list(moduleId)`, `uuid(moduleId, path)`, `resolve(uuid)`, `open(uuid)`, and `copyUuid(moduleId, path)`. It indexes shared author-created suite entities as private Foundry JournalEntryPages, preserves UUIDs across edits, and archives removed records. Journal pages link back to the module editors; they are not a second source of editable project data. Suite launch buttons work even without an active Foundry Scene.

UniCanvas is the shared DOM/SVG canvas runtime for the Foundry module suite. It
provides cursor-anchored zoom, mouse and touch panning, bounded or infinite
workspaces, scale-correct item dragging, camera animation, selection, and a
small lifecycle API. Version 2.4 is compatible with the 2.3 `create()`,
`makeDraggable()`, and camera methods.

The API is available after the Foundry `init` hook:

```js
const UC = game.modules.get("unicanvas")?.api;
const canvas = UC.create({
  viewport: document.querySelector(".my-viewport"),
  world: document.querySelector(".my-world"),
  width: 3000,
  height: 1800,
  minScale: 0.2,
  maxScale: 3,
  infinite: true,
  resizeBehavior: "preserve-center",
  onTransform: (state) => saveCamera(state),
});
```

Always call `canvas.destroy()` when its application closes. Destruction
cancels animation frames and active drags, disconnects `ResizeObserver`,
removes every listener, removes generated controls, and restores the original
inline styles and accessibility attributes.

## Camera

- `getState()` / `setState({ x, y, scale })`
- `panBy(x, y)` / `panTo(x, y)`
- `zoomBy(factor, point?)` / `zoomAt(scale, clientX, clientY)`
- `centerOn(worldX, worldY, { scale? })`
- `fit()` / `fitBounds({ x, y, width, height })`
- `animateTo({ x, y, scale }, { duration?, easing? })`
- `screenToWorld(clientX, clientY)` / `worldToScreen(x, y)`
- `setSize(width, height, { fit? })`
- `setInfinite(boolean)`, `setEnabled(boolean)`, `setReadOnly(boolean)`
- `getStatus()` returns the current modes, dimensions, and transform.

Wheel and pinch zoom keep the same world coordinate below the pointer. The
coordinate conversion also compensates when Foundry or another parent applies
a CSS transform to the viewport. `ResizeObserver` preserves the world point in
the center by default. Set `resizeBehavior` to `"fit"` or `"none"` when needed.

When `infinite: false`, camera translation is constrained to the configured
world size and `boundsPadding`. Infinite mode has no artificial square or
camera boundary.

Multiple camera changes can be coalesced into one render and one transform
notification:

```js
canvas.batch((camera) => {
  camera.setSize(4200, 2400);
  camera.centerOn(1750, 900, { scale: 1.25 });
});
```

## Draggable elements

```js
const disposeDrag = canvas.makeDraggable(card, {
  get: () => ({ x: record.x, y: record.y }),
  set: ({ x, y }) => {
    record.x = x;
    record.y = y;
    card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  },
  onEnd: (_point, _event, { moved, cancelled }) => {
    if (moved && !cancelled) persist(record);
  },
  threshold: 2,
  grid: 8,
  bounds: { minX: 0, minY: 0, maxX: 3000, maxY: 1800 },
});
```

Pointer movement is sampled with `getCoalescedEvents()` when available and
committed at most once per animation frame. Releasing an unmoved item does not
call `set`, which prevents editor flashes and unnecessary persistence. Options
also include `axis: "x" | "y"`, `snap(point)`, `disabled()`, `force`,
`ignore`, `onStart`, `onMove`, `onEnd`, and `onCancel`. Call the returned
function when the element is removed; `canvas.destroy()` also disposes it.

## Events and cleanup scopes

`canvas.on(name, listener)` returns an unsubscribe function. Controller events
include `transform`, `resize`, `selection`, `interactionstart`,
`interactionend`, `dragstart`, `dragmove`, `dragend`, and `motionchange`. DOM
consumers can listen for `unicanvastransform`, `unicanvasselection`, and
`unicanvasdestroy`.

The destroy-safe scope utility is useful in modules built on UniCanvas:

```js
const scope = UC.scope();
scope.listen(window, "keydown", onKeyDown);
const hookId = Hooks.on("updateActor", onActorUpdate);
scope.add(() => Hooks.off("updateActor", hookId));
// When the application closes:
scope.destroy();
```

Scopes run cleanups once in reverse registration order. Adding a cleanup to an
already destroyed scope executes it immediately. `scope.signal` is an
`AbortSignal`, so the same scope can also be passed to APIs that natively
support cancellation.

## Accessibility and motion

Generated controls are real `button` elements with labels, keyboard focus, and
an announced scale status. Supply localized strings through `labels`. Canvas
shortcuts are `+`, `-`, `0`/`Home`, arrow keys, and Space for pan override;
shortcuts are ignored while editing a form field. `animateTo()` follows the
operating-system reduced-motion setting, which can be overridden with
`setReducedMotion()`.

Version 2.4 also ships UniCanvas UI Kit 1.1, exposed as `api.ui`. Listen for
`unicanvas.apiReady` or `unicanvas.uiReady` during Foundry initialization.

UniCanvas bundles `@panzoom/panzoom` 4.6.2 under the MIT license for backwards
compatibility. Its complete license notice is included next to the bundled
script in [`scripts/vendor/PANZOOM-LICENSE.txt`](scripts/vendor/PANZOOM-LICENSE.txt).
