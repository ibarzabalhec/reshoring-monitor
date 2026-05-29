// Place this at: scripts/update-projects.mjs
// Weekly discovery sweep for the Semiconductor Reshoring Monitor.
// Calls the Claude API (with web search), validates, and merges into projects.json.
//
// Run locally:  ANTHROPIC_API_KEY=sk-... node scripts/update-projects.mjs
// In CI it reads ANTHROPIC_API_KEY from the GitHub Actions secret.
//
// GUARDRAILS (mirror the playbook):
//   - only records with at least one source URL are kept
//   - dollar/size fields are left null/"" when the model can't cite them
//   - WG-market single-sourced items are flagged review:true
//   - existing projects are updated in place (lifecycle), never duplicated
//
// This is a reviewed-before-prod scaffold: read it, set MODEL, and test with a dry run.

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

// ---- the sweep prompt (self-contained) ----
const PROMPT = `You are the weekly discovery sweep for Welcome Group's Semiconductor Reshoring Monitor.
Welcome Group is an industrial real estate developer; its markets are Texas (home), Georgia, North Carolina, South Carolina, Tennessee.
Find NEW or CHANGED U.S. semiconductor manufacturing and supplier-ecosystem activity over roughly the last 60 days:
fabs, advanced packaging, materials/wafer/gas/chemical plants, and process-equipment plants.

RULES:
- Sweep the five WG states first and in full, then national.
- Never invent figures. Capex, CHIPS award, jobs, square footage, acreage, dates must come from a published source. If not documented, use null (numbers) or "" (strings).
- Prefer two independent sources; include the URLs you actually used.
- Discovery over confirmation: actively surface projects NOT in the known list below.

KNOWN PROJECTS (do not re-report unless there is a real change such as groundbreaking, production start, expansion, delay, or cancellation):
${knownList}

Use web search. Then output ONLY a JSON array (no prose, no markdown fences). Each element:
{
  "co": "", "site": "", "city": "", "st": "2-letter",
  "lat": 0, "lng": 0,
  "type": "anchor | packaging | materials | equipment",
  "capex": null, "chips": null,
  "date": "YYYY-MM", "delayed": false,
  "sf": "",                       // documented footprint only, else ""
  "sum": "", "cre": "",           // plain commercial-real-estate language, tied to Welcome Group; no chip jargon
  "src": ["url1", "url2"],        // at least one real URL; omit the record if you have none
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

// ---- validate + merge ----
let added = 0, updated = 0, skipped = 0;
for (const r of found) {
  if (!r || !Array.isArray(r.src) || r.src.length === 0) { skipped++; continue; } // citeability gate
  r.lastSeen = new Date().toISOString().slice(0, 10);
  r.confidence = r.src.length >= 2 ? "high" : "low";
  r.review = WG_STATES.includes(r.st) && r.confidence === "low";                  // WG single-sourced -> review

  const k = keyOf(r);
  if (existingIndex.has(k)) {
    Object.assign(existingIndex.get(k), r);                                        // lifecycle update
    updated++;
  } else {
    existing.push(r);
    existingIndex.set(k, r);
    added++;
  }
}

// ---- write data + a dated sweep log ----
fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));
try {
  fs.mkdirSync("sweeps", { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join("sweeps", `sweep-${stamp}.json`), JSON.stringify(found, null, 2));
} catch {}

console.log(`Sweep complete: ${added} added, ${updated} updated, ${skipped} skipped (no source). Total projects: ${existing.length}.`);
