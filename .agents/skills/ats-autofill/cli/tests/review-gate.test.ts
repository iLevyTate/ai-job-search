import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  DeskReviewGate,
  StdinReviewGate,
  reviewGateHasSubmit,
} from "../src/review-gate.ts"

function fakeStdin(options: { isTTY?: boolean } = {}) {
  const stream = new EventEmitter() as EventEmitter & { off: typeof EventEmitter.prototype.off; isTTY?: boolean }
  // Default to an attached terminal: that is the only stdin the gate accepts,
  // and the tests below that pass isTTY: false are the ones proving it.
  stream.isTTY = options.isTTY ?? true
  return stream
}

describe("StdinReviewGate", () => {
  test("keeps waiting until Enter, then continues", async () => {
    const stdin = fakeStdin()
    const writes: string[] = []
    const gate = new StdinReviewGate(stdin, { write: (text) => writes.push(text) })
    let browserOpen = true
    const pending = gate.waitForDecision({ url: "https://jobs.example/1" }).then((decision) => {
      browserOpen = false
      return decision
    })
    expect(browserOpen).toBe(true)
    expect(writes.join("")).toContain("nothing has been sent yet")
    stdin.emit("data", Buffer.from("\n"))
    expect(await pending).toBe("continue")
    expect(reviewGateHasSubmit(gate)).toBe(false)
  })

  test("the word submit is the only line that sends the application", async () => {
    const stdin = fakeStdin()
    const gate = new StdinReviewGate(stdin, { write: () => {} })
    const pending = gate.waitForDecision({ url: "https://boards.greenhouse.io/acme/jobs/1" })
    stdin.emit("data", Buffer.from("submit\n"))
    expect(await pending).toBe("submit")
  })

  test("stdin close cancels without a submit path", async () => {
    const stdin = fakeStdin()
    const gate = new StdinReviewGate(stdin, { write: () => {} })
    const pending = gate.waitForDecision({ url: "https://jobs.example/1" })
    stdin.emit("close")
    expect(await pending).toBe("cancel")
  })

  test("refuses when stdin is not a terminal, so piped input cannot submit", async () => {
    const stdin = fakeStdin({ isTTY: false })
    const writes: string[] = []
    const gate = new StdinReviewGate(stdin, { write: (text) => writes.push(text) })
    const pending = gate.waitForDecision({ url: "https://boards.greenhouse.io/acme/jobs/1" })
    // The word that would send it, arriving from a pipe rather than a person.
    stdin.emit("data", Buffer.from("submit\n"))
    expect(await pending).toBe("cancel")
    expect(writes.join("")).toMatch(/terminal/i)
    expect(stdin.listenerCount("data")).toBe(0)
  })

  test("cancels after the timeout when nobody answers", async () => {
    const stdin = fakeStdin()
    const gate = new StdinReviewGate(stdin, { write: () => {} }, { timeoutMs: 5 })
    expect(await gate.waitForDecision({ url: "https://jobs.example/1" })).toBe("cancel")
    expect(stdin.listenerCount("data")).toBe(0)
  })
})

describe("DeskReviewGate", () => {
  test("Continue closes after browser-ready; Cancel is distinct; disconnect cancels", async () => {
    const calls: string[] = []
    const gate = new DeskReviewGate({
      endpoint: "http://127.0.0.1:9/autofill",
      token: "tok-1",
      pollMs: 1,
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push(`${init?.method || "GET"} ${url}`)
        if (url.endsWith("/ready")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response(JSON.stringify({ decision: "continue" }), { status: 200 })
      },
    })
    expect(await gate.waitForDecision({ url: "https://jobs.example/1", screenshot: "shot.png" })).toBe("continue")
    expect(calls[0]).toContain("POST")
    expect(calls[0]).toContain("/ready")
    expect(reviewGateHasSubmit(gate)).toBe(false)

    const cancelGate = new DeskReviewGate({
      endpoint: "http://127.0.0.1:9/autofill",
      token: "tok-1",
      fetchImpl: async (input) => {
        if (String(input).endsWith("/ready")) return new Response("{}", { status: 200 })
        return new Response(JSON.stringify({ decision: "cancel" }), { status: 200 })
      },
    })
    expect(await cancelGate.waitForDecision({ url: "https://jobs.example/1" })).toBe("cancel")

    const disconnected = new DeskReviewGate({
      endpoint: "http://127.0.0.1:9/autofill",
      token: "tok-1",
      fetchImpl: async () => {
        throw new Error("disconnected")
      },
    })
    expect(await disconnected.waitForDecision({ url: "https://jobs.example/1" })).toBe("cancel")
  })
})
