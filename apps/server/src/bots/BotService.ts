import {
  Bot,
  BotError,
  BotRoom,
  type BotCreateInput,
  type BotDirectory,
  BotId,
  type BotMutationResult,
  type BotRefInput,
  type BotUpdateInput,
  CommandId,
  ModelSelection,
  ProjectId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { botProviderRejection } from "./BotProviderPolicy.ts";
import { type BotRow, ensureBotSchema, readRooms } from "./botStore.ts";

export class BotService extends Context.Service<
  BotService,
  {
    readonly subscribeDirectory: () => Stream.Stream<BotDirectory, BotError>;
    readonly create: (input: BotCreateInput) => Effect.Effect<BotMutationResult, BotError>;
    readonly update: (input: BotUpdateInput) => Effect.Effect<BotMutationResult, BotError>;
    readonly archive: (input: BotRefInput) => Effect.Effect<BotMutationResult, BotError>;
    readonly restore: (input: BotRefInput) => Effect.Effect<BotMutationResult, BotError>;
    /** Rooms live in the same directory; their writer signals here. */
    readonly notifyDirectoryChanged: Effect.Effect<void>;
  }
>()("t3/bots/BotService") {}

const decodeBot = Schema.decodeUnknownEffect(Bot);
const decodeRooms = Schema.decodeUnknownEffect(Schema.Array(BotRoom));
const ProjectIdsJson = Schema.fromJsonString(Schema.Array(ProjectId));
const decodeProjectIds = Schema.decodeUnknownEffect(ProjectIdsJson);
const encodeProjectIds = Schema.encodeEffect(ProjectIdsJson);
const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const encodeModelSelection = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const dmCommandId = (botId: string) => CommandId.make(`bot-dm:${botId}`);

const botError = (message: string, botId?: BotId, cause?: unknown) =>
  new BotError({
    message,
    ...(botId === undefined ? {} : { botId }),
    ...(cause === undefined ? {} : { cause }),
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  yield* ensureBotSchema;

  // Directory reads are small; subscribers re-read on the newest change signal.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  // Serializes name checks with their writes, so two creates cannot take one name.
  const writeLock = yield* Semaphore.make(1);

  const toBot = (row: BotRow) =>
    decodeProjectIds(row.allowed_project_ids_json).pipe(
      Effect.flatMap((allowedProjectIds) =>
        decodeBot({
          id: row.bot_id,
          name: row.name,
          title: row.title,
          avatar: row.avatar,
          persona: row.persona,
          personaRevision: row.persona_revision,
          dmThreadId: row.dm_thread_id,
          peerThreadId: row.peer_thread_id ?? null,
          projectId: row.project_id,
          allowedProjectIds,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          archivedAt: row.archived_at,
        }),
      ),
    );

  const readRow = (botId: BotId) =>
    sql<BotRow>`SELECT * FROM bots WHERE bot_id = ${botId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError((cause) => botError("Could not read the bot.", botId, cause)),
    );

  const requireReadyBot = Effect.fn("BotService.requireReadyBot")(function* (botId: BotId) {
    const row = yield* readRow(botId);
    if (row === undefined || row.dm_thread_id === null) {
      return yield* botError("That bot no longer exists.", botId);
    }
    return row;
  });

  const toResult = (row: BotRow) =>
    toBot(row).pipe(
      Effect.map((bot) => ({ bot })),
      Effect.mapError((cause) => botError("Could not read the bot.", undefined, cause)),
    );

  const list = Effect.fn("BotService.list")(function* () {
    const rows = yield* sql<BotRow>`
      SELECT * FROM bots WHERE dm_thread_id IS NOT NULL ORDER BY created_at, bot_id
    `.pipe(Effect.mapError((cause) => botError("Could not list bots.", undefined, cause)));
    const bots = yield* Effect.forEach(rows, (row) =>
      toBot(row).pipe(
        Effect.map((bot) => [bot]),
        // One unreadable row must not hide every other bot.
        Effect.catch((cause) =>
          Effect.logWarning("Skipping an unreadable bot.", { botId: row.bot_id, cause }).pipe(
            Effect.as([]),
          ),
        ),
      ),
    );
    const rooms = yield* readRooms(sql).pipe(
      Effect.flatMap(decodeRooms),
      Effect.mapError((cause) => botError("Could not list rooms.", undefined, cause)),
    );
    return { bots: bots.flat(), rooms } satisfies BotDirectory;
  });

  const subscribeDirectory: BotService["Service"]["subscribeDirectory"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the read is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  const assertNameFree = Effect.fn("BotService.assertNameFree")(function* (
    name: string,
    botId: BotId,
  ) {
    const rows = yield* sql<{ readonly bot_id: string }>`
      SELECT bot_id FROM bots
      WHERE name = ${name} COLLATE NOCASE AND bot_id <> ${botId} AND archived_at IS NULL
    `.pipe(Effect.mapError((cause) => botError("Could not check the bot name.", botId, cause)));
    if (rows.length > 0) {
      return yield* botError(`Another bot is already named ${name}.`, botId);
    }
  });

  // The launch is keyed by the bot, so a retry after a crash finds the same DM thread.
  const launchDm = Effect.fn("BotService.launchDm")(function* (row: BotRow) {
    const botId = BotId.make(row.bot_id);
    const modelSelection = yield* decodeModelSelection(row.model_selection_json).pipe(
      Effect.mapError((cause) => botError("The bot's model is unreadable.", botId, cause)),
    );
    const launched = yield* threadLaunch
      .launch({
        commandId: dmCommandId(row.bot_id),
        projectId: ProjectId.make(row.project_id),
        title: row.name,
        titleRenamed: true,
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError((cause) =>
          botError(`Could not start a chat for ${row.name}: ${cause.message}`, botId, cause),
        ),
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE bots SET dm_thread_id = ${launched.threadId}, updated_at = ${now}
      WHERE bot_id = ${row.bot_id}
    `.pipe(Effect.mapError((cause) => botError("Could not save the bot.", botId, cause)));
    yield* notifyChanged;
    return launched.threadId;
  });

  const create: BotService["Service"]["create"] = Effect.fn("BotService.create")(function* (input) {
    // Peer channels join two bot ids with ":", so an id must not contain one.
    if (input.botId.includes(":")) return yield* botError("That bot id is not valid.", input.botId);
    const existing = yield* readRow(input.botId);
    if (existing === undefined) {
      const currentSettings = Option.isSome(settings)
        ? yield* settings.value.getSettings.pipe(
            Effect.mapError((cause) =>
              botError("Could not read provider settings.", input.botId, cause),
            ),
          )
        : null;
      const rejection = botProviderRejection(input.modelSelection.instanceId, currentSettings);
      if (rejection !== undefined) return yield* botError(rejection);
      const now = DateTime.formatIso(yield* DateTime.now);
      const modelSelectionJson = yield* encodeModelSelection(input.modelSelection).pipe(
        Effect.mapError((cause) => botError("That model is not valid.", input.botId, cause)),
      );
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          yield* assertNameFree(input.name, input.botId);
          yield* sql`
              INSERT INTO bots (
                bot_id, name, title, avatar, persona, persona_revision, project_id,
                model_selection_json, dm_thread_id, created_at, updated_at, archived_at
              ) VALUES (
                ${input.botId}, ${input.name}, ${input.title}, ${input.avatar}, ${input.persona},
                1, ${input.projectId}, ${modelSelectionJson}, NULL, ${now}, ${now}, NULL
              )
              ON CONFLICT(bot_id) DO NOTHING
            `.pipe(
            Effect.mapError((cause) => botError("Could not save the bot.", input.botId, cause)),
          );
        }),
      );
    }
    const row = yield* readRow(input.botId);
    if (row === undefined) return yield* botError("Could not save the bot.", input.botId);
    if (row.dm_thread_id === null) yield* launchDm(row);
    return yield* toResult(yield* requireReadyBot(input.botId));
  });

  const update: BotService["Service"]["update"] = Effect.fn("BotService.update")(function* (input) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* requireReadyBot(input.botId);
        if (input.name !== undefined && row.archived_at === null) {
          yield* assertNameFree(input.name, input.botId);
        }
        const personaChanged = input.persona !== undefined && input.persona !== row.persona;
        const allowedProjectIdsJson =
          input.allowedProjectIds === undefined
            ? row.allowed_project_ids_json
            : yield* encodeProjectIds([...new Set(input.allowedProjectIds)]).pipe(
                Effect.mapError((cause) =>
                  botError("Those projects are not valid.", input.botId, cause),
                ),
              );
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
            UPDATE bots SET
              name = ${input.name ?? row.name},
              title = ${input.title ?? row.title},
              avatar = ${input.avatar ?? row.avatar},
              persona = ${input.persona ?? row.persona},
              allowed_project_ids_json = ${allowedProjectIdsJson},
              persona_revision = ${row.persona_revision + (personaChanged ? 1 : 0)},
              updated_at = ${now}
            WHERE bot_id = ${input.botId}
          `.pipe(
          Effect.mapError((cause) => botError("Could not save the bot.", input.botId, cause)),
        );
      }),
    );
    yield* notifyChanged;
    return yield* toResult(yield* requireReadyBot(input.botId));
  });

  const setArchivedAt = Effect.fn("BotService.setArchivedAt")(function* (
    botId: BotId,
    archivedAt: string | null,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE bots SET archived_at = ${archivedAt}, updated_at = ${now} WHERE bot_id = ${botId}
    `.pipe(Effect.mapError((cause) => botError("Could not save the bot.", botId, cause)));
    yield* notifyChanged;
    return yield* toResult(yield* requireReadyBot(botId));
  });

  const archive: BotService["Service"]["archive"] = Effect.fn("BotService.archive")(
    function* (input) {
      const row = yield* requireReadyBot(input.botId);
      if (row.archived_at !== null) return yield* toResult(row);
      // The bot also runs in its peer and room seats, which keep going after its DM is idle.
      const seats = yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM bot_room_threads WHERE bot_id = ${input.botId}
      `.pipe(Effect.mapError((cause) => botError("Could not read the bot.", input.botId, cause)));
      const owned = [row.dm_thread_id, row.peer_thread_id, ...seats.map((seat) => seat.thread_id)];
      for (const threadId of owned) {
        if (threadId === null) continue;
        const shell = yield* threads
          .getThreadShell(ThreadId.make(threadId))
          .pipe(
            Effect.mapError((cause) =>
              botError("Could not read the bot's chat.", input.botId, cause),
            ),
          );
        if (shell !== null && ACTIVE_STATUSES.has(shell.status)) {
          return yield* botError(`${row.name} is still working. Stop it first.`, input.botId);
        }
      }
      const archivedAt = DateTime.formatIso(yield* DateTime.now);
      // The DM is archived with its bot, so nothing, including the composer, wakes it meanwhile.
      yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`bot-archive:${input.botId}:${archivedAt}`),
          threadId: ThreadId.make(row.dm_thread_id ?? ""),
        })
        .pipe(
          Effect.mapError((cause) =>
            botError("Could not archive the bot's chat.", input.botId, cause),
          ),
        );
      return yield* setArchivedAt(input.botId, archivedAt);
    },
  );

  const restore: BotService["Service"]["restore"] = Effect.fn("BotService.restore")(
    function* (input) {
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* requireReadyBot(input.botId);
          if (row.archived_at === null) return yield* toResult(row);
          yield* assertNameFree(row.name, input.botId);
          yield* threads
            .dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(`bot-restore:${input.botId}:${row.archived_at}`),
              threadId: ThreadId.make(row.dm_thread_id ?? ""),
            })
            .pipe(
              Effect.mapError((cause) =>
                botError("Could not restore the bot's chat.", input.botId, cause),
              ),
            );
          return yield* setArchivedAt(input.botId, null);
        }),
      );
    },
  );

  // A restart between saving a bot and its DM launch finishes the launch with the same command.
  const pending = yield* sql<BotRow>`SELECT * FROM bots WHERE dm_thread_id IS NULL`.pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<BotRow>),
  );
  yield* Effect.forEach(pending, (row) =>
    launchDm(row).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not resume a bot's DM launch.", { cause })),
    ),
  ).pipe(Effect.forkScoped);

  return BotService.of({
    subscribeDirectory,
    create,
    update,
    archive,
    restore,
    notifyDirectoryChanged: notifyChanged,
  });
});

export const layer = Layer.effect(BotService, make);
