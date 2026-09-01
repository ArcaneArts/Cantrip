import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function TooltipProvider({
  delayDuration = 350,
  skipDelayDuration = 100,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

export function Tooltip(
  props: React.ComponentProps<typeof TooltipPrimitive.Root>,
) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger(
  props: React.ComponentProps<typeof TooltipPrimitive.Trigger>,
) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  children,
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cn(
          "z-[80] w-fit max-w-80 origin-(--radix-tooltip-content-transform-origin) rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-[80] size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-primary fill-primary" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

function SuppressibleTooltip({
  children,
  disabled,
}: {
  children: React.ReactNode;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <Tooltip
      open={disabled ? false : open}
      onOpenChange={(nextOpen) => setOpen(disabled ? false : nextOpen)}
    >
      {children}
    </Tooltip>
  );
}

export function TooltipButton({
  disabled,
  pending,
  tooltip,
  tooltipDisabled,
  tooltipSide = "bottom",
  ...props
}: React.ComponentProps<typeof Button> & {
  tooltip: React.ReactNode;
  tooltipDisabled?: boolean;
  tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
}) {
  const ariaLabel =
    props["aria-label"] ?? (typeof tooltip === "string" ? tooltip : undefined);
  const button = (
    <Button
      {...props}
      aria-label={ariaLabel}
      disabled={disabled}
      pending={pending}
      title={undefined}
    />
  );
  const contents = (
    <>
      <TooltipTrigger asChild>
        {disabled || pending ? (
          <span className="inline-flex shrink-0">{button}</span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
    </>
  );

  return tooltipDisabled === undefined ? (
    <Tooltip>{contents}</Tooltip>
  ) : (
    <SuppressibleTooltip disabled={tooltipDisabled}>
      {contents}
    </SuppressibleTooltip>
  );
}
