export function isInExcalidrawPanel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-excalidraw-panel]") !== null;
}
