import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { Command as CommandPrimitive } from 'cmdk';
import { Toaster as SonnerToaster } from 'sonner';
import {
  AlertDialog as AlertDialogPrimitive,
  Checkbox as CheckboxPrimitive,
  Collapsible as CollapsiblePrimitive,
  ContextMenu as ContextMenuPrimitive,
  Dialog as DialogPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
  RadioGroup as RadioGroupPrimitive,
  ScrollArea as ScrollAreaPrimitive,
  Select as SelectPrimitive,
  Separator as SeparatorPrimitive,
  Switch as SwitchPrimitive,
  Tabs as TabsPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import { cn } from '../../lib/cn';
import { useTheme } from '../../lib/theme';

const focus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const surface =
  'ferry-ui border border-border bg-card text-card-foreground shadow-[var(--shadow-popover)]';

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;
export const AlertDialogCancel = AlertDialogPrimitive.Cancel;
export const AlertDialogAction = AlertDialogPrimitive.Action;
export const AlertDialogTitle = AlertDialogPrimitive.Title;
export const AlertDialogDescription = AlertDialogPrimitive.Description;
export function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      className={cn('fixed inset-0 z-[var(--z-modal-overlay)] bg-[var(--scrim)]', className)}
      {...props}
    />
  );
}
export function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        className={cn(
          'ferry-ui fixed left-1/2 top-1/2 z-[var(--z-modal)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-card p-6 text-card-foreground shadow-[var(--shadow-popover)]',
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}
const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button text-ui-label transition-colors duration-150 ease-out motion-reduce:transition-none ${focus} disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0`,
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:brightness-110',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        ghost: 'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:brightness-110',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-4',
        icon: 'size-8 rounded-button p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);
export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;
export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-ui-meta leading-4',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        success: 'border-transparent bg-success/15 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-6', className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-ui-section font-semibold leading-6', className)} {...props} />;
}
export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-ui-secondary text-muted-foreground', className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center p-6 pt-0', className)} {...props} />;
}

export function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}
export function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger {...props} />;
}
export function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal {...props} />;
}
export function DialogClose({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close
      className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), className)}
      {...props}
    />
  );
}
export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-[var(--scrim)] transition-opacity duration-200 ease-out data-[state=open]:animate-[ferry-ui-fade-in_200ms_ease-out_both] data-[state=closed]:animate-[ferry-ui-fade-out_200ms_ease-in_both] motion-reduce:animate-none motion-reduce:transition-none',
        className,
      )}
      {...props}
    />
  );
}
export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'ferry-ui fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-card border border-border bg-card p-6 text-card-foreground shadow-[var(--shadow-popover)] transition duration-200 ease-out data-[state=open]:animate-[ferry-ui-dialog-in_200ms_ease-out_both] data-[state=closed]:animate-[ferry-ui-fade-out_200ms_ease-in_both] motion-reduce:animate-none motion-reduce:transition-none',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-2 text-left', className)} {...props} />;
}
export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title className={cn('text-ui-section font-semibold', className)} {...props} />
  );
}
export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-ui-secondary text-muted-foreground', className)}
      {...props}
    />
  );
}

export function Sheet({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}
export const SheetTrigger = DialogTrigger;
export function SheetContent({
  side = 'right',
  className,
  overlayClassName,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  overlayClassName?: string;
}) {
  const position = {
    top: 'inset-x-0 top-0',
    right: 'inset-y-0 right-0 h-full w-[min(400px,90vw)]',
    bottom: 'inset-x-0 bottom-0',
    left: 'inset-y-0 left-0 h-full w-[min(400px,90vw)]',
  }[side];
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        className={cn(
          'ferry-ui fixed z-50 bg-card p-6 text-card-foreground shadow-[var(--shadow-popover)] transition duration-200 ease-out data-[state=open]:animate-[ferry-ui-fade-in_200ms_ease-out_both] data-[state=closed]:animate-[ferry-ui-fade-out_200ms_ease-in_both] motion-reduce:animate-none motion-reduce:transition-none',
          position,
          focus,
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
export const SheetClose = DialogClose;
export const SheetHeader = DialogHeader;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;

function MenuItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-control px-2 text-ui-body outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-4',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  );
}
export function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root {...props} />;
}
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(
        'flex min-h-8 items-center gap-2 rounded-control px-2 text-ui-body outline-none data-[state=open]:bg-accent [&_svg]:size-4',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4" strokeWidth={1.75} />
    </DropdownMenuPrimitive.SubTrigger>
  );
}
export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      className={cn('z-50 min-w-32 rounded-card p-1', surface, className)}
      {...props}
    />
  );
}
export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn('z-50 min-w-32 rounded-card p-1', surface, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}
export function DropdownMenuItem(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean },
) {
  return <MenuItem {...props} />;
}
export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      {...(checked === undefined ? {} : { checked })}
      className={cn(
        'relative flex min-h-8 cursor-default select-none items-center rounded-control py-1 pl-8 pr-2 text-ui-body outline-none data-[highlighted]:bg-accent',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-4" strokeWidth={1.75} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}
export function DropdownMenuRadioGroup(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>,
) {
  return <DropdownMenuPrimitive.RadioGroup {...props} />;
}
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn(
        'relative flex min-h-8 cursor-default select-none items-center rounded-control py-1 pl-8 pr-2 text-ui-body outline-none data-[highlighted]:bg-accent',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-4" strokeWidth={1.75} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}
export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('px-2 py-2 text-ui-meta text-muted-foreground', inset && 'pl-8', className)}
      {...props}
    />
  );
}
export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}
export function DropdownMenuShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('ml-auto pl-4 font-sans text-ui-meta text-muted-foreground', className)}
      {...props}
    />
  );
}

export function ContextMenu(props: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root {...props} />;
}
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuPortal = ContextMenuPrimitive.Portal;
export const ContextMenuSub = ContextMenuPrimitive.Sub;
export function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn('z-50 min-w-32 rounded-card p-1', surface, className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}
export function ContextMenuItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        'flex min-h-8 cursor-default items-center rounded-control px-2 text-ui-body outline-none data-[highlighted]:bg-accent',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  );
}
export function ContextMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return (
    <ContextMenuPrimitive.Label
      className={cn('px-2 py-1.5 text-ui-meta text-muted-foreground', className)}
      {...props}
    />
  );
}
export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export function Tabs(props: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root {...props} />;
}
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex h-9 items-center gap-1 rounded-button bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-7 items-center justify-center rounded-control px-3 text-ui-label transition-colors duration-150 ease-out motion-reduce:transition-none data-[state=active]:bg-card data-[state=active]:text-foreground',
        focus,
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('mt-3 focus-visible:outline-none', className)}
      {...props}
    />
  );
}

export function TooltipProvider(props: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={400} {...props} />;
}
export function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root {...props} />;
}
export function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger {...props} />;
}
export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'ferry-ui z-50 rounded-control border border-border bg-popover px-3 py-1.5 text-ui-meta text-popover-foreground shadow-[var(--shadow-popover)]',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-card bg-popover text-popover-foreground',
        className,
      )}
      {...props}
    />
  );
}
export function CommandDialog({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { children: React.ReactNode }) {
  return (
    <Dialog {...props}>
      <DialogContent className="overflow-hidden p-0">
        <Command className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-ui-meta [&_[cmdk-group-heading]]:text-muted-foreground">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
export function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center border-b border-border px-3">
      <CommandPrimitive.Input
        className={cn(
          'h-11 w-full bg-transparent text-ui-body outline-none placeholder:text-muted-foreground',
          className,
        )}
        {...props}
      />
    </div>
  );
}
export function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn('max-h-72 overflow-y-auto overflow-x-hidden p-1', className)}
      {...props}
    />
  );
}
export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className="py-6 text-center text-ui-body text-muted-foreground"
      {...props}
    />
  );
}
export function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-ui-meta [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
export function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn('my-1 h-px bg-border', className)} {...props} />;
}
export function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-control px-2 py-1.5 text-ui-body outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
export function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('ml-auto pl-4 font-sans text-ui-meta text-muted-foreground', className)}
      {...props}
    />
  );
}

export const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = 'ScrollArea';
export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation={orientation}
      className={cn(
        'flex touch-none select-none p-1 transition-colors',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}

export function SidebarProvider({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex min-h-svh w-full', className)} {...props} />;
}
export function Sidebar({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <aside
      className={cn('flex h-full w-64 flex-col bg-sidebar text-sidebar-foreground', className)}
      {...props}
    />
  );
}
export function SidebarHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-3', className)} {...props} />;
}
export function SidebarContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 flex-1 overflow-auto px-3', className)} {...props} />;
}
export function SidebarFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-3', className)} {...props} />;
}
export function SidebarGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <section className={cn('py-3', className)} {...props} />;
}
export function SidebarGroupLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-2 pb-2 text-ui-meta text-muted-foreground', className)} {...props} />
  );
}
export function SidebarMenu({ className, ...props }: React.HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn('flex flex-col gap-1', className)} {...props} />;
}
export function SidebarMenuItem(props: React.LiHTMLAttributes<HTMLLIElement>) {
  return <li {...props} />;
}
export function SidebarMenuButton({
  className,
  isActive,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { isActive?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-button px-2 text-left text-ui-body hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        focus,
        isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="relative w-full overflow-auto">
      <table className={cn('w-full caption-bottom text-ui-body', className)} {...props} />
    </div>
  );
}
export function TableHeader(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="[&_tr]:border-b [&_tr]:border-border" {...props} />;
}
export function TableBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className="[&_tr:last-child]:border-0" {...props} />;
}
export function TableFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot className={cn('border-t border-border bg-muted/50 font-medium', className)} {...props} />
  );
}
export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}
export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-10 px-3 text-left align-middle text-ui-meta text-muted-foreground [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}
export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('p-3 align-middle [&:has([role=checkbox])]:pr-0', className)} {...props} />
  );
}
export function TableCaption({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption className={cn('mt-3 text-ui-secondary text-muted-foreground', className)} {...props} />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full rounded-control border border-input bg-background px-3 py-1 text-ui-body placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        focus,
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-20 w-full rounded-control border border-input bg-background px-3 py-2 text-ui-body  placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        focus,
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root {...props} />;
}
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;
export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-9 w-full items-center justify-between rounded-control border border-input bg-background px-3 text-ui-body  data-[placeholder]:text-muted-foreground',
        focus,
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-50" strokeWidth={1.75} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}
export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn('z-50 max-h-96 min-w-32 overflow-hidden rounded-card', surface, className)}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}
export function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn('px-2 py-1.5 text-ui-meta text-muted-foreground', className)}
      {...props}
    />
  );
}
export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex min-h-8 w-full cursor-default select-none items-center rounded-control py-1.5 pl-8 pr-2 text-ui-body outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" strokeWidth={1.75} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
export function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
  );
}

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root className={cn('ferry-switch peer', focus, className)} {...props}>
      <SwitchPrimitive.Thumb className="ferry-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
export function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-4 shrink-0 rounded-control border border-primary  data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        focus,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="size-3.5" strokeWidth={1.75} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('grid gap-2', className)} {...props} />;
}
export function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'aspect-square size-4 rounded-full border border-primary text-primary ',
        focus,
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
        <span className="size-2 rounded-full bg-current" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export function Avatar({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'relative flex size-10 shrink-0 overflow-hidden rounded-full bg-muted',
        className,
      )}
      {...props}
    />
  );
}
export function AvatarImage({ className, ...props }: React.ComponentProps<'img'>) {
  return <img className={cn('aspect-square size-full object-cover', className)} {...props} />;
}
export function AvatarFallback({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'flex size-full items-center justify-center rounded-full bg-muted text-ui-label',
        className,
      )}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-control bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  );
}
export function Progress({
  className,
  value = 0,
  ...props
}: React.ComponentProps<'div'> & { value?: number }) {
  const safe = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={safe}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
      {...props}
    >
      <div
        className="h-full bg-primary transition-[width] duration-150 ease-out"
        style={{ width: `${String(safe)}%` }}
      />
    </div>
  );
}
export function Sonner(props: React.ComponentProps<typeof SonnerToaster>) {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      theme={resolvedTheme}
      className="ferry-ui toaster group"
      toastOptions={{
        classNames: {
          toast:
            'bg-card text-card-foreground border-border rounded-card shadow-[var(--shadow-popover)]',
          title: 'text-foreground',
          description: 'text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}

export function Collapsible(props: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root {...props} />;
}
export function CollapsibleTrigger({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn('inline-flex items-center gap-2 text-ui-body', focus, className)}
      {...props}
    />
  );
}
export function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return (
    <CollapsiblePrimitive.Content
      className={cn(
        'overflow-hidden text-ui-body data-[state=open]:animate-[ferry-ui-expand_150ms_ease-out_both] data-[state=closed]:animate-[ferry-ui-collapse_150ms_ease-in_both] motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-6 items-center rounded-control border border-border bg-muted px-1.5 font-mono text-ui-meta text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
