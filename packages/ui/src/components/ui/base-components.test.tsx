// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import axe from 'axe-core';
import * as UI from './index';

afterEach(cleanup);

const cases = [
  ['Button', <UI.Button>Continue</UI.Button>],
  ['Badge', <UI.Badge>Status</UI.Badge>],
  [
    'Card',
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle>Project</UI.CardTitle>
        <UI.CardDescription>Current workspace</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>main</UI.CardContent>
    </UI.Card>,
  ],
  [
    'Dialog',
    <UI.Dialog>
      <UI.DialogTrigger asChild>
        <UI.Button>Open dialog</UI.Button>
      </UI.DialogTrigger>
      <UI.DialogContent>
        <UI.DialogTitle>Details</UI.DialogTitle>
        <UI.DialogDescription>Session information</UI.DialogDescription>
      </UI.DialogContent>
    </UI.Dialog>,
  ],
  [
    'Sheet',
    <UI.Sheet>
      <UI.SheetTrigger asChild>
        <UI.Button>Open drawer</UI.Button>
      </UI.SheetTrigger>
      <UI.SheetContent>
        <UI.SheetTitle>Details</UI.SheetTitle>
      </UI.SheetContent>
    </UI.Sheet>,
  ],
  [
    'DropdownMenu',
    <UI.DropdownMenu>
      <UI.DropdownMenuTrigger asChild>
        <UI.Button>Menu</UI.Button>
      </UI.DropdownMenuTrigger>
      <UI.DropdownMenuContent>
        <UI.DropdownMenuItem>Rename</UI.DropdownMenuItem>
      </UI.DropdownMenuContent>
    </UI.DropdownMenu>,
  ],
  [
    'ContextMenu',
    <UI.ContextMenu>
      <UI.ContextMenuTrigger>Session row</UI.ContextMenuTrigger>
      <UI.ContextMenuContent>
        <UI.ContextMenuItem>Rename</UI.ContextMenuItem>
      </UI.ContextMenuContent>
    </UI.ContextMenu>,
  ],
  [
    'Tabs',
    <UI.Tabs defaultValue="tab">
      <UI.TabsList aria-label="Sections">
        <UI.TabsTrigger value="tab">Overview</UI.TabsTrigger>
      </UI.TabsList>
      <UI.TabsContent value="tab">Details</UI.TabsContent>
    </UI.Tabs>,
  ],
  [
    'Tooltip',
    <UI.TooltipProvider>
      <UI.Tooltip>
        <UI.TooltipTrigger asChild>
          <UI.Button>Info</UI.Button>
        </UI.TooltipTrigger>
        <UI.TooltipContent>More information</UI.TooltipContent>
      </UI.Tooltip>
    </UI.TooltipProvider>,
  ],
  [
    'Command',
    <UI.Command>
      <UI.CommandInput aria-label="Search" />
      <UI.CommandList>
        <UI.CommandEmpty>No results</UI.CommandEmpty>
        <UI.CommandItem>Open project</UI.CommandItem>
      </UI.CommandList>
    </UI.Command>,
  ],
  [
    'ScrollArea',
    <UI.ScrollArea className="h-20">
      <p>Scrollable content</p>
    </UI.ScrollArea>,
  ],
  [
    'Separator',
    <>
      <span>First</span>
      <UI.Separator />
      <span>Second</span>
    </>,
  ],
  [
    'Sidebar',
    <UI.Sidebar aria-label="Workspace navigation">
      <UI.SidebarHeader>Workspace</UI.SidebarHeader>
      <UI.SidebarContent>
        <UI.SidebarMenu>
          <UI.SidebarMenuItem>
            <UI.SidebarMenuButton>Library</UI.SidebarMenuButton>
          </UI.SidebarMenuItem>
        </UI.SidebarMenu>
      </UI.SidebarContent>
    </UI.Sidebar>,
  ],
  [
    'Table',
    <UI.Table>
      <UI.TableCaption>Projects</UI.TableCaption>
      <UI.TableHeader>
        <UI.TableRow>
          <UI.TableHead scope="col">Name</UI.TableHead>
        </UI.TableRow>
      </UI.TableHeader>
      <UI.TableBody>
        <UI.TableRow>
          <UI.TableCell>Ferry</UI.TableCell>
        </UI.TableRow>
      </UI.TableBody>
    </UI.Table>,
  ],
  [
    'Input',
    <label>
      Project name
      <UI.Input aria-label="Project name" />
    </label>,
  ],
  [
    'Textarea',
    <label>
      Instructions
      <UI.Textarea aria-label="Instructions" />
    </label>,
  ],
  [
    'Select',
    <UI.Select defaultValue="auto">
      <UI.SelectTrigger aria-label="Model">
        <UI.SelectValue />
      </UI.SelectTrigger>
      <UI.SelectContent>
        <UI.SelectItem value="auto">Auto</UI.SelectItem>
      </UI.SelectContent>
    </UI.Select>,
  ],
  [
    'Switch',
    <label>
      Notifications
      <UI.Switch aria-label="Notifications" />
    </label>,
  ],
  [
    'Checkbox',
    <label>
      <UI.Checkbox aria-label="Remember setting" />
      Remember setting
    </label>,
  ],
  [
    'RadioGroup',
    <fieldset>
      <legend>Theme</legend>
      <UI.RadioGroup aria-label="Theme" defaultValue="system">
        <label>
          <UI.RadioGroupItem value="system" />
          System
        </label>
      </UI.RadioGroup>
    </fieldset>,
  ],
  [
    'Avatar',
    <UI.Avatar>
      <UI.AvatarFallback>JM</UI.AvatarFallback>
    </UI.Avatar>,
  ],
  ['Skeleton', <UI.Skeleton aria-hidden="true" className="h-4 w-20" />],
  ['Progress', <UI.Progress value={50} aria-label="Upload progress" />],
  ['Sonner', <UI.Sonner />],
  [
    'Collapsible',
    <UI.Collapsible>
      <UI.CollapsibleTrigger>More details</UI.CollapsibleTrigger>
      <UI.CollapsibleContent>Details</UI.CollapsibleContent>
    </UI.Collapsible>,
  ],
  [
    'Kbd',
    <span>
      Press <UI.Kbd>Ctrl K</UI.Kbd>
    </span>,
  ],
] as const;

describe.each(cases)('%s base component', (name, node) => {
  it('renders and has no axe violations', async () => {
    for (const theme of ['dark', 'light']) {
      const { container } = render(<div className={'ferry-ui ' + theme}>{node}</div>);
      expect(container.firstChild).not.toBeNull();
      const results = await axe.run(container);
      expect(
        results.violations.map(({ id }) => id),
        name + ' in ' + theme,
      ).toEqual([]);
      cleanup();
    }
  });
});
