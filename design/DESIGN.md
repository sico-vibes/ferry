# Ferry — UI DNA (authoritative design spec)

> Every UI brief references sections of this file. **Numbers here win over your eyes; the reference images win over your taste.**
> References: `design/reference/home-left.png`, `design/reference/home-right.png` (two halves of one wide composition, each 736×920).
> Zoomed crops (2×): `design/reference/crops/*.png` — open the ones named in your brief with your image viewer.
> **The reference images are third-party work and are NOT in git** (`design/reference/` is gitignored). They exist only in the local checkout at `C:\dev\ferry\design\reference\`. Regenerate crops with `python scripts/crop_reference.py`.
> Not part of the app: the browser chrome (traffic lights, URL bar), the device bezel, the `@SIREN.UIX` watermark, and the resource list (lucide.dev, heroicons…) on the right of image 2.

---

## 1. Character — the DNA in words

1. **Neutral near-black app, navy-tinted side panels, layered depth.** The app background is a *neutral* dark gray; the left sidebar and right panel are *navy-tinted* rounded panels; the center canvas is a slightly *warm/purple-neutral* dark. Depth comes from hairline borders, a subtle top inner highlight, and faint radial glows — never heavy drop shadows, never pure `#000`.
2. **Monochrome UI + one signature gradient.** Everything is grayscale except (a) **electric blue** (functional accent) and (b) the **signature gradient** (blue → mauve → amber → mustard). The gradient appears **only** on: the active pinned item, the composer frame + banner band, the Send button, the hero headline text, the avatar. Its rarity is what makes it premium — do not add it anywhere else.
3. **Blue light leaks.** Thin glowing blue lines: the **right edge of the left sidebar**, the **left edge of the right panel**, **under the New Chat buttons**, and the separator between right-panel sections. 1px line + blurred halo.
4. **Pills everywhere.** Tabs, chips, buttons, the active item are fully rounded; panels 18–20px radius; cards 14px; rail tiles 14px.
5. **Quiet typography.** 11–13px UI text, medium weights, muted secondary; the only large type is the hero headline.
6. **Airy.** 16px panel padding, 4px grid / 8px rhythm, generous empty space in the canvas with a dotted grid + circuit illustration.

## 2. Tokens

All values live in `packages/ui/src/styles/tokens.css` as CSS variables and are exposed via a Tailwind v4 `@theme`. **Components never use raw color literals** (lint-enforced).

### 2.1 Surfaces (sampled from the reference, rounded)
| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#1C1D20` | window background (behind rail and between panels). Mica may show through when enabled; fallback solid |
| `--bg-rail-tile` | `#2B2C30` | inactive rail tiles |
| `--bg-rail-tile-active` | `#35363B` | active rail tile |
| `--bg-panel` | `#151821` | right panel base |
| `--bg-panel-grad` | `linear-gradient(180deg,#151A29 0%,#15181F 100%)` | left sidebar panel |
| `--bg-canvas` | `#141418` | center canvas |
| `--bg-card` | `#1D1D22` | pinned chat cards, provider cards |
| `--bg-raised` | `#2E2E33` | active tab, hovered cards |
| `--bg-input` | `#141418` | composer input area, search fields sit on `#1B1E27` |
| `--bg-pill-dark` | `#050B13` | New Chat button fill |
| `--bg-capacity` | `linear-gradient(135deg,#182A46 0%,#121B2E 100%)` | capacity card |

### 2.2 Lines & highlights
| Token | Value |
|---|---|
| `--border-hair` | `rgba(255,255,255,0.06)` |
| `--border-soft` | `rgba(255,255,255,0.09)` |
| `--border-strong` | `rgba(255,255,255,0.14)` |
| `--highlight-top` | `inset 0 1px 0 rgba(255,255,255,0.04)` |
| `--fade-line` | `linear-gradient(90deg,transparent,rgba(255,255,255,0.12),transparent)` |

### 2.3 Text
`--text-1: #EDEEF2` (primary) · `--text-2: #A3A6B0` (secondary) · `--text-3: #6E717C` (muted/meta) · `--text-link: #60A5FA` · `--text-on-gradient: #FFFFFF` · `--text-on-send: #0B0C0F`

### 2.4 Accents
| Token | Value | Use |
|---|---|---|
| `--blue-500` | `#3D84EC` | functional accent, active ring arc, links |
| `--blue-600` | `#3069AE` | rail New button fill |
| `--blue-mini` | `#5594C9` | mini "+" circles |
| `--blue-glow` | `rgba(61,132,236,0.55)` | glows/light leaks |
| `--star` | `#EFBC0B` | saved-topic stars |
| `--warn` | `#F5A524` | banner link, warnings |
| `--success` | `#22C55E` · `--danger` `#EF4444` | status |

### 2.5 Gradients (the only places color is allowed to be loud)
| Token | Value | Use |
|---|---|---|
| `--grad-signature` | `linear-gradient(90deg,#3D84EC 0%,#C97C8E 36%,#E08A4C 64%,#D9C12A 100%)` | active pinned item |
| `--grad-composer` | `linear-gradient(100deg,#8E8830 0%,#A99A55 14%,#B0674A 42%,#8F593D 55%,#655971 75%,#476192 90%,#3F608D 100%)` | composer frame + banner band |
| `--grad-headline` | `linear-gradient(90deg,#E9A23B 0%,#E6B24A 40%,#8FB2FF 70%,#3D84EC 100%)` | hero headline text (`background-clip:text`) |
| `--grad-send` | `linear-gradient(90deg,#CFB32B 0%,#8FB86A 45%,#4286EB 100%)` | Send button |
| `--grad-avatar` | `conic-gradient(from 200deg,#E8C547,#B68F66,#4286EB,#E8C547)` | avatar circle |

### 2.6 Radii, spacing, sizes
- Radii: `--r-window 12` · `--r-panel 18` · `--r-canvas 20` · `--r-card 14` · `--r-tile 14` · `--r-input 12` · `--r-item 12` · `--r-pill 999`
- Spacing: 4px base. Panel padding 16. Section gap 20. List item gap 4. Column gap 12. Outer padding 12.
- Control heights: pill tab 34 · New Chat 40 (sidebar) / 32 (right panel) · sidebar item 36 · chip 30 · composer action pill 28 · Send 30 · search 36 · list row 52.

### 2.7 Typography
- Font: **Inter Variable** (self-hosted `@fontsource-variable/inter`), `font-feature-settings: "cv11","ss01"`; `tabular-nums` for counters, %, times.
- Scale: meta `11/16 500` · label `12/16 500` · body `13/20 450` · title `15/22 600` · chat `14.5/24 400` · hero `30/38 600, letter-spacing -0.01em`.

### 2.8 Icons & motion
- Icons: **lucide-react**, stroke 1.75. Sizes: 18 rail · 16 lists/pills · 14 chips/small pills. Brand marks (GitHub, Supabase, Playwright…): **simple-icons** (CC0).
- Motion: hover/press 160ms ease-out; panels 220ms; gradient shimmer 6s linear infinite on the composer frame + active pill (disabled under `prefers-reduced-motion`); no motion on streaming text.
- Glow recipe: `box-shadow: 0 0 12px 1px var(--blue-glow)` on a 1px line.

### 2.9 Brand (Ferry logo — replaces any placeholder "F")
Assets (owned by the user, committed): `packages/ui/src/assets/brand/ferry-mark.png` (black mark on transparent, 512², used as a **CSS mask**), `packages/ui/src/assets/brand/ferry-icon.png` (colored app icon, 512²), `apps/desktop/build/icon.{ico,png}` (Windows app icon), `apps/desktop/src/renderer/public/favicon.png`. Sources: `design/brand/`.
Brand tokens (in `packages/ui/src/styles/brand.css`, sampled from the icon): `--brand-ink #090622` · `--brand-lilac #C8B5F5` · `--brand-violet #6552A3` · `--brand-glow rgba(200,181,245,0.45)` · `--grad-brand linear-gradient(135deg,#C8B5F5 0%,#8F7AE0 52%,#6552A3 100%)`.
Usage (`FerryMark` variants):
- `icon` — the colored app icon image. **Rail top logo** (28px).
- `brand` — mark masked with `--grad-brand`. **Hero white tile** (mark ~30px inside the 56px tile).
- `mono` — mark masked with `currentColor`. **Model picker glyph** (14px), **ModelBadge** (12px).
The brand violet is the logo's color only; it does not join the UI palette (the 5 gradient places in §1 are unchanged).

## 3. Layout (reference frame 1440×900, dark)

```
┌ Title bar 36 (drag; Windows controls via titleBarOverlay: color #1C1D20, symbols #A3A6B0) ────────────────────┐
│Rail 64│ Left column 272           │ Center (flex)                                             │ Right 300     │
│ logo  │┌ Sidebar panel (flex:1) ─┐│ Tabs row 44: [▢ New Chat][▢ ferry-web][+]   ⋯ [Configuration ⚙][Share ⤴] ◉ │
│ ● New ││ ◫ Chats           🔍     ││┌ Canvas (r20) ───────────────────────────────────┐│┌ panel ┐     │
│ ───   ││[ + New Chat ✦ ] underglow│││ ✦ Auto · GLM-5.3 ▾                 ⋯  🔗 [Share]│││◫ ⤴ ⋮ [New Chat ✦]│
│▣Chats ││ ─ fade ─                 │││        dotted grid + circuit + logo tile       │││🔍 Search chats… Ctrl F│
│▣Library││ Pinned Profiles       (+)│││  Build bigger with Ferry — every free          │││☆ Saved topics    ⋮ │
│▣Explore││[Best Available     ⋯]◄grad│  model, one seamless task.   (gradient text)   │││  title ★ / meta     │
│ ◌ +   ││  Auto-Free ⋯ / Fast ⋯    │││  sub text, 2 lines, centered                   │││ ── blue glow ──     │
│       ││  Long Context ⋯          │││ 📌 Pinned Chats ▾                   See all ›  │││💬 Recent Chats    ⋮ │
│       ││ ─ fade ─                 │││ [card][card][card]→                            │││  title 🗨 / meta ×6 │
│       ││ Integrations          (+)│││ chips → Explain repo · Fix tests · …           │││                     │
│       ││  GitHub ✓ Supabase ✓ Playwright│┌ Composer (gradient frame) ───────────────┐│││                     │
│ ☀     ││                          ││││ ⏱ banner text…            Add provider ↗ ││││                     │
│ ⎋     ││ ⚙ Settings               ││││ Ask Ferry to build, fix or explain…      ││││                     │
│       ││ 🎧 Help & Support         ││││ [🔗 Attach][💡 Best Available]  [🎙 Voice][Send]│││                  │
│       │└──────────────────────────┘││└──────────────────────────────────────────┘│││                     │
│       │┌ Capacity card 64 ────────┐││  disclaimer 10.5                           ││└─────────────────────┘│
│       ││≈ 420 steps left today (◔64%)│└────────────────────────────────────────────┘│                      │
└───────┴───────────────────────────┴───────────────────────────────────────────────┴──────────────────────┘
```
- Outer padding 12; column gap 12. Canvas and right panel start below the tabs row; the left column starts at the top (below the title bar).
- Responsive: < 1280px → right panel becomes an overlay drawer; < 1100px → sidebar collapses to rail-only; min window 1024×680. Must look right at 100/125/150% Windows scaling.

## 4. Component anatomy (each maps to a crop)

### 4.1 Rail — `crops/rail.png`
- Width 64, transparent over `--bg-app`, items centered.
- Top: **Ferry logo** 24px (original mark; never the Gemini sparkle).
- **New** button: 36px circle, `--blue-600`, white pencil 16px, `box-shadow: 0 0 18px var(--blue-glow)`.
- Hairline divider (32px wide, `--border-soft`).
- Nav tiles: 44×44, radius 14, `--bg-rail-tile`, border `--border-hair`; **active** = `--bg-rail-tile-active` + `--border-strong` + `--highlight-top`. Icon 18px `--text-2` (active `--text-1`). Label **under** the tile, 10.5px/500, active `--text-1`, inactive `--text-3`. Vertical gap 18.
- Order: **Chats** (message-square-dashed style icon), **Library** (folder/stack icon), **Explore** (compass/globe icon).
- **Add** button: 40px circle, 1px **dashed** `rgba(255,255,255,0.22)`, "+" 16px `--text-2`.
- Bottom: theme toggle 36px circle, bg `radial-gradient(circle, rgba(61,132,236,0.25), rgba(61,132,236,0.08))`, blue sun icon 16; below it a sign-out/settings icon 18px `--text-3`.

### 4.2 Sidebar panel — `crops/sidebar.png`, `crops/sidebar-top.png`
- `--bg-panel-grad`, radius 18, border `--border-hair`, padding 16.
- **Right-edge light leak:** absolutely positioned 1px vertical line on the right border from 30% to 92% height, `linear-gradient(180deg,transparent,var(--blue-500),transparent)` + glow.
- Header: 32px circle icon button (panel-left icon; bg `rgba(255,255,255,0.05)`), title "Chats" `15/22 600`, search icon button on the right.
- **New Chat button** (see 4.3), then fade separator.
- **Section header:** label `11/16 500 --text-3` ("Pinned Profiles", "Integrations") + right **mini add**: 16px circle `--blue-mini`, white "+" 10px.
- **Sidebar item:** h36, radius 12, padding 0 10, gap 10; icon 16 `--text-2`; label `13/20 450` `#D5D7DE`; trailing `⋯` (`--text-3`, opacity .7 → 1 on hover); hover bg `rgba(255,255,255,0.04)`.
- **Active item:** fill `--grad-signature`, icon/label/`⋯` white, radius 12 (pill-like), `--highlight-top`.
- Bottom links: Settings (gear), Help & Support (headset): same item style, no trailing menu.

### 4.3 New Chat button (sidebar h40 / right panel h32)
- Pill, fill `--bg-pill-dark`, border `--border-soft`, content: "+" 16 · "New Chat" `13/20 500 --text-1` · sparkles icon 14 (subtle multicolor tint allowed: blue→amber).
- **Underglow:** pseudo-element 70% width, 1px `--blue-500` line centered 1px under the bottom edge + `filter: blur(0.5px)` + glow shadow.

### 4.4 Integrations — `crops/integrations.png`
- Item = 28px circle tile (`rgba(255,255,255,0.06)`) holding a 16px **brand-colored** icon (simple-icons hex — brand marks are the one exception to the monochrome rule, as in the reference) + name `13/20 500` + **verified badge placed inline right after the name** (14px, filled blue `BadgeCheck`, 6px gap) when connected; disconnected items: name `--text-2`, icon at 60% opacity, no badge. Row height 40, gap 12.

### 4.5 Capacity card — `crops/capacity-card.png`
- Separate card under the sidebar panel (gap 10), h64, radius 14, `--bg-capacity`, border `rgba(61,132,236,0.28)`.
- Left: "≈ 420 steps left today" `13/20 600 --text-1`; below: "Add provider" `11/16 500 --text-link` + a 14px circle-arrow icon.
- Right: **RingGauge** 40px, stroke 4, track `rgba(255,255,255,0.10)`, arc `--blue-500` with glow, center "64%" `10px 600 tabular`.

### 4.6 Tabs row & top-right cluster — `crops/tabs-topbar.png`, `crops/topbar-right.png`
- Pill tabs h34, padding 0 14, icon 14 + label `13/20 500`; **active** `--bg-raised` + `--border-strong`; inactive transparent + `--border-hair`; close "×" on hover; "+" = 34px circle `--border-hair`.
- Right cluster: `⋯` icon button; **Configuration** pill (bg `#1E1F24`, `--border-soft`, label then gear icon); **Share** pill (same, border tinted `rgba(207,158,55,0.35)`, label then share icon); **avatar** 36px circle `--grad-avatar` with a crown icon 14 in `#1C1D20`.

### 4.7 Canvas — `crops/canvas-header.png`, `crops/hero.png`, `crops/canvas-right.png`
- Radius 20, `--bg-canvas`, border `--border-hair`, padding 20 24.
- **Ambient glows:** radial `rgba(176,103,74,0.14)` ~520px at top-left; radial `rgba(61,132,236,0.07)` ~600px at top-center-right.
- **Dotted grid:** `radial-gradient(rgba(255,255,255,0.09) 1px, transparent 1px)` 14px spacing, masked by a radial fade (≈ 420px) centered on the hero.
- Header: left = model picker (sparkle-like Ferry glyph 14 + "Auto · GLM-5.3" `13/20 500` + chevron-down 14); right = `⋯`, 32px circle link button, **Share** pill.

### 4.8 Hero
- 56px **white** tile (radius 16, `#F4F4F6`, shadow `0 8px 24px rgba(0,0,0,0.35)`) holding the Ferry mark (in brand gradient).
- **Circuit illustration** (inline SVG behind the tile): ~8 orthogonal thin traces (1px `rgba(255,255,255,0.20)`) branching left/right/up from the tile with rounded corners, ending in 5px hollow nodes; two accent nodes (blue `#3D84EC`, amber `#E9A23B`). Optional slow dash-flow animation (reduced-motion off).
- Headline: 2 lines, `30/38 600`, `--grad-headline` text fill, centered.
- Sub: `13/20 --text-2`, max-width 440, centered, 2 lines.

### 4.9 Pinned cards — `crops/pinned-cards.png`
- Section header: pin icon 14 + "Pinned Chats" + chevron (`12/16 500 --text-2`); "See all ›" right (`12/16 --text-3`).
- Card 200×104, radius 14, `--bg-card`, border `--border-hair`, padding 14. 28px icon tile (radius 8) color-coded by project language (TS `#3178C6`, Python `#E8B83A`, Go `#00ADD8`, Rust `#DE7B45`, generic green `#1E8E3E` / purple `#7C4DFF`) with a white 16px glyph; title `12.5/18 600 --text-1` (mt 12); snippet `11.5/16 --text-3` 1 line ellipsis; date `11/16 --text-3` (mt 8). Horizontal scroll, fade edges.

### 4.10 Chips — `crops/chips.png`
- h30 pills, transparent, border `rgba(255,255,255,0.12)`, icon 14 + `12.5/16 450 #D0D2D8`, gap 8; horizontal scroll with fade edges.

### 4.11 Composer — `crops/composer-left.png`, `crops/composer-right.png`
Construction (important): the composer is a **gradient-filled frame** (`--grad-composer`, radius 18). The **top band (h30) is the banner** — part of the gradient fill, not a separate strip. The **input area** is an inset dark panel (`--bg-input`, radius 14) sitting 3px inside the left/right/bottom edges and directly under the band. Result: a thick gradient band on top, ~3px gradient borders elsewhere. Slow shimmer on the gradient.
- Banner band: left timer icon 14 + text `12/16 500 rgba(255,255,255,0.90)`; right link `12/16 600` in `--warn` + arrow-up-right 14.
- Input area: padding 12 14; textarea autosize (min 44, max 240), placeholder `--text-3` "Ask Ferry to build, fix or explain…".
- Action row (bottom of input area): left **Attach** pill (h28, `--border-soft`, link/paperclip icon 14) and **profile chip** (h28, bg `rgba(61,132,236,0.15)`, text `--text-link`, lightbulb 14); right **Voice** pill (`--border-soft`, audio-lines 14; disabled in v1 with a tooltip) and **Send** (h30, `--grad-send`, text `--text-on-send` `12.5/16 600`, send icon 14). While a run is active Send becomes **Stop** (square icon).
- Disclaimer under the composer: `10.5/14 --text-3`, centered, with one underlined link.

### 4.12 Right panel — `crops/right-panel.png`
- Radius 18, `--bg-panel` with a faint vertical navy gradient, border `--border-hair`, padding 14.
- **Left-edge light leak** (mirror of 4.2).
- Header: panel-toggle, share, `⋮` icon buttons (left) + **New Chat ✦** (h32 variant with underglow) on the right.
- Search: h36, radius 12, bg `#1B1E27`, `--border-soft`, search icon 16, placeholder "Search chats…", **KbdChip** "Ctrl F" (bg `#2A2D36`, radius 6, 11px).
- Section headers: icon 14 + `12/16 500 --text-2` + `⋮` right. "Saved topics" (star outline), "Recent chats" (message-circle-plus style).
- Rows h52: title `13/18 500 #E4E5EA` ellipsis; meta `11/16 --text-3` ("Edited 2m ago", "Edited Oct 2, 2:05 PM"); trailing filled **star** 16 `--star` (saved) or outline message-circle 16 `--text-3` (recent).
- Between sections: a **blue-glow separator** (1px, `linear-gradient(90deg,transparent,var(--blue-500),transparent)` + glow).

### 4.13 States
Hover: +4% white overlay. Press: scale .98. Focus: 2px ring `--blue-500` @40% + 2px offset. Disabled: 40% opacity. Loading: skeleton shimmer. Empty: muted illustration + one-line CTA.

## 5. Copy deck (Ferry wording in the reference structure)
| Reference | Ferry |
|---|---|
| Pinned Models | **Pinned Profiles**: *Best Available* (active), *Auto-Free*, *Fast*, *Long Context* |
| Integrations: Figma ✓, Canva ✓, Superbase | **Integrations**: *GitHub* ✓, *Supabase* ✓, *Playwright* |
| "80 credits left today / Upgrade to" | **"≈ 420 steps left today" / "Add provider"**, ring 64% |
| "2.5 Flash ▾" | **"Auto · GLM-5.3 ▾"** |
| Tabs "New Chat", "Design System" | **"New Chat", "ferry-web"** |
| Headline | **"Build bigger with Ferry — every free / model, one seamless task."** |
| Sub | "Ferry routes each step to the model that still has room, and carries your task across when one runs dry." |
| Pinned Chats cards | "Auth refactor · ferry-web", "Fix flaky tests · api", "Add dark mode · dashboard" |
| Chips | Explain this repo · Fix failing tests · Write tests · Refactor · Review my changes · Plan a feature |
| "Free Trial ending soon continue your workflow" / "Upgrade Now" | **"Free capacity low — Gemini resets in 2h 13m"** / **"Add provider ↗"** |
| "Ask me anything…" | "Ask Ferry to build, fix or explain…" |
| Deep Think chip | current profile ("Best Available") |
| Right panel "Saved topic" / "Recent Chats" | **"Saved topics"** / **"Recent chats"** |
| Disclaimer | "Ferry uses AI models and can make mistakes. Review changes before committing. **Data use**" |

**Brand rule:** original Ferry logo + illustration only. No Google/Gemini names or sparkle, no `@SIREN.UIX` assets.

## 6. Fidelity checklist (used in every UI review)
- [ ] Column widths within ±4px at 1440×900 (rail 64, left 272, right 300, gaps 12).
- [ ] Surfaces: neutral app bg vs navy panels vs warm-neutral canvas — the three are visibly distinct.
- [ ] Gradients appear **only** in the 5 allowed places.
- [ ] Light leaks present: sidebar right edge, right panel left edge, under both New Chat buttons, right-panel section separator.
- [ ] Composer: thick gradient top band = banner; 3px gradient borders; inset dark input.
- [ ] Type sizes/weights per §2.7; secondary text muted, not white.
- [ ] Radii per §2.6; pills fully rounded.
- [ ] Icons lucide stroke 1.75 at the specified sizes.
- [ ] Hero: white logo tile, circuit traces with 2 accent nodes, gradient headline, dotted grid fade.
- [ ] No raw color literals in components (lint).
- [ ] 125% and 150% scaling screenshots have no clipping/overflow.

## 7. Extending the DNA (rules for every screen not in the reference)

The reference covers Home only. Everything else Ferry grows into must look like it was always part of it. Follow these patterns; if a new need doesn't fit, extend this section first, then build.

### 7.1 Page pattern
Canvas → **page header** (title `15/22 600` + subtitle `13 text-2` + one primary action pill on the right; optional pill sub-nav under it) → **section cards** (`--bg-card`, hairline, radius 14, padding 16, section title `12/16 500 text-2`). Settings-style pages add a 240px left nav inside the canvas. Explore, Library, Settings, Onboarding all use this.

### 7.2 Status semantics (fixed meanings, everywhere: UI + CLI)
| Meaning | Color | Examples |
|---|---|---|
| Done / healthy | `--success` | tool ✓, provider ok, gate passed |
| Active / info / primary | `--blue-500` | running, selected, links, focus |
| Needs attention / warning | `--warn` | awaiting approval, low capacity, ≥80% quota |
| Failed / destructive | `--danger` | tool ✗, key invalid, delete |
| Learned / estimated data | `--brand-lilac` (dot only) | confidence "learned" |
| Neutral / idle | `--text-3` | disabled, unknown |

### 7.3 Data display
Numbers use `tabular-nums`; changing counts animate (`CountUp`); compact formats (1.2K, 820K, $3.40). Quotas are always **bar + used/limit + reset countdown + confidence dot** (`QuotaWindowBar`). Times: relative under 7 days ("2m ago"), absolute after ("Oct 2, 2:05 PM").

### 7.4 Emphasis budget
The five gradient places (§1.2) never grow. New emphasis comes from, in order: blue accent → glow line (§2.8 recipe) → motion (subtle, reduced-motion aware) → size/weight. Brand violet stays on the logo (§2.9).

### 7.5 Density & scale
Two densities: **comfortable** (default, reference spacing) and **compact** (row heights −25%, panel padding 12, chat 13.5/22) for long agent runs. Long transcripts **group** consecutive tool calls into one collapsible summary row ("Explored 14 files · edited 3 · ran tests ✓") — expanded on demand, auto-expanded on failure or approval.

### 7.6 Structural patterns (added as features require them)
- **Tab status dots:** running (blue pulse), awaiting approval (amber), done (none), failed (red); approvals from background tabs raise a badge on the tab + an approvals tray.
- **Repo context pill:** every session shows `repo · branch` (GitBranch icon, 12px) in the canvas header next to the model picker.
- **Resizable right panel** (300–560px, drag handle = hairline that glows blue on hover) and a **bottom panel** (terminal, logs; 200–480px) toggled with Ctrl+`.
- **Full-canvas review mode** for diffs and delegation results (Monaco diff inside the canvas, file list on the left, Accept/Reject/Rework bar on top).
- **Contextual left sidebar:** its content follows the rail — Chats (profiles + integrations), Library (workspace tree), Explore (provider list); the right panel stays per-session (Chats · Plan · Changes).
- **Compact Home:** after the first sessions exist, Home leads with the composer + "Continue" cards; the full hero shows on first run and empty states (setting to keep it).

### 7.7 Accessibility floor
Body/meta text on any surface must reach 4.5:1 (AA). `--text-3` may be lifted slightly to meet it on `--bg-canvas`; decorative text (disclaimers) keeps ≥ 4.5:1 too. Every icon-only control has an `aria-label`; focus ring per §4.13.

### 7.8 CLI translation
The CLI reuses the palette via truecolor: blue accent, §7.2 status colors, muted gray for secondary; the signature gradient appears only in the startup banner; the capacity ring becomes `≈ 420 steps ▰▰▰▰▰▰▱▱▱ 64%`.
