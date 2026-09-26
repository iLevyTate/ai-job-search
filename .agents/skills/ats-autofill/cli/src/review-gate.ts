export type ReviewDecision = "continue" | "cancel" | "submit"

export interface ReviewRequest {
  url: string
  screenshot?: string | null
}

export interface ReviewGate {
  waitForDecision(request: ReviewRequest): Promise<ReviewDecision>
}

type StdinLike = {
  isTTY?: boolean
  once(event: "data" | "end" | "close" | "error", listener: (...args: unknown[]) => void): StdinLike
  off?(event: string, listener: (...args: unknown[]) => void): StdinLike
}

export interface StdinReviewGateOptions {
  timeoutMs?: number
}

// Matches the Desk gate: a review nobody answers is a cancel, not an open browser.
const STDIN_REVIEW_TIMEOUT_MS = 30 * 60 * 1000

type Writer = { write(chunk: string): unknown }

export class StdinReviewGate implements ReviewGate {
  // Explicit fields rather than TypeScript parameter properties. Parameter
  // properties emit runtime assignments, which Node's strip-only type stripping
  // rejects. Keep this shape.
  private readonly stdin: StdinLike
  private readonly stderr: Writer
  private readonly timeoutMs: number

  constructor(stdin: StdinLike = process.stdin, stderr: Writer = process.stderr, options: StdinReviewGateOptions = {}) {
    this.stdin = stdin
    this.stderr = stderr
    this.timeoutMs = options.timeoutMs ?? STDIN_REVIEW_TIMEOUT_MS
  }

  waitForDecision(request: ReviewRequest): Promise<ReviewDecision> {
    // A pipe is not a person. The only input that can send an application is
    // the word submit typed at an attached terminal; anything arriving from a
    // script or a redirect is refused before a listener is even attached.
    if (!this.stdin.isTTY) {
      this.stderr.write(
        "\nForm filled, but stdin is not a terminal, so nobody can review it here. Closing without sending.\n" +
          "Run this in an interactive terminal, or launch it from Desk to use the review card.\n",
      )
      return Promise.resolve("cancel")
    }
    this.stderr.write(
      "\nForm filled. The browser is open and nothing has been sent yet.\n" +
        "Check every field. Type submit and press Enter to send it, or press Enter alone to close without sending.\n",
    )
    return new Promise((resolve) => {
      let settled = false
      const finish = (decision: ReviewDecision) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.stdin.off?.("data", onData)
        this.stdin.off?.("end", onCancel)
        this.stdin.off?.("close", onCancel)
        this.stdin.off?.("error", onCancel)
        resolve(decision)
      }
      const onData = (chunk: unknown) => {
        const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : ""
        finish(/^\s*submit\s*$/i.test(text) ? "submit" : "continue")
      }
      const onCancel = () => finish("cancel")
      this.stdin.once("data", onData)
      this.stdin.once("end", onCancel)
      this.stdin.once("close", onCancel)
      this.stdin.once("error", onCancel)
      // Kept referenced on purpose: the CLI is awaiting this gate, and finish()
      // clears the timer on every exit, so it never outlives the review.
      const timer = setTimeout(() => finish("cancel"), this.timeoutMs)
      void request
    })
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface DeskReviewGateOptions {
  endpoint: string
  token: string
  fetchImpl?: FetchLike
  pollMs?: number
  signal?: AbortSignal
}

export class DeskReviewGate implements ReviewGate {
  private readonly options: DeskReviewGateOptions

  constructor(options: DeskReviewGateOptions) {
    this.options = options
  }

  async waitForDecision(request: ReviewRequest): Promise<ReviewDecision> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const base = this.options.endpoint.replace(/\/$/, "")
    try {
      let token = this.options.token
      if (!token) {
        const started = await fetchImpl(`${base}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: this.options.signal,
        })
        if (!started.ok) return "cancel"
        const startedBody = await started.json() as { token?: string }
        token = startedBody.token || ""
        if (!token) return "cancel"
      }
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      }
      const ready = await fetchImpl(`${base}/ready`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          token,
          url: request.url,
          screenshot: request.screenshot ?? null,
        }),
        signal: this.options.signal,
      })
      if (!ready.ok) return "cancel"

      const started = Date.now()
      while (!this.options.signal?.aborted) {
        const response = await fetchImpl(`${base}/decision`, {
          method: "GET",
          headers,
          signal: this.options.signal,
        })
        if (!response.ok) return "cancel"
        const body = await response.json() as { decision?: string; pending?: boolean }
        if (body.decision === "continue" || body.decision === "cancel" || body.decision === "submit") {
          return body.decision
        }
        if (body.pending === false) return "cancel"
        await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 200))
        if (Date.now() - started > 30 * 60 * 1000) return "cancel"
      }
      return "cancel"
    } catch {
      return "cancel"
    }
  }
}

export function createReviewGateFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewGate {
  const token = env.JOB_SEARCH_DESK_REVIEW_TOKEN
  const endpoint = env.JOB_SEARCH_DESK_REVIEW_URL
  if (endpoint) return new DeskReviewGate({ endpoint, token: token || "" })
  return new StdinReviewGate()
}

export function reviewGateHasSubmit(gate: ReviewGate): boolean {
  return typeof (gate as ReviewGate & { submit?: unknown }).submit === "function"
}
