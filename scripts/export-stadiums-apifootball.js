/**
 * FOOTBALLGLOBE - STADIUM EXPORT (API-FOOTBALL VERSION)
 *
 * A sibling to export-stadiums-proxy.js, not a replacement. That script feeds
 * the live site from football-data.org via the maprates proxy; this one is a
 * scoping tool for a much wider source (api-sports.io), whose output is
 * inspected by hand before anything downstream consumes it.
 *
 * Source: GET /teams?league={id}&season={season} against
 *   v3.football.api-sports.io, keyed by x-apisports-key. League IDs and the
 *   season come from scripts/apifootball-scope.json.
 *
 * Failure mode: this API answers HTTP 200 even when the call failed, and puts
 *   the reason in `errors` - an empty ARRAY on success, a populated DICT on
 *   failure. A failed call therefore looks exactly like a league with no
 *   teams unless `errors` is checked explicitly, which is why it is checked
 *   before `response` is read at all.
 *
 * Rate limits: two independent budgets, never to be conflated.
 *   per-minute: x-ratelimit-limit / x-ratelimit-remaining          (300)
 *   per-day:    x-ratelimit-requests-limit / -requests-remaining  (7500)
 *   Both are logged on every call. The run aborts when the DAILY remainder
 *   drops below DAILY_FLOOR, so a scoping pass can never eat the whole day's
 *   budget and leave nothing for the real export.
 *
 * Output: dry runs write stadiums-apifootball-dryrun.json and are unguarded -
 *   a dry run is a sample and is SUPPOSED to be small. Only --all writes
 *   stadiums-apifootball-candidate.json, and only that file gets the
 *   shrink guard. Every venue is written regardless of capacity; choosing a
 *   capacity cutoff is the geocoding step's job, and it needs the whole
 *   distribution to choose from.
 *
 * File safety: a file already present at an output path is treated as the
 *   NORMAL case - another terminal or session may own it, and this process
 *   cannot see their work. Anything this run did not create is backed up to
 *   <name>.bak-<timestamp> before being replaced, and no production path is
 *   ever deleted. Probe runs (--probe-league / PROBE_LABEL) are redirected onto
 *   probe-prefixed paths in PROBE_DIR - a directory OUTSIDE the repository -
 *   and cannot address a production path at all, so a throwaway experiment can
 *   never land on real output. The only deletion in this script removes probe
 *   artifacts this same run created, verified by prefix and by directory.
 *
 * Usage: node scripts/export-stadiums-apifootball.js [--all]
 *        node scripts/export-stadiums-apifootball.js --probe-league=39 [--cleanup-probe]
 *        node scripts/export-stadiums-apifootball.js --rematch-only [--force-shrink]
 *        CALL_DELAY_MS=1500 node scripts/export-stadiums-apifootball.js --all
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const API_HOST = 'v3.football.api-sports.io';

// Resolved from __dirname so the script reads and writes the same files no
// matter which directory it is run from.
const ROOT = path.join(__dirname, '..');
const SCOPE_PATH = path.join(__dirname, 'apifootball-scope.json');
const PREMIUM_PATH = path.join(ROOT, 'public', 'stadiums-premium.json');

// Delay between calls, in ms. The per-minute ceiling is 300, so 1000ms is
// comfortably inside it; raise it if the account is on a smaller plan.
const CALL_DELAY_MS = Number(process.env.CALL_DELAY_MS) || 1000;

// Leagues fetched when --all is absent. A dry run exists to show the shape of
// the data and the summary, not to cover the scope.
const DRY_RUN_LEAGUES = 5;

// Abort while there is still enough daily budget left to be useful tomorrow -
// and, more to the point, before the API starts refusing calls mid-run.
const DAILY_FLOOR = 50;

// Documented limits, used only to render "N/300" and "N/7500" when a header
// is missing. The headers themselves are authoritative when present.
const MINUTE_LIMIT_FALLBACK = 300;
const DAILY_LIMIT_FALLBACK = 7500;

/**
 * Re-run both carry-forward passes against the existing candidate file and
 * make NO API calls at all. The point is that the match rule above can be
 * changed and re-evaluated without re-pulling 781 leagues; the venue data
 * itself is left exactly as the fetching run wrote it.
 */
const REMATCH_ONLY = process.argv.includes('--rematch-only');

const FETCH_ALL = process.argv.includes('--all');

/**
 * --probe-league=<id> fetches exactly one league so a match rule can be tried
 * against real data. It exists so that probing never again means hand-writing
 * a production filename from a throwaway script: a probe run is redirected
 * onto probe-prefixed paths and CANNOT address a production path at all.
 */
function parseProbeLeague(argv) {
  const arg = argv.find(a => a.startsWith('--probe-league='));
  if (!arg) return null;
  const id = Number(arg.slice('--probe-league='.length));
  if (!Number.isInteger(id) || id <= 0) {
    console.error(`ERROR: --probe-league needs a positive league id, got "${arg}"`);
    process.exit(1);
  }
  return id;
}

const PROBE_LEAGUE = parseProbeLeague(process.argv);
const PROBE_PREFIX = 'probe-';
const PROBE_LABEL = process.env.PROBE_LABEL || (PROBE_LEAGUE ? `league${PROBE_LEAGUE}` : null);
const PROBE_MODE = PROBE_LABEL !== null;

// Probe output lives OUTSIDE the repository. A prefix alone still leaves a
// throwaway file sitting next to real ones, where a careless glob or a
// hand-typed rm can reach it; a separate directory means no repo path is ever
// a probe's target or a cleanup's target. Override with PROBE_DIR.
const PROBE_DIR = process.env.PROBE_DIR || path.join(os.tmpdir(), 'footballglobe-probes');

/**
 * Resolve an output filename. In probe mode every output - candidate, dry run
 * and pass-2 log alike - moves to PROBE_DIR and keeps the probe- prefix, so no
 * production path is reachable and every probe artifact is self-identifying.
 */
function outPath(base) {
  return PROBE_MODE
    ? path.join(PROBE_DIR, `${PROBE_PREFIX}${PROBE_LABEL}-${base}`)
    : path.join(ROOT, base);
}

if (PROBE_MODE) fs.mkdirSync(PROBE_DIR, { recursive: true });

const DRYRUN_PATH = outPath('stadiums-apifootball-dryrun.json');
const CANDIDATE_PATH = outPath('stadiums-apifootball-candidate.json');

// The pass-2 log is scoped to the run that produced it. A dry run samples five
// leagues and its match list says nothing about a full pass, so it must not be
// written where a full pass's reviewed log lives.
const PASS2_LOG_PATH = outPath(
  (FETCH_ALL || REMATCH_ONLY || PROBE_MODE)
    ? 'carry-forward-pass2.json'
    : 'carry-forward-pass2-dryrun.json'
);

const OUTPUT_PATH = (FETCH_ALL || REMATCH_ONLY || PROBE_MODE) ? CANDIDATE_PATH : DRYRUN_PATH;

// Deliberate override for the pass-2 shrink guard, for when a rule change is
// MEANT to produce fewer matches than the log already holds.
const FORCE_SHRINK = process.argv.includes('--force-shrink');

// Delete this run's own probe artifacts on the way out. Opt-in, because the
// usual reason to run a probe is to read what it wrote.
const CLEANUP_PROBE = process.argv.includes('--cleanup-probe');

const API_KEY = process.env.APIFOOTBALL_KEY;

// Venue name/city values that carry no information. The API uses these as
// filler for grounds it has not resolved, and they must not become records.
const PLACEHOLDER_VALUES = new Set([
  'tbc', 'tbd', 'tba', 'n a', 'na', 'none', 'null', 'unknown',
  'to be confirmed', 'to be decided', 'to be announced', '-', '--',
]);

/**
 * Premium venues whose stored coordinates are known to be imprecise. These are
 * NEVER carried forward, however well they match - they are to be re-geocoded
 * from scratch. Listed by their premium name; both the strict and the relaxed
 * normalisation of each is checked, so "The Elland Road Stadium" on the
 * API-Football side is excluded just as "Elland Road" is.
 */
const NO_CARRY_VENUES = [
  'Anfield',
  'Old Trafford',
  'Elland Road',
  'Carrow Road',
  'Bramall Lane',
];

/**
 * Thrown when the daily budget runs out. Distinct from a per-league error so
 * the loop can stop the whole run instead of recording 700 identical
 * "quota exceeded" failures.
 */
class DailyQuotaError extends Error {}

/**
 * Output paths this run created itself. Everything else at a production path
 * belongs to somebody else until proven otherwise.
 */
const createdThisRun = new Set();

/**
 * Write a JSON output file.
 *
 * A file already sitting at an output path is the NORMAL case, not the
 * exception: another terminal, another session, or an earlier run may own it,
 * and this process cannot see their work. So anything this run did not itself
 * create is copied aside before being replaced, and the backup path is
 * printed. This function never deletes; the single deletion in this script is
 * removeProbeArtifacts, which can only reach paths this run created.
 */
function writeOutputFile(targetPath, data) {
  if (fs.existsSync(targetPath) && !createdThisRun.has(targetPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${targetPath}.bak-${stamp}`;
    fs.copyFileSync(targetPath, backup);
    console.log(`🗃️  ${path.basename(targetPath)} already existed and was not created by this run`);
    console.log(`   backed up to: ${backup}`);
  }
  fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
  createdThisRun.add(targetPath);
}

/**
 * Write the pass-2 audit log, refusing ANY shrink - not just an empty result
 * over a populated log. Fewer matches than the log already holds means either
 * a narrower run (a probe, a dry run) or a rule that just got stricter;
 * neither is grounds for discarding entries a human may already have read and
 * trusted. --force-shrink says the shrink is intended.
 *
 * Returns whether the log was actually written, so the summary can say when
 * the log and the candidate no longer describe the same run.
 */
function writePass2Log(logPath, matches) {
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch (err) {
    existing = null;
  }
  const existingCount = Array.isArray(existing) ? existing.length : 0;

  if (matches.length < existingCount && !FORCE_SHRINK) {
    console.warn('');
    console.warn(`⚠️  REFUSING to shrink the pass-2 log: ${existingCount} entries on disk, ${matches.length} this run`);
    console.warn(`   ${logPath} left intact.`);
    console.warn('   The log now describes an EARLIER run than the candidate beside it.');
    console.warn('   Re-run with --force-shrink if the smaller result is the intended one.');
    console.warn('');
    return false;
  }

  writeOutputFile(logPath, matches);
  return true;
}

/**
 * Refuse to start a fetching probe whose outputs already exist. Overwriting
 * them would destroy an earlier probe's results as surely as overwriting a
 * production file would, and a probe label is cheap to change.
 * --rematch-only is exempt: re-scoring an existing probe candidate is the
 * whole point of it.
 */
function assertProbeTargetsFree() {
  const clashes = [OUTPUT_PATH, PASS2_LOG_PATH].filter(p => fs.existsSync(p));
  if (clashes.length === 0) return;

  console.error(`ERROR: probe "${PROBE_LABEL}" would overwrite files it did not create:`);
  for (const p of clashes) console.error(`   ${p}`);
  console.error('  Choose another label with PROBE_LABEL=..., or remove those files yourself.');
  process.exit(1);
}

/**
 * Delete this run's probe artifacts - and nothing else, ever.
 *
 * Three independent conditions, all required: the path is in createdThisRun,
 * its basename carries the probe prefix, and it sits inside PROBE_DIR. A
 * deletion that names a path literally, rather than deriving it from what this
 * run actually created, is the bug this function exists to make unwritable.
 */
function removeProbeArtifacts() {
  if (!PROBE_MODE) return;

  for (const target of createdThisRun) {
    if (!path.basename(target).startsWith(PROBE_PREFIX)) {
      console.error(`   refusing to delete (not probe-prefixed): ${target}`);
      continue;
    }
    if (path.relative(PROBE_DIR, target).startsWith('..')) {
      console.error(`   refusing to delete (outside PROBE_DIR): ${target}`);
      continue;
    }
    fs.unlinkSync(target);
    console.log(`🧹 removed probe artifact: ${target}`);
  }
}

/**
 * Sleep for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Decode the HTML entities this API leaves in its strings ("Saint-Étienne"
 * arrives as-is, but "St James&apos; Park" does not). Handles the named
 * entities that actually occur plus any numeric/hex reference.
 */
const NAMED_ENTITIES = {
  amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', ntilde: 'ñ', szlig: 'ß', oslash: 'ø', aring: 'å',
};

function decodeHtmlEntities(value) {
  if (typeof value !== 'string') return value;

  // Repeat until stable: the source occasionally double-escapes ("&amp;apos;").
  let previous;
  let current = value;
  let passes = 0;
  do {
    previous = current;
    current = current.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
      if (entity[0] === '#') {
        const codePoint = entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
        try {
          return String.fromCodePoint(codePoint);
        } catch (err) {
          return match;
        }
      }
      const named = NAMED_ENTITIES[entity.toLowerCase()];
      return named === undefined ? match : named;
    });
    passes++;
  } while (current !== previous && passes < 5);

  return current;
}

/**
 * Decode entities across every string in a nested structure, so no field is
 * left un-cleaned just because nobody thought to name it.
 */
function decodeDeep(value) {
  if (typeof value === 'string') return decodeHtmlEntities(value);
  if (Array.isArray(value)) return value.map(decodeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = decodeDeep(inner);
    return out;
  }
  return value;
}

/**
 * Normalise a string for matching: strip accents, lowercase, collapse
 * punctuation to single spaces. Same shape as normalizeForMatch in
 * geocode-stadiums.js, minus that script's Google-specific street-abbreviation
 * expansions, which have no counterpart in this source.
 */
function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pass-2 venue-name normalisation. Drops a leading "The" and a trailing
 * "Stadium"/"Arena", both of which the two sources disagree about freely
 * ("The City Ground" vs "City Ground", "Portman Road" vs "Portman Road
 * Stadium"). The trailing word is only dropped when something 2+ characters
 * long survives, so a ground actually called "Arena" keeps its name.
 */
function relaxVenueName(value) {
  let name = normalizeForMatch(value);
  name = name.replace(/^the\s+/, '');
  const trimmed = name.replace(/\s+(stadium|arena)$/, '');
  if (trimmed.length >= 2) name = trimmed;
  return name.trim();
}

/**
 * Pass-2 city normalisation. API-Football appends the county or region
 * ("Bournemouth, Dorset", "Leeds, West Yorkshire") where the premium file
 * holds the bare city, so everything from the first comma on is dropped.
 * Split before normalising, since normalizeForMatch eats the comma itself.
 */
function relaxCity(value) {
  return normalizeForMatch(String(value || '').split(',')[0]);
}

// Both normalisations of every no-carry name, so a match on either shape is
// caught regardless of which side's spelling it came from.
const NO_CARRY_KEYS = new Set(
  NO_CARRY_VENUES.flatMap(name => [normalizeForMatch(name), relaxVenueName(name)])
);

function isNoCarry(venueName) {
  return NO_CARRY_KEYS.has(normalizeForMatch(venueName))
    || NO_CARRY_KEYS.has(relaxVenueName(venueName));
}

/**
 * Whether a value is filler rather than a real name. Normalised first, so
 * "T.B.C." and "TBC " land on the same entry as "tbc".
 */
function isPlaceholder(value) {
  const normalized = normalizeForMatch(value);
  if (normalized.length === 0) return true;
  return PLACEHOLDER_VALUES.has(normalized);
}

/**
 * GET an endpoint and return { body, headers }. Rejects on transport errors,
 * non-200 status, and unparseable JSON; a 200 carrying a populated `errors`
 * field is the caller's business, since only the caller knows the league it
 * belongs to.
 */
function fetchFromApi(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      path: pathAndQuery,
      method: 'GET',
      headers: { 'x-apisports-key': API_KEY },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve({ body: JSON.parse(data), headers: res.headers });
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Render the two rate-limit budgets. They are read from different header
 * pairs and printed as one line each so a remaining-value can never be
 * silently compared against the other budget's limit.
 */
function readRateLimits(headers) {
  const num = (name) => {
    const raw = headers[name];
    if (raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    minuteRemaining: num('x-ratelimit-remaining'),
    minuteLimit: num('x-ratelimit-limit') ?? MINUTE_LIMIT_FALLBACK,
    dailyRemaining: num('x-ratelimit-requests-remaining'),
    dailyLimit: num('x-ratelimit-requests-limit') ?? DAILY_LIMIT_FALLBACK,
  };
}

function formatRateLimits(limits) {
  const minute = limits.minuteRemaining === null ? '?' : limits.minuteRemaining;
  const daily = limits.dailyRemaining === null ? '?' : limits.dailyRemaining;
  return `minute: ${minute}/${limits.minuteLimit}   day: ${daily}/${limits.dailyLimit}`;
}

/**
 * Read the `errors` field. Success is an empty ARRAY; failure is a populated
 * DICT (and, defensively, a populated array). Returns a list of messages,
 * empty when the call actually succeeded.
 */
function extractApiErrors(body) {
  const errors = body && body.errors;
  if (errors === undefined || errors === null) return [];
  if (Array.isArray(errors)) {
    return errors.map(e => (typeof e === 'string' ? e : JSON.stringify(e)));
  }
  if (typeof errors === 'object') {
    return Object.entries(errors).map(([key, message]) => `${key}: ${message}`);
  }
  return [String(errors)];
}

/**
 * Fetch one league's teams. Throws on transport failure or on a 200 whose
 * `errors` field is populated - never returns an empty team list to stand in
 * for a failed call.
 */
async function fetchLeagueTeams(leagueId, season) {
  const { body, headers } = await fetchFromApi(`/teams?league=${leagueId}&season=${season}`);
  const limits = readRateLimits(headers);

  console.log(`   ${formatRateLimits(limits)}`);

  const errors = extractApiErrors(body);
  if (errors.length > 0) {
    const message = errors.join('; ');
    // A daily-quota refusal is terminal for the whole run, not just this league.
    if (/requests?[^a-z]*limit|quota|reached.*request/i.test(message)) {
      throw new DailyQuotaError(message);
    }
    throw new Error(message);
  }

  if (limits.dailyRemaining !== null && limits.dailyRemaining < DAILY_FLOOR) {
    throw new DailyQuotaError(
      `daily budget down to ${limits.dailyRemaining}/${limits.dailyLimit} (floor ${DAILY_FLOOR})`
    );
  }

  return {
    // /teams?league= reports paging.total: 1 for every league, so the whole
    // result set is always in this one response and there is no page 2 to ask
    // for. Recorded here so a future reader can see that was checked.
    paging: body.paging || null,
    // The season the API says it answered for, rather than the one we asked
    // for - they can differ when a league's season is labelled by end year.
    season: body?.parameters?.season ?? season,
    teams: Array.isArray(body.response) ? body.response : [],
  };
}

/**
 * Country keys for a premium record. Indexed under BOTH area.name and
 * area.code ("England" and "ENG"), because the API-Football side supplies only
 * a single free-text country string and may agree with either.
 */
function premiumCountryKeys(area) {
  if (!area) return [];
  return [area.name, area.code]
    .map(normalizeForMatch)
    .filter(key => key.length > 0);
}

/**
 * Index public/stadiums-premium.json for both carry-forward passes. Those 212
 * records are hand-verified and include 15 applications of the manual venue
 * overrides, so anything matching one must take its coordinates rather than
 * be geocoded again.
 *
 * Three indexes come out of it:
 *   byNameCity        strict  name|city  -> entry          (pass 1)
 *   byRelaxedNameCity relaxed name|city  -> entry          (pass 2)
 *   byRelaxedName     relaxed name -> { entry, grounds }   (pass 2, name-only)
 *
 * `grounds` counts DISTINCT grounds, not records: a club in both its domestic
 * league and the Champions League contributes two identical records, and that
 * must not read as an ambiguous name.
 */
function loadPremiumIndex() {
  let premium;
  try {
    premium = JSON.parse(fs.readFileSync(PREMIUM_PATH, 'utf8'));
  } catch (err) {
    console.warn(`⚠️  Could not read ${PREMIUM_PATH}: ${err.message}`);
    console.warn('   Continuing with no carried coordinates - every venue will need geocoding.');
    return {
      byNameCity: new Map(),
      byRelaxedNameCity: new Map(),
      byRelaxedName: new Map(),
      byCountryAndRelaxedName: new Map(),
      size: 0,
    };
  }

  const byNameCity = new Map();
  const byRelaxedNameCity = new Map();
  const byRelaxedName = new Map();
  const byCountryAndRelaxedName = new Map();

  for (const country of Object.values(premium.countries || {})) {
    for (const league of country.leagues || []) {
      for (const stadium of league.stadiums || []) {
        if (!Number.isFinite(stadium.latitude) || !Number.isFinite(stadium.longitude)) continue;
        if (!stadium.venue || !stadium.city) continue;

        const entry = {
          latitude: stadium.latitude,
          longitude: stadium.longitude,
          venue: stadium.venue,
          city: stadium.city,
          areaName: stadium.area?.name ?? null,
          areaCode: stadium.area?.code ?? null,
        };
        const groundKey = `${normalizeForMatch(stadium.venue)}|${normalizeForMatch(stadium.city)}`;

        if (!byNameCity.has(groundKey)) byNameCity.set(groundKey, entry);

        const relaxedKey = `${relaxVenueName(stadium.venue)}|${relaxCity(stadium.city)}`;
        if (!byRelaxedNameCity.has(relaxedKey)) byRelaxedNameCity.set(relaxedKey, entry);

        const relaxedName = relaxVenueName(stadium.venue);

        // Global name index. Used ONLY to tell "no such name anywhere" apart
        // from "that name exists, but in another country" when reporting
        // country-mismatch rejections; it never authorises a match.
        if (!byRelaxedName.has(relaxedName)) byRelaxedName.set(relaxedName, new Set());
        byRelaxedName.get(relaxedName).add(groundKey);

        // Country-scoped name index. This is what a name-only match reads, so
        // uniqueness is judged inside one country rather than worldwide.
        for (const countryKey of premiumCountryKeys(stadium.area)) {
          const key = `${countryKey}|${relaxedName}`;
          if (!byCountryAndRelaxedName.has(key)) {
            byCountryAndRelaxedName.set(key, { entry, grounds: new Set() });
          }
          byCountryAndRelaxedName.get(key).grounds.add(groundKey);
        }
      }
    }
  }

  return { byNameCity, byRelaxedNameCity, byRelaxedName, byCountryAndRelaxedName, size: byNameCity.size };
}
/**
 * Two-pass coordinate carry-forward, reported separately.
 *
 * Pass 1 is exact: strict normalised name AND city must both match. Nothing
 *   about it is negotiable - it is the rule the 212 hand-verified records were
 *   checked under.
 *
 * Pass 2 sees only what pass 1 missed, and tries two rules in order:
 *   relaxed-name-city  relaxed name AND relaxed city match
 *   name-only          relaxed names match, the two sides agree on country
 *                      (premium area.name OR area.code), and the name is
 *                      unique WITHIN that country on both sides. An unknown
 *                      country on either side refuses the match outright.
 *                      Ambiguity or a country mismatch leaves it unmatched and
 *                      counted, because a wrong coordinate is worse than a
 *                      missing one.
 *
 * NO_CARRY venues are refused before pass 1 even looks at them, and again if a
 * match lands on one, so no rule can smuggle a known-imprecise coordinate
 * through.
 */
function applyCarryForward(venues, premium) {
  let pass1 = 0;
  let pass2 = 0;
  let excluded = 0;
  const pass2Matches = [];

  // Why a name-only candidate was refused. Country mismatch is called out
  // separately in the summary: it is the failure that means "the same ground
  // name exists in the premium set, but somewhere else entirely".
  const nameOnlyRejected = { countryMismatch: 0, unknownCountry: 0, ambiguous: 0 };

  // Relaxed-name frequency WITHIN each country, for the uniqueness test on the
  // API-Football side. Keyed the same way as the premium country index, so the
  // two sides are counted under identical rules.
  const apiNameCounts = new Map();
  for (const venue of venues) {
    const countryKey = normalizeForMatch(venue.country);
    if (countryKey.length === 0) continue;
    const key = `${countryKey}|${relaxVenueName(venue.name)}`;
    apiNameCounts.set(key, (apiNameCounts.get(key) || 0) + 1);
  }

  const assign = (venue, entry, rule) => {
    venue.latitude = entry.latitude;
    venue.longitude = entry.longitude;
    venue.coordinateSource = 'stadiums-premium.json';
    venue.carryRule = rule;
  };

  const unmatched = [];

  for (const venue of venues) {
    // Reset first, so --rematch-only never inherits a previous run's decision.
    venue.latitude = null;
    venue.longitude = null;
    venue.coordinateSource = null;
    venue.carryRule = null;
    venue.carryExcluded = false;

    if (isNoCarry(venue.name)) {
      venue.carryExcluded = true;
      excluded++;
      continue;
    }

    const match = venue.city
      ? premium.byNameCity.get(`${normalizeForMatch(venue.name)}|${normalizeForMatch(venue.city)}`)
      : null;

    if (match) {
      // Belt and braces: pass 1 requires the names to be equal, so this can
      // only fire if the two sides spell a no-carry ground identically - but
      // the rule is "never", not "usually never".
      if (isNoCarry(match.venue)) {
        venue.carryExcluded = true;
        excluded++;
        continue;
      }
      assign(venue, match, 'exact-name-city');
      pass1++;
      continue;
    }

    unmatched.push(venue);
  }

  for (const venue of unmatched) {
    const relaxedName = relaxVenueName(venue.name);
    let rule = null;
    let match = venue.city
      ? premium.byRelaxedNameCity.get(`${relaxedName}|${relaxCity(venue.city)}`)
      : null;

    if (match) {
      rule = 'relaxed-name-city';
    } else {
      // Name-only. The weakest rule in the script, so it carries the most
      // conditions: same country on both sides, and the name unique within
      // that country on both sides.
      const countryKey = normalizeForMatch(venue.country);

      if (countryKey.length === 0) {
        // Country unknown on the API-Football side - do not guess.
        if (premium.byRelaxedName.has(relaxedName)) nameOnlyRejected.unknownCountry++;
      } else {
        const candidate = premium.byCountryAndRelaxedName.get(`${countryKey}|${relaxedName}`);

        if (!candidate) {
          // A premium ground of this name exists, but not in this country. A
          // premium record with no area at all never reaches the country
          // index, so it lands here too - unknown country, same refusal.
          if (premium.byRelaxedName.has(relaxedName)) nameOnlyRejected.countryMismatch++;
        } else if (candidate.grounds.size !== 1
                   || apiNameCounts.get(`${countryKey}|${relaxedName}`) !== 1) {
          nameOnlyRejected.ambiguous++;
        } else {
          match = candidate.entry;
          rule = 'name-only';
        }
      }
    }

    if (!match) continue;

    if (isNoCarry(match.venue)) {
      venue.carryExcluded = true;
      excluded++;
      continue;
    }

    assign(venue, match, rule);
    pass2++;
    pass2Matches.push({
      apifootballName: venue.name,
      apifootballCity: venue.city,
      apifootballCountry: venue.country,
      premiumName: match.venue,
      premiumCity: match.city,
      premiumCountry: match.areaName,
      rule,
    });
  }

  return { pass1, pass2, excluded, pass2Matches, nameOnlyRejected };
}
/**
 * Turn one /teams entry into a venue record, or return null with a reason.
 * Cleaning order is deliberate: national sides go first (they have venues but
 * are not clubs), then structurally missing venues, then placeholder junk,
 * and entities are decoded before anything is compared or keyed so that
 * "St James&apos; Park" and "St James' Park" cannot become two venues.
 */
function toVenueRecord(entry, leagueId) {
  const team = decodeDeep(entry && entry.team) || {};
  const venue = decodeDeep(entry && entry.venue);

  if (team.national === true) {
    return { skipped: 'national' };
  }
  if (!venue || venue.name === undefined || venue.name === null || venue.name === '') {
    return { skipped: 'no-venue' };
  }
  if (isPlaceholder(venue.name) || (venue.city !== undefined && venue.city !== null && venue.city !== '' && isPlaceholder(venue.city))) {
    return { skipped: 'placeholder' };
  }

  return {
    record: {
      venueId: venue.id ?? null,
      name: venue.name,
      address: venue.address ?? null,
      city: venue.city ?? null,
      country: team.country ?? null,
      capacity: Number.isFinite(venue.capacity) ? venue.capacity : null,
      surface: venue.surface ?? null,
      image: venue.image ?? null,
      teamIds: team.id != null ? [team.id] : [],
      teamNames: team.name ? [team.name] : [],
      leagueIds: [leagueId],
      venueIds: venue.id != null ? [venue.id] : [],
      latitude: null,
      longitude: null,
      coordinateSource: null,
      carryRule: null,
      carryExcluded: false,
    },
  };
}

/**
 * Fold b's associations into a, keeping a's own descriptive fields but filling
 * any it lacks from b. Used by both dedup passes.
 */
function mergeVenues(a, b) {
  const union = (left, right) => Array.from(new Set([...left, ...right]));

  a.teamIds = union(a.teamIds, b.teamIds);
  a.teamNames = union(a.teamNames, b.teamNames);
  a.leagueIds = union(a.leagueIds, b.leagueIds);
  a.venueIds = union(a.venueIds, b.venueIds);

  a.address = a.address ?? b.address;
  a.city = a.city ?? b.city;
  a.country = a.country ?? b.country;
  a.surface = a.surface ?? b.surface;
  a.image = a.image ?? b.image;
  // Keep the larger stated capacity: the source's null/0 entries are missing
  // data, not genuinely tiny grounds.
  if ((b.capacity ?? 0) > (a.capacity ?? 0)) a.capacity = b.capacity;

  return a;
}

/**
 * Two-pass dedup.
 *
 * Pass 1 keys on venue.id, which catches the ordinary case of one ground
 * shared by several clubs or appearing in several leagues.
 *
 * Pass 2 catches what pass 1 cannot: the same ground carrying two different
 * venue IDs because its city is transliterated differently in each record
 * ("Almaty" vs "Almatı (Almaty)"). Those records agree on normalised name AND
 * address, so that pair is the merge key - city is deliberately excluded,
 * because differing city strings are the very symptom being repaired. The
 * lower ID wins, and every associated team ID is collected onto it.
 */
function dedupeVenues(records) {
  const byVenueId = new Map();
  const withoutId = [];

  for (const record of records) {
    if (record.venueId == null) {
      withoutId.push(record);
      continue;
    }
    const existing = byVenueId.get(record.venueId);
    if (existing) mergeVenues(existing, record);
    else byVenueId.set(record.venueId, record);
  }

  const firstPass = [...byVenueId.values(), ...withoutId];
  const idMerges = records.length - firstPass.length;

  const byNameAndAddress = new Map();
  const result = [];
  let nameAddressMerges = 0;

  // Lowest ID first, so the survivor of any merge is the lower ID by
  // construction rather than by comparison.
  const ordered = [...firstPass].sort((a, b) => {
    if (a.venueId == null) return 1;
    if (b.venueId == null) return -1;
    return a.venueId - b.venueId;
  });

  for (const record of ordered) {
    const key = `${normalizeForMatch(record.name)}|${normalizeForMatch(record.address)}`;
    // A record with neither a usable name nor address key is left alone rather
    // than being merged with every other blank-address venue.
    if (normalizeForMatch(record.address).length === 0) {
      result.push(record);
      continue;
    }
    const existing = byNameAndAddress.get(key);
    if (existing) {
      mergeVenues(existing, record);
      nameAddressMerges++;
    } else {
      byNameAndAddress.set(key, record);
      result.push(record);
    }
  }

  return { venues: result, idMerges, nameAddressMerges };
}

/**
 * Bucket capacities so a capacity cutoff can be chosen from evidence rather
 * than guessed. Cumulative counts are what a cutoff decision actually needs:
 * "how many venues survive at >= 10,000".
 */
const CAPACITY_BUCKETS = [
  { label: 'unknown / 0', min: null, max: null },
  { label: '1 - 999', min: 1, max: 999 },
  { label: '1,000 - 4,999', min: 1000, max: 4999 },
  { label: '5,000 - 9,999', min: 5000, max: 9999 },
  { label: '10,000 - 19,999', min: 10000, max: 19999 },
  { label: '20,000 - 39,999', min: 20000, max: 39999 },
  { label: '40,000 - 59,999', min: 40000, max: 59999 },
  { label: '60,000+', min: 60000, max: Infinity },
];

function capacityDistribution(venues) {
  const counts = CAPACITY_BUCKETS.map(() => 0);

  for (const venue of venues) {
    const capacity = Number.isFinite(venue.capacity) ? venue.capacity : 0;
    if (capacity <= 0) {
      counts[0]++;
      continue;
    }
    const index = CAPACITY_BUCKETS.findIndex(
      (bucket, i) => i > 0 && capacity >= bucket.min && capacity <= bucket.max
    );
    counts[index === -1 ? 0 : index]++;
  }

  // Cumulative "at or above this bucket's floor", skipping the unknown bucket.
  let running = 0;
  const rows = [];
  for (let i = counts.length - 1; i >= 1; i--) {
    running += counts[i];
    rows.unshift({
      label: CAPACITY_BUCKETS[i].label,
      count: counts[i],
      atOrAbove: running,
      floor: CAPACITY_BUCKETS[i].min,
    });
  }
  rows.unshift({ label: CAPACITY_BUCKETS[0].label, count: counts[0], atOrAbove: null, floor: null });

  return rows;
}

/**
 * Run carry-forward over a venue list, fold the results into the output
 * object, and write the pass-2 audit log. Shared by the fetching run and
 * --rematch-only so the two can never drift apart.
 */
function carryForwardInto(output, venues) {
  const premium = loadPremiumIndex();
  console.log(`Loaded ${premium.size} hand-verified grounds from ${PREMIUM_PATH}`);
  console.log(`No-carry list: ${NO_CARRY_VENUES.join(', ')}\n`);

  const { pass1, pass2, excluded, pass2Matches, nameOnlyRejected } = applyCarryForward(venues, premium);

  output.venuesCarriedPass1 = pass1;
  output.venuesCarriedPass2 = pass2;
  output.venuesWithCarriedCoordinates = pass1 + pass2;
  output.venuesExcludedFromCarry = excluded;
  output.venuesNeedingGeocoding = venues.length - (pass1 + pass2);
  output.noCarryVenues = NO_CARRY_VENUES;
  output.nameOnlyRejected = nameOnlyRejected;

  output.pass2LogWritten = writePass2Log(PASS2_LOG_PATH, pass2Matches);
  console.log(`📁 Pass-2 log: ${PASS2_LOG_PATH} (${pass2Matches.length} matches this run)`);

  return pass2Matches;
}

/**
 * --rematch-only: re-run both carry-forward passes over the existing
 * candidate file. No API calls, no re-fetching; venue identity, capacity and
 * league associations are exactly as the fetching run left them.
 */
function rematchOnly() {
  console.log('🏟️  STADIUM EXPORT (API-Football) - REMATCH ONLY, no API calls\n');
  if (PROBE_MODE) console.log(`Probe mode: ${PROBE_LABEL} - production paths are unreachable this run\n`);

  let output;
  try {
    output = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf8'));
  } catch (err) {
    console.error(`ERROR: could not read ${CANDIDATE_PATH}: ${err.message}`);
    console.error('  --rematch-only re-scores an existing candidate; run --all first to create one.');
    process.exit(1);
  }

  if (!Array.isArray(output.venues) || output.venues.length === 0) {
    console.error(`ERROR: ${CANDIDATE_PATH} holds no venues to rematch.`);
    process.exit(1);
  }

  console.log(`Input:  ${CANDIDATE_PATH}`);
  console.log(`Venues: ${output.venues.length}\n`);

  carryForwardInto(output, output.venues);

  output.mode = 'rematch-only';
  output.rematchedAt = new Date().toISOString();
  output.capacityDistribution = capacityDistribution(output.venues);

  writeOutputFile(CANDIDATE_PATH, output);

  printSummary(output);
  console.log(`📁 Saved to: ${CANDIDATE_PATH}`);
  console.log('');

  if (CLEANUP_PROBE) removeProbeArtifacts();
}

async function exportStadiums() {
  if (REMATCH_ONLY) {
    rematchOnly();
    return;
  }

  console.log('🏟️  STADIUM EXPORT (API-Football scoping pass)\n');

  if (!API_KEY) {
    console.error('ERROR: APIFOOTBALL_KEY is not set.');
    console.error('  APIFOOTBALL_KEY=... node scripts/export-stadiums-apifootball.js');
    process.exit(1);
  }

  let scope;
  try {
    scope = JSON.parse(fs.readFileSync(SCOPE_PATH, 'utf8'));
  } catch (err) {
    console.error(`ERROR: could not read ${SCOPE_PATH}: ${err.message}`);
    process.exit(1);
  }

  const season = scope.season;
  const allLeagueIds = Array.isArray(scope.leagueIds) ? scope.leagueIds : [];
  if (!season || allLeagueIds.length === 0) {
    console.error(`ERROR: ${SCOPE_PATH} needs a season and a non-empty leagueIds array.`);
    process.exit(1);
  }

  const leagueIds = PROBE_LEAGUE
    ? [PROBE_LEAGUE]
    : (FETCH_ALL ? allLeagueIds : allLeagueIds.slice(0, DRY_RUN_LEAGUES));

  const modeLabel = PROBE_LEAGUE ? `PROBE (league ${PROBE_LEAGUE} only)`
    : FETCH_ALL ? 'FULL (--all)'
    : `DRY RUN (first ${DRY_RUN_LEAGUES} leagues)`;

  if (PROBE_MODE) assertProbeTargetsFree();

  console.log(`Mode:      ${modeLabel}`);
  console.log(`Season:    ${season} (requested)`);
  console.log(`Leagues:   ${leagueIds.length} of ${allLeagueIds.length} in scope`);
  console.log(`Delay:     ${CALL_DELAY_MS}ms between calls`);
  console.log(`Output:    ${OUTPUT_PATH}`);
  console.log('');

  const rawRecords = [];
  const leagueMeta = [];
  const errored = [];
  const skipCounts = { national: 0, 'no-venue': 0, placeholder: 0 };
  let totalTeamRecords = 0;
  let attempted = 0;
  let apiSeason = null;
  let abortedMessage = null;

  for (const leagueId of leagueIds) {
    attempted++;
    console.log(`📋 League ${leagueId}  (${attempted}/${leagueIds.length})`);

    let quotaError = null;

    try {
      const { teams, season: reportedSeason } = await fetchLeagueTeams(leagueId, season);
      apiSeason = reportedSeason;
      totalTeamRecords += teams.length;

      let kept = 0;
      for (const entry of teams) {
        const result = toVenueRecord(entry, leagueId);
        if (result.skipped) {
          skipCounts[result.skipped]++;
          continue;
        }
        rawRecords.push(result.record);
        kept++;
      }

      leagueMeta.push({
        leagueId,
        season: reportedSeason,
        teamRecords: teams.length,
        venueRecords: kept,
        capturedAt: new Date().toISOString(),
      });

      console.log(`   ✅ ${teams.length} teams → ${kept} venue records`);
    } catch (err) {
      if (err instanceof DailyQuotaError) {
        quotaError = err;
      } else {
        errored.push({ leagueId, message: err.message });
        console.error(`   ❌ ERROR: ${err.message}`);
      }
    }

    // Outside the try on purpose: a failed call still consumed a request from
    // both budgets, so it must back off exactly like a successful one.
    await sleep(CALL_DELAY_MS);

    if (quotaError) {
      abortedMessage = quotaError.message;
      console.error('');
      console.error('='.repeat(60));
      console.error('🛑 DAILY QUOTA FLOOR REACHED - aborting the run');
      console.error('='.repeat(60));
      console.error(`   ${abortedMessage}`);
      console.error(`   ${attempted} of ${leagueIds.length} leagues attempted.`);
      console.error('   Partial results are still summarised and written below.');
      console.error('');
      break;
    }
  }

  const { venues, idMerges, nameAddressMerges } = dedupeVenues(rawRecords);

  // Largest grounds first, then venue ID, so the file is both readable and
  // deterministic run to run.
  venues.sort((a, b) => {
    const diff = (b.capacity ?? -1) - (a.capacity ?? -1);
    if (diff !== 0) return diff;
    return (a.venueId ?? Infinity) - (b.venueId ?? Infinity);
  });

  const output = {
    generatedAt: new Date().toISOString(),
    source: `api-football (${API_HOST})`,
    mode: PROBE_MODE ? `probe:${PROBE_LABEL}` : (FETCH_ALL ? 'full' : 'dry-run'),
    // Reported by the API, not the requested value.
    season: apiSeason,
    requestedSeason: season,
    aborted: abortedMessage,
    leaguesInScope: allLeagueIds.length,
    leaguesAttempted: attempted,
    leaguesSucceeded: leagueMeta.length,
    leaguesErrored: errored,
    totalTeamRecords,
    skipped: skipCounts,
    totalVenues: venues.length,
    dedup: { byVenueId: idMerges, byNameAndAddress: nameAddressMerges },
    capacityDistribution: capacityDistribution(venues),
    leagues: leagueMeta,
    venues,
  };

  console.log('');
  carryForwardInto(output, venues);

  // Pre-write guard, mirroring export-stadiums-proxy.js: never let a bad run
  // shrink the file. Applied to the CANDIDATE only - a dry run is a
  // deliberately small sample and would trip the guard by design.
  if (FETCH_ALL) {
    let existingCount = 0;
    try {
      const existing = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf8'));
      existingCount = Array.isArray(existing.venues) ? existing.venues.length : 0;
    } catch (err) {
      existingCount = 0;
    }
    const requiredMinimum = existingCount > 0 ? existingCount : 100;

    if (venues.length < requiredMinimum) {
      printSummary(output);
      console.error('\n' + '='.repeat(60));
      console.error('🛑 GUARD TRIPPED - refusing to write candidate');
      console.error('='.repeat(60));
      console.error(`   Found: ${venues.length} venues`);
      console.error(`   Expected at least: ${requiredMinimum}`);
      console.error(`   Existing file at ${CANDIDATE_PATH} left untouched.`);
      console.error('');
      process.exit(1);
    }
  }

  writeOutputFile(OUTPUT_PATH, output);

  printSummary(output);
  console.log(`📁 Saved to: ${OUTPUT_PATH}`);
  console.log('');

  if (CLEANUP_PROBE) removeProbeArtifacts();

  if (abortedMessage) process.exit(1);
}

function printSummary(output) {
  console.log('\n' + '='.repeat(60));
  console.log(`📊 SUMMARY (${output.mode})`);
  console.log('='.repeat(60));
  console.log(`   Season reported by API:      ${output.season ?? 'n/a'} (requested ${output.requestedSeason})`);
  console.log(`   Leagues attempted:           ${output.leaguesAttempted} of ${output.leaguesInScope} in scope`);
  console.log(`   Leagues succeeded:           ${output.leaguesSucceeded}`);
  console.log(`   Leagues errored:             ${output.leaguesErrored.length}`);
  for (const { leagueId, message } of output.leaguesErrored) {
    console.log(`      - league ${leagueId}: ${message}`);
  }
  console.log(`   Total team records:          ${output.totalTeamRecords}`);
  console.log(`   Skipped - national teams:    ${output.skipped.national}`);
  console.log(`   Skipped - missing venue:     ${output.skipped['no-venue']}`);
  console.log(`   Skipped - placeholder junk:  ${output.skipped.placeholder}`);
  console.log(`   Merged on venue.id:          ${output.dedup.byVenueId}`);
  console.log(`   Merged on name + address:    ${output.dedup.byNameAndAddress}`);
  console.log(`   Unique venues after dedup:   ${output.totalVenues}`);
  console.log('');
  console.log(`   Carried - pass 1 (exact):    ${output.venuesCarriedPass1}`);
  console.log(`   Carried - pass 2 (relaxed):  ${output.venuesCarriedPass2}`);
  console.log(`   Carried - total:             ${output.venuesWithCarriedCoordinates}`);
  console.log(`   Excluded from carry-forward: ${output.venuesExcludedFromCarry}  (no-carry list)`);
  const rejected = output.nameOnlyRejected || {};
  console.log(`   Name-only rejected - country: ${rejected.countryMismatch ?? 0}`);
  console.log(`   Name-only rejected - unknown: ${rejected.unknownCountry ?? 0}`);
  console.log(`   Name-only rejected - ambiguous: ${rejected.ambiguous ?? 0}`);
  console.log(`   Still needing geocoding:     ${output.venuesNeedingGeocoding}`);
  console.log('');
  console.log('   Capacity distribution:');
  console.log(`      ${'bucket'.padEnd(18)}${'count'.padStart(7)}${'at or above'.padStart(14)}`);
  for (const row of output.capacityDistribution) {
    const atOrAbove = row.atOrAbove === null ? '-' : String(row.atOrAbove);
    console.log(`      ${row.label.padEnd(18)}${String(row.count).padStart(7)}${atOrAbove.padStart(14)}`);
  }
  console.log('='.repeat(60));
  console.log('');
}

exportStadiums().catch(err => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exit(1);
});
