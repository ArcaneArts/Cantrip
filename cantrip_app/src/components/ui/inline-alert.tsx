import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, Info } from "lucide-react";
import * as React from "react";

import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

const inlineAlertVariants = cva(
  "flex items-start gap-2 rounded-md border leading-5",
  {
    variants: {
      size: {
        default: "px-3 py-2 text-sm",
        sm: "px-3 py-2 text-xs",
      },
      tone: {
        error: "border-destructive/30 bg-destructive/5 text-destructive",
        info: "border-border bg-muted/40 text-muted-foreground",
        warning:
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      },
    },
    defaultVariants: {
      size: "default",
      tone: "info",
    },
  },
);

type InlineAlertProps = Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof inlineAlertVariants> & {
    error?: unknown;
    fallback?: string;
    icon?: React.ReactNode | false;
    title?: React.ReactNode;
  };

function InlineAlert({
  children,
  className,
  error,
  fallback = "Something went wrong.",
  icon,
  role,
  size,
  title,
  tone = "info",
  ...props
}: InlineAlertProps) {
  const message = children ?? errorMessage(error, fallback);
  const resolvedIcon =
    icon === false
      ? null
      : (icon ??
        (tone === "info" ? (
          <Info className="size-4" />
        ) : (
          <CircleAlert className="size-4" />
        )));

  return (
    <div
      role={role ?? (tone === "error" ? "alert" : "status")}
      data-slot="inline-alert"
      data-tone={tone}
      className={cn(inlineAlertVariants({ size, tone }), className)}
      {...props}
    >
      {resolvedIcon ? (
        <span aria-hidden="true" className="mt-0.5 shrink-0">
          {resolvedIcon}
        </span>
      ) : null}
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        <div>{message}</div>
      </div>
    </div>
  );
}

export { InlineAlert, inlineAlertVariants };
