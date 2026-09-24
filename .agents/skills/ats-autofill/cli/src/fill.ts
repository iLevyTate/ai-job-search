// Browser-driven form filling. Requires Playwright (see README).
//
// Submit is a separate decision. The filler does not send the application
// unless the review gate returns "submit". LinkedIn, Indeed, and Dice are
// never sent from here.

import { existsSync } from "fs"
import { resolve as resolvePath } from "path"
import { matchField, matchOption, type FieldValue, type Profile } from "./matcher.ts"
import { StdinReviewGate, type ReviewDecision, type ReviewGate } from "./review-gate.ts"

export type AtsKind = "greenhouse" | "lever" | "ashby" | "workday" | "unknown"

export interface FilledField {
  label: string
  key: string
  value: string
  confidence: "high" | "low"
}

export interface FillReport {
  url: string
  ats: AtsKind
  filled: FilledField[]
  skipped: { label: string; reason: string }[]
  screenshot: string | null
  submitted: boolean
  review?: ReviewDecision
}

/**
 * Playwright insists on the exact browser revision it was built against. When a
 * usable Chromium already exists at a different path (a system install, or a
 * revision fetched by another Playwright version), point at it with
 * ATS_AUTOFILL_CHROMIUM instead of downloading a second copy.
 */
export function launchOptions(headless: boolean): { headless: boolean; executablePath?: string } {
  const override = process.env.ATS_AUTOFILL_CHROMIUM
  return override ? { headless, executablePath: override } : { headless }
}

const MANUAL_SUBMIT_HOSTS = ["linkedin.com", "indeed.com", "dice.com"]

/** LinkedIn, Indeed, and Dice forbid automated submission. */
export function submitBlockedHost(url: string): boolean {
  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return MANUAL_SUBMIT_HOSTS.some((name) => host === name || host.endsWith(`.${name}`))
}

/** True when a control's visible label is the application's own submit button. */
export function isApplicationSubmitLabel(label: string): boolean {
  const text = label.replace(/\s+/g, " ").trim()
  if (!text || /newsletter|subscribe|search jobs/i.test(text)) return false
  return /^(submit|submit application|send application|send my application)$/i.test(text)
}

export function detectAts(url: string): AtsKind {
  const u = url.toLowerCase()
  if (u.includes("greenhouse.io")) return "greenhouse"
  if (u.includes("lever.co")) return "lever"
  if (u.includes("ashbyhq.com")) return "ashby"
  if (u.includes("myworkdayjobs.com") || u.includes("workday")) return "workday"
  return "unknown"
}

/**
 * Label-derivation strategies, most reliable first.
 *
 * Must be passed to `evaluate` as a function, not a string. Playwright will
 * evaluate a function-shaped string as an expression and never call it, which
 * silently yields undefined for every field.
 *
 * Runs in browser context, so it must not close over anything from Node.
 */
function deriveLabel(el: Element): string {
  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim()

  const aria = el.getAttribute("aria-label")
  if (aria) return clean(aria)

  const labelledby = el.getAttribute("aria-labelledby")
  if (labelledby) {
    const ref = document.getElementById(labelledby)
    if (ref) return clean(ref.textContent)
  }

  if (el.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
    if (forLabel) return clean(forLabel.textContent)
  }

  const ancestorLabel = el.closest("label")
  if (ancestorLabel) return clean(ancestorLabel.textContent)

  const fieldset = el.closest("fieldset")
  if (fieldset) {
    const legend = fieldset.querySelector("legend")
    if (legend) return clean(legend.textContent)
  }

  const group = el.closest("[class*=field], [class*=question], [class*=form-group], div")
  if (group) {
    const heading = group.querySelector("label, legend, .label, [class*=label]")
    if (heading && !heading.contains(el)) return clean(heading.textContent)
  }

  return clean(el.getAttribute("placeholder") || el.getAttribute("name") || "")
}

export interface FillOptions {
  url: string
  profile: Profile
  headed: boolean
  dryRun: boolean
  screenshotPath: string | null
  timeoutMs: number
  reviewGate?: ReviewGate
}

export async function fillApplication(opts: FillOptions): Promise<FillReport> {
  let chromium: typeof import("playwright").chromium
  try {
    ;({ chromium } = await import("playwright"))
  } catch {
    throw new Error(
      "Playwright is not installed. Run `bun install` in .agents/skills/ats-autofill/cli, " +
        "then `bunx playwright install chromium`.",
    )
  }

  const ats = detectAts(opts.url)
  const report: FillReport = {
    url: opts.url,
    ats,
    filled: [],
    skipped: [],
    screenshot: null,
    submitted: false,
  }

  const browser = await chromium.launch(launchOptions(!opts.headed))
  const context = await browser.newContext({ acceptDownloads: false })
  const page = await context.newPage()

  try {
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs })
    // Application forms are usually below an "Apply" affordance; wait for
    // client-side rendering to produce form controls (SPA boards like Ashby can
    // take >1.5s on a cold load) and follow an obvious apply link if the form
    // is still absent.
    await page
      .waitForFunction(
        () => document.querySelectorAll("input, textarea, select").length >= 3,
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => {})
    if ((await page.locator("input, textarea, select").count()) < 3) {
      // Only follow a navigation link. A short or iframe-hosted form can read
      // as "<3 controls" while still having a submit button labeled "Apply";
      // clicking that would submit a blank application. Anchors navigate.
      const applyLink = page.locator('a[href]:has-text("Apply")').first()
      if (await applyLink.count()) {
        const insideForm = await applyLink.evaluate((el) => Boolean(el.closest("form"))).catch(() => true)
        if (!insideForm) {
          await applyLink.click({ timeout: 5000 }).catch(() => {})
          await page.waitForTimeout(2000)
        }
      }
    }

    const controls = await page.locator("input, textarea, select").all()

    for (const control of controls) {
      if (!(await control.isVisible().catch(() => false))) continue

      const type = ((await control.getAttribute("type")) || "").toLowerCase()
      if (type === "hidden" || type === "submit" || type === "button") continue

      const rawLabel = await control.evaluate(deriveLabel).catch(() => "")
      if (!rawLabel) continue

      const match = matchField(rawLabel, opts.profile)
      if (!match) {
        report.skipped.push({ label: rawLabel, reason: "no confident profile match" })
        continue
      }

      if (opts.dryRun) {
        report.filled.push({
          label: rawLabel,
          key: match.key,
          value: renderValue(match.value),
          confidence: match.confidence,
        })
        continue
      }

      const ok = await applyValue(page, control, match.value, type)
      if (ok) {
        report.filled.push({
          label: rawLabel,
          key: match.key,
          value: renderValue(match.value),
          confidence: match.confidence,
        })
      } else {
        report.skipped.push({ label: rawLabel, reason: `could not set ${match.key}` })
      }
    }

    if (opts.screenshotPath && !opts.dryRun) {
      await page.screenshot({ path: opts.screenshotPath, fullPage: true })
      report.screenshot = opts.screenshotPath
    }

    if (opts.headed) {
      const gate = opts.reviewGate ?? new StdinReviewGate()
      report.review = await gate.waitForDecision({
        url: opts.url,
        screenshot: report.screenshot,
      })
      if (report.review === "submit") {
        if (submitBlockedHost(opts.url)) {
          report.skipped.push({
            label: "Submit",
            reason: "LinkedIn, Indeed, and Dice have to be sent by hand",
          })
        } else {
          report.submitted = await clickApplicationSubmit(page)
          if (!report.submitted) {
            report.skipped.push({ label: "Submit", reason: "no submit button found" })
          } else {
            await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {})
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }

  return report
}

async function clickApplicationSubmit(page: import("playwright").Page): Promise<boolean> {
  const controls = page.locator('button, input[type="submit"], [role="button"]')
  const count = await controls.count()
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i)
    if (!(await control.isVisible().catch(() => false))) continue
    const label = await control
      .evaluate((el) => {
        const node = el as HTMLElement
        const value = "value" in node ? String((node as HTMLInputElement).value || "") : ""
        return (node.innerText || value || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim()
      })
      .catch(() => "")
    if (!isApplicationSubmitLabel(label)) continue
    await control.click({ timeout: 10000 })
    return true
  }
  return false
}

function renderValue(v: FieldValue): string {
  if (v.kind === "boolean") return v.value ? "Yes" : "No"
  return v.value
}

async function applyValue(
  page: import("playwright").Page,
  control: import("playwright").Locator,
  value: FieldValue,
  type: string,
): Promise<boolean> {
  try {
    if (value.kind === "file") {
      const abs = resolvePath(value.value)
      if (!existsSync(abs)) return false
      await control.setInputFiles(abs, { timeout: 10000 })
      return true
    }

    const tag = await control.evaluate((el) => el.tagName.toLowerCase())

    if (tag === "select") {
      const options = await control.locator("option").allTextContents()
      const chosen = matchOption(value, options)
      if (!chosen) return false
      await control.selectOption({ label: chosen }, { timeout: 5000 })
      return true
    }

    if (type === "radio" || type === "checkbox") {
      // The label already matched this specific input, so decide whether THIS
      // option is the one to select rather than typing into it.
      const own = await control.evaluate((el) => {
        const input = el as HTMLInputElement
        const byLabel = input.id
          ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]')
          : null
        const ancestor = input.closest("label")
        return (byLabel?.textContent || ancestor?.textContent || input.value || "").trim()
      })
      const chosen = matchOption(value, [own])
      if (!chosen) return false
      await control.check({ timeout: 5000 })
      return true
    }

    if (value.kind === "boolean") {
      await control.fill(value.value ? "Yes" : "No", { timeout: 5000 })
      return true
    }

    await control.fill(value.value, { timeout: 5000 })
    return true
  } catch {
    return false
  }
}
