// Suite applications can open even in worlds with no active Foundry Scene.
(() => {
  const groups = { cityViewer: "city-viewer", mindPalace: "mind-palace", dialogueStage: "dialogue-stage", chronicle: "chronicle" };
  Hooks.once("ready", () => {
    document.addEventListener("click", event => {
      const button = event.target.closest?.("#scene-controls [data-control], #scene-controls [data-tool]");
      if (!button) return;
      const group = button.dataset.control || ui.controls?.control?.name;
      const moduleId = groups[group];
      if (!moduleId) return;
      const module = game.modules.get(moduleId);
      if (!module?.active || !module.api) return;
      const tool = button.dataset.tool;
      // Core SceneControls intentionally ignores all tools when canvas.ready is false.
      // Handle the module launch button ourselves; normal tool clicks remain with core.
      if (tool && globalThis.canvas?.ready) return;
      const commands = { open: "open", edit: "openEditor", show: "show", hide: "hide", close: "hide" };
      const command = tool ? commands[tool] : "open";
      if (!command || typeof module.api[command] !== "function") return;
      if (["openEditor", "show", "hide"].includes(command) && !game.user.isGM) return;
      event.preventDefault();
      if (!globalThis.canvas?.ready || tool) event.stopImmediatePropagation();
      Promise.resolve().then(() => module.api[command]()).catch(error => {
        console.error(`${moduleId} | Launch failed`, error);
        ui.notifications.error(`${module.title}: ${error.message}`);
      });
    }, true);
  });
})();
