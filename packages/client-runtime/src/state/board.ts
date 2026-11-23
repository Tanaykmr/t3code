import {
  type BoardElement,
  type BoardFileRef,
  type BoardHeader,
  type BoardSettings,
  type BoardStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export type BoardView =
  | { readonly status: "missing" }
  | {
      readonly status: "ready";
      readonly board: BoardHeader;
      /** Canonical order, tombstones included. */
      readonly elements: ReadonlyArray<BoardElement>;
      readonly settings: BoardSettings;
      readonly files: ReadonlyArray<BoardFileRef>;
      /** Records the latest event changed; a snapshot changes all of them. */
      readonly changed: ReadonlySet<string> | "all";
      readonly mutationId: string | null;
    };

export class BoardStreamGapError extends Schema.TaggedError<BoardStreamGapError>()(
  "BoardStreamGapError",
  { expected: Schema.Number, received: Schema.Number },
) {}

const MAX_GAP_REOPENS = 5;

export const isBoardStreamGapError = Schema.is(BoardStreamGapError);

const byIndex = (left: BoardElement, right: BoardElement) => {
  const a = left.index ?? "";
  const b = right.index ?? "";
  if (a !== b) return a < b ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

/** Folds one stream event into the view. Already-seen revisions return the view unchanged. */
export function reduceBoardEvent(
  view: BoardView | null,
  event: BoardStreamEvent,
): BoardView | BoardStreamGapError {
  switch (event.type) {
    case "missing":
      return { status: "missing" };
    case "snapshot":
      return {
        status: "ready",
        board: event.snapshot.board,
        elements: event.snapshot.elements,
        settings: event.snapshot.settings,
        files: event.snapshot.files,
        changed: "all",
        mutationId: null,
      };
    case "delta": {
      const { delta } = event;
      if (view === null || view.status !== "ready") {
        return new BoardStreamGapError({ expected: 0, received: delta.revision });
      }
      if (delta.revision <= view.board.revision) return view;
      if (delta.revision !== view.board.revision + 1) {
        return new BoardStreamGapError({
          expected: view.board.revision + 1,
          received: delta.revision,
        });
      }
      const changed = new Map(delta.elements.map((element) => [element.id, element]));
      const elements = view.elements
        .filter((element) => !changed.has(element.id))
        .concat(delta.elements)
        .sort(byIndex);
      const files = delta.files?.length
        ? [
            ...view.files.filter((file) => !delta.files?.some((next) => next.id === file.id)),
            ...delta.files,
          ]
        : view.files;
      return {
        status: "ready",
        board: {
          ...view.board,
          revision: delta.revision,
          orderRevision: delta.orderRevision,
        },
        elements,
        settings: delta.settings ?? view.settings,
        files,
        changed: new Set(changed.keys()),
        mutationId: delta.mutationId,
      };
    }
  }
}

/** Folds every event in order. A gap means this subscriber fell behind, so it reopens. */
export function foldBoardStream<E, R>(
  stream: Stream.Stream<BoardStreamEvent, E, R>,
  reopened = 0,
): Stream.Stream<BoardView, E, R> {
  return stream.pipe(
    Stream.mapAccumEffect(
      (): BoardView | null => null,
      (view, event) => {
        const next = reduceBoardEvent(view, event);
        return isBoardStreamGapError(next)
          ? Effect.fail(next)
          : Effect.succeed([next, [next]] as const);
      },
    ),
    Stream.catchIf(isBoardStreamGapError, (gap) =>
      reopened < MAX_GAP_REOPENS ? foldBoardStream(stream, reopened + 1) : Stream.die(gap),
    ),
  );
}

export function createBoardEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const applyScheduler = createAtomCommandScheduler();
  return {
    view: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:board:view",
      tag: WS_METHODS.boardSubscribe,
      idleTtlMs: 0,
      transform: (stream) => foldBoardStream(stream),
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:create",
      tag: WS_METHODS.boardCreate,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:apply",
      tag: WS_METHODS.boardApply,
      scheduler: applyScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.boardId]),
      },
    }),
    getFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:get-files",
      tag: WS_METHODS.boardGetFiles,
    }),
  };
}
