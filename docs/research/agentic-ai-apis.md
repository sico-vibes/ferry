# R-agentic-apis — `github.com/cporter202/agentic-ai-apis` evaluated for Ferry

**Research date: 2026-09-28.** Desk review: read the repo's README, category pages, generation
scripts and GitHub Actions workflow; verified all metadata through the GitHub REST API; verified
"free"/pricing claims against the primary source (Apify's own pricing page and Store API). No API
keys were used. Every non-obvious claim is cited to a URL/path; marketing-only claims are marked
**claimed**; things I could not confirm are **unknown**. This file is docs-only — no `src/` change,
no commit.

Ferry context read first: `docs/research/free-providers.md`, `docs/research/community-free-llm.md`,
`docs/research/routers-2.md` §"Data sources", `packages/catalog/data/limits/*.yaml`,
`packages/catalog/data/vendor/SOURCES.md`, `packages/extensions/src/mcp.ts`,
`packages/agent/src/tool-registry.ts`, `packages/client/src/mock/fixtures/integrations.ts`.

---

## 10-line plain-English summary

1. This repo is **not a list of AI/LLM APIs and not an SDK or agent framework**. It is an
   auto-generated directory of **Apify Store "Actors"** — hosted web-scraping/automation jobs —
   filtered into three headings: Agents, AI Models, MCP Servers.
2. Every one of its **2,896 rows links to `apify.com/...?fpr=p2hrc6`**, an Apify affiliate link;
   the "AI Models" heading is just Apify actors whose store category tag is `AI` (it includes
   Cars.com, SofaScore and job scrapers).
3. There is **no LLM model API provider in it at all** — no Groq, Cerebras, SambaNova, OpenRouter
   (as a provider), etc. The only LLM-adjacent items are paid Apify actors that *proxy or scrape*
   model services.
4. It has **no LICENSE file** (GitHub reports `license: null`), so it grants no reuse rights; the
   data is **Markdown tables only** (the source JSON is `.gitignore`d), so it is not machine-readable.
5. It is kept current by a **daily GitHub Action** that pulls `api.apify.com/v2/store` and commits
   only when the catalog changes (`settings/fetch_apify_actors.js`, `.github/workflows/daily-sync.yml`).
6. Activity is bot-driven and shallow: 210 commits, **172 by `github-actions[bot]`, 38 by the owner**,
   628 stars, 165 forks, 11 watchers, 2 open issues both titled "API" (2026-09-28).
7. Everything in the repo is **paid pay-per-event / pay-per-usage** on Apify; the only "free" is
   Apify's own **$5/month** free-plan credit that **does not roll over** and blocks until reset.
8. A handful of entries are genuinely *useful tool ideas for a coding agent* (RAG web browser,
   website→Markdown, Playwright MCP, Brave Search MCP, code sandbox), but each is an Apify actor
   with per-result pricing, not a free first-party tool.
9. **Delta vs Ferry is essentially zero for providers/models**: Ferry's catalog already covers every
   legitimate free provider the repo's genre could offer, and the repo adds none.
10. Verdict: **ignore as a data source; optionally mine 3–5 entries as ideas for Ferry's MCP/tool
    presets; avoid its OpenRouter relay and all ChatGPT/Gemini-web scrapers** (ToS + supply-chain risk).

---

## 1. What the repo is

| Question | Answer | Source |
|---|---|---|
| Kind | Directory / index of **Apify Store Actors** (hosted scraping & automation jobs), auto-generated into Markdown tables | `settings/generate_readme_clean.js`; category READMEs |
| Is it a list? SDK? framework? MCP registry? | A list/directory only. No SDK, no client code, no agent framework. The "MCP Servers" heading is Apify actors that expose an MCP endpoint. | repo tree; `README.md` |
| License | **None.** GitHub API returns `"license": null`; there is no `LICENSE` file in the tree. Default copyright → **no reuse rights granted**. | GitHub API `<https://api.github.com/repos/cporter202/agentic-ai-apis>`; tree |
| Size | 18,284 KB (~18 MB) of generated Markdown (three tables: 811 + 1,574 + 511 rows). `ai-models-apis/README.md` alone is 475 KB. | GitHub API `size`; tree blob sizes |
| Created / activity | Created **2026-04-06**; 210 commits; latest `chore: sync daily Apify catalog` on **2026-09-28**. 172 commits by `github-actions[bot]`, 38 by `cporter202`. | GitHub API commits/contributors |
| Popularity | 628 stars, 165 forks, 11 watchers, 2 open issues (both titled "API"), 0 releases/tags. Not archived. | GitHub API |
| Maintenance quality | Automated and "alive" but **not editorial**: no license, no CI other than the sync bot, no per-entry verification, no machine-readable output. README's own GitHub description still says "2,036" while the README says "2,896" — a stale metadata signal. `FOLLOW_CREATOR.md` asks users to follow the owner on Facebook. | `README.md`; `FOLLOW_CREATOR.md`; GitHub API `description` |
| Monetization | Every row is an affiliate link: `...?fpr=p2hrc6` (FirstPromoter id) appended in `fetch_apify_actors.js`; the README's own "Maintenance Notes" state "API links keep the existing affiliate tracking from the upstream source data." Apify's affiliate programme pays up to 30%. | `settings/fetch_apify_actors.js`; `README.md`; `<https://apify.com/partners/affiliate>` |

**How it is built (verified from source):** `fetch_apify_actors.js` pages through
`https://api.apify.com/v2/store?limit=100&offset=...`, keeps `{name, title, description, url,
affiliate_url, categories, stats, createdAt, modifiedAt}`, and writes a gitignored
`apify_actors.json`. `generate_readme_clean.js` maps Apify categories `AGENTS`→"Agents",
`AI`→"AI Models", `MCP_SERVERS`→"MCP Servers", filters obvious test actors, truncates descriptions
to 200 chars, and emits one Markdown table per category. The daily workflow runs the two scripts
and commits if anything changed. The declared "Last Updated" date is the newest upstream actor
`modifiedAt`, not the repo's own review date.

**What it is *not*:** there is no curated evaluation, no free/paid/dead status, no data-use label,
no rate-limit data, no license, and no API. It is a raw Apify-category projection.

---

## 2. Content relevant to Ferry

### 2.1 First finding: there are no LLM API providers here

I searched all three category pages for first-party model providers. The hits for "OpenAI",
"Claude", "Gemini", "DeepSeek", "Qwen", "Perplexity", "Hugging Face" etc. are **not** provider API
listings — they are Apify actors that *scrape or wrap* those services. There is **no entry for Groq,
Cerebras, SambaNova, Together, Fireworks, NVIDIA NIM, Cloudflare Workers AI, Mistral, LLM7, Kilo,
or OpenRouter-as-a-provider**. So the repo cannot contribute a single provider to Ferry's catalog.

The only LLM-adjacent entries (all paid Apify actors) are:

| Entry | What it actually is | Status / price (verified) | Ferry relevance |
|---|---|---|---|
| [`apify/openrouter`](https://apify.com/apify/openrouter) | "Use any AI LLM model without accounts … as a proxy for all requests" — a **relay** that calls model providers on Apify's account | PAY_PER_EVENT, from **$0.005 per credit unit**; 2.31M runs (Store API) | **Avoid**: a paid middleman in the request path; same class as the relay/supply-chain risk in `community-free-llm.md` §4.5 |
| `fayoussef/bulk-llm-runner` | "Run ChatGPT, Claude, Gemini & DeepSeek in Bulk (No API Key)" — **web/API wrapper** for ≥350 models | Apify pay-per-event; **unknown** exact price | **Avoid**: wraps vendor surfaces outside their API terms; ToS risk |
| `apify/chatgpt-search-scraper`, `apify/gemini-search-scraper`, `apify/google-ai-mode-scraper`, `apify/perplexity-search-scraper`, and many "AI Brand Visibility" actors | Scrape ChatGPT/Gemini/Perplexity/Claude web answers | Apify pay-per-event | **Avoid / irrelevant**: web-session scraping Ferry already rejects |

### 2.2 The tool/MCP entries that are actually interesting (as *ideas*)

All are Apify actors, billed **per event / per result**, priced on the primary source (Apify Store
API). "Free" in a title means "runnable within Apify's $5/month free-plan credit" or "free at a tiny
sample size" — not a recurring free API.

| Entry | Capability | Verified pricing | Note |
|---|---|---|---|
| [`apify/rag-web-browser`](https://apify.com/apify/rag-web-browser) | Google search + fetch top-N pages → clean Markdown for agents/RAG | PAY_PER_EVENT (per fetched page / search query); 8.47M runs, 182K users | Strong web-search/fetch primitive; Apify's own, well-run |
| [`apify/website-content-crawler`](https://apify.com/apify/website-content-crawler) | Crawl a site → Markdown/text for LLMs/RAG; LangChain/LlamaIndex output | PAY_PER_USAGE (platform CU) | Docs/corpus ingestion pattern |
| [`apify/web-fetch`](https://apify.com/apify/web-fetch) / [`apify/url-to-markdown`](https://apify.com/apify/url-to-markdown) | URL → Markdown/plain text | PAY_PER_USAGE | Single-page fetch tool |
| [`apify/ai-code-sandbox`](https://apify.com/apify/ai-code-sandbox) | Secure Python/Node code-execution sandbox; web shell, REST **and MCP** | pricingInfos **null** on Store API → **unknown** (likely pay-per-usage) | Code-exec pattern; also see `automation-lab/ai-code-runner-sandbox` |
| [`clearpath/brave-search-mcp`](https://apify.com/clearpath/brave-search-mcp) | Brave Search exposed as 4 MCP tools (web/image/video/answers) | PAY_PER_EVENT (actor-start + per result) | MCP preset idea; verify first-party Brave API instead |
| [`nexgendata/playwright-mcp-server`](https://apify.com/nexgendata/playwright-mcp-server) | Playwright automation (17 tools) over MCP | PAY_PER_EVENT (start + per dataset item) | Browser-automation MCP idea; Ferry already plans Playwright mock preset |
| [`themineworks/academic-research-mcp`](https://apify.com/themineworks/academic-research-mcp) / [`nexgendata/academic-research-mcp-server`](https://apify.com/nexgendata/academic-research-mcp-server) | OpenAlex/Crossref/arXiv/PubMed search as MCP tools | PAY_PER_EVENT | Docs/research fetch pattern |
| [`mrbridge/latest-news-mcp-server`](https://apify.com/mrbridge/latest-news-mcp-server) | "free news API for AI" — 14 MCP tools over 27 public APIs | PAY_PER_EVENT, **$0.008 per tool-read** (title says "free"; it is not) | Good example of a **misleading "free" claim** |
| [`parsebird/agent-skills-scraper`](https://apify.com/parsebird/agent-skills-scraper) | Scrapes `skills.sh` agent-skill metadata | PAY_PER_EVENT | Curiosity only |
| `apify/ai-web-agent`, `louvre/apify-prompt-pilot`, `shelvick/stealth-browser-agent` | Natural-language browser automation | PAY_PER_EVENT | Ferry uses its own browser tooling |

Everything else (the bulk of 2,896 rows) is commercial scraping unrelated to a coding agent: Amazon,
LinkedIn, TikTok, SEC filings, real-estate, job boards, lead-gen, etc.

---

## 3. Delta vs Ferry

### 3.1 Providers/models the repo lists that Ferry lacks — genuinely free/recurring + coding-useful

**None.** The repo contains no LLM provider entries at all (§2.1), so there is nothing to add to
`packages/catalog/data/limits/`. Ferry's current catalog already covers the whole space the repo
touches only parasitically:

- Ferry already has: `anthropic, anyapi, cerebras, cloudflare-workers-ai, deepinfra, deepseek,
  fireworks, gemini, groq, huggingface, hyperbolic, kilo, llm7, mistral, nebius, novita, nvidia,
  openai, opencode, opencode-go, openrouter, ovhcloud, sambanova, scaleway, stepfun, together,
  tokenrouter, vercel-ai-gateway, zai-glm` plus `dead-*` tombstones.
- The repo adds no free tier, no new model, and no limit figure that Ferry does not already track
  (and `free-providers.md` traces each such figure to a first-party page — the repo does not).

### 3.2 Things Ferry already has (so the repo is redundant here)

- **MCP client + stdio/HTTP transports**: `packages/extensions/src/mcp.ts` already implements
  `McpServerConfigSchema` (stdio and http) and a reconnect-capable client. The repo's "MCP Servers"
  heading is just a list of paid Apify MCP actors — no config format, no transport code.
- **Playwright / GitHub / Supabase MCP presets**: already present as mock fixtures in
  `packages/client/src/mock/fixtures/integrations.ts`.
- **Web fetch / workspace tools / sandbox stubs**: `packages/workspace` + `packages/agent` own the
  tool registry; the repo contributes no tool code.

### 3.3 Entries to avoid, and why

| Entry / class | Why avoid for Ferry |
|---|---|
| `apify/openrouter` relay | Third-party paid proxy in the request path — exactly the "malicious intermediary / supply-chain" risk documented in `community-free-llm.md` §4.5; also no BYOK, so it is not offline/desktop-friendly. |
| `bulk-llm-runner`, all "ChatGPT/Gemini/Perplexity/Claude Search Scraper" and "AI Brand Visibility" actors | Web-session scraping of vendor UIs, against vendor ToS — the `free-providers.md` §"Relays, scrapers" and `routers-2.md` §13 (`g4f`) classification. |
| The 2,800+ commercial scrapers | Irrelevant to a coding agent; many require residential proxies and per-result spend. |
| Whole repo as a catalog source | No license (see §4), all-affiliate links, Markdown-only. |

---

## 4. Is it usable as a data source?

| Criterion | Verdict | Evidence |
|---|---|---|
| Machine-readable? | **No.** Only generated Markdown tables are committed; the raw `apify_actors.json` that would be parseable is gitignored (`.gitignore`) and never committed. | `.gitignore`; `fetch_apify_actors.js` |
| Update cadence | **Daily** (workflow cron `17 10 * * *`, `America/New_York`; commits only on change). Fresh, but upstream is only the Apify marketplace. | `.github/workflows/daily-sync.yml` |
| License allows reuse? | **No.** No `LICENSE` file; GitHub `license: null`. With no license, all rights reserved — Ferry may **not** copy the tables into the repo. | GitHub API; repo tree |
| Coverage relevant to Ferry | **None for providers/limits**; partial and paid-only for tools/MCP. | §2 |
| Integrity | Affiliate-monetized links (`fpr=p2hrc6`), category-tag precision is poor (Cars/SofaScore/jobs under "AI Models"), no per-entry status/verification, and `agentic-ai-apis` description vs README count mismatch. | `fetch_apify_actors.js`; category pages; GitHub API |

**Conclusion:** not usable as a data source for Ferry's `@ferry/catalog` or limits tables, and not a
credible MCP directory. If Ferry ever wants Apify data, the correct primary source is the **Apify
Store API** (`api.apify.com/v2/store`) or Apify's **official MCP server** (`https://mcp.apify.com/`),
not this unlicensed mirror. This is consistent with `routers-2.md` §"Data sources", which already
prefers MIT/Apache-2.0, machine-readable datasets (models.dev, Helicone, LiteLLM, OpenRouter
`/models`).

---

## 5. Anything else worth borrowing

Not the data — but three *patterns* and one optional integration are worth noting:

1. **Agent-native discovery via a single `AGENTS.md`.** Apify publishes machine instructions for
   autonomous agents at `https://apify.com/agents.md` and `https://agi.apify.com/AGENTS.md`, and
   supports **agentic payments** (x402 / MPP) so an agent can buy an Actor run with no human account
   (`https://apify.com/pricing`, "Can an AI agent pay…"). This is a good model for how Ferry could
   advertise its own tool/MCP surface to other agents (Ferry already ships `AGENTS.md`).
2. **A "dynamic MCP server" pattern.** Apify's official MCP server (`https://mcp.apify.com/`,
   `docs.apify.com/platform/integrations/mcp`) lets a client discover and call Actors as tools
   dynamically. If Ferry ships an MCP *preset* list, an analogous "one server, many tools, discovered
   at connect time" entry is a useful shape to design for.
3. **The tool categories worth having as first-party presets** (verify against the real vendor, not
   Apify): web search + fetch-to-Markdown (RAG Web Browser / Firecrawl pattern), single-URL
   →Markdown, browser automation (Playwright MCP), docs/scholar fetch (arXiv/OpenAlex/PubMed), and a
   bounded code-execution sandbox. Ferry has no bundled MCP-server *preset catalog* today — only the
   mock fixtures — so this is the one place the repo's inventory is a useful ideation list.
4. **Optional, user-added, disabled-by-default:** Apify's official MCP server as a preset a user can
   enable with their own Apify token. Do **not** bundle or auto-enable it, and do not use the
   affiliate links.

---

## What Ferry should do with this (ranked)

1. **Do not use `agentic-ai-apis` as a catalog/limits data source.** No license, Markdown-only, no
   provider entries, affiliate links. Record the decision (this doc) and move on.
2. **Add nothing to `packages/catalog/data/limits/` from it.** It lists no free LLM provider Ferry
   lacks; Ferry's existing catalog is already broader and first-party-verified.
3. **Mine it only as an ideation list for an MCP/tool preset catalog** (web search+fetch, URL→Markdown,
   Playwright, docs/scholar, code sandbox). Before shipping any preset, verify limits/pricing/ToS on
   the **actual vendor's** page, and prefer official registries (`modelcontextprotocol` registry,
   `mcp.apify.com`) over Apify actors.
4. **If Apify is wanted at all, offer the official Apify MCP server (`mcp.apify.com`) as an
   optional, disabled, user-token preset** — never the affiliate mirror, never the OpenRouter relay.
5. **Ignore everything else**: the ~2,800 commercial scrapers, all "AI Brand Visibility" /
   ChatGPT-Gemini-Claude scrapers, and `fayoussef/bulk-llm-runner` (avoid: scraping/relay + ToS risk).
6. **Keep defending the catalog's license discipline.** This repo is a concrete example of what
   Ferry's `routers-2.md` §"Data sources" warns against: a popular (628★) but unlicensed,
   machine-unreadable, affiliate-monetized mirror. Cite it as the negative case.

---

## Sources

- Repo: <https://github.com/cporter202/agentic-ai-apis> · `README.md` · `agents-apis/README.md` ·
  `ai-models-apis/README.md` · `mcp-servers-apis/README.md` · `settings/fetch_apify_actors.js` ·
  `settings/generate_readme_clean.js` · `.github/workflows/daily-sync.yml` · `.gitignore` ·
  `FOLLOW_CREATOR.md` (tree and blobs read via `raw.githubusercontent.com`).
- Repo metadata: GitHub REST API `repos/cporter202/agentic-ai-apis`, `.../commits`,
  `.../contributors`, `.../issues`, `.../git/trees/main?recursive=1` (read 2026-09-28).
- Affiliate/monetization: <https://apify.com/partners/affiliate> (`fpr=p2hrc6` is a FirstPromoter
  affiliate id appended by the fetch script).
- Apify platform pricing / free plan / agentic payments: <https://apify.com/pricing>
  (Free plan = $5 usage/month, non-carryover; agents via x402/MPP at `agi.apify.com`).
- Apify Store API (used to verify actor pricing/stats): `https://api.apify.com/v2/acts/{actor}`
  for `apify/rag-web-browser`, `apify/ai-code-sandbox`, `apify/openrouter`,
  `clearpath/brave-search-mcp`, `mrbridge/latest-news-mcp-server`,
  `nexgendata/playwright-mcp-server`.
- Apify official MCP server: <https://mcp.apify.com/> · <https://docs.apify.com/platform/integrations/mcp>.
- Ferry prior art: `docs/research/free-providers.md` · `docs/research/community-free-llm.md` §4.5 ·
  `docs/research/routers-2.md` §13 and §"Data sources" · `packages/extensions/src/mcp.ts` ·
  `packages/client/src/mock/fixtures/integrations.ts`.
