import type { BotAvatar } from "@t3tools/contracts";
import {
  BotIcon,
  CodeIcon,
  CompassIcon,
  FeatherIcon,
  FlaskConicalIcon,
  LightbulbIcon,
  type LucideIcon,
  RocketIcon,
  ShieldIcon,
} from "lucide-react";

export const BOT_AVATAR_ICONS: Record<BotAvatar, LucideIcon> = {
  bot: BotIcon,
  lightbulb: LightbulbIcon,
  code: CodeIcon,
  compass: CompassIcon,
  flask: FlaskConicalIcon,
  feather: FeatherIcon,
  rocket: RocketIcon,
  shield: ShieldIcon,
};

export function BotAvatarIcon(props: { readonly avatar: BotAvatar; readonly className?: string }) {
  const Icon = BOT_AVATAR_ICONS[props.avatar];
  return <Icon aria-hidden className={props.className} strokeWidth={1.75} />;
}
