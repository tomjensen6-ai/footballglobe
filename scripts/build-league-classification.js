/**
 * FOOTBALLGLOBE - BUILD LEAGUE CLASSIFICATION
 *
 * Splits the in-scope API-Football leagues into four buckets - men, women,
 * other, excluded - so downstream exports stop re-deriving gender and
 * competition type from league names at call time. Reads
 * scripts/apifootball-scope.json for the id list and the season, and a leagues
 * response file for the names and countries.
 *
 * `other` is youth and reserve competitions. They used to be lumped in with
 * `excluded`, which was wrong for this map: a youth or reserve side plays at a
 * real ground hosting watchable football, and dropping those leagues costs the
 * map roughly 294 stadiums. `excluded` now means only what we genuinely cannot
 * place on a season map - cup competitions and play-off phases, which have no
 * stable home venue - while `other` stays available to render, just not as
 * senior league football.
 *
 * Input (leagues file), either shape:
 *   { response: [ { league: { id, name, type }, country: { name } } ] }
 *   [ { league: { id, name, type }, country: { name } } ]
 *
 * Output:
 *   { generatedAt, season, rulesVersion,
 *     counts: { men, women, other, excluded },
 *     leagues: { "<id>": { name, country, category, order } } }
 *
 * `order` is the league's zero-based position among its own country's leagues
 * of the SAME category, sorted by ascending id - so the top flight is 0.
 *
 * Output: scripts/league-classification.candidate.json by default. --apply
 *   writes scripts/league-classification.json itself. Same candidate-then-apply
 *   pattern as build-premium-from-geocoded.js.
 *
 * Usage: node scripts/build-league-classification.js [<leagues-file>] [--apply]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SCOPE_PATH = path.join(__dirname, 'apifootball-scope.json');
const OUTPUT_REAL_PATH = path.join(__dirname, 'league-classification.json');
const OUTPUT_CANDIDATE_PATH = path.join(__dirname, 'league-classification.candidate.json');

const DEFAULT_LEAGUES_PATH = '/Users/tje/fg-probe/apifootball-leagues.json';

const APPLY = process.argv.includes('--apply');

// Candidate beside the real file, never on top of it.
const OUTPUT_PATH = APPLY ? OUTPUT_REAL_PATH : OUTPUT_CANDIDATE_PATH;

const RULES_VERSION = 3;

/**
 * The leagues file is the first non-flag argument. A relative path resolves
 * against the working directory, not the script, so a path pasted from a shell
 * prompt means what it looks like.
 */
function parseLeaguesPath(argv) {
  const positional = argv.slice(2).filter(a => !a.startsWith('--'));
  if (positional.length === 0) return DEFAULT_LEAGUES_PATH;
  if (positional.length > 1) {
    console.error(`ERROR: expected one leagues file path, got ${positional.length}: ${positional.join(', ')}`);
    process.exit(1);
  }
  return path.resolve(positional[0]);
}

const LEAGUES_PATH = parseLeaguesPath(process.argv);

// ---------------------------------------------------------------------------
// CLASSIFICATION RULES
//
// The explicit id lists are not redundant with the name patterns. Some leagues
// carry no gendered or age token in their name at all - WPSL, Elitettan, WE
// League - so no regex over the name can ever reach them, and the id is the
// only handle there is. API-Football league ids are stable across seasons (a
// league keeps its id as new seasons are appended to it), so these lists need
// no seasonal maintenance; they only need revisiting when a new league of that
// kind enters scope.
// ---------------------------------------------------------------------------

/**
 * Ids that jump every rule below and land in `men` directly.
 *
 * 510 is Switzerland's third tier, genuinely named "1. Liga Promotion" -
 * "Promotion" is part of the division's proper name, not a phase marker, so
 * PHASE_PATTERN matches it wrongly. Every other league PHASE_PATTERN catches
 * names a parent league plus a phase ("Serie C - Promotion - Play-offs"), so
 * the parent division is already in scope and the phase entry is a duplicate
 * listing of the same venues; 510 has no such parent and excluding it drops
 * its grounds outright.
 *
 * Found by checking which venues had no category left after exclusion: 16
 * venues, 15 of them Swiss.
 */
const MEN_ID_OVERRIDES = new Set([510]);

const EXCLUDED_CUP_IDS = new Set([1032, 1095, 1211, 1119]);
const CUP_PATTERN = /super ?cup|supercup|supercopa|supercoppa|community shield|summer series|\bcup\b/i;

const OTHER_YOUTH_IDS = new Set([702, 734]);
const YOUTH_PATTERN = /\bu-?1[5-9]\b|\bu-?2[0-3]\b|youth|junior|primavera|development|jugend|academy|reserve|next pro/i;

const PHASE_PATTERN = /play-?off|play offs|promotion|relegation|championship round/i;

const WOMEN_IDS = new Set([638, 673, 736, 854, 1116, 1117, 1130, 1182]);
const WOMEN_PATTERN = /women|femin|femenin|femenil|femmin|frauen|dames|kvinn|kvinde|damallsv|toppserien|feminina|wsl|kobiet|damer/i;

/**
 * First match wins, in this order. Cups and play-off phases are ruled out
 * before the women check on purpose: a women's cup is still a cup, and that
 * exclusion is about the competition format, not about who plays in it.
 *
 * The women check now runs BEFORE the youth check, which is deliberate: a
 * women's youth or reserve league lands in `women`, not `other`. That is the
 * choice we want while the women's buckets are small and gender is the axis
 * the map filters on - but it does mean `women` is not purely senior football.
 * Revisit this ordering if women's youth leagues actually turn up in scope and
 * anything downstream starts treating `women` as a senior-only set.
 */
function classify(id, name) {
  const n = name || '';
  if (MEN_ID_OVERRIDES.has(id)) return 'men';
  if (EXCLUDED_CUP_IDS.has(id) || CUP_PATTERN.test(n)) return 'excluded';
  if (PHASE_PATTERN.test(n)) return 'excluded';
  if (WOMEN_IDS.has(id) || WOMEN_PATTERN.test(n)) return 'women';
  if (OTHER_YOUTH_IDS.has(id) || YOUTH_PATTERN.test(n)) return 'other';
  return 'men';
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: ${label} not found: ${filePath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`ERROR: ${label} is not valid JSON: ${filePath}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }
}

function build() {
  console.log('-'.repeat(60));
  console.log('BUILD LEAGUE CLASSIFICATION');
  console.log('-'.repeat(60));
  console.log(`  scope:   ${path.relative(ROOT, SCOPE_PATH)}`);
  console.log(`  leagues: ${LEAGUES_PATH}`);
  console.log('');

  const scope = readJson(SCOPE_PATH, 'scope file');
  const scopeIds = Array.isArray(scope.leagueIds) ? scope.leagueIds : [];
  if (scopeIds.length === 0) {
    console.error('ERROR: scope file has no leagueIds');
    process.exit(1);
  }

  const raw = readJson(LEAGUES_PATH, 'leagues file');
  const entries = Array.isArray(raw) ? raw : raw.response;
  if (!Array.isArray(entries)) {
    console.error('ERROR: leagues file is neither an array nor an object with a "response" array');
    process.exit(1);
  }

  // Last entry wins on a duplicate id. The API does not emit duplicates, but a
  // hand-concatenated file might.
  const byId = new Map();
  for (const entry of entries) {
    const id = entry?.league?.id;
    if (typeof id !== 'number') continue;
    byId.set(id, {
      name: entry.league.name || '',
      country: entry.country?.name || ''
    });
  }

  // ---- GUARD: every scope id must be present in the leagues response ----
  const missing = scopeIds.filter(id => !byId.has(id));
  if (missing.length > 0) {
    console.error('='.repeat(60));
    console.error('REFUSING TO WRITE');
    console.error('='.repeat(60));
    console.error(`  ${missing.length} of ${scopeIds.length} scope league ids are absent from the leagues response.`);
    console.error('  Classifying without them would silently drop those leagues from');
    console.error('  every downstream export. Re-fetch the leagues file first.');
    console.error(`  missing ids: ${missing.join(', ')}`);
    process.exit(1);
  }

  // ---- CLASSIFY ----
  const classified = scopeIds.map(id => {
    const { name, country } = byId.get(id);
    return { id, name, country, category: classify(id, name) };
  });

  const counts = { men: 0, women: 0, other: 0, excluded: 0 };
  for (const league of classified) counts[league.category] += 1;

  // ---- GUARD: the four buckets must account for the whole scope ----
  const summed = counts.men + counts.women + counts.other + counts.excluded;
  if (summed !== scopeIds.length) {
    console.error('='.repeat(60));
    console.error('REFUSING TO WRITE');
    console.error('='.repeat(60));
    console.error(`  men + women + other + excluded = ${summed}, scope = ${scopeIds.length}`);
    console.error('  Every scope league must land in exactly one bucket. A mismatch');
    console.error('  means classify() returned a category outside the four, or the');
    console.error('  scope list contains duplicate ids.');
    process.exit(1);
  }

  // ---- ORDER: position within (country, category), by ascending id ----
  // API-Football issues ids in tier order within a country, so ascending id is
  // tier order and index 0 is the top flight.
  const groups = new Map();
  for (const league of classified) {
    const key = `${league.country}::${league.category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(league);
  }
  const orderById = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => a.id - b.id);
    group.forEach((league, i) => orderById.set(league.id, i));
  }

  const leagues = {};
  for (const league of classified) {
    leagues[league.id] = {
      name: league.name,
      country: league.country,
      category: league.category,
      order: orderById.get(league.id)
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    season: scope.season,
    rulesVersion: RULES_VERSION,
    counts,
    leagues
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // ---- SUMMARY ----
  console.log('-'.repeat(60));
  console.log('SUMMARY');
  console.log('-'.repeat(60));
  console.log(`  season:     ${scope.season}`);
  console.log(`  scope:      ${scopeIds.length} leagues`);
  console.log(`  men:        ${counts.men}`);
  console.log(`  women:      ${counts.women}`);
  console.log(`  other:      ${counts.other}`);
  console.log(`  excluded:   ${counts.excluded}`);
  console.log(`  countries:  ${new Set(classified.map(l => l.country)).size}`);
  console.log('');
  console.log(`Wrote ${OUTPUT_PATH}`);
  if (!APPLY) {
    console.log('Candidate only. Re-run with --apply to write scripts/league-classification.json.');
  }
}

build();
