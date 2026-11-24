import type {
  BoardConflict,
  BoardElement,
  BoardElementToken,
  BoardOperation,
  BoardSnapshot,
} from "@t3tools/contracts";
import { generateKeyBetween } from "fractional-indexing";

/**
 * A small agent vocabulary compiled to native Excalidraw 0.18.1 records, with no DOM. Defaults
 * match the editor's own new-element defaults so agent shapes look like hand-drawn ones.
 */
export type BoardShapeType = "rectangle" | "diamond" | "ellipse";
export type BoardCreateType = BoardShapeType | "text" | "arrow" | "line";

export interface BoardCreateEdit {
  readonly op: "create";
  readonly type: BoardCreateType;
  /** The caller's name for the element within this batch; the server picks the real id. */
  readonly id?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly label?: string | undefined;
  readonly text?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly strokeColor?: string | undefined;
  readonly backgroundColor?: string | undefined;
}

export interface BoardPatchEdit {
  readonly op: "patch";
  readonly id: string;
  readonly expected: BoardElementToken;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly label?: string | undefined;
  readonly text?: string | undefined;
  readonly strokeColor?: string | undefined;
  readonly backgroundColor?: string | undefined;
}

export interface BoardDeleteEdit {
  readonly op: "delete";
  readonly id: string;
  readonly expected: BoardElementToken;
}

export type BoardEdit = BoardCreateEdit | BoardPatchEdit | BoardDeleteEdit;

export interface BoardEditRandom {
  readonly id: () => string;
  readonly seed: () => number;
}

export type CompiledBoardEdits =
  | {
      readonly _tag: "Compiled";
      readonly operations: ReadonlyArray<BoardOperation>;
      /** Caller temp id → real id. */
      readonly ids: Readonly<Record<string, string>>;
      /** Bound labels, which the caller edits through their container. */
      readonly labelIds: ReadonlySet<string>;
      /**
       * Existing records written without a token from the caller (labels, arrows, binding
       * targets), as the elements the caller sees and their tokens in `snapshot`.
       */
      readonly dependents: ReadonlyArray<BoardConflict>;
    }
  | { readonly _tag: "Invalid"; readonly message: string }
  | { readonly _tag: "Stale"; readonly conflicts: ReadonlyArray<BoardConflict> };

const FONT_SIZE = 20;
const FONT_FAMILY_EXCALIFONT = 5;
const LINE_HEIGHT = 1.25;
// No DOM to measure text in: estimate an average Excalifont glyph as this fraction of the font size.
// The editor re-measures on load and edit, so this only has to be close.
const CHAR_WIDTH = FONT_SIZE * 0.6;
const BOUND_TEXT_PADDING = 5;
/** The editor logs elements beyond this as corrupt. */
const MAX_COORDINATE = 1_000_000;
const BINDING_GAP = 5;
const ARROW_LABEL_WIDTH_FRACTION = 0.7;
const ARROW_LABEL_MIN_WIDTH = FONT_SIZE * 11;
const ROUNDNESS_PROPORTIONAL = 2;
const ROUNDNESS_ADAPTIVE = 3;
const BINDABLE_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "text",
  "image",
  "frame",
  "magicframe",
  "embeddable",
  "iframe",
]);
const RESIZABLE_TYPES = new Set(["rectangle", "diamond", "ellipse", "image", "frame"]);
const LABEL_CONTAINER_TYPES = new Set(["rectangle", "diamond", "ellipse", "arrow"]);
const LINEAR_TYPES = new Set(["arrow", "line"]);

type Mutable = { -readonly [K in keyof BoardElement]: BoardElement[K] } & Record<string, unknown>;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface BoundRef {
  readonly id: string;
  readonly type: string;
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const boundRefs = (element: BoardElement): ReadonlyArray<BoundRef> => {
  const value = element.boundElements;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { id?: unknown }).id === "string" &&
    typeof (entry as { type?: unknown }).type === "string"
      ? [{ id: (entry as BoundRef).id, type: (entry as BoundRef).type }]
      : [],
  );
};

const bindingTarget = (value: unknown): string | null =>
  typeof value === "object" && value !== null
    ? str((value as { elementId?: unknown }).elementId)
    : null;

const linearPoints = (element: BoardElement): ReadonlyArray<Point> => {
  const points = element.points;
  if (!Array.isArray(points)) return [];
  const x = num(element.x);
  const y = num(element.y);
  return points.flatMap((point: unknown) =>
    Array.isArray(point) && point.length >= 2
      ? [{ x: x + num(point[0]), y: y + num(point[1]) }]
      : [],
  );
};

/** Axis-aligned bounds; linear elements by their points, since x/y is only their first point. */
const elementBounds = (element: BoardElement) => {
  if (LINEAR_TYPES.has(element.type) || element.type === "freedraw") {
    const points = linearPoints(element);
    if (points.length > 0) {
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
    }
  }
  return {
    x: num(element.x),
    y: num(element.y),
    width: num(element.width),
    height: num(element.height),
  };
};

const wrapLines = (text: string, maxWidth: number): ReadonlyArray<string> => {
  const maxChars = Math.max(1, Math.floor(maxWidth / CHAR_WIDTH));
  const lines: Array<string> = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      let rest = word;
      while (rest.length > maxChars) {
        if (line !== "") {
          lines.push(line);
          line = "";
        }
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      if (line === "") line = rest;
      else if (line.length + 1 + rest.length <= maxChars) line = `${line} ${rest}`;
      else {
        lines.push(line);
        line = rest;
      }
    }
    lines.push(line);
  }
  return lines;
};

const measure = (lines: ReadonlyArray<string>) => ({
  width: Math.max(0, ...lines.map((line) => line.length)) * CHAR_WIDTH,
  height: lines.length * FONT_SIZE * LINE_HEIGHT,
});

const normalizeText = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");

/** Excalidraw's `getBoundTextMaxWidth` / `getBoundTextMaxHeight` and container inset, 0.18.1. */
const containerInner = (container: BoardElement) => {
  const width = num(container.width);
  const height = num(container.height);
  if (container.type === "ellipse") {
    return {
      dx: (width / 2) * (1 - Math.SQRT1_2) + BOUND_TEXT_PADDING,
      dy: (height / 2) * (1 - Math.SQRT1_2) + BOUND_TEXT_PADDING,
      width: Math.round((width / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2,
      height: Math.round((height / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2,
    };
  }
  if (container.type === "diamond") {
    return {
      dx: width / 4 + BOUND_TEXT_PADDING,
      dy: height / 4 + BOUND_TEXT_PADDING,
      width: Math.round(width / 2) - BOUND_TEXT_PADDING * 2,
      height: Math.round(height / 2) - BOUND_TEXT_PADDING * 2,
    };
  }
  return {
    dx: BOUND_TEXT_PADDING,
    dy: BOUND_TEXT_PADDING,
    width: width - BOUND_TEXT_PADDING * 2,
    height: height - BOUND_TEXT_PADDING * 2,
  };
};

/** The container height whose inner box fits `textHeight`. */
const containerHeightFor = (type: string, textHeight: number) => {
  const inner = textHeight + BOUND_TEXT_PADDING * 2;
  if (type === "ellipse") return Math.ceil(inner * Math.SQRT2);
  if (type === "diamond") return Math.ceil(inner * 2);
  return Math.ceil(inner);
};

/** Where a ray from the element's centre toward `toward` leaves its outline, plus the binding gap. */
const edgePoint = (element: BoardElement, toward: Point): Point => {
  const { x, y, width, height } = elementBounds(element);
  const center = { x: x + width / 2, y: y + height / 2 };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return center;
  const a = Math.max(width / 2, 1);
  const b = Math.max(height / 2, 1);
  const t =
    element.type === "ellipse"
      ? 1 / Math.hypot(dx / a, dy / b)
      : element.type === "diamond"
        ? 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
        : Math.min(dx === 0 ? Infinity : a / Math.abs(dx), dy === 0 ? Infinity : b / Math.abs(dy));
  return {
    x: center.x + dx * t + (dx / length) * BINDING_GAP,
    y: center.y + dy * t + (dy / length) * BINDING_GAP,
  };
};

const centerOf = (element: BoardElement): Point => {
  const { x, y, width, height } = elementBounds(element);
  return { x: x + width / 2, y: y + height / 2 };
};

const sameToken = (element: BoardElement, expected: BoardElementToken) =>
  element.version === expected.version && element.versionNonce === expected.versionNonce;

/**
 * Compiles agent edits against a snapshot into one native batch. Dependents (bound labels,
 * connected arrows, the shapes an arrow binds to) are updated in the same batch with the tokens
 * read from `snapshot`, so the service rejects the whole batch if any of them moved meanwhile.
 */
export const compileBoardEdits = (input: {
  readonly snapshot: BoardSnapshot;
  readonly edits: ReadonlyArray<BoardEdit>;
  readonly random: BoardEditRandom;
  readonly now: number;
}): CompiledBoardEdits => {
  const { snapshot, edits, random, now } = input;
  const base = new Map(snapshot.elements.map((element) => [element.id, element]));
  const next = new Map<string, Mutable>();
  const created = new Set<string>();
  const deleted = new Set<string>();
  const expectedFor = new Map<string, BoardElementToken>();
  const tempIds = new Map<string, string>();
  const indices = snapshot.elements
    .flatMap((element) => (element.index === null ? [] : [element.index]))
    .toSorted();

  const read = (id: string): BoardElement | undefined => next.get(id) ?? base.get(id);
  const live = (id: string): BoardElement | undefined => {
    const element = read(id);
    return element === undefined || element.isDeleted || deleted.has(id) ? undefined : element;
  };
  const write = (id: string): Mutable => {
    const existing = next.get(id);
    if (existing !== undefined) return existing;
    const copy = structuredClone(base.get(id)) as Mutable;
    next.set(id, copy);
    return copy;
  };

  /** A fresh index just above `after`, below whatever followed it. */
  const indexAfter = (after: string | null): string => {
    const position =
      after === null ? indices.length : indices.findIndex((candidate) => candidate > after);
    const at = position === -1 ? indices.length : position;
    const index = generateKeyBetween(
      after ?? indices[indices.length - 1] ?? null,
      indices[at] ?? null,
    );
    indices.splice(at, 0, index);
    return index;
  };

  const baseRecord = (
    type: string,
    fields: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly strokeColor?: string | undefined;
      readonly backgroundColor?: string | undefined;
      readonly index: string;
    },
  ): Mutable => {
    const id = random.id();
    created.add(id);
    return {
      id,
      type,
      x: fields.x,
      y: fields.y,
      width: fields.width,
      height: fields.height,
      angle: 0,
      strokeColor: fields.strokeColor ?? "#1e1e1e",
      backgroundColor: fields.backgroundColor ?? "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: fields.index,
      roundness:
        type === "rectangle"
          ? { type: ROUNDNESS_ADAPTIVE }
          : type === "text"
            ? null
            : { type: ROUNDNESS_PROPORTIONAL },
      seed: random.seed(),
      version: 1,
      versionNonce: 0,
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
    };
  };

  const textFields = (text: string) => {
    const lines = wrapLines(text, Infinity);
    return { text, originalText: text, ...measure(lines) };
  };

  /** Wraps and centres a bound label in its container, growing a shape that is too short. */
  const layoutLabel = (label: Mutable, containerId: string) => {
    const container = write(containerId);
    const original = str(label.originalText) ?? str(label.text) ?? "";
    if (LINEAR_TYPES.has(container.type)) {
      const bounds = elementBounds(container);
      const lines = wrapLines(
        original,
        Math.max(ARROW_LABEL_WIDTH_FRACTION * bounds.width, ARROW_LABEL_MIN_WIDTH),
      );
      const size = measure(lines);
      const points = linearPoints(container);
      const mid = Math.floor((points.length - 1) / 2);
      const from = points[mid] ?? { x: bounds.x, y: bounds.y };
      const to = points[mid + 1] ?? from;
      Object.assign(label, {
        text: lines.join("\n"),
        ...size,
        x: (from.x + to.x) / 2 - size.width / 2,
        y: (from.y + to.y) / 2 - size.height / 2,
      });
      return;
    }
    let inner = containerInner(container);
    const lines = wrapLines(original, Math.max(inner.width, CHAR_WIDTH));
    const size = measure(lines);
    if (size.height > inner.height) {
      container.height = containerHeightFor(container.type, size.height);
      inner = containerInner(container);
    }
    Object.assign(label, {
      text: lines.join("\n"),
      ...size,
      x: num(container.x) + inner.dx + inner.width / 2 - size.width / 2,
      y: num(container.y) + inner.dy + inner.height / 2 - size.height / 2,
    });
  };

  const labelOf = (container: BoardElement): string | undefined =>
    boundRefs(container).find((ref) => ref.type === "text" && live(ref.id) !== undefined)?.id;

  const setLabel = (containerId: string, text: string) => {
    const container = write(containerId);
    const existing = labelOf(container);
    // The editor drops whitespace-only text on load, which would strand the container's binding.
    if (text.trim() === "") {
      if (existing !== undefined) deleteElement(existing);
      return;
    }
    if (existing !== undefined) {
      const label = write(existing);
      Object.assign(label, { originalText: text, text, updated: now });
      layoutLabel(label, containerId);
      return;
    }
    const label = baseRecord("text", {
      x: num(container.x),
      y: num(container.y),
      width: 0,
      height: 0,
      strokeColor: str(container.strokeColor) ?? undefined,
      index: indexAfter(container.index),
    });
    Object.assign(label, {
      text,
      originalText: text,
      fontSize: FONT_SIZE,
      fontFamily: FONT_FAMILY_EXCALIFONT,
      textAlign: "center",
      verticalAlign: "middle",
      containerId,
      autoResize: true,
      lineHeight: LINE_HEIGHT,
    });
    next.set(label.id, label);
    container.boundElements = [...boundRefs(container), { id: label.id, type: "text" }];
    container.updated = now;
    layoutLabel(label, containerId);
  };

  const relayoutLabel = (containerId: string) => {
    const container = read(containerId);
    const labelId = container === undefined ? undefined : labelOf(container);
    if (container === undefined || labelId === undefined) return;
    layoutLabel(write(labelId), containerId);
  };

  /** Set when an edit would move an elbow arrow, which needs the editor's own router. */
  let movesElbow = false;

  /**
   * Re-aims an arrow's bound ends at its targets' outlines, keeping any bend points. When one
   * shape changed, only the end bound to it moves; the other end keeps its native placement.
   */
  const routeArrow = (arrowId: string, seed?: ReadonlyArray<Point>, movedId?: string) => {
    // Elbow and rotated arrows, and arrows on rotated shapes, need the editor's own geometry.
    const rotated = (id: string | null) => id !== null && (read(id)?.angle ?? 0) !== 0;
    const current = read(arrowId);
    if (
      current?.elbowed === true ||
      rotated(arrowId) ||
      rotated(bindingTarget(current?.startBinding)) ||
      rotated(bindingTarget(current?.endBinding))
    ) {
      movesElbow = true;
      return;
    }
    const arrow = write(arrowId);
    const points = [...(seed ?? linearPoints(arrow))];
    if (points.length < 2) return;
    const startId = bindingTarget(arrow.startBinding);
    const endId = bindingTarget(arrow.endBinding);
    const start = startId === null ? undefined : live(startId);
    const end = endId === null ? undefined : live(endId);
    const last = points.length - 1;
    if (start !== undefined && (movedId === undefined || startId === movedId)) {
      const toward = last > 1 ? points[1]! : end !== undefined ? centerOf(end) : points[last]!;
      points[0] = edgePoint(start, toward);
    }
    if (end !== undefined && (movedId === undefined || endId === movedId)) {
      const toward =
        last > 1 ? points[last - 1]! : start !== undefined ? centerOf(start) : points[0]!;
      points[last] = edgePoint(end, toward);
    }
    const origin = points[0]!;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    Object.assign(arrow, {
      x: origin.x,
      y: origin.y,
      points: points.map((point) => [point.x - origin.x, point.y - origin.y]),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      updated: now,
    });
    relayoutLabel(arrowId);
  };

  const relayoutDependents = (id: string) => {
    relayoutLabel(id);
    for (const ref of boundRefs(read(id)!)) {
      if (ref.type === "arrow" && live(ref.id) !== undefined) routeArrow(ref.id, undefined, id);
    }
  };

  const removeRef = (ownerId: string, refId: string) => {
    const owner = live(ownerId);
    if (owner === undefined || !boundRefs(owner).some((ref) => ref.id === refId)) return;
    const writable = write(ownerId);
    const remaining = boundRefs(owner).filter((ref) => ref.id !== refId);
    writable.boundElements = remaining.length === 0 ? null : remaining;
    writable.updated = now;
  };

  /** Deletes like the editor: a label goes with its container, and arrows let go of it. */
  function deleteElement(id: string): void {
    const element = live(id);
    if (element === undefined) return;
    deleted.add(id);
    const containerId = str(element.containerId);
    if (containerId !== null) removeRef(containerId, id);
    for (const endpoint of [
      bindingTarget(element.startBinding),
      bindingTarget(element.endBinding),
    ]) {
      if (endpoint !== null) removeRef(endpoint, id);
    }
    // Like the editor, deleting a frame releases its children instead of deleting them.
    if (element.type === "frame" || element.type === "magicframe") {
      for (const child of new Set([...base.keys(), ...next.keys()])) {
        if (live(child) !== undefined && read(child)?.frameId === id) {
          const writable = write(child);
          writable.frameId = null;
          writable.updated = now;
        }
      }
    }
    for (const ref of boundRefs(element)) {
      if (ref.type === "text") deleteElement(ref.id);
      else if (ref.type === "arrow" && live(ref.id) !== undefined) {
        const arrow = write(ref.id);
        if (bindingTarget(arrow.startBinding) === id) arrow.startBinding = null;
        if (bindingTarget(arrow.endBinding) === id) arrow.endBinding = null;
        arrow.updated = now;
      }
    }
  }

  /** A temp id from earlier in this batch, or an existing element. */
  const resolveRef = (ref: string) => tempIds.get(ref) ?? ref;

  const stale: Array<BoardConflict> = [];
  const targetExisting = (id: string, expected: BoardElementToken): BoardElement | undefined => {
    const element = base.get(id);
    if (element === undefined || created.has(id)) {
      stale.push({ id, current: null });
      return undefined;
    }
    if (!sameToken(element, expected)) {
      stale.push({ id, current: { version: element.version, versionNonce: element.versionNonce } });
      return undefined;
    }
    if (element.isDeleted) {
      stale.push({ id, current: { version: element.version, versionNonce: element.versionNonce } });
      return undefined;
    }
    if (!expectedFor.has(id)) expectedFor.set(id, expected);
    return element;
  };

  for (const [position, edit] of edits.entries()) {
    const where = `edits[${position}]`;
    if (
      edit.op !== "delete" &&
      [edit.x, edit.y, edit.width, edit.height].some(
        (value) => value !== undefined && Math.abs(value) > MAX_COORDINATE,
      )
    ) {
      return { _tag: "Invalid", message: `${where}: keep coordinates within ±${MAX_COORDINATE}.` };
    }
    if (edit.op === "create") {
      if (edit.id !== undefined && (tempIds.has(edit.id) || base.has(edit.id))) {
        return {
          _tag: "Invalid",
          message: `${where}: id "${edit.id}" is already used. Pick a new name for each created element.`,
        };
      }
      if (edit.type === "text") {
        if (edit.text === undefined || edit.text.trim() === "") {
          return { _tag: "Invalid", message: `${where}: a text element needs text.` };
        }
        if (edit.x === undefined || edit.y === undefined) {
          return { _tag: "Invalid", message: `${where}: a text element needs x and y.` };
        }
        if (edit.label !== undefined || edit.start !== undefined || edit.end !== undefined) {
          return {
            _tag: "Invalid",
            message: `${where}: text takes text, not label, start, or end.`,
          };
        }
        const text = normalizeText(edit.text);
        const element = baseRecord("text", {
          x: edit.x,
          y: edit.y,
          width: 0,
          height: 0,
          strokeColor: edit.strokeColor,
          backgroundColor: edit.backgroundColor,
          index: indexAfter(null),
        });
        Object.assign(element, {
          ...textFields(text),
          fontSize: FONT_SIZE,
          fontFamily: FONT_FAMILY_EXCALIFONT,
          textAlign: "left",
          verticalAlign: "top",
          containerId: null,
          autoResize: true,
          lineHeight: LINE_HEIGHT,
        });
        next.set(element.id, element);
        if (edit.id !== undefined) tempIds.set(edit.id, element.id);
        continue;
      }
      if (edit.text !== undefined) {
        return { _tag: "Invalid", message: `${where}: use label for a ${edit.type}'s text.` };
      }
      if (edit.type === "arrow" || edit.type === "line") {
        if (
          edit.type === "line" &&
          (edit.start !== undefined || edit.end !== undefined || edit.label !== undefined)
        ) {
          return {
            _tag: "Invalid",
            message: `${where}: only arrows attach to shapes or hold a label. Use type arrow.`,
          };
        }
        const ends: Array<BoardElement | undefined> = [];
        for (const ref of [edit.start, edit.end]) {
          if (ref === undefined) {
            ends.push(undefined);
            continue;
          }
          const target = live(resolveRef(ref));
          if (target === undefined) {
            return { _tag: "Invalid", message: `${where}: "${ref}" is not an element here.` };
          }
          if (!BINDABLE_TYPES.has(target.type) || str(target.containerId) !== null) {
            return {
              _tag: "Invalid",
              message: `${where}: an arrow cannot attach to "${ref}", a ${target.type}.`,
            };
          }
          ends.push(target);
        }
        const [start, end] = ends;
        const hasGeometry = edit.x !== undefined && edit.y !== undefined;
        if (!hasGeometry && (start === undefined || end === undefined)) {
          return {
            _tag: "Invalid",
            message: `${where}: give an ${edit.type} x and y (and width/height to its end), or both start and end.`,
          };
        }
        const from: Point = hasGeometry ? { x: edit.x!, y: edit.y! } : centerOf(start!);
        const to: Point = hasGeometry
          ? { x: edit.x! + (edit.width ?? 0), y: edit.y! + (edit.height ?? 0) }
          : centerOf(end!);
        const element = baseRecord(edit.type, {
          x: from.x,
          y: from.y,
          width: 0,
          height: 0,
          strokeColor: edit.strokeColor,
          backgroundColor: edit.backgroundColor,
          index: indexAfter(null),
        });
        Object.assign(element, {
          points: [
            [0, 0],
            [to.x - from.x, to.y - from.y],
          ],
          lastCommittedPoint: null,
          startBinding:
            start === undefined ? null : { elementId: start.id, focus: 0, gap: BINDING_GAP },
          endBinding: end === undefined ? null : { elementId: end.id, focus: 0, gap: BINDING_GAP },
          startArrowhead: null,
          endArrowhead: edit.type === "arrow" ? "arrow" : null,
          ...(edit.type === "arrow" ? { elbowed: false } : {}),
        });
        next.set(element.id, element);
        if (edit.id !== undefined) tempIds.set(edit.id, element.id);
        for (const target of new Set([start, end])) {
          if (target === undefined) continue;
          const writable = write(target.id);
          writable.boundElements = [...boundRefs(writable), { id: element.id, type: "arrow" }];
          writable.updated = now;
        }
        routeArrow(element.id, [from, to]);
        if (movesElbow) {
          return {
            _tag: "Invalid",
            message: `${where}: an arrow cannot attach to a rotated shape yet. Attach it to an unrotated shape, or give it x and y instead.`,
          };
        }
        if (edit.label !== undefined) setLabel(element.id, normalizeText(edit.label));
        continue;
      }
      if (
        edit.x === undefined ||
        edit.y === undefined ||
        edit.width === undefined ||
        edit.height === undefined
      ) {
        return {
          _tag: "Invalid",
          message: `${where}: a ${edit.type} needs x, y, width, and height.`,
        };
      }
      if (edit.width <= 0 || edit.height <= 0) {
        return { _tag: "Invalid", message: `${where}: width and height must be positive.` };
      }
      if (edit.start !== undefined || edit.end !== undefined) {
        return { _tag: "Invalid", message: `${where}: only arrows take start and end.` };
      }
      const element = baseRecord(edit.type, {
        x: edit.x,
        y: edit.y,
        width: edit.width,
        height: edit.height,
        strokeColor: edit.strokeColor,
        backgroundColor: edit.backgroundColor,
        index: indexAfter(null),
      });
      next.set(element.id, element);
      if (edit.id !== undefined) tempIds.set(edit.id, element.id);
      if (edit.label !== undefined) setLabel(element.id, normalizeText(edit.label));
      continue;
    }

    if (tempIds.has(edit.id)) {
      return {
        _tag: "Invalid",
        message: `${where}: "${edit.id}" is created in this edit. Set its fields when creating it.`,
      };
    }
    if (deleted.has(edit.id)) {
      return {
        _tag: "Invalid",
        message: `${where}: "${edit.id}" was deleted earlier in this edit.`,
      };
    }
    const target = targetExisting(edit.id, edit.expected);
    if (target === undefined) continue;

    if (edit.op === "delete") {
      deleteElement(edit.id);
      continue;
    }

    const linear = LINEAR_TYPES.has(target.type);
    const boundLabel = target.type === "text" && str(target.containerId) !== null;
    const moves = edit.x !== undefined || edit.y !== undefined;
    const resizes = edit.width !== undefined || edit.height !== undefined;
    if (boundLabel) {
      return {
        _tag: "Invalid",
        message: `${where}: "${edit.id}" is a label. Patch its container's label instead.`,
      };
    }
    if (linear && (moves || resizes)) {
      return {
        _tag: "Invalid",
        message: `${where}: arrows and lines cannot be moved by patch. Move what they connect, or delete and recreate them.`,
      };
    }
    if (resizes && !RESIZABLE_TYPES.has(target.type)) {
      return { _tag: "Invalid", message: `${where}: a ${target.type} cannot be resized.` };
    }
    if (
      (edit.width !== undefined && edit.width <= 0) ||
      (edit.height !== undefined && edit.height <= 0)
    ) {
      return { _tag: "Invalid", message: `${where}: width and height must be positive.` };
    }
    if (edit.text !== undefined && target.type !== "text") {
      return { _tag: "Invalid", message: `${where}: use label for a ${target.type}'s text.` };
    }
    if (edit.label !== undefined && target.type === "text") {
      return { _tag: "Invalid", message: `${where}: use text for a text element.` };
    }
    if (edit.label !== undefined && !LABEL_CONTAINER_TYPES.has(target.type)) {
      return { _tag: "Invalid", message: `${where}: a ${target.type} cannot hold a label.` };
    }

    // A frame's children move with it in the editor; that is not supported here yet.
    if ((moves || resizes) && (target.type === "frame" || target.type === "magicframe")) {
      return {
        _tag: "Invalid",
        message: `${where}: moving or resizing a frame is not supported yet. Move the shapes inside it instead.`,
      };
    }

    const element = write(edit.id);
    // Earlier edits in this batch may have moved it already; the label follows from there.
    const fromX = element.x as number;
    const fromY = element.y as number;
    if (edit.x !== undefined) element.x = edit.x;
    if (edit.y !== undefined) element.y = edit.y;
    if (edit.width !== undefined) element.width = edit.width;
    if (edit.height !== undefined) element.height = edit.height;
    if (edit.strokeColor !== undefined) element.strokeColor = edit.strokeColor;
    if (edit.backgroundColor !== undefined) element.backgroundColor = edit.backgroundColor;
    if (edit.text !== undefined) {
      if (edit.text.trim() === "") {
        return {
          _tag: "Invalid",
          message: `${where}: delete a text element instead of emptying it.`,
        };
      }
      Object.assign(element, textFields(normalizeText(edit.text)));
    }
    element.updated = now;
    const height = element.height;
    if (edit.label !== undefined) setLabel(edit.id, normalizeText(edit.label));
    if (moves && !resizes && edit.label === undefined && element.height === height) {
      // A plain move carries the label along as laid out, keeping its alignment and font.
      const labelId = labelOf(element);
      if (labelId !== undefined && live(labelId) !== undefined) {
        const label = write(labelId);
        label.x = (label.x as number) + (element.x as number) - fromX;
        label.y = (label.y as number) + (element.y as number) - fromY;
        label.updated = now;
      }
      for (const ref of boundRefs(element)) {
        if (ref.type === "arrow" && live(ref.id) !== undefined) {
          routeArrow(ref.id, undefined, edit.id);
        }
      }
    } else if (moves || resizes || edit.text !== undefined || element.height !== height) {
      // A longer label can grow its container, which moves the edges its arrows attach to.
      relayoutDependents(edit.id);
    }
    if (movesElbow) {
      return {
        _tag: "Invalid",
        message: `${where}: "${edit.id}" is attached to an elbow, rotated, or rotated-shape connector, and rerouting one is not supported yet. Leave its size and position, or delete the connector first.`,
      };
    }
  }

  if (stale.length > 0) return { _tag: "Stale", conflicts: stale };

  const operations: Array<BoardOperation> = [];
  const dependents = new Map<string, BoardConflict>();
  const tokenOf = (element: BoardElement) => ({
    version: element.version,
    versionNonce: element.versionNonce,
  });
  for (const id of new Set([...next.keys(), ...deleted])) {
    const element = next.get(id);
    if (created.has(id)) {
      if (!deleted.has(id) && element !== undefined) operations.push({ type: "create", element });
      continue;
    }
    const prior = base.get(id)!;
    const expected = expectedFor.get(id) ?? tokenOf(prior);
    if (!expectedFor.has(id)) {
      const containerId = prior.type === "text" ? str(prior.containerId) : null;
      const shown = (containerId === null ? undefined : base.get(containerId)) ?? prior;
      dependents.set(shown.id, { id: shown.id, current: tokenOf(shown) });
    }
    operations.push(
      deleted.has(id)
        ? { type: "delete", id, expected }
        : { type: "replace", element: element!, expected },
    );
  }
  if (operations.length === 0) {
    return { _tag: "Invalid", message: "The edit changes nothing." };
  }
  const labelIds = new Set(
    [...next.values()]
      .filter((element) => element.type === "text" && str(element.containerId) !== null)
      .map((element) => element.id),
  );
  return {
    _tag: "Compiled",
    operations,
    ids: Object.fromEntries(tempIds),
    labelIds,
    dependents: [...dependents.values()],
  };
};

export interface BoardSummaryElement {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly version: number;
  readonly versionNonce: number;
  readonly label?: string;
  readonly text?: string;
  readonly start?: string;
  readonly end?: string;
}

const SUMMARY_TEXT_MAX = 500;
const clip = (text: string) =>
  text.length > SUMMARY_TEXT_MAX ? `${text.slice(0, SUMMARY_TEXT_MAX)}…` : text;

/** Shortens long label and text, for a reply after any search has seen the full text. */
export const clipBoardSummary = (element: BoardSummaryElement): BoardSummaryElement => ({
  ...element,
  ...(element.label === undefined ? {} : { label: clip(element.label) }),
  ...(element.text === undefined ? {} : { text: clip(element.text) }),
});

/**
 * Live elements in canonical order, with each bound label folded into its container: the agent
 * edits labels through the container, so a label never appears on its own. Text is unclipped.
 */
export const summarizeBoard = (snapshot: BoardSnapshot): ReadonlyArray<BoardSummaryElement> => {
  const live = new Map(
    snapshot.elements
      .filter((element) => !element.isDeleted)
      .map((element) => [element.id, element]),
  );
  const labelText = (element: BoardElement) => str(element.originalText) ?? str(element.text) ?? "";
  const summary: Array<BoardSummaryElement> = [];
  for (const element of live.values()) {
    const containerId = str(element.containerId);
    if (element.type === "text" && containerId !== null && live.has(containerId)) continue;
    const bounds = elementBounds(element);
    const labelRef = boundRefs(element).find(
      (ref) => ref.type === "text" && live.get(ref.id)?.type === "text",
    );
    const label = labelRef === undefined ? undefined : labelText(live.get(labelRef.id)!);
    const start = bindingTarget(element.startBinding);
    const end = bindingTarget(element.endBinding);
    summary.push({
      id: element.id,
      type: element.type,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      version: element.version,
      versionNonce: element.versionNonce,
      ...(element.type === "text" ? { text: labelText(element) } : {}),
      ...(label === undefined ? {} : { label }),
      ...(start === null ? {} : { start }),
      ...(end === null ? {} : { end }),
    });
  }
  return summary;
};
