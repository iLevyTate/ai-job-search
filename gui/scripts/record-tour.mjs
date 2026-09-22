/**
 * Screen demo of the demo Desk.
 *
 * The picture is the application. A normal cursor moves to each control,
 * and the view eases in around that cursor, then eases back out.
 * Chat is the demo replay: it does not start Claude Code.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI = join(HERE, "..");
const REPO = join(GUI, "..");
const OUT_DIR = join(REPO, "assets");
const RAW_DIR = join(OUT_DIR, `desk-tour-raw-${Date.now()}`);
const FINAL = join(OUT_DIR, "desk-tour.mp4");
const PORT = Number(process.env.JOB_SEARCH_GUI_PORT || 8770);
const URL = `http://127.0.0.1:${PORT}/`;
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;

const mouse = { x: WIDTH / 2, y: HEIGHT / 2 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", windowsHide: true, cwd });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function startDesk() {
  const child = spawn(process.execPath, ["server.mjs", "--demo"], {
    cwd: GUI,
    env: {
      ...process.env,
      JOB_SEARCH_DEMO: "1",
      JOB_SEARCH_DEMO_PACE: "film",
      JOB_SEARCH_GUI_NO_BROWSER: "1",
      JOB_SEARCH_GUI_PORT: String(PORT),
      JOB_SEARCH_CLAUDE_CHROME: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += String(chunk);
      if (/http:\/\/127\.0\.0\.1:\d+/.test(output) || /Desk/i.test(output)) {
        cleanup();
        resolve(child);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(child);
    }, 8000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) reject(new Error(`desk server exited ${code}\n${output}`));
    });
  });
}

async function waitForDesk(page) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
        return;
      }
    } catch {
      // still starting
    }
    await sleep(250);
  }
  throw new Error(`Desk did not start on ${URL}`);
}

async function film(page, fn, ...args) {
  return page.evaluate(fn, ...args);
}

async function seatChrome(page) {
  await film(page, () => {
    const sheet = document.getElementById("sheet");
    const cursor = document.getElementById("tour-cursor");
    if (cursor) (sheet?.open ? sheet : document.documentElement).append(cursor);
    const host = sheet?.open ? sheet : document.body;
    for (const id of ["tour-matte-top", "tour-matte-bot", "tour-spot", "tour-card"]) {
      const el = document.getElementById(id);
      if (el && el.parentElement !== host) host.append(el);
    }
  });
}

async function quiet(page) {
  await film(page, () => document.getElementById("tour-matte-bot")?.classList.remove("lit"));
  await sleep(180);
}

async function say(page, step, line) {
  await seatChrome(page);
  await film(page, ([nextStep, nextLine]) => {
    const stepEl = document.getElementById("tour-step");
    const lineEl = document.getElementById("tour-line");
    const matte = document.getElementById("tour-matte-bot");
    if (stepEl) stepEl.textContent = nextStep;
    if (lineEl) lineEl.textContent = nextLine;
    matte?.classList.add("lit");
  }, [step, line]);
}

async function card(page, kicker, title, line, holdMs = 1700) {
  await seatChrome(page);
  await film(page, ([nextKicker, nextTitle, nextLine]) => {
    const el = document.getElementById("tour-card");
    const k = document.getElementById("tour-card-kicker");
    const t = document.getElementById("tour-card-title");
    const n = document.getElementById("tour-card-line");
    if (k) k.textContent = nextKicker;
    if (t) t.textContent = nextTitle;
    if (n) n.textContent = nextLine;
    if (!el) return;
    el.style.transition = "none";
    el.classList.add("on");
    void el.offsetHeight;
    el.style.transition = "";
  }, [kicker, title, line]);
  await sleep(holdMs);
  await film(page, () => document.getElementById("tour-card")?.classList.remove("on"));
  await sleep(640);
}

const cam = { tx: 0, ty: 0, s: 1 };

function frameFor(box, maxScale = 1.28) {
  const padX = 72;
  const padY = 64;
  let s = Math.min(maxScale, (WIDTH - padX * 2) / box.w, (HEIGHT - padY * 2) / box.h);
  if (!Number.isFinite(s) || s < 1) s = 1;
  let tx = (WIDTH - box.w * s) / 2 - box.x * s;
  let ty = (HEIGHT - box.h * s) / 2 - box.y * s;
  tx = Math.min(0, Math.max(tx, -120));
  ty = Math.min(0, Math.max(ty, -48));
  return { tx, ty, s };
}

async function layoutBox(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return null;
  return {
    x: (box.x - cam.tx) / cam.s,
    y: (box.y - cam.ty) / cam.s,
    w: box.width / cam.s,
    h: box.height / cam.s,
  };
}

async function paintCamera(page) {
  await page.evaluate(({ tx, ty, s }) => {
    document.body.style.transformOrigin = "0 0";
    document.body.style.transition = "none";
    document.body.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }, { tx: cam.tx, ty: cam.ty, s: cam.s });
}

async function moveCamera(page, next, ms = 820, stick = null) {
  const from = { ...cam };
  const frames = Math.max(18, Math.round(ms / (1000 / FPS)));
  const started = Date.now();
  for (let i = 1; i <= frames; i += 1) {
    const e = easeInOut(i / frames);
    cam.tx = from.tx + (next.tx - from.tx) * e;
    cam.ty = from.ty + (next.ty - from.ty) * e;
    cam.s = from.s + (next.s - from.s) * e;
    await paintCamera(page);
    if (stick) {
      const live = await stick.boundingBox();
      if (live) await page.mouse.move(live.x + Math.min(live.width * 0.42, 220), live.y + Math.min(live.height * 0.45, 36));
    }
    const wait = started + (ms * i) / frames - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

async function frame(page, locator, { maxScale = 1.28, hold = 0, ms = 820 } = {}) {
  const box = await layoutBox(page, locator);
  if (!box) return;
  await moveCamera(page, frameFor(box, maxScale), ms, locator);
  if (hold) await sleep(hold);
}

async function frameUnion(page, locators, options = {}) {
  const boxes = [];
  for (const locator of locators) {
    if (await locator.count()) {
      const box = await layoutBox(page, locator);
      if (box) boxes.push(box);
    }
  }
  if (!boxes.length) return;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  await moveCamera(page, frameFor({ x, y, w: right - x, h: bottom - y }, options.maxScale ?? 1.22), options.ms ?? 820, locators[0]);
  if (options.hold) await sleep(options.hold);
}

async function wide(page) {
  await moveCamera(page, { tx: 0, ty: 0, s: 1 }, 780);
}

async function clickPulse(page) {
  await film(page, () => {
    const cursor = document.getElementById("tour-cursor");
    if (!cursor) return;
    cursor.classList.add("down");
    setTimeout(() => cursor.classList.remove("down"), 180);
  });
}

async function glide(page, x, y, ms = 640) {
  const from = { ...mouse };
  const frames = Math.max(12, Math.round(ms / (1000 / FPS)));
  const started = Date.now();
  for (let i = 1; i <= frames; i += 1) {
    const e = easeInOut(i / frames);
    mouse.x = from.x + (x - from.x) * e;
    mouse.y = from.y + (y - from.y) * e;
    await page.mouse.move(mouse.x, mouse.y);
    const due = started + (ms * i) / frames;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

async function travel(page, locator, ms = 640) {
  await locator.waitFor({ state: "visible", timeout: 15000 });
  const box = await locator.boundingBox();
  if (box) {
    await glide(page, box.x + box.width * 0.55, box.y + box.height * 0.48, ms);
    await sleep(140);
  }
}

async function pointClick(page, locator) {
  await travel(page, locator);
  await clickPulse(page);
  await locator.click();
  await sleep(160);
}

async function typeSlow(locator, text) {
  await locator.click();
  await locator.fill("");
  await locator.pressSequentially(text, { delay: 28 });
  await sleep(140);
}

async function installFilmChrome(page) {
  await film(page, () => {
    const gate = document.getElementById("gate");
    if (gate) {
      gate.hidden = true;
      gate.inert = true;
      gate.setAttribute("aria-hidden", "true");
    }
    const banner = document.getElementById("demo-banner");
    if (banner) banner.hidden = true;
    const account = document.getElementById("account-label");
    if (account) {
      const paint = () => {
        if (/@/.test(account.textContent || "")) account.textContent = "Signed in";
      };
      paint();
      new MutationObserver(paint).observe(account, { childList: true, characterData: true, subtree: true });
    }
    document.getElementById("tour-blackout")?.remove();
    if (document.getElementById("tour-card")) return;

    const style = document.createElement("style");
    style.textContent = `
      html.tour, body.tour { background: #070605 !important; }
      body.tour {
        padding: 56px 0 128px;
        height: 100%;
      }
      body.tour #demo-banner { display: none !important; }
      /* Headless Chromium paints in software. Blur and blend layers cost
         more than a frame budget at 1080p, so the film trades them for a
         flat dim that reads the same after compression. */
      body.tour .grain, body.tour .atmosphere, body.tour .vignette, body.tour .workline, body.tour .scrim { display: none !important; }
      body.tour * { backdrop-filter: none !important; }
      body.tour .sheet::backdrop {
        backdrop-filter: none !important;
        background: rgba(8, 6, 4, 0.8);
      }
      /* The stock dialog rises 12px and then snaps. The film fades it
         and moves the camera instead, so the type never jumps. */
      body.tour .sheet[open] { animation: tour-fade 0.45s ease !important; }
      @keyframes tour-fade { from { opacity: 0; } to { opacity: 1; } }
      #tour-camera, body.tour #sheet-form {
        transform-origin: 0 0;
        transition: transform 1.05s cubic-bezier(0.45, 0, 0.2, 1);
      }
      #tour-matte-top, #tour-matte-bot, #tour-card, #tour-spot, #tour-cursor {
        pointer-events: none;
      }
      #tour-matte-top, #tour-matte-bot {
        position: fixed;
        left: 0;
        right: 0;
        z-index: 2147483646;
        background: #070605;
      }
      #tour-matte-top {
        top: 0;
        height: 56px;
        border-bottom: 1px solid rgba(208, 138, 58, 0.18);
      }
      #tour-matte-bot {
        bottom: 0;
        height: 128px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 0 4.5rem 0.2rem;
        border-top: 1px solid rgba(208, 138, 58, 0.18);
        opacity: 0;
        transition: opacity 0.55s cubic-bezier(0.22, 1, 0.36, 1);
      }
      #tour-matte-bot.lit { opacity: 1; }
      #tour-step {
        margin: 0 0 0.4rem;
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 0.72rem;
        letter-spacing: 0.28em;
        text-transform: uppercase;
        color: #d08a3a;
      }
      #tour-line {
        margin: 0;
        max-width: 38rem;
        font-family: Fraunces, "Iowan Old Style", Georgia, serif;
        font-size: 1.65rem;
        font-weight: 500;
        line-height: 1.22;
        letter-spacing: -0.03em;
        color: #f4ebd8;
      }
      #tour-spot {
        position: fixed;
        inset: 0;
        z-index: 2147483645;
        opacity: 0;
        transition: opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1);
        background: radial-gradient(
          circle at var(--sx, 50%) var(--sy, 50%),
          transparent 0,
          transparent var(--sr, 120px),
          rgba(7, 6, 5, 0.52) calc(var(--sr, 120px) + 90px)
        );
      }
      #tour-spot.on { opacity: 1; }
      #tour-cursor {
        position: fixed;
        top: 0;
        left: 0;
        z-index: 2147483647;
        width: 20px;
        height: 20px;
        margin: -10px 0 0 -10px;
        border: 1.5px solid #d08a3a;
        border-radius: 50%;
        background: rgba(208, 138, 58, 0.2);
        box-shadow: 0 0 0 7px rgba(208, 138, 58, 0.08), 0 0 24px rgba(208, 138, 58, 0.18);
        transform: translate(-40px, -40px);
        transition: none;
      }
      #tour-cursor.down {
        width: 14px;
        height: 14px;
        margin: -7px 0 0 -7px;
        background: rgba(208, 138, 58, 0.45);
      }
      #tour-card {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        background: #070605;
        opacity: 0;
        transition: opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1);
      }
      #tour-card.on { opacity: 1; }
      #tour-card-kicker {
        margin: 0 0 1.1rem;
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 0.74rem;
        letter-spacing: 0.36em;
        text-transform: uppercase;
        color: #d08a3a;
      }
      #tour-card-title {
        margin: 0;
        font-family: Fraunces, "Iowan Old Style", Georgia, serif;
        font-size: 4.1rem;
        font-weight: 520;
        line-height: 0.98;
        letter-spacing: -0.045em;
        color: #f4ebd8;
      }
      #tour-card-line {
        margin: 1.35rem 0 0;
        max-width: 28rem;
        font-family: Newsreader, "Iowan Old Style", Georgia, serif;
        font-size: 1.2rem;
        line-height: 1.4;
        color: #b3a594;
      }
      #tour-card-rule {
        width: 3.2rem;
        height: 1px;
        margin: 1.5rem 0 0;
        background: rgba(208, 138, 58, 0.55);
      }
    `;
    document.head.append(style);
    document.documentElement.classList.add("tour");
    document.body.classList.add("tour");

    const top = document.createElement("div");
    top.id = "tour-matte-top";
    const bot = document.createElement("div");
    bot.id = "tour-matte-bot";
    bot.innerHTML = `<p id="tour-step"></p><p id="tour-line"></p>`;
    const spotEl = document.createElement("div");
    spotEl.id = "tour-spot";
    const cursor = document.createElement("div");
    cursor.id = "tour-cursor";
    const cardEl = document.createElement("div");
    cardEl.id = "tour-card";
    cardEl.className = "on";
    cardEl.innerHTML = `
      <p id="tour-card-kicker">Job Search Desk</p>
      <h1 id="tour-card-title">Paste a job.</h1>
      <div id="tour-card-rule"></div>
      <p id="tour-card-line">Get a CV. Claude writes it. You send it.</p>
    `;
    document.body.append(top, bot, spotEl, cursor, cardEl);
    const camera = document.createElement("div");
    camera.id = "tour-camera";
    const tourIds = new Set(["tour-matte-top", "tour-matte-bot", "tour-spot", "tour-cursor", "tour-card", "tour-camera"]);
    for (const node of [...document.body.childNodes]) {
      if (node.nodeType === 1 && tourIds.has(node.id)) continue;
      camera.append(node);
    }
    document.body.prepend(camera);

    document.addEventListener("mousemove", (event) => {
      cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
    }, true);
  });
}

async function settleType(page) {
  await page.evaluate(async () => {
    const faces = [
      "520 66px Fraunces",
      "500 19px Newsreader",
      "400 12px 'IBM Plex Mono'",
      "500 12px 'IBM Plex Mono'",
      "500 16px 'Bricolage Grotesque'",
      "600 16px 'Bricolage Grotesque'",
    ];
    await Promise.all(faces.map((face) => document.fonts.load(face).catch(() => [])));
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await sleep(240);
}

async function preparePicture(page) {
  page.setDefaultTimeout(20000);
  await page.locator('.steps button[data-action="setup"]').waitFor({ state: "visible", timeout: 20000 });
  await page.waitForFunction(async () => {
    const res = await fetch("/commands");
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body.commands) && body.commands.some((command) => command.id === "apply");
  }, null, { timeout: 15000 });
  await installFilmChrome(page);
  await useAppCamera(page);
  await settleType(page);
}

async function useAppCamera(page) {
  await film(page, () => {
    const wrapped = document.getElementById("tour-camera");
    if (wrapped) {
      while (wrapped.firstChild) document.body.insertBefore(wrapped.firstChild, wrapped);
      wrapped.remove();
    }
    document.body.style.padding = "0";
    document.body.style.transition = "none";
    for (const id of ["tour-matte-top", "tour-matte-bot", "tour-spot", "tour-card", "tour-blackout"]) {
      document.getElementById(id)?.remove();
    }
    const style = document.createElement("style");
    style.textContent = `
      body.tour { padding: 0 !important; }
      #tour-camera, body.tour #sheet-form { transition: transform 0.72s cubic-bezier(0.22, 1, 0.36, 1) !important; }
      body.tour #sheet { animation: none !important; overflow: visible; }
      #tour-cursor {
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        z-index: 2147483647 !important;
        width: 22px !important;
        height: 22px !important;
        margin: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        pointer-events: none !important;
        filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.45));
      }
    `;
    document.head.append(style);
    const cursor = document.getElementById("tour-cursor");
    if (cursor) {
      document.documentElement.append(cursor);
      cursor.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M4.2 2.2l14 8.2-6.2 1.3-2.2 6.1z" fill="#161616" stroke="#fff" stroke-width="1.35" stroke-linejoin="round"/></svg>`;
    }
    document.addEventListener("mousemove", (event) => {
      const el = document.getElementById("tour-cursor");
      if (!el) return;
      el.style.transform = `translate(${event.clientX - 4}px, ${event.clientY - 2}px)`;
    }, true);
  });
}

let captureAt = 0;

function markShot(marks, name) {
  const sec = Math.max(0, (Date.now() - captureAt) / 1000);
  marks.push({ name, sec });
  console.log(`shot ${name} ${sec.toFixed(1)}`);
}

async function openStep(page, action) {
  await pointClick(page, page.locator(`.steps button[data-action="${action}"]`));
}

async function fillSheet(page, fields) {
  await page.locator("#sheet[open]").waitFor({ state: "visible", timeout: 8000 });
  await seatChrome(page);
  await sleep(240);
  for (const [name, value] of fields) {
    const field = page.locator(`#sheet [name="${name}"]`);
    await travel(page, field, 480);
    await typeSlow(field, value);
  }
}

async function runSheet(page) {
  await pointClick(page, page.locator("#sheet-run"));
  await page.locator("#sheet[open]").waitFor({ state: "hidden", timeout: 8000 });
  await seatChrome(page);
}

async function waitReply(page, text) {
  await page.locator("#panel-chat").getByText(text).last().waitFor({ state: "visible", timeout: 25000 });
  await sleep(500);
}

async function walkthrough(page, marks) {
  const harbor = page.locator("#panel-jobs .job-row", { hasText: "Harbor Health" });
  const harborApp = page.locator("#panel-applications .app-row", { hasText: "Harbor Health" });
  await sleep(1100);

  await openStep(page, "setup");
  await fillSheet(page, [
    ["setupName", "Alex Rivera"],
    ["setupLocation", "Remote, United States"],
    ["setupTarget", "Staff AI engineer"],
  ]);
  await sleep(280);
  await runSheet(page);
  await waitReply(page, "Profile set.");
  markShot(marks, "find");

  await openStep(page, "scrape");
  await waitReply(page, "Found 5 openings.");
  markShot(marks, "rank");

  await openStep(page, "rank");
  await waitReply(page, "Harbor Health is an 88.");
  await pointClick(page, page.locator('[data-tab="jobs"]'));
  await page.locator("#panel-jobs").waitFor({ state: "visible", timeout: 8000 });
  await page.locator('[data-job-filter="all"]').click();
  const why = harbor.locator(".job-notes summary");
  await why.waitFor({ state: "visible", timeout: 10000 });
  await pointClick(page, why);
  await sleep(240);
  markShot(marks, "score");
  await frame(page, harbor, { maxScale: 1.26, hold: 2200 });
  markShot(marks, "apply");

  await wide(page);
  await openStep(page, "apply");
  await fillSheet(page, [["paste", "https://jobs.example.com/harbor-health-ml"]]);
  await sleep(240);
  await runSheet(page);
  const reply = page.locator("#panel-chat .msg", { hasText: "ready for you to read" }).last();
  await reply.waitFor({ state: "visible", timeout: 25000 });
  await frame(page, reply, { maxScale: 1.24, hold: 1800 });

  await pointClick(page, page.locator('[data-tab="applications"]'));
  await page.locator("#panel-applications").waitFor({ state: "visible", timeout: 8000 });
  const cv = harborApp.locator("[data-file]", { hasText: "CV" });
  await cv.waitFor({ state: "visible", timeout: 8000 });
  await pointClick(page, cv);
  const preview = page.locator("#panel-applications .artifact-text");
  await preview.waitFor({ state: "visible", timeout: 8000 });
  markShot(marks, "packet");
  await frameUnion(page, [harborApp, preview], { maxScale: 1.2, hold: 2200 });
  markShot(marks, "autofill");

  await wide(page);
  await openStep(page, "autofill");
  await fillSheet(page, [["url", "https://jobs.example.com/harbor-health-ml/apply"]]);
  await sleep(240);
  await runSheet(page);
  await waitReply(page, "You click Submit.");
  markShot(marks, "interview");

  await openStep(page, "interview");
  await waitReply(page, "prep is ready");
  await openStep(page, "outcome");
  await waitReply(page, "stays drafted");
  markShot(marks, "close");

  await wide(page);
  await sleep(1100);
  markShot(marks, "end");
}

/**
 * Playwright's built-in recorder pipes screencast frames into VP8 at 1 Mbit/s,
 * realtime preset, 25 fps: soft text and quantized timing. We take the same
 * screencast frames ourselves, keep their real timestamps, and let ffmpeg
 * resample to a constant frame rate with a proper x264 pass.
 */
async function startCapture(page) {
  const client = await page.context().newCDPSession(page);
  const frames = [];
  let pending = Promise.resolve();
  client.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = join(RAW_DIR, `f${String(frames.length).padStart(6, "0")}.jpg`);
    frames.push({ file, ts: metadata.timestamp });
    pending = pending.then(() => {
      writeFileSync(file, Buffer.from(data, "base64"));
      return client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
  });
  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: 90,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    everyNthFrame: 1,
  });
  return {
    frames,
    async stop() {
      const endedAt = Date.now() / 1000;
      await client.send("Page.stopScreencast").catch(() => {});
      await pending;
      await client.detach().catch(() => {});
      return endedAt;
    },
  };
}

function writeConcatList(frames, endedAt) {
  const lines = ["ffconcat version 1.0"];
  const minStep = 1 / FPS / 2;
  frames.forEach((frame, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].ts : endedAt;
    const duration = Math.max(next - frame.ts, minStep);
    lines.push(`file '${basename(frame.file)}'`, `duration ${duration.toFixed(4)}`);
  });
  lines.push(`file '${basename(frames.at(-1).file)}'`);
  const list = join(RAW_DIR, "frames.txt");
  writeFileSync(list, `${lines.join("\n")}\n`);
  return list;
}

async function encode(frames, endedAt) {
  const list = writeConcatList(frames, endedAt);
  const seconds = endedAt - frames[0].ts;
  const fadeOutAt = seconds > 2 ? (seconds - 1.05).toFixed(2) : "0";
  await run("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", relative(OUT_DIR, list).split("\\").join("/"),
    "-vf", [
      `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
      `fps=${FPS}`,
      "fade=t=in:st=0:d=0.25",
      `fade=t=out:st=${fadeOutAt}:d=0.45`,
      "format=yuv420p",
    ].join(","),
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "16",
    "-tune", "animation",
    "-an",
    "-movflags", "+faststart",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-color_range", "tv",
    basename(FINAL),
  ], OUT_DIR);
}

const VIEWS = [
  ["setup", "start", "find"],
  ["find", "find", "rank"],
  ["rank", "rank", "score"],
  ["score", "score", "apply"],
  ["apply", "apply", "autofill"],
  ["autofill", "autofill", "interview"],
  ["interview", "interview", "close"],
  ["close", "close", "end"],
];

async function encodeViews(frames, marks, endedAt) {
  const origin = frames[0].ts;
  const at = { start: 0, end: Math.max(0, endedAt - origin) };
  for (const mark of marks) at[mark.name] = mark.sec;
  const dir = join(OUT_DIR, "desk-tour-views");
  mkdirSync(dir, { recursive: true });
  for (const [id, from, to] of VIEWS) {
    const start = at[from];
    const end = at[to];
    if (start == null || end == null || end - start < 0.8) {
      console.log(`skip view ${id}`);
      continue;
    }
    const duration = end - start;
    const fadeOut = Math.max(0, duration - 0.4);
    await run("ffmpeg", [
      "-y",
      "-ss", start.toFixed(3),
      "-i", FINAL,
      "-t", duration.toFixed(3),
      "-vf", `fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.35,format=yuv420p`,
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "16",
      "-tune", "animation",
      "-an",
      "-movflags", "+faststart",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-color_range", "tv",
      join(dir, `${id}.mp4`),
    ], OUT_DIR);
    console.log(join(dir, `${id}.mp4`));
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  const desk = await startDesk();
  const browser = await chromium.launch({ headless: true, args: [`--window-size=${WIDTH},${HEIGHT}`] });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    const paint = () => {
      if (document.getElementById("tour-blackout")) return;
      const el = document.createElement("div");
      el.id = "tour-blackout";
      el.setAttribute("style", "position:fixed;inset:0;background:#070605;z-index:2147483647");
      (document.body || document.documentElement).append(el);
    };
    paint();
    document.addEventListener("DOMContentLoaded", paint);
  });
  const page = await context.newPage();
  let take = null;
  let endedAt = 0;
  const marks = [];
  try {
    await waitForDesk(page);
    await page.mouse.move(mouse.x, mouse.y);
    await preparePicture(page);
    take = await startCapture(page);
    captureAt = Date.now();
    await walkthrough(page, marks);
  } finally {
    if (take) endedAt = await take.stop();
    await context.close();
    await browser.close();
    desk.kill("SIGTERM");
  }
  if (!take?.frames.length) throw new Error("Screencast produced no frames");
  console.log(`captured ${take.frames.length} frames over ${(endedAt - take.frames[0].ts).toFixed(1)}s`);
  await encode(take.frames, endedAt);
  await encodeViews(take.frames, marks, endedAt);
  rmSync(RAW_DIR, { recursive: true, force: true });
  console.log(FINAL);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
