# Phase 3: Live

Real live audio. You go live from your laptop with your soundcard mix. Viewers listen, chat, react and send requests in real time. Afterwards you decide whether to publish the recording as a replay.

## How it fits together

| Part | Where it runs | Job |
|---|---|---|
| FabStudio, **Live** tab | Your laptop (Chrome or Edge) | Opens your soundcard, mixes it into one stream, sends that stream to viewers **and** records the same stream on the laptop. Chat, requests, moderation and settings. |
| Cloudflare **Realtime SFU** | Cloudflare | Carries the audio from your laptop to every listener. |
| **LiveRoom** (Durable Object, one per live) | Cloudflare | The room: who is here, chat, slow mode, mutes, pause, pinned message, the request queue, reaction pulses. Saves chat to Supabase every 15 seconds and when the live ends. |
| Worker (`/live/*`) | Cloudflare | Holds the SFU secret. Lets only you publish. Lets listeners in according to the viewer mode. |
| Supabase | Supabase | Accounts (guests included), the live session record, views, Like and Love, saved chat. |
| `/live/?id=...` | Cloudflare Pages | The public page: countdown, then Listen, chat, requests, reactions. |

A live is a normal published item (kind `live`), so views, Like, Love and comments are counted per session like any other item. After the live, publishing the replay puts the recording on the same item: same page, same counters.

The phone does **not** broadcast and does **not** pair. A phone is just a viewer. Open the viewer link on it to hear what the public hears and catch glitches.

The countdown never starts the live. Only the **Go live** button does.

## Install

1. Unzip over your existing project. It adds files and edits these existing ones: `site/studio/js/app.js`, `ui.js`, `api.js`, `publish.js`, `sw.js`, `css/studio.css`, `site/js/data.js`, `home.js`, `poem.js` and `worker/src/index.js`. It does **not** touch `site/shared/config.js` or `worker/wrangler.toml`.
2. Do the setup below, in order.

## Setup (once)

### 1. Database

Supabase, SQL Editor, paste `supabase/migrations/005_live.sql`, Run. It is safe to run again.

### 2. Create the Realtime SFU app

Cloudflare dashboard, **Realtime**, **SFU**, **Create application**. Copy the **App ID** and the **App Secret** (shown once).

### 3. Worker

Open `worker/wrangler.toml.phase3-additions.txt`. Copy its blocks into `worker/wrangler.toml`: the `LIVE_ROOM` Durable Object binding and the `[[migrations]]` block. Add `SFU_APP_ID = "..."` inside your existing `[vars]`. Then, in the `worker` folder:

```
npx wrangler secret put SFU_APP_SECRET
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler deploy
```

`SFU_APP_SECRET` is the secret from step 2. `SUPABASE_SERVICE_KEY` is the Supabase **service_role** key; skip it if you already set it for guest merging. Never put either in a file.

Check `ALLOWED_ORIGINS` in `wrangler.toml` contains your site's address (it already has `https://fabstudio.pages.dev`). If you use a custom domain, add it, or the live room refuses the connection.

### 4. Site

Commit and push, or deploy Pages as you did before. In FabStudio, hard reload once so the new files install (the app cache is now `v5`).

## Test session (about 15 minutes)

You need: your laptop with the soundcard or interface, headphones, and a phone.

**A. Laptop, ready**

1. Laptop, Chrome or Edge, open `/studio/`, sign in, open the **Live** tab.
2. **New live**. Give it a title. Skip the planned start for this test. Create.
3. The console opens. Wait for **Room connected**.
4. In **Sound**, press **Open soundcard** and allow the microphone. Choose your soundcard in the list. Play something: the meter moves. Aim for the bar mostly in the middle, almost never touching the right end (it turns red). Use **Gain** to set that.
   - Windows with a mixer or interface: choose the interface's input.
   - To send what the computer itself plays (backing track, poem audio), choose the loopback input your soundcard or driver provides (often called Stereo Mix or similar). A browser cannot capture it without one.
   - Noise suppression, echo cancelling and auto gain are **off** on purpose, so the sound stays as you mixed it.
5. Put on headphones. Leave **Hear what viewers hear** off unless you use headphones.

**B. Phone, as a viewer**

6. Press **Copy viewer link** and open it on your phone (any browser). It is the same page the public sees. You will see the countdown or "Waiting".
7. Put the phone in another room, or wear headphones on the phone and keep the laptop on headphones too. If the phone is in the same room with speakers, it echoes. That is the phone, not the live.

**C. Go live**

8. Laptop: **Go live**. The badge turns **ON AIR**, the timer runs, and "Recording on this laptop" counts up.
9. Phone: the page switches to live by itself. Press **Listen live**. You hear the laptop's input after about a second or less. The line under the player says "Audio: good" when it is fine and tells you when it stutters.
10. Phone: write a chat message, press Love and Like, send a **Poem request** and a **Question**. On the laptop they appear at once. Press **Reading** on the request, then **Done**.
11. Laptop: try **Pause chat**, **Slow 10s**, **pin** a message, **mute** the phone's guest ID (shown as `Guest xxxx`), then click its ID under the chat to unmute it.
12. Laptop **Live settings**: switch **Viewer mode** to *Login required*. The phone (a guest) should show "Sign in to join". Set it back to *Open*.
13. Pull the soundcard USB cable for 3 seconds, plug it back. The console says the input was lost: press **Retry audio** (it also tries by itself).

**D. End and replay**

14. Laptop: **End live**, confirm. Phone: shows "This live has ended".
15. In the **After the live** card, wait until it says the recording is uploaded (keep the app open and online). Then **Publish replay**.
16. Open the home page: the live now appears as a normal poem tile. Open it: the replay plays, and the views, Like, Love and saved chat comments are on the same item.

That is the full test: audio, chat, a request, a recording and a published replay.

## Viewer modes

- **Open**: anyone, guests included.
- **Login required**: signed-in accounts only. Guests see a sign-in prompt, cannot listen, chat or request.
- Captcha mode is reserved and **off**. When you add Turnstile later, the viewer side already has a single place for the token (`getCaptchaToken` in `site/js/auth-ui.js`).

## Settings

Everything below is in the console under **Live settings** and applies immediately. They are defined in one list, `site/shared/live-settings.js`: to add one, add one entry there.

**Who can watch**

| Setting | Default | Notes |
|---|---|---|
| Viewer mode | open | Captcha mode is not available yet. It will come with Turnstile. |

**What viewers see**

| Setting | Default | Notes |
|---|---|---|
| Show the view count | On |  |
| Show how many are watching now | On |  |
| Show Like and Love counts | On |  |

**Chat**

| Setting | Default | Notes |
|---|---|---|
| Chat is on | On |  |
| Guests can chat | On | Off means only signed-in accounts can write. |
| Slow mode | 0 | 0 is off. Otherwise one message per person every this many seconds. |
| Longest message | 200 |  |
| Messages a new viewer sees on arrival | 50 |  |

**Reactions**

| Setting | Default | Notes |
|---|---|---|
| Like and Love are on | On |  |

**Requests and questions**

| Setting | Default | Notes |
|---|---|---|
| Viewers can request a poem | On |  |
| Viewers can ask a question | On |  |
| Everyone sees the request queue | On | Off means each person sees only their own. |
| Guests can send requests and questions | On |  |
| Limit per person | 3 |  |

**Audio**

| Setting | Default | Notes |
|---|---|---|
| Quality sent to viewers | 96 | Higher is clearer but uses more of every viewer's data, and more of your Cloudflare allowance. |
| Send stereo | On |  |

**Countdown**

| Setting | Default | Notes |
|---|---|---|
| Show a countdown before the start | On | The countdown never starts the live. Only your Go live button does. |
| Countdown begins | 60 |  |

**Host**

| Setting | Default | Notes |
|---|---|---|
| Name shown on your chat messages | Fabris |  |

## If something does not work

| What you see | Likely cause |
|---|---|
| "Live audio is not set up on the Worker yet" | `SFU_APP_ID` or `SFU_APP_SECRET` missing, or the Worker not redeployed (step 3). |
| Room never says "Connected" | `LIVE_ROOM` binding or `[[migrations]]` missing; or your site address is not in `ALLOWED_ORIGINS`. |
| "Sign in again" | The owner token was rejected; sign out and in once. |
| Could not load lives list | Migration 005 not run. |
| Chat is not saved after the live | `SUPABASE_SERVICE_KEY` secret missing. |
| Phone hears nothing but says "Listening" | The laptop meter is flat: wrong input chosen. |
| "The audio connection timed out" | A network that blocks UDP (some office or school Wi-Fi). Try mobile data. |
| Replay button greyed | The recording is still uploading from the laptop. |

Browser console (F12) shows which step of the audio connection failed.

## Limits and honest notes

- **Not tested against real Cloudflare here.** The room, the Worker rules, the page and the console were tested with simulated services, including a browser. The real SFU audio negotiation and a real soundcard session are exactly what the test session above checks. If audio fails to connect, send me the browser console lines.
- **Cost**: check Cloudflare's current Realtime SFU pricing and free allowance before a long or well-attended live. Audio at 96 kbps for many listeners is the main cost. Lower **Quality sent to viewers** to reduce it. I could not verify the current figures.
- One broadcaster per live. Pressing Go live from a second window is refused while the first is on air.
- An ended live is final. A new live is a new session.
- Keep the laptop awake and the tab open while on air. Closing the tab asks you to confirm. The recording is saved every 3 seconds, so a crash loses at most a moment.
- The viewer count shown is the number of different accounts who opened the live page. "Watching now" is people connected right now.
- Moderation by ID works with the four characters shown after a name in your chat (`Amina ·abcd`) or `Guest abcd`.
