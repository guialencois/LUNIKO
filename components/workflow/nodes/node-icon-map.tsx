import {
  MousePointerClick,
  Webhook,
  Clock,
  Globe,
  PencilLine,
  GitFork,
  Split,
  Wand2,
  Merge as MergeIcon,
  Timer,
  Code2,
  Calendar,
  Sheet,
  Bot,
  type LucideIcon,
} from "lucide-react";

export const nodeIconMap: Record<string, LucideIcon> = {
  MousePointerClick,
  Webhook,
  Clock,
  Globe,
  PencilLine,
  GitFork,
  Split,
  Wand2,
  Merge: MergeIcon,
  Timer,
  Code2,
  Calendar,
  Sheet,
  Bot,
};

export function getNodeIcon(iconName: string): LucideIcon {
  return nodeIconMap[iconName] ?? Globe;
}
