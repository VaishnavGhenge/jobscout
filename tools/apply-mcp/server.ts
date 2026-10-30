/**
 * apply-mcp: a job-application browser server built for low token cost.
 *
 * General browser MCPs (Playwright MCP, Chrome DevTools MCP) expose clicks and
 * page snapshots, so every task becomes snapshot -> find element -> act, and
 * every step echoes code, console noise and page trees back into the model's
 * context. This server exposes the *tasks* instead, and gets its data from the
 * cheapest source that has it:
 *
 *   - LinkedIn search and job text come from LinkedIn's public guest endpoints
 *     over plain HTTP. No browser, no login, ten requests in parallel.
 *   - Where a fact needs your session (a job's Apply target, a Google Form that
 *     requires sign-in), the HTML is fetched from inside your logged-in Chrome,
 *     not rendered and walked.
 *   - Google Forms are read from the FB_PUBLIC_LOAD_DATA_ blob the page embeds
 *     and filled with a native prefill link, so no field is ever clicked.
 *     Only the resume upload goes through the UI, because files can't be
 *     prefilled.
 *   - Common screening questions are answered from applicant.json, so a form
 *     read returns only the questions it couldn't answer.
 *
 * Nothing here submits anything unless form_submit is called with confirm.
 *
 * Chrome: attaches over CDP to 127.0.0.1:$APPLY_CDP_PORT (default 9222), and
 * launches Chrome with a dedicated profile if nothing is listening. Since Chrome
 * 136 remote debugging is refused on the default profile, hence the separate
 * one at ~/.jobscout/chrome-profile.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isEngineeringRole } from "@/lib/scoring";
import {
  UA, decodeEntities, guestDetail, pool, score, searchLinkedIn, sleep,
} from "../lib/linkedin";

const PORT = Number(process.env.APPLY_CDP_PORT ?? 9222);
const PROFILE =
  process.env.APPLY_CHROME_PROFILE ?? join(homedir(), ".jobscout", "chrome-profile");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BANK_PATH =
  process.env.APPLY_BANK ?? resolve(process.cwd(), "tools/apply-mcp/private/applicant.json");
/** Hard cap on any tool result. A tool that needs more is returning the wrong thing. */
const MAX_OUT = 8000;

// ---------------------------------------------------------------------------
// Chrome

let browser: Browser | null = null;
let ctx: BrowserContext | null = null;
let dataTab: Page | null = null;
let workTab: Page | null = null;

async function cdpUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

async function context(): Promise<BrowserContext> {
  if (ctx && browser?.isConnected()) return ctx;
  if (!(await cdpUp())) {
    spawn(
      CHROME,
      [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        "--no-first-run",
        "--no-default-browser-check",
        // Cookies in a profile seeded from Playwright MCP are encrypted with
        // Playwright's mock keychain; without this they read as logged out.
        "--use-mock-keychain",
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    for (let i = 0; i < 50 && !(await cdpUp()); i++) await sleep(200);
    if (!(await cdpUp())) throw new Error(`Chrome did not open a CDP port on ${PORT}`);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  ctx = browser.contexts()[0] ?? (await browser.newContext());
  dataTab = null;
  workTab = null;
  return ctx;
}

/**
 * Remembers our two tabs by CDP target id, so a restarted server picks them up
 * again instead of opening two more every session. window.name can't do this:
 * Chrome clears it on cross-site navigation.
 */
const TABS_FILE = join(homedir(), ".jobscout", "apply-tabs.json");

async function targetId(p: Page): Promise<string> {
  const s = await p.context().newCDPSession(p);
  try {
    const r = (await s.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
    return r.targetInfo.targetId;
  } finally {
    await s.detach().catch(() => {});
  }
}

async function tab(kind: "data" | "work"): Promise<Page> {
  const c = await context();
  const cur = kind === "data" ? dataTab : workTab;
  if (cur && !cur.isClosed()) return cur;
  let saved: Record<string, string> = {};
  try {
    saved = JSON.parse(readFileSync(TABS_FILE, "utf8"));
  } catch {}
  let p: Page | undefined;
  if (saved[kind]) {
    for (const q of c.pages()) {
      if ((await targetId(q).catch(() => "")) === saved[kind]) {
        p = q;
        break;
      }
    }
  }
  if (!p) {
    p = await c.newPage();
    saved[kind] = await targetId(p);
    writeFileSync(TABS_FILE, JSON.stringify(saved));
  }
  if (kind === "data") dataTab = p;
  else workTab = p;
  return p;
}

/** Serializes use of the data tab, which hops between origins. */
let dataLock: Promise<unknown> = Promise.resolve();

/**
 * GET a URL with your session's cookies, from a tab already on that origin.
 * The tab sits on the origin's robots.txt, which is the cheapest same-origin
 * page there is.
 */
async function sessionFetch(url: string): Promise<{ status: number; url: string; text: string }> {
  const run = async () => {
    const p = await tab("data");
    const origin = new URL(url).origin;
    if (!p.url().startsWith(origin)) {
      await p.goto(`${origin}/robots.txt`, { waitUntil: "commit" });
    }
    return p.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include" });
      return { status: r.status, url: r.url, text: await r.text() };
    }, url);
  };
  const next = dataLock.then(run, run);
  dataLock = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Small helpers

function clip(s: string, n = MAX_OUT): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: clip(s) }] };
}

/** Runs fn over items with at most n in flight. */
// ---------------------------------------------------------------------------
// LinkedIn

const APPLY_HOST =
  /forms\.gle|docs\.google\.com\/forms|greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|rippling\.com|workable\.com|recruitee\.com|keka\.com|darwinbox|zohorecruit|freshteam|\/careers?\/|\/jobs?\//i;

/** Where "Apply" goes. Needs the logged-in page: the guest page hides it. */
async function applyTarget(jobId: string): Promise<{ kind: string; url: string | null }> {
  const r = await sessionFetch(`https://www.linkedin.com/jobs/view/${jobId}/`);
  if (/authwall|uas\/login|checkpoint/.test(r.url)) return { kind: "needs-linkedin-login", url: null };
  const h = r.text;
  const urls = [...h.matchAll(/safety\\?\/go\\?\/?\?url=([^"&\\\s]+)/g)].map((m) => {
    try {
      return decodeURIComponent(m[1].replace(/%2E/gi, "."));
    } catch {
      return m[1];
    }
  });
  const url = urls.find((u) => APPLY_HOST.test(u)) ?? null;
  if (url) {
    const kind = /forms\.gle|docs\.google\.com\/forms/.test(url)
      ? "google-form"
      : /greenhouse|lever\.co|ashbyhq|smartrecruiters|rippling|workday|workable|recruitee/.test(url)
        ? "ats"
        : "external";
    return { kind, url };
  }
  const about = h.indexOf("About the job");
  const easy = h.indexOf("Easy Apply");
  if (easy >= 0 && (about < 0 || easy < about)) return { kind: "easy-apply", url: `https://www.linkedin.com/jobs/view/${jobId}/` };
  if (h.includes("Apply on company website") && urls[0]) return { kind: "external", url: urls[0] };
  return { kind: "unknown", url: null };
}

// ---------------------------------------------------------------------------
// Answer bank

interface Rule {
  /** Regexes over the normalized question text. First rule that matches wins. */
  q: string[];
  a: string;
  /** For choice questions: option labels or regexes to prefer, in order. */
  options?: string[];
}
interface Bank {
  resumes: Record<string, string>;
  defaultResume: string;
  rules: Rule[];
}

function loadBank(): Bank {
  if (!existsSync(BANK_PATH)) return { resumes: {}, defaultResume: "", rules: [] };
  return JSON.parse(readFileSync(BANK_PATH, "utf8")) as Bank;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9+#.']+/g, " ").trim();

function ruleFor(question: string, bank: Bank): Rule | undefined {
  const q = norm(question);
  return bank.rules.find((r) => r.q.some((p) => new RegExp(p, "i").test(q)));
}

/**
 * Turns a free answer into one of the offered options, or null if none fits.
 * Order: the rule's preferred options, then exact/contains match, then for a
 * number ("90" days) the highest option that doesn't exceed it.
 */
function chooseOption(answer: string, options: string[], preferred?: string[]): string | null {
  for (const p of preferred ?? []) {
    const hit = options.find((o) => o === p || new RegExp(p, "i").test(o));
    if (hit) return hit;
  }
  const a = norm(answer);
  const exact = options.find((o) => norm(o) === a);
  if (exact) return exact;
  const starts = options.find((o) => norm(o).startsWith(a) || a.startsWith(norm(o)));
  if (starts && norm(starts)) return starts;
  const n = Number(answer.match(/\d+(\.\d+)?/)?.[0]);
  if (!Number.isNaN(n)) {
    const nums = options
      .map((o) => ({ o, v: Number(o.match(/\d+(\.\d+)?/)?.[0]) }))
      .filter((x) => !Number.isNaN(x.v) && x.v <= n)
      .sort((x, y) => y.v - x.v);
    if (nums[0]) return nums[0].o;
    if (n === 0) return options.find((o) => /immediate/i.test(o)) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Forms

type FieldType =
  | "text" | "paragraph" | "radio" | "dropdown" | "checkbox" | "scale" | "date" | "time"
  | "file" | "grid" | "email" | "tel" | "number" | "select" | "combobox" | "url";

interface Field {
  n: number;
  q: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  hasOther?: boolean;
  /** Google Forms entry id, or the data-am stamp for generic forms. */
  key: string;
  answer?: string;
  from?: "bank" | "you";
}

interface FormSession {
  id: string;
  kind: "google" | "generic";
  title: string;
  url: string;
  fields: Field[];
  /** Google only: base viewform URL for prefill links. */
  viewform?: string;
  pages?: number;
  needsSignIn?: boolean;
}

const forms = new Map<string, FormSession>();
let formSeq = 0;

const GTYPE: Record<number, FieldType | null> = {
  0: "text", 1: "paragraph", 2: "radio", 3: "dropdown", 4: "checkbox", 5: "scale",
  7: "grid", 9: "date", 10: "time", 13: "file", 6: null, 8: null, 11: null, 12: null,
};

async function resolveShort(url: string): Promise<string> {
  if (!/forms\.gle|lnkd\.in/.test(url)) return url;
  const r = await fetch(url, { redirect: "manual", headers: { "user-agent": UA } });
  const loc = r.headers.get("location");
  if (loc) return resolveShort(new URL(loc, url).href);
  if (/lnkd\.in/.test(url)) {
    const h = await r.text();
    const m = h.match(/href="(https?:\/\/(?!www\.linkedin\.com|lnkd\.in)[^"]+)"/);
    if (m) return decodeEntities(m[1]);
  }
  return url;
}

async function readGoogleForm(url: string): Promise<FormSession> {
  const u = new URL(url);
  u.search = "";
  u.pathname = u.pathname.replace(/\/(formResponse|viewform|edit)?\/?$/, "/viewform");
  const r = await sessionFetch(u.href);
  const m = r.text.match(/FB_PUBLIC_LOAD_DATA_ = ([\s\S]*?);<\/script>/);
  if (!m) {
    const signIn = /accounts\.google\.com|ServiceLogin/.test(r.url + r.text.slice(0, 3000));
    throw new Error(
      signIn
        ? "Form needs a Google sign-in. Log in to Google in the apply Chrome window, then retry."
        : `No form data at ${r.url} (status ${r.status}). Closed or not a Google Form.`,
    );
  }
  const d = JSON.parse(m[1]);
  const items: unknown[][] = d[1][1] ?? [];
  const fields: Field[] = [];
  let pages = 1;
  for (const it of items) {
    const t = it[3] as number;
    if (t === 8) pages++;
    const type = GTYPE[t];
    if (!type) continue;
    const sub = (it[4] as unknown[][] | null)?.[0];
    if (!sub) continue;
    const opts = (sub[1] as unknown[][] | null) ?? [];
    fields.push({
      n: fields.length + 1,
      q: String(it[1] ?? "").trim(),
      type,
      required: sub[2] === 1,
      options: opts.filter((o) => o[0]).map((o) => String(o[0])),
      hasOther: opts.some((o) => o[4] === 1),
      key: String(sub[0]),
    });
  }
  return {
    id: `f${++formSeq}`,
    kind: "google",
    title: String(d[1][8] ?? d[3] ?? "Google Form"),
    url,
    fields,
    viewform: `https://docs.google.com/forms/d/${d[14]}/viewform`,
    pages,
    needsSignIn: fields.some((f) => f.type === "file") || d[1][10]?.[0] === 1,
  };
}

/** Labels and stamps every control on the page; generic forms only. */
async function readGenericForm(url: string): Promise<FormSession> {
  const p = await tab("work");
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("form input, form select, form textarea, input, textarea", { timeout: 15000 });
  await sleep(600);
  const raw = await p.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el as HTMLElement);
      return (r.width > 0 && r.height > 0 && s.visibility !== "hidden") || (el as HTMLInputElement).type === "file";
    };
    const labelOf = (el: Element): string => {
      const e = el as HTMLInputElement;
      const fromLabels = e.labels?.[0]?.innerText;
      const by = e.getAttribute("aria-labelledby");
      const fromBy = by ? by.split(/\s+/).map((i) => document.getElementById(i)?.innerText ?? "").join(" ") : "";
      const legend = e.closest("fieldset")?.querySelector("legend")?.innerText;
      let prev = "";
      let node: Element | null = e;
      for (let i = 0; i < 4 && node && !prev; i++) {
        node = node.parentElement;
        const t = node?.querySelector("label, legend, [class*=label], [class*=question]")?.textContent;
        if (t && t.trim().length < 300) prev = t;
      }
      return (fromLabels || fromBy || e.getAttribute("aria-label") || legend || prev || e.placeholder || e.name || "").replace(/\s+/g, " ").trim();
    };
    const out: { key: string; q: string; type: string; required: boolean; options?: string[] }[] = [];
    const seenGroups = new Set<string>();
    let i = 0;
    for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
      const e = el as HTMLInputElement;
      const type = (e.tagName === "SELECT" ? "select" : e.tagName === "TEXTAREA" ? "paragraph" : e.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "search"].includes(type) || !visible(e)) continue;
      if ((type === "radio" || type === "checkbox") && e.name) {
        if (seenGroups.has(e.name)) continue;
        seenGroups.add(e.name);
        const group = Array.from(document.querySelectorAll(`input[name="${CSS.escape(e.name)}"]`)) as HTMLInputElement[];
        const key = `am${++i}`;
        group.forEach((g) => g.setAttribute("data-am", key));
        const q = (e.closest("fieldset")?.querySelector("legend")?.innerText || labelOf(e.closest("[role=group],[role=radiogroup],div") ?? e)).replace(/\s+/g, " ").trim();
        out.push({ key, q, type: group.length > 1 || type === "radio" ? type : "checkbox", required: group.some((g) => g.required), options: group.map((g) => (g.labels?.[0]?.innerText || g.value).trim()) });
        continue;
      }
      const key = `am${++i}`;
      e.setAttribute("data-am", key);
      const role = e.getAttribute("role");
      out.push({
        key,
        q: labelOf(e),
        type: role === "combobox" ? "combobox" : type === "textarea" ? "paragraph" : type,
        required: e.required || e.getAttribute("aria-required") === "true" || /\*\s*$/.test(labelOf(e)),
        options: e.tagName === "SELECT" ? Array.from((e as unknown as HTMLSelectElement).options).map((o) => o.text.trim()).filter((t) => t && !/^select/i.test(t)) : undefined,
      });
    }
    return { title: document.title, fields: out };
  });
  return {
    id: `f${++formSeq}`,
    kind: "generic",
    title: raw.title,
    url,
    fields: raw.fields.map((f, k) => ({ ...f, n: k + 1, type: f.type as FieldType })),
  };
}

function applyBank(s: FormSession, bank: Bank): void {
  for (const f of s.fields) {
    if (f.type === "file") continue;
    const r = ruleFor(f.q, bank);
    if (!r) continue;
    if (f.options?.length) {
      const o = chooseOption(r.a, f.options, r.options);
      if (o) f.answer = o;
      else if (f.hasOther) f.answer = r.a;
    } else f.answer = r.a;
    if (f.answer !== undefined) f.from = "bank";
  }
}

function describeForm(s: FormSession): string {
  const missing = s.fields.filter((f) => f.required && f.answer === undefined && f.type !== "file");
  const head = [
    `form ${s.id}: ${s.title} (${s.kind}, ${s.fields.length} fields${s.pages && s.pages > 1 ? `, ${s.pages} pages` : ""}${s.needsSignIn ? ", needs Google sign-in" : ""})`,
    missing.length ? `unanswered required: ${missing.map((f) => f.n).join(", ")}` : "all required answered",
  ];
  const rows = s.fields.map((f) => {
    const opts = f.options?.length ? ` {${f.options.join(" | ")}${f.hasOther ? " | other" : ""}}` : "";
    const val = f.type === "file" ? "<resume>" : f.answer !== undefined ? `= ${f.answer}` : f.required ? "= ?" : "";
    return `${f.n}${f.required ? "*" : ""} [${f.type}] ${f.q.slice(0, 140)}${f.answer !== undefined ? "" : opts} ${val}`.trimEnd();
  });
  return [...head, ...rows].join("\n");
}

function prefillUrl(s: FormSession): string {
  const u = new URL(s.viewform!);
  u.searchParams.set("usp", "pp_url");
  for (const f of s.fields) {
    if (f.answer === undefined || f.type === "file" || f.type === "grid") continue;
    const k = `entry.${f.key}`;
    if (f.type === "checkbox") {
      for (const v of f.answer.split(/\s*;\s*/)) {
        if (f.options?.includes(v)) u.searchParams.append(k, v);
        else if (f.hasOther) {
          u.searchParams.append(k, "__other_option__");
          u.searchParams.set(`${k}.other_option_response`, v);
        }
      }
    } else if ((f.type === "radio" || f.type === "dropdown") && !f.options?.includes(f.answer) && f.hasOther) {
      u.searchParams.set(k, "__other_option__");
      u.searchParams.set(`${k}.other_option_response`, f.answer);
    } else u.searchParams.set(k, f.answer);
  }
  return u.href;
}

function resumePath(choice: string | undefined, bank: Bank): string | null {
  const c = choice ?? bank.defaultResume;
  if (!c) return null;
  const p = resolve(bank.resumes[c] ?? c);
  return existsSync(p) ? p : null;
}

async function uploadGoogle(p: Page, question: string, file: string): Promise<boolean> {
  const item = p.locator("[role=listitem]").filter({ has: p.locator("[role=heading]", { hasText: question.slice(0, 60) }) }).first();
  const name = basename(file);
  if ((await item.innerText()).includes(name)) return true;
  const picker = () => p.frames().find((f) => f.url().includes("/picker"));
  if (!picker()) await item.locator("[role=button]").filter({ hasText: /Add file/i }).first().click();
  const deadline = Date.now() + 20000;
  while (!picker() && Date.now() < deadline) await sleep(150);
  const fr = picker();
  if (!fr) return false;
  // The picker wires its change handler up a moment after Browse renders. A
  // file set before that still fires an upload request, but the result is never
  // inserted, so the only trustworthy signal is the filename showing up in the
  // form. Each retry uploads another copy to Drive, hence the settle first.
  await fr.getByRole("button", { name: /^Browse$/ }).waitFor({ state: "visible", timeout: 20000 });
  await sleep(1500);
  for (let attempt = 0; attempt < 4; attempt++) {
    await fr.locator("input[type=file]").first().setInputFiles(file);
    for (let i = 0; i < 24; i++) {
      if ((await item.innerText()).includes(name)) return true;
      await sleep(250);
    }
  }
  return false;
}

/** What the page actually shows, per question, for checking against intent. */
async function readBackGoogle(p: Page): Promise<{ q: string; v: string }[]> {
  return p.evaluate(() =>
    Array.from(document.querySelectorAll("[role=listitem]")).flatMap((li) => {
      const q = (li.querySelector("[role=heading]") as HTMLElement | null)?.innerText.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
      if (!q) return [];
      const checked = Array.from(li.querySelectorAll("[role=radio][aria-checked=true],[role=checkbox][aria-checked=true]")).map((r) => r.getAttribute("data-value") || r.getAttribute("data-answer-value") || r.getAttribute("aria-label") || "");
      const sel = li.querySelector("[role=option][aria-selected=true]")?.getAttribute("data-value");
      const inp = li.querySelector("input:not([type=hidden]), textarea") as HTMLInputElement | null;
      const file = (li as HTMLElement).innerText.match(/\S+\.(pdf|docx?|rtf|txt)\b/i)?.[0];
      return [{ q, v: file ?? (checked.length ? checked.join("; ") : sel ?? inp?.value ?? "") }];
    }),
  );
}

/**
 * Fills, through the page, every field the prefill link didn't set. Prefill is
 * ignored outright on a signed-in form that has a saved draft, which is any
 * form you've opened before, so this is the normal path more often than not.
 */
async function repairGoogle(p: Page, s: FormSession): Promise<void> {
  const back = await readBackGoogle(p);
  const titles = await p.evaluate(() =>
    Array.from(document.querySelectorAll("[role=listitem]")).map((li) =>
      ((li.querySelector("[role=heading]") as HTMLElement | null)?.innerText ?? "").replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim(),
    ),
  );
  const used = new Map<string, number>();
  for (const f of s.fields) {
    const q = f.q.replace(/\s+/g, " ").trim();
    const nth = used.get(q) ?? 0;
    used.set(q, nth + 1);
    if (f.answer === undefined || f.type === "file" || f.type === "grid") continue;
    const shown = back.filter((b) => b.q === q)[nth];
    if (!shown || norm(shown.v) === norm(f.answer)) continue;
    const idx = titles.map((t, i) => (t === q ? i : -1)).filter((i) => i >= 0)[nth];
    if (idx === undefined) continue;
    const item = p.locator("[role=listitem]").nth(idx);
    const opt = (v: string) => (f.options?.includes(v) ? v : "__other_option__");
    if (f.type === "text" || f.type === "paragraph" || f.type === "date" || f.type === "time") {
      await item.locator("input:not([type=hidden]), textarea").first().fill(f.answer);
    } else if (f.type === "radio" || f.type === "scale") {
      await item.locator(`[role=radio][data-value="${CSS_ESC(opt(f.answer))}"]`).first().click();
      if (opt(f.answer) === "__other_option__") await item.locator("input[type=text]").last().fill(f.answer);
    } else if (f.type === "checkbox") {
      for (const v of f.answer.split(/\s*;\s*/)) {
        const box = item.locator(`[role=checkbox][data-answer-value="${CSS_ESC(opt(v))}"], [role=checkbox][aria-label="${CSS_ESC(v)}"]`).first();
        if ((await box.getAttribute("aria-checked")) !== "true") await box.click();
      }
    } else if (f.type === "dropdown") {
      await item.locator("[role=listbox]").first().click();
      await p.locator(`[role=option][data-value="${CSS_ESC(f.answer)}"]:visible`).last().click();
    }
  }
}

const CSS_ESC = (s: string) => s.replace(/["\\]/g, "\\$&");

async function fillGeneric(p: Page, s: FormSession, file: string | null): Promise<string[]> {
  const notes: string[] = [];
  for (const f of s.fields) {
    const loc = p.locator(`[data-am="${f.key}"]`);
    try {
      if (f.type === "file") {
        if (file) await loc.first().setInputFiles(file);
        continue;
      }
      if (f.answer === undefined) continue;
      if (f.type === "select") {
        await loc.first().selectOption({ label: chooseOption(f.answer, f.options ?? []) ?? f.answer });
      } else if (f.type === "radio" || f.type === "checkbox") {
        const want = f.type === "checkbox" && !f.options?.length ? [f.answer] : f.answer.split(/\s*;\s*/);
        const n = await loc.count();
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          const label = await el.evaluate((e) => ((e as HTMLInputElement).labels?.[0]?.innerText || (e as HTMLInputElement).value).trim());
          if (want.some((w) => norm(w) === norm(label)) || (n === 1 && /^(yes|true|y)$/i.test(f.answer))) await el.check();
        }
      } else if (f.type === "combobox") {
        await loc.first().click();
        await loc.first().fill(f.answer);
        await sleep(400);
        await p.keyboard.press("Enter");
      } else {
        await loc.first().fill(f.answer);
      }
    } catch (e) {
      notes.push(`#${f.n} not filled: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Server

const server = new McpServer({ name: "apply", version: "0.1.0" });

server.registerTool(
  "jobs_search",
  {
    description:
      "Search LinkedIn jobs and return them ranked by fit with the jobscout profile (stack, level, YOE ask, blockers). No browser needed. Returns jobId per row for job_detail.",
    inputSchema: {
      keywords: z.string(),
      location: z.string().default("India"),
      experience: z.array(z.enum(["internship", "entry", "associate", "mid-senior", "director", "executive"])).optional(),
      workplace: z.array(z.enum(["onsite", "remote", "hybrid"])).optional(),
      postedWithinDays: z.number().int().min(1).max(30).default(7),
      pages: z.number().int().min(1).max(5).default(2).describe("10 results per page"),
      limit: z.number().int().min(1).max(50).default(20),
      minScore: z.number().default(0),
    },
  },
  async (a) => {
    const cards = await searchLinkedIn({
      keywords: a.keywords,
      location: a.location,
      experience: a.experience,
      workplace: a.workplace,
      postedWithinSeconds: a.postedWithinDays * 86400,
      pages: a.pages,
    });
    const eng = cards.filter((c) => isEngineeringRole(c.title));
    const details = await pool(eng, 8, (c) => guestDetail(c.jobId).catch(() => null));
    const rows = eng
      .map((c, i) => {
        const s = score(c.title, c.location, details[i]?.description ?? "");
        return { c, s, d: details[i] };
      })
      .filter((r) => r.s.eligibility !== "blocked" && r.s.score >= a.minScore)
      .sort((x, y) => y.s.score - x.s.score)
      .slice(0, a.limit);
    const yoe = (s: { yoeMin: number | null; yoeMax: number | null }) =>
      s.yoeMin == null ? "" : ` ${s.yoeMin}${s.yoeMax != null && s.yoeMax !== s.yoeMin ? `-${s.yoeMax}` : "+"}y`;
    const lines = rows.map(
      ({ c, s, d }) =>
        `${s.score} ${c.jobId} | ${c.title} | ${c.company} | ${c.location} | ${c.posted ?? ""}${yoe(s)}${d?.applicants ? ` | ${d.applicants}` : ""} | ${s.reasons.slice(0, 3).join("; ")}`,
    );
    return text(
      `${cards.length} found, ${cards.length - eng.length} non-engineering dropped, showing ${rows.length} by fit\nscore jobId | title | company | location | posted yoe | applicants | why\n${lines.join("\n")}`,
    );
  },
);

server.registerTool(
  "job_detail",
  {
    description:
      "One LinkedIn job: requirements, criteria, applicant count, and where Apply goes (google-form, ats, external, easy-apply) with the URL.",
    inputSchema: {
      jobId: z.string(),
      maxChars: z.number().int().default(1800).describe("description length cap"),
    },
  },
  async ({ jobId, maxChars }) => {
    const [d, apply] = await Promise.all([
      guestDetail(jobId),
      applyTarget(jobId).catch((e: Error) => ({ kind: `error: ${e.message}`, url: null })),
    ]);
    const s = score(d.title, d.location, d.description);
    const crit = Object.entries(d.criteria).map(([k, v]) => `${k}: ${v}`).join(" | ");
    return text(
      [
        `${d.title} | ${d.company} | ${d.location}`,
        `posted ${d.postedAgo ?? "?"} | ${d.applicants ?? "applicants ?"} | ${crit}`,
        `fit ${s.score}: ${s.reasons.join("; ")}${s.blockers.length ? ` | BLOCKERS: ${s.blockers.join(", ")}` : ""}`,
        `apply: ${apply.kind}${apply.url ? ` ${apply.url}` : ""}`,
        "",
        clip(d.description, maxChars),
      ].join("\n"),
    );
  },
);

server.registerTool(
  "posts_search",
  {
    description:
      "Search LinkedIn posts (recruiter hiring posts, often with a Google Form). Returns author, age, text and resolved form/apply links. Uses the logged-in browser.",
    inputSchema: {
      query: z.string(),
      days: z.enum(["1", "7", "30"]).default("7"),
      limit: z.number().int().min(1).max(30).default(12),
      textChars: z.number().int().default(450),
    },
  },
  async ({ query, days, limit, textChars }) => {
    const p = await tab("work");
    const range = days === "1" ? "past-24h" : days === "7" ? "past-week" : "past-month";
    const u = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&datePosted=%22${range}%22&sortBy=%22date_posted%22`;
    await p.goto(u, { waitUntil: "domcontentloaded" });
    if (/authwall|login/.test(p.url())) return text("LinkedIn login needed in the apply Chrome window.");
    const count = () => p.evaluate(() => Array.from(document.querySelectorAll("h2")).filter((h) => h.textContent?.trim() === "Feed post").length);
    await p.waitForFunction(() => Array.from(document.querySelectorAll("h2")).some((h) => h.textContent?.trim() === "Feed post"), null, { timeout: 15000 }).catch(() => {});
    let last = -1;
    for (let i = 0; i < 6; i++) {
      const c = await count();
      if (c >= limit || c === last) break;
      last = c;
      await p.mouse.wheel(0, 4000);
      await p.waitForFunction((n) => Array.from(document.querySelectorAll("h2")).filter((h) => h.textContent?.trim() === "Feed post").length > n, c, { timeout: 2500 }).catch(() => {});
    }
    const posts = await p.evaluate((max) => {
      return Array.from(document.querySelectorAll("h2"))
        .filter((h) => h.textContent?.trim() === "Feed post")
        .slice(0, max)
        .map((h) => {
          const el = h.parentElement as HTMLElement;
          const t = el.innerText.replace(/\s+/g, " ").replace(/^Feed post\s*/, "").trim();
          const hrefs = Array.from(el.querySelectorAll("a")).map((a) => a.href);
          const post = hrefs.find((x) => /feed\/update|\/posts\//.test(x)) ?? null;
          const links = Array.from(new Set([...(t.match(/https?:\/\/lnkd\.in\/[\w-]+/g) ?? []), ...hrefs.filter((x) => /lnkd\.in|forms\.gle|docs\.google\.com\/forms/.test(x))]));
          return { t, post, links };
        });
    }, limit);
    const out = await Promise.all(
      posts.map(async (x, i) => {
        const links = await Promise.all(x.links.slice(0, 3).map((l) => resolveShort(l).catch(() => l)));
        const body = x.t.replace(/\s*(Like|Comment|Repost|Send)(\s+(Like|Comment|Repost|Send))*\s*$/, "");
        return `#${i + 1} ${body.slice(0, textChars)}${links.length ? `\n   links: ${links.join(" ")}` : ""}${x.post ? `\n   post: ${x.post}` : ""}`;
      }),
    );
    return text(`${posts.length} posts\n${out.join("\n")}`);
  },
);

server.registerTool(
  "form_read",
  {
    description:
      "Read an application form (Google Form, ATS or any page with a form) into numbered fields, pre-answered from applicant.json. Returns a form id for form_fill. Only unanswered required fields need your input.",
    inputSchema: { url: z.string() },
  },
  async ({ url }) => {
    const real = await resolveShort(url);
    const s = /docs\.google\.com\/forms/.test(real) ? await readGoogleForm(real) : await readGenericForm(real);
    applyBank(s, loadBank());
    forms.set(s.id, s);
    return text(describeForm(s));
  },
);

server.registerTool(
  "form_fill",
  {
    description:
      "Fill a form read by form_read and attach a resume. Does NOT submit. answers maps field number to value (checkbox: values joined by ';'); they override the bank. Returns a read-back of what the page shows and any mismatch.",
    inputSchema: {
      form: z.string().describe("form id from form_read, e.g. f1"),
      answers: z.record(z.string(), z.string()).optional(),
      resume: z.string().optional().describe("resume key from applicant.json (e.g. backend, fullstack) or an absolute path"),
    },
  },
  async ({ form, answers, resume }) => {
    const s = forms.get(form);
    if (!s) return text(`Unknown form ${form}. Run form_read first.`);
    for (const [k, v] of Object.entries(answers ?? {})) {
      const f = s.fields.find((x) => x.n === Number(k));
      if (!f) continue;
      f.answer = f.options?.length && !f.options.includes(v) ? chooseOption(v, f.options) ?? v : v;
      f.from = "you";
    }
    const bank = loadBank();
    const file = resumePath(resume, bank);
    const fileField = s.fields.find((f) => f.type === "file");
    const p = await tab("work");
    await p.bringToFront();
    const notes: string[] = [];
    if (s.kind === "google") {
      await p.goto(prefillUrl(s), { waitUntil: "domcontentloaded" });
      await p.waitForSelector("[role=listitem]", { timeout: 15000 });
      await repairGoogle(p, s);
      if (fileField) {
        if (!file) notes.push(`resume not attached: no file for "${resume ?? bank.defaultResume}"`);
        else if (!(await uploadGoogle(p, fileField.q, file))) notes.push("resume upload did not confirm");
      }
      const back = await readBackGoogle(p);
      const used = new Map<string, number>();
      for (const f of s.fields) {
        const nth = used.get(f.q) ?? 0;
        used.set(f.q, nth + 1);
        const shown = back.filter((b) => b.q === f.q.replace(/\s+/g, " ").trim())[nth];
        if (!shown) {
          if (s.pages && s.pages > 1) continue;
          notes.push(`#${f.n} not on page`);
          continue;
        }
        if (f.type === "file") continue;
        if (f.answer !== undefined && norm(shown.v) !== norm(f.answer) && !(f.hasOther && shown.v)) {
          notes.push(`#${f.n} shows "${shown.v}" expected "${f.answer}"`);
        }
        if (f.required && !shown.v) notes.push(`#${f.n} required and empty: ${f.q.slice(0, 80)}`);
      }
    } else {
      if (!p.url().startsWith(s.url.split("#")[0]) || !(await p.locator("[data-am]").count())) {
        const again = await readGenericForm(s.url);
        s.fields.forEach((f, i) => (f.key = again.fields[i]?.key ?? f.key));
      }
      notes.push(...(await fillGeneric(p, s, file)));
      for (const f of s.fields) {
        if (f.required && f.answer === undefined && f.type !== "file") notes.push(`#${f.n} required and empty: ${f.q.slice(0, 80)}`);
      }
    }
    const filled = s.fields.filter((f) => f.answer !== undefined).length;
    return text(
      [
        `form ${s.id}: filled ${filled}/${s.fields.length}${fileField ? `, resume ${file ? basename(file) : "MISSING"}` : ""}. NOT submitted.`,
        s.pages && s.pages > 1 ? `multi-page form (${s.pages}): later pages are prefilled but only page 1 was checked.` : "",
        notes.length ? `issues:\n- ${notes.join("\n- ")}` : "read-back matches.",
        "review:",
        ...s.fields.map((f) => `${f.n} ${f.q.slice(0, 70)} = ${f.type === "file" ? (file ? basename(file) : "-") : f.answer ?? "-"}${f.from === "you" ? " (you)" : ""}`),
      ].filter(Boolean).join("\n"),
    );
  },
);

server.registerTool(
  "form_submit",
  {
    description:
      "Submit the form currently filled in the apply tab. Call ONLY after the user has explicitly approved this specific application.",
    inputSchema: { form: z.string(), confirm: z.literal(true) },
  },
  async ({ form }) => {
    const s = forms.get(form);
    const p = await tab("work");
    const before = p.url();
    const btn = s?.kind === "google"
      ? p.locator("[role=button]").filter({ hasText: /^\s*Submit\s*$/ }).first()
      : p.locator("button[type=submit], input[type=submit], button").filter({ hasText: /submit|apply|send/i }).first();
    if (!(await btn.count())) {
      const next = await p.locator("[role=button]").filter({ hasText: /^\s*Next\s*$/ }).count();
      return text(next ? "Form has more pages: no Submit on this page yet." : "No submit button found.");
    }
    await btn.click();
    await p.waitForURL((u) => u.href !== before, { timeout: 15000 }).catch(() => {});
    await sleep(800);
    const body = (await p.locator("body").innerText()).replace(/\s+/g, " ").trim();
    const ok = /formResponse/.test(p.url()) || /thank|received|submitted|success/i.test(body.slice(0, 1500));
    return text(`${ok ? "SUBMITTED" : "UNCONFIRMED"}: ${p.url()}\n${body.slice(0, 400)}`);
  },
);

server.registerTool(
  "page_read",
  {
    description: "Fallback: open a URL in the apply tab (or use the current page) and return its visible text and apply/form links, capped.",
    inputSchema: { url: z.string().optional(), maxChars: z.number().int().default(3000) },
  },
  async ({ url, maxChars }) => {
    const p = await tab("work");
    if (url) await p.goto(await resolveShort(url), { waitUntil: "domcontentloaded" });
    await p.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
    const r = await p.evaluate(() => ({
      title: document.title,
      text: ((document.querySelector("main") as HTMLElement | null) ?? document.body).innerText.replace(/\n{2,}/g, "\n"),
      links: Array.from(new Set(Array.from(document.querySelectorAll("a")).map((a) => a.href).filter((h) => /apply|forms\.gle|docs\.google\.com\/forms|careers|jobs\//i.test(h)))).slice(0, 15),
    }));
    return text(`${r.title} | ${p.url()}\n${clip(r.text, maxChars)}${r.links.length ? `\nlinks:\n${r.links.join("\n")}` : ""}`);
  },
);

await server.connect(new StdioServerTransport());
