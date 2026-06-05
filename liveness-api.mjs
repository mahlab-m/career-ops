#!/usr/bin/env node
/**
 * liveness-api.mjs — zero-token job liveness checker (no Playwright)
 *
 * Verifies a job posting is still OPEN by hitting the ATS API directly.
 * HTTP 200 is NOT trusted (Ashby/SPA boards return 200 for dead pages).
 *
 * Detection:
 *   - Ashby:      ApiJobPosting GraphQL -> data.jobPosting === null => EXPIRED
 *   - Lever:      GET /v0/postings/{slug}/{id} -> non-200 => EXPIRED
 *   - Greenhouse: GET /v1/boards/{slug}/jobs/{id} -> non-200 => EXPIRED
 *                 (corporate-domain gh_jid links map via DOMAIN_SLUG below)
 *
 * Usage:
 *   node liveness-api.mjs <url1> [url2] ...
 *   echo "<url>" | node liveness-api.mjs -
 * Prints: "LIVE <url>" / "DEAD <url>" / "UNKNOWN <url>"
 * Exit 0 if all LIVE, 1 if any DEAD/UNKNOWN.
 */

const DOMAIN_SLUG = {
  "stripe.com": "stripe", "sumup.com": "sumup", "complyadvantage.com": "complyadvantage",
  "helsing.ai": "helsing", "dojo.careers": "dojo", "getyourguide.careers": "getyourguide",
};

async function httpStatus(url) {
  try { const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }); return r.status; }
  catch { return null; }
}

export async function checkLiveness(url) {
  // Ashby
  let m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/);
  if (m) {
    const [, org, jid] = m;
    try {
      const r = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationName: "ApiJobPosting",
          variables: { organizationHostedJobsPageName: org, jobPostingId: jid },
          query: "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { title } }",
        }),
      });
      const d = await r.json();
      return d?.data?.jobPosting ? "LIVE" : "DEAD";
    } catch { return "UNKNOWN"; }
  }
  // Lever
  m = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/);
  if (m) { const [, slug, jid] = m; return (await httpStatus(`https://api.lever.co/v0/postings/${slug}/${jid}`)) === 200 ? "LIVE" : "DEAD"; }
  // Greenhouse direct
  m = url.match(/job-boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (m) { const [, slug, jid] = m; return (await httpStatus(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jid}`)) === 200 ? "LIVE" : "DEAD"; }
  // Corporate domain with gh_jid
  m = url.match(/https?:\/\/([^/]+).*[?&]gh_jid=(\d+)/);
  if (m) {
    const dom = m[1].replace(/^www\./, ""), jid = m[2], slug = DOMAIN_SLUG[dom];
    if (slug) return (await httpStatus(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jid}`)) === 200 ? "LIVE" : "DEAD";
  }
  return "UNKNOWN";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let urls = process.argv.slice(2);
  if (urls.length === 1 && urls[0] === "-") {
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    urls = Buffer.concat(chunks).toString().split(/\s+/).filter(Boolean);
  }
  let bad = 0;
  for (const u of urls) { const s = await checkLiveness(u); if (s !== "LIVE") bad++; console.log(`${s} ${u}`); }
  process.exit(bad ? 1 : 0);
}
