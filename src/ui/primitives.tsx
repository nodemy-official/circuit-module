"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { CircuitIcon } from "./CircuitIcon.js";

/**
 * shadcn/ui の Base UI 版を、回路 UI の CSS 変数プリセット向け class と data-slot に調整しています。
 * @see https://ui.shadcn.com/docs/components/base/button
 * @see https://ui.shadcn.com/docs/components/base/dialog
 */

function classNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export type ButtonVariant = "default" | "outline" | "ghost";
export type ButtonSize = "default" | "icon";

export type ButtonProps = Omit<ButtonPrimitive.Props, "className"> & {
  className?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLElement, ButtonProps>(
  ({ className, size = "default", variant = "default", type = "button", ...props }, ref) => (
    <ButtonPrimitive
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={classNames(
        "circuit-ui-button",
        className,
      )}
      type={type}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export type InputProps = Omit<InputPrimitive.Props, "className"> & {
  className?: string;
};

export const Input = forwardRef<HTMLElement, InputProps>(({ className, ...props }, ref) => (
  <InputPrimitive
    ref={ref}
    data-slot="input"
    className={classNames("circuit-ui-input", className)}
    {...props}
  />
));
Input.displayName = "Input";

export type NativeSelectProps = Omit<ComponentPropsWithoutRef<"select">, "className"> & {
  className?: string;
};

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      data-slot="native-select"
      className={classNames("circuit-ui-input", className)}
      {...props}
    />
  ),
);
NativeSelect.displayName = "NativeSelect";

export type SwitchProps = Omit<SwitchPrimitive.Root.Props, "children" | "className"> & {
  children?: ReactNode;
  className?: string;
  thumbClassName?: string;
};

export const Switch = forwardRef<HTMLElement, SwitchProps>(
  ({ children, className, thumbClassName, ...props }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      className={classNames("circuit-ui-switch", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={classNames("circuit-ui-switch-thumb", thumbClassName)}
      >
        {children}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  ),
);
Switch.displayName = "Switch";

export type TabsProps = Omit<TabsPrimitive.Root.Props, "className"> & {
  className?: string;
};

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(({ className, ...props }, ref) => (
  <TabsPrimitive.Root
    ref={ref}
    data-slot="tabs"
    className={classNames("circuit-ui-tabs", className)}
    {...props}
  />
));
Tabs.displayName = "Tabs";

export type TabsListProps = Omit<TabsPrimitive.List.Props, "className"> & {
  className?: string;
};

export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, activateOnFocus = true, ...props }, ref) => (
    <TabsPrimitive.List
      ref={ref}
      data-slot="tabs-list"
      className={classNames("circuit-ui-tabs-list", className)}
      activateOnFocus={activateOnFocus}
      {...props}
    />
  ),
);
TabsList.displayName = "TabsList";

export type TabsTriggerProps = Omit<TabsPrimitive.Tab.Props, "className"> & {
  className?: string;
};

export const TabsTrigger = forwardRef<HTMLElement, TabsTriggerProps>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Tab
      ref={ref}
      data-slot="tabs-trigger"
      className={classNames("circuit-ui-tabs-trigger", className)}
      {...props}
    />
  ),
);
TabsTrigger.displayName = "TabsTrigger";

export type TabsContentProps = Omit<TabsPrimitive.Panel.Props, "className" | "keepMounted"> & {
  className?: string;
  keepMounted?: boolean;
};

export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, keepMounted = true, ...props }, ref) => (
    <TabsPrimitive.Panel
      ref={ref}
      data-slot="tabs-content"
      className={classNames("circuit-ui-tabs-content", className)}
      keepMounted={keepMounted}
      {...props}
    />
  ),
);
TabsContent.displayName = "TabsContent";

export type DialogProps = DialogPrimitive.Root.Props;

export function Dialog(props: DialogProps) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export type DialogContentProps = Omit<DialogPrimitive.Popup.Props, "className"> & {
  className?: string;
  container?: DialogPrimitive.Portal.Props["container"];
  showCloseButton?: boolean;
};

export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      children,
      className,
      container,
      showCloseButton = true,
      ...props
    },
    ref,
  ) => (
    <DialogPrimitive.Portal data-slot="dialog-portal" container={container}>
      <DialogPrimitive.Backdrop
        data-slot="dialog-backdrop"
        className="circuit-ui-dialog-backdrop"
      />
      <DialogPrimitive.Popup
        ref={ref}
        data-slot="dialog-content"
        className={classNames("circuit-ui-dialog-content", className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                size="icon"
                className="circuit-ui-dialog-close"
                aria-label="閉じる"
              />
            }
          >
            <CircuitIcon name="close" size={18} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  ),
);
DialogContent.displayName = "DialogContent";

export type DialogTitleProps = Omit<DialogPrimitive.Title.Props, "className"> & {
  className?: string;
};

export const DialogTitle = forwardRef<HTMLHeadingElement, DialogTitleProps>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Title
      ref={ref}
      data-slot="dialog-title"
      className={classNames("circuit-ui-dialog-title", className)}
      {...props}
    />
  ),
);
DialogTitle.displayName = "DialogTitle";

export type DialogDescriptionProps = Omit<DialogPrimitive.Description.Props, "className"> & {
  className?: string;
};

export const DialogDescription = forwardRef<HTMLParagraphElement, DialogDescriptionProps>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Description
      ref={ref}
      data-slot="dialog-description"
      className={classNames("circuit-ui-dialog-description", className)}
      {...props}
    />
  ),
);
DialogDescription.displayName = "DialogDescription";

export type DialogCloseProps = Omit<DialogPrimitive.Close.Props, "className"> & {
  className?: string;
};

export const DialogClose = forwardRef<HTMLButtonElement, DialogCloseProps>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Close
      ref={ref}
      data-slot="dialog-close"
      className={className}
      {...props}
    />
  ),
);
DialogClose.displayName = "DialogClose";
