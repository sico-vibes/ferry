# Ferry UI v2 — design spec (authoritative for the UI remake)

Status: approved direction 2026-10-01. Supersedes `design/archive/DESIGN-v1.md` for every screen rebuilt in the remake
(the former spec is archived at `design/archive/DESIGN-v1.md`).

Reference: the user's "Voxa AI" chat screenshot — a quiet two-column dark app: left sidebar
(brand, New chat, Library, Discover, chat history, upgrade card, user row), one centred conversation
column, a soft rounded composer with a send button, and a few quick-action chips under the composer.

User decisions (2026-10-01): accent = **Ferry violet** (from the logo), session extras live in an
**on-demand right drawer**, typeface **Geist**, **dark and light themes built together**.

## 1. Character

Simple, calm, informative. The conversation is the product; everything else stays out of the way
until asked for. One accent colour, used only for the primary action and the current selection.
Information comes from content (numbers, names, states), not decoration: no glows, gradients,
glass, or ornamental borders. The Ferry logo is the only place brand colour is allowed to be loud.

Rules that apply to every screen:

1. **One primary action per view.** It is the only filled-violet button on screen.
2. **No duplicate controls.** Each action has exactly one home on a screen (e.g. New chat lives
   only in the sidebar; the model/profile switch lives only in the composer; Settings lives only
   in the user menu and the command palette). The palette is the universal second path.
3. **Symmetry and alignment.** Every element sits on the 4 px grid; left edges inside a column
   align; the composer and the transcript share one width and one centre line; equal gutters on
   both sides of the centre column.
4. **Hierarchy by size, weight and spacing first,** colour last. Borders separate regions, not items.
5. **Sentence case everywhere.** No all-caps labels, no eyebrow labels above headings, no "→" in
   buttons, no middle-dot meta strings. Monospace only for code, paths, and terminal output.
6. **Empty and error states give the next action** in one sentence plus one button.

## 2. Tokens (CSS variables, shadcn/ui naming, both themes)

Implemented as CSS variables in `@ferry/ui` with the shadcn/ui names so components work unchanged.
Text must pass AA at 4.5:1 in both themes. Inputs and focus indicators need 3:1 boundaries;
surface tones may be differentiated by color and spacing without a boundary contrast ratio.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--background` | `#0F0E14` | `#FAFAFC` | app canvas |
| `--sidebar` | `#131219` | `#F4F3F8` | sidebar |
| `--card` | `#17161D` | `#FFFFFF` | composer, cards, menus |
| `--muted` | `#1E1D25` | `#EFEEF4` | hover, chips, inputs |
| `--border` | `rgba(255,255,255,.06)` | `rgba(23,21,30,.07)` | hairlines only (row separators inside a group, card edge where tone alone is not enough) |
| `--input` | `rgba(255,255,255,.12)` | `rgba(23,21,30,.14)` | form fields (text inputs, selects, checkboxes) — must stay identifiable (WCAG 1.4.11) |
| `--foreground` | `#EDECF2` | `#17151E` | primary text |
| `--muted-foreground` | `#A19EAE` | `#5E5A6B` | secondary text |
| `--primary` | `#6D5BD0` | `#5B47B8` | primary button, active item, focus |
| `--primary-foreground` | `#FFFFFF` | `#FFFFFF` | text on primary |
| `--accent` (soft) | `rgba(143,122,224,.14)` | `rgba(101,82,163,.10)` | selected row, badge bg |
| `--accent-foreground` | `#C8B5F5` | `#4A3A99` | badge text, active icon |
| `--ring` | `#8F7AE0` | `#6552A3` | focus ring (2 px, offset 2) |
| `--destructive` | `#E5484D` | `#CE2C31` | destructive only |
| `--success` / `--warning` | `#3DD68C` / `#F5A524` | `#1A7F4B` / `#A35A00` | status dots/text only |

Regions and elements use surface tone and spacing instead of solid outlines: no divider between
sidebar and content, no rule under the chat header, and no rules between sections (use 24–32 px
spacing). Cards, composer, tool groups, approval and delegation cards, menus, popovers, capacity
card, and drawer sit on `--card` with at most a `--border` hairline. Rows use spacing or a hairline.
Chips use `--muted` fill without a stroke; quick-start chips may keep a hairline. Drawer separation
uses tone and the soft shadow without a stroke. Strong outlines are reserved for the focus ring
(2 px with 2 px offset) and form inputs (`--input`).

Brand (unchanged, logo only): `#C8B5F5`, `#8F7AE0`, `#6552A3`, ink `#090622`.

**Type — Geist Sans** (self-hosted via the `geist` package, OFL) and **Geist Mono** for code.
Scale (size/line-height/weight): 12/16/450 meta · 13/20/450 secondary · 14/22/450 body ·
14/20/550 labels & buttons · 16/24/600 section titles · 20/28/600 page titles · 28/36/650 home greeting.
Letter-spacing: −0.01em at ≥20 px, 0 otherwise. Tabular numbers for counts, quotas, prices.

**Spacing** (4 px base): 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48 · 64. **Radius by hierarchy:**
6 (inputs inside cards, kbd), 10 (buttons, chips, list rows), 14 (cards, composer, menus, dialogs),
full (badges, avatar, send button). **Separation (seamless, user decision 2026-10-02):** regions and elements are separated by **surface tone and spacing, not solid outlines**. No divider line between sidebar and content (sidebar tone `--sidebar` vs `--background` does it), no rule under the header, no rule between sections (use 24–32 px spacing). Cards, composer, tool groups and menus sit on `--card` (one step lighter than the canvas) with at most a `--border` hairline; never a full-strength stroke. Rows inside a group: spacing or a `--border` hairline. Strong outlines are reserved for the focus ring (`--ring`) and form inputs (`--input`). **Elevation:** one soft shadow for floating
layers (menus, dialogs, drawer) — `0 8px 24px rgba(0,0,0,.28)` dark / `0 8px 24px rgba(23,21,30,.10)` light.
**Icons:** lucide, 16 px in rows/buttons, 18 px in nav, stroke 1.75. **Motion:** 150 ms ease-out for
hover/press/expand, 200 ms for drawer/dialog; honour reduced motion; no ambient animation.

## 3. Layout

Window minimum 1024×680; reference frame 1440×900.

```
+--------------------+-----------------------------------------------+-----------------+
| [logo] Ferry   [<] | Fix the failing test   (Auto-Free)  Share [▤] ⋯|  Drawer (400px) |
|                    |-----------------------------------------------|  Plan Changes   |
| [+] New chat       |                                               |  Terminal       |
|  ▢  Library        |              transcript (max 768)             |  (on demand,    |
|  ◎  Models         |                                               |   overlays or   |
|                    |                                               |   pushes ≥1280) |
| Chats              |                                               |                 |
|  Fix failing test  |                                               |                 |
|  Explain the router|                                               |                 |
|  …                 |   +---------------------------------------+   |                 |
|                    |   | ✦ Ask Ferry to build, fix or explain… |   |                 |
| +----------------+ |   | [📎] [Auto-Free ▾] [repo ▾]       (➤) |   |                 |
| | 420 steps left | |   +---------------------------------------+   |                 |
| | ▬▬▬▬▬▬▭▭  64%  | |    Ferry can make mistakes. Check changes.    |                 |
| | Add provider   | |                                               |                 |
| +----------------+ |                                               |                 |
| (◉) Jordan      ⌄ |                                               |                 |
+--------------------+-----------------------------------------------+-----------------+
```

- **Sidebar 260 px** (collapsible to a 64 px icon rail; collapsed state remembered). Inner padding 12;
  nav rows 36 px; section gap 24. Order: brand row → primary nav (New chat, Library, Models) →
  Chats (pinned first, then recent; 6 shown + "Show more") → spacer → capacity card → user row.
- **Main column:** header 56 px (title, profile badge, Share, drawer toggle, ⋯); content centred,
  max 768 px, side gutters ≥ 32 px; composer pinned to the bottom with 24 px bottom margin and the
  same width/centre as the transcript; one-line disclaimer under it (muted, 12 px).
- **Drawer 400 px** on the right, opened only by the header toggle (or palette/shortcut); tabs Plan,
  Changes, Terminal; pushes content at ≥1280 px wide, overlays below that.
- **Pages** (Library, Models, Settings) use the same main column but max 1040 px, with a 56 px
  page header (title left, the page's single primary action right).

## 4. Screens

| Screen | Route | Content | Primary action |
|---|---|---|---|
| Home / new chat | `/` | Greeting with Ferry mark (28/36), composer centred vertically, 4 quick-start chips under it (Fix a failing test · Explain this repo · Write tests · Plan a feature — each with one tinted icon), workspace chosen in the composer | Send |
| Session | `/s/:id` | Transcript with the agent timeline (thinking collapsed, tool lanes, handoff markers, approval cards, delegation cards), composer | Send (Stop while running) |
| Review | `/s/:id/review/:run` | Full-width diff: file list left (240), diff right, gates summary, decision bar | Accept |
| Library | `/library` | Projects list (name, path, branch, last activity) → project detail: sessions, instructions, permissions | Open folder |
| Models | `/models` (was Explore) | Tabs **Providers** (cards in a 2–3 column grid, status + quota bar + one "Manage" per card), **Models** (paged table: search, filters, sort), **Usage** (today ring + 14-day chart + resets) | Add provider |
| Settings | `/settings` | Left section list (General, Profiles, Providers & keys, Routing, Optimizers, Delegation, Permissions, Gateway, Data & privacy, Shortcuts, About), right form; save per section | Save changes (per section, only when dirty) |
| Onboarding | `/onboarding` | Centred 560 px card, 3 steps: Welcome → Add a free provider → Open a folder | Continue |
| Command palette | global ⌘/Ctrl K | Commands, projects, chats; `>` for commands only | — |
| Approvals | inline + header indicator | Inline cards in the transcript; a single counter in the header when approvals are pending elsewhere | Allow once |
| States | everywhere | Empty, loading (skeletons, no spinners in lists), error, offline banner, interrupted session (Resume), paid confirmation, paid cap reached | the one fix |

Removed vs today: the icon rail + separate sidebar (merged into one sidebar), the always-on right
panel (now the drawer), the tabs row (chats are in the sidebar; multiple open chats via the palette
and back/forward), duplicate New chat / Settings / search buttons, decorative glows and gradients,
the hero illustration.

## 5. Components (shadcn/ui in `@ferry/ui`)

Base: shadcn/ui (Radix + Tailwind v4, MIT) generated into `packages/ui/src/components/ui/`, themed only
through the tokens above: Button (primary, secondary, ghost, outline, destructive; sizes sm 32 / md 36 /
icon 32), Badge, Card, Dialog, Sheet (drawer), DropdownMenu, ContextMenu, Tabs, Tooltip, Command (cmdk),
ScrollArea, Separator, Sidebar, Table, Input, Textarea, Select, Switch, Checkbox, RadioGroup, Avatar,
Skeleton, Progress, Sonner (toasts), Collapsible, Kbd.
Ferry composites built from those: AppSidebar, ChatHeader, Composer, Transcript + AgentTimeline,
ThinkingBlock, ToolCallRow/Group, HandoffMarker, ApprovalCard, DelegationCard, CapacityCard,
ProviderCard, ModelsTable, UsageChart (recharts, themed), DiffView (Monaco, themed), TerminalView
(xterm, themed), EmptyState, OfflineBanner.

## 6. Review checklist (every screen, both themes, 1440/1280/1024 and 125 % scaling)

- One filled-violet button; no action appears twice on the screen.
- All left edges in a column align; composer and transcript share width and centre; gutters equal.
- Spacing values only from the scale; radii only from the hierarchy; no new colours.
- Text contrast AA; focus ring visible on every interactive element; keyboard reaches everything.
- No all-caps labels, eyebrows, decorative gradients/glows, "→" in buttons, or mono outside code.
- Empty, loading, error states present and actionable.

## 7. Application shell rules

- Use one 44 px title bar across the full window, above the sidebar and page content. The full
  strip is draggable. Interactive controls use `-webkit-app-region: no-drag`; every remaining
  pixel stays available for dragging. Keep the background continuous with the active app theme.
- Put the sidebar toggle, back and forward navigation, current project and chat context, page
  actions, and window controls in that title bar. Do not repeat the sidebar toggle or chat title
  in a second header. Reserve the native Electron title bar overlay area and update its surface
  and symbol colors when the resolved theme changes. Web preview uses matching simulated chrome.
- In the collapsed sidebar rail, tooltips open with no delay or entrance animation, use the active
  theme's popover and popover-foreground tokens, and open to the right. Never use the native
  `title` attribute for rail labels.
- The user menu opens upward, aligns to its trigger, and is at least as wide as the trigger. Show
  an account label, then consistently aligned icon and label rows, right-aligned shortcuts, and
  separators between groups. Put System, Light, and Dark in a Theme submenu and mark the active
  choice with a check.
- Never use browser-native prompts, alerts, or confirmation boxes, or Electron message boxes for
  in-app actions. Use the shared themed AlertDialog with a title, one-line description, Cancel,
  and a primary or destructive action.
- Use lucide icons for interface actions. Do not use sparkle or star icons, or emoji as icons.
