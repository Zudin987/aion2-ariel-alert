# AION 2 Ariel Character-Creation Alert

Discord webhook monitor for **Ariel / Elyos / Asia**.

Source: https://aion2.gaming.tools/server-status?region=AS

## How it works

- Checks the Ariel/Elyos/Asia row for the **Character creation blocked** icon, not just server-online status.
- Sends a Discord alert when character creation is **open**, including an opening on its very first observed check.
- Saves the prior blocked/open state in state.json and alerts just once per opening.
- Validates source update time (within 30 minutes), server status, exact target, and a second positive page request to avoid false alarms.
- Does not alert on maintenance, stale/changed HTML, or network failure.
- Uses a third-party data source; game login remains the final authority.

## Activate Discord alerts

1. In the target Discord channel, open **Edit Channel → Integrations → Webhooks → New Webhook**. Copy the webhook URL. **Keep it private.**
2. In this repo open **Settings → Secrets and variables → Actions → New repository secret** and add name **DISCORD_WEBHOOK_URL** with that URL. Do not paste the webhook into any repository file, issue, or chat.
3. Optional role ping: in **Settings → Secrets and variables → Actions → Variables**, add **DISCORD_ROLE_ID** as the numeric role ID. No role is pinged by default.
4. Open **Actions → Ariel Character Creation Monitor → Run workflow**. First use **test-alert** to verify the Discord message; then **check** to verify website access.
5. The workflow runs automatically around every **5 minutes**. Runs may be delayed or missed by GitHub Actions. If the state commit fails, check **Settings → Actions → General → Workflow permissions** and grant read/write access if available.

The monitor is intentionally conservative: failure to detect a lock must never be mistaken for evidence of an unlock when the source format or timestamp becomes invalid.

## Local commands

    pip install -r requirements.txt
    python -m unittest discover -s tests -v
    python monitor.py --check

For webhook testing, set DISCORD_WEBHOOK_URL in your environment and run:

    python monitor.py --test-alert

Never publish Discord webhook URLs or other credentials. Scheduled workflows can be disabled by GitHub after extended repository inactivity.

## Cloudflare Workers version (recommended)

The new Cloudflare Worker (see cloudflare/README.md) checks every five minutes using Cloudflare Cron, remembers alert state in free Cloudflare KV, and provides a read-only /health endpoint to verify scheduled activity.

To deploy it, connect this repository through Cloudflare Workers & Pages → Import a repository, set the Worker name to aion2-ariel-alert and root directory to cloudflare, build command to npm install && npm test, and deploy command to npm run deploy. After deployment, add DISCORD_WEBHOOK_URL as a private Cloudflare Worker Secret. The KV namespace is automatically provisioned.

**The Cloudflare Worker is not active yet.** Keep the old GitHub Actions monitor until Cloudflare /health confirms working scheduled checks, then disable GitHub's scheduled workflow to prevent duplicates.
