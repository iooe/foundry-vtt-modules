# Changelog

## 2.6.0

- Shared neutral editor surfaces with persistent light and dark themes.
- Search, keyboard save, compact menus and document selectors with UUID drops.
- Revision-aware save status for Dialogue Stage and Mind Palace.
- Browser coverage for all four editors, including responsive layout and quest/table selection.

## 2.4.0

- Corrected cursor-anchored zoom and drag deltas inside CSS-scaled Foundry UI.
- Reworked pinch gestures around a stable world-space focal point.
- Added pointer-capture recovery and seamless pinch-to-one-finger pan.
- Batched camera and drag writes with `requestAnimationFrame`.
- Removed duplicate drag commits on pointer release and click-only gestures.
- Added complete cleanup for active gestures, timers, animation frames,
  observers, controls, listeners, classes, styles, and accessibility state.
- Added infinite and finite camera bounds, `fitBounds`, `centerOn`, `panTo`,
  `setSize`, `animateTo`, `batch`, and status/control methods.
- Added grid, axis, bounds, and custom snap support for draggable elements.
- Added destroy-safe `CleanupScope` and controller event subscriptions.
- Added resize center preservation and reduced-motion support.
- Improved keyboard navigation, focus visibility, labels, and disabled states.
- Added a deterministic controller regression test suite.
