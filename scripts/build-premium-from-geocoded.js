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
 *       name, code, leagues: [ { id, name, tier, stadiums: [ ... ] } ] } } }
 *
 * Every country gets exactly ONE synthetic league, "All venues". The app's
 * topLeague = countryData?.leagues?.[0] therefore always resolves, and its
 * "filter to top league only" step becomes a no-op that keeps every venue
 * rather than a filter that silently drops most of them.
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
  console.log(`Output: ${OUTPUT_PATH}`);
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

  // Grouped by the country string EXACTLY as the flat file spells it. No
  // normalising, no mapping table: an invented country name here would be a
  // country the app can never look up.
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
    byCountry.get(country).push(stadiumRecord(venue));
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

  for (const name of countryNames) {
    const stadiums = byCountry.get(name);

    // Capacity descending, so the grounds a viewer recognises sit at the top of
    // the sidebar's first ten. Ties break on venue name so the order is total
    // and the output is byte-stable across runs.
    stadiums.sort((a, b) => (b.capacity - a.capacity)
      || String(a.venue || '').localeCompare(String(b.venue || '')));

    const code = countryCode(name);
    if (code) {
      if (!codeCollisions.has(code)) codeCollisions.set(code, []);
      codeCollisions.get(code).push(name);
    }

    countries[name] = {
      name,
      code,
      leagues: [
        {
          id: leagueIdByCountry.get(name),
          name: SYNTHETIC_LEAGUE_NAME,
          tier: 1,
          stadiums,
        },
      ],
    };
  }

  const written = countryNames.reduce((n, c) => n + byCountry.get(c).length, 0);
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
    totalLeagues: countryNames.length,
    totalStadiums: written,
    countries,
  };

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
  console.log(`  skipped (no coords):     ${skippedNoCoords}`);
  console.log(`  skipped (no country):    ${skippedNoCountry}`);
  console.log(`  stadiums written:        ${written}`);
  console.log(`  countries:               ${countryNames.length}`);

  const largest = countryNames
    .map(name => ({ name, n: byCountry.get(name).length }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, 5);

  console.log('\n  five largest countries:');
  for (const { name, n } of largest) {
    console.log(`    ${String(n).padStart(5)}  ${name}`);
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`SYNTHETIC LEAGUE IDS (base ${SYNTHETIC_LEAGUE_ID_BASE}, sorted country order)`);
  console.log('-'.repeat(60));
  for (const name of countryNames) {
    console.log(`  ${leagueIdByCountry.get(name)}  ${name}`);
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
