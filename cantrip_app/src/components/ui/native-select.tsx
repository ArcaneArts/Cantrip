import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const nativeSelectVariants = cva(
  "rounded-md border border-input bg-background outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-9 px-3 text-sm",
        sm: "h-8 px-2 text-xs",
        lg: "h-10 px-3 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

function NativeSelect({
  className,
  size,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> &
  VariantProps<typeof nativeSelectVariants>) {
  return (
    <select
      data-slot="native-select"
      className={cn(nativeSelectVariants({ className, size }))}
      {...props}
    />
  );
}

export { NativeSelect, nativeSelectVariants };
