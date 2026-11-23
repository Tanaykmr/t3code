import { mentionQueryAt, mentionsInText } from "@t3tools/client-runtime/state/bots";
import { BOT_MESSAGE_MAX_LENGTH, type Bot, type BotMention } from "@t3tools/contracts";
import { ArrowUpIcon, AtSignIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { BotAvatarIcon } from "./BotAvatarIcon";

/**
 * A plain composer whose @-picks become chips. Only chips route: a typed `@Name`
 * without one is just text.
 */
export function BotMentionComposer(props: {
  readonly bots: ReadonlyArray<Bot>;
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly onSend: (input: {
    readonly text: string;
    readonly mentions: ReadonlyArray<BotMention>;
  }) => Promise<boolean>;
}) {
  const gt = useGT();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [chips, setChips] = useState<ReadonlyArray<BotMention>>([]);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const query = mentionQueryAt(text, caret);
  const suggestions =
    query === null
      ? []
      : props.bots
          .filter((bot) => bot.name.toLowerCase().startsWith(query.query.toLowerCase()))
          .slice(0, 6);
  const mentions = mentionsInText(text, chips);
  const canSend = !sending && props.disabled !== true && text.trim() !== "";

  const pick = (bot: Bot) => {
    if (query === null) return;
    const before = text.slice(0, query.start);
    const after = text.slice(caret);
    const inserted = `@${bot.name} `;
    const next = `${before}${inserted}${after}`;
    setText(next);
    setChips([...chips, { botId: bot.id, label: bot.name }]);
    const nextCaret = before.length + inserted.length;
    setCaret(nextCaret);
    setHighlight(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const sent = await props.onSend({ text: text.trim(), mentions });
    setSending(false);
    if (sent) {
      setText("");
      setChips([]);
      setCaret(0);
    }
  };

  return (
    <div className="relative rounded-2xl border bg-card px-3 pt-2 pb-2 shadow-xs">
      {suggestions.length > 0 ? (
        <ul
          role="listbox"
          aria-label={gt("Bots")}
          className="absolute bottom-full left-2 mb-1 w-64 rounded-lg border bg-popover p-1 shadow-md"
        >
          {suggestions.map((bot, index) => (
            <li key={bot.id} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(bot);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  index === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
              >
                <BotAvatarIcon avatar={bot.avatar} className="size-4 text-muted-foreground" />
                <span className="font-medium">{bot.name}</span>
                <span className="truncate text-xs text-muted-foreground">{bot.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {mentions.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1" aria-label={gt("Addressed to")}>
          {mentions.map((mention) => (
            <span
              key={mention.botId}
              className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium"
            >
              @{mention.label}
            </span>
          ))}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        rows={2}
        value={text}
        maxLength={BOT_MESSAGE_MAX_LENGTH}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setHighlight(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (suggestions.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((highlight + step + suggestions.length) % suggestions.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(suggestions[highlight] ?? suggestions[0]!);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
        className="block w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center justify-between">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={gt("Mention a bot")}
          onClick={() => {
            const at = text.length > 0 && !/\s$/.test(text) ? `${text} @` : `${text}@`;
            setText(at);
            setCaret(at.length);
            inputRef.current?.focus();
          }}
        >
          <AtSignIcon aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          aria-label={gt("Send")}
          disabled={!canSend}
          onClick={() => void send()}
        >
          <ArrowUpIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
