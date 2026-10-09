/** AION 2 Global: Ariel / Elyos / Asia creation-availability monitor. */
export const SOURCE_URL = 'https://aion2.gaming.tools/server-status?region=AS';
export const STATE_KEY = 'ariel:asia:elyos:creation:v1';
const LOCK_LABEL = 'Character creation blocked';
const TARGET = ['Ariel', 'Elyos', 'Asia'];
export class SourceError extends Error {}

function plain(html) {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function dateFromPage(html) {
  const re = /<[^>]*\btitle=["']([A-Za-z]+\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M\s+UTC)["'][^>]*>\s*Updated\b/i;
  const m = re.exec(html);
  if (!m) throw new SourceError('Server-data Updated timestamp not found');
  const p = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)\s+UTC$/i.exec(m[1]);
  if (!p) throw new SourceError('Could not read update timestamp');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months.findIndex(x => x.toLowerCase() === p[1].slice(0, 3).toLowerCase());
  const day = Number(p[2]), year = Number(p[3]), hour12 = Number(p[4]);
  const minute = Number(p[5]), second = Number(p[6]);
  if (month < 0 || hour12 < 1 || hour12 > 12 || minute > 59 || second > 59) {
    throw new SourceError('Invalid server-data timestamp components');
  }
  const hour = (hour12 % 12) + (p[7].toUpperCase() === 'PM' ? 12 : 0);
  const millis = Date.UTC(year, month, day, hour, minute, second);
  const d = new Date(millis);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
    throw new SourceError('Invalid server-data calendar date');
  }
  return millis;
}

export function parseStatus(html, now = Date.now()) {
  if (typeof html !== 'string' || html.length < 100) throw new SourceError('Empty or invalid HTML');
  const updatedAt = dateFromPage(html);
  const age = now - updatedAt;
  if (age < -5 * 60_000 || age > 30 * 60_000) {
    throw new SourceError('Server-data timestamp stale or future (' + Math.round(age / 1000) + 's)');
  }
  // Fail closed if the website has stopped exposing its documented lock label.
  if (!html.includes(LOCK_LABEL)) throw new SourceError('Missing known creation-lock marker on page');
  const required = ['status', 'server', 'faction', 'region', 'population'];
  const matches = [];
  for (const [, table] of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const head = /<thead\b[^>]*>([\s\S]*?)<\/thead\s*>/i.exec(table);
    if (!head) continue;
    const headings = [...head[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th\s*>/gi)]
      .map(m => plain(m[1]).toLowerCase());
    if (!required.every(key => headings.filter(h => h === key).length === 1)) continue;
    const idx = Object.fromEntries(required.map(key => [key, headings.indexOf(key)]));
    const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/i.exec(table);
    if (!body) continue;
    for (const [, row] of body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(m => m[1]);
      if (required.some(key => idx[key] >= cells.length)) continue;
      const serverCell = cells[idx.server];
      const named = /<span\b[^>]*class=["'][^"']*\bfont-medium\b[^"']*["'][^>]*>([\s\S]*?)<\/span\s*>/i.exec(serverCell);
      if (!named) continue;
      const identity = [plain(named[1]), plain(cells[idx.faction]), plain(cells[idx.region])];
      if (identity.some((value, i) => value !== TARGET[i])) continue;
      const online = plain(cells[idx.status]);
      const locks = [...serverCell.matchAll(/\baria-label\s*=\s*["']Character creation blocked["']/gi)];
      if (locks.length > 1) throw new SourceError('Duplicate Ariel lock markers');
      matches.push({
        server: TARGET[0], faction: TARGET[1], region: TARGET[2],
        online,
        creation: online === 'Online' ? (locks.length === 1 ? 'blocked' : 'open') : 'unavailable',
        population: plain(cells[idx.population]),
        sourceUpdatedAt: new Date(updatedAt).toISOString()
      });
    }
  }
  if (matches.length !== 1) throw new SourceError('Expected exactly one Ariel/Elyos/Asia row; found ' + matches.length);
  return matches[0];
}

export async function fetchStatus(fetchImpl = fetch, now = Date.now()) {
  const response = await fetchImpl(SOURCE_URL, {
    headers: { 'Accept': 'text/html', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(20000),
    cf: { cacheTtl: 0 }
  });
  if (!response.ok) throw new SourceError('Tracker HTTP ' + response.status);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    throw new SourceError('Tracker did not return HTML');
  }
  const html = await response.text();
  if (html.length > 2_000_000) throw new SourceError('Tracker response unexpectedly large');
  return parseStatus(html, now);
}

function previousState(value) {
  if (value == null) return { creation: null };
  if (typeof value !== 'object' || ![null, 'blocked', 'open'].includes(value.creation ?? null)) {
    throw new SourceError('Stored state is invalid; refusing to alert');
  }
  return value;
}
function validateWebhook(env) {
  const url = String(env.DISCORD_WEBHOOK_URL ?? '').trim();
  if (!/^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[^/\s]+$/.test(url)) {
    throw new Error('Configure the DISCORD_WEBHOOK_URL Worker secret');
  }
  return url;
}

export async function notifyDiscord(env, fetchImpl = fetch) {
  const url = validateWebhook(env);
  const role = String(env.DISCORD_ROLE_ID ?? '').trim();
  if (role && !/^\d{15,22}$/.test(role)) throw new Error('Invalid DISCORD_ROLE_ID');
  const ping = role ? '<@&' + role + '> ' : '';
  const content = ping + '🟢 **Ariel character creation OPEN!**\n' +
    '**AION 2 Global — Asia / Elyos / Ariel**\n' +
    'Try creating your character now: ' + SOURCE_URL + '\n' +
    '_Based on unofficial third-party data; please confirm in game._';
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [], roles: role ? [role] : [] } }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Discord webhook HTTP ' + response.status);
}

export async function runMonitor(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.STATE || typeof env.STATE.get !== 'function' || typeof env.STATE.put !== 'function') {
    throw new Error('STATE KV namespace binding missing');
  }
  const checkedAt = new Date(now).toISOString();
  const prior = previousState(await env.STATE.get(STATE_KEY, 'json'));
  try {
    const observed = await fetchStatus(fetchImpl, now);
    let alerted = false;
    if (observed.creation === 'open' && prior.creation !== 'open') {
      const confirmed = await fetchStatus(fetchImpl, now);
      if (confirmed.creation !== 'open') throw new SourceError('Opening was not confirmed by second fetch');
      await notifyDiscord(env, fetchImpl);
      alerted = true;
    }
    const state = {
      ...prior,
      creation: observed.creation === 'unavailable' ? prior.creation : observed.creation,
      lastCheckedAt: checkedAt,
      lastSuccessAt: checkedAt,
      lastError: null,
      lastObservation: observed,
      lastAlertAt: alerted ? checkedAt : (prior.lastAlertAt ?? null)
    };
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
    console.log(JSON.stringify({ event: 'ariel_check', creation: observed.creation, online: observed.online, alerted, checkedAt }));
    return { state, alerted };
  } catch (error) {
    const state = {
      ...prior,
      lastCheckedAt: checkedAt,
      lastError: String(error?.message ?? error).slice(0, 240)
    };
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
    console.error(JSON.stringify({ event: 'ariel_check_failed', reason: state.lastError, checkedAt }));
    throw error;
  }
}

export default {
  async scheduled(_controller, env, _ctx) {
    await runMonitor(env);
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !['/', '/health'].includes(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const state = previousState(await env.STATE.get(STATE_KEY, 'json'));
      return Response.json({
        service: 'AION 2 Ariel Creation Monitor',
        target: 'Asia / Elyos / Ariel',
        scheduledEvery: '5 minutes (best effort)',
        savedCreationStatus: state.creation,
        lastCheckedAt: state.lastCheckedAt ?? null,
        lastSuccessAt: state.lastSuccessAt ?? null,
        lastError: state.lastError ?? null,
        lastObservation: state.lastObservation ?? null,
        lastAlertAt: state.lastAlertAt ?? null
      }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'Unable to read state' }, { status: 503 });
    }
  }
};
