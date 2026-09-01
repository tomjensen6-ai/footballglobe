/**
 * FOOTBALLGLOBE - SYNC CACHES TO public/
 *
 * The export/geocode scripts write to the repo root, which is gitignored.
 * The app fetches from public/, which is committed and deployed. This script
 * is the link between the two.
 *
 * Every copy is guarded: a source file may never have FEWER populated records
 * than the destination it is about to overwrite. That is the failure this
 * script exists to prevent - an empty or half-finished export silently
 * replacing good deployed data.
 *
 * Both files are checked BEFORE either is copied, so a failure on one file
 * leaves public/ completely untouched.
 *
 * Run: npm run sync-public
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * True when a field is actually populated. Deliberately not a truthiness
 * check: latitude 0 is a real coordinate (the equator), so only null,
 * undefined and '' count as missing.
 */
function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Count populated fields across every stadium record in the nested
 * countries -> leagues -> stadiums structure.
 */
function countStadiumFields(data) {
  const counts = { stadiums: 0, city: 0, latitude: 0, crestUrl: 0, area: 0 };

  for (const country of Object.values(data.countries || {})) {
    for (const league of country.leagues || []) {
      for (const stadium of league.stadiums || []) {
        counts.stadiums++;
        if (hasValue(stadium.city)) counts.city++;
        if (hasValue(stadium.latitude)) counts.latitude++;
        if (hasValue(stadium.crestUrl)) counts.crestUrl++;
        if (hasValue(stadium.area)) counts.area++;
      }
    }
  }

  return counts;
}

/**
 * Count league entries and total standings table rows in the standings cache.
 * `leagues` is keyed by competition id, but an array is handled too in case
 * the shape changes.
 *
 * tableRows matters because the league count alone cannot detect a league
 * whose table came back truncated - the entry is still there, just short.
 */
function countStandingsFields(data) {
  const leagues = data.leagues || {};
  const entries = Array.isArray(leagues) ? leagues : Object.values(leagues);

  let tableRows = 0;
  for (const league of entries) {
    tableRows += league?.standings?.table?.length || 0;
  }

  return {
    leagues: Array.isArray(leagues) ? leagues.length : Object.keys(leagues).length,
    tableRows,
  };
}

const FILES = [
  { name: 'stadiums-premium.json', count: countStadiumFields },
  { name: 'standings-premium-cache.json', count: countStandingsFields },
];

/**
 * Read and parse a JSON file. `required` distinguishes a missing source
 * (fatal) from a missing destination (first run).
 */
function readJson(filePath, { required }) {
  if (!fs.existsSync(filePath)) {
    if (required) {
      return { error: `not found at ${filePath}` };
    }
    return { missing: true };
  }

  try {
    return { data: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { error: `could not be parsed: ${err.message}` };
  }
}

/**
 * Check one file. Returns { ok, failures, sourceCounts, destCounts, firstRun }.
 * Never writes anything - copying happens only after every file has passed.
 */
function checkFile(file) {
  const sourcePath = path.join(ROOT, file.name);
  const destPath = path.join(PUBLIC_DIR, file.name);

  const source = readJson(sourcePath, { required: true });
  if (source.error) {
    return { ok: false, fatal: `Source ${file.name} ${source.error}` };
  }

  const dest = readJson(destPath, { required: false });
  if (dest.error) {
    // Not treated as a first run on purpose: an unreadable destination means
    // the guard cannot verify anything, and silently overwriting it would
    // defeat the point of having a guard.
    return {
      ok: false,
      fatal:
        `Destination public/${file.name} ${dest.error}\n` +
        `   Delete it to force a first-run copy, if that is what you want.`,
    };
  }

  const sourceCounts = file.count(source.data);

  if (dest.missing) {
    return { ok: true, firstRun: true, sourcePath, destPath, sourceCounts, destCounts: null };
  }

  const destCounts = file.count(dest.data);
  const failures = [];

  for (const [field, sourceCount] of Object.entries(sourceCounts)) {
    const destCount = destCounts[field];
    if (sourceCount < destCount) {
      failures.push({ field, sourceCount, destCount });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    sourcePath,
    destPath,
    sourceCounts,
    destCounts,
  };
}

/**
 * Format one file's counts as aligned "field: source -> dest" lines.
 */
function formatCounts(counts, destCounts) {
  const width = Math.max(...Object.keys(counts).map(k => k.length));
  return Object.entries(counts).map(([field, sourceCount]) => {
    const label = `${field}:`.padEnd(width + 1);
    const comparison = destCounts ? ` (was ${destCounts[field]})` : ' (new)';
    return `     ${label} ${String(sourceCount).padStart(4)}${comparison}`;
  });
}

function syncToPublic() {
  console.log('📦 SYNC CACHES → public/\n');

  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error(`❌ ERROR: public/ not found at ${PUBLIC_DIR}`);
    process.exit(1);
  }

  // PHASE 1: check everything. Nothing is copied in this pass.
  const results = FILES.map(file => ({ file, result: checkFile(file) }));

  const fatals = results.filter(r => r.result.fatal);
  if (fatals.length > 0) {
    console.error('='.repeat(60));
    console.error('🛑 CANNOT SYNC - nothing was copied');
    console.error('='.repeat(60));
    for (const { result } of fatals) {
      console.error(`   ${result.fatal}`);
    }
    console.error('');
    process.exit(1);
  }

  const regressed = results.filter(r => !r.result.ok);
  if (regressed.length > 0) {
    console.error('='.repeat(60));
    console.error('🛑 GUARD TRIPPED - refusing to sync');
    console.error('='.repeat(60));
    console.error('   A source file has fewer populated records than the copy');
    console.error('   already in public/. Nothing was copied - public/ is untouched.');
    console.error('');

    for (const { file, result } of regressed) {
      console.error(`   ${file.name}:`);
      for (const { field, sourceCount, destCount } of result.failures) {
        console.error(
          `      ${field}: source has ${sourceCount}, public/ has ${destCount}` +
            ` (${destCount - sourceCount} would be lost)`
        );
      }
      console.error('');
    }

    console.error('   Re-run the export/geocode scripts, or investigate the');
    console.error('   root file, before syncing.');
    console.error('');
    process.exit(1);
  }

  // PHASE 2: every file passed - copy them all.
  for (const { file, result } of results) {
    if (result.firstRun) {
      console.log(`ℹ️  First run: public/${file.name} does not exist yet - creating it.`);
    }

    // Copy via a temp file in the same directory, then rename, so an
    // interrupted run can never leave a half-written file in public/.
    const tempPath = `${result.destPath}.tmp`;
    try {
      fs.copyFileSync(result.sourcePath, tempPath);
      fs.renameSync(tempPath, result.destPath);
    } catch (err) {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      console.error(`\n❌ ERROR copying ${file.name}: ${err.message}`);
      process.exit(1);
    }

    console.log(`✅ ${file.name} → public/${file.name}`);
    for (const line of formatCounts(result.sourceCounts, result.destCounts)) {
      console.log(line);
    }
    console.log('');
  }

  console.log('='.repeat(60));
  console.log('🎉 SYNC COMPLETE');
  console.log('='.repeat(60));
  console.log(`   ${results.length} files copied into public/`);
  console.log('   Commit public/ to deploy the updated data.');
  console.log('');
}

syncToPublic();
