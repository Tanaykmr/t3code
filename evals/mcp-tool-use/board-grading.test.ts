import { assert, it } from "@effect/vitest";

import { gradeBoard } from "./board-grading.ts";

const expect = {
  shapes: ["Web", "API", "Database"],
  arrows: [
    ["Web", "API"],
    ["API", "Database"],
  ],
} as const;

const box = (id: string, label: string) => ({ op: "create", type: "rectangle", id, label });
const arrow = (start: string, end: string) => ({ op: "create", type: "arrow", start, end });
const passes = (edits: ReadonlyArray<object>, failed = false) =>
  gradeBoard(expect, [{ tool: "board_apply", input: { edits }, failed }])[0]!.pass;

it("passes one successful batch that links the right boxes", () => {
  const boxes = [box("w", "Web"), box("a", " api "), box("d", "Database")];
  assert.isTrue(passes([...boxes, arrow("w", "a"), arrow("a", "d")]));
  assert.isFalse(passes([...boxes, arrow("w", "a"), arrow("a", "d")], true), "failed call");
  assert.isFalse(passes([...boxes, arrow("w", "d"), arrow("a", "d")]), "wrong start");
  assert.isFalse(passes([...boxes, arrow("w", "a")]), "missing arrow");
  assert.isFalse(passes([...boxes, arrow("a", "w"), arrow("d", "a")]), "reversed");
  assert.isFalse(
    passes([...boxes, box("w2", "Web"), arrow("w", "a"), arrow("a", "d")]),
    "two Web boxes",
  );
  assert.isFalse(
    passes([box("x", "Web"), box("x", "API"), box("d", "Database"), arrow("x", "x")]),
    "shared name",
  );
  assert.isFalse(
    passes([
      { op: "create", type: "text", id: "w", text: "Web" },
      box("a", "API"),
      box("d", "Database"),
      arrow("w", "a"),
      arrow("a", "d"),
    ]),
    "text is not a box",
  );
  assert.deepStrictEqual(gradeBoard(undefined, []), []);
});
