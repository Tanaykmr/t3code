import * as Schema from "effect/Schema";

export const BoardExpect = Schema.Struct({
  /** Shape labels, each on exactly one shape a single successful board_apply creates. */
  shapes: Schema.Array(Schema.String),
  /** `[from, to]` shape labels: an arrow created in that same batch starts at one, ends at the other. */
  arrows: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});
export type BoardExpect = typeof BoardExpect.Type;

const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);

type Edit = { readonly [key: string]: unknown };
const isEdit = (value: unknown): value is Edit => typeof value === "object" && value !== null;

/** Whether one board_apply's edits draw the expected shapes and link them with arrows. */
const drawsBoard = (expect: BoardExpect, input: unknown) => {
  const edits = isEdit(input) && Array.isArray(input.edits) ? input.edits.filter(isEdit) : [];
  const creates = edits.filter((edit) => edit.op === "create");
  const names = new Map<string, string>();
  for (const label of expect.shapes) {
    const shapes = creates.filter(
      (edit) =>
        typeof edit.type === "string" &&
        SHAPES.has(edit.type) &&
        typeof edit.label === "string" &&
        edit.label.trim().toLowerCase() === label.toLowerCase(),
    );
    const name = shapes[0]?.id;
    if (shapes.length !== 1 || typeof name !== "string") return false;
    names.set(label, name);
  }
  if (new Set(names.values()).size !== names.size) return false;
  return expect.arrows.every(([from, to]) =>
    creates.some(
      (edit) =>
        edit.type === "arrow" && edit.start === names.get(from) && edit.end === names.get(to),
    ),
  );
};

export const gradeBoard = (
  expect: BoardExpect | undefined,
  calls: ReadonlyArray<{
    readonly tool: string;
    readonly input: unknown;
    readonly failed?: boolean;
  }>,
) =>
  expect === undefined
    ? []
    : [
        {
          check: `board ${expect.shapes.join(", ")}`,
          pass: calls.some(
            (call) =>
              call.tool === "board_apply" &&
              call.failed === false &&
              drawsBoard(expect, call.input),
          ),
        },
      ];
