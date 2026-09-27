import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";
import { startDesk } from "../server.mjs";

// The desk binds 127.0.0.1 only, but so does every other program on the
// computer. Host and Origin checks stop web pages; they do nothing against a
// local process, which can send any headers it likes. These pin the
// per-launch token: the page gets it once in the launch link, keeps it as a
// cookie, and every route and the WebSocket refuse a caller without it.

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const REPO_ROOT = join(HERE, "..", "..");
const WRONG = "0".repeat(64);

// server.mjs keeps one desk per process, so each test boots and stops its own.
async function withDesk(options, testFn) {
  process.env.JOB_SEARCH_GUI_NO_BROWSER = "1";
  const desk = await startDesk({ root: REPO_ROOT, openBrowser: false, port: 0, ...options });
  const base = desk.href.replace(/\/$/, "");
  try {
    await testFn({
      desk,
      base,
      port: desk.port,
      auth: { Authorization: `Bearer ${desk.token}` },
      cookie: `desk_session_${desk.port}=${desk.token}`,
    });
  } finally {
    desk.stop();
  }
}

function fakeRuntime() {
  return {
    snapshot() {
      return { conversationId: "c1", controller: "chat", controllerGeneration: 1 };
    },
    eventsAfter() {
      return [];
    },
    subscribe() {
      return () => {};
    },
  };
}

function upgradeStatus(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    }, (res) => resolve(res.statusCode));
    req.on("upgrade", () => resolve(101));
    req.on("error", reject);
    req.end();
  });
}

test("the token is 32 random bytes, minted per desk, and never in the plain href", async () => {
  await withDesk({}, async ({ desk }) => {
    assert.match(desk.token, /^[0-9a-f]{64}$/);
    assert.equal(desk.launchHref, `${desk.href}?token=${desk.token}`);
    assert.equal(desk.href.includes("token"), false);
    await withDesk({}, async (second) => {
      assert.notEqual(second.desk.token, desk.token);
    });
  });
});

test("a request without the launch token answers 401 on every route", async () => {
  await withDesk({}, async ({ base }) => {
    const bare = await fetch(`${base}/workspace`);
    assert.equal(bare.status, 401);
    const body = await bare.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /launch link/);
    // What a local process would go for: print mode runs Claude with
    // permissions skipped. The Origin guard alone lets a non-browser through.
    const send = await fetch(`${base}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(send.status, 401);
    const paths = [
      "/",
      "/index.html",
      "/dist/desk.js",
      "/desk.css",
      "/events",
      "/auth/status",
      "/auth/meta",
      "/jobs",
      "/applications",
      "/progress",
      "/tools",
      "/commands",
      "/artifacts",
      "/artifacts/any/preview",
      "/update/status",
      "/chrome-extension/status",
      `/workspace-file?path=${encodeURIComponent("job_search_tracker.csv")}`,
      "/does-not-exist",
    ];
    for (const path of paths) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, path);
    }
    for (const path of ["/stop", "/reset", "/workspace/cli", "/auth/login", "/auth/install", "/auth/cancel", "/documents?name=cv.pdf&kind=cv", "/jobs/mark", "/workspace-file/open", "/update/download", "/chrome-extension/install"]) {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 401, path);
    }
  });
});

test("a wrong token answers 401 however it is presented", async () => {
  await withDesk({}, async ({ base, port, desk }) => {
    assert.equal((await fetch(`${base}/workspace`, { headers: { Authorization: `Bearer ${WRONG}` } })).status, 401);
    assert.equal((await fetch(`${base}/workspace`, { headers: { Cookie: `desk_session_${port}=${WRONG}` } })).status, 401);
    assert.equal((await fetch(`${base}/workspace?token=${WRONG}`)).status, 401);
    // A prefix, a longer string, or the right value under another desk's
    // cookie name does not pass either.
    assert.equal((await fetch(`${base}/workspace?token=${desk.token.slice(0, 63)}`)).status, 401);
    assert.equal((await fetch(`${base}/workspace?token=${desk.token}0`)).status, 401);
    assert.equal((await fetch(`${base}/workspace`, { headers: { Cookie: `desk_session_${port + 1}=${desk.token}` } })).status, 401);
  });
});

test("the launch link serves the page once and sets the cookie that carries later requests", async () => {
  await withDesk({}, async ({ base, port, desk }) => {
    const first = await fetch(desk.launchHref);
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type"), /text\/html/);
    const cookie = first.headers.get("set-cookie") || "";
    // Not Secure: plain http on loopback. HttpOnly: the page never reads it.
    // Strict: no other site's request carries it.
    assert.equal(cookie, `desk_session_${port}=${desk.token}; Path=/; HttpOnly; SameSite=Strict`);
    assert.match(await first.text(), /Job Search Desk/);

    const pair = cookie.split(";")[0];
    const viaCookie = await fetch(`${base}/workspace`, { headers: { Cookie: pair } });
    assert.equal(viaCookie.status, 200);
    assert.equal((await viaCookie.json()).root, REPO_ROOT);
    // The cookie also carries POSTs (the page's fetches) and the page itself
    // after a reload, and only the launch link hands the cookie out.
    const post = await fetch(`${base}/stop`, { method: "POST", headers: { Origin: base, Cookie: pair } });
    assert.equal(post.status, 200);
    const reload = await fetch(`${base}/`, { headers: { Cookie: pair } });
    assert.equal(reload.status, 200);
    assert.equal(reload.headers.get("set-cookie"), null);
    const api = await fetch(`${base}/workspace?token=${desk.token}`);
    assert.equal(api.status, 200);
    assert.equal(api.headers.get("set-cookie"), null);
    // A stale cookie from an earlier desk on this port loses to a fresh link.
    const relaunch = await fetch(desk.launchHref, { headers: { Cookie: `desk_session_${port}=${WRONG}` } });
    assert.equal(relaunch.status, 200);
    assert.match(relaunch.headers.get("set-cookie") || "", new RegExp(`^desk_session_${port}=${desk.token};`));
  });
});

test("the streams take the token on the URL, since EventSource cannot set headers", async () => {
  await withDesk({}, async ({ base, desk, cookie }) => {
    for (const init of [[`${base}/events?token=${desk.token}`, {}], [`${base}/events`, { headers: { Cookie: cookie } }]]) {
      const ac = new AbortController();
      const res = await fetch(init[0], { ...init[1], signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      const reader = res.body.getReader();
      const { value } = await reader.read();
      assert.match(new TextDecoder().decode(value), /^event: hello/);
      ac.abort();
      await reader.cancel().catch(() => {});
    }
  });
});

test("HTML responses refuse to be framed; scripts and data carry no framing policy", async () => {
  await withDesk({}, async ({ base, auth }) => {
    for (const path of ["/", "/index.html", "/first-run.html"]) {
      const res = await fetch(`${base}${path}`, { headers: auth });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("x-frame-options"), "DENY", path);
      assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'none'", path);
    }
    const js = await fetch(`${base}/dist/desk.js`, { headers: auth });
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("x-frame-options"), null);
    const json = await fetch(`${base}/workspace`, { headers: auth });
    assert.equal(json.headers.get("x-frame-options"), null);
  });
});

test("the page takes the token off the address bar and sends it on both streams", () => {
  // The renderer is a bundle, so its contract is pinned at the source.
  const src = readFileSync(join(HERE, "..", "public", "src", "desk.js"), "utf8");
  assert.match(src, /history\.replaceState\(/);
  assert.match(src, /new EventSource\(withDeskToken\("\/events"\)\)/);
  assert.match(src, /new WebSocket\(withDeskToken\(/);
  // Fetches ride on the cookie; nothing opts out of sending it.
  assert.doesNotMatch(src, /credentials:\s*["']omit["']/);
});

test("POST /send answers 409 while the desk runtime is attached", async () => {
  await withDesk({ runtime: fakeRuntime() }, async ({ base, auth }) => {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, ...auth },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /runtime/);
  });
});

test("the WebSocket upgrade needs the token: none or wrong is 401, ?token= or the cookie connects", async () => {
  await withDesk({ runtime: fakeRuntime() }, async ({ port, desk, cookie }) => {
    assert.equal(await upgradeStatus(port, "/ws"), 401);
    assert.equal(await upgradeStatus(port, `/ws?token=${WRONG}`), 401);
    assert.equal(await upgradeStatus(port, "/ws", { Cookie: `desk_session_${port}=${WRONG}` }), 401);
    assert.equal(await upgradeStatus(port, `/ws?token=${desk.token}`), 101);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${desk.token}`);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", conversationId: "c1", afterSequence: 0, protocolVersion: 1 }));
    const [raw] = await once(ws, "message");
    assert.equal(JSON.parse(String(raw)).type, "snapshot");
    ws.close();
    await once(ws, "close");

    // After a reload the page has no token in memory; the cookie carries it.
    const viaCookie = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    await once(viaCookie, "open");
    viaCookie.close();
    await once(viaCookie, "close");
  });
});

test("the Autofill review gate stays on its own review token, since the CLI must never hold this one", async () => {
  await withDesk({}, async ({ base }) => {
    const started = await fetch(`${base}/autofill/start`, { method: "POST" });
    assert.equal(started.status, 200);
    const { token } = await started.json();
    assert.ok(token);
    assert.notEqual(token.length, 0);
    const wrong = await fetch(`${base}/autofill/decision`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(wrong.status, 401);
    const polled = await fetch(`${base}/autofill/decision`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(polled.status, 200);
  });
});

test("Open refuses a file the system opener would run and points at Reveal in folder", async () => {
  const fixture = join(REPO_ROOT, "job_scraper", "desk-auth-test-open.sh");
  mkdirSync(join(REPO_ROOT, "job_scraper"), { recursive: true });
  writeFileSync(fixture, "#!/bin/sh\necho hi\n");
  try {
    await withDesk({}, async ({ base, auth }) => {
      const res = await fetch(`${base}/workspace-file/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base, ...auth },
        body: JSON.stringify({ path: "job_scraper/desk-auth-test-open.sh" }),
      });
      assert.equal(res.status, 415);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /does not open \.sh files/);
      assert.match(body.error, /Reveal in folder/);
    });
  } finally {
    rmSync(fixture, { force: true });
  }
});
