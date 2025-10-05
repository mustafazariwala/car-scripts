// toll-notices.js
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const dotenv = require("dotenv");
const moment = require("moment-timezone");
const cron = require("node-cron");

// ensure fetch exists (Node 18+ has it; Node 16 needs this)
const fetch = global.fetch || ((...args) =>
  import('node-fetch').then(({ default: f }) => f(...args)));

dotenv.config();

const GOOGLE_CHAT_WEBHOOK_URL = process.env.GOOGLE_CHAT_WEBHOOK_URL;
const REGOS_FILE = process.env.REGOS_FILE || path.resolve(process.cwd(), "regos.json");
const DAYS_TO_CHECK = Number(process.env.DAYS_TO_CHECK || 365);
const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() !== "false";

const LINKT_URL = "https://tollnotice.linkt.com.au/Search.asp";
const ETOLL_URL = "https://paytollnotice.mye-toll.com.au/tollnotice/";
const TZ = "Australia/Sydney";

// ---------- helpers ----------
const parseMoney = (txt) => {
  if (!txt) return null;
  const m = String(txt).replace(/,/g, "").match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : null;
};
const parseIssuedMonth = (s) => {
  if (!s) return null;
  const m = moment.tz(s, "MMMM YYYY", true, TZ);
  return m.isValid() ? m : null;
};
const readEntries = (filePath) => {
  const raw = fs.readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("regos.json must be an array");
  return arr.map(x => ({
    rego: String(x.rego || "").trim().toUpperCase(),
    renter: String(x.renter || "").trim(),
    paymentDay: String(x.paymentDay || "").trim(), // Monday..Sunday
    rentAmount: Number(x.rentAmount || 0),
    phone: x.phone ? String(x.phone).replace(/[^\d]/g, "") : "" // 614...
  })).filter(e => e.rego && e.renter && e.paymentDay);
};
const weekdayToday = () => moment.tz(TZ).format("dddd");
const enc = (s) => encodeURIComponent(s);

// ---------- generic page helpers ----------
const tryDismissBanners = async (page) => {
  const sels = [
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
    'button:has-text("Got it")',
    'text=Accept all',
    '[aria-label*="consent" i]',
  ];
  for (const sel of sels) {
    const el = page.locator(sel).first();
    try { if (await el.count()) await el.click({ timeout: 600 }); } catch {}
    for (const fr of page.frames()) {
      const fel = fr.locator(sel).first();
      try { if (await fel.count()) await fel.click({ timeout: 600 }); } catch {}
    }
  }
};

const findInAnyFrame = async (page, selector, { timeout = 60000, state = "visible" } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { await page.locator(selector).first().waitFor({ state, timeout: 300 }); return page.mainFrame(); } catch {}
    for (const fr of page.frames()) {
      try { await fr.locator(selector).first().waitFor({ state, timeout: 300 }); return fr; } catch {}
    }
    await page.waitForTimeout(200);
  }
  return null;
};

// Robustly set NSW in e-Toll custom dropdown
async function setEtollStateNSW(frame) {
  const state = frame.locator("#stateShortName");
  await state.waitFor({ state: "visible", timeout: 30000 });
  await state.click({ delay: 60 });
  await state.fill("");
  await state.type("NSW", { delay: 80 });
  await state.press("Enter").catch(() => {});

  const gotValid = async () => (await state.getAttribute("data-isvalid")) === "true";
  if (!(await gotValid())) {
    await state.press("ArrowDown").catch(() => {});
    await state.press("Enter").catch(() => {});
  }

  if (!(await gotValid())) {
    const option = frame.locator(
      '.dropdown-menu >> text=/^NSW$/i, [role="listbox"] >> text=/^NSW$/i, .list-group-item >> text=/^NSW$/i'
    ).first();
    if (await option.isVisible().catch(() => false)) {
      await option.click().catch(() => {});
    }
  }

  if (!(await gotValid())) {
    await frame.evaluate(() => {
      const el = document.querySelector("#stateShortName");
      if (!el) return;
      el.value = "NSW";
      el.setAttribute("data-isvalid", "true");
      el.setAttribute("data-isopen", "false");
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      el.blur();
    });
  }

  await state.blur().catch(() => {});
  await frame.waitForTimeout(150);
}

// ---------- scraping (fresh context per rego = clean storage) ----------
// Linkt
async function scrapeLinktForRego(browser, entry) {
  const { rego } = entry;
	const context = await newStealthContext(browser);
  const page = await context.newPage();

  await page.goto(LINKT_URL, { waitUntil: "domcontentloaded" });
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  await page.fill("#txtRegistrationNumber", rego);
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.click("#searchLink"),
  ]);

  const table = await page.waitForSelector("#additionalResults", { state: "visible", timeout: 15000 }).catch(() => null);
  if (!table) {
    await context.close();
    return { notices: [], noResultsMessage: `No Linkt table found for ${rego}.` };
  }

  const rows = await page.$$("#additionalResults tbody tr");
  const notices = [];
  for (const row of rows) {
    const tds = await row.$$("td");
    if (tds.length < 4) continue;

    const getText = async (i) => (tds[i] ? (await tds[i].innerText()).trim() : "");
    const abbr = tds[4] ? await tds[4].$("abbr") : null;
    const tripStatus = abbr ? (await abbr.innerText()).trim() : await getText(4);
    const tripStatusDetail = abbr ? ((await abbr.getAttribute("title")) || "").trim() : "";
    const checkbox = tds[0] ? await tds[0].$("input[type=checkbox]") : null;

    const rowId = checkbox ? await checkbox.getAttribute("value") : null;
    const isPayable = checkbox ? ((await checkbox.getAttribute("ispayable")) === "True") : false;

    const lpn = await getText(1);
    const motorway = await getText(2);
    const issuedText = await getText(3);
    const adminFeeText = await getText(5);
    const tollText = await getText(6);

    const issuedMoment = parseIssuedMonth(issuedText);
    notices.push({
      rego,
      source: "linkt",
      rowId,
      isPayable,
      lpn,
      motorway,
      issuedText,
      issuedISO: issuedMoment ? issuedMoment.toISOString() : null,
      tripStatus,
      tripStatusDetail,
      adminFeeText,
      adminFee: parseMoney(adminFeeText),
      tollAmountText: tollText,
      tollAmount: parseMoney(tollText),
    });
  }

  await context.close();
  return { notices };
}

// e-Toll
async function scrapeEtollForRego(browser, entry) {
  const { rego } = entry;
  const context = await newStealthContext(browser);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  // Small helper: try clicking common consent banners
  const clickConsents = async () => {
    const sels = [
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'button:has-text("Got it")',
      'text=Accept all',
      '[aria-label*="consent" i]',
    ];
    for (const sel of sels) {
      try { const el = page.locator(sel).first(); if (await el.count()) await el.click({ timeout: 500 }); } catch {}
      for (const fr of page.frames()) {
        try { const el = fr.locator(sel).first(); if (await el.count()) await el.click({ timeout: 500 }); } catch {}
      }
    }
  };

  // Search across frames for any of the rego selectors
  const regoSelectors = '#rego, input[name="rego"], input[placeholder*="LICENCE PLATE" i], input[aria-label*="Licence Plate" i]';
  const findRegoInAnyFrame = async (timeoutMs = 65000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        // Try main frame first
        const loc = page.locator(regoSelectors).first();
        if (await loc.count()) return page.mainFrame();
      } catch {}
      // Then child frames
      for (const fr of page.frames()) {
        try {
          const loc = fr.locator(regoSelectors).first();
          if (await loc.count()) return fr;
        } catch {}
      }
      await page.waitForTimeout(200);
    }
    return null;
  };

  // EXACT dropdown interaction you wanted
  const clickArrowAndPickNSW = async (frame) => {
    const arrow = frame.locator('#pickListCaret, span.arrow-box').first();
    await arrow.waitFor({ state: "visible", timeout: 30000 });
    await arrow.click({ force: true });

    const nsw = frame.locator('item[data-value="NSW"]').first();
    await nsw.waitFor({ state: "visible", timeout: 10000 });
    await nsw.click({ force: true });

    // Click outside (rego) to close
    const outside = frame.locator(regoSelectors).first();
    await outside.waitFor({ state: "visible", timeout: 5000 });
    await outside.click({ force: true });

    // Verify selection stuck
    await frame.waitForFunction(() => {
      const el = document.querySelector("#stateShortName");
      return el && el.value.toUpperCase() === "NSW" &&
             el.getAttribute("data-isvalid") === "true" &&
             el.getAttribute("data-isopen") !== "true";
    }, null, { timeout: 5000 }).catch(() => {});
  };

  // Wait for either results or "No Toll Trips found" modal
  const waitForEtollOutcome = async (timeoutMs = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Modal?
      for (const fr of page.frames()) {
        const title = fr.locator(".modal-dialog .modal-title").first();
        if (await title.isVisible({ timeout: 100 }).catch(() => false)) {
          const txt = (await title.innerText().catch(() => "")).trim();
          if (/No Toll Trips found/i.test(txt)) return { type: "none", frame: fr };
        }
      }
      // Results?
      for (const fr of page.frames()) {
        const section = fr.locator("section.tollnotices").first();
        if (await section.isVisible({ timeout: 100 }).catch(() => false)) {
          return { type: "results", frame: fr };
        }
      }
      await page.waitForTimeout(120);
    }
    return { type: "timeout" };
  };

  try {
    await page.goto(ETOLL_URL, { waitUntil: "domcontentloaded" });
    // cleansing
    await page.addInitScript(() => { try { localStorage.clear(); } catch {}; try { sessionStorage.clear(); } catch {}; });
    await page.reload({ waitUntil: "domcontentloaded" });

    // Give the SPA time to hydrate in headless
    await page.waitForLoadState("networkidle").catch(() => {});
    await clickConsents();

    // Find rego in any frame (attached first, then ensure visible)
    const formFrame = await findRegoInAnyFrame(65000);
    if (!formFrame) {
      // Optional: drop a screenshot for debugging
      try { await page.screenshot({ path: `etoll_rego_missing_${rego}.png`, fullPage: true }); } catch {}
      await context.close();
      return { notices: [], noResultsMessage: `e-Toll: rego field not found for ${rego}.` };
    }

    const regoField = formFrame.locator(regoSelectors).first();
    await regoField.scrollIntoViewIfNeeded().catch(() => {});
    await regoField.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});

    // Type (not just fill) to trigger oninput validators
    await regoField.click({ force: true });
    await regoField.fill("");
    await regoField.type(rego, { delay: 60 });

    // Select NSW
    await clickArrowAndPickNSW(formFrame);

    // Submit
    const submitBtn = formFrame.locator("#searchTollNoticesForm_0");
    if (await submitBtn.count()) {
      await submitBtn.click({ force: true }).catch(async () => {
        await submitBtn.press("Enter").catch(() => {});
      });
    } else {
      // Fallback: press Enter in any field
      await regoField.press("Enter").catch(() => {});
    }

    // Outcome
    const outcome = await waitForEtollOutcome(35000);

    if (outcome.type === "none") {
      await outcome.frame
        .locator('#closeErrorBtn, .modal-footer button:has-text("Close")')
        .first()
        .click({ timeout: 1000 })
        .catch(() => {});
      await context.close();
      return { notices: [], noResultsMessage: `e-Toll: No toll trips found for ${rego} (SHB/SHT).` };
    }

    if (outcome.type === "timeout") {
      await context.close();
      return { notices: [], noResultsMessage: `e-Toll: Timed out waiting for results/modals for ${rego}.` };
    }

    // Parse results
    const resFrame = outcome.frame;
    const rowLoc = resFrame.locator("section.tollnotices label.tollnotice-item");
    const count = await rowLoc.count().catch(() => 0);

    if (count === 0) {
      await context.close();
      return { notices: [], noResultsMessage: `e-Toll: No unpaid notices listed for ${rego}.` };
    }

    const notices = [];
    for (let i = 0; i < count; i++) {
      const row = rowLoc.nth(i);

      const md = row.locator(".hidden-sm.hidden-xs.visible-md.visible-lg");
      let tollRoad = "", letter = "", chargeText = "";

      if (await md.count()) {
        const cells = md.locator(":scope > div");
        tollRoad   = (await cells.nth(1).innerText().catch(() => "")).trim();
        const lt   = (await cells.nth(2).innerText().catch(() => "")).trim();
        letter     = (lt.split(/\s+/)[0] || "").trim();
        chargeText = (await md.locator(".fee").first().innerText().catch(() => "")).trim();
      } else {
        const sm = row.locator(".visible-sm.visible-xs.hidden-md.hidden-lg");
        const whole = (await sm.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const mLetter = whole.match(/letter\s+([0-9A-Z]+)/i);
        letter = mLetter ? mLetter[1] : "";
        chargeText = (await sm.locator(".fee").first().innerText().catch(() => "")).trim();
        const mRoad = whole.match(/\b(Sydney Harbour Tunnel|Sydney Harbour Bridge|Lane Cove Tunnel|WestConnex|M[0-9A-Z ]+|[A-Z][A-Za-z ]+)\b/);
        tollRoad = mRoad ? mRoad[1] : "e-Toll Road";
      }

      notices.push({
        rego,
        lpn: rego,
        source: "etoll",
        rowId: await row.locator("input.tollnotice-list-cb").getAttribute("value").catch(() => null),
        motorway: tollRoad || "e-Toll Road",
        issuedText: "e-Toll",
        issuedISO: null,
        tripStatus: letter ? `Letter ${letter}` : "Unpaid",
        tripStatusDetail: letter ? `e-Toll letter ${letter}` : "e-Toll unpaid",
        adminFeeText: "—",
        adminFee: 0,
        tollAmountText: chargeText || "—",
        tollAmount: parseMoney(chargeText),
        isPayable: true
      });
    }

    await context.close();
    return { notices };
  } catch (e) {
    try { await page.screenshot({ path: `etoll_error_${rego}.png`, fullPage: true }); } catch {}
    await context.close();
    return { notices: [], noResultsMessage: `e-Toll error for ${rego}: ${e.message}` };
  }
}


// --- stealth context helper (helps headless find #rego on e-Toll) ---
const STEALTH_UA =
  process.env.STEALTH_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function newStealthContext(browser) {
  const context = await browser.newContext({
    timezoneId: TZ,
    locale: "en-AU",
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    hasTouch: false,
    userAgent: STEALTH_UA,
  });

  // Mask common headless signals
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, "webdriver", { get: () => false }); } catch {}
    try { window.chrome = { runtime: {} }; } catch {}
    try {
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-AU", "en"] });
    } catch {}
  });

  return context;
}


// ---------- Google Chat ----------
function buildMessages(entry, mode = "morning", totalsForMsg = null) {
  const amount = entry.rentAmount ? `$${entry.rentAmount.toFixed(2)}` : "$0.00";
  const isEvening = mode === "evening";

  // If totals available, format them; otherwise leave placeholders
  const hasTotals = !!(totalsForMsg && (totalsForMsg.toll > 0 || totalsForMsg.admin > 0));
  const tollStr   = hasTotals ? `$${totalsForMsg.toll.toFixed(2)}`  : "(toll amount)";
  const adminStr  = hasTotals && totalsForMsg.admin > 0 ? ` (admin $${totalsForMsg.admin.toFixed(2)})` : "";
  const totalStr  = hasTotals
    ? `$${(entry.rentAmount + totalsForMsg.toll + totalsForMsg.admin).toFixed(2)}`
    : "(total)";

  // ---------------- WhatsApp (bold via *) ----------------
  const waMorning =
`Hi ${entry.renter},

Please transfer the rental payment of *${amount}* for vehicle *${entry.rego}* by *5:00 PM today*.

*Account details*
ZARIWALA ENTERPRISES PTY LTD
BSB: 067873
Account number: 12127790

Thanks.`;

  const waMorningWithTolls =
`Hi ${entry.renter},

Please transfer *${amount}* +   (tolls) = $  for vehicle *${entry.rego}* by *5:00 PM today*.

*Account details*
ZARIWALA ENTERPRISES PTY LTD
BSB: 067873
Account number: 12127790

Thanks.`;

  const waEvening =
`Hi ${entry.renter},

*Second reminder:* Please transfer the rental payment of *${amount}* for vehicle *${entry.rego}* by *8:00 AM tomorrow*. The car will be *locked* after that.

*Account details*
ZARIWALA ENTERPRISES PTY LTD
BSB: 067873
Account number: 12127790

Thanks.`;

  const waEveningWithTolls =
`Hi ${entry.renter},

*Second reminder:* Please transfer *${amount}* +   (tolls) = $  for vehicle *${entry.rego}* by *8:00 AM tomorrow*. The car will be *locked* after that.

*Account details*
ZARIWALA ENTERPRISES PTY LTD
BSB: 067873
Account number: 12127790

Thanks.`;

  // ---------------- SMS (plain text, no asterisks) ----------------
  const smsMorning =
`Hi ${entry.renter},

Please transfer the rental payment of ${amount} for vehicle ${entry.rego} by 5:00 PM today.

Account details
ZARIWALA ENTERPRISES PTY LTD
BSB: 067873
Account number: 12127790

Thanks.`;

  const smsMorningWithTolls =
`Hi ${entry.renter},

Please transfer ${amount} +   (tolls) = $  for vehicle ${entry.rego} by 5:00 PM today.

Account details
ZARIWALA ENTERPRISES PTY LTD
BSB: 067873
Account number: 12127790

Thanks.`;

  const smsEvening =
`Hi ${entry.renter},

Second reminder: Please transfer the rental payment of ${amount} for vehicle ${entry.rego} by 8:00 AM tomorrow. The car will be locked after that.

Account details
ZARIWALA ENTERPRISES PTY LTD
BSB: 067873
Account number: 12127790

Thanks.`;

  const smsEveningWithTolls =
`Hi ${entry.renter},

Second reminder: Please transfer ${amount} +   (tolls) = $  for vehicle ${entry.rego} by 8:00 AM tomorrow. The car will be locked after that.

Account details
ZARIWALA ENTERPRISES PTY LTD
BSB: 067873
Account number: 12127790

Thanks.`;

  const waMsg       = isEvening ? waEvening       : waMorning;
  const waMsgTolls  = isEvening ? waEveningWithTolls  : waMorningWithTolls;
  const smsMsg      = isEvening ? smsEvening      : smsMorning;
  const smsMsgTolls = isEvening ? smsEveningWithTolls : smsMorningWithTolls;

  return { waMsg, waMsgTolls, smsMsg, smsMsgTolls, amount, isEvening };
}



async function sendCardForEntry(entry, notices, noResultsMessage, { mode = "morning", includeTolls = true } = {}) {
  const headerTitle = "Rent & Toll Notices";
  const headerSubtitle = moment().tz(TZ).format("ddd, DD MMM YYYY h:mm A z");

  // --- compute totals early so we can inject into the with-tolls messages ---
  let totalsForMsg = null;
  if (includeTolls && Array.isArray(notices) && notices.length > 0) {
    const totals = notices.reduce((acc, n) => {
      acc.admin += n.adminFee || 0;
      acc.toll  += n.tollAmount || 0;
      return acc;
    }, { admin: 0, toll: 0 });
    if (totals.admin > 0 || totals.toll > 0) totalsForMsg = totals;
  }

  const { waMsg, waMsgTolls, smsMsg, smsMsgTolls, amount, isEvening } = buildMessages(entry, mode, totalsForMsg);

  // Links
  const waBase   = entry.phone ? `https://wa.me/${entry.phone}?text=${enc(waMsg)}`         : `https://wa.me/?text=${enc(waMsg)}`;
  const waTolls  = entry.phone ? `https://wa.me/${entry.phone}?text=${enc(waMsgTolls)}`    : `https://wa.me/?text=${enc(waMsgTolls)}`;
  const smsBase  = entry.phone ? `sms:${entry.phone}?&body=${enc(smsMsg)}`                  : `sms:?&body=${enc(smsMsg)}`;
  const smsTolls = entry.phone ? `sms:${entry.phone}?&body=${enc(smsMsgTolls)}`             : `sms:?&body=${enc(smsMsgTolls)}`;

  const sections = [];

  // Title (bold)
  sections.push({ widgets: [ { textParagraph: { text: `🚗 <b>${entry.rego} — ${entry.renter}</b>` } } ] });

  // Rent line
  sections.push({
    widgets: [
      { textParagraph: { text: isEvening
        ? `💸 <b>Second reminder</b> • Due by <b>8:00 AM tomorrow</b> • Amount: <b>${amount}</b> • Day: <b>${entry.paymentDay}</b>`
        : `💸 <b>Rent due today</b> • Due by <b>5:00 PM</b> • Amount: <b>${amount}</b> • Day: <b>${entry.paymentDay}</b>`
      } }
    ]
  });

  // Toll info sections only when we scraped (morning)
  if (includeTolls) {
    if (noResultsMessage) {
      sections.push({ widgets: [{ textParagraph: { text: `⚠️ ${noResultsMessage}` } }] });
    }

    if (notices.length > 0) {
      const totals = notices.reduce((acc, n) => {
        acc.admin += n.adminFee || 0;
        acc.toll  += n.tollAmount || 0;
        return acc;
      }, { admin: 0, toll: 0 });

      sections.push({
        widgets: [
          { textParagraph: { text: `🧾 <b>Toll totals</b> • Admin: <b>$${totals.admin.toFixed(2)}</b> • Tolls: <b>$${totals.toll.toFixed(2)}</b>` } }
        ]
      });

      const byMonth = {};
      const order = [];
      for (const n of notices) {
        const key = n.issuedText || "Date unknown";
        if (!byMonth[key]) { byMonth[key] = []; order.push(key); }
        byMonth[key].push(n);
      }
      for (const month of order) {
        const items = byMonth[month].map(r => {
          const status = r.tripStatus || "—";
          const fee = r.adminFeeText || "—";
          const toll = r.tollAmountText || "—";
          const pay = r.isPayable ? "✅" : "⛔️";
          const src = r.source === "etoll" ? " (e-Toll)" : "";
          return `• ${r.motorway}${src} — <i>${status}</i> — Admin: <b>${fee}</b>, Toll: <b>${toll}</b> ${pay}`;
        }).join("<br>");
        sections.push({ widgets: [{ textParagraph: { text: `📅 <b>${month}</b><br>${items}` } }] });
      }
    } else if (!noResultsMessage) {
      sections.push({ widgets: [{ textParagraph: { text: "ℹ️ No toll notices found for this rego in the selected window." } }] });
    }
  }

  // Row 1: base reminder (icon-only)
  sections.push({
    widgets: [
      {
        buttons: [
          { textButton: { text: "🟢", onClick: { openLink: { url: waBase  } } } }, // WhatsApp (base)
          { textButton: { text: "💬", onClick: { openLink: { url: smsBase } } } }  // SMS (base)
        ]
      }
    ]
  });

  // Row 2: with-tolls reminder (icon-only) — works for morning (auto totals) & evening (placeholders)
  sections.push({
    widgets: [
      {
        buttons: [
          { textButton: { text: "🟢➕", onClick: { openLink: { url: waTolls  } } } }, // WhatsApp with tolls
          { textButton: { text: "💬➕", onClick: { openLink: { url: smsTolls } } } }  // SMS with tolls
        ]
      }
    ]
  });

  // Footer links: Linkt + e-Toll
  sections.push({
    widgets: [
      {
        buttons: [
          { textButton: { text: "🔗", onClick: { openLink: { url: LINKT_URL } } } },
          { textButton: { text: "🛣️", onClick: { openLink: { url: ETOLL_URL } } } }
        ]
      }
    ]
  });

  const message = { cards: [ { header: { title: headerTitle, subtitle: headerSubtitle }, sections } ] };
  await postToChat(message);
}


async function postToChat(message) {
  if (!GOOGLE_CHAT_WEBHOOK_URL) {
    console.warn("No GOOGLE_CHAT_WEBHOOK_URL, printing message payload:");
    console.dir(message, { depth: null });
    return;
  }
  const res = await fetch(GOOGLE_CHAT_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(message)
  });
  if (!res.ok) console.error("❌ Google Chat send failed:", res.status, await res.text());
  else console.log(`✅ Sent to Google Chat at ${new Date().toUTCString()}`);
}

// ---------- main job (08:00 & 17:00 Australia/Sydney) ----------
async function runForToday(mode = "morning") {
  const entries = readEntries(REGOS_FILE);
  const todayName = weekdayToday();
  const dueToday = entries.filter(e => e.paymentDay.toLowerCase() === todayName.toLowerCase());

  if (dueToday.length === 0) {
    console.log(`[${moment().tz(TZ).format()}] No payments due today (${todayName}).`);
    return;
  }

  const includeTolls = mode === "morning"; // <-- only morning scrapes tolls

  if (!includeTolls) {
    // Evening: no scraping at all, just send cards
    for (const entry of dueToday) {
      console.log(`(Evening) Reminder for ${entry.rego} — ${entry.renter}`);
      await sendCardForEntry(entry, [], null, { mode: "evening", includeTolls: false });
    }
    return;
  }

  // Morning: scrape and include tolls
  const daysCutoff = moment.tz(TZ).startOf("day").clone().subtract(DAYS_TO_CHECK, "days");
  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    for (const entry of dueToday) {
      console.log(`(Morning) Processing ${entry.rego} — ${entry.renter}`);

      const { notices: linkt = [], noResultsMessage: linktMsg } = await scrapeLinktForRego(browser, entry);
      const { notices: etoll = [], noResultsMessage: etollMsg } = await scrapeEtollForRego(browser, entry);

      const combined = [...linkt, ...etoll].filter(n => {
        if (!n.issuedISO) return true;
        return moment(n.issuedISO).isSameOrAfter(daysCutoff);
      }).sort((a, b) => (Date.parse(b.issuedISO || 0) - Date.parse(a.issuedISO || 0)));

      const infoMsg = [linktMsg, etollMsg].filter(Boolean).join(" • ") || null;

      await sendCardForEntry(entry, combined, infoMsg, { mode: "morning", includeTolls: true });
    }
  } catch (e) {
    console.error("Run error:", e);
  } finally {
    await browser.close();
  }
}

// Run immediately (testing; uses morning style)
runForToday("morning");
runForToday("evening");

// Daily at 08:00 and 17:00 Sydney time
cron.schedule("0 8 * * *", () => {
  console.log(`[Scheduler] 8:00 AM job fired (${moment().tz(TZ).format()})`);
  runForToday("morning");
}, { timezone: TZ });

cron.schedule("0 17 * * *", () => {
  console.log(`[Scheduler] 5:00 PM job fired (${moment().tz(TZ).format()})`);
  runForToday("evening");
}, { timezone: TZ });
