#!/usr/bin/env node
/**
 * nightly-local.mjs — fully local, deterministic nightly job-scan pipeline.
 *
 * Why this exists: the cloud (CCR) routine executes but CANNOT git-push or be
 * observed, so it failed silently every night. This runs on the user's Mac via
 * launchd, needs no LLM, and is fully verifiable.
 *
 * Pipeline (all deterministic — zero Claude tokens):
 *   1. run scan.mjs            → source A (tracked companies, title+location filtered)
 *   2. take today's new rows   → from data/scan-history.tsv
 *   3. ATS liveness + JD fetch → Greenhouse / Ashby / Lever posting APIs
 *   4. rule-based score (/5)   → archetype + seniority + location + JD signals
 *   5. dedup vs Notion         → Notion REST API query (by company+title)
 *   6. push 3.0+ to Notion     → Notion REST API create-page
 *   7. write reports/nightly-DATE.md  (always — even on 0 new)
 *
 * Notion auth: reads a Notion integration token from env NOTION_TOKEN or the
 * file config/.notion-token (gitignored). If absent, it does everything EXCEPT
 * the push/dedup and writes the report with a "needs token" note — so the scan,
 * scoring and report still run and prove the machinery.
 *
 * Usage:  node nightly-local.mjs            (scan already run? it runs it itself)
 *         node nightly-local.mjs --no-scan  (skip running scan.mjs)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

const DB_ID = 'c16c99436a004342b49d63b6e83ffd07';
const TODAY = new Date().toISOString().slice(0, 10);
const ROOT = new URL('.', import.meta.url).pathname;

function token() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN.trim();
  const f = ROOT + 'config/.notion-token';
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  return null;
}

// ── Scoring (deterministic, mirrors modes/_profile.md intent) ──────────
const STRONG = ['chief of staff', 'bizops', 'business operations', 'revenue operations',
  'strategy & operations', 'strategy and operations', 'corporate strategy', 'corporate development',
  'strategic finance', 'revenue strategy', 'commercial strategy', 'gtm operations',
  'go-to-market operations', "founder's associate", 'founder associate', 'head of strategy',
  'head of operations', 'operations strategy', 'market expansion', 'special projects'];
const NEGATIVE = ['sales development', 'business development representative', 'account executive',
  'account manager', 'recruiter', 'talent acquisition', 'people operations', 'software engineer',
  'data engineer', 'product manager', 'legal counsel', 'finance manager', 'accountant', 'driver',
  'growth marketing', 'growth engineer', 'intern', 'working student', 'werkstudent',
  // domain ops that are NOT the strategy/BizOps archetype (learned from 2026-06-11 over-push):
  'financial crime', 'investigator', 'customer operations', 'benefits operations',
  'trading operations', 'tech operations', 'it operations', 'network specialist',
  'onboarding operations', 'workplace operations', 'payments operations', 'process operations',
  'security operations', 'banking operations', 'afc operations', 'planning analyst',
  'sales operations analyst', 'enablement', 'transformation consultant', 'supply chain'];
const SENIOR = ['senior', 'lead', 'head', 'principal', 'staff', 'director', 'manager'];

const GCC = ['dubai', 'abu dhabi', 'uae', 'qatar', 'doha', 'saudi', 'riyadh', 'jeddah', 'ksa', 'kuwait', 'bahrain', 'egypt', 'cairo'];
const REMOTE = ['remote', 'emea', 'europe'];
const WEUR = ['united kingdom', 'uk', 'london', 'ireland', 'dublin', 'germany', 'berlin', 'munich',
  'france', 'paris', 'netherlands', 'amsterdam', 'belgium', 'spain', 'madrid', 'barcelona',
  'portugal', 'lisbon', 'italy', 'milan', 'sweden', 'stockholm', 'austria', 'vienna', 'switzerland'];
const SINGAPORE = ['singapore'];

function scoreRole(title, loc, jd) {
  const t = (title || '').toLowerCase();
  const l = (loc || '').toLowerCase();
  const j = (jd || '').toLowerCase();
  if (NEGATIVE.some(n => t.includes(n))) return { score: 0, reason: 'negative archetype' };
  // archetype
  let arch = STRONG.some(s => t.includes(s)) ? 4.0 : (/strateg|operation|growth strategy|planning/.test(t) ? 3.2 : 2.0);
  // seniority
  const sen = SENIOR.some(s => t.includes(s)) ? 0.2 : (/(associate|coordinator|specialist)/.test(t) ? -0.4 : 0);
  // location tier
  let locTier;
  if (GCC.some(k => l.includes(k)) || SINGAPORE.some(k => l.includes(k))) locTier = 0.6;
  else if (REMOTE.some(k => l.includes(k))) locTier = 0.5;
  else if (WEUR.some(k => l.includes(k))) locTier = 0.2;
  else locTier = -1.0; // out of target
  // JD richness (consulting/strategy signals)
  const jdSig = /(consult|mckinsey|bcg|bain|chief of staff|board|c-suite|executive|p&l|forecast|gtm|revenue)/.test(j) ? 0.1 : 0;
  let s = Math.max(0, Math.min(5, arch + sen + locTier + jdSig));
  return { score: Math.round(s * 10) / 10, reason: `arch ${arch}+sen ${sen}+loc ${locTier}` };
}

// ── ATS liveness + JD fetch ────────────────────────────────────────────
function parseAts(url) {
  let m;
  if ((m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([a-f0-9-]+)/i))) return { ats: 'ashby', org: m[1], id: m[2] };
  if ((m = url.match(/greenhouse\.io\/(?:v1\/boards\/)?([^/]+)\/jobs\/(\d+)/i)) || (m = url.match(/gh_jid=(\d+)/))) {
    const slug = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=|v1\/boards\/)?([a-z0-9_-]+)/i);
    if (m[1] && m[2]) return { ats: 'gh', org: m[1], id: m[2] };
  }
  if ((m = url.match(/(?:job-boards(?:\.eu)?\.greenhouse\.io|boards\.greenhouse\.io)\/([^/]+)\/jobs\/(\d+)/i))) return { ats: 'gh', org: m[1], id: m[2] };
  if ((m = url.match(/gh_jid=(\d+)/)) && /greenhouse|stripe|sumup|hellofresh|dojo|getyourguide/i.test(url)) {
    const slug = (url.match(/\/\/([a-z0-9-]+)\.|boards\/([a-z0-9_-]+)\//i) || [])[1];
    return { ats: 'gh-jid', id: m[1], rawslug: slug };
  }
  if ((m = url.match(/jobs\.lever\.co\/([^/]+)\/([a-f0-9-]+)/i))) return { ats: 'lever', org: m[1], id: m[2] };
  return null;
}
const strip = h => (h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

async function liveJD(url, fallbackTitle) {
  const p = parseAts(url);
  try {
    if (p?.ats === 'ashby') {
      const r = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: 'ApiJobPosting', variables: { organizationHostedJobsPageName: p.org, jobPostingId: p.id }, query: 'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { title locationName descriptionHtml } }' })
      });
      const j = await r.json(); const post = j.data?.jobPosting;
      if (!post) return null;
      return { title: post.title, loc: post.locationName, jd: strip(post.descriptionHtml) };
    }
    if (p?.ats === 'gh') {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${p.org}/jobs/${p.id}`);
      if (!r.ok) return null; const j = await r.json(); if (j.error) return null;
      return { title: j.title, loc: j.location?.name, jd: strip(j.content) };
    }
    if (p?.ats === 'lever') {
      const r = await fetch(`https://api.lever.co/v0/postings/${p.org}/${p.id}`);
      if (!r.ok) return null; const j = await r.json(); if (!j || !j.text) return null;
      return { title: j.text, loc: j.categories?.location, jd: strip(j.description + ' ' + (j.lists || []).map(x => x.content).join(' ')) };
    }
  } catch { return null; }
  return null;
}

// ── Notion REST ────────────────────────────────────────────────────────
async function notion(path, method, body, tok) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method, headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}
async function existsInNotion(company, title, tok) {
  const r = await notion(`databases/${DB_ID}/query`, 'POST', {
    filter: { and: [{ property: 'Company', rich_text: { equals: company } }, { property: 'Role Title', title: { equals: title } }] }
  }, tok);
  return r.ok && (r.json.results?.length > 0);
}
function marketFor(loc) {
  const l = (loc || '').toLowerCase();
  if (GCC.some(k => l.includes(k))) return 'ME';
  if (l.includes('singapore')) return 'Singapore';
  if (l.includes('united kingdom') || l.includes('london') || /\buk\b/.test(l)) return 'UK';
  if (l.includes('germany') || l.includes('berlin') || l.includes('munich')) return 'Germany';
  if (l.includes('france') || l.includes('paris')) return 'France';
  if (l.includes('netherlands') || l.includes('amsterdam')) return 'Netherlands';
  if (REMOTE.some(k => l.includes(k))) return 'UK + EU';
  return 'EU (other)';
}
async function pushNotion(role, tok) {
  const postingType = role.score >= 3.5 ? 'Specific Open Role' : 'Watchlist — Monitor';
  const fit = role.score >= 4.0 ? 'High' : role.score >= 3.5 ? 'Medium' : 'Low';
  return notion('pages', 'POST', {
    parent: { database_id: DB_ID },
    properties: {
      'Role Title': { title: [{ text: { content: role.title } }] },
      'Company': { rich_text: [{ text: { content: role.company } }] },
      'Status': { select: { name: 'Not Reviewed' } },
      'Tracker': { select: { name: 'General Roles' } },
      'Date Found': { date: { start: TODAY } },
      'Fit': { select: { name: fit } },
      'Posting Type': { select: { name: postingType } },
      'Link': { url: role.url },
      'Market': { select: { name: marketFor(role.loc) } },
      'Notes': { rich_text: [{ text: { content: `${role.score}/5 — ${fit}. ${role.loc}. [local nightly]` } }] }
    }
  }, tok);
}

// ── Main ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (!args.includes('--no-scan')) {
  try { execSync('node scan.mjs', { cwd: ROOT, stdio: 'inherit' }); } catch (e) { console.error('scan.mjs failed:', e.message); }
}
const tsv = readFileSync(ROOT + 'data/scan-history.tsv', 'utf8').trim().split('\n');
const todays = tsv.map(l => l.split('\t')).filter(c => c[1] === TODAY).map(c => ({ url: c[0], title: c[3], company: c[4], loc: c[6] }));
console.log(`\n[nightly-local] ${TODAY}: ${todays.length} new rows from scan-history`);

const tok = token();
const pushed = [], skipped = [], dead = [];
let scanned = 0;
for (const row of todays) {
  scanned++;
  const pre = scoreRole(row.title, row.loc, '');
  if (pre.score < 2.8) { skipped.push({ ...row, why: 'prefilter ' + pre.reason }); continue; }
  const live = await liveJD(row.url, row.title);
  if (!live) { dead.push(row); continue; }
  const sc = scoreRole(live.title || row.title, live.loc || row.loc, live.jd);
  if (sc.score < 3.0) { skipped.push({ ...row, why: 'score ' + sc.score }); continue; }
  const role = { company: row.company, title: live.title || row.title, loc: live.loc || row.loc, url: row.url, score: sc.score };
  if (tok) {
    if (await existsInNotion(role.company, role.title, tok)) { skipped.push({ ...role, why: 'dup in Notion' }); continue; }
    const r = await pushNotion(role, tok);
    if (r.ok) pushed.push(role); else skipped.push({ ...role, why: `push failed ${r.status} ${JSON.stringify(r.json).slice(0,120)}` });
  } else {
    pushed.push({ ...role, note: 'WOULD push (no token)' });
  }
}

// ── Report ──────────────────────────────────────────────────────────────
mkdirSync(ROOT + 'reports', { recursive: true });
const lines = [`# Local Nightly — ${TODAY} ${new Date().toISOString()}`, '',
  `- token present: ${tok ? 'yes' : 'NO (push skipped)'}`,
  `- new rows scanned: ${scanned}`, `- live+scored ≥3.0 → ${tok ? 'pushed' : 'would push'}: ${pushed.length}`,
  `- skipped: ${skipped.length}`, `- expired/dead (ATS 404): ${dead.length}`, '', '## Pushed'];
for (const p of pushed) lines.push(`- ${p.score} | ${p.company} — ${p.title} | ${p.loc} | ${p.url}${p.note ? ' [' + p.note + ']' : ''}`);
lines.push('', '## Skipped (reasons)');
for (const s of skipped.slice(0, 40)) lines.push(`- ${s.company} — ${s.title}: ${s.why}`);
writeFileSync(ROOT + `reports/nightly-${TODAY}.md`, lines.join('\n'));
console.log(`\n[nightly-local] pushed ${pushed.length}, skipped ${skipped.length}, dead ${dead.length}. Report written.`);
console.log(tok ? '' : '\n⚠ No NOTION_TOKEN — set it to enable the push (see SETUP).');
