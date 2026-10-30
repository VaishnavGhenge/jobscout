/**
 * Benchmarks apply-mcp against Playwright MCP and Chrome DevTools MCP on the
 * same four job-application tasks, against the same logged-in Chrome.
 *
 *   node tools/apply-mcp/bench.ts [ours|playwright|devtools ...]
 *
 * Baselines are driven with an expert script per task: the call sequence an
 * agent would use if it already knew the page, with no failed attempts. Real
 * agents do worse than that, so these are best-case numbers for the baselines.
 *
 * Measured per task: calls, chars the model has to write (tool arguments),
 * chars returned into context, wall time, and success checked independently
 * over CDP. Tool-schema size is reported separately: a client pays it on every
 * turn the server is connected, whether or not a tool is called.
 *
 * Never submits. The form is cleared before and after each fill so one run's
 * draft can't leak into the next.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const CDP = "http://127.0.0.1:9222";
const FORM =
  "https://docs.google.com/forms/d/e/1FAIpQLSdGdi4on2EyITJSbsVF0EUV7-HISMkhH24oZJFxWgJ08-5pKA/viewform";
const JOB_ID = "4485302613";
const SEARCH_UI =
  "https://www.linkedin.com/jobs/search/?keywords=backend%20engineer&location=India&f_E=2%2C3&f_TPR=r604800";
const RESUME = `${process.cwd()}/tools/apply-mcp/private/resumes/Vaishnav_Ghenge_Backend.pdf`;

/** What the filled ITILITE form must show, keyed by question prefix. */
const EXPECT: [string, RegExp][] = [
  ["Name", /Vaishnav Ghenge/],
  ["Email", /vaishnavghenge@gmail\.com/],
  ["Phone number", /8999467933/],
  ["Current Location", /Pune/],
  ["Are you currently based in Bangalore", /^Yes$/],
  ["Are you willing to work from", /^Yes$/],
  ["Class 10th", /94\.40/],
  ["Class 12th", /Diploma/],
  ["Bachelor's Degree", /^B\.E\. \/ B\.Tech$/],
  ["Name of college", /Pune University/],
  ["What is your Bachelor's Degree branch", /8\.8/],
  ["Total years of professional experience in Python", /3\+/],
  ["Total years of professional experience", /3\+/],
  ["Current Company", /Noovosoft/],
  ["Current designation", /Software Engineer/],
  ["What is your official notice period", /45 Days or above/],
  ["What is your official notice period#2", /90/],
  ["Current Salary", /13\.55/],
  ["Expected Salary", /20 LPA/],
  ["Resume/ CV", /Vaishnav_Ghenge_Backend\.pdf/],
];

// --- the page-side helpers a baseline agent would write -------------------

const EXTRACT_CARDS = `async () => {
  for (let i = 0; i < 6; i++) { document.querySelectorAll('*').forEach(e => { if (e.scrollHeight > e.clientHeight + 200 && getComputedStyle(e).overflowY.match(/auto|scroll/)) e.scrollTop += 1500; }); await new Promise(r => setTimeout(r, 800)); }
  const dismiss = [...document.querySelectorAll('button')].filter(b => /^Dismiss .* job$/.test(b.getAttribute('aria-label') || b.textContent.trim()));
  return dismiss.map(b => { let card = b; for (let i = 0; i < 6 && card; i++) { card = card.parentElement; if (card.querySelectorAll('p').length >= 3) break; }
    return [...card.querySelectorAll('p')].map(p => p.textContent.trim()).filter(t => t && !/^·$|top applicant|early applicant|connection/.test(t)).slice(0, 4).join(' | '); });
}`;

const EXTRACT_JOB = `async () => {
  await new Promise(r => setTimeout(r, 1500));
  const t = (document.querySelector('main') || document.body).innerText.replace(/\\n{2,}/g, '\\n');
  const apply = [...document.querySelectorAll('a')].map(a => a.href).find(h => /safety\\/go/.test(h)) || null;
  return { apply: apply && decodeURIComponent(apply.split('url=')[1].split('&')[0]), text: t.slice(0, 3500) };
}`;

const EXTRACT_FORM = `() => [...document.querySelectorAll('[role=listitem]')].map(li => {
  const title = li.querySelector('[role=heading]')?.innerText.replace(/\\s+/g,' ').trim(); const t = li.innerText;
  const type = /Add file|Upload/i.test(t) ? 'file' : li.querySelector('[role=radio]') ? 'radio: ' + [...li.querySelectorAll('[role=radio]')].map(r => r.getAttribute('data-value')).join(' / ')
    : li.querySelector('[role=checkbox]') ? 'checkbox: ' + [...li.querySelectorAll('[role=checkbox]')].map(r => r.getAttribute('aria-label')).join(' / ')
    : li.querySelector('[role=listbox]') ? 'dropdown' : li.querySelector('textarea') ? 'paragraph' : li.querySelector('input') ? 'text' : 'other';
  return title ? title + '  [' + type + ']' : null; }).filter(Boolean)`;

/** The fill script that finally worked by hand in the ITILITE session. */
const PW_FILL = `async (page) => {
  await page.goto('${FORM}'); await page.waitForSelector('[role=listitem]');
  const items = page.locator('[role=listitem]'); const n = await items.count(); const meta = [];
  for (let i = 0; i < n; i++) meta.push(((await items.nth(i).locator('[role=heading]').first().innerText().catch(() => '')) || '').replace(/\\s+/g, ' ').trim());
  const idx = (p, k = 0) => meta.map((t, i) => t.startsWith(p) ? i : -1).filter(i => i >= 0)[k];
  const text = [['Name','Vaishnav Ghenge'],['Email','vaishnavghenge@gmail.com'],['Phone number','+91 8999467933'],['Current Location','Pune, Maharashtra'],['Class 10th','94.40%'],
    ['Class 12th','N/A, completed Diploma in Computer Engineering instead (Government Polytechnic, Amravati): 96%'],['Name of college','Pune University (Savitribai Phule Pune University), B.E. Computer Engineering, 2021 to 2024'],
    ["What is your Bachelor's Degree branch",'Computer Engineering, CGPA 8.8/10'],['Total years of professional experience in Python','3+ years (Python/Django, since Aug 2023, incl. 1-year internship)'],
    ['=Total years of professional experience *','3+ years (Aug 2023 to present, incl. 1-year internship)'],['Current Company','Noovosoft Technologies LLP'],['Current designation','Software Engineer'],
    ['Current Salary','13.55 LPA'],['Expected Salary',"20 LPA, open to the role's band if higher"]];
  for (const [k, v] of text) { const i = k.startsWith('=') ? meta.indexOf(k.slice(1)) : idx(k);
    await items.nth(i).locator('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea').first().fill(v); }
  const notice = items.filter({ hasText: 'official notice period' }).filter({ hasNot: page.locator('[role=radio]') });
  await notice.locator('input:not([type=hidden]), textarea').first().fill('90 days');
  await items.nth(idx('Are you currently based in Bangalore')).locator('[aria-label="Yes"]').first().click();
  await items.nth(idx('Are you willing to work from')).locator('[aria-label="Yes"]').first().click();
  await page.locator('[role=radio][data-value="B.E. / B.Tech"]').click();
  await items.nth(idx('What is your official notice period')).locator('[aria-label="45 Days or above"]').first().click();
  await page.locator('[role=listitem]').filter({ hasText: 'Resume/ CV' }).locator('[role=button]').filter({ hasText: /Add file/i }).first().click();
  let fr; for (let i = 0; i < 60 && !fr; i++) { fr = page.frames().find(f => f.url().includes('/picker')); if (!fr) await page.waitForTimeout(250); }
  await fr.getByRole('button', { name: /^Browse$/ }).waitFor(); await page.waitForTimeout(1500);
  const done = page.locator('[role=listitem]').filter({ hasText: 'Vaishnav_Ghenge_Backend.pdf' }).first();
  for (let a = 0; a < 4; a++) { await fr.locator('input[type=file]').first().setInputFiles('${RESUME}');
    if (await done.waitFor({ timeout: 6000 }).then(() => true, () => false)) break; }
  return 'ok';
}`;

// --- measurement ------------------------------------------------------------

interface Call { tool: string; inChars: number; outChars: number; ms: number; error?: string }
interface TaskResult { task: string; calls: Call[]; ok: boolean; note: string }

function outText(r: unknown): string {
  const c = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.map((x) => (x.type === "text" ? x.text ?? "" : `[${x.type}]`)).join("\n");
}

class Driver {
  calls: Call[] = [];
  client: Client;
  constructor(client: Client) {
    this.client = client;
  }
  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const t0 = Date.now();
    try {
      const r = await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 180_000 });
      const out = outText(r);
      this.calls.push({ tool, inChars: JSON.stringify(args).length, outChars: out.length, ms: Date.now() - t0, error: r.isError ? out.slice(0, 200) : undefined });
      return out;
    } catch (e) {
      this.calls.push({ tool, inChars: JSON.stringify(args).length, outChars: 0, ms: Date.now() - t0, error: String(e).slice(0, 200) });
      return "";
    }
  }
  take(): Call[] {
    const c = this.calls;
    this.calls = [];
    return c;
  }
}

// --- independent checks over CDP --------------------------------------------

async function withChrome<T>(fn: (p: import("playwright-core").Page) => Promise<T>): Promise<T> {
  const b = await chromium.connectOverCDP(CDP);
  try {
    const ctx = b.contexts()[0];
    const pages = ctx.pages().filter((p) => p.url().includes("docs.google.com/forms"));
    // The filled tab is the one with answers in it; Forms strips the prefill
    // params from the URL, so the URL can't tell the tabs apart.
    let best = pages[pages.length - 1];
    let most = -1;
    for (const p of pages) {
      const n = await p.evaluate(() => Array.from(document.querySelectorAll("input[type=text], textarea")).filter((i) => (i as HTMLInputElement).value).length).catch(() => -1);
      if (n > most) [best, most] = [p, n];
    }
    return await fn(best ?? (await ctx.newPage()));
  } finally {
    await b.close().catch(() => {}); // disconnects; Chrome keeps running
  }
}

async function readForm(): Promise<{ q: string; v: string }[]> {
  return withChrome((p) =>
    p.evaluate(() =>
      Array.from(document.querySelectorAll("[role=listitem]")).flatMap((li) => {
        const q = (li.querySelector("[role=heading]") as HTMLElement | null)?.innerText.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
        if (!q) return [];
        const checked = Array.from(li.querySelectorAll("[role=radio][aria-checked=true],[role=checkbox][aria-checked=true]")).map((r) => r.getAttribute("data-value") || r.getAttribute("aria-label") || "");
        const inp = li.querySelector("input:not([type=hidden]), textarea") as HTMLInputElement | null;
        const file = (li as HTMLElement).innerText.match(/\S+\.pdf\b/i)?.[0];
        return [{ q, v: file ?? (checked.length ? checked.join("; ") : inp?.value ?? "") }];
      }),
    ),
  );
}

function checkForm(shown: { q: string; v: string }[]): { ok: boolean; wrong: string[] } {
  const wrong: string[] = [];
  const seen = new Map<string, number>();
  for (const [key, re] of EXPECT) {
    const [prefix, nth] = key.split("#");
    const hits = shown.filter((s) => s.q.startsWith(prefix) && (prefix !== "Total years of professional experience" || !s.q.includes("Python")));
    const k = nth ? Number(nth) - 1 : (seen.get(prefix) ?? 0);
    seen.set(prefix, k + 1);
    const v = hits[k]?.v ?? "";
    if (!re.test(v)) wrong.push(`${key}="${v.slice(0, 40)}"`);
  }
  return { ok: wrong.length === 0, wrong };
}

/** Clears the form and any saved draft, so runs don't see each other's answers. */
async function clearForm(): Promise<void> {
  await withChrome(async (p) => {
    if (!p.url().includes("/viewform")) await p.goto(FORM, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("[role=listitem]", { timeout: 20000 });
    // A picker left open by a previous run sits over the whole form.
    const picker = p.frames().find((f) => f.url().includes("/picker"));
    if (picker) await picker.getByRole("button", { name: /Close/ }).first().click({ timeout: 3000 }).catch(() => {});
    await p.keyboard.press("Escape").catch(() => {});
    const dialog = p.getByRole("dialog", { name: /Clear form/ });
    if (!(await dialog.isVisible().catch(() => false))) {
      const clear = p.locator("[role=button]").filter({ hasText: /^\s*Clear form\s*$/ }).first();
      if (!(await clear.count())) return;
      await clear.click({ timeout: 5000 }).catch(() => {});
    }
    await dialog.getByRole("button", { name: /^Clear form$/ }).click({ timeout: 5000 }).catch(() => {});
    await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(800);
  });
}

// --- servers and task scripts -------------------------------------------------

const SERVERS: Record<string, { command: string; args: string[] }> = {
  ours: { command: "node", args: ["tools/apply-mcp/dist/server.mjs"] },
  playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", CDP] },
  devtools: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest", `--browser-url=${CDP}`] },
};

type Tasks = Record<string, (d: Driver) => Promise<{ ok: boolean; note: string }>>;

const ours: Tasks = {
  async search(d) {
    const o = await d.call("jobs_search", { keywords: "backend engineer", location: "India", experience: ["entry", "associate"], postedWithinDays: 7 });
    const rows = o.split("\n").filter((l) => /^\d+ \d{8,} \|/.test(l));
    return { ok: rows.length >= 10, note: `${rows.length} ranked rows with jobIds` };
  },
  async detail(d) {
    const o = await d.call("job_detail", { jobId: JOB_ID });
    return { ok: /forms\.gle\/LeC8CaMSE7nggcy17/.test(o) && /Python/.test(o), note: o.match(/apply: .*/)?.[0] ?? "no apply line" };
  },
  async formRead(d) {
    const o = await d.call("form_read", { url: FORM });
    const n = o.split("\n").filter((l) => /^\d+\*? \[/.test(l)).length;
    return { ok: n === 20, note: `${n} fields, ${o.match(/unanswered required: [\d, ]+|all required answered/)?.[0]}` };
  },
  async formFill(d) {
    const r = await d.call("form_read", { url: FORM });
    const id = r.match(/^form (f\d+)/)?.[1] ?? "f1";
    await d.call("form_fill", { form: id, resume: "backend" });
    const c = checkForm(await readForm());
    return { ok: c.ok, note: c.ok ? "all 20 verified" : `wrong: ${c.wrong.join(", ")}` };
  },
};

const playwright: Tasks = {
  async search(d) {
    await d.call("browser_navigate", { url: SEARCH_UI });
    const o = await d.call("browser_evaluate", { function: EXTRACT_CARDS });
    const rows = (o.match(/ \| /g) ?? []).length / 2;
    return { ok: false, note: `~${Math.round(rows)} rows, no jobIds, not ranked (UI cards carry no ids)` };
  },
  async detail(d) {
    await d.call("browser_navigate", { url: `https://www.linkedin.com/jobs/view/${JOB_ID}/` });
    const o = await d.call("browser_evaluate", { function: EXTRACT_JOB });
    return { ok: /forms\.gle/.test(o), note: /forms\.gle/.test(o) ? "apply url found" : "apply url missing" };
  },
  async formRead(d) {
    await d.call("browser_navigate", { url: FORM });
    const o = await d.call("browser_evaluate", { function: EXTRACT_FORM });
    const n = (o.match(/\[(text|radio|checkbox|file|paragraph|dropdown)/g) ?? []).length;
    return { ok: n === 20, note: `${n} fields, none pre-answered` };
  },
  async formFill(d) {
    await d.call("browser_run_code_unsafe", { code: PW_FILL });
    const c = checkForm(await readForm());
    return { ok: c.ok, note: c.ok ? "all 20 verified" : `wrong: ${c.wrong.join(", ")}` };
  },
};

/** chrome-devtools-mcp: element uids come from take_snapshot. */
function uidFor(snap: string, re: RegExp, nth = 0): string | null {
  const hits = snap.split("\n").filter((l) => re.test(l)).map((l) => l.match(/uid=([\w-]+)/)?.[1]).filter(Boolean) as string[];
  return hits[nth] ?? null;
}

/** new_page answers with the page list; the selected page is the new one. */
function pageId(out: string): number {
  return Number(out.match(/^(\d+):.*\[selected\]/m)?.[1] ?? NaN);
}

const devtools: Tasks = {
  async search(d) {
    const id = pageId(await d.call("new_page", { url: SEARCH_UI }));
    const o = await d.call("evaluate_script", { pageId: id, function: EXTRACT_CARDS });
    await d.call("close_page", { pageId: id });
    const rows = (o.match(/ \| /g) ?? []).length / 2;
    return { ok: false, note: `~${Math.round(rows)} rows, no jobIds, not ranked (UI cards carry no ids)` };
  },
  async detail(d) {
    const id = pageId(await d.call("new_page", { url: `https://www.linkedin.com/jobs/view/${JOB_ID}/` }));
    const o = await d.call("evaluate_script", { pageId: id, function: EXTRACT_JOB });
    await d.call("close_page", { pageId: id });
    return { ok: /forms\.gle/.test(o), note: /forms\.gle/.test(o) ? "apply url found" : "apply url missing" };
  },
  async formRead(d) {
    const id = pageId(await d.call("new_page", { url: FORM }));
    const o = await d.call("evaluate_script", { pageId: id, function: EXTRACT_FORM });
    await d.call("close_page", { pageId: id });
    const n = (o.match(/\[(text|radio|checkbox|file|paragraph|dropdown)/g) ?? []).length;
    return { ok: n === 20, note: `${n} fields, none pre-answered` };
  },
  async formFill(d) {
    const id = pageId(await d.call("new_page", { url: FORM }));
    const snap = await d.call("take_snapshot", { pageId: id });
    const tb = (label: RegExp, nth = 0) => uidFor(snap, new RegExp(`textbox.*${label.source}`, "i"), nth);
    const pairs: [string | null, string][] = [
      [tb(/"Name/), "Vaishnav Ghenge"], [tb(/"Email/), "vaishnavghenge@gmail.com"], [tb(/"Phone/), "+91 8999467933"],
      [tb(/Current Location/), "Pune, Maharashtra"], [tb(/Class 10th/), "94.40%"],
      [tb(/Class 12th/), "N/A, completed Diploma in Computer Engineering instead (Government Polytechnic, Amravati): 96%"],
      [tb(/Name of college/), "Pune University (Savitribai Phule Pune University), B.E. Computer Engineering, 2021 to 2024"],
      [tb(/branch of study/), "Computer Engineering, CGPA 8.8/10"],
      [tb(/experience in Python/), "3+ years (Python/Django, since Aug 2023, incl. 1-year internship)"],
      [tb(/"Total years of professional experience/), "3+ years (Aug 2023 to present, incl. 1-year internship)"],
      [tb(/Current Company/), "Noovosoft Technologies LLP"], [tb(/Current designation/), "Software Engineer"],
      [tb(/notice period/), "90 days"], [tb(/Current Salary/), "13.55 LPA"], [tb(/Expected Salary/), "20 LPA, open to the role's band if higher"],
    ];
    const elements = pairs.filter(([u]) => u).map(([uid, value]) => ({ uid, value }));
    if (elements.length) await d.call("fill_form", { pageId: id, elements });
    for (const re of [/radio "Yes"/, /checkbox "Yes"/, /radio "B\.E\. \/ B\.Tech"/, /radio "45 Days or above"/]) {
      const uid = uidFor(snap, re);
      if (uid) await d.call("click", { pageId: id, uid });
    }
    const add = uidFor(snap, /button "Resume\/ CV/);
    if (add) {
      await d.call("click", { pageId: id, uid: add });
      await new Promise((r) => setTimeout(r, 3000));
      const snap2 = await d.call("take_snapshot", { pageId: id });
      const browse = uidFor(snap2, /button "Browse"/);
      for (let a = 0; browse && a < 3; a++) {
        await d.call("upload_file", { pageId: id, uid: browse, filePaths: [RESUME] });
        await new Promise((r) => setTimeout(r, 6000));
        if ((await readForm()).some((f) => f.v.endsWith(".pdf"))) break;
      }
    }
    const c = checkForm(await readForm());
    await d.call("close_page", { pageId: id });
    return { ok: c.ok, note: `${elements.length}/15 text uids found; ${c.ok ? "all 20 verified" : `wrong: ${c.wrong.join(", ")}`}` };
  },
};

const SCRIPTS: Record<string, Tasks> = { ours, playwright, devtools };

async function run(name: string) {
  const s = SERVERS[name];
  const client = new Client({ name: "bench", version: "1" });
  const t0 = Date.now();
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args, stderr: "ignore" }));
  const tools = (await client.listTools()).tools;
  const schemaChars = JSON.stringify(tools).length;
  const startup = Date.now() - t0;
  const d = new Driver(client);
  const results: TaskResult[] = [];
  for (const [task, fn] of Object.entries(SCRIPTS[name])) {
    if (task === "formFill") await clearForm();
    const t = Date.now();
    let r: { ok: boolean; note: string };
    try {
      r = await fn(d);
    } catch (e) {
      r = { ok: false, note: `threw: ${String(e).slice(0, 160)}` };
    }
    const calls = d.take();
    results.push({ task, calls, ok: r.ok, note: r.note });
    const sum = (k: "inChars" | "outChars") => calls.reduce((a, c) => a + c[k], 0);
    console.error(`${name.padEnd(10)} ${task.padEnd(9)} ${r.ok ? "OK  " : "FAIL"} calls=${calls.length} in=${sum("inChars")} out=${sum("outChars")} ${Date.now() - t}ms  ${r.note}${calls.some((c) => c.error) ? `  errors: ${calls.filter((c) => c.error).map((c) => `${c.tool}: ${c.error}`).join(" / ")}` : ""}`);
    if (task === "formFill") await clearForm();
  }
  await client.close();
  return { name, tools: tools.length, schemaChars, startup, results };
}

const which = process.argv.slice(2).length ? process.argv.slice(2) : ["ours", "playwright", "devtools"];
const all = [];
for (const w of which) all.push(await run(w));

const tok = (c: number) => Math.round(c / 4);
console.log("\n| server | tools | schema tok/turn | task | ok | calls | model writes tok | returned tok | wall s |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const s of all) {
  for (const r of s.results) {
    const i = r.calls.reduce((a, c) => a + c.inChars, 0);
    const o = r.calls.reduce((a, c) => a + c.outChars, 0);
    const ms = r.calls.reduce((a, c) => a + c.ms, 0);
    console.log(`| ${s.name} | ${s.tools} | ${tok(s.schemaChars)} | ${r.task} | ${r.ok ? "yes" : "no"} | ${r.calls.length} | ${tok(i)} | ${tok(o)} | ${(ms / 1000).toFixed(1)} |`);
  }
}
writeFileSync("tools/apply-mcp/bench-results.json", JSON.stringify(all, null, 2));
