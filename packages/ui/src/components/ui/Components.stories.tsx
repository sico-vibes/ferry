import '../../styles/index.css';
import * as UI from './index';
import type { ReactNode } from 'react';

function ThemeGallery({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid gap-5 bg-background p-6 text-foreground md:grid-cols-2">
      {(['dark', 'light'] as const).map((theme) => (
        <section
          className={`ferry-ui ${theme} min-h-36 rounded-card border border-border bg-background p-5`}
          key={theme}
        >
          <h2 className="mb-4 text-ui-meta text-muted-foreground">
            {title} · {theme}
          </h2>
          {children}
        </section>
      ))}
    </main>
  );
}

export const Button = () => (
  <ThemeGallery title="Button">
    <div className="flex flex-wrap items-center gap-2">
      <UI.Button>Primary</UI.Button>
      <UI.Button variant="secondary">Secondary</UI.Button>
      <UI.Button variant="ghost">Ghost</UI.Button>
      <UI.Button variant="outline">Outline</UI.Button>
      <UI.Button variant="destructive">Delete</UI.Button>
      <UI.Button size="sm">Small</UI.Button>
      <UI.Button size="icon" aria-label="More">
        <span aria-hidden="true">⋯</span>
      </UI.Button>
    </div>
  </ThemeGallery>
);
export const Badge = () => (
  <ThemeGallery title="Badge">
    <div className="flex flex-wrap items-center gap-2">
      <UI.Badge>Default</UI.Badge>
      <UI.Badge variant="secondary">Secondary</UI.Badge>
      <UI.Badge variant="outline">Outline</UI.Badge>
      <UI.Badge variant="destructive">Destructive</UI.Badge>
      <UI.Badge variant="success">Success</UI.Badge>
      <UI.Badge variant="warning">Warning</UI.Badge>
    </div>
  </ThemeGallery>
);
export const Card = () => (
  <ThemeGallery title="Card">
    <UI.Card className="max-w-sm">
      <UI.CardHeader>
        <UI.CardTitle>Usage</UI.CardTitle>
        <UI.CardDescription>Current cycle</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>420 steps remaining</UI.CardContent>
      <UI.CardFooter>
        <UI.Button size="sm">Manage</UI.Button>
      </UI.CardFooter>
    </UI.Card>
  </ThemeGallery>
);
export const Dialog = () => (
  <ThemeGallery title="Dialog">
    <UI.Dialog>
      <UI.DialogTrigger asChild>
        <UI.Button variant="outline">Open dialog</UI.Button>
      </UI.DialogTrigger>
      <UI.DialogContent>
        <UI.DialogHeader>
          <UI.DialogTitle>Save changes?</UI.DialogTitle>
          <UI.DialogDescription>Your settings are ready to save.</UI.DialogDescription>
        </UI.DialogHeader>
        <UI.Button>Continue</UI.Button>
      </UI.DialogContent>
    </UI.Dialog>
  </ThemeGallery>
);
export const Sheet = () => (
  <ThemeGallery title="Sheet">
    <UI.Sheet>
      <UI.SheetTrigger asChild>
        <UI.Button variant="outline">Open drawer</UI.Button>
      </UI.SheetTrigger>
      <UI.SheetContent>
        <UI.SheetHeader>
          <UI.SheetTitle>Plan</UI.SheetTitle>
          <UI.SheetDescription>Review your next steps.</UI.SheetDescription>
        </UI.SheetHeader>
      </UI.SheetContent>
    </UI.Sheet>
  </ThemeGallery>
);
export const DropdownMenu = () => (
  <ThemeGallery title="Dropdown menu">
    <UI.DropdownMenu>
      <UI.DropdownMenuTrigger asChild>
        <UI.Button variant="outline">Options</UI.Button>
      </UI.DropdownMenuTrigger>
      <UI.DropdownMenuContent>
        <UI.DropdownMenuLabel>Session</UI.DropdownMenuLabel>
        <UI.DropdownMenuItem>Rename</UI.DropdownMenuItem>
        <UI.DropdownMenuSeparator />
        <UI.DropdownMenuItem>Archive</UI.DropdownMenuItem>
      </UI.DropdownMenuContent>
    </UI.DropdownMenu>
  </ThemeGallery>
);
export const ContextMenu = () => (
  <ThemeGallery title="Context menu">
    <UI.ContextMenu>
      <UI.ContextMenuTrigger asChild>
        <button className="rounded-button border border-border p-3 text-ui-body">
          Right click this row
        </button>
      </UI.ContextMenuTrigger>
      <UI.ContextMenuContent>
        <UI.ContextMenuLabel>Session</UI.ContextMenuLabel>
        <UI.ContextMenuItem>Rename</UI.ContextMenuItem>
        <UI.ContextMenuSeparator />
        <UI.ContextMenuItem>Archive</UI.ContextMenuItem>
      </UI.ContextMenuContent>
    </UI.ContextMenu>
  </ThemeGallery>
);
export const Tabs = () => (
  <ThemeGallery title="Tabs">
    <UI.Tabs defaultValue="one">
      <UI.TabsList>
        <UI.TabsTrigger value="one">Overview</UI.TabsTrigger>
        <UI.TabsTrigger value="two">Activity</UI.TabsTrigger>
        <UI.TabsTrigger value="three">Settings</UI.TabsTrigger>
      </UI.TabsList>
      <UI.TabsContent value="one">Overview content</UI.TabsContent>
      <UI.TabsContent value="two">Activity content</UI.TabsContent>
      <UI.TabsContent value="three">Settings content</UI.TabsContent>
    </UI.Tabs>
  </ThemeGallery>
);
export const Tooltip = () => (
  <ThemeGallery title="Tooltip">
    <UI.TooltipProvider>
      <UI.Tooltip>
        <UI.TooltipTrigger asChild>
          <UI.Button variant="outline">Hover or focus</UI.Button>
        </UI.TooltipTrigger>
        <UI.TooltipContent>Additional details</UI.TooltipContent>
      </UI.Tooltip>
    </UI.TooltipProvider>
  </ThemeGallery>
);
export const Command = () => (
  <ThemeGallery title="Command">
    <UI.Command className="max-w-md rounded-card border border-border bg-card">
      <UI.CommandInput placeholder="Search commands" aria-label="Search commands" />
      <UI.CommandList>
        <UI.CommandEmpty>No results.</UI.CommandEmpty>
        <UI.CommandGroup heading="Suggestions">
          <UI.CommandItem>New chat</UI.CommandItem>
          <UI.CommandItem>Open settings</UI.CommandItem>
        </UI.CommandGroup>
      </UI.CommandList>
    </UI.Command>
  </ThemeGallery>
);
export const ScrollArea = () => (
  <ThemeGallery title="Scroll area">
    <UI.ScrollArea className="h-32 w-64 rounded-control border border-border p-3">
      <p>Recent sessions</p>
      <p>Fix the failing test</p>
      <p>Explain the router</p>
      <p>Review provider setup</p>
      <p>Plan a feature</p>
    </UI.ScrollArea>
  </ThemeGallery>
);
export const Separator = () => (
  <ThemeGallery title="Separator">
    <div className="max-w-sm space-y-3">
      <p>Workspace</p>
      <UI.Separator />
      <p>Current project</p>
      <UI.Separator orientation="vertical" className="inline-block h-8 align-middle" />
    </div>
  </ThemeGallery>
);
export const Sidebar = () => (
  <ThemeGallery title="Sidebar">
    <UI.Sidebar className="min-h-52 rounded-card border border-sidebar-border">
      <UI.SidebarHeader>Ferry</UI.SidebarHeader>
      <UI.SidebarContent>
        <UI.SidebarGroup>
          <UI.SidebarGroupLabel>Workspace</UI.SidebarGroupLabel>
          <UI.SidebarMenu>
            <UI.SidebarMenuItem>
              <UI.SidebarMenuButton isActive>New chat</UI.SidebarMenuButton>
            </UI.SidebarMenuItem>
            <UI.SidebarMenuItem>
              <UI.SidebarMenuButton>Library</UI.SidebarMenuButton>
            </UI.SidebarMenuItem>
          </UI.SidebarMenu>
        </UI.SidebarGroup>
      </UI.SidebarContent>
      <UI.SidebarFooter>Jordan</UI.SidebarFooter>
    </UI.Sidebar>
  </ThemeGallery>
);
export const Table = () => (
  <ThemeGallery title="Table">
    <UI.Table>
      <UI.TableCaption>Recent sessions</UI.TableCaption>
      <UI.TableHeader>
        <UI.TableRow>
          <UI.TableHead>Session</UI.TableHead>
          <UI.TableHead>Status</UI.TableHead>
        </UI.TableRow>
      </UI.TableHeader>
      <UI.TableBody>
        <UI.TableRow>
          <UI.TableCell>Fix the failing test</UI.TableCell>
          <UI.TableCell>
            <UI.Badge variant="success">Ready</UI.Badge>
          </UI.TableCell>
        </UI.TableRow>
      </UI.TableBody>
    </UI.Table>
  </ThemeGallery>
);
export const Input = () => (
  <ThemeGallery title="Input">
    <label className="grid max-w-sm gap-2 text-ui-label">
      Project name
      <UI.Input placeholder="my-project" />
    </label>
  </ThemeGallery>
);
export const Textarea = () => (
  <ThemeGallery title="Textarea">
    <label className="grid max-w-sm gap-2 text-ui-label">
      Instructions
      <UI.Textarea placeholder="Describe what Ferry should do" />
    </label>
  </ThemeGallery>
);
export const Select = () => (
  <ThemeGallery title="Select">
    <UI.Select defaultValue="auto">
      <UI.SelectTrigger aria-label="Model">
        <UI.SelectValue placeholder="Choose a model" />
      </UI.SelectTrigger>
      <UI.SelectContent>
        <UI.SelectItem value="auto">Auto</UI.SelectItem>
        <UI.SelectItem value="fast">Fast</UI.SelectItem>
      </UI.SelectContent>
    </UI.Select>
  </ThemeGallery>
);
export const Switch = () => (
  <ThemeGallery title="Switch">
    <label className="flex items-center gap-3 text-ui-body">
      Use system theme
      <UI.Switch aria-label="Use system theme" defaultChecked />
    </label>
  </ThemeGallery>
);
export const Checkbox = () => (
  <ThemeGallery title="Checkbox">
    <label className="flex items-center gap-2 text-ui-body">
      <UI.Checkbox aria-label="Remember choice" defaultChecked />
      Remember this choice
    </label>
  </ThemeGallery>
);
export const RadioGroup = () => (
  <ThemeGallery title="Radio group">
    <UI.RadioGroup defaultValue="system">
      <label className="flex items-center gap-2">
        <UI.RadioGroupItem value="system" id="r-system" />
        System
      </label>
      <label className="flex items-center gap-2">
        <UI.RadioGroupItem value="dark" id="r-dark" />
        Dark
      </label>
      <label className="flex items-center gap-2">
        <UI.RadioGroupItem value="light" id="r-light" />
        Light
      </label>
    </UI.RadioGroup>
  </ThemeGallery>
);
export const Avatar = () => (
  <ThemeGallery title="Avatar">
    <UI.Avatar>
      <UI.AvatarImage src="/avatar.png" alt="Jordan Miles" />
      <UI.AvatarFallback>JM</UI.AvatarFallback>
    </UI.Avatar>
  </ThemeGallery>
);
export const Skeleton = () => (
  <ThemeGallery title="Skeleton">
    <div className="flex items-center gap-3">
      <UI.Skeleton className="size-10 rounded-full" />
      <div className="grid gap-2">
        <UI.Skeleton className="h-4 w-40" />
        <UI.Skeleton className="h-3 w-28" />
      </div>
    </div>
  </ThemeGallery>
);
export const Progress = () => (
  <ThemeGallery title="Progress">
    <div className="grid max-w-sm gap-2">
      <label>
        Provider quota <span className="tabular-nums">64%</span>
      </label>
      <UI.Progress value={64} aria-label="Provider quota" />
    </div>
  </ThemeGallery>
);
export const Sonner = () => (
  <ThemeGallery title="Sonner">
    <div className="flex items-center gap-3">
      <UI.Button
        onClick={() => {
          void import('sonner').then(({ toast }) => {
            toast.success('Changes saved');
          });
        }}
      >
        Show toast
      </UI.Button>
      <UI.Sonner position="top-right" />
    </div>
  </ThemeGallery>
);
export const Collapsible = () => (
  <ThemeGallery title="Collapsible">
    <UI.Collapsible defaultOpen>
      <UI.CollapsibleTrigger>Session details</UI.CollapsibleTrigger>
      <UI.CollapsibleContent className="pt-2 text-muted-foreground">
        Branch: main
      </UI.CollapsibleContent>
    </UI.Collapsible>
  </ThemeGallery>
);
export const Kbd = () => (
  <ThemeGallery title="Kbd">
    <div className="flex items-center gap-2">
      Open command palette <UI.Kbd>Ctrl</UI.Kbd>
      <span>+</span>
      <UI.Kbd>K</UI.Kbd>
    </div>
  </ThemeGallery>
);
