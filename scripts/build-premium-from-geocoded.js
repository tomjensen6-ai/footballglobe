/**
 * FOOTBALLGLOBE - BUILD PREMIUM FROM GEOCODED
 *
 * Reads the FLAT geocoded export and emits public/stadiums-premium.json in the
 * NESTED shape the React app already consumes, so App.js needs no change:
 * getStadiumsFromCache still indexes countries by name and still walks
 * country.leagues[].stadiums[].
 *
 * Input (flat):
 *   { venues: [ { venueId, name, city, country, latitude, longitude,
 *                 capacity, teamIds[], teamNames[] } ] }
 *
 * Output (nested), mirroring the real public/stadiums-premium.json:
 *   { lastUpdated, totalStadiums, ..., countries: { "England": {
 *       name, code, leagues: [ { id, name, category, tier, stadiums } ] } } }
 *
 * Leagues are REAL leagues, taken from scripts/league-classification.json:
 * every country lists its men's leagues in order, then its women's, then its
 * youth/reserve ("other") ones, and a league with no venues is left out. A
 * venue is filed under the single lowest-order league it belongs to WITHIN a
 * category, so it appears once per category it plays in - a ground hosting
 * both men's and women's football is listed in one men's league and one
 * women's league. Venues whose only leagues are excluded are dropped.
 *
 * A country with no classified leagues at all still gets the old single
 * synthetic "All venues" league - Brunei, Chad and Liechtenstein are the
 * cases in the current data. The app's topLeague = countryData?.leagues?.[0]
 * therefore still always resolves.
 *
 * Output: <output>.premium-candidate.json by default. --apply overwrites
 *   public/stadiums-premium.json itself, and only after the shrink guard
 *   below agrees. Same candidate-then-diff pattern as geocode-stadiums.js.
 *
 * Usage: node scripts/build-premium-from-geocoded.js [--input=<path>] [--apply]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DEFAULT_INPUT_PATH = path.join(ROOT, 'stadiums-apifootball-geocoding.json');
const PREMIUM_PATH = path.join(ROOT, 'public', 'stadiums-premium.json');
const CLASSIFICATION_PATH = path.join(__dirname, 'league-classification.json');

const APPLY = process.argv.includes('--apply');

/**
 * --input=<path>. A relative path resolves against the working directory, not
 * the script, so a path pasted from a shell prompt means what it looks like.
 */
function parseInputPath(argv) {
  const arg = argv.find(a => a.startsWith('--input='));
  if (!arg) return DEFAULT_INPUT_PATH;
  const raw = arg.slice('--input='.length).trim();
  if (!raw) {
    console.error('ERROR: --input= given with no path');
    process.exit(1);
  }
  return path.resolve(raw);
}

const INPUT_PATH = parseInputPath(process.argv);

// Candidate beside the real file, never on top of it. The suffix names the
// producer so it cannot be confused with geocode-stadiums.js's candidates.
const OUTPUT_PATH = APPLY
  ? PREMIUM_PATH
  : PREMIUM_PATH.replace(/\.json$/, '.premium-candidate.json');

/**
 * Synthetic league ids start here. football-data.org's real competition ids
 * are small integers - the ones in the current premium file run 2001-2021 -
 * so a 900k base cannot collide with a real one, and a reader seeing 900001
 * can tell at a glance that it is manufactured.
 */
const SYNTHETIC_LEAGUE_ID_BASE = 900001;

const SYNTHETIC_LEAGUE_NAME = 'All venues';

/**
 * The categories that make it into the output, in the order a country lists
 * them. `excluded` is deliberately absent: it is the one classification that
 * puts a venue nowhere.
 */
const CATEGORY_ORDER = ['men', 'women', 'other'];

/**
 * The classification is a hard dependency, not an optional enrichment: without
 * it there are no league names, no categories and no ordering, and the only
 * thing left to emit would be the synthetic league this build exists to
 * replace. So it is loaded first and its absence stops the run.
 */
function loadClassification() {
  if (!fs.existsSync(CLASSIFICATION_PATH)) {
    console.error(`ERROR: classification not found: ${CLASSIFICATION_PATH}`);
    console.error('   Build it first:');
    console.error('     node scripts/build-league-classification.js --apply');
    process.exit(1);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(CLASSIFICATION_PATH, 'utf8'));
  } catch (err) {
    console.error(`ERROR: classification is not valid JSON: ${CLASSIFICATION_PATH}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  if (!doc || !doc.leagues || typeof doc.leagues !== 'object') {
    console.error(`ERROR: classification has no leagues map: ${CLASSIFICATION_PATH}`);
    console.error('   Rebuild it: node scripts/build-league-classification.js --apply');
    process.exit(1);
  }
  return doc;
}

/**
 * The single league a venue is listed under per category: the LOWEST `order`
 * it belongs to, so a club that plays in the top flight is filed there rather
 * than in whatever secondary competition it also appears in. Ties on order -
 * possible when a venue's leagues come from two different classification
 * countries - break on the lower league id, so the pick is deterministic.
 * Excluded leagues, and ids the classification has never heard of, take part
 * in nothing; a venue left with an empty map here is dropped by the caller.
 */
function pickLeaguesByCategory(leagueIds, leagueMeta) {
  const picked = new Map();
  const ids = Array.isArray(leagueIds) ? leagueIds : [];
  for (const rawId of ids) {
    const meta = leagueMeta[String(rawId)];
    if (!meta || !CATEGORY_ORDER.includes(meta.category)) continue;
    const candidate = {
      id: Number(rawId),
      name: meta.name,
      category: meta.category,
      order: meta.order,
    };
    const current = picked.get(meta.category);
    if (!current
        || candidate.order < current.order
        || (candidate.order === current.order && candidate.id < current.id)) {
      picked.set(meta.category, candidate);
    }
  }
  return picked;
}

/**
 * Capacity descending, so the grounds a viewer recognises sit at the top of
 * the sidebar's first ten. Ties break on venue name so the order is total and
 * the output is byte-stable across runs.
 */
function sortStadiums(stadiums) {
  stadiums.sort((a, b) => (b.capacity - a.capacity)
    || String(a.venue || '').localeCompare(String(b.venue || '')));
  return stadiums;
}

/**
 * Country code, first three letters uppercased. That is exactly the scheme the
 * existing file uses (England -> ENG, Spain -> SPA, Netherlands -> NET), so
 * this reproduces those nine byte for byte. Nothing in App.js reads
 * country.code - it looks countries up by NAME - so a collision across ~200
 * countries is cosmetic, not a bug. Collisions are counted and reported rather
 * than hidden.
 */
function countryCode(name) {
  return String(name).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || null;
}

/**
 * A coordinate is usable only if it is a real finite number. `latitude == null`
 * alone would let a string or a NaN through and put a broken marker on the map,
 * so the test is widened here; anything that fails it is counted as "no coords".
 */
function hasCoordinates(venue) {
  return Number.isFinite(venue.latitude) && Number.isFinite(venue.longitude);
}

/**
 * teamNames is an array because one ground can host several clubs. The app
 * renders teamName as a scalar (marker titles, popup, sidebar), so several
 * names are joined rather than dropped - losing "Cruz Azul" from Estadio
 * Azteca would be a silent data loss the UI could never show.
 */
function teamNameOf(venue) {
  const names = Array.isArray(venue.teamNames)
    ? venue.teamNames.filter(n => typeof n === 'string' && n.trim().length > 0)
    : [];
  if (names.length === 0) return null;
  return names.length === 1 ? names[0] : names.join(' / ');
}

/**
 * teamId is the app's identity for a venue: React list key, selection
 * comparison, and the join key for match-day fixtures. The flat file carries an
 * array, so the first id wins - it has to be a scalar, and it has to be stable,
 * which it is because the input order is stable.
 */
function teamIdOf(venue) {
  const ids = Array.isArray(venue.teamIds)
    ? venue.teamIds.filter(id => id !== null && id !== undefined)
    : [];
  return ids.length > 0 ? ids[0] : null;
}

/**
 * One stadium record in the nested shape. Only the fields the app actually
 * reads are emitted: crestUrl, clubColors, founded and address are omitted on
 * purpose, and App.js guards every one of them with `|| ''` or `|| 0`.
 *
 * `area` exists because App.js reads `stadium.area?.name` for the popup's
 * travel links - the top-level `country` field is not what it looks at.
 * Only `name` is emitted; the real file's area also carries code and flag,
 * neither of which is read anywhere in App.js.
 *
 * undefined is coerced to null throughout: JSON.stringify drops undefined
 * keys, and a record missing a key reads very differently from one holding
 * null when someone diffs two builds.
 */
function stadiumRecord(venue) {
  return {
    teamId: teamIdOf(venue),
    teamName: teamNameOf(venue),
    venue: venue.name ?? null,
    latitude: venue.latitude,
    longitude: venue.longitude,
    city: venue.city ?? null,
    capacity: Number.isFinite(venue.capacity) ? venue.capacity : 0,
    area: { name: venue.country },
    // Not read by the app. Kept because it is the only stable identifier back
    // to the flat file, and a build with no way home is hard to audit.
    venueId: venue.venueId ?? null,
    // The venue's FULL league list, not just the league it is filed under
    // here. Carrying it makes every placement auditable against the
    // classification without going back to the flat file.
    leagueIds: Array.isArray(venue.leagueIds) ? [...venue.leagueIds] : [],
  };
}

/** Total stadiums in a nested document, counted by walking it rather than by
 *  trusting its own totalStadiums field. */
function countNestedStadiums(doc) {
  if (!doc || !doc.countries) return 0;
  let n = 0;
  for (const country of Object.values(doc.countries)) {
    for (const league of country.leagues || []) {
      n += (league.stadiums || []).length;
    }
  }
  return n;
}

function build() {
  console.log('BUILD PREMIUM FROM GEOCODED\n');
  console.log(`Mode:   ${APPLY ? 'APPLY (overwrites public/stadiums-premium.json)' : 'CANDIDATE (writes a candidate file only)'}`);
  console.log(`Input:  ${INPUT_PATH}`);
  console.log(`Leagues: ${CLASSIFICATION_PATH}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log('');

  const classification = loadClassification();
  const leagueMeta = classification.leagues;
  console.log(`Classification: season ${classification.season}, rules v${classification.rulesVersion}, `
    + `${Object.keys(leagueMeta).length} leagues `
    + `(${JSON.stringify(classification.counts)})`);
  console.log('');

  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`ERROR: input file not found: ${INPUT_PATH}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
  if (!data || !Array.isArray(data.venues)) {
    console.error('ERROR: input is not the flat shape - expected a top-level venues[] array.');
    console.error('   This script converts flat -> nested. It cannot read a nested file.');
    process.exit(1);
  }

  const venuesRead = data.venues.length;
  let skippedNoCoords = 0;
  let skippedNoCountry = 0;
  // Venues left with no category after classification. In practice these are
  // venues whose every league is `excluded`; a venue carrying no league ids at
  // all, or only ids the classification does not know, would land here too.
  let droppedExcludedOnly = 0;

  // Grouped by the country string EXACTLY as the flat file spells it. No
  // normalising, no mapping table: an invented country name here would be a
  // country the app can never look up. Each entry keeps the venue's record
  // alongside the one league it takes per category, so the country pass below
  // never has to look at the flat file again.
  const byCountry = new Map();

  for (const venue of data.venues) {
    if (!hasCoordinates(venue)) {
      skippedNoCoords++;
      continue;
    }
    const country = typeof venue.country === 'string' ? venue.country.trim() : '';
    if (!country) {
      skippedNoCountry++;
      continue;
    }
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push({
      record: stadiumRecord(venue),
      leagues: pickLeaguesByCategory(venue.leagueIds, leagueMeta),
    });
  }

  const countryNames = [...byCountry.keys()].sort();

  // Ids are handed out in sorted country order, so the same input always
  // produces the same id for the same country. Re-running this build does not
  // renumber anything that was already published.
  const leagueIdByCountry = new Map();
  countryNames.forEach((name, i) => {
    leagueIdByCountry.set(name, SYNTHETIC_LEAGUE_ID_BASE + i);
  });

  const countries = {};
  const codeCollisions = new Map();

  // Countries that fell back to the synthetic league because nothing they host
  // survived classification. Logged by name: a country appearing here that is
  // not expected to is a classification gap, not a quiet default.
  const fallbackCountries = [];

  // Distinct venues, NOT league memberships. A venue in both a men's and a
  // women's league is one placement here and two records in the output.
  let placedDistinct = 0;

  for (const name of countryNames) {
    const entries = byCountry.get(name);

    const code = countryCode(name);
    if (code) {
      if (!codeCollisions.has(code)) codeCollisions.set(code, []);
      codeCollisions.get(code).push(name);
    }

    // id -> league under construction. Built from the leagues this country's
    // venues actually land in, so an empty league is never emitted.
    const leaguesById = new Map();
    let placedHere = 0;

    for (const entry of entries) {
      if (entry.leagues.size === 0) continue;
      placedHere++;
      for (const league of entry.leagues.values()) {
        if (!leaguesById.has(league.id)) {
          leaguesById.set(league.id, { ...league, stadiums: [] });
        }
        leaguesById.get(league.id).stadiums.push(entry.record);
      }
    }

    let leagues;
    if (leaguesById.size === 0) {
      // No classified league anywhere in this country - keep the old single
      // synthetic league rather than emitting a country with no leagues at all,
      // which the app's topLeague lookup could not survive.
      fallbackCountries.push(name);
      placedDistinct += entries.length;
      leagues = [
        {
          id: leagueIdByCountry.get(name),
          name: SYNTHETIC_LEAGUE_NAME,
          tier: 1,
          stadiums: sortStadiums(entries.map(e => e.record)),
        },
      ];
    } else {
      droppedExcludedOnly += entries.length - placedHere;
      placedDistinct += placedHere;
      // men, then women, then other; within a category by classification order,
      // then by id so the sort is total and the output byte-stable.
      leagues = [...leaguesById.values()]
        .sort((a, b) =>
          (CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
          || (a.order - b.order)
          || (a.id - b.id))
        .map(league => ({
          id: league.id,
          name: league.name,
          category: league.category,
          // tier is DISPLAY ORDER within the category, derived from ascending
          // league id, and is not a claim about the real football pyramid. Id
          // order is reliable for the top flight but inverts in places - in
          // Spain, Segunda RFEF sits at higher ids than Tercera.
          tier: league.order + 1,
          stadiums: sortStadiums(league.stadiums),
        }));
    }

    countries[name] = { name, code, leagues };
  }

  const written = Object.values(countries)
    .reduce((n, c) => n + c.leagues.reduce((m, l) => m + l.stadiums.length, 0), 0);
  const totalLeagues = Object.values(countries).reduce((n, c) => n + c.leagues.length, 0);
  const now = new Date();

  const output = {
    // The app logs stadiumsData.lastUpdated, so it keeps the file's own
    // YYYY-MM-DD form. generatedAt is the full timestamp, added because two
    // builds on one day are otherwise indistinguishable.
    generatedAt: now.toISOString(),
    lastUpdated: now.toISOString().slice(0, 10),
    source: 'api-football',
    exportMethod: 'build-premium-from-geocoded',
    totalCountries: countryNames.length,
    totalLeagues,
    totalStadiums: written,
    countries,
  };

  // ---- RECONCILIATION ----
  // Every venue read must be accounted for exactly once: skipped, dropped, or
  // placed. Placed counts DISTINCT venues, not league memberships, because one
  // venue can be listed in several leagues; counting memberships here would
  // hide a real loss behind a multi-category venue.
  const reconciled = skippedNoCoords + skippedNoCountry + droppedExcludedOnly + placedDistinct;

  console.log('-'.repeat(60));
  console.log('RECONCILIATION');
  console.log('-'.repeat(60));
  console.log(`  venues read:             ${venuesRead}`);
  console.log(`  skipped (no coords):     ${skippedNoCoords}`);
  console.log(`  skipped (no country):    ${skippedNoCountry}`);
  console.log(`  dropped (excluded only): ${droppedExcludedOnly}`);
  console.log(`  placed (distinct):       ${placedDistinct}`);
  console.log(`  ${reconciled === venuesRead ? 'balances' : 'DOES NOT BALANCE'}: `
    + `${skippedNoCoords} + ${skippedNoCountry} + ${droppedExcludedOnly} + ${placedDistinct} `
    + `= ${reconciled} vs ${venuesRead} read`);
  console.log('');

  if (reconciled !== venuesRead) {
    console.error('='.repeat(60));
    console.error('REFUSING TO WRITE');
    console.error('='.repeat(60));
    console.error(`  skipped + dropped + placed = ${reconciled}, venues read = ${venuesRead}`);
    console.error('  Every venue must be accounted for exactly once. A mismatch means');
    console.error('  venues are being lost or double-counted between the flat file and');
    console.error('  the nested output, which is exactly the bug this build must not ship.');
    process.exit(1);
  }

  // ---- SHRINK GUARD ----
  // The published file is what the live map reads. A build that would publish
  // fewer venues than are already there is far more likely to be a broken input
  // than a real shrink, and --apply is destructive, so it is refused. The
  // candidate path is never guarded: writing a candidate costs nothing and
  // looking at it is the whole point.
  if (APPLY) {
    if (!fs.existsSync(PREMIUM_PATH)) {
      console.log('NOTE: no existing public/stadiums-premium.json - nothing to compare against.');
    } else {
      let existingCount = 0;
      try {
        existingCount = countNestedStadiums(
          JSON.parse(fs.readFileSync(PREMIUM_PATH, 'utf8'))
        );
      } catch (err) {
        console.error(`ERROR: existing ${PREMIUM_PATH} could not be read: ${err.message}`);
        console.error('   Refusing to overwrite a file this script cannot compare against.');
        process.exit(1);
      }

      if (written < existingCount) {
        console.error('\n' + '='.repeat(60));
        console.error('REFUSING TO WRITE');
        console.error('='.repeat(60));
        console.error(`  existing public/stadiums-premium.json: ${existingCount} stadiums`);
        console.error(`  this build would write:                ${written} stadiums`);
        console.error('  A build that shrinks the published file is treated as a bug,');
        console.error('  not an intention. Inspect the candidate first:');
        console.error(`    node ${path.relative(ROOT, __filename)}${INPUT_PATH === DEFAULT_INPUT_PATH ? '' : ` --input=${INPUT_PATH}`}`);
        process.exit(1);
      }
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // ---- SUMMARY ----
  console.log('-'.repeat(60));
  console.log('SUMMARY');
  console.log('-'.repeat(60));
  console.log(`  venues read:             ${venuesRead}`);
  console.log(`  placed (distinct):       ${placedDistinct}`);
  console.log(`  stadium records written: ${countNestedStadiums(output)}`);
  console.log(`  leagues:                 ${totalLeagues}`);
  console.log(`  countries:               ${countryNames.length}`);
  // countNestedStadiums counts league MEMBERSHIPS, so it exceeds the distinct
  // placed count by exactly the number of extra categories venues appear in -
  // a ground hosting men's and women's football is counted twice there, once
  // here. The two numbers differing is expected, not a defect.
  const duplicated = countNestedStadiums(output) - placedDistinct;
  console.log(`  records - distinct:      ${duplicated}`
    + `  (venues listed in more than one category)`);

  const largest = countryNames
    .map(name => ({ name, n: byCountry.get(name).length }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, 5);

  console.log('\n  five largest countries:');
  for (const { name, n } of largest) {
    console.log(`    ${String(n).padStart(5)}  ${name}`);
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`SYNTHETIC FALLBACK COUNTRIES (no classified league; base ${SYNTHETIC_LEAGUE_ID_BASE})`);
  console.log('-'.repeat(60));
  if (fallbackCountries.length === 0) {
    console.log('  none - every country resolved to at least one real league');
  } else {
    for (const name of fallbackCountries) {
      console.log(`  ${leagueIdByCountry.get(name)}  ${name}`);
    }
  }

  const collided = [...codeCollisions.entries()].filter(([, names]) => names.length > 1);
  if (collided.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('COUNTRY CODE COLLISIONS (cosmetic - the app looks countries up by NAME)');
    console.log('-'.repeat(60));
    for (const [code, names] of collided) {
      console.log(`  ${code}: ${names.join(', ')}`);
    }
  }

  console.log('');
  console.log(`Wrote ${OUTPUT_PATH}`);
  if (!APPLY) {
    console.log('Candidate only. Re-run with --apply to publish it.');
  }
}

build();
