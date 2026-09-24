import { describe, expect, test } from "bun:test"
import { isApplicationSubmitLabel, submitBlockedHost } from "../src/fill.ts"

describe("application submit", () => {
  test("recognizes the employer's submit button and ignores nearby controls", () => {
    expect(isApplicationSubmitLabel("Submit application")).toBe(true)
    expect(isApplicationSubmitLabel("Submit")).toBe(true)
    expect(isApplicationSubmitLabel("Send application")).toBe(true)
    expect(isApplicationSubmitLabel("Apply")).toBe(false)
    expect(isApplicationSubmitLabel("Subscribe")).toBe(false)
    expect(isApplicationSubmitLabel("Search jobs")).toBe(false)
  })

  test("LinkedIn, Indeed, and Dice stay manual", () => {
    expect(submitBlockedHost("https://www.linkedin.com/jobs/view/1")).toBe(true)
    expect(submitBlockedHost("https://www.indeed.com/viewjob?jk=1")).toBe(true)
    expect(submitBlockedHost("https://www.dice.com/job-detail/1")).toBe(true)
    expect(submitBlockedHost("https://boards.greenhouse.io/acme/jobs/1")).toBe(false)
    expect(submitBlockedHost("https://jobs.lever.co/acme/abc")).toBe(false)
  })
})
