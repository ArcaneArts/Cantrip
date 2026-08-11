import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from "react";

import { cn } from "@/lib/utils";

export const styledMenuContentClass =
  "z-50 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg";
export const styledMenuItemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export function styledMenuContentClassName(className?: string): string {
  return cn(styledMenuContentClass, className);
}

export function styledMenuItemClassName(className?: string): string {
  return cn(styledMenuItemClass, className);
}

export const StyledDropdownMenuContent = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Content
    ref={ref}
    className={styledMenuContentClassName(className)}
    {...props}
  />
));
StyledDropdownMenuContent.displayName = "StyledDropdownMenuContent";

export const StyledDropdownMenuItem = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={styledMenuItemClassName(className)}
    {...props}
  />
));
StyledDropdownMenuItem.displayName = "StyledDropdownMenuItem";

export const StyledDropdownMenuSubContent = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent
    ref={ref}
    className={styledMenuContentClassName(className)}
    {...props}
  />
));
StyledDropdownMenuSubContent.displayName = "StyledDropdownMenuSubContent";

export const StyledDropdownMenuSubTrigger = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={styledMenuItemClassName(className)}
    {...props}
  />
));
StyledDropdownMenuSubTrigger.displayName = "StyledDropdownMenuSubTrigger";

export const StyledContextMenuContent = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Content
    ref={ref}
    className={styledMenuContentClassName(className)}
    {...props}
  />
));
StyledContextMenuContent.displayName = "StyledContextMenuContent";

export const StyledContextMenuItem = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={styledMenuItemClassName(className)}
    {...props}
  />
));
StyledContextMenuItem.displayName = "StyledContextMenuItem";

export const StyledContextMenuSubContent = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.SubContent
    ref={ref}
    className={styledMenuContentClassName(className)}
    {...props}
  />
));
StyledContextMenuSubContent.displayName = "StyledContextMenuSubContent";

export const StyledContextMenuSubTrigger = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={styledMenuItemClassName(className)}
    {...props}
  />
));
StyledContextMenuSubTrigger.displayName = "StyledContextMenuSubTrigger";
