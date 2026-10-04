# Free routing impact

Generated from `packages/catalog/data/models.snapshot.json` and provider plans in `packages/catalog/data/limits/*.yaml`.
Before reproduces `main` Auto-Free eligibility with default trial opt-ins (none). After assumes the user selected the provider free-tier billing setting and applies the sourced `free_plan` coverage, $0, OpenRouter, trial, and paid/credits policies in this worktree. Snapshot providers without a catalog limits entry are counted as non-routable.

| Provider | Snapshot models | Free before | Free after |
|---|---:|---:|---:|
| 302ai | 117 | 0 | 0 |
| abacus | 108 | 0 | 0 |
| abliteration-ai | 3 | 0 | 0 |
| above | 9 | 0 | 0 |
| agentrouter | 5 | 0 | 0 |
| agnes | 3 | 0 | 0 |
| ai-router | 5 | 0 | 0 |
| ai21 | 2 | 0 | 0 |
| aiand | 11 | 0 | 0 |
| aihubmix | 106 | 0 | 0 |
| ainetcafe | 1 | 0 | 0 |
| aixy | 1 | 0 | 0 |
| aki-io | 7 | 0 | 0 |
| alibaba | 56 | 0 | 0 |
| alibaba-cn | 90 | 0 | 0 |
| alibaba-coding-plan | 12 | 0 | 0 |
| alibaba-coding-plan-cn | 12 | 0 | 0 |
| alibaba-token-plan | 28 | 0 | 0 |
| alibaba-token-plan-cn | 28 | 0 | 0 |
| amazon-bedrock | 179 | 0 | 0 |
| ambient | 10 | 0 | 0 |
| amd | 6 | 0 | 0 |
| anthropic | 15 | 0 | 0 |
| anyapi | 30 | 30 | 30 |
| arcee | 7 | 0 | 0 |
| atomic-chat | 5 | 0 | 0 |
| auriko | 15 | 0 | 0 |
| azure | 92 | 0 | 0 |
| azure-cognitive-services | 75 | 0 | 0 |
| bailing | 2 | 0 | 0 |
| baseten | 23 | 0 | 0 |
| berget | 6 | 0 | 0 |
| blueclaw | 2 | 0 | 0 |
| bothub | 8 | 0 | 0 |
| cerebras | 2 | 0 | 0 |
| chutes | 14 | 0 | 0 |
| clarifai | 12 | 0 | 0 |
| claudinio | 2 | 0 | 0 |
| cline-pass | 18 | 0 | 0 |
| cloudferro-sherlock | 5 | 0 | 0 |
| cloudflare-ai-gateway | 50 | 0 | 0 |
| cloudflare-workers-ai | 27 | 27 | 20 |
| cohere | 14 | 0 | 0 |
| coralbricks | 4 | 0 | 0 |
| cortecs | 109 | 0 | 0 |
| crof | 24 | 0 | 0 |
| crossmodel | 66 | 0 | 0 |
| crusoe | 11 | 0 | 0 |
| daoxe | 9 | 0 | 0 |
| databricks | 30 | 0 | 0 |
| deepinfra | 70 | 0 | 0 |
| deepseek | 4 | 0 | 0 |
| digitalocean | 100 | 0 | 0 |
| dinference | 6 | 0 | 0 |
| drun | 3 | 0 | 0 |
| ebcloud | 4 | 0 | 0 |
| echo | 1 | 0 | 0 |
| edenai | 285 | 0 | 0 |
| empiriolabs | 66 | 0 | 0 |
| evroc | 16 | 0 | 0 |
| fastrouter | 47 | 0 | 0 |
| fireworks-ai | 34 | 0 | 0 |
| freemodel | 10 | 0 | 0 |
| friendli | 7 | 0 | 0 |
| frogbot | 26 | 0 | 0 |
| gemini | 39 | 39 | 19 |
| github-copilot | 32 | 0 | 0 |
| gitlab | 28 | 0 | 0 |
| gmicloud | 15 | 0 | 0 |
| google-vertex | 53 | 0 | 0 |
| google-vertex-anthropic | 15 | 0 | 0 |
| greenpt | 40 | 0 | 0 |
| groq | 16 | 16 | 11 |
| helicone | 90 | 0 | 0 |
| hetzner | 2 | 0 | 0 |
| hpc-ai | 9 | 0 | 0 |
| huggingface | 78 | 0 | 0 |
| hyper | 23 | 0 | 0 |
| iflowcn | 14 | 0 | 0 |
| impossibl | 76 | 0 | 0 |
| inception | 3 | 0 | 0 |
| inceptron | 4 | 0 | 0 |
| inco | 7 | 0 | 0 |
| infer | 2 | 0 | 0 |
| inference | 9 | 0 | 0 |
| inferx | 12 | 0 | 0 |
| infomaniak | 10 | 0 | 0 |
| io-net | 17 | 0 | 0 |
| iteracompute | 9 | 0 | 0 |
| jalapeno | 17 | 0 | 0 |
| jiekou | 61 | 0 | 0 |
| kenari | 60 | 0 | 0 |
| kilo | 392 | 26 | 26 |
| kimi-code-plan-cn | 4 | 0 | 0 |
| kimi-code-plan-global | 4 | 0 | 0 |
| klokintegration | 3 | 0 | 0 |
| kosmik | 1 | 0 | 0 |
| kuae-cloud-coding-plan | 1 | 0 | 0 |
| lilac | 4 | 0 | 0 |
| llama | 7 | 0 | 0 |
| llmgateway | 205 | 0 | 0 |
| llmgateway-providers | 428 | 0 | 0 |
| llmtech | 1 | 0 | 0 |
| llmtr | 32 | 0 | 0 |
| lmstudio | 3 | 0 | 0 |
| longcat | 1 | 0 | 0 |
| lucidquery | 4 | 0 | 0 |
| lynkr | 1 | 0 | 0 |
| meganova | 19 | 0 | 0 |
| melious | 15 | 0 | 0 |
| merge-gateway | 191 | 0 | 0 |
| meta | 5 | 0 | 0 |
| minimax | 7 | 0 | 0 |
| minimax-cn | 7 | 0 | 0 |
| minimax-cn-coding-plan | 7 | 0 | 0 |
| minimax-coding-plan | 7 | 0 | 0 |
| mistral | 35 | 3 | 35 |
| mixlayer | 5 | 0 | 0 |
| moark | 2 | 0 | 0 |
| modal | 4 | 0 | 0 |
| model-oracle-ai | 15 | 0 | 0 |
| modelis | 9 | 0 | 0 |
| modelscope | 7 | 0 | 0 |
| moonshotai | 4 | 0 | 0 |
| moonshotai-cn | 4 | 0 | 0 |
| morph | 3 | 0 | 0 |
| nan | 7 | 0 | 0 |
| nano-gpt | 592 | 0 | 0 |
| nearai | 32 | 0 | 0 |
| nebius | 20 | 0 | 0 |
| neon | 46 | 0 | 0 |
| neosmith | 4 | 0 | 0 |
| neuralwatt | 29 | 0 | 0 |
| nova | 2 | 0 | 0 |
| novita-ai | 107 | 0 | 0 |
| nvidia | 105 | 105 | 104 |
| oci | 9 | 0 | 0 |
| ofox | 148 | 0 | 0 |
| ollama-cloud | 24 | 0 | 0 |
| openai | 50 | 0 | 0 |
| opencode | 110 | 0 | 0 |
| opencode-go | 41 | 2 | 2 |
| openreason | 3 | 0 | 0 |
| openrouter | 385 | 20 | 24 |
| opper | 57 | 0 | 0 |
| orcarouter | 117 | 0 | 0 |
| ovhcloud | 14 | 14 | 14 |
| pendra | 6 | 0 | 0 |
| perplexity | 4 | 0 | 0 |
| perplexity-agent | 22 | 0 | 0 |
| pioneer | 114 | 0 | 0 |
| poe | 137 | 0 | 0 |
| poolside | 3 | 0 | 0 |
| privatemode-ai | 11 | 0 | 0 |
| qihang-ai | 9 | 0 | 0 |
| qiniu-ai | 91 | 0 | 0 |
| qvac | 9 | 0 | 0 |
| regolo-ai | 18 | 0 | 0 |
| requesty | 159 | 0 | 0 |
| routing-run | 15 | 0 | 0 |
| runinfra | 7 | 0 | 0 |
| sakana | 4 | 0 | 0 |
| salad-cloud | 1 | 0 | 0 |
| sap-ai-core | 49 | 0 | 0 |
| sarvam | 2 | 0 | 0 |
| scaleway | 15 | 0 | 0 |
| scnet-token-plan | 19 | 0 | 0 |
| scx-ai | 4 | 0 | 0 |
| sensenova | 5 | 0 | 0 |
| siliconflow | 57 | 0 | 0 |
| siliconflow-cn | 44 | 0 | 0 |
| snowflake-cortex | 25 | 0 | 0 |
| stackit | 8 | 0 | 0 |
| standardcompute | 1 | 0 | 0 |
| stepfun | 9 | 0 | 0 |
| stepfun-ai | 9 | 0 | 0 |
| stepfun-ai-step-plan | 4 | 0 | 0 |
| stepfun-step-plan | 5 | 0 | 0 |
| subconscious | 2 | 0 | 0 |
| submodel | 9 | 0 | 0 |
| synthetic | 10 | 0 | 0 |
| tempr | 39 | 0 | 0 |
| tencent-coding-plan | 8 | 0 | 0 |
| tencent-token-plan | 2 | 0 | 0 |
| tencent-tokenhub | 3 | 0 | 0 |
| tensorx | 25 | 0 | 0 |
| the-grid-ai | 9 | 0 | 0 |
| thinkingmachines | 2 | 0 | 0 |
| tinfoil | 9 | 0 | 0 |
| togetherai | 39 | 0 | 0 |
| tokengo | 13 | 0 | 0 |
| tokenrouter | 1 | 1 | 1 |
| trustedrouter | 7 | 0 | 0 |
| umans-ai | 6 | 0 | 0 |
| umans-ai-coding-plan | 7 | 0 | 0 |
| unorouter | 23 | 0 | 0 |
| upstage | 4 | 0 | 0 |
| v0 | 3 | 0 | 0 |
| vancine | 8 | 0 | 0 |
| venice | 111 | 0 | 0 |
| vercel | 388 | 0 | 0 |
| vispark | 3 | 0 | 0 |
| vivgrid | 34 | 0 | 0 |
| volcengine | 16 | 0 | 0 |
| volcengine-coding-plan | 10 | 0 | 0 |
| vultr | 10 | 0 | 0 |
| wafer.ai | 5 | 0 | 0 |
| wallaby | 1 | 0 | 0 |
| wandb | 29 | 0 | 0 |
| watsonx | 5 | 0 | 0 |
| xai | 12 | 0 | 0 |
| xiaomi | 9 | 0 | 0 |
| xiaomi-token-plan-ams | 9 | 0 | 0 |
| xiaomi-token-plan-cn | 9 | 0 | 0 |
| xiaomi-token-plan-sgp | 9 | 0 | 0 |
| xpersona | 13 | 0 | 0 |
| zai | 18 | 0 | 0 |
| zai-coding-plan | 7 | 0 | 0 |
| zeldoc | 1 | 0 | 0 |
| zenifra | 1 | 0 | 0 |
| zenmux | 122 | 10 | 0 |
| zhipuai | 17 | 0 | 0 |
| zhipuai-coding-plan | 4 | 0 | 0 |

Total: 293 free before; 286 free after; 79 status flips.

## Models whose status changed

- `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`: free → billable. Outside sourced free-plan coverage; excluded by pattern @cf/deepseek-ai/deepseek-v4-flash-0731 (https://developers.cloudflare.com/workers-ai/platform/pricing/).
- `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813`: free → billable. Outside sourced free-plan coverage; excluded by pattern @cf/deepseek-ai/deepseek-v4-pro-0813 (https://developers.cloudflare.com/workers-ai/platform/pricing/).
- `cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6`: free → billable. Outside sourced free-plan coverage; excluded by pattern @cf/moonshotai/kimi-k2.6 (https://developers.cloudflare.com/workers-ai/platform/pricing/).
- `cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code`: free → billable. Outside sourced free-plan coverage; excluded by pattern @cf/moonshotai/kimi-k2.7-code (https://developers.cloudflare.com/workers-ai/platform/pricing/).
- `cloudflare-workers-ai/@cf/zai-org/glm-5.2`: free → billable. Outside sourced free-plan coverage; excluded by pattern @cf/zai-org/glm-5.2 (https://developers.cloudflare.com/workers-ai/platform/pricing/).
- `cloudflare-workers-ai/@cf/zai-org/glm-5.3`: free → billable. Outside sourced free-plan coverage; excluded by pattern @cf/zai-org/glm-5.3 (https://developers.cloudflare.com/workers-ai/platform/pricing/).
- `cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash`: free → billable. Outside sourced free-plan coverage; excluded by pattern @cf/zai-org/glm-5.3-flash (https://developers.cloudflare.com/workers-ai/platform/pricing/).
- `gemini/deep-research-max-preview-04-2026`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/deep-research-preview-04-2026`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-2.5-computer-use-preview-10-2025`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-2.5-flash-image`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-2.5-pro-preview-tts`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3-pro-image`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3-pro-image-preview`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3.1-flash-image`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3.1-flash-image-preview`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3.1-flash-lite-image`: free → billable. Outside sourced free-plan coverage; excluded by pattern gemini-3.1-flash-lite-image (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3.1-flash-tts-preview`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3.1-pro-preview`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3.1-pro-preview-customtools`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3.6-flash`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-3.7-flash`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-embedding-001`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/gemini-omni-flash-preview`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/veo-3.1-fast-generate-preview`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/veo-3.1-generate-preview`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `gemini/veo-3.1-lite-generate-preview`: free → billable. Outside sourced free-plan coverage (https://ai.google.dev/gemini-api/docs/pricing).
- `groq/groq/compound`: free → billable. Outside sourced free-plan coverage (https://console.groq.com/docs/rate-limits).
- `groq/groq/compound-mini`: free → billable. Outside sourced free-plan coverage (https://console.groq.com/docs/rate-limits).
- `groq/llama-3.1-8b-instant`: free → billable. Outside sourced free-plan coverage (https://console.groq.com/docs/rate-limits).
- `groq/llama-3.3-70b-versatile`: free → billable. Outside sourced free-plan coverage (https://console.groq.com/docs/rate-limits).
- `groq/qwen/qwen3.6-27b`: free → billable. Outside sourced free-plan coverage (https://console.groq.com/docs/rate-limits).
- `mistral/codestral-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/devstral-2512`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/devstral-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/devstral-medium-2507`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/devstral-medium-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/devstral-small-2505`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/devstral-small-2507`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/magistral-medium-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/magistral-small`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/ministral-3b-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/ministral-8b-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-embed`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-large-2411`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-large-2512`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-large-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-medium-2505`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-medium-2508`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-medium-2604`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-medium-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-nemo`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-small-2506`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-small-2603`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/mistral-small-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/open-mistral-7b`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/open-mistral-nemo`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/open-mixtral-8x22b`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/open-mixtral-8x7b`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/pixtral-12b`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/pixtral-large-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/voxtral-small-latest`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/zai-glm-5-2`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `mistral/zai-glm-5-3`: billable → free. Covered by sourced free-tier plan (https://docs.mistral.ai/admin/billing-usage/usage-limits); free-tier billing selected.
- `nvidia/deepseek-ai/deepseek-v4-pro`: free → billable. Outside sourced free-plan coverage; excluded by pattern deepseek-ai/deepseek-v4-pro (https://build.nvidia.com/models).
- `openrouter/google/lyria-3-clip-preview`: billable → free. OpenRouter catalog input/output prices are both $0.
- `openrouter/google/lyria-3-pro-preview`: billable → free. OpenRouter catalog input/output prices are both $0.
- `openrouter/openrouter/free`: billable → free. OpenRouter catalog input/output prices are both $0.
- `openrouter/stealth/space-bunny-alpha`: billable → free. OpenRouter catalog input/output prices are both $0.
- `zenmux/anthropic/claude-sonnet-5-free`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/moonshotai/kimi-k2.7-code-free`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/moonshotai/kimi-k3-free`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/stepfun/step-3.7-flash-free`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/x-ai/grok-imagine-image-2.0`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/x-ai/grok-voice-stt-1.0`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/x-ai/grok-voice-tts-1.0`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/z-ai/glm-4.6v-flash-free`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/z-ai/glm-4.7-flash-free`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
- `zenmux/z-ai/glm-image`: free → billable. Provider free plan does not provide API access (https://zenmux.ai/docs/guide/subscription.html).
