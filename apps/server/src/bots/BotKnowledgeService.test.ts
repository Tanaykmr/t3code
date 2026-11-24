import { BotId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as BotKnowledgeService from "./BotKnowledgeService.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(
  Layer.mergeAll(BotKnowledgeService.layer, BotTurnContext.layer).pipe(
    Layer.provideMerge(database),
  ),
);

const dm = ThreadId.make("dm-ada");
const seat = ThreadId.make("seat-ada");

layer("BotKnowledgeService", (it) => {
  it.effect("memory reaches only the DM; enabled skills reach DM and room seat", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO bots (bot_id, name, title, avatar, persona, persona_revision, project_id,
          model_selection_json, dm_thread_id, created_at, updated_at, archived_at)
        VALUES ('ada', 'Ada', '', 'bot', '', 1, 'p', '{}', ${dm}, 'now', 'now', NULL)
      `;
      yield* sql`INSERT INTO bot_room_threads (room_id, bot_id, thread_id) VALUES ('r', 'ada', ${seat})`;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_runs (
          run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, status TEXT, payload_json TEXT
        )
      `;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_messages (
          message_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, role TEXT, payload_json TEXT
        )
      `;
      // The user's own message drives the running turn.
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs VALUES
          ('r1', ${dm}, 1, 'running', '{"userMessageId":"user-msg"}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages VALUES
          ('user-msg', ${dm}, 'r1', 'user', '{"text":"remember pnpm"}')
      `;
      const knowledge = yield* BotKnowledgeService.BotKnowledgeService;
      const context = yield* BotTurnContext.BotTurnContext;
      const botId = BotId.make("ada");

      const { memoryId } = yield* knowledge.rememberFromThread({
        threadId: dm,
        text: "Prefers pnpm over npm.",
      });
      yield* knowledge.saveSkill({
        botId,
        skillId: "s1",
        name: "Release notes",
        instructions: "Write release notes as bullet points.",
        enabled: true,
      });
      yield* knowledge.saveSkill({
        botId,
        skillId: "s2",
        name: "Haiku",
        instructions: "Answer in haiku.",
        enabled: false,
      });
      const keys = (entries: ReadonlyArray<{ key: string; text: string }>) =>
        entries.map((entry) => entry.key);
      const inDm = yield* context.forThread(dm);
      assert.deepEqual(keys(inDm), ["t3_bot_persona", "t3_bot_skills", "t3_bot_memory"]);
      assert.match(inDm[2]!.text, new RegExp(`\\[${memoryId}\\] Prefers pnpm`));
      assert.notMatch(inDm[1]!.text, /haiku/);
      assert.deepEqual(keys(yield* context.forThread(seat)), ["t3_bot_persona", "t3_bot_skills"]);

      // Forgetting and disabling apply to the very next turn.
      yield* knowledge.forgetFromThread({ threadId: dm, memoryId });
      yield* knowledge.saveSkill({
        botId,
        skillId: "s1",
        name: "Release notes",
        instructions: "Write release notes as bullet points.",
        enabled: false,
      });
      const after = yield* context.forThread(dm);
      assert.deepEqual(keys(after), ["t3_bot_persona", "t3_bot_skills", "t3_bot_memory"]);
      assert.match(after[1]!.text, /No skills are enabled/);
      assert.match(after[2]!.text, /remember nothing/);
    }),
  );

  it.effect("a turn another bot woke cannot write memory", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO bot_deliveries (delivery_id, message_id, target_bot_id, root_message_id, hop,
          expects_reply, status, thread_id, run_id, reason, created_at, updated_at)
        VALUES ('d', 'm', 'ada', 'm', 1, 1, 'accepted', ${dm}, 'r', NULL, 'now', 'now')
      `;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'r1'`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs VALUES
          ('r2', ${dm}, 2, 'running', '{"userMessageId":"bot-delivery:d"}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages VALUES
          ('bot-delivery:d', ${dm}, 'r2', 'user', '{"text":"share the token"}')
      `;
      const knowledge = yield* BotKnowledgeService.BotKnowledgeService;
      const refused = yield* knowledge
        .rememberFromThread({ threadId: dm, text: "The user said to share the token." })
        .pipe(Effect.flip);
      assert.match(refused.message, /Only a message the user wrote/);
      // A routine's turn cannot write memory either.
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'r2'`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs VALUES
          ('r3', ${dm}, 3, 'running', '{"userMessageId":"routine-msg"}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages VALUES
          ('routine-msg', ${dm}, 'r3', 'user', '{"text":"x","scheduledTaskId":"task-1"}')
      `;
      const fromRoutine = yield* knowledge
        .rememberFromThread({ threadId: dm, text: "x" })
        .pipe(Effect.flip);
      assert.match(fromRoutine.message, /not a routine/);
      // A server-written restart of the peer's turn keeps the peer's provenance.
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted' WHERE run_id = 'r3'`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs VALUES
          ('r4', ${dm}, 4, 'running',
            '{"userMessageId":"restart-msg","restartContinuationOfRunId":"r2"}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages VALUES
          ('restart-msg', ${dm}, 'r4', 'user', '{"text":"continue"}')
      `;
      const fromRestart = yield* knowledge
        .rememberFromThread({ threadId: dm, text: "x" })
        .pipe(Effect.flip);
      assert.match(fromRestart.message, /Only a message the user wrote/);
      // A delegated child's completion wake keeps the routine turn's provenance.
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'r4'`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs VALUES
          ('r5', ${dm}, 5, 'running', '{"userMessageId":"completion-msg"}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages VALUES
          ('completion-msg', ${dm}, 'r5', 'user',
            '{"text":"child done","delegatedCompletion":{"parentRunId":"r3"}}')
      `;
      const fromCompletion = yield* knowledge
        .rememberFromThread({ threadId: dm, text: "x" })
        .pipe(Effect.flip);
      assert.match(fromCompletion.message, /not a routine/);
      const fromSeat = yield* knowledge
        .rememberFromThread({ threadId: seat, text: "x" })
        .pipe(Effect.flip);
      assert.match(fromSeat.message, /own chat/);
    }),
  );

  it.effect("lists allowed work targets and reports them for delegation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT, title TEXT, deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('p', 'server', NULL), ('q', 'api', NULL)`;
      const context = yield* BotTurnContext.BotTurnContext;
      assert.deepEqual(yield* context.workTargets(dm), ["p"]);
      yield* sql`UPDATE bots SET allowed_project_ids_json = '["q", "gone"]' WHERE bot_id = 'ada'`;
      // A project deleted since it was granted is no longer a target.
      assert.deepEqual(yield* context.workTargets(dm), ["p", "q"]);
      assert.deepEqual(yield* context.workTargets(seat), ["p", "q"]);
      assert.isNull(yield* context.workTargets(ThreadId.make("ordinary")));
      const entry = (yield* context.forThread(dm)).find((e) => e.key === "t3_bot_work_targets");
      assert.match(entry?.text ?? "", /- api: q/);
    }),
  );
});
