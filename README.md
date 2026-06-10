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

Use `Authorization: Bearer $CALLY_MENTRA_CONTROL_TOKEN` when configured.

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

## Operations Notes

- **"Invalid frontend token format" log noise:** the `@mentra/sdk` global auth middleware logs this
  whenever a webview request carries a frontend token that isn't in its `userId:hash` form. The token
  is supplied by MentraOS infrastructure and the SDK recovers on its own (it falls back to this app's
  `CALLY_MENTRA_CONTROL_TOKEN` auth), so it is harmless. The app collapses these into a once-per-minute
  counter line instead of a per-request stack trace; all other errors pass through untouched.
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
