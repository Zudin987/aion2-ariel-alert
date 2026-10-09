# Cloudflare Workers — Ariel character-creation monitor

This is the free-tier serverless alternative to the Python / GitHub Actions scheduler.

**Target:** AION 2 Global / Asia / Elyos / Ariel.
**Source:** https://aion2.gaming.tools/server-status?region=AS
**Schedule:** Cloudflare Cron Trigger every five minutes, UTC; best-effort.
**Storage:** Cloudflare KV STATE namespace, automatically provisioned by Wrangler 4.45+.
**Notifications:** Existing Discord webhook when character creation changes from blocked to open.
**Diagnostics:** Read-only public /health route shows the last check, any error, and the last observed creation status.

Cloudflare Workers Free allows 100,000 requests/day and 10 ms CPU per invocation. Cloudflare KV Free allows 100,000 reads and 1,000 writes/day. At 288 scheduled invocations per day (one read and one write each), this small monitor fits within those usage allowances. Verify actual CPU and Cron behavior after deployment.

## Set up directly using the Cloudflare dashboard

1. Open https://dash.cloudflare.com/ and sign in or create a free account.
2. Go to **Workers & Pages → Create application → Import a repository**.
3. Authorize GitHub and select **Zudin987/aion2-ariel-alert** (grant Cloudflare access to this repository if asked).
4. Configure:
   - **Worker name:** aion2-ariel-alert
   - **Production branch:** main
   - **Root directory:** cloudflare
   - **Build command:** npm install && npm test
   - **Deploy command:** npm run deploy
5. Choose **Save and Deploy**. Recent Wrangler automatically provisions the Cloudflare KV namespace for the STATE binding defined in wrangler.jsonc. Check Worker **Settings → Bindings** for the STATE binding. No namespace IDs need to be copied or supplied.
6. Under Worker **Settings → Variables and Secrets → Add**, choose **Secret**, set the name **DISCORD_WEBHOOK_URL**, and paste the URL for the same Discord webhook you previously tested. Select Deploy. GitHub Actions secrets are not transferable or readable from Cloudflare; you must set this secret again in Cloudflare. NEVER paste it into your public repository or this chat.
7. Optional: add text variable **DISCORD_ROLE_ID** with a numeric Discord role ID if you want an automatic role ping. If unset, nobody is pinged.

## Verify automatic checks

Cloudflare says new or changed Cron Triggers can take **up to 15 minutes** to propagate.

Open the real workers.dev URL Cloudflare created, then append **/health** to it. The JSON fields are:

- **lastCheckedAt** — most recent scheduled attempt, including failures.
- **lastSuccessAt** — last successfully parsed server status.
- **savedCreationStatus** — blocked, open, or null before the first successful check.
- **lastError** — error from the last attempt (null when successful).
- **lastObservation** — most recent parsed Ariel status.
- **lastAlertAt** — timestamp of the last Discord unlock alert.

Times are UTC; Malaysia is UTC+8. Refresh the /health page 10–20 minutes later and see whether lastCheckedAt advances. The /health endpoint does not trigger status checks or Discord messages. Its fields are publicly visible to anyone who knows the Worker URL.

**Keep the old GitHub Actions monitor running until the Cloudflare /health endpoint confirms successful scheduled checks.** Once the Cloudflare version is verified, disable the older GitHub Actions workflow in .github/workflows/monitor.yml so that two independent systems do not both alert for one unlock.

## Safety behavior

The Worker checks the exact Ariel / Elyos / Asia row and the website's explicit character-creation lock icon. It requires a recognizable lock label elsewhere on the page and fresh server-data timestamps. It confirms an apparent unlock with a second fetch. A missing row, altered schema, stale tracker, maintenance or network failure cannot be mistaken for an unlock. This deliberately prioritizes avoiding false alerts, even if a page-format change means a legitimate opening is temporarily missed.

No AION 2 login or game account data is used. The website is unofficial; confirm availability in the game. The KV store is eventually consistent; extremely rare duplicate notifications are possible if Discord succeeds but subsequent state persistence fails.

## For developers

Run these commands from the cloudflare subfolder:
- npm install
- npm test
- npx wrangler dev --test-scheduled (exposes /cdn-cgi/local/scheduled for local cron testing)
- npm run deploy

Never commit local .env or .dev.vars files or tokens.

Official documentation:
- https://developers.cloudflare.com/workers/ci-cd/builds/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/configuration/secrets/
