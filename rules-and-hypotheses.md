# Rules and Hypotheses — Job Search

## Confirmed Rules

### Scan Protocol (CRITICAL — do not skip)
Every "run career ops" session MUST do TWO things, not one:

1. `node scan.mjs` — hits 71 tracked companies via Greenhouse/Ashby/Lever APIs (zero-token)
2. WebSearch broad discovery — runs the queries from portals.yml `search_queries` across all of Greenhouse, Ashby, Lever, LinkedIn, Welcome to the Jungle, etc. This finds companies NOT in the tracked list.

**Rule: never skip step 2.** The tracked list is a seed (~71 companies). The full EU/UK/MENA market has thousands of companies posting relevant roles. Step 2 is where the high-fit roles at unknown companies get found. If I only run scan.mjs, I'm covering ~5% of the market.

**Rule: always check for duplicates before pushing to Notion.** Search the database first. Never push blindly. Dedup against ALL existing entries regardless of Status — a role marked "Not a Fit", "Rejected", or "Applied" still counts as already-seen and must NOT be re-pushed.

**Rule: after WebSearch discovery, fetch each promising JD via the ATS API before scoring.** Don't score from titles alone.

### HARD RULE — never push unverified roles (added 2026-06-03 after 50%-expired failure)
On 2026-06-03 the user reviewed the batch and ~half were EXPIRED and the rest NOT A FIT. Root cause confirmed by data: every failure was a role I pushed from **WebSearch (stale Google cache)** on private Ashby boards, tagged "est. — Verify JD" — pushed WITHOUT verifying the link was live and WITHOUT reading the JD. Stale URL → expired. Unread JD → not-a-fit (e.g. A11 required M&A exp, invisible from the title).

**Two non-negotiable gates before ANY role goes to Notion:**
1. **LIVENESS** — the role MUST be confirmed live. HTTP 200 is NOT proof (Ashby/SPA boards return 200 for dead pages). Use the ATS posting API:
   - Ashby: `POST jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting` with `{organizationHostedJobsPageName, jobPostingId}` → if `data.jobPosting` is `null`, it is EXPIRED. Skip.
   - Greenhouse: `GET boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}` → 404/410 or `?error=true` redirect = expired.
   - Lever: `GET api.lever.co/v0/postings/{slug}/{id}` → empty/404 = expired.
2. **JD READ** — the actual JD MUST be fetched and read. NO scoring from titles. NO "est." scores. If I cannot fetch the JD, I cannot push.

**Source-of-truth hierarchy:**
- `scan.mjs` (live Greenhouse/Ashby/Lever APIs) is the ONLY trusted push source — it only returns open postings and exposes the full JD. Push from here.
- WebSearch is for DISCOVERING NEW COMPANIES ONLY. When WebSearch finds a company not in portals.yml, add the company to portals.yml so `scan.mjs` pulls its roles live — do NOT push the WebSearch URL directly.
- Private boards where the posting API returns null for everything = cannot verify = DO NOT push. Skip silently.

**Eliminated forever:** the "est. — Verify JD" push. If it needs verifying, verify it BEFORE pushing or don't push it.

### Auto-expire on re-scan
Each run, re-check liveness of existing "Not Reviewed" Notion roles via the posting API. Any that return null/404 → set Status = "Expired" automatically so the user never opens a dead link.

**Tool:** `node liveness-api.mjs <url...>` (zero-token, no Playwright) returns LIVE/DEAD/UNKNOWN per URL using the ATS posting APIs. Run it on every candidate URL before pushing, and on existing "Not Reviewed" rows each scan. Built + validated 2026-06-03.

### Feedback Loop (CRITICAL — read FROM Notion, not just push TO it)
**Before every push session, query Notion for everything the user marked "Not a Fit" or "Rejected" and respect it.** The loop is bidirectional:
1. Search the data source for Status = "Not a Fit" / "Rejected".
2. For each, extract the company + role pattern and add it to the "Rejected — do not resurface" list below.
3. Never push a role matching a rejected pattern again — not the exact role, not the same archetype at the same company.

### Rejected — do not resurface (learned from user feedback)
- **Anthropic — Finance & Strategy, Deal Desk - EMEA** → Not a Fit. Transactional deal-desk: CPQ, Salesforce, contract management. Not strategy.
- **Anthropic — Finance & Strategy, Deal Operations - EMEA** → Not a Fit. Even more transactional than Deal Desk. CPQ/contract systems.
- **GENERALISED RULE:** Skip ALL "Deal Desk", "Deal Operations", "Commercial Operations" roles that are CPQ / contract-management / quote-to-cash in nature, even when titled "Finance & Strategy" or "Strategy". These are commercial-ops execution, not the strategy/BizOps/CoS archetype. Brand name (even Anthropic) does NOT override this.
- **Anthropic Finance & Strategy roles broadly** are low-fit for this user — deprioritise unless clearly a true strategy/planning role (not deal/commercial ops).

### Archetype Priority (what to look for)
- **High fit (4.0+):** GTM S&O / Revenue Ops, BizOps, Chief of Staff at EU/UK/MENA scaleup or AI lab. Manager or Senior Manager level. London / Paris / Berlin / Amsterdam / Dubai / Remote.
- **Medium (3.5–3.9):** Same archetypes at slightly lower brand, or adjacent roles (CoS, Strategy). Worth tracking.
- **Skip by default:** BDR, BDM, Account Executive, Account Manager, Sales Rep, HR/People Ops, Legal, Finance Manager, Data Engineer, PM, Engineering, Analyst (junior), US-only, Korea/Japan, PhD-required, C-level.
- **Location blockers:** US-only, on-site 5 days US city, Korea/Japan/APAC only.

### Notion Push Rules
- Always check for existing entries by company+role before creating new pages.
- Use Date Found = today's date on every push.
- Set Tracker = "General Roles" on all entries.
- High/Medium fit (3.5+) → Posting Type: "Specific Open Role". Borderline (3.0–3.4) → Posting Type: "Watchlist — Monitor".

### What Watchlist means (confirmed with user 2026-06-03)
- **Company-watching lives in `portals.yml`, NOT Notion.** Every company there is scanned each run; new live+read+scored roles are auto-pushed as "Specific Open Role". That is the "watch company → promote when a role opens" behavior.
- **Notion "Watchlist — Monitor" = borderline individual roles (3.0–3.4) to revisit later.** It is a holding pen, not a company monitor. The nightly liveness sweep still applies — dead Watchlist roles auto-flip to "Expired". User can manually promote a Watchlist role to "Specific Open Role" anytime.
- To watch a new company: add it to portals.yml (so scan covers it). Do NOT create a company-placeholder row in Notion.

## Hypotheses Being Tested
- Adyen / Amsterdam — strong commercial strategy team. Worth regular checking.
- 360Learning / Pennylane / Agicap — Paris scaleups with RevOps/BizOps needs, less competed than London roles.
- BVNK / Dojo / Tide — UK fintech with growing strategy teams, less visible than Monzo/Revolut/Wise.

## What Hasn't Worked
- Running scan.mjs alone — misses 95% of the market (websearch companies + companies not in tracked list).
- Pushing to Notion without dedup check — created 19 duplicate entries on 2026-05-31, had to manually clean up.
- **One-directional loop (pushing without reading feedback)** — re-surfaced Anthropic Deal Desk / Deal Operations roles the user had already marked Not a Fit. Root cause: never queried Notion for rejections before pushing. Fixed 2026-06-03 with the Feedback Loop rule above.
- **Duplicates across sessions** — same Anthropic F&S roles pushed 3-4× because dedup wasn't enforced in early sessions. Multiple copies of "Deal Desk - EMEA" / "Deal Operations - EMEA" exist in Notion and need cleanup.
- **Pushing WebSearch URLs blind ("est. — Verify JD")** — 2026-06-03: ~50% of reviewed roles were EXPIRED, rest NOT A FIT. All were WebSearch-sourced, unverified, unread. This nearly made the user abandon the system. Fixed with the HARD RULE above: liveness + JD-read gates, scan.mjs as sole push source, WebSearch for company-discovery only. Trust was the cost — do not repeat.
