# Cally Mentra App

Server-side MentraOS app that lets Mukil invoke Cally from Mentra glasses.

## What It Does

- Listens for final voice transcriptions containing `Cally`, `Kali`, or `Callie`.
- Shows short replies on the glasses display and speaks them through MentraOS TTS when available.
- Supports command intents: `help`, `status`, `look`, `read this`, `remember <note>`, `recap`, `captions`, `quiet`, and `speak`.
- Captures a photo when the command asks to look/read/see/scan.
- Tracks current device state including WiFi, battery, charging, model, connection, and location when available.
- Uses button/touch shortcuts: short press shows status, long press captures/asks, simple touch shows a ready prompt.
- Shows high-priority phone notifications when the MentraOS permission is granted.
- Persists short user notes with MentraOS SimpleStorage.
- Logs meals through a local LoseFit bridge so voice commands like `Cally log lunch chicken bowl` become reviewable food logs.
- Forwards voice/photo/location context to a configurable Cally bridge endpoint.
- Exposes local control endpoints and a richer `/webview` surface for the OpenClaw `cally-mentra` skill.
- Accepts an optional direct, authenticated Wi-Fi WebSocket from Mentra Live for low-latency
  `hello`/heartbeat/`ping`/`pong`/status diagnostics while retaining the Mentra SDK path.

Server-side apps can observe Mentra Live WiFi/device state, but WiFi network joining/configuration still appears to be owned by the MentraOS phone/glasses setup flow rather than a cloud app SDK call.

## Setup

```bash
cd apps/cally-mentra
cp .env.example .env
npm install
npm run dev
```

Register the app in the MentraOS Developer Console:

- Package name: `com.mukil.cally` or your chosen `PACKAGE_NAME`
- Public URL: your ngrok/Tailscale/production HTTPS URL
- WebView URL: your public URL plus `/webview`, for example `https://mentra.mukilsenthil.com/webview`
- Permissions: `MICROPHONE`, `CAMERA`, `LOCATION`

MentraOS docs say apps are server-side JavaScript/TypeScript services that connect through MentraOS Cloud; the SDK exposes sessions, transcription events, layouts, audio/TTS, camera photo capture, and location.

## Local Control API

Protected routes require `Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN`; query-string tokens
are rejected. The webview can read the token from `#token=...`, which remains in the browser
fragment and is converted to the same header. In production, use random values of at least 32 bytes
for both this token and `CALLY_COOKIE_SECRET`.

```bash
curl http://localhost:3017/health
curl http://localhost:3017/webview
curl -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" http://localhost:3017/sessions
curl -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" http://localhost:3017/status
curl -X POST -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"text":"status"}' http://localhost:3017/sessions/<sessionId>/command
curl -X POST -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Hello from Cally"}' http://localhost:3017/sessions/<sessionId>/say
curl -X POST -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"What am I looking at?","size":"medium"}' http://localhost:3017/sessions/<sessionId>/capture
```

## Direct Mentra Live Wi-Fi POC

The endpoint has two authentication modes:

- **Production:** Cloudflare Access service credentials on the WebSocket upgrade. Cloudflare admits
  the request and adds a short-lived signed assertion; Cally verifies that assertion and binds its
  service-token identity to one configured `deviceId`.
- **Local development:** a dedicated `CALLY_GLASSES_DEVICE_TOKEN`. This fallback is rejected when
  `NODE_ENV=production` and must never be exposed on a public origin.

If neither mode is configured, upgrades at the direct path fail closed with `503`; the existing
`@mentra/sdk` routes and sessions continue normally. The POC accepts JSON text messages only, caps
each message at `CALLY_GLASSES_MAX_PAYLOAD_BYTES`, requires `hello` before all other messages,
expires missed heartbeats, and permits one current connection for each `deviceId`. A newer hello for
the same device replaces the older socket.

### Cloudflare Access production setup

1. Use a dedicated hostname such as `glasses.example.com` and publish Cally through a Cloudflare
   Tunnel. Keep the origin port private so callers cannot bypass Access.
2. Create a Cloudflare Access self-hosted application for that hostname. Add a `Service Auth` policy
   that includes the specific service token for each glasses; do not use a bypass or “any token”
   rule.
3. Configure all three origin verifier values together:

   ```text
   CALLY_CLOUDFLARE_ACCESS_ISSUER=https://<team>.cloudflareaccess.com
   CALLY_CLOUDFLARE_ACCESS_AUDIENCE=<application-aud-tag>
   CALLY_CLOUDFLARE_ACCESS_DEVICE_BINDINGS_JSON={"<service-token-client-id>":"mentra-live-001"}
   ```

4. Provision only the dedicated WSS URL and that device's service-token pair to ASG. ASG presents:

   ```text
   CF-Access-Client-Id: <per-device-client-id>
   CF-Access-Client-Secret: <per-device-client-secret>
   ```

Cally validates the `Cf-Access-Jwt-Assertion` signature using Cloudflare's rotating JWKS, plus exact
issuer, audience, expiry, and service-token `common_name`. A valid Cloudflare token still cannot
claim another configured glasses ID. Cally closes the WSS shortly before assertion expiry with code
`4003`; ASG reconnects with the service headers, and Cloudflare supplies a fresh short-lived
assertion on the new upgrade.

This connection renewal does not rotate the longer-lived client secret. Cloudflare calls extending
the token's expiration **refresh**, while generating a replacement secret is a separate **rotate**
operation. Secret rotation will use current/next credential slots once phone-based provisioning is
implemented; do not place a Cloudflare management API token on the glasses or in this repository.

Cloudflare references: [service tokens and rotation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
[Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
and [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

#### Automatic service-token expiration renewal

The repository includes a one-shot, scheduler-friendly renewal job. Give this job—not the Cally
runtime and never ASG—a Cloudflare API token scoped only to `Access: Service Tokens Write` for the
target account:

```bash
CLOUDFLARE_API_TOKEN=<server-secret> \
CLOUDFLARE_ACCOUNT_ID=<32-hex-account-id> \
CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS=<uuid>[,<uuid>...] \
npm run auth:refresh-cloudflare
```

It sequentially calls Cloudflare's official `refresh` endpoint, times out stalled calls, attempts
every configured token, exits nonzero if any fail, and logs only token ID, safe name, and new expiry.
Store these three variables in a root-readable scheduler environment file rather than the main app's
`.env`, then run the command monthly with a systemd timer or equivalent. Also enable Cloudflare's
service-token expiry alert as a backup.

This job extends expiration without changing the client secret. Scheduled **secret rotation** is a
later phone-provisioning milestone because an intermittently offline device needs current/next
credential slots and a grace window before the old secret is revoked.

### Local-development fallback

For the first same-LAN ping, use the ignored `.env` files and a random credential:

```text
ws://<server-LAN-IP>:3017/v1/glasses/connect
X-Cally-Device-Token: <CALLY_GLASSES_DEVICE_TOKEN>
```

Do not put any device credential in a URL, source file, log, or Git commit.

Every message uses this envelope:

```json
{
  "type": "hello|heartbeat|ping|pong|status",
  "requestId": "optional-correlation-id",
  "timestamp": 0,
  "payload": {}
}
```

The first message must be protocol version 1:

```json
{
  "type": "hello",
  "timestamp": 0,
  "payload": {
    "protocolVersion": 1,
    "deviceId": "mentra-live-001",
    "processSid": "a1b2c3d4",
    "deviceModel": "Mentra Live",
    "androidVersion": "11",
    "androidSdk": 30,
    "appVersion": "1.0"
  }
}
```

The server answers a valid first message with an accepted `hello` acknowledgement. The ASG does not
consider the route ready, send periodic telemetry, or accept `ping` until that acknowledgement
arrives. This separates a TCP/WebSocket connection from a working application-protocol session.

Heartbeat and status payloads may include `battery`, `charging`, `wifiConnected`, `wifiSsid`,
`wifiRssi`, and `localIp`. The server echoes a client `ping` as a correlated `pong`; the glasses must
likewise correlate server `ping`/status requests with the same `requestId`.

Direct-device diagnostics and controls reuse `CALLY_MENTRA_CONTROL_TOKEN` and return `401` when it
is missing or incorrect:

```bash
curl -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" \
  http://localhost:3017/v1/glasses
curl -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" \
  http://localhost:3017/v1/glasses/mentra-live-001
curl -X POST -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" \
  http://localhost:3017/v1/glasses/mentra-live-001/ping
curl -X POST -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" \
  http://localhost:3017/v1/glasses/mentra-live-001/status
```

This first POC is intentionally diagnostic-only. It does not put camera, microphone, speaker,
streaming, OTA, reboot, or general commands on the direct route.

### First end-to-end ping walkthrough

This is the smallest useful hardware experiment. It deliberately uses build-time ASG settings; the
next milestone will provision the endpoint and device credential from the phone and persist them on
the glasses.

1. For the smallest same-LAN test, give the server two different development credentials in its
   ignored `.env`:

   ```text
   CALLY_GLASSES_DEVICE_TOKEN=<random-device-token>
   CALLY_MENTRA_CONTROL_TOKEN=<different-random-control-token>
   ```

   The device token authenticates the glasses WebSocket. The control token authenticates your
   diagnostic `curl` request. Keeping them separate prevents a compromised glasses credential from
   automatically authorizing server controls.

   For the Cloudflare test instead, leave `CALLY_GLASSES_DEVICE_TOKEN` empty and configure the three
   `CALLY_CLOUDFLARE_ACCESS_*` values described above. Keep the control token separate in either
   case.

2. Start Cally with `npm run dev`. The Cloudflare route is
   `wss://glasses.<domain>/v1/glasses/connect`; a same-LAN debug listener is
   `ws://<server-LAN-IP>:3017/v1/glasses/connect`.

3. In the ignored `MentraOS/asg_client/.env`, select the corresponding authentication mode:

   ```text
   CALLY_DIRECT_MODE=enabled
   CALLY_DIRECT_URL=wss://<reachable-cally-host>/v1/glasses/connect
   CALLY_DIRECT_CF_ACCESS_CLIENT_ID=<per-device-client-id>
   CALLY_DIRECT_CF_ACCESS_CLIENT_SECRET=<per-device-client-secret>

   # Or, for the same-LAN development test only:
   # CALLY_DIRECT_DEVICE_TOKEN=<random-device-token>
   ```

   A cleartext same-LAN debug build instead needs `CALLY_DIRECT_ALLOW_CLEARTEXT_DEBUG=true`. Never
   put a credential in the URL or commit either `.env` file. These first-POC values become Android
   `BuildConfig` fields and can be extracted from the APK; phone provisioning into protected runtime
   storage is the next credential milestone.

4. Build and install the third-party ASG using the repository's Mentra Live development/recovery
   workflow, then watch only the new sidecar logs:

   ```bash
   ./gradlew :app:assembleDebug
   ./scripts/dev-setup.sh
   adb logcat -s DirectWebSocket
   ```

5. Wait for `Direct Cally hello acknowledged`, list connected devices, and copy the returned
   `deviceId`:

   ```bash
   curl -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" \
     http://localhost:3017/v1/glasses
   ```

6. Send the first real command:

   ```bash
   curl -X POST -H "Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN" \
     http://localhost:3017/v1/glasses/<deviceId>/ping
   ```

   Success is an HTTP response whose nested WebSocket response has `type: "pong"` and the same
   generated `requestId`. That correlation proves the request went server → glasses → server; a
   plain HTTP health response would not prove the glasses participated.

7. For the Cloudflare path, confirm the device snapshot reports `authKind: "cloudflare_access"`.
   When the short-lived Access assertion reaches its renewal window, Cally closes with code `4003`;
   the existing ASG reconnect loop presents the service headers again and receives a fresh assertion.

## LoseFit Meal Logging

LoseFit is a pragmatic bridge for Lose It-style tracking: it captures meals locally now, estimates obvious calories/macros when possible, marks each entry `needs_review`, and exports CSV for manual review/import.

Default log path from this app is `../../data/losefit/meal-log.jsonl` relative to the app working directory. Override with `LOSEFIT_LOG_PATH`.

Voice/control examples:

- `Cally log lunch chicken bowl with unsweetened tea`
- `Cally I had 650 calories chicken bowl for lunch`
- `Cally calories today`
- `Cally LoseFit export CSV`

CLI examples:

```bash
npm run losefit -- log "lunch chicken bowl with unsweetened tea"
npm run losefit -- today
npm run losefit -- export
npm run smoke:losefit
```

## Cally Agent Bridge

Cally reasoning is resolved in this priority order:

1. **Webhook** — if `CALLY_AGENT_WEBHOOK_URL` is set, context is POSTed there (contract below).
2. **Local OpenClaw CLI** — otherwise, if `CALLY_AGENT_CLI_ENABLED` is not `false`, the app runs a
   single agent turn through the local CLI. This is the default for local setups and needs no HTTP gateway.
3. **Local fallback** — if both are disabled, the app answers basic time/status intents itself.

### Local CLI bridge

The app invokes the CLI directly with `execFile` (no shell, so transcribed speech can't inject shell
syntax):

```bash
openclaw agent --session-key mentra:<userId> --message "<prompt>" --json --timeout 45
```

It reads the reply from `result.payloads[0].text` (falling back to `finalAssistantVisibleText`), then
trims it short for the heads-up display. Sessions are scoped per user via
`CALLY_AGENT_SESSION_PREFIX` so each wearer keeps their own conversation thread.

Env knobs (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CALLY_AGENT_CLI_ENABLED` | `true` | Enable the local CLI bridge when no webhook is set. |
| `CALLY_AGENT_CLI_PATH` | `openclaw` | Path/binary for the OpenClaw CLI. |
| `CALLY_AGENT_CLI_TIMEOUT_SECONDS` | `45` | Per-turn agent timeout (the process gets +15s headroom). |
| `CALLY_AGENT_SESSION_PREFIX` | `mentra` | Session-key prefix; final key is `<prefix>:<userId>`. |
| `CALLY_MENTRA_CAPTURE_DIR` | `../../data/mentra-captures` | Where captured photos are written. |

Photos are only captured on explicit commands (look/read/scan/photo, long button press, or the
`/capture` endpoint). On capture, the frame is saved under `CALLY_MENTRA_CAPTURE_DIR` and its local
path is included in the agent prompt so the CLI can reason about it by path.

### Webhook contract

If `CALLY_AGENT_WEBHOOK_URL` is set, the app sends:

```json
{
  "kind": "voice|photo|control",
  "userId": "...",
  "sessionId": "...",
  "text": "...",
  "location": {},
  "photo": {
    "mimeType": "image/jpeg",
    "filename": "photo.jpg",
    "base64": "...",
    "size": 12345
  }
}
```

The endpoint should respond with:

```json
{ "reply": "Short answer to display and speak" }
```

## Latency Architecture

The glasses path is tiered for speed (measured ~1s vs ~13–20s for a full agent turn):

1. **Local fast-path (instant):** deterministic commands — `status`, time/date, `captions/quiet`,
   `remember`, `recap`, LoseFit logging — answered in-process with no network and no LLM.
2. **Direct OpenAI (~1s):** open-ended questions go straight to the Chat Completions API from this
   always-warm process, using a **compressed digest** of Cally's brain as the system prompt
   (`CALLY_OPENAI_*`). The raw model answers in ~0.6s; the full OpenClaw agent turn is ~15s because of
   per-turn machinery (CLI spawn, gateway context assembly) — not the model — so we bypass it here.
3. **Full OpenClaw agent (fallback):** used only if the fast path fails/disabled (`CALLY_AGENT_CLI_*`).
   Full tools/memory, but slow.

### The compressed brain digest

`scripts/make-glasses-digest.mjs` distills the ~150k-char OpenClaw workspace context down to ~8k
(identity, soul, user, memory index, and a trimmed slice of recent daily memory) and writes it to
`~/.openclaw/workspace-glasses/AGENTS.md`. That file is the `CALLY_OPENAI_DIGEST_PATH` system prompt —
this is the deliberate **latency ↔ brain** tradeoff. Regenerate when memory changes:

```bash
node scripts/make-glasses-digest.mjs
# keep it fresh, e.g. hourly:
# crontab -e ->  0 * * * * cd /path/to/apps/cally-mentra && node scripts/make-glasses-digest.mjs
```

> Note on this EC2 host: 2 vCPU / 3.7G RAM with heavy swap. The instance is the real ceiling on the
> full-agent path; the direct-OpenAI fast path is what keeps replies snappy under that constraint.

## Operations Notes

- **"Invalid frontend token format" log noise:** the `@mentra/sdk` global auth middleware logs this
  whenever a webview request carries a frontend token that isn't in its `userId:hash` form. The token
  is supplied by MentraOS infrastructure and the SDK catches its own format error. This app's
  protected routes still independently require `CALLY_MENTRA_CONTROL_TOKEN`. The app collapses those
  SDK warnings into a once-per-minute counter line; all other errors pass through untouched.
- **Resilience:** control routes return structured JSON errors (`400` for invalid input, `404` for an
  unknown session, `401` unauthorized, `500` otherwise), and unhandled rejections / uncaught exceptions
  are logged rather than crashing the service.

## Restarting the Service

After changing code, rebuild before restarting so `dist/` is current:

```bash
cd apps/cally-mentra
npm run build
sudo systemctl restart cally-mentra.service
systemctl status cally-mentra.service --no-pager
```

## Tests

```bash
npm test
npm run typecheck
```

The direct-glasses suite runs against ephemeral local HTTP/WebSocket servers and covers
authentication, hello ordering, duplicate replacement, request correlation, payload limits,
heartbeat expiry, protected HTTP diagnostics, and shutdown cleanup.
