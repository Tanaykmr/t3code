import IconBulb from "@tabler/icons-react-native/IconBulb";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconCompass from "@tabler/icons-react-native/IconCompass";
import IconFeather from "@tabler/icons-react-native/IconFeather";
import IconFlask from "@tabler/icons-react-native/IconFlask";
import IconRobotFace from "@tabler/icons-react-native/IconRobotFace";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconShield from "@tabler/icons-react-native/IconShield";
import type { BotAvatar } from "@t3tools/contracts";
import { withUniwind } from "uniwind";

const BOT_GLYPH_ICONS = {
  bot: IconRobotFace,
  lightbulb: IconBulb,
  code: IconCode,
  compass: IconCompass,
  flask: IconFlask,
  feather: IconFeather,
  rocket: IconRocket,
  shield: IconShield,
} satisfies Record<BotAvatar, unknown>;

function BotGlyphView(props: {
  readonly glyph: BotAvatar;
  readonly color?: string;
  readonly size?: number;
}) {
  const Icon = BOT_GLYPH_ICONS[props.glyph];
  return <Icon color={props.color} size={props.size ?? 20} strokeWidth={1.75} />;
}

/** A bot's line avatar; `colorClassName` themes it like other icons. */
export const BotGlyph = withUniwind(BotGlyphView);
