// Place this at: scripts/update-projects.mjs
// Weekly discovery sweep for the Semiconductor Reshoring Monitor.
// Calls the Claude API (with web search), VALIDATES EVERY SOURCE URL, and merges into projects.json.
//
// Run locally:  ANTHROPIC_API_KEY=sk-... node scripts/update-projects.mjs
// In CI it reads ANTHROPIC_API_KEY from the GitHub Actions secret.
//
// GUARDRAILS (mirror the playbook):
//   - every source URL is fetched live; dead links are dropped
//   - a record with no working source is skipped (never published)
//   - existing entries are re-audited each run; a project left with zero live links is flagged review:true (not deleted)
//   - dollar/size fields are left null/"" when the model can't cite them
//   - WG-market single-sourced items are flagged review:true
//   - existing projects are updated in place (lifecycle), never duplicated

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";          // cost-effective for a weekly sweep; change if desired
const DATA_FILE = "projects.json";
const WG_STATES = ["TX", "GA", "NC", "SC", "TN"];

const client = new Anthropic();             // reads ANTHROPIC_API_KEY from env

// ---- load existing data ----
let existing = [];
try { existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
catch { console.warn("No projects.json found — starting from empty."); }

const keyOf = (e) => `${(e.co || "").toLowerCase()}|${(e.site || "").toLowerCase()}`;
const existingIndex = new Map(existing.map((e) => [keyOf(e), e]));
const knownList = existing
  .map((e) => `${e.co} | ${e.site} | ${e.city}, ${e.st} | ${e.date}`)
  .join("\n");

// ---- live URL validation: a source counts only if it actually loads ----
async function urlOk(u) {
  if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return false;
  const opts = { redirect: "follow", headers: { "User-Agent": "reshoring-monitor-linkcheck" } };
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(9000);
  try {
    let r = await fetch(u, { method: "HEAD", ...opts });
    // some servers reject HEAD; retry with GET before giving up
    if (!r.ok && [400, 403, 405, 501].includes(r.status)) r = await fetch(u, { method: "GET", ...opts });
    return r.ok;
  } catch { return false; }
}
async function liveSources(src) {
  const out = [];
  for (const u of Array.isArray(src) ? src : []) { if (await urlOk(u)) out.push(u); }
  return out;
}

// ---- the sweep prompt (self-contained) ----
const PROMPT = `You are the weekly discovery sweep for Welcome Group's Semiconductor Reshoring Monitor.
Welcome Group is an industrial real estate developer; its markets are Texas (home), Georgia, North Carolina, South Carolina, Tennessee.
Find NEW or CHANGED U.S. semiconductor manufacturing and supplier-ecosystem activity over roughly the last 60 days:
fabs, advanced packaging, materials/wafer/gas/chemical plants, and process-equipment plants.

RULES:
- Sweep the five WG states first and in full, then national.
- Never invent figures. Capex, CHIPS award, jobs, square footage, acreage, dates must come from a published source. If not documented, use null (numbers) or "" (strings).
- Only cite URLs you actually opened during this search and confirmed load. Do not guess or reconstruct URLs. Prefer the article's canonical link.
- Prefer two independent sources.
- Discovery over confirmation: actively surface projects NOT in the known list below.
- capex, chips, and any public-incentive figure must be DOLLARS IN BILLIONS as plain numbers (40 means $40B; 1.61 means a $1.61B award). Never output raw dollars like 40000000000.
- If a find updates a project already in the known list, reuse that project's exact company and city spelling so it merges instead of creating a duplicate.

KNOWN PROJECTS (do not re-report unless there is a real change such as groundbreaking, production start, expansion, delay, or cancellation):
${knownList}

Use web search. Then output ONLY a JSON array (no prose, no markdown fences). Each element:
{
  "co": "", "site": "", "city": "", "st": "2-letter",
  "lat": 0, "lng": 0,
  "type": "anchor | packaging | materials | equipment",
  "capex": null, "chips": null,   // dollars IN BILLIONS as plain numbers (e.g. 40, 1.61), never raw dollars
  "date": "YYYY-MM", "delayed": false,
  "sf": "",                       // documented footprint only, else ""
  "sum": "", "cre": "",           // plain commercial-real-estate language, tied to Welcome Group; no chip jargon
  "src": ["url1", "url2"],        // only URLs you opened and confirmed load
  "changeNote": ""                // if this updates a known project, say what changed; else ""
}
Approximate lat/lng from the city. Return [] if nothing qualifies this week.`;

// ---- call the API with web search ----
const resp = await client.messages.create({
  model: MODEL,
  max_tokens: 8000,
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
  messages: [{ role: "user", content: PROMPT }],
});

const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

// ---- parse JSON (tolerant: grab the first [...] array) ----
let found = [];
try {
  const match = text.match(/\[[\s\S]*\]/);
  found = JSON.parse(match ? match[0] : text);
} catch (e) {
  console.error("Could not parse model output as JSON. Raw output:\n", text);
  process.exit(1);
}

// ---- validate new finds (live-link gate) + merge ----
let added = 0, updated = 0, skipped = 0, deadLinks = 0;
for (const r of found) {
  if (!r || typeof r !== "object") { skipped++; continue; }
  const before = Array.isArray(r.src) ? r.src.length : 0;
  r.src = await liveSources(r.src);
  deadLinks += before - r.src.length;
  if (r.src.length === 0) { skipped++; continue; }   // no working source -> do not publish
  r.lastSeen = new Date().toISOString().slice(0, 10);
  r.confidence = r.src.length >= 2 ? "high" : "low";
  r.review = WG_STATES.includes(r.st) && r.confidence === "low";
  const k = keyOf(r);
  if (existingIndex.has(k)) { Object.assign(existingIndex.get(k), r); updated++; }
  else { existing.push(r); existingIndex.set(k, r); added++; }
}

// ---- weekly link audit: re-check EVERY existing source, drop dead ones ----
let auditedDead = 0, flagged = 0;
for (const e of existing) {
  if (!Array.isArray(e.src)) continue;
  const live = await liveSources(e.src);
  if (live.length !== e.src.length) {
    auditedDead += e.src.length - live.length;
    e.src = live;
    e.linkAudit = new Date().toISOString().slice(0, 10);
    if (live.length === 0) { e.review = true; flagged++; }  // flag for review, do not silently delete
  }
}

// ---- write data + a dated sweep log ----
fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));
try {
  fs.mkdirSync("sweeps", { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join("sweeps", `sweep-${stamp}.json`), JSON.stringify(found, null, 2));
} catch {}

console.log(`Sweep complete: ${added} added, ${updated} updated, ${skipped} skipped (no live source). ` +
  `Dead links dropped — new: ${deadLinks}, existing re-audit: ${auditedDead}, projects flagged for review: ${flagged}. ` +
  `Total projects: ${existing.length}.`);
