import { Code2, MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";

export function MobileAppModeSwitch({
  currentMode,
  labeled = false,
  onSwitch,
}: {
  currentMode: "chat" | "ide";
  labeled?: boolean;
  onSwitch(): void;
}) {
  const switchingToChat = currentMode === "ide";
  const label = switchingToChat ? "Chats" : "IDE";
  const accessibleLabel = `Switch to ${label}`;
  const Icon = switchingToChat ? MessageSquare : Code2;

  return (
    <Button
      aria-label={accessibleLabel}
      className={labeled ? undefined : "size-9"}
      onClick={onSwitch}
      size={labeled ? "sm" : "icon"}
      title={accessibleLabel}
      variant="ghost"
    >
      <Icon className="size-4" />
      {labeled ? label : null}
    </Button>
  );
}
