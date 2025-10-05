# Toll Notices — Rent & Tolls Notifier (Linkt + e-Toll → Google Chat)

A Node.js script that, twice a day, reminds you of renters’ payments and (in the morning) scrapes **Linkt** and **e-Toll** for unpaid toll notices. It posts a rich **Google Chat card** per renter (by rego) with compact buttons to send a **WhatsApp** or **SMS** reminder—both a **base rent** message and a **rent + tolls** message.

* **8:00 AM (Sydney):** Sends the reminder **and** scrapes toll totals (auto-filled in the “with tolls” message).
* **5:00 PM (Sydney):** Sends the **second reminder** (no scraping; “with tolls” text keeps placeholders for editing).

---

## Features

* Reads renter list from `regos.json`.
* Scrapes **Linkt** and **e-Toll** (morning only) with a stealth browser context to improve headless reliability.
* Posts one Google Chat **card per renter** (bold *rego — renter*).
* Adds compact buttons:

  * 🟢 WhatsApp (base) / 🟢➕ WhatsApp (with tolls)
  * 💬 SMS (base) / 💬➕ SMS (with tolls)
  * 🔗 Linkt / 🛣️ e-Toll
* WhatsApp text uses `*asterisk*` bold; SMS is plain text.
* Groups toll rows by month (Linkt) or “e-Toll” (for e-Toll rows), includes a **totals** line.

---

## Requirements

* **Node.js 18+** (recommended). For Node 16, `node-fetch` is dynamically imported.
* **Playwright** with Chromium (installed via `npm i` below).
* A **Google Chat incoming webhook URL**.

---

## Installation

```bash
git clone <your-repo>
cd <your-repo>
npm install playwright moment-timezone node-cron dotenv
# First-time only: install browsers for Playwright
npx playwright install chromium
```

---

## Configuration

Create a `.env` file in the project root:

```env
GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/XXXX/messages?key=YYYY&token=ZZZZ
REGOS_FILE=./regos.json
DAYS_TO_CHECK=365
HEADLESS=true
# (optional) Spoofed user agent to improve headless reliability
STEALTH_UA=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36
```

### `regos.json` format

`regos.json` must be an **array** of renter entries. Phone numbers should be **digits only** in **E.164** style (e.g., `614XXXXXXXX`).

```json
[
  { "rego": "BB22BB", "renter": "Sam Spinner",  "paymentDay": "Wednesday", "rentAmount": 250, "phone": "614XXXXXXXX" }
]
```

**Fields**

* `rego` *(string, required)* — vehicle plate, any case (stored uppercase).
* `renter` *(string, required)* — person to message.
* `paymentDay` *(string, required)* — e.g. `Monday` … `Sunday`.
* `rentAmount` *(number)* — rent in AUD.
* `phone` *(string, optional)* — digits only; if omitted, WhatsApp/SMS links open without a prefilled recipient.

---

## Running

### One-off test (prints 8am card **and** 5pm card immediately)

```bash
node toll-notices.js
```

> The script calls:
>
> * `runForToday("morning")`
> * `runForToday("evening")`
>
> **For production**, you’ll typically comment out those two immediate calls and rely on the schedulers below.

### Scheduled runs (via `node-cron`)

* **08:00** Australia/Sydney → morning run (scrapes Linkt + e-Toll, adds totals)
* **17:00** Australia/Sydney → evening run (no scraping)

These are already configured in the file:

```js
cron.schedule("0 8 * * *", () => runForToday("morning"), { timezone: TZ });
cron.schedule("0 17 * * *", () => runForToday("evening"), { timezone: TZ });
```

---

## What gets sent to Google Chat

Each renter gets a **single card**:

* **Title line:** `🚗 <b>REGO — RENTER</b>`
* **Rent line (changes by time):**

  * Morning: `💸 Rent due today • Due by 5:00 PM • Amount: $X • Day: Monday`
  * Evening: `💸 Second reminder • Due by 8:00 AM tomorrow • Amount: $X • Day: Monday`
* **Tolls (morning only):**

  * Totals row: `🧾 Toll totals • Admin: $A • Tolls: $T`
  * Grouped lines by month (Linkt) or “e-Toll”.
* **Buttons:**

  * Row 1: 🟢 (WhatsApp base), 💬 (SMS base)
  * Row 2: 🟢➕ (WhatsApp with tolls), 💬➕ (SMS with tolls)
  * Footer: 🔗 (Linkt), 🛣️ (e-Toll)

**WhatsApp** messages use `*bold*`. **SMS** messages are plain text.

---

## Headless vs Headed

* Default: `HEADLESS=true`.
* If e-Toll is flaky in headless:

  * Temporarily set `HEADLESS=false` to visually debug.
  * Check generated screenshots in the project root:

    * `etoll_rego_missing_<rego>.png`
    * `etoll_error_<rego>.png`
  * The script uses a **stealth** context (`userAgent`, `navigator.webdriver` masking, etc.) to improve reliability.

---

## Troubleshooting

* **Empty/blank cards:** ensure `GOOGLE_CHAT_WEBHOOK_URL` is correct and the Chat space allows incoming webhooks.
* **“e-Toll: rego field not found” in headless:** try `HEADLESS=false` and/or set a modern `STEALTH_UA`. Slow networks/SPAs may need more time; the script already waits for `networkidle` and searches across frames.
* **WhatsApp links not opening on desktop:** If no `phone` is set, WhatsApp Web opens a generic “new chat” with text prefilled. Add renter `phone` in E.164 format (e.g., `614XXXXXXXX`) for direct chats.
* **Days window:** Change `DAYS_TO_CHECK` if you want more or fewer historical Linkt months included.

---

## Security & Notes

* Webhook URL is sensitive — keep `.env` out of source control.
* This script scrapes public pages (no login). Sites can change their DOM; if parsing breaks, adjust selectors in the code.
* Don’t store bank details elsewhere—messages already embed the payment details.

---

## Customizing messages

Messages are generated in `buildMessages(...)`.

* WhatsApp variants (`waMorning`, `waEvening`, and their “with tolls” versions) use asterisks for bold.
* SMS variants are the same wording without asterisks.

If you prefer different deadlines (e.g., due by 6 PM), edit the strings in `buildMessages`.

---

## Production tips

* Run under a process manager (PM2, systemd, Docker) so it stays alive and logs are captured.
* For Docker, mount your `.env` and `regos.json`, and ensure timezone is set to `Australia/Sydney` (or rely on `moment-timezone` + `TZ` logic already in code).

---

## Quick checklist

* [ ] `npm install` & `npx playwright install chromium`
* [ ] Create `.env` with `GOOGLE_CHAT_WEBHOOK_URL`
* [ ] Create `regos.json` with your renters (set `phone` to E.164 digits)
* [ ] Test: `HEADLESS=false` and `node toll-notices.js`
* [ ] Switch back to `HEADLESS=true` for server use
* [ ] Comment out immediate test calls if you only want the scheduled posts

---

If you want me to generate a **starter `regos.json`** from your latest list (with placeholder phones), say the word and I’ll print it exactly as a file-ready block.
