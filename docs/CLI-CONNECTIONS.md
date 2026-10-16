# Use an installed coding CLI in Ferry

Ferry can use Codex CLI, Claude Code CLI and OpenCode CLI as model connections. Install and sign
in to the client first. Ferry uses its current account; adding another account or importing that
client's previous conversations is outside this integration.

## Connect in the desktop app

1. Open **Models → Providers → Installed CLIs**, or **Settings → Providers & keys**.
2. Select **Detect / Refresh**. Installation, sign-in, discovered models and generation verification
   are separate facts. A discovered model has not necessarily been tested on your account.
3. Choose a free or included model and select **Verify connection**. Ferry sends one small request.
   Wait for the result; an exhausted or unsupported connection displays the reason.
4. Enable **Use in Ferry chat and CLI**, **Allow Gateway requests**, or both. These permissions are
   independent and start disabled. Verification alone does not enable either permission.

Open the chat model picker and choose **Included subscriptions** or **All connected**. Select a model
under its CLI's name. Its **Options** control opens beside the model chip, with the effort choices
reported by that client. **Client default** follows the installed client's reported default rather
than pinning an effort permanently. Fast/priority mode starts off. This beta cannot set a known-price
reservation that bounds a separately billed Fast/priority charge, so the bridge fails closed when the
request needs that unsupported billing guarantee. A positive Gateway key budget alone does not enable
Fast/priority mode. Standard speed and supported reasoning choices remain available.

Saved OpenCode Zen CLI model references are resolved for display and options without rewriting the
stored pin. Refreshing discovery does not silently change the selection.

For automatic routing, enable subscription CLI inclusion in the routing profile. Auto tries eligible
free capacity first, then approved included capacity. Choosing a CLI model manually uses that model
directly, even when the profile excludes subscription models from Auto.

If a profile restricts its provider list, also include the installed CLI connection under **Profiles →
Models it can use → Choose providers**. API providers and installed CLI connections have separate
IDs (for example, `openai` and `codex-cli`). Enabling signed-in CLI backup does not widen or migrate
an existing provider allowlist.

**Included** means subscription capacity, not unlimited usage or free API billing. **Metered** and
**Unknown** require separate spending authorization. A CLI connection does not authorize overage,
credits or separately billed modes.

## OpenCode Zen and Go

OpenCode Zen and OpenCode Go use separate upstream connections. Finding a Go credential does not
prove access to a Zen model. In the OpenCode connection controls, choose the Zen credential source.
**Detect again** refreshes the installed CLI inventory without generating a response. If Ferry detects
a Go credential, the separate **Offer the installed Go credential for the Zen check** switch appears
off by default. Changing it only changes the credential offered; it does not start verification. Use
**Verify free CLI access** explicitly to send the small free-model check.
Only free Zen models in the installed-client discovery are offered for that check. An explicitly
requested metered or unknown model is rejected; Ferry does not silently substitute a different model.

- **Installed CLI credentials** uses the client's configured credential. You can explicitly offer
  the installed Go credential for a real Zen access check.
- **Anonymous Zen free access** checks an eligible free model without a saved Zen key.
- **Zen key saved in Ferry** uses the selected saved Zen credential for the check.

Changing Zen's credential source requires verification again. Go and other OpenCode upstream
providers retain their own installed credentials. Ferry never copies those credentials into its
database or impersonates OpenCode when using the standard API connection.

## Connect from the Ferry terminal

Run `ferry`, then use `/connect` to open the connection picker and `/model` to search models.
Subscription models have their own filter and CLI groups. Selecting a CLI model opens its options.

The same connection manager is available without the interactive UI:

```sh
ferry connect list --json
ferry connect refresh codex-cli --json
ferry connect verify codex-cli --model <discovered-model-ref>
ferry connect update codex-cli --native true --gateway false
```

Use the exact model reference returned by discovery. `ferry connect --help` lists supported flags.

## Use the connection through Gateway

Enable the connection's Gateway permission, start Gateway, and create a Ferry Gateway key. Copy the
base URL and key from **Gateway → Connect** into your client. The Ferry key is distinct from the
coding client's credential. Keep Ferry running while clients use its local endpoint.

An explicit CLI model reference selects that connection. An Auto/profile request uses the profile's
eligible routes and subscription opt-in. Ferry returns caller tool requests to your client; your
client executes them and supplies their real results in the next request.

Native CLI transport currently supports text and caller tools. Explicit controls that the bridge
cannot enforce, images and structured-output requests return a validation error. Use a compatible
API connection when those capabilities are required. Ferry does not silently replace the model or
drop an unsupported option.

## Read usage and recover from limits

The connection manager shows account quota windows when the client reports them. **Unavailable**
means the client did not provide usable quota data. Account limits and tokens generated through
Ferry are different measurements.

Select the responding-model logo to view that conversation's model contributions. Attribution uses
retained Ferry usage evidence; a `gateway/<keyId>` logical routing ref is not itself an LLM model. When
the actual Gateway producer was recorded, Ferry uses that model for attribution. Missing token
dimensions show **Not reported**. A conversation with assistant replies but no retained usage aggregate
is marked as missing coverage, while a fully captured conversation remains complete. For partial older
histories, timestamps cannot prove which earlier usage records are absent; Ferry preserves recorded
totals and does not estimate or fill gaps with zeroes.

An exhausted account is blocked across models that share its quota. Ferry can try another eligible
connection before Gateway output begins. Once an answer or tool call has streamed, Gateway reports
the failure instead of joining another model's answer onto it. A reported reset or a successful
explicit refresh/check can restore eligibility; an unknown reset requires a fresh check. Authentication
errors require signing in again through the installed client, then refreshing and verifying in Ferry.
