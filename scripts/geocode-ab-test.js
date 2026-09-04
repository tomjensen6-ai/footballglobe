/**
 * FOOTBALLGLOBE - GEOCODING SPOT-CHECK (THROWAWAY)
 *
 * (Filename kept from the A/B version it replaces, so shell history still
 * finds it. It is no longer an A/B test: there is one query and no winner.)
 *
 * Samples venues from stadiums-apifootball-candidate.json that are ABSENT from
 * public/stadiums-premium.json and geocodes each once, with the production
 * query shape:
 *
 *   venue, city, country      + components=country:<ISO2>
 *
 * There is deliberately no reference coordinate and no distance column. The
 * A/B version measured against premium and scored 0.000 km on every row,
 * because premium's coordinates were themselves produced by this exact query -
 * it was comparing a query with itself. These venues have no coordinate at
 * all, which is the real population to be judged, and the only thing that can
 * be reported honestly about them is what Google returned: the types, and the
 * point. Whether that point is the right one is a human call, made by looking.
 *
 * Sampling is weighted toward the 1,000-4,999 capacity band, which is 47.6% of
 * the eligible set and the hardest case; large grounds are already known to
 * resolve cleanly. Countries are preferred unused, so 15 venues means 15
 * countries. Selection is fully deterministic - no RNG - so a re-run checks
 * the same venues.
 *
 * WRITES NOTHING. No cache, no candidate, no sidecar, no premium file. There
 * is no file-writing API referenced in this file.
 *
 * Cost: 1 request per venue against the 5,000/day Geocoding cap.
 *
 * Usage: node scripts/geocode-ab-test.js [--dry] [--venues=N]
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PREMIUM_PATH = path.join(ROOT, 'public', 'stadiums-premium.json');
const CANDIDATE_PATH = path.join(ROOT, 'stadiums-apifootball-candidate.json');

// The dedicated geocoding key only. No fallback to the browser Maps key: it is
// referrer-restricted and fails server-side with REQUEST_DENIED, so a fallback
// would turn a missing variable into a run of denied requests. Never printed.
const GOOGLE_API_KEY = process.env.REACT_APP_GOOGLE_GEOCODING_KEY;

const DRY = process.argv.includes('--dry');
const venuesArg = process.argv.find(a => a.startsWith('--venues='));
const VENUE_COUNT = venuesArg ? Number(venuesArg.slice('--venues='.length)) : 15;

const CALL_DELAY_MS = 500;

const CAPACITY_BUCKETS = [
  { label: 'unknown/0', min: null, max: null },
  { label: '1-999', min: 1, max: 999 },
  { label: '1k-4,999', min: 1000, max: 4999 },
  { label: '5k-9,999', min: 5000, max: 9999 },
  { label: '10k-19,999', min: 10000, max: 19999 },
  { label: '20k-39,999', min: 20000, max: 39999 },
  { label: '40k-59,999', min: 40000, max: 59999 },
  { label: '60k+', min: 60000, max: Infinity },
];

/**
 * Sampling weights per capacity band, indexed into CAPACITY_BUCKETS and given
 * out of 100. Roughly proportional to the eligible population but tilted to
 * the small end, where failures are expected to live: 1-999 is 1.7% of the
 * pool and gets 5 slots. 60k+ keeps a single slot purely to confirm the easy
 * band stays easy. Scaled to whatever --venues asks for by largest remainder.
 */
const BUCKET_WEIGHTS = { 1: 5, 2: 50, 3: 19, 4: 15, 5: 7, 6: 3, 7: 1 };

/**
 * Largest-remainder allocation, so the quotas always sum to exactly `count`
 * however the weights divide.
 */
function bucketQuotas(count) {
  const total = Object.values(BUCKET_WEIGHTS).reduce((a, b) => a + b, 0);
  const exact = Object.entries(BUCKET_WEIGHTS)
    .map(([b, w]) => ({ bucket: Number(b), exact: (w * count) / total }));

  const quotas = exact.map(e => ({ ...e, n: Math.floor(e.exact) }));
  let remaining = count - quotas.reduce((a, q) => a + q.n, 0);

  for (const q of [...quotas].sort((a, b) => (b.exact - b.n) - (a.exact - a.n))) {
    if (remaining <= 0) break;
    q.n++;
    remaining--;
  }
  return quotas.filter(q => q.n > 0).map(q => [q.bucket, q.n]).sort((a, b) => a[0] - b[0]);
}

// ISO-3166-1 alpha-2 for Google's components filter. API-Football supplies
// country names, not codes, so this maps by name.
const COUNTRY_TO_ISO2 = {
  England: 'GB', Scotland: 'GB', Wales: 'GB', 'Northern-Ireland': 'GB',
  Spain: 'ES', Italy: 'IT', Germany: 'DE', France: 'FR', Netherlands: 'NL',
  Portugal: 'PT', Brazil: 'BR', Turkey: 'TR', Norway: 'NO', Monaco: 'MC',
  Belgium: 'BE', 'Czech-Republic': 'CZ', Ukraine: 'UA', Greece: 'GR',
  Austria: 'AT', Slovakia: 'SK', Azerbaijan: 'AZ', Switzerland: 'CH',
  Denmark: 'DK', Sweden: 'SE', Poland: 'PL', Serbia: 'RS', Croatia: 'HR',
  Ireland: 'IE', Argentina: 'AR', Mexico: 'MX', USA: 'US', Japan: 'JP',
  'South-Korea': 'KR', China: 'CN', Australia: 'AU', Russia: 'RU',
  Romania: 'RO', Bulgaria: 'BG', Hungary: 'HU', Finland: 'FI', Iceland: 'IS',
  Israel: 'IL', Egypt: 'EG', Morocco: 'MA', Tunisia: 'TN', Algeria: 'DZ',
  'South-Africa': 'ZA', Nigeria: 'NG', Ghana: 'GH', India: 'IN',
  Indonesia: 'ID', Thailand: 'TH', Vietnam: 'VN', Malaysia: 'MY',
  Colombia: 'CO', Chile: 'CL', Peru: 'PE', Uruguay: 'UY', Paraguay: 'PY',
  Ecuador: 'EC', Bolivia: 'BO', Venezuela: 'VE', Canada: 'CA',
  'Saudi-Arabia': 'SA', Qatar: 'QA', 'United-Arab-Emirates': 'AE',
  Kazakhstan: 'KZ', Georgia: 'GE', Armenia: 'AM', Belarus: 'BY',
  Lithuania: 'LT', Latvia: 'LV', Estonia: 'EE', Slovenia: 'SI',
  'Bosnia-and-Herzegovina': 'BA', Albania: 'AL', 'North-Macedonia': 'MK',
  Montenegro: 'ME', Kosovo: 'XK', Cyprus: 'CY', Malta: 'MT', Luxembourg: 'LU',
  Iran: 'IR', Iraq: 'IQ', Jordan: 'JO', Kuwait: 'KW', Oman: 'OM',
  Bahrain: 'BH', Lebanon: 'LB', Syria: 'SY', Uzbekistan: 'UZ',
  Andorra: 'AD', Angola: 'AO', Barbados: 'BB', Bangladesh: 'BD',
  Jamaica: 'JM', 'Trinidad-And-Tobago': 'TT', 'Costa-Rica': 'CR',
  Panama: 'PA', Guatemala: 'GT', Honduras: 'HN', 'El-Salvador': 'SV',
  Nicaragua: 'NI', 'Dominican-Republic': 'DO', Haiti: 'HT', Cuba: 'CU',
  Kenya: 'KE', Tanzania: 'TZ', Uganda: 'UG', Zambia: 'ZM', Zimbabwe: 'ZW',
  Cameroon: 'CM', Senegal: 'SN', 'Ivory-Coast': 'CI', Mali: 'ML',
  Ethiopia: 'ET', Sudan: 'SD', Libya: 'LY', Mozambique: 'MZ', Botswana: 'BW',
  Rwanda: 'RW', Burundi: 'BI', Gabon: 'GA', Congo: 'CG', 'Congo-DR': 'CD',
  'Burkina-Faso': 'BF', Niger: 'NE', Guinea: 'GN', Benin: 'BJ', Togo: 'TG',
  Singapore: 'SG', Philippines: 'PH', Myanmar: 'MM', Cambodia: 'KH',
  Nepal: 'NP', Pakistan: 'PK', 'Sri-Lanka': 'LK', Bangladesh2: 'BD',
  'New-Zealand': 'NZ', Fiji: 'FJ', 'Papua-New-Guinea': 'PG',
  Moldova: 'MD', Turkmenistan: 'TM', Kyrgyzstan: 'KG', Tajikistan: 'TJ',
  Mongolia: 'MN', Afghanistan: 'AF', Yemen: 'YE', Palestine: 'PS',
  'Faroe-Islands': 'FO', Gibraltar: 'GI', 'San-Marino': 'SM',
  Liechtenstein: 'LI', Andorra2: 'AD', 'Hong-Kong': 'HK', Macao: 'MO',
  Bhutan: 'BT', Malawi: 'MW', Bosnia: 'BA', Macedonia: 'MK', Taiwan: 'TW', Bahamas: 'BS', Bermuda: 'BM', Suriname: 'SR', Guyana: 'GY',
};

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\brd\b/g, 'road')
    .replace(/\bln\b/g, 'lane')
    .replace(/\bave?\b/g, 'avenue')
    .replace(/\s+/g, ' ')
    .trim();
}

function relaxVenueName(value) {
  const name = normalizeForMatch(value).replace(/^the\s+/, '');
  const trimmed = name.replace(/\s+(stadium|arena)$/, '');
  return (trimmed.length >= 2 ? trimmed : name).trim();
}

function relaxCity(value) {
  return normalizeForMatch(String(value || '').split(',')[0]);
}

/** Acceptance rule from geocode-stadiums.js, second path. */
function venueNameMatches(venue, formattedAddress) {
  if (!venue || venue === 'Unknown') return false;
  const needle = normalizeForMatch(venue);
  if (needle.length < 5) return false;
  return normalizeForMatch(formattedAddress).includes(needle);
}

function bucketOf(venue) {
  const capacity = Number.isFinite(venue.capacity) ? venue.capacity : 0;
  if (capacity <= 0) return 0;
  const index = CAPACITY_BUCKETS.findIndex(
    (b, i) => i > 0 && capacity >= b.min && capacity <= b.max
  );
  return index === -1 ? 0 : index;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function geocode(address, iso2) {
  return new Promise((resolve, reject) => {
    let url = 'https://maps.googleapis.com/maps/api/geocode/json'
      + `?address=${encodeURIComponent(address)}`;
    if (iso2) url += `&components=${encodeURIComponent('country:' + iso2)}`;
    url += `&key=${GOOGLE_API_KEY}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Eligible = present in the candidate, absent from premium under BOTH the
 * strict and the relaxed key, and not already carrying a coordinate. A venue
 * premium already knows about is not what this check is about.
 */
function eligibleVenues() {
  const premium = JSON.parse(fs.readFileSync(PREMIUM_PATH, 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf8'));

  const strict = new Set();
  const relaxed = new Set();
  for (const country of Object.values(premium.countries)) {
    for (const league of country.leagues) {
      for (const s of league.stadiums) {
        strict.add(`${normalizeForMatch(s.venue)}|${normalizeForMatch(s.city)}`);
        relaxed.add(`${relaxVenueName(s.venue)}|${relaxCity(s.city)}`);
      }
    }
  }

  return candidate.venues.filter(v =>
    v.latitude === null
    && !v.carryExcluded
    && v.name && v.city && v.country
    && !strict.has(`${normalizeForMatch(v.name)}|${normalizeForMatch(v.city)}`)
    && !relaxed.has(`${relaxVenueName(v.name)}|${relaxCity(v.city)}`)
  );
}

/**
 * Deterministic weighted sample. Within each bucket, countries not yet used
 * anywhere in the sample are preferred, so the 15 rows cover 15 countries
 * rather than 15 grounds in the same league.
 */
function selectVenues(count) {
  const eligible = eligibleVenues();

  const buckets = new Map();
  for (const v of eligible) {
    const b = bucketOf(v);
    if (!buckets.has(b)) buckets.set(b, new Map());
    const byCountry = buckets.get(b);
    if (!byCountry.has(v.country)) byCountry.set(v.country, []);
    byCountry.get(v.country).push(v);
  }
  for (const byCountry of buckets.values()) {
    for (const list of byCountry.values()) {
      list.sort((a, b) => (a.venueId ?? 0) - (b.venueId ?? 0));
    }
  }

  const usedCountries = new Set();
  const picked = [];

  const quotas = bucketQuotas(count);

  for (const [bucketIndex, quota] of quotas) {
    const byCountry = buckets.get(bucketIndex);
    if (!byCountry) continue;
    const countries = [...byCountry.keys()].sort();

    let taken = 0;
    // Preferred pass: countries this sample has not touched, taken at evenly
    // spaced positions across the sorted list rather than from the front.
    // Taking the first unused country each time produced an alphabetical
    // prefix (Albania..Bolivia) and never reached anything past B.
    const stride = [];
    for (let i = 0; i < countries.length; i++) {
      const slot = Math.floor((i * quota) / countries.length);
      if (!stride[slot]) stride[slot] = [];
      stride[slot].push(countries[i]);
    }
    for (const group of stride) {
      if (taken >= quota) break;
      if (!group) continue;
      const country = group.find(c => !usedCountries.has(c));
      if (!country) continue;
      picked.push({ venue: byCountry.get(country)[0], bucket: CAPACITY_BUCKETS[bucketIndex].label });
      usedCountries.add(country);
      taken++;
    }
    // Fallback: allow a repeat country rather than leave the quota short.
    for (const country of countries) {
      if (taken >= quota) break;
      const list = byCountry.get(country);
      const next = list.find(v => !picked.some(p => p.venue === v));
      if (!next) continue;
      picked.push({ venue: next, bucket: CAPACITY_BUCKETS[bucketIndex].label });
      taken++;
    }
  }

  return picked.slice(0, count);
}

/**
 * Render a table sized to its own content. The previous version used fixed
 * padStart widths, and a cell one character too wide silently ran into its
 * neighbour ("0.0000.129"). Widths are now computed from the data, so a long
 * value widens its column instead of corrupting the row.
 */
function renderTable(headers, rows, alignRight = new Set()) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map(r => String(r[i]).length)));

  const line = cells => cells
    .map((c, i) => (alignRight.has(i)
      ? String(c).padStart(widths[i])
      : String(c).padEnd(widths[i])))
    .join('  ')
    .replace(/\s+$/, '');

  const rule = widths.map(w => '-'.repeat(w)).join('  ');
  return [line(headers), rule, ...rows.map(line)].join('\n');
}

async function main() {
  if (!GOOGLE_API_KEY && !DRY) {
    console.error('ERROR: REACT_APP_GOOGLE_GEOCODING_KEY is not set.');
    process.exit(1);
  }

  const sample = selectVenues(VENUE_COUNT);
  console.log(`Sampled ${sample.length} venues absent from premium, `
    + `across ${new Set(sample.map(s => s.venue.country)).size} countries`);
  console.log(`Requests to be made: ${DRY ? 0 : sample.length}\n`);

  const buildQuery = v => [v.name, v.city, v.country].join(', ');

  if (DRY) {
    console.log(renderTable(
      ['venue', 'city', 'country', 'capacity', 'band', 'iso2'],
      sample.map(s => [
        s.venue.name, s.venue.city, s.venue.country,
        s.venue.capacity ?? '—', s.bucket,
        COUNTRY_TO_ISO2[s.venue.country] || 'NONE',
      ]),
      new Set([3])
    ));
    return;
  }

  const results = [];
  for (const { venue, bucket } of sample) {
    const iso2 = COUNTRY_TO_ISO2[venue.country] || null;
    process.stderr.write(`  ${venue.name} (${venue.country}) ... `);

    const response = await geocode(buildQuery(venue), iso2);

    if (response.status === 'OVER_QUERY_LIMIT' || response.status === 'OVER_DAILY_LIMIT') {
      console.error(`\nABORT: ${response.status} - ${response.error_message || 'quota'}`);
      process.exit(1);
    }

    const top = response.status === 'OK' && Array.isArray(response.results) && response.results.length
      ? response.results[0]
      : null;
    const types = (top && top.types) || [];
    const byType = types.includes('stadium');
    const byName = !byType && top && venueNameMatches(venue.name, top.formatted_address);

    results.push({
      venue, bucket, iso2, types,
      status: response.status,
      accepted: !!(byType || byName),
      acceptedBy: byType ? 'stadium-type' : (byName ? 'name-match' : null),
      lat: top ? top.geometry.location.lat : null,
      lng: top ? top.geometry.location.lng : null,
      formatted: top ? top.formatted_address : null,
    });

    process.stderr.write(`${byType ? 'stadium' : (byName ? 'name-match' : 'REJECT')}\n`);
    await sleep(CALL_DELAY_MS);
  }

  report(results);
}

function report(results) {
  const pct = (n, d) => (d === 0 ? '—' : (100 * n / d).toFixed(0) + '%');
  const accepted = results.filter(r => r.accepted);
  const rejected = results.filter(r => !r.accepted);

  console.log('\n' + '='.repeat(100));
  console.log('SPOT-CHECK (query = venue, city, country) - acceptance is the RULE\'s verdict, not verified truth');
  console.log('='.repeat(100));
  console.log(`   venues checked:         ${results.length}`);
  console.log(`   accepted:               ${accepted.length}  (${pct(accepted.length, results.length)})`);
  console.log(`     via "stadium" type:   ${results.filter(r => r.acceptedBy === 'stadium-type').length}`);
  console.log(`     via venue-name match: ${results.filter(r => r.acceptedBy === 'name-match').length}`);
  console.log(`   rejected:               ${rejected.length}  (${pct(rejected.length, results.length)})`);
  console.log(`   zero results returned:  ${results.filter(r => r.lat === null).length}`);

  // ---- by capacity band ----
  console.log('\n' + '-'.repeat(100));
  console.log('ACCEPTANCE BY CAPACITY BAND');
  console.log('-'.repeat(100));
  const bandOrder = CAPACITY_BUCKETS.map(b => b.label);
  const byBand = new Map();
  for (const r of results) {
    if (!byBand.has(r.bucket)) byBand.set(r.bucket, []);
    byBand.get(r.bucket).push(r);
  }
  console.log(renderTable(
    ['band', 'n', 'accepted', 'rejected', 'rate'],
    bandOrder.filter(b => byBand.has(b)).map(b => {
      const rows = byBand.get(b);
      const ok = rows.filter(r => r.accepted).length;
      return [b, rows.length, ok, rows.length - ok, pct(ok, rows.length)];
    }),
    new Set([1, 2, 3, 4])
  ));

  // ---- by country ----
  console.log('\n' + '-'.repeat(100));
  console.log('ACCEPTANCE BY COUNTRY  (most countries carry n=1 - these are outcomes, not rates)');
  console.log('-'.repeat(100));
  const byCountry = new Map();
  for (const r of results) {
    if (!byCountry.has(r.venue.country)) byCountry.set(r.venue.country, []);
    byCountry.get(r.venue.country).push(r);
  }
  const countryRows = [...byCountry.entries()]
    .map(([c, rows]) => {
      const ok = rows.filter(r => r.accepted).length;
      return { c, n: rows.length, ok, rate: ok / rows.length };
    })
    .sort((a, b) => a.rate - b.rate || b.n - a.n || a.c.localeCompare(b.c));
  console.log(renderTable(
    ['country', 'n', 'accepted', 'rejected'],
    countryRows.map(r => [r.c, r.n, r.ok, r.n - r.ok]),
    new Set([1, 2, 3])
  ));

  // ---- type signatures among ACCEPTED ----
  console.log('\n' + '-'.repeat(100));
  console.log('TYPES RETURNED, ACCEPTED RESULTS ONLY');
  console.log('-'.repeat(100));
  const sigs = new Map();
  for (const r of accepted) {
    const sig = r.types.join(', ') || '(none)';
    if (!sigs.has(sig)) sigs.set(sig, { n: 0, by: new Set() });
    sigs.get(sig).n++;
    sigs.get(sig).by.add(r.acceptedBy);
  }
  console.log(renderTable(
    ['n', 'accepted via', 'types'],
    [...sigs.entries()].sort((a, b) => b[1].n - a[1].n)
      .map(([sig, v]) => [v.n, [...v.by].join('+'), sig]),
    new Set([0])
  ));
  const nonStadiumAccepted = accepted.filter(r => !r.types.includes('stadium'));
  console.log(`\n   accepted WITHOUT a stadium type: ${nonStadiumAccepted.length}`);
  for (const r of nonStadiumAccepted) {
    console.log(`     ${r.venue.name} (${r.venue.country}) [${r.types.join(', ')}]`);
    console.log(`       ${r.formatted}`);
  }

  // ---- rejected, in full ----
  console.log('\n' + '-'.repeat(100));
  console.log('REJECTED VENUES');
  console.log('-'.repeat(100));
  console.log(renderTable(
    ['venue', 'city', 'country', 'capacity', 'types returned'],
    rejected.map(r => [
      r.venue.name, r.venue.city, r.venue.country,
      r.venue.capacity ?? '—',
      r.types.join(', ') || r.status,
    ]),
    new Set([3])
  ));
  console.log('='.repeat(100));
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
