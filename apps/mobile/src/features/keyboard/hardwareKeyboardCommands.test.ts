import { describe, expect, it } from "vite-plus/test";

import { parseActiveThreadPath } from "./hardwareKeyboardCommands";

describe("parseActiveThreadPath", () => {
  it.each(["/review", "?botDm=true"])("decodes route components before %s", (suffix) => {
    expect(parseActiveThreadPath(`/threads/local%20machine/thread%2Fone${suffix}`)).toEqual({
      environmentId: "local machine",
      threadId: "thread/one",
    });
  });

  it("ignores malformed encoded route components", () => {
    expect(parseActiveThreadPath("/threads/%E0%A4%A/thread-1")).toBeNull();
  });
});
