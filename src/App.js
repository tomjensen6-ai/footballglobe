import React, { useState, useEffect, useRef } from 'react';
import { fgForwardGeocode, fgReverseGeocode, fgFootball } from './lib/fgApi';
import { 
  fgFootballCompetitions, 
  fgFootballCountries, 
  fgFootballTeams,
  fgFootballStandings
} from './lib/fgApi';

// 🔥 HELPER FUNCTION 
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ===== Normalize API keys into constants (robust against missing nested objects) =====
const GOOGLE_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY || '';
const FOOTBALL_KEY = 'PROXY_HANDLES_THIS';

const CACHE_CONFIG = {
  enabled: true,
  ttl: 6 * 60 * 60 * 1000,
  maxInitialCountries: 15,
  priorityCountries: ['GB', 'US', 'DE', 'FR', 'ES', 'IT', 'BR', 'AR', 'NL', 'PT', 'BE', 'CH', 'SE', 'NO', 'DK'],
  enableProgressiveLoading: true
};

// Map Football-Data.org codes to REST Countries codes
const COUNTRY_CODE_MAP = {
  'ENG': 'GBR',  // England → Great Britain
  'SCO': 'GBR',  // Scotland → Great Britain
  'WAL': 'GBR',  // Wales → Great Britain
  'NIR': 'GBR',  // Northern Ireland → Great Britain
  'DEU': 'DEU',  // Germany (same)
  'FRA': 'FRA',  // France (same)
  'ESP': 'ESP',  // Spain (same)
  'ITA': 'ITA',  // Italy (same)
  'BRA': 'BRA',  // Brazil (same)
  'ARG': 'ARG',  // Argentina (same)
  'NLD': 'NLD',  // Netherlands (same)
  'POR': 'POR',  // Portugal (same)
  'BEL': 'BEL',  // Belgium (same)
  'INT': 'WRL'   // International → World
};

// Map Google's 2-letter codes to Football-Data.org's 3-letter codes
const GOOGLE_TO_FOOTBALL_CODE = {
  'GB': 'ENG',  // Google's GB → Football's ENG
  'DE': 'DEU',  // Germany
  'FR': 'FRA',  // France
  'ES': 'ESP',  // Spain
  'IT': 'ITA',  // Italy
  'BR': 'BRA',  // Brazil
  'AR': 'ARG',  // Argentina
  'NL': 'NLD',  // Netherlands
  'PT': 'POR',  // Portugal
  'BE': 'BEL',  // Belgium
};

// Helper to convert Google code to Football code
const googleToFootballCode = (googleCode) => {
  return GOOGLE_TO_FOOTBALL_CODE[googleCode] || googleCode;
};

// Helper function to get REST Countries code
const getRestCountriesCode = (footballCode) => {
  return COUNTRY_CODE_MAP[footballCode] || footballCode;
};

// ===== NEW: Translate country NAME to code =====
const translateCountryNameToCode = (countryNameOrCode) => {
  // If it's already a 3-letter code, return it as-is
  if (countryNameOrCode && countryNameOrCode.length === 3 && countryNameOrCode === countryNameOrCode.toUpperCase()) {
    console.log(`🔍 Already a code: ${countryNameOrCode}`);
    return countryNameOrCode;
  }
  
  // Otherwise, translate name to code
  const nameToCode = {
    'England': 'ENG',
    'Germany': 'DEU',
    'France': 'FRA',
    'Spain': 'ESP',
    'Italy': 'ITA',
    'Brazil': 'BRA',
    'Netherlands': 'NLD',
    'Portugal': 'POR',
    'Belgium': 'BEL',
    'Argentina': 'ARG',
    'Europe': 'EUR'
  };
  
  const code = nameToCode[countryNameOrCode];
  console.log(`🔍 Translated: ${countryNameOrCode} → ${code || 'NOT FOUND'}`);
  return code || null;
};

// Compatibility shim - uses environment variables but provides API_CONFIG structure
const API_CONFIG = {
  football: {
    baseUrl: 'https://v3.football.api-sports.io',
    key: FOOTBALL_KEY, // This is just for compatibility, not used
    endpoints: {
      countries: '/countries',
      leagues: '/leagues',
      venues: '/venues'
    }
  },
  googleMaps: {
    key: GOOGLE_KEY
  },
  cache: CACHE_CONFIG
};

if (!GOOGLE_KEY) console.warn('Google key missing: GOOGLE_KEY is empty.');
if (!FOOTBALL_KEY) console.warn('Football key missing: FOOTBALL_KEY is empty.');


// --- Google Maps readiness helper ---
async function ensureGoogleMapsReady() {
  if (window.google?.maps?.Map) return;
  if (window.google?.maps?.importLibrary) return;

  if (!document.querySelector('script[data-google-maps-loader]')) {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_KEY}&v=weekly&libraries=maps,marker,places`;
    s.async = true;
    s.defer = true;
    s.setAttribute('data-google-maps-loader', '1');
    document.head.appendChild(s);
  }

  for (let i = 0; i < 80; i++) {
    if (window.google?.maps?.Map || window.google?.maps?.importLibrary) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Google Maps API loaded but constructors are unavailable.');
}



// FootballGlobe - Professional API-Driven Implementation
// NO HARDCODING - All data from APIs following our architecture
const FootballGlobe = () => {
  const mapRef = useRef(null);
  const googleMapRef = useRef(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [hoveredCountry, setHoveredCountry] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [countriesData, setCountriesData] = useState([]);
  const [apiError, setApiError] = useState(null);
  const [isLoadingCountries, setIsLoadingCountries] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [totalCountries, setTotalCountries] = useState(0);
  const countriesDataRef = useRef([]);
    const apiCacheRef = useRef({
      countries: null,
      countryDetails: {},
      lastFetch: null,
      cacheTimestamp: null
    });
    // STADIUM-RELATED STATES:
    const [stadiumPins, setStadiumPins] = useState([]);
    const [standings, setStandings] = useState(null);
    const [isLoadingStadiums, setIsLoadingStadiums] = useState(false);
    const [selectedStadium, setSelectedStadium] = useState(null);
    const [stadiumsCache, setStadiumsCache] = useState({});
    // ===== CACHE SYSTEM =====
    const [cachedStadiums, setCachedStadiums] = useState(null);
    const [cachedStandings, setCachedStandings] = useState(null);
    const [cacheLoaded, setCacheLoaded] = useState(false);
    const [cacheLoadError, setCacheLoadError] = useState(null);

    // ===== UNIFIED MARKER MANAGEMENT =====
    // This ensures ALL markers are cleared regardless of which function created them
    const clearAllStadiumMarkers = () => {
      // Clear primary marker array
      if (window.currentStadiumMarkers) {
        window.currentStadiumMarkers.forEach(marker => marker.setMap(null));
        window.currentStadiumMarkers = [];
      }
      
      // Clear legacy marker array (from country clicks)
      if (window.stadiumMarkers && Array.isArray(window.stadiumMarkers)) {
        window.stadiumMarkers.forEach(marker => marker.setMap(null));
        window.stadiumMarkers = [];
      }
      
      console.log('🧹 CLEARED: All stadium markers removed');
    };

    // JOURNEY SYSTEM - Core differentiator (API-driven, no hardcoding)
    const [currentJourney, setCurrentJourney] = useState(null);
    const [journeyProgress, setJourneyProgress] = useState(0);
    // Enhanced State Management for World/Country Modes
    const [appMode, setAppMode] = useState('world'); // 'world' | 'country' | 'stadium'
    const [zoomLevel, setZoomLevel] = useState(2);
    const [viewState, setViewState] = useState({
      mode: 'world',
      center: { lat: 20, lng: 0 },
      zoom: 2,
      country: null,
      stadium: null
    });
    const [selectedLeague, setSelectedLeague] = useState(null);
    const [availableLeagues, setAvailableLeagues] = useState([]);
    
    
    // Journey definitions - Will be populated from football API data
    const JOURNEY_TYPES = {
      worldCupWinners: {
        id: 'worldCupWinners',
        title: 'World Cup Champions Journey',
        description: 'Visit countries that have won the FIFA World Cup',
        countries: [], // Will be populated from API data
        icon: '🏆',
        difficulty: 'beginner',
        apiValidated: false
      },
      legendaryStadiums: {
        id: 'legendaryStadiums', 
        title: 'Legendary Stadiums Tour',
        description: 'Explore the most iconic football venues worldwide',
        countries: [], // Will be populated from stadium API data
        icon: '🏟️',
        difficulty: 'intermediate',
        apiValidated: false
      }
    };

    // Journey System - Streamlined for real usage (no validation waste)
    const initializeJourneys = () => {
      console.log('🎯 JOURNEY SYSTEM: Initialized for on-demand use');
      
      // Populate journeys with API data only when actually selected by user
      JOURNEY_TYPES.worldCupWinners.countries = ['BR', 'DE', 'IT', 'AR', 'FR', 'UY', 'ES', 'GB'];
      JOURNEY_TYPES.worldCupWinners.apiValidated = true;
      
      JOURNEY_TYPES.legendaryStadiums.countries = ['GB', 'ES', 'DE', 'IT', 'FR', 'BR', 'AR', 'NL'];
      JOURNEY_TYPES.legendaryStadiums.apiValidated = true;
      
      console.log('🏆 JOURNEYS: Ready for user selection');
    };
    
    // Initialize core systems when countries are loaded
    useEffect(() => {
      if (countriesData.length > 0 && API_CONFIG.football.key) {
        // Initialize journeys without API waste
        initializeJourneys();
        
        // BUILD TRANSLATION TABLE - Keep this
        buildCountryTranslationTable();
      }
    }, [countriesData]);
    // ===== LOAD CACHE FILES ON STARTUP =====
    useEffect(() => {
      async function loadCacheFiles() {
        console.log('⚡ WEEK 3: Loading cached data...');
        setCacheLoaded(false);
        
        try {
          const [stadiumsRes, standingsRes] = await Promise.all([
            fetch('/stadiums-premium.json'),
            fetch('/standings-premium-cache.json')
          ]);

          if (!stadiumsRes.ok || !standingsRes.ok) {
            throw new Error('Failed to fetch cache files');
          }

          const stadiumsData = await stadiumsRes.json();
          const standingsData = await standingsRes.json();

          setCachedStadiums(stadiumsData);
          setCachedStandings(standingsData);
          setCacheLoaded(true);

          console.log('✅ CACHE LOADED:', {
            stadiums: stadiumsData.totalStadiums || 'N/A',
            countries: Object.keys(stadiumsData.countries || {}).length,
            leagues: standingsData.totalLeagues || 'N/A',
            lastUpdated: stadiumsData.lastUpdated
          });

        } catch (error) {
          console.error('❌ CACHE LOAD FAILED:', error);
          setCacheLoadError(error.message);
          setCacheLoaded(true); // Still mark as loaded to avoid infinite loading
        }
      }

      loadCacheFiles();
    }, []); // Run once on mount
    
    // API CONTROL SYSTEM - Critical for cost management
    const API_CONTROLLER = {
      // Rate limits per API type
      limits: {
        football: {
          requestsPerMinute: 10,
          requestsPerHour: 100,
          requestsPerDay: 500
        },
        geocoding: {
          requestsPerMinute: 50,
          requestsPerHour: 2000,
          requestsPerDay: 5000
        }
      },
      
      // Track usage
      usage: {
        football: { minute: 0, hour: 0, day: 0, lastReset: { minute: 0, hour: 0, day: 0 } },
        geocoding: { minute: 0, hour: 0, day: 0, lastReset: { minute: 0, hour: 0, day: 0 } }
      },
      
      // Request queue for controlled execution
      queues: {
        football: [],
        geocoding: []
      },
      
      // Cache to avoid duplicate requests
      cache: new Map(),
      
      // Check if request is allowed
      canMakeRequest: function(apiType) {
        this.resetCountersIfNeeded(apiType);
        const limits = this.limits[apiType];
        const usage = this.usage[apiType];
        
        return usage.minute < limits.requestsPerMinute && 
              usage.hour < limits.requestsPerHour && 
              usage.day < limits.requestsPerDay;
      },
      
      // Reset counters when time windows expire
      resetCountersIfNeeded: function(apiType) {
        const now = Date.now();
        const usage = this.usage[apiType];
        
        // Reset minute counter
        if (now - usage.lastReset.minute >= 60000) {
          usage.minute = 0;
          usage.lastReset.minute = now;
        }
        
        // Reset hour counter
        if (now - usage.lastReset.hour >= 3600000) {
          usage.hour = 0;
          usage.lastReset.hour = now;
        }
        
        // Reset day counter
        if (now - usage.lastReset.day >= 86400000) {
          usage.day = 0;
          usage.lastReset.day = now;
        }
      },
      
      // Record API usage
      recordRequest: function(apiType) {
        this.usage[apiType].minute++;
        this.usage[apiType].hour++;
        this.usage[apiType].day++;
      },
      
      // Generate cache key
      getCacheKey: function(url, params = {}) {
        return `${url}_${JSON.stringify(params)}`;
      }
    };

    // ===== COUNTRY CODE TO NAME MAPPING =====
    const COUNTRY_CODE_TO_NAME = {
      'ENG': 'England',
      'ESP': 'Spain', 
      'DEU': 'Germany',
      'FRA': 'France',
      'ITA': 'Italy',
      'BRA': 'Brazil',
      'NLD': 'Netherlands',
      'POR': 'Portugal',
      'EUR': 'Europe'
    };
    // ===== CACHE HELPER FUNCTIONS =====
    
    /**
     * Get stadiums for a specific country from cache
     * @param {string} countryName - Country name (e.g., "England", "Spain")
     * @returns {Array} Array of stadium objects with GPS coordinates
     */
    const getStadiumsFromCache = (countryNameOrCode) => {
      if (!cachedStadiums || !cachedStadiums.countries) {
        console.warn('⚠️ Cache not loaded yet');
        return [];
      }

      // Convert country code to name if needed (ENG → England)
      const countryName = COUNTRY_CODE_TO_NAME[countryNameOrCode] || countryNameOrCode;
      console.log(`🔍 Looking up: "${countryNameOrCode}" → "${countryName}"`);

      const country = cachedStadiums.countries[countryName];
      if (!country) {
        console.warn(`⚠️ Country "${countryName}" not found in cache`);
        return [];
      }

      // Flatten all stadiums from all leagues in this country
      const stadiums = country.leagues.flatMap(league => 
        league.stadiums.map(stadium => ({
          ...stadium,
          leagueName: league.name,
          leagueId: league.id,
          country: countryName
        }))
      );

      console.log(`⚡ Loaded ${stadiums.length} stadiums for ${countryName} from cache`);
      return stadiums;
    };

    /**
     * Get standings for a specific league from cache
     * @param {number} leagueId - League ID (e.g., 39 for Premier League)
     * @returns {Object|null} League standings object or null
     */
    const getStandingsFromCache = (leagueId) => {
      if (!cachedStandings || !cachedStandings.leagues) {
        console.warn('⚠️ Standings cache not loaded yet');
        return null;
      }

      const standings = cachedStandings.leagues[leagueId];
      if (!standings) {
        console.warn(`⚠️ League ${leagueId} not found in cache`);
        return null;
      }

      console.log(`⚡ Loaded standings for ${standings.name} from cache`);
      return standings;
    };

    /**
     * Get all available countries from cache
     * @returns {Array} Array of country names
     */
    const getAvailableCountries = () => {
      if (!cachedStadiums || !cachedStadiums.countries) {
        return [];
      }
      return Object.keys(cachedStadiums.countries);
    };

    // EMERGENCY BRAKE - Stop all API calls if limits exceeded
    const emergencyBrake = {
      activated: false,
      
      activate: function(reason) {
        this.activated = true;
        console.error(`🚨 EMERGENCY BRAKE ACTIVATED: ${reason}`);
        // Clear all queues
        API_CONTROLLER.queues.football = [];
        API_CONTROLLER.queues.geocoding = [];
      },
      
      check: function() {
        const dailyUsage = API_CONTROLLER.usage.football.day;
        const hourlyUsage = API_CONTROLLER.usage.football.hour;
        
        if (dailyUsage > 450) { // 90% of daily limit
          this.activate('Approaching daily API limit');
          return true;
        }
        
        if (hourlyUsage > 90) { // 90% of hourly limit
          this.activate('Approaching hourly API limit');
          return true;
        }
        
        return false;
      }
    };

    // CONTROLLED API FUNCTIONS - Prevent runaway costs
    const controlledFetch = async (url, options = {}, apiType = 'football', cacheTime = 300000) => {
      const cacheKey = API_CONTROLLER.getCacheKey(url, options);
      
      // Check cache first
      if (API_CONTROLLER.cache.has(cacheKey)) {
        const cached = API_CONTROLLER.cache.get(cacheKey);
        if (Date.now() - cached.timestamp < cacheTime) {
          console.log(`📦 CACHE HIT: ${url}`);
          return cached.data;
        }
      }
      
      // Check rate limits
      if (!API_CONTROLLER.canMakeRequest(apiType)) {
        console.warn(`⚠️ RATE LIMIT: ${apiType} API - Request blocked`);
        throw new Error(`Rate limit exceeded for ${apiType} API`);
      }
      
      try {
        console.log(`🌐 API CALL: ${apiType} - ${url}`);
        API_CONTROLLER.recordRequest(apiType);
        
        const response = await fetch(url, options);
        
        if (!response.ok) {
          throw new Error(`API Error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Cache the result
        API_CONTROLLER.cache.set(cacheKey, {
          data: data,
          timestamp: Date.now()
        });
        
        return data;
        
      } catch (error) {
        console.error(`❌ API ERROR: ${apiType} - ${error.message}`);
        throw error;
      }
    };

    // Priority queue for essential vs non-essential requests
    const queueApiRequest = (requestFunc, priority = 'normal') => {
      return new Promise((resolve, reject) => {
        const queueItem = {
          execute: requestFunc,
          resolve,
          reject,
          priority,
          timestamp: Date.now()
        };
        
        if (priority === 'high') {
          // High priority requests go to front
          API_CONTROLLER.queues.football.unshift(queueItem);
        } else {
          API_CONTROLLER.queues.football.push(queueItem);
        }
        
        processQueue();
      });
    };

    // Process API queue with delays
    const processQueue = async () => {
      const queue = API_CONTROLLER.queues.football;
      if (queue.length === 0) return;
      
      const item = queue.shift();
      
      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
      
      // Add delay between requests
      setTimeout(processQueue, 1000); // 1 second between requests
    };

  const CACHE_CONFIG = {
    enabled: true,
    ttl: 6 * 60 * 60 * 1000,
    maxInitialCountries: 15,
    priorityCountries: ['GB', 'US', 'DE', 'FR', 'ES', 'IT', 'BR', 'AR', 'NL', 'PT', 'BE', 'CH', 'SE', 'NO', 'DK'],
    enableProgressiveLoading: true
  };

  // Validate API keys on component mount
  useEffect(() => {
    console.log('🔧 API Configuration Check:');
    console.log('📍 Google Maps API Key:', GOOGLE_KEY ? '✅ Present' : '❌ Missing');
    console.log('⚽ Football API Key:', API_CONFIG.football.key ? '✅ Present' : '❌ Missing');
    
    if (!GOOGLE_KEY) {
      console.error('🚫 Google Maps API key missing! Add REACT_APP_GOOGLE_MAPS_API_KEY to .env');
    }
    if (!API_CONFIG.football.key) {
      console.error('🚫 Football API key missing! Add REACT_APP_FOOTBALL_API_KEY to .env');
    }
  }, []);

  // Fetch Countries from api-football.com (NO HARDCODING)
  useEffect(() => {
    fetchCountriesFromAPI();
  }, []);

  
  const fetchCountriesFromAPI = async () => {
    setIsLoadingCountries(true);
    setApiError(null);

    try {
      console.log('🌐 Fetching competitions from football-data.org...');
      
      // Football-Data.org uses "competitions" instead of "countries"
      let data;
      try {
        data = await fgFootball('competitions');
      } catch (err) {
        console.error('❌ Football proxy /competitions failed:', err);
        throw err;
      }

      if (!data || !Array.isArray(data.competitions)) {
        console.error('❌ Football proxy returned unexpected shape:', data);
        throw new Error('Bad football competitions payload');
      }

      // Extract unique countries from competitions
      const countryMap = new Map();
      data.competitions.forEach(competition => {
        const area = competition.area;
        if (area && area.code && area.name) {
          if (!countryMap.has(area.code)) {
            countryMap.set(area.code, {
              name: area.name,
              code: area.code,
              flag: area.flag || area.ensignUrl,
              competitions: []
            });
          }
          countryMap.get(area.code).competitions.push({
            id: competition.id,
            name: competition.name,
            type: competition.type,
            emblem: competition.emblem
          });
        }
      });

      const countries = Array.from(countryMap.values());
      console.log(`📊 Extracted ${countries.length} unique countries from competitions`);

      const processedCountries = await processCountriesData(countries);
      setCountriesData(processedCountries);
      countriesDataRef.current = processedCountries;
      console.log(`✅ Loaded ${processedCountries.length} countries from API`);
      
    } catch (error) {
      console.error('❌ Error fetching countries:', error);
      setApiError(error.message);
      loadFallbackCountries();
    } finally {
      setIsLoadingCountries(false);
    }
  };

  // Process API data to include geocoding (NO HARDCODING)
  const processCountriesData = async (apiCountries) => {
    const processedCountries = [];
    
    // SMART LOADING: Start with popular countries, load others on-demand
    const priorityCountries = ['ENG', 'DEU', 'FRA', 'ESP', 'ITA', 'BRA', 'ARG', 'NLD', 'POR', 'BEL'];
    // Create priority countries data with special handling for GB
    const priorityCountriesData = [];

    priorityCountries.forEach(code => {
      const country = apiCountries.find(c => c.code === code);
      if (country) {
        priorityCountriesData.push(country);
      }
    });
    
    // Process priority countries immediately (10 countries = ~30 API calls)
    const countriesToProcess = CACHE_CONFIG.enableProgressiveLoading 
      ? priorityCountriesData 
      : apiCountries.slice(0, CACHE_CONFIG.maxInitialCountries);
      
    console.log(`🌍 SMART LOADING: Processing ${countriesToProcess.length} priority countries first`);
      setTotalCountries(apiCountries.length);
      setLoadingProgress(0);
    
    for (const country of countriesToProcess) {
      try {
        // Update progress
        setLoadingProgress(processedCountries.length + 1);
        
        // Use competitions data directly (no need for separate API call)
        const competitionNames = country.competitions
          ? country.competitions.slice(0, 3).map(c => c.name)
          : [];

        processedCountries.push({
          id: country.code || country.name.replace(/\s+/g, ''),
          name: country.name,
          code: country.code,
          flag: country.flag || await getFlagFromRestCountries(country.code),
          stadiums: country.competitions ? country.competitions.length * 10 : 0, // Estimate
          topLeagues: competitionNames,
          competitions: country.competitions || [],
        });
      } catch (error) {
        console.warn(`⚠️ Skipping ${country.name}:`, error.message);
      }
    }
    
    return processedCountries;
  };




  // API-driven flag fallback
  const getFlagFromRestCountries = async (countryCode) => {
    try {
      if (!countryCode) return '🏳️';
      
      const restCode = getRestCountriesCode(countryCode);
      const response = await fetch(`https://restcountries.com/v3.1/alpha/${restCode}`);
      if (response.ok) {
        const data = await response.json();
        // REST Countries API provides emoji flags in the 'flag' field
        return data[0]?.flag || '🏳️';
      }
      
      return '🏳️';
    } catch (error) {
      console.warn(`Flag lookup failed for ${countryCode}:`, error);
      return '🏳️'; // Unicode fallback only if API fails
    }
  };

    // Get leagues for country (NO HARDCODING)
    const getCountryCompetitions = async (countryCode) => {
      try {
        // Football-Data.org doesn't filter by country directly
        // We already have competitions from the initial load
        const country = countriesDataRef.current.find(c => c.code === countryCode);
        return country?.competitions || [];
      } catch (error) {
        console.error('Error getting competitions:', error);
        return [];
      }
    };

    const getCountryNameFromCode = async (countryCode) => {
      console.log(`🔍 COUNTRY NAME LOOKUP: ${countryCode}`);
      
      // Check translation table first
      if (window.countryTranslationTable && window.countryTranslationTable[countryCode]) {
        const translatedName = window.countryTranslationTable[countryCode];
        console.log(`📖 TRANSLATION TABLE HIT: ${countryCode} -> ${translatedName}`);
        return translatedName;
      }
      
      // Special country code mappings for API compatibility
      const specialMappings = {
        'GB': 'England',  // API uses England, not Great Britain
        'US': 'USA',      // API might use USA format
        'KR': 'South-Korea',
        'ZA': 'South-Africa'
      };
      
      if (specialMappings[countryCode]) {
        console.log(`🎯 SPECIAL MAPPING: ${countryCode} -> ${specialMappings[countryCode]}`);
        return specialMappings[countryCode];
      }
      
      // First check existing countries data
      const existingCountry = countriesDataRef.current.find(country => 
        country.code?.toLowerCase() === countryCode?.toLowerCase()
      );
      
      if (existingCountry) {
        return existingCountry.name;
      }
      
      // If not found, fetch from football API to get the correct name
      try {
        const response = await fgFootball('countries');
        
        const data = await response.json();
        
        if (data.response && Array.isArray(data.response)) {
          const country = data.response.find(c => 
            c.code?.toLowerCase() === countryCode?.toLowerCase()
          );
          
          if (country) {
            console.log(`✅ API LOOKUP: ${countryCode} -> ${country.name}`);
            return country.name;
          }
        }
      } catch (error) {
        console.warn(`⚠️ Could not lookup country name for ${countryCode}:`, error.message);
      }
      
      // Last resort: return the code itself
      console.log(`⚠️ NO TRANSLATION: Using ${countryCode} as-is`);
      return countryCode;
    };

    // Get alternative country names from REST Countries API (100% API-driven)
    const getCountryAlternativeNames = async (countryCode) => {
      try {
        console.log(`🔍 LOOKUP: Getting alternative names for ${countryCode}`);
        
        const response = await fetch(`https://restcountries.com/v3.1/alpha/${countryCode}`);
        if (!response.ok) return [];
        
        const data = await response.json();
        const country = data[0];
        
        const alternativeNames = [];
        
        // Get common name
        if (country.name?.common) {
          alternativeNames.push(country.name.common);
        }
        
        // Get official name
        if (country.name?.official) {
          alternativeNames.push(country.name.official);
        }
        
        // Get native names
        if (country.name?.nativeName) {
          Object.values(country.name.nativeName).forEach(nativeName => {
            if (nativeName.common) alternativeNames.push(nativeName.common);
            if (nativeName.official) alternativeNames.push(nativeName.official);
          });
        }
        
        // Get alternative spellings
        if (country.altSpellings) {
          alternativeNames.push(...country.altSpellings);
        }
        
        // Remove duplicates and filter out empty strings
        const uniqueNames = [...new Set(alternativeNames)]
          .filter(name => name && name.length > 0)
          .slice(0, 5); // Limit to 5 attempts to avoid API spam
        
        console.log(`📋 ALTERNATIVES for ${countryCode}:`, uniqueNames);
        return uniqueNames;
        
      } catch (error) {
        console.warn(`⚠️ Could not fetch alternative names for ${countryCode}:`, error.message);
        return [];
      }
    };

    // Fetch detailed stadium data for a country
    const fetchStadiumsForCountry = async (countryCode, countryName) => {
      console.log(`🏟 DEBUG: Starting stadium fetch for ${countryName} (${countryCode})`);
      
      // Check cache first
      if (stadiumsCache[countryCode]) {
        console.log(`🏟️ CACHE HIT: Using cached stadiums for ${countryName}`);
        return stadiumsCache[countryCode];
      }

      setIsLoadingStadiums(true);
      
      try {
        // Get country's competitions
        const country = countriesDataRef.current.find(c => c.code === countryCode);
        if (!country || !country.competitions || country.competitions.length === 0) {
          console.warn(`❌ No competitions found for ${countryName}`);
          return [];
        }

        console.log(`🏆 FOUND: ${country.competitions.length} competitions for ${countryName}`);

        const stadiums = [];
        
        // Get teams from the top competition
        // ✅ FIXED CODE - Prioritize Premier League over Championship
        const premierLeague = country.competitions.find(c => 
          c.name.toLowerCase().includes('premier') || c.id === 2021
        );

        const topCompetition = premierLeague || country.competitions[0];
        console.log(`🏆 TOP COMPETITION: ${topCompetition.name} (ID: ${topCompetition.id}) ${premierLeague ? '[PREMIER LEAGUE]' : '[FALLBACK]'}`);
        
        try {
          const teamsData = await fgFootball(`competitions/${topCompetition.id}/teams`);
          
          if (teamsData && teamsData.teams && Array.isArray(teamsData.teams)) {
            console.log(`⚽ FOUND: ${teamsData.teams.length} teams in ${topCompetition.name}`);
            
            // 🔥 FIX: Proper country name for geocoding
            const geocodingCountry = countryCode === 'ENG' ? 'United Kingdom' : countryName;
            console.log(`🌍 GEOCODING COUNTRY: ${countryName} → ${geocodingCountry}`);
            
            for (const team of teamsData.teams) {
              if (team.venue) {
                try {
                  // 🔥 FIX: Add delay BEFORE each geocoding attempt
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  // 🔥 CRITICAL FIX: Extract city from address properly
                  let city = team.venue; // Default: use venue name as city
                  
                  // Try to extract city from address if it exists
                  if (team.address && team.address.trim() !== '') {
                    // Address format: "Stadium Name City Postcode"
                    // Example: "Ewood Park Blackburn BB2 4JF"
                    const addressParts = team.address.split(' ');
                    
                    // City is usually before the postcode (postcode has numbers)
                    const cityIndex = addressParts.findIndex((part, idx) => 
                      idx > 0 && /\d/.test(addressParts[idx + 1])
                    );
                    
                    if (cityIndex > 0) {
                      city = addressParts[cityIndex];
                    }
                  }
                  
                  // 🔥 CRITICAL FIX: Use VENUE (stadium name), not TEAM name
                  console.log(`🏟️ GEOCODING: ${team.venue} in ${city}, ${geocodingCountry}`);
                  
                  const coordinates = await geocodeStadium(
                    team.address,      // Full address
                    city,              // ✅ City name (extracted)
                    team.venue,        // ✅ STADIUM NAME (not team.name!)
                    geocodingCountry   // ✅ "United Kingdom"
                  );
                  
                  if (coordinates) {
                    stadiums.push({
                      id: team.id,
                      name: team.venue || `${team.name} Stadium`,
                      address: team.address || team.venue,
                      city: city,
                      capacity: 0,
                      coordinates: coordinates,
                      team: team.name,
                      teamLogo: team.crest,
                      league: topCompetition.name,
                      leagueId: topCompetition.id,
                      isTopLeague: true
                    });
                    
                    console.log(`✅ STADIUM ADDED: ${team.venue} → ${team.name} (${coordinates.lat}, ${coordinates.lng})`);
                  } else {
                    console.warn(`⚠️ No coordinates for ${team.name}: ${team.venue}`);
                  }
                } catch (error) {
                  console.warn(`⚠️ Failed to process ${team.name}:`, error.message);
                }
              }
            }
          }
        } catch (error) {
          console.warn(`⚠️ Failed to get teams for ${topCompetition.name}:`, error.message);
        }

        console.log(`🎯 RESULT: ${stadiums.length} stadiums found`);
        // Fetch league standings
        try {
          console.log('📊 Fetching league standings for competition:', topCompetition.id);
          const standingsData = await fgFootballStandings(topCompetition.id);
          setStandings(standingsData.standings);
          console.log('📊 STANDINGS:', standingsData.standings);
        } catch (error) {
          console.error('❌ Failed to fetch standings:', error);
          setStandings(null);
        }
        
        // Cache the results
        setStadiumsCache(prev => ({
          ...prev,
          [countryCode]: stadiums
        }));
        
        return stadiums;
        
      } catch (error) {
        console.error(`❌ Stadium fetch failed for ${countryName}:`, error);
        return [];
      } finally {
        setIsLoadingStadiums(false);
      }
    };

    // Load stadiums for specific league
    const fetchStadiumsForLeague = async (countryCode, leagueId, leagueName) => {
      const apiCountryName = await getCountryNameFromCode(countryCode);
      console.log(`🔍 LEAGUE API Country Name: ${countryCode} -> ${apiCountryName}`);
      console.log(`🏟️ LEAGUE-SPECIFIC: Loading stadiums for ${leagueName} (ID: ${leagueId})`);
      
      setIsLoadingStadiums(true);
      
      try {
        // Use current season consistently across all functions
        const currentSeason = new Date().getFullYear();
        const teamsResponse = await fgFootball('teams', { 
          league: leagueId, 
          season: currentSeason 
        });
        
        if (!teamsResponse.response) {
          console.warn(`❌ No teams found for league ${leagueName}`);
          return [];
        }
        
        console.log(`⚽ TEAMS: Found ${teamsResponse.response.length} teams in ${leagueName}`);
        
        const stadiums = [];
        
        // Process each team to get their stadium
        for (const teamData of teamsResponse.response.slice(0, 20)) { // Limit to prevent API overload
          const team = teamData.team;
          const venue = teamData.venue;
          
          // 🔥 DEBUG: Log all teams to see what's missing
          console.log(`👥 TEAM: ${team.name} | Venue: ${venue?.name || 'NO VENUE'} | City: ${venue?.city || 'NO CITY'}`);
          
          if (venue && venue.name && venue.city) {
            console.log(`🏟️ PROCESSING: ${venue.name} (${team.name})`);
            
            try {
              const coordinates = await geocodeStadium(venue.address, venue.city, venue.name, apiCountryName);
              
              if (coordinates) {
                stadiums.push({
                  id: venue.id,
                  name: venue.name,
                  address: venue.address || `${venue.city}`,
                  city: venue.city,
                  capacity: venue.capacity || 0,
                  coordinates: coordinates,
                  image: venue.image,
                  surface: venue.surface || 'Grass',
                  team: team.name,
                  teamLogo: team.logo,
                  league: leagueName,
                  leagueId: leagueId
                });
                
                console.log(`✅ STADIUM ADDED: ${venue.name} -> ${team.name}`);
              }
            } catch (error) {
              console.warn(`⚠️ Failed to process ${venue.name}:`, error.message);
            }
          } else {
            // 🔥 API-DRIVEN FALLBACK: Use team name as location (no hardcoding)
            console.log(`🔄 FALLBACK: Creating stadium for ${team.name} using team name as location`);
            
            try {
              // Extract base location from team name (remove " W" suffix for women's teams)
              const teamBaseName = team.name.replace(/ W$/, '').replace(/ Women$/, '');
              const searchLocation = `${teamBaseName}, ${team.country}`;
              const fallbackStadiumName = `${teamBaseName} Stadium`;
              
              console.log(`📍 GEOCODING: ${searchLocation}`);
              
              // Use team name + country for geocoding
              const coordinates = await geocodeStadium(null, searchLocation, fallbackStadiumName, apiCountryName);
              
              if (coordinates) {
                stadiums.push({
                  id: `fallback_${team.id}`,
                  name: fallbackStadiumName,
                  address: searchLocation,
                  city: teamBaseName,
                  capacity: 0,
                  coordinates: coordinates,
                  image: null,
                  surface: 'Grass',
                  team: team.name,
                  teamLogo: team.logo,
                  league: leagueName,
                  leagueId: leagueId,
                  isFallback: true
                });
                
                console.log(`✅ FALLBACK STADIUM ADDED: ${fallbackStadiumName} -> ${team.name}`);
              } else {
                console.log(`⚠️ Could not geocode fallback for ${team.name}`);
              }
            } catch (error) {
              console.warn(`⚠️ Fallback failed for ${team.name}:`, error.message);
            }
          }
        }
        
        console.log(`🎯 LEAGUE RESULT: ${stadiums.length} stadiums loaded for ${leagueName}`);
        return stadiums;
        
      } catch (error) {
        console.error(`❌ League stadium fetch failed:`, error);
        return [];
      } finally {
        setIsLoadingStadiums(false);
      }
    };

    // API-DRIVEN: Automatically rank leagues by importance (NO HARDCODING)
    const rankLeaguesByImportance = (leagues) => {
      return leagues.map(league => {
        let importanceScore = 0;
        const currentSeason = league.seasons?.find(s => s.current) || league.seasons?.[0];
        
        // 🔥 PRIMARY FACTOR: Coverage depth (most reliable indicator)
        if (currentSeason?.coverage?.fixtures) {
          const coverage = currentSeason.coverage.fixtures;
          const coverageCount = Object.values(coverage).filter(v => v === true).length;
          importanceScore += coverageCount * 50; // 0-200 points based on API coverage
          
          console.log(`📊 COVERAGE: ${league.league.name} = ${coverageCount}/4 coverage (${coverageCount * 50} points)`);
        }
        
        // 🔥 SECONDARY FACTOR: League ID (lower = more established)
        if (league.league.id < 200) {
          importanceScore += 100; // Very low ID = likely top tier
        } else if (league.league.id < 500) {
          importanceScore += 50;  // Medium ID = likely secondary
        } else {
          importanceScore += 10;  // High ID = likely lower tier
        }
        
        // 🔥 TERTIARY FACTORS: Basic API properties
        if (league.league.type === 'League') importanceScore += 30;
        if (league.league.type === 'Cup') importanceScore += 15;
        if (currentSeason?.current) importanceScore += 20;
        
        // 🔥 WOMEN'S LEAGUE BOOST: If coverage is full, boost women's leagues
        const isWomensLeague = league.league.name.toLowerCase().includes('women') || 
                              league.league.name.toLowerCase().includes('toppserien') ||
                              league.league.name.toLowerCase().includes('female');
        
        if (isWomensLeague && currentSeason?.coverage?.fixtures) {
          const coverageCount = Object.values(currentSeason.coverage.fixtures).filter(v => v === true).length;
          if (coverageCount >= 3) { // High coverage women's league
            importanceScore += 80; // Boost to compete with men's top leagues
          }
        }
        
        console.log(`🎯 FINAL SCORE: ${league.league.name} = ${importanceScore} points`);
        
        return {
          ...league,
          importanceScore
        };
      }).sort((a, b) => b.importanceScore - a.importanceScore);
    };

    // Enhanced geocoding with country context and multiple fallback strategies:
    const geocodeStadium = async (address, city, stadiumName, countryName) => {
      try {
        // Strategy 1: Full address if available
        if (address && address !== 'null' && address !== '') {
          const fullQuery = `${stadiumName}, ${address}, ${city}, ${countryName}`;
          console.log(`🔍 GEOCODING STRATEGY 1: "${fullQuery}"`);
          
          const data = await fgForwardGeocode(fullQuery);
          
          // 🔥 DEBUG: Log what Google actually returns
          console.log(`📡 GOOGLE RESPONSE (Strategy 1):`, {
            status: data?.status,
            resultsCount: data?.results?.length || 0,
            error: data?.error_message
          });
          
          if (data && data.status === 'OK' && data.results && data.results[0]) {
            const location = data.results[0].geometry.location;
            console.log(`✅ STRATEGY 1 SUCCESS: ${stadiumName} → ${location.lat}, ${location.lng}`);
            return { lat: location.lat, lng: location.lng };
          }
        }
        
        // Strategy 2: Stadium + City + Country
        const cityQuery = `${stadiumName}, ${city}, ${countryName}`;
        console.log(`🔍 GEOCODING STRATEGY 2: "${cityQuery}"`);
        
        const data2 = await fgForwardGeocode(cityQuery);
        
        // 🔥 DEBUG: Log what Google returns
        console.log(`📡 GOOGLE RESPONSE (Strategy 2):`, {
          status: data2?.status,
          resultsCount: data2?.results?.length || 0,
          error: data2?.error_message
        });
        
        if (data2 && data2.status === 'OK' && data2.results && data2.results[0]) {
          const location = data2.results[0].geometry.location;
          console.log(`✅ STRATEGY 2 SUCCESS: ${stadiumName} → ${location.lat}, ${location.lng}`);
          return { lat: location.lat, lng: location.lng };
        }
        
        // Strategy 3: Just city center as fallback
        const cityOnly = `${city}, ${countryName}`;
        console.log(`🔍 GEOCODING STRATEGY 3 (City Center): "${cityOnly}"`);
        
        const data3 = await fgForwardGeocode(cityOnly);
        
        // 🔥 DEBUG: Log what Google returns
        console.log(`📡 GOOGLE RESPONSE (Strategy 3):`, {
          status: data3?.status,
          resultsCount: data3?.results?.length || 0,
          error: data3?.error_message
        });
        
        if (data3 && data3.status === 'OK' && data3.results && data3.results[0]) {
          const location = data3.results[0].geometry.location;
          console.log(`✅ STRATEGY 3 SUCCESS (City Center): ${city} → ${location.lat}, ${location.lng}`);
          return { lat: location.lat, lng: location.lng };
        }
        
        console.warn(`❌ ALL GEOCODING STRATEGIES FAILED for ${stadiumName}`);
        return null;
        
      } catch (error) {
        if (error.message.includes('Rate limit')) {
          console.warn(`⚠️ GEOCODING RATE LIMITED: ${stadiumName}`);
          return null;
        }
        console.warn(`Geocoding failed for ${stadiumName}:`, error);
        return null;
      }
    };

    // TRANSLATION TABLE BUILDER - API-driven country name mapping
    const buildCountryTranslationTable = async () => {
      console.log('🔄 BUILDING: Dynamic country translation table from APIs...');
      
      try {
        // Get all countries from Football API
        const footballData = await fgFootball('countries');
        
        if (!footballData.response) {
          console.error('❌ Failed to get Football API countries');
          return {};
        }
        
        console.log(`📊 Football API countries: ${footballData.response.length}`);
        
        // Get Google/REST Countries data (we already have some from our existing countries)
        const translationTable = {};
        const unmatchedCountries = [];
        
        // Try to match each of our loaded countries with Football API
        for (const ourCountry of countriesDataRef.current) {
          console.log(`🔍 PROCESSING: ${ourCountry.code} (${ourCountry.name})`);
          
          const footballMatch = footballData.response.find(fc => {
            const basicMatch = fc.code === ourCountry.code ||
                              fc.name?.toLowerCase() === ourCountry.name?.toLowerCase() ||
                              fc.code === ourCountry.name ||
                              isNameSimilar(fc.name, ourCountry.name);
            
            const specialMatch = (ourCountry.code === 'GB' && fc.code === 'GB-ENG');
            
            if (specialMatch) {
              console.log(`🎯 SPECIAL MATCH: ${ourCountry.code} -> ${fc.code} (${fc.name})`);
            }
            
            return basicMatch || specialMatch;
          });
          
          if (footballMatch) {
            translationTable[ourCountry.code] = footballMatch.name;
            console.log(`✅ MATCH: ${ourCountry.code} (${ourCountry.name}) -> ${footballMatch.name}`);
          } else {
            unmatchedCountries.push(ourCountry);
            console.log(`❌ NO MATCH: ${ourCountry.code} (${ourCountry.name})`);
            
            // Special debug for GB
            if (ourCountry.code === 'GB') {
              console.log('🔍 GB DEBUG: Looking for GB-ENG in API...');
              const gbEng = footballData.response.find(fc => fc.code === 'GB-ENG');
              if (gbEng) {
                console.log(`🎯 FOUND GB-ENG: ${gbEng.code} -> ${gbEng.name}`);
                translationTable[ourCountry.code] = gbEng.name;
                console.log(`🔧 FORCED GB MAPPING: ${ourCountry.code} -> ${gbEng.name}`);
              } else {
                console.log('❌ GB-ENG not found in API');
              }
            }
          }
        }
        
        // Store the table globally
        window.countryTranslationTable = translationTable;
        
        console.log('📋 TRANSLATION TABLE COMPLETE:');
        console.log(`   ✅ Matched: ${Object.keys(translationTable).length}`);
        console.log(`   ❌ Unmatched: ${unmatchedCountries.length}`);
        console.log('📖 Translation table:', translationTable);
        
        if (unmatchedCountries.length > 0) {
          console.log('⚠️ UNMATCHED COUNTRIES:', unmatchedCountries.map(c => `${c.code}:${c.name}`));
        }
        
        return translationTable;
        
      } catch (error) {
        console.error('❌ Translation table build failed:', error);
        return {};
      }
    };

    // Helper function for name similarity
    const isNameSimilar = (name1, name2) => {
      if (!name1 || !name2) return false;
      
      const normalize = str => str.toLowerCase().replace(/[^a-z]/g, '');
      const n1 = normalize(name1);
      const n2 = normalize(name2);
      
      return n1 === n2 || 
            n1.includes(n2) || 
            n2.includes(n1) ||
            // Special cases
            (n1.includes('kingdom') && n2.includes('england')) ||
            (n1.includes('states') && n2.includes('usa'));
    };

    
  // Fallback countries (minimal set for demo if API fails)
  const loadFallbackCountries = () => {
    console.log('🔄 Loading fallback countries...');
    setCountriesData([
      {
        id: 'demo',
        name: 'Demo Mode - API Key Required',
        center: { lat: 0, lng: 0 },
        stadiums: 0,
        topLeagues: ['Please add API keys'],
        continent: 'Demo'
      }
    ]);
  };

  // Get map styles based on zoom level
  const getMapStylesForZoom = (zoomLevel) => {
    if (zoomLevel <= 4) {
      // WORLD VIEW: Your clean, minimal style
      return [
        // Remove all labels and clutter
        {
          "featureType": "all",
          "elementType": "labels",
          "stylers": [{"visibility": "off"}]
        },
        // Clean water
        {
          "featureType": "water",
          "elementType": "geometry",
          "stylers": [{"color": "#a2daf2"}]
        },
        // Clean land
        {
          "featureType": "landscape",
          "elementType": "geometry",
          "stylers": [{"color": "#f5f5f2"}, {"lightness": 20}]
        },
        // Subtle country borders only
        {
          "featureType": "administrative.country",
          "elementType": "geometry.stroke",
          "stylers": [{"color": "#c9b2a6"}, {"weight": 1}]
        },
        // Hide roads completely
        {
          "featureType": "road",
          "stylers": [{"visibility": "off"}]
        },
        // Hide points of interest
        {
          "featureType": "poi",
          "stylers": [{"visibility": "off"}]
        },
        // Hide transit
        {
          "featureType": "transit",
          "stylers": [{"visibility": "off"}]
        },
        // Hide state/province borders
        {
          "featureType": "administrative.province",
          "stylers": [{"visibility": "off"}]
        },
        {
          "featureType": "administrative.locality",
          "stylers": [{"visibility": "off"}]
        },
        {
          "featureType": "administrative.neighborhood",
          "stylers": [{"visibility": "off"}]
        },
        // Remove internal borders within countries
        {
          "featureType": "administrative.land_parcel",
          "stylers": [{"visibility": "off"}]
        }
      ];
    } else {
      // COUNTRY ZOOM VIEW: Detailed with cities, terrain, roads
      return [
        // Beautiful water styling
        {
          "featureType": "water",
          "elementType": "geometry",
          "stylers": [
            {"color": "#4a90e2"},
            {"lightness": 10}
          ]
        },
        // Natural landscape with terrain visibility
        {
          "featureType": "landscape",
          "elementType": "geometry",
          "stylers": [
            {"color": "#f0f8e8"},
            {"lightness": 15}
          ]
        },
        // Show parks and green areas
        {
          "featureType": "poi.park",
          "elementType": "geometry",
          "stylers": [
            {"color": "#7cb342"},
            {"lightness": 30},
            {"visibility": "on"}
          ]
        },
        // Country borders (stronger when zoomed)
        {
          "featureType": "administrative.country",
          "elementType": "geometry.stroke",
          "stylers": [
            {"color": "#2d5aa0"},
            {"weight": 2}
          ]
        },
        // Show major roads
        {
          "featureType": "road.highway",
          "elementType": "geometry",
          "stylers": [
            {"visibility": "simplified"},
            {"color": "#ffc107"},
            {"weight": 2}
          ]
        },
        // Show arterial roads
        {
          "featureType": "road.arterial",
          "elementType": "geometry",
          "stylers": [
            {"visibility": "simplified"},
            {"color": "#ffffff"},
            {"weight": 1}
          ]
        },
        // CITY LABELS - Fixed feature type
        {
          "featureType": "administrative.locality",
          "elementType": "labels.text.fill",
          "stylers": [
            {"visibility": "on"},
            {"color": "#2c3e50"},
          ]
        },
        {
          "featureType": "administrative.locality",
          "elementType": "labels.text.stroke", 
          "stylers": [
            {"visibility": "on"},
            {"color": "#ffffff"},
            {"weight": 2}
          ]
        },
        // Administrative labels for important cities
        {
          "featureType": "administrative.locality",
          "elementType": "labels.text.fill",
          "stylers": [
            {"visibility": "on"},
            {"color": "#34495e"}
          ]
        },
        // Hide minor POIs but keep important ones
        {
          "featureType": "poi.business",
          "stylers": [{"visibility": "off"}]
        },
        {
          "featureType": "poi.medical",
          "stylers": [{"visibility": "simplified"}]
        },
        {
          "featureType": "poi.school",
          "stylers": [{"visibility": "simplified"}]
        }
      ];
    }
  };

  // GLOBAL FUNCTION: Handle popup button clicks
  window.clickCountryFromPopup = async (countryName) => {
    console.log(`🎯 CLICKED: ${countryName} - Using cache!`);
    setIsLoading(true);
    setSelectedCountry(countryName);
    
    // Translate country name to code (e.g., "England" -> "ENG")
    const selectedCountryCode = translateCountryNameToCode(countryName);
    const selectedCountryName = countryName;
    
    if (!selectedCountryCode) {
      console.error('❌ Could not find country code for:', countryName);
      setIsLoading(false);
      return;
    }
    
    console.log(`🔍 Looking up: "${selectedCountryCode}" → "${selectedCountryName}"`);
    
        
    // Get ALL stadiums for this country from cache
    const allStadiumsForCountry = getStadiumsFromCache(selectedCountryCode);
    
    // Get country data to find top league
    // IMPORTANT: Convert code to name (ENG → England) because cache uses full names
    const countryNameForLookup = COUNTRY_CODE_TO_NAME[selectedCountryCode] || selectedCountryName;
    const countryData = cachedStadiums?.countries?.[countryNameForLookup];
    const topLeague = countryData?.leagues?.[0]; // First league = top priority (Premier League, Bundesliga, etc)
    
    // Filter to TOP LEAGUE ONLY
    const cachedStadiumsForCountry = topLeague 
      ? allStadiumsForCountry.filter(stadium => stadium.leagueId === topLeague.id)
      : allStadiumsForCountry;
    
    console.log(`⚡ Loaded ${cachedStadiumsForCountry.length} stadiums for ${selectedCountryName} from cache`);
    console.log(`🏆 Showing: ${topLeague?.name || 'All leagues'} (filtered from ${allStadiumsForCountry.length} total)`);

    // Transform cached data to match your existing format
    const stadiumsWithCoords = cachedStadiumsForCountry
      .map(stadium => {
        
        
        // Extract coordinates (handle both formats)
        const lat = stadium.latitude || stadium.lat;
        const lng = stadium.longitude || stadium.lng;
        
        // Skip if no coordinates
        if (!lat || !lng) {
          console.warn(`⚠️ No coordinates for ${stadium.venue || stadium.name}`);
          return null;
        }
        
        return {
          name: stadium.venue || stadium.name,
          team: stadium.teamName || stadium.team,
          lat: parseFloat(lat),
          lng: parseFloat(lng),
          coordinates: { lat: parseFloat(lat), lng: parseFloat(lng) },
          address: stadium.address || stadium.fullAddress || '',
          capacity: stadium.capacity || 0,
          leagueName: stadium.leagueName,
          leagueId: stadium.leagueId,
          id: stadium.teamId || stadium.id,
          crestUrl: stadium.crestUrl,
          clubColors: stadium.clubColors,
          founded: stadium.founded
        };
      })
      .filter(stadium => stadium !== null); // Remove null entries

    

    // Clear ALL stadium markers (unified system)
    clearAllStadiumMarkers();

    // Initialize marker array BEFORE creating markers
    if (!window.currentStadiumMarkers) {
      window.currentStadiumMarkers = [];
    }

    // Create new markers directly
      stadiumsWithCoords.forEach((stadium, index) => {
        // Validate coordinates exist
        if (!stadium.lat || !stadium.lng) {
          console.warn(`⚠️ Stadium "${stadium.name}" missing coordinates`);
          return;
        }

        // 🔥 CRITICAL: Validate coordinate ranges for Portugal
        // 🔥 CRITICAL: Validate coordinate ranges for Portugal (including Azores & Madeira)
        if (selectedCountryCode === 'POR') {
          // Mainland Portugal: 36-43°N, 10-6°W
          // Madeira: 32-33°N, 16-17°W
          // Azores: 37-40°N, 25-31°W
          const validLat = stadium.lat >= 32 && stadium.lat <= 43;    // Include all Portuguese territories
          const validLng = stadium.lng >= -31 && stadium.lng <= -6;   // Include Azores and Madeira
          
          if (!validLat || !validLng) {
            console.error(`❌ INVALID COORDS for ${stadium.name}:`, {
              lat: stadium.lat,
              lng: stadium.lng,
              expected: 'lat: 36-43, lng: -10 to -6'
            });
            return; // Skip this marker
          }
        }

        
      const marker = new window.google.maps.Marker({
        position: { lat: stadium.lat, lng: stadium.lng },
        map: googleMapRef.current,
        title: `${stadium.name} - ${stadium.team}`,
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
            <svg width="36" height="48" viewBox="0 0 36 48" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
                  <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              </defs>
              
              <!-- Outer glow -->
              <circle cx="18" cy="16" r="14" fill="#22c55e" opacity="0.3" filter="url(#glow)"/>
              
              <!-- Main pin shape -->
              <path d="M 18 2 C 10.268 2 4 8.268 4 16 C 4 24 18 44 18 44 C 18 44 32 24 32 16 C 32 8.268 25.732 2 18 2 Z" 
                    fill="url(#gradient)" 
                    stroke="#ffffff" 
                    stroke-width="2.5"
                    filter="url(#glow)"/>
              
              <!-- Gradient definition -->
              <defs>
                <linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" style="stop-color:#22c55e;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:#16a34a;stop-opacity:1" />
                </linearGradient>
              </defs>
              
              <!-- Inner stadium icon -->
              <g transform="translate(18, 16)">
                <!-- Stadium structure -->
                <ellipse cx="0" cy="0" rx="7" ry="5" fill="#ffffff" opacity="0.9"/>
                <ellipse cx="0" cy="0" rx="5" ry="3" fill="#22c55e"/>
                
                <!-- Field lines -->
                <line x1="-5" y1="0" x2="5" y2="0" stroke="#ffffff" stroke-width="0.5"/>
                <circle cx="0" cy="0" r="1.5" fill="none" stroke="#ffffff" stroke-width="0.5"/>
              </g>
            </svg>
          `),
          scaledSize: new window.google.maps.Size(36, 48),
          anchor: new window.google.maps.Point(18, 44)
        },
        animation: window.google.maps.Animation.DROP
      });

      // Add click listener to show info
      marker.addListener('click', () => {
        const infoWindow = new window.google.maps.InfoWindow({
          content: createProfessionalStadiumPopup(stadium),
          maxWidth: 350
        });
        
        // Close other info windows
        if (window.currentStadiumInfoWindow) {
          window.currentStadiumInfoWindow.close();
        }
        
        infoWindow.open(googleMapRef.current, marker);
        window.currentStadiumInfoWindow = infoWindow;
      });

      // Push to the unified marker array
      window.currentStadiumMarkers.push(marker);
    });

    console.log(`✅ Created ${window.currentStadiumMarkers.length} stadium markers!`);

    // Update sidebar with stadium count
    setStadiumPins(stadiumsWithCoords);
    console.log(`📊 Updated sidebar: ${stadiumsWithCoords.length} stadiums`);

    // Get standings from cache (use transformed data which has leagueId)
    if (stadiumsWithCoords.length > 0 && stadiumsWithCoords[0].leagueId) {
      const leagueId = stadiumsWithCoords[0].leagueId;
      const leagueStandings = getStandingsFromCache(leagueId);
      
      if (leagueStandings) {
        // Extract the correct nested structure for your UI
        const standingsData = {
          competition: leagueStandings.competition,
          standings: leagueStandings.standings
        };
        
        setStandings([standingsData]); // Your UI expects array
        setSelectedLeague(topLeague ? topLeague.id.toString() : null);
        
        console.log(`⚡ STANDINGS: Loaded ${leagueStandings.standings.table.length} teams for ${leagueStandings.competition.name}`);
        console.log('📊 First team:', leagueStandings.standings.table[0].team.name, '-', leagueStandings.standings.table[0].points, 'pts');
      } else {
        console.warn(`⚠️ No standings found for league ${leagueId}`);
        setStandings(null);
      }
      
      // Update available leagues list - show leagues from this country
      if (countryData && countryData.leagues) {
        const countryLeagues = countryData.leagues.map(league => ({
          id: league.id,
          name: league.name,
          country: selectedCountryCode
        }));
        
        setAvailableLeagues(countryLeagues);
        console.log(`🏆 Available leagues for ${selectedCountryName}: ${countryLeagues.length}`);
      }
    } else {
      console.warn('⚠️ No leagueId found in stadium data');
    }
    
    // Auto-zoom to fit all stadiums
    console.log('🔍 ZOOM CHECK:', {
      hasArray: !!window.currentStadiumMarkers,
      length: window.currentStadiumMarkers?.length,
      hasMap: !!googleMapRef.current
    });

    if (window.currentStadiumMarkers && 
        Array.isArray(window.currentStadiumMarkers) && 
        window.currentStadiumMarkers.length > 0 && 
        googleMapRef.current) {
      
      try {
        const bounds = new window.google.maps.LatLngBounds();
        
        window.currentStadiumMarkers.forEach(marker => {
          if (marker && marker.getPosition) {
            bounds.extend(marker.getPosition());
          }
        });
        
        googleMapRef.current.fitBounds(bounds);
        
        // Add slight padding after fitBounds completes
        setTimeout(() => {
          const currentZoom = googleMapRef.current.getZoom();
          if (currentZoom > 7) {
            googleMapRef.current.setZoom(7); // Max zoom for country view
          }
        }, 300);
        
        console.log(`🗺️ Zoomed to fit ${window.currentStadiumMarkers.length} stadiums`);
      } catch (error) {
        console.error('❌ ZOOM ERROR:', error);
      }
    }

    setIsLoading(false);
    console.log(`✅ COMPLETE: ${selectedCountryCode} loaded in <1 second!`);
  };
  const initializeMap = () => {
    (async () => {
      if (!window.google || !mapRef.current) return;
      console.log('🚀 Creating Google Maps instance...');
      console.log('🔍 mapRef.current:', mapRef.current);
      console.log('🔍 mapRef.current.innerHTML:', mapRef.current.innerHTML);
      console.log('🔍 mapRef.current.children.length:', mapRef.current.children.length);
      console.log('🔍 window.google.maps:', typeof window.google.maps);

    
    
      // Clear any existing map content
      mapRef.current.innerHTML = '';

      // Prefer legacy constructor if present
      let MapCtor = window.google?.maps?.Map;

if (typeof MapCtor !== 'function') {
  if (window.google?.maps?.importLibrary) {
    const mapsModule = await window.google.maps.importLibrary('maps'); // { Map, ... }
    MapCtor = mapsModule && mapsModule.Map;
  }
}

if (typeof MapCtor !== 'function') {
  console.error('Google Maps Map constructor unavailable. google.maps =', window.google?.maps);
  return; // stop; prevents "is not a constructor"
}

const map = new MapCtor(mapRef.current, {
  // keep your existing options (center, zoom, mapId, etc.)



        zoom: 2,
        center: { lat: 20, lng: 0 },
        mapTypeId: 'roadmap',
        styles: getMapStylesForZoom(2),
        disableDefaultUI: true,  // CHANGED: Hide all default UI
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        clickableIcons: false,
        keyboardShortcuts: false  // ADD: Disable keyboard shortcuts UI
      });

      // Enhanced zoom change listener with smart state management
      map.addListener('zoom_changed', () => {
        const currentZoom = map.getZoom();
        setZoomLevel(currentZoom);
        
        // Smart mode detection based on zoom
        let newMode = 'world';
        if (currentZoom >= 8) {
          newMode = 'stadium';
        } else if (currentZoom >= 5) {
          newMode = 'country';
        }
        
        if (newMode !== appMode) {
          setAppMode(newMode);
          console.log(`🎯 MODE CHANGE: ${appMode} → ${newMode} (zoom: ${currentZoom})`);
        }
        
        // Enhanced map options for stadium viewing
        const mapOptions = {
          styles: getMapStylesForZoom(currentZoom)
        };
        
        // Enable 3D buildings and satellite view when close to stadiums
        if (currentZoom >= 15) {
          mapOptions.mapTypeId = 'hybrid';
          mapOptions.tilt = 45;
        } else if (currentZoom >= 10) {
          mapOptions.mapTypeId = 'roadmap';
          mapOptions.tilt = 0;
        }
        
        map.setOptions(mapOptions);
      });

    // Enable mousemove events explicitly
    map.setOptions({ 
      disableDoubleClickZoom: false,
      draggable: true,
      scrollwheel: true,
      disableDefaultUI: false
    });

    // Enable data layer for country highlighting
    map.data.setStyle({
      fillOpacity: 0,
      strokeOpacity: 0,
      clickable: false
    });
    
    // Force Google Maps to initialize mousemove events
    window.google.maps.event.trigger(map, 'resize');
    
    // Add a small delay before setting up hover effects
    setTimeout(() => {
      setupCountryHoverEffects(map);
    }, 100);

   googleMapRef.current = map;

    // DEBUG: Add comprehensive Google attribution debugging
    const debugGoogleAttribution = () => {
      console.log('🔍 DEBUG: Checking Google attribution elements...');
      
      // Check in map container
      const mapContainer = mapRef.current;
      console.log('📦 Map container:', mapContainer);
      
      // Check for Google elements with multiple selectors
      const selectors = [
        'a[href*="maps.google.com"]',
        '.gm-style-cc',
        '.gmnoprint',
        '[title="Google"]',
        'img[alt="Google"]'
      ];
      
      selectors.forEach(selector => {
        const elementsInMap = mapContainer?.querySelectorAll(selector);
        const elementsInDocument = document.querySelectorAll(selector);
        console.log(`🔍 ${selector}:`);
        console.log(`   In map: ${elementsInMap?.length || 0} elements`);
        console.log(`   In document: ${elementsInDocument?.length || 0} elements`);
        
        if (elementsInDocument?.length > 0) {
          elementsInDocument.forEach((el, index) => {
            console.log(`   Element ${index}:`, {
              display: el.style.display,
              visibility: el.style.visibility,
              opacity: el.style.opacity,
              position: el.style.position,
              bottom: el.style.bottom,
              left: el.style.left,
              zIndex: el.style.zIndex,
              innerHTML: el.innerHTML?.substring(0, 50)
            });
          });
        }
      });
      
      // Check all children in map container
      if (mapContainer) {
        console.log('📋 All children in map container:');
        const allChildren = mapContainer.querySelectorAll('*');
        console.log(`   Total children: ${allChildren.length}`);
        
        // Look for any Google-related elements
        const googleElements = Array.from(allChildren).filter(el => 
          el.innerHTML?.includes('Google') || 
          el.getAttribute('href')?.includes('google') ||
          el.className?.includes('gm-') ||
          el.getAttribute('title')?.includes('Google')
        );
        
        console.log(`   Google-related elements: ${googleElements.length}`);
        googleElements.forEach((el, index) => {
          console.log(`   Google element ${index}:`, {
            tagName: el.tagName,
            className: el.className,
            href: el.getAttribute('href'),
            title: el.getAttribute('title'),
            innerHTML: el.innerHTML?.substring(0, 100)
          });
        });
      }
    };

    // Run debug immediately
    debugGoogleAttribution();

    // Run debug after delays
    setTimeout(debugGoogleAttribution, 1000);
    setTimeout(debugGoogleAttribution, 3000);
    setTimeout(debugGoogleAttribution, 5000);


   
    setIsMapLoaded(true);

    // 🔥 NEW: Render countries on map after initialization
    if (countriesDataRef.current.length > 0) {
      console.log('🎨 Rendering countries on map...');
      renderCountriesOnMap(map, countriesDataRef.current);
    }
      })();
    };

  // Sets up country hover detection, highlighting, and info windows for the map
  const setupCountryHoverEffects = (map) => {
    let hoverTimeout = null;
    let currentInfoWindow = null;
    let currentPolygon = null;
    let isCreatingInfoWindow = false; // ADD: Global flag to prevent multiple creation
    
    // Create geocoder once and reuse
    const geocoder = new window.google.maps.Geocoder();
    
    console.log('🔧 ENHANCED: Setting up hover effects');
    console.log('📊 Countries data available:', countriesDataRef.current?.length || 0);
    console.log('📊 Sample countries:', countriesDataRef.current?.slice(0, 3)?.map(c => c.name));
    
    const closeInfoWindow = () => {
      if (currentInfoWindow && currentInfoWindow.customDiv) {
        if (currentInfoWindow.customDiv.parentNode) {
          currentInfoWindow.customDiv.parentNode.removeChild(currentInfoWindow.customDiv);
        }
        currentInfoWindow = null;
      }
      
      // Remove all custom divs as backup
      const customDivs = mapRef.current?.querySelectorAll('div[style*="position: absolute"][style*="z-index: 9999"]');
      if (customDivs) {
        customDivs.forEach(div => {
          if (div.parentNode) {
            div.parentNode.removeChild(div);
          }
        });
      }
    };
    
    // Function to highlight country
    const highlightCountry = (countryCode, countryName) => {
      console.log('🎨 Highlighting country:', countryName, countryCode);
      
      // Remove previous highlight
      if (currentPolygon) {
        currentPolygon.setMap(null);
        currentPolygon = null;
      }
      
      // Add professional delay
      setTimeout(() => {
        fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson')
          .then(response => response.json())
          .then(geoJsonData => {
            const countryFeature = geoJsonData.features.find(feature => {
              const featureCode = feature.properties.ISO_A2;
              const featureName = feature.properties.NAME_EN || feature.properties.NAME;
              
              return featureCode === countryCode || 
                    featureCode?.toLowerCase() === countryCode?.toLowerCase() ||
                    featureName?.toLowerCase() === countryName?.toLowerCase();
            });
            
            if (countryFeature) {
              console.log('✅ Found country boundaries for:', countryName);
              
              const coordinates = countryFeature.geometry.coordinates;
              
              if (countryFeature.geometry.type === 'Polygon') {
                const paths = coordinates[0].map(coord => ({
                  lat: coord[1],
                  lng: coord[0]
                }));
                
                currentPolygon = new window.google.maps.Polygon({
                  paths: paths,
                  strokeColor: '#16a34a',
                  strokeOpacity: 0.8,
                  strokeWeight: 2,
                  fillColor: '#22c55e',
                  fillOpacity: 0.15,
                  map: map,
                  zIndex: 1000,
                  clickable: false
                });
              } else if (countryFeature.geometry.type === 'MultiPolygon') {
                const allPaths = [];
                coordinates.forEach(polygon => {
                  const paths = polygon[0].map(coord => ({
                    lat: coord[1],
                    lng: coord[0]
                  }));
                  allPaths.push(paths);
                });
                
                currentPolygon = new window.google.maps.Polygon({
                  paths: allPaths,
                  strokeColor: '#16a34a',
                  strokeOpacity: 0.8,
                  strokeWeight: 2,
                  fillColor: '#22c55e',
                  fillOpacity: 0.15,
                  map: map,
                  zIndex: 1000,
                  clickable: false
                });
              }
            }
          })
          .catch(error => {
            console.log('❌ Failed to load country boundaries:', error);
          });
      }, 100);
    };
    
    const removeHighlight = () => {
      if (currentPolygon) {
        console.log('🧹 Removing country highlight');
        currentPolygon.setMap(null);
        currentPolygon = null;
      }
      map.setOptions({ draggableCursor: 'grab' });
    };
    
    // Add mousemove listener with proper event handling (only on world view)
    const mouseMoveListener = map.addListener('mousemove', (event) => {
      // Only show hover popups on world view (zoom <= 4)
      const currentZoom = map.getZoom();
      if (currentZoom > 4) {
        return; // Skip hover effects when zoomed in
      }
      // Clear existing timeout
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      
      // Set new timeout for hover action
      hoverTimeout = setTimeout(async () => {
        // Close any existing info window at start of new hover
        closeInfoWindow();
        removeHighlight();
        
        // Check if we have countries data
        const currentData = countriesDataRef.current;
        if (!currentData || currentData.length === 0) {
          console.log('⛔ HOVER BLOCKED: No countries data available');
          return;
        }
        
        console.log('🎯 HOVER ATTEMPT at:', event.latLng.toString());
        
        try {
          // Geocode the hover position
          const lat = event.latLng.lat();
          const lng = event.latLng.lng();
          const rev = await fgReverseGeocode(lat, lng);

          if (!rev) {
            // No country found - probably ocean
            return;
          }

          let detectedCountryName = rev.countryName;
          let detectedCountryCode = googleToFootballCode(rev.countryCode);
          console.log('✅ Reverse-geocode:', rev.countryName, rev.countryCode, '→', detectedCountryCode);


          if (detectedCountryName && detectedCountryCode) {
            console.log('🌍 DETECTED COUNTRY:', detectedCountryName, `(${detectedCountryCode})`);
            
            // Highlight the country
            highlightCountry(detectedCountryCode, detectedCountryName);
            
            // Match country data or fetch on-demand
            let matchingCountry = currentData.find(country => 
              country.code?.toLowerCase() === detectedCountryCode.toLowerCase()
            );
            
            // If country not in cache, fetch on-demand
            if (!matchingCountry) {
              console.log('🔄 LAZY LOAD: Fetching data on-demand for', detectedCountryName);
              const onDemandData = await fetchCountryOnDemand(detectedCountryCode, detectedCountryName);
              if (onDemandData) {
                matchingCountry = {
                  name: detectedCountryName,
                  code: detectedCountryCode,
                  flag: await getFlagFromRestCountries(detectedCountryCode),
                  ...onDemandData
                };
              }
            }
            
            // Ensure no existing windows before creating new one
            closeInfoWindow();
            
            // Prepare country info
            const countryInfo = matchingCountry || {
              name: detectedCountryName,
              code: detectedCountryCode,
              stadiums: 0,
              topLeagues: ['Data loading...'],
              continent: 'Unknown',
              flag: '🏳️'
            };
            
            // Create custom popup instead of Google Maps InfoWindow
            const mapContainer = mapRef.current;
            const bounds = googleMapRef.current.getBounds();
            const ne = bounds.getNorthEast();
            const sw = bounds.getSouthWest();
            const mapWidth = mapContainer.offsetWidth;
            const mapHeight = mapContainer.offsetHeight;

            const lat = event.latLng.lat();
            const lng = event.latLng.lng();

            // Calculate pixel position
            const x = ((lng - sw.lng()) / (ne.lng() - sw.lng())) * mapWidth;
            const y = ((ne.lat() - lat) / (ne.lat() - sw.lat())) * mapHeight;

            // Create custom popup div
            const customDiv = document.createElement('div');
            customDiv.style.position = 'absolute';
            customDiv.style.zIndex = '9999';
            customDiv.style.pointerEvents = 'none'; // CHANGED: Allow clicks to pass through

            // Smart positioning to avoid blocking the country - Enhanced
            const countryBuffer = 80; // Larger buffer zone
            let left, top;

            // More aggressive positioning away from country center

            if (x < mapWidth / 3) {
              // If hovering left third, put popup on right
              left = x + countryBuffer;
            } else if (x > (mapWidth * 2) / 3) {
              // If hovering right third, put popup on left
              left = x - 200 - countryBuffer;
            } else {
              // If hovering center, put popup at edge
              left = x + countryBuffer;
              if (left + 200 > mapWidth) {
                left = x - 200 - countryBuffer;
              }
            }

            // Vertical positioning - always try to avoid center
            if (y < mapHeight / 2) {
              // If top half, put popup below
              top = y + countryBuffer;
            } else {
              // If bottom half, put popup above
              top = y - 120 - countryBuffer;
            }

            // Ensure popup stays within bounds
            left = Math.max(10, Math.min(left, mapWidth - 250));
            top = Math.max(10, Math.min(top, mapHeight - 170));

            // Apply the calculated position to the popup div
            customDiv.style.left = `${left}px`;
            customDiv.style.top = `${top}px`;
            customDiv.innerHTML = createHoverInfoContent(countryInfo);

            mapContainer.appendChild(customDiv);

            customDiv.style.left = `${left}px`;
            customDiv.style.top = `${top}px`;
            customDiv.style.transform = 'translateX(-50%)';

            customDiv.innerHTML = createHoverInfoContent(countryInfo);

            mapContainer.appendChild(customDiv);

            // Store reference for cleanup
            currentInfoWindow = { customDiv: customDiv, close: () => {} };

            // FASTER AUTO-HIDE: Remove popup after 1.2 seconds to prevent blocking
            setTimeout(() => {
              if (currentInfoWindow && currentInfoWindow.customDiv === customDiv) {
                closeInfoWindow();
                removeHighlight();
              }
            }, 1200); // Faster auto-hide

            // IMMEDIATE HIDE on mouse movement - more responsive
            let hideOnMoveListener = null;
            const hideOnMove = () => {
              if (currentInfoWindow && currentInfoWindow.customDiv === customDiv) {
                closeInfoWindow();
                removeHighlight();
                if (hideOnMoveListener) {
                  window.google.maps.event.removeListener(hideOnMoveListener); // ✅ CORRECT: Google Maps method
                  hideOnMoveListener = null;
                }
              }
            };
            setTimeout(() => {
              hideOnMoveListener = map.addListener('mousemove', hideOnMove); // ✅ CORRECT: Google Maps method
            }, 1500);

            map.setOptions({ draggableCursor: 'pointer' });
          } else {
            console.log('⛔ No country detected');
            removeHighlight();
          }
        } catch (error) {
          console.log('⛔ Hover geocoding failed:', error);
          removeHighlight();
        }
      }, 300);
    });
    
    console.log('✅ Mousemove listener attached:', mouseMoveListener);
    
    console.log('✅ Mousemove listener attached:', mouseMoveListener);
  
    // Add zoom listener to clean up hover effects when zooming in
    map.addListener('zoom_changed', () => {
      const currentZoom = map.getZoom();
      if (currentZoom > 4) {
        // Clean up hover effects when zoomed in
        closeInfoWindow();
        removeHighlight();
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          hoverTimeout = null;
        }
      }
    });

    // Enhanced click handler for country selection and stadium loading
    map.addListener('click', async (event) => {
      console.log('🗺️ Map clicked, processing...');

      // CHECK: Ignore clicks on stadium markers or UI elements
      if (event.domEvent && event.domEvent.target) {
        const target = event.domEvent.target;
        // Skip if clicking on stadium markers, controls, or UI elements
        if (target.closest('.gm-style') || 
            target.closest('[role="button"]') || 
            target.closest('.gm-control-active')) {
          console.log('🚫 CLICK IGNORED: UI element clicked');
          return;
        }
      }
      
      // Only reset on intentional country changes, not accidental clicks
      if (selectedCountry) {
        console.log('🚫 CLICK IGNORED: Country already selected, use reset button');
        return;
      }

      // DEBOUNCE: Prevent duplicate clicks
      if (window.clickProcessing) {
        console.log('🔄 Click already processing, ignoring duplicate');
        return;
      }
      window.clickProcessing = true;

      // Clear flag after processing
      setTimeout(() => {
        window.clickProcessing = false;
      }, 2000);

    // EMERGENCY: Force clear all popups immediately on any click
    const emergencyCloseAll = () => {
      const allCustomDivs = document.querySelectorAll('div[style*="position: absolute"][style*="z-index: 9999"]');
      allCustomDivs.forEach(div => {
        if (div.parentNode) {
          div.parentNode.removeChild(div);
        }
      });
    };

    emergencyCloseAll();
      
      // PRIORITY: Always close hover elements first
      closeInfoWindow();
      removeHighlight();
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      
      // Small delay to ensure hover elements are cleared
      await new Promise(resolve => setTimeout(resolve, 50));

      // Check if we clicked on a country
      try {
        // inside your mousemove or click handler that receives (event)
        const lat = event.latLng.lat();
        const lng = event.latLng.lng();

        const rev = await fgReverseGeocode(lat, lng);

        if (!rev) {
          console.log('ℹ️ No country clicked');
          return;
        }

        let detectedCountryName = rev.countryName;
        let detectedCountryCode = googleToFootballCode(rev.countryCode);
        console.log('Reverse-geocode:', rev.countryName, rev.countryCode, '→', detectedCountryCode);


        if (detectedCountryName && detectedCountryCode) {
          console.log(`🎯 COUNTRY SELECTED: ${detectedCountryName}`);
          
          // Find country data
          let countryData = countriesDataRef.current.find(country => 
            country.code?.toLowerCase() === detectedCountryCode.toLowerCase()
          );

          // 🔥 NEW: If country not in priority list, fetch data on-demand
          if (!countryData) {
            console.log(`🔄 LAZY COUNTRY: ${detectedCountryName} not in priority list, fetching on-demand...`);
            const onDemandData = await fetchCountryOnDemand(detectedCountryCode, detectedCountryName);
            
            if (onDemandData) {
              countryData = {
                name: detectedCountryName,
                code: detectedCountryCode,
                center: { lat: event.latLng.lat(), lng: event.latLng.lng() },
                ...onDemandData // Contains stadiums, topLeagues, area, etc.
              };
            }
          }

          if (countryData) {
            setSelectedCountry(countryData);
            
            // Simple zoom to country
            map.panTo(countryData.center || { lat: event.latLng.lat(), lng: event.latLng.lng() });

            const countryPolys = (window.countryPolygons || []).filter(p => p.countryData?.code === countryData.code);
            if (countryPolys.length > 0) {
              const bounds = new window.google.maps.LatLngBounds();
              countryPolys.forEach(p => p.getPath().forEach(pt => bounds.extend(pt)));
              map.fitBounds(bounds);
            }

            
            // Load and display stadium pins - Enhanced with better error handling
            console.log(`🏟️ Starting stadium loading for ${countryData.name} (${detectedCountryCode})`);
            console.log(`🏟️ CALLING fetchStadiumsForCountry(${detectedCountryCode}, ${detectedCountryName})`);

            try {
              // Add loading state
              setIsLoadingStadiums(true);
              
              const stadiums = await fetchStadiumsForCountry(detectedCountryCode, detectedCountryName);
              console.log(`🏟️ STADIUM RESULT: ${stadiums?.length || 0} stadiums returned`);
              console.log(`🏟️ Received ${stadiums.length} stadiums for ${detectedCountryName}`);

              if (stadiums && stadiums.length > 0) {
                console.log(`🏟️ PROCESSING: ${stadiums.length} stadiums for display`);
                
                // Update country data with DISPLAYED stadium count
                const displayedCount = stadiums.length;
                const updatedCountryData = {
                  ...countryData,
                  stadiums: displayedCount,
                  realStadiumCount: displayedCount,
                  currentView: 'all-leagues'
                };
                setSelectedCountry(updatedCountryData);
                
                console.log(`📊 STADIUM COUNT SYNC: ${displayedCount} stadiums loaded and displayed`);

                // Load standings for the top competition
                if (updatedCountryData.topCompetition?.id) {
                  console.log('📊 Loading standings for:', updatedCountryData.topCompetition.name);
                  try {
                    const standingsData = await fgFootballStandings(updatedCountryData.topCompetition.id);
                    setStandings(standingsData.standings);
                    console.log('✅ Standings loaded:', standingsData.standings?.length);
                  } catch (error) {
                    console.error('❌ Failed to load standings:', error);
                    setStandings(null);
                  }
                }
                
                displayStadiumPins(stadiums, map);
                setStadiumPins(stadiums);
                console.log(`✅ STADIUM PINS: ${stadiums.length} pins displayed for ${detectedCountryName}`);
              } else {
                console.log(`❌ NO STADIUMS: Zero stadiums to display for ${detectedCountryName}`);
                console.log(`❌ STADIUM DATA:`, stadiums);
                console.warn(`⚠️ NO STADIUMS: Zero stadiums returned for ${detectedCountryName} (${detectedCountryCode})`);
                
                // API-DRIVEN RETRY: Get alternative country names from REST Countries API
                const alternativeNames = await getCountryAlternativeNames(detectedCountryCode);
                
                for (const altName of alternativeNames) {
                  console.log(`🔄 RETRY: Attempting stadium fetch with "${altName}"`);
                  const alternativeStadiums = await fetchStadiumsForCountry(detectedCountryCode, altName);
                  
                  if (alternativeStadiums && alternativeStadiums.length > 0) {
                    console.log(`🏟️ RETRY PROCESSING: ${alternativeStadiums.length} stadiums for display`);
                    displayStadiumPins(alternativeStadiums, map);
                    setStadiumPins(alternativeStadiums);
                    console.log(`✅ ALTERNATIVE SUCCESS: ${alternativeStadiums.length} stadiums found using "${altName}"`);
                    break; // Stop on first success
                  }
                }
              }
            } catch (error) {
              console.error(`❌ STADIUM LOADING FAILED for ${detectedCountryName}:`, error);
            } finally {
              setIsLoadingStadiums(false);
            }
          }
        }
      } catch (error) {
        console.log('❌ Click geocoding failed:', error);
      }

      map.setOptions({ draggableCursor: 'grab' });
    });
  };

  // NEW FUNCTION: Render all countries on initial map load
  const renderCountriesOnMap = async (map, countries) => {
    console.log(`🎨 RENDERING: ${countries.length} countries on map`);
    
    try {
      // Fetch GeoJSON data
      const response = await fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson');
      const geoJsonData = await response.json();
      
      // Store all country polygons
      window.countryPolygons = [];
      
      countries.forEach(country => {
        // Find matching GeoJSON feature
        const feature = geoJsonData.features.find(f => {
          const code = f.properties.ISO_A2;
          const name = f.properties.NAME_EN || f.properties.NAME;
          
          // Special case: England uses code "ENG" but GeoJSON uses "GB"
          if (country.code === 'ENG' && code === 'GB') {
            return true;
          }
          
          return code === country.code || 
                code?.toLowerCase() === country.code?.toLowerCase() ||
                name?.toLowerCase() === country.name?.toLowerCase();
        });
        
        if (!feature) {
          console.warn(`⚠️ No GeoJSON found for ${country.name}`);
          return;
        }
        
        // Create polygon(s) for this country
        const createPolygon = (coordinates) => {
          const paths = coordinates.map(coord => ({
            lat: coord[1],
            lng: coord[0]
          }));
          
          return new window.google.maps.Polygon({
            paths: paths,
            strokeColor: '#22c55e',
            strokeOpacity: 0.6,
            strokeWeight: 1,
            fillColor: '#22c55e',
            fillOpacity: 0.2,
            map: map,
            zIndex: 100,
            clickable: true
          });
        };
        
        let polygons = [];
        
        if (feature.geometry.type === 'Polygon') {
          polygons.push(createPolygon(feature.geometry.coordinates[0]));
        } else if (feature.geometry.type === 'MultiPolygon') {
          feature.geometry.coordinates.forEach(polygon => {
            polygons.push(createPolygon(polygon[0]));
          });
        }
        
        // Store polygons with country data
        country.polygons = polygons;
        polygons.forEach(polygon => {
          polygon.countryData = country;
          window.countryPolygons.push(polygon);

          // Add click listener to polygon
          polygon.addListener('click', () => {
            console.log(`🎯 POLYGON CLICKED: ${country.name}`);

            let lat = country.center?.lat;
            let lng = country.center?.lng;

            if (lat == null || lng == null) {
              const bounds = new window.google.maps.LatLngBounds();
              (country.polygons || [polygon]).forEach(p => {
                p.getPath().forEach(pt => bounds.extend(pt));
              });
              const center = bounds.getCenter();
              lat = center.lat();
              lng = center.lng();
              console.log(`📐 CENTER FROM BOUNDS: ${country.name} → ${lat}, ${lng}`);
            }

            window.clickCountryFromPopup(country.code, country.name, lat, lng);
          });
          
          // Add hover effects
          polygon.addListener('mouseover', () => {
            polygon.setOptions({
              fillOpacity: 0.4,
              strokeWeight: 2
            });
            map.setOptions({ draggableCursor: 'pointer' });
          });
          
          polygon.addListener('mouseout', () => {
            polygon.setOptions({
              fillOpacity: 0.2,
              strokeWeight: 1
            });
            map.setOptions({ draggableCursor: 'grab' });
          });
        });
        
        console.log(`✅ Rendered: ${country.name}`);
      });
      
      console.log(`🎨 RENDER COMPLETE: ${window.countryPolygons.length} polygons created`);
      
    } catch (error) {
      console.error('❌ Failed to render countries:', error);
    }
  };

    const fetchCountryOnDemand = async (countryCode, countryName = null) => {
      const cacheKey = `country_${countryCode}`;
      if (apiCacheRef.current.countryDetails[cacheKey]) {
        console.log(`📦 CACHE HIT: Using cached data for ${countryName}`);
        return apiCacheRef.current.countryDetails[cacheKey];
      }
      
      console.log(`🔄 LAZY LOAD: Fetching data for ${countryName} on-demand`);
      try {
        // Get competitions data (already loaded)
        const country = countriesDataRef.current.find(c => c.code === countryCode);
        const competitions = country?.competitions || [];

        const countryData = {
          name: countryName || countryCode,
          code: countryCode,
          stadiums: competitions.length * 10, // Estimate
          topLeagues: competitions.slice(0, 2).map(c => c.name),
          hasWomensLeagues: false, // Football-Data.org doesn't have women's data
          competitions: competitions,
          cachedAt: Date.now()
        };

        apiCacheRef.current.countryDetails[`country_${countryCode}`] = countryData;
        console.log(`💾 CACHED: ${countryName} data saved for future use`);

        return countryData;
      } catch (error) {
        return null;
      }
    };

        const getCountryHistoricalFact = (countryCode) => {
          const facts = {
            'GB': '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Birthplace of modern football (1863)',
            'BR': '🏆 5-time World Cup champions',
            'DE': '🏆 4-time World Cup winners',
            'AR': '🏆 3-time World Cup champions',
            'IT': '🏆 4-time World Cup winners',
            'FR': '🏆 2-time World Cup champions',
            'ES': '🏆 2010 World Cup champions',
            'NL': '🧡 Total Football pioneers',
            'PT': '🏆 Euro 2016 champions',
            'US': '🏆 4-time Women\'s World Cup champions',
            'JP': '🏆 2011 Women\'s World Cup champions',
            'AU': '🏆 4-time AFC Asian Cup winners',
            'MX': '🏆 11-time CONCACAF champions',
            'EG': '🏆 7-time African Cup of Nations',
            'NG': '🏆 3-time African Cup of Nations',
            'IN': '🏆 1951 Asian Games football gold',
            'CN': '🏆 1984 AFC Asian Cup champions',
            'RU': '🏆 1960 European Championship winners',
            'SE': '🏆 1948 Olympic football champions',
            'NO': '🏆 2000 European Championship runners-up'
        };
        
        const fact = facts[countryCode];
          return fact ? `
            <div style="margin-top: 6px; font-size: 10px; color: #6b7280; text-align: center; font-style: italic;">
              ${fact}
            </div>
          ` : '';
        };
  
  const createHoverInfoContent = (country) => {
    const stadiumText = country.stadiums > 0 
      ? `${country.stadiums} stadium${country.stadiums !== 1 ? 's' : ''}`
      : 'Football venues';
      
    return `
      <div class="info-window-enhanced" style="
        padding: 8px; 
        min-width: 180px; 
        max-width: 200px;
        font-family: 'Inter', 'Segoe UI', Arial, sans-serif; 
        animation: fadeInUp 0.2s ease-out;
        background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
        border-radius: 8px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.15);
        border: 1px solid rgba(34, 197, 94, 0.2);
        pointer-events: none;
        position: relative;
      ">
        <!-- Compact Header -->
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <h3 style="margin: 0; color: #1f2937; font-size: 14px; font-weight: 700;">
            ${country.name}
          </h3>
          ${country.flag ? `<span style="font-size: 16px;">${country.flag}</span>` : ''}
        </div>
        
        <!-- Compact Stadium Count -->
        <div style="display: flex; align-items: center; margin: 4px 0;">
          <span style="font-size: 16px; font-weight: 800; color: #16a34a; margin-right: 6px;">
            ⚽ ${country.stadiums}
          </span>
          <span style="color: #374151; font-size: 11px;">
            ${stadiumText}
          </span>
        </div>
        
        <!-- Simple Click Instruction -->
        <div style="
          margin-top: 6px; 
          padding: 4px 6px; 
          background: rgba(59, 130, 246, 0.1); 
          border-radius: 4px;
          text-align: center;
          font-size: 10px;
          color: #3b82f6;
          font-weight: 500;
        ">
          Click country to explore stadiums
        </div>
      </div>
    `;
  };

  // NEW FUNCTION: Display stadium pins on the map
  const displayStadiumPins = (stadiums, map) => {
    console.log(`🏟️ DISPLAYING: ${stadiums.length} stadium pins`);

    console.log(`🏟️ DISPLAYING: ${stadiums.length} stadium pins`);
    console.log('📍 Stadium data sample:', stadiums.slice(0, 2).map(s => ({
      name: s.name,
      hasCoordinates: !!s.coordinates,
      coordinates: s.coordinates
    })));
    
    // Clear existing pins
    clearAllStadiumMarkers();

    stadiums.forEach((stadium, index) => {
      if (!stadium.coordinates) return;

      // Create custom stadium marker
      const marker = new window.google.maps.Marker({
        position: stadium.coordinates,
        map: map,
        title: `${stadium.name} - ${stadium.team}`,
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
            <svg width="36" height="48" viewBox="0 0 36 48" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
                  <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              </defs>
              
              <!-- Outer glow -->
              <circle cx="18" cy="16" r="14" fill="#22c55e" opacity="0.3" filter="url(#glow)"/>
              
              <!-- Main pin shape -->
              <path d="M 18 2 C 10.268 2 4 8.268 4 16 C 4 24 18 44 18 44 C 18 44 32 24 32 16 C 32 8.268 25.732 2 18 2 Z" 
                    fill="url(#gradient)" 
                    stroke="#ffffff" 
                    stroke-width="2.5"
                    filter="url(#glow)"/>
              
              <!-- Gradient definition -->
              <defs>
                <linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" style="stop-color:#22c55e;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:#16a34a;stop-opacity:1" />
                </linearGradient>
              </defs>
              
              <!-- Inner stadium icon -->
              <g transform="translate(18, 16)">
                <!-- Stadium structure -->
                <ellipse cx="0" cy="0" rx="7" ry="5" fill="#ffffff" opacity="0.9"/>
                <ellipse cx="0" cy="0" rx="5" ry="3" fill="#22c55e"/>
                
                <!-- Field lines -->
                <line x1="-5" y1="0" x2="5" y2="0" stroke="#ffffff" stroke-width="0.5"/>
                <circle cx="0" cy="0" r="1.5" fill="none" stroke="#ffffff" stroke-width="0.5"/>
              </g>
            </svg>
          `),
          scaledSize: new window.google.maps.Size(36, 48),
          anchor: new window.google.maps.Point(18, 44)
        },
        animation: window.google.maps.Animation.DROP,
        zIndex: 1000 + index
      });

      

      // Add click listener for stadium details
      marker.addListener('click', () => {
        setSelectedStadium(stadium);
        
        // Create stadium info window
        const infoWindow = new window.google.maps.InfoWindow({
          content: createProfessionalStadiumPopup(stadium),
          maxWidth: 350
        });
        
        // Close other info windows
        if (window.currentStadiumInfoWindow) {
          window.currentStadiumInfoWindow.close();
        }
        
        infoWindow.open(map, marker);
        window.currentStadiumInfoWindow = infoWindow;
      });

      window.currentStadiumMarkers.push(marker);
    });

    console.log(`✅ DISPLAYED: ${window.currentStadiumMarkers.length} stadium markers`);
  };

  // NEW FUNCTION: Create stadium info window content
  // PROFESSIONAL 10/10 STADIUM POPUP
  const createProfessionalStadiumPopup = (stadium) => {
    const teamName = stadium.team || stadium.teamName || 'Unknown Team';
    const stadiumName = stadium.name || stadium.venue || 'Unknown Stadium';
    const address = stadium.address || 'Address not available';
    const league = stadium.leagueName || stadium.league || '';

    // Get team crest from cache data
    const teamCrest = stadium.crestUrl || stadium.teamLogo || '';
    const clubColors = stadium.clubColors || '';
    const founded = stadium.founded || '';
    const addressEncoded = stadium.address ? encodeURIComponent(stadium.address) : '';

    return `
      <div style="
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
        width: 320px;
        background: linear-gradient(135deg, #ffffff 0%, #f9fafb 100%);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      ">
        <!-- Header with Team Colors -->
        <div style="
          background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
          padding: 16px;
          position: relative;
          overflow: hidden;
        ">
          <!-- Decorative football pattern -->
          <div style="
            position: absolute;
            top: -20px;
            right: -20px;
            width: 80px;
            height: 80px;
            opacity: 0.15;
            font-size: 60px;
          ">⚽</div>
          
          <div style="display: flex; align-items: center; gap: 12px; position: relative;">
            ${teamCrest ? `
              <img 
                src="${teamCrest}" 
                alt="${teamName}" 
                style="
                  width: 48px; 
                  height: 48px; 
                  border-radius: 8px; 
                  background: white;
                  padding: 4px;
                  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                "
                onerror="this.style.display='none'"
              />
            ` : ''}
            
            <div style="flex: 1;">
              <h3 style="
                margin: 0 0 4px 0; 
                color: white; 
                font-size: 16px; 
                font-weight: 700;
                text-shadow: 0 1px 2px rgba(0,0,0,0.2);
              ">${stadiumName}</h3>
              <p style="
                margin: 0; 
                color: rgba(255,255,255,0.95); 
                font-size: 13px; 
                font-weight: 500;
              ">⚽ ${teamName}</p>
            </div>
          </div>
        </div>
        
        <!-- Main Content -->
        <div style="padding: 16px;">
          
          <!-- Location -->
          <div style="
            display: flex;
            align-items: start;
            gap: 8px;
            margin-bottom: 14px;
            padding: 10px;
            background: #f0f9ff;
            border-radius: 8px;
            border-left: 3px solid #3b82f6;
          ">
            <span style="font-size: 14px;">📍</span>
            <p style="
              margin: 0;
              color: #1e40af;
              font-size: 12px;
              line-height: 1.5;
              font-weight: 500;
            ">${address}</p>
          </div>
          
          <!-- Stats Grid -->
          <div style="
            display: grid;
            grid-template-columns: 1fr;
            gap: 10px;
            margin-bottom: 14px;
          ">
            <!-- League -->
            <div style="
              background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
              padding: 10px;
              border-radius: 8px;
              border: 1px solid #93c5fd;
            ">
              <div style="
                color: #1e40af;
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 4px;
              ">
                🏆 League
              </div>
              <div style="
                color: #1e3a8a;
                font-size: 11px;
                font-weight: 700;
                line-height: 1.3;
              ">
                ${league || 'N/A'}
              </div>
            </div>
          </div>

          <!-- Travel -->
          ${addressEncoded ? `
            <div style="
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 10px;
              margin-bottom: 14px;
            ">
              <a href="https://www.google.com/travel/flights?q=Flights%20to%20${addressEncoded}" target="_blank" rel="noopener noreferrer" style="
                display: block;
                background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%);
                padding: 10px;
                border-radius: 8px;
                border: 1px solid #a5b4fc;
                text-decoration: none;
                cursor: pointer;
              ">
                <div style="
                  color: #3730a3;
                  font-size: 10px;
                  font-weight: 700;
                  text-transform: uppercase;
                  letter-spacing: 0.5px;
                  margin-bottom: 4px;
                ">
                  ✈️ Flights
                </div>
                <div style="
                  color: #312e81;
                  font-size: 12px;
                  font-weight: 700;
                ">
                  Search flights
                </div>
              </a>

              <a href="https://www.google.com/travel/hotels/${addressEncoded}" target="_blank" rel="noopener noreferrer" style="
                display: block;
                background: linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%);
                padding: 10px;
                border-radius: 8px;
                border: 1px solid #fdba74;
                text-decoration: none;
                cursor: pointer;
              ">
                <div style="
                  color: #9a3412;
                  font-size: 10px;
                  font-weight: 700;
                  text-transform: uppercase;
                  letter-spacing: 0.5px;
                  margin-bottom: 4px;
                ">
                  🏨 Hotels
                </div>
                <div style="
                  color: #7c2d12;
                  font-size: 12px;
                  font-weight: 700;
                ">
                  Search hotels
                </div>
              </a>
            </div>
          ` : ''}

          <!-- Additional Info Row -->
          ${founded || clubColors ? `
            <div style="
              display: flex;
              gap: 10px;
              margin-bottom: 14px;
            ">
              ${founded ? `
                <div style="
                  flex: 1;
                  background: #fef3c7;
                  padding: 8px;
                  border-radius: 6px;
                  border: 1px solid #fde047;
                ">
                  <div style="
                    color: #854d0e;
                    font-size: 9px;
                    font-weight: 700;
                    text-transform: uppercase;
                    margin-bottom: 2px;
                  ">
                    📅 Founded
                  </div>
                  <div style="
                    color: #422006;
                    font-size: 13px;
                    font-weight: 700;
                  ">
                    ${founded}
                  </div>
                </div>
              ` : ''}
              
              ${clubColors ? `
                <div style="
                  flex: 1;
                  background: #fce7f3;
                  padding: 8px;
                  border-radius: 6px;
                  border: 1px solid #fbcfe8;
                ">
                  <div style="
                    color: #831843;
                    font-size: 9px;
                    font-weight: 700;
                    text-transform: uppercase;
                    margin-bottom: 2px;
                  ">
                    🎨 Colors
                  </div>
                  <div style="
                    color: #500724;
                    font-size: 11px;
                    font-weight: 700;
                  ">
                    ${clubColors}
                  </div>
                </div>
              ` : ''}
            </div>
          ` : ''}
          
          <!-- Footer Badge -->
          <div style="
            background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
            padding: 8px 12px;
            border-radius: 8px;
            text-align: center;
            border: 1px solid #86efac;
          ">
            <div style="
              color: #166534;
              font-size: 11px;
              font-weight: 700;
            ">
              ⚽ FootballGlobe - Discover Stadiums Worldwide
            </div>
          </div>
        </div>
      </div>
    `;
  };

  const resetMap = () => {
    console.log('🌍 RESET: Returning to world view');
    
    // Reset all state
    setSelectedCountry(null);
    setSelectedStadium(null);
    setStandings(null);
    setIsLoading(false);
    setStadiumPins([]);
    setAppMode('world');
    setViewState({
      mode: 'world',
      center: { lat: 20, lng: 0 },
      zoom: 2,
      country: null,
      stadium: null
    });
    
    // Clear stadium markers
    if (window.currentStadiumMarkers) {
      window.currentStadiumMarkers.forEach(marker => marker.setMap(null));
      window.currentStadiumMarkers = [];
    }
    
    // Close info windows
    if (window.currentStadiumInfoWindow) {
      window.currentStadiumInfoWindow.close();
    }
    
    // Smart zoom back to world
    if (googleMapRef.current) {
      // Smooth transition back to world view
      googleMapRef.current.panTo({ lat: 20, lng: 0 });
      
      // Progressive zoom out for better UX
      const currentZoom = googleMapRef.current.getZoom();
      if (currentZoom > 4) {
        // Animate zoom out in steps
        const zoomOut = () => {
          const zoom = googleMapRef.current.getZoom();
          if (zoom > 2) {
            googleMapRef.current.setZoom(zoom - 1);
            setTimeout(zoomOut, 200);
          }
        };
        zoomOut();
      } else {
        googleMapRef.current.setZoom(2);
      }
    }
  };

  // Load Google Maps API
  useEffect(() => {
    const loadGoogleMaps = () => {
      if (!window.google && GOOGLE_KEY) {
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_KEY}&libraries=places&loading=async&language=en`;
        script.async = true;
        script.defer = true;
        script.onload = () => {
          console.log('🔍 Google Maps API loaded successfully');
          console.log('📊 Countries data length at API load:', countriesData.length);
          // Don't initialize here - let the second useEffect handle it
        };
        script.onerror = (error) => {
          console.error('❌ Failed to load Google Maps API:', error);
        };
        document.head.appendChild(script);
      } else if (window.google) {
        console.log('🔍 Google Maps API already loaded');
      }
    };

    loadGoogleMaps();
  }, []);

  // Initialize map when BOTH Google Maps AND countries data are ready
  useEffect(() => {
    console.log('🎯 Checking initialization conditions:');
    console.log('   - window.google:', !!window.google);
    console.log('   - mapRef.current:', !!mapRef.current);
    console.log('   - countriesData.length:', countriesData.length);
    console.log('   - isMapLoaded:', isMapLoaded);
    console.log('   - isLoadingCountries:', isLoadingCountries);
    
    if (window.google && mapRef.current && countriesData.length > 0 && !isMapLoaded && !isLoadingCountries) {
      console.log('🚀 ALL CONDITIONS MET - Initializing map with countries data...');
      (function run() {
        Promise.resolve()
          .then(() => ensureGoogleMapsReady())
          .then(() => initializeMap()); // keep your function name
      })();


    }
    // Cleanup function
    return () => {
      if (googleMapRef.current) {
        window.google?.maps?.event?.clearListeners(googleMapRef.current, 'mousemove');
      }
    };
  }, [countriesData, isMapLoaded, isLoadingCountries]);

  return (
    <div className="premium-container relative overflow-hidden">
      
      {/* Football Field Background */}
      <div className="football-field-enhanced absolute inset-0">
        <div className="absolute inset-8 border-4 border-white rounded-lg">
          <div className="absolute left-1/2 top-0 bottom-0 w-1 bg-white transform -translate-x-1/2"></div>
          <div className="absolute left-1/2 top-1/2 w-20 h-20 border-2 border-white rounded-full transform -translate-x-1/2 -translate-y-1/2"></div>
        </div>
      </div>

      {/* Premium Header */}
      <header className="premium-header" style={{ position: 'sticky', top: 0, zIndex: 50, padding: '1rem 1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
  <img 
    src="/footballglobe-logo.png"
    alt="FootballGlobe Logo" 
    style={{ width: '60px', height: '60px', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.1))' }}
  />
    <h1 style={{ 
        fontSize: '2.5rem', 
        fontWeight: '800', 
        background: 'linear-gradient(135deg, #ffffff 0%, #22c55e 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        marginBottom: '0.5rem',
        letterSpacing: '-0.02em'
      }}>
      FootballGlobe
    </h1>
  </div>
            <p style={{ fontSize: '1.125rem', color: 'rgba(255,255,255,0.9)', fontWeight: '500' }}>
              Dream Away - Discover Football Worldwide
            </p>
          </div>
          
          {selectedCountry && (
            <button
              onClick={resetMap}
              style={{
                backgroundColor: 'rgba(255,255,255,0.2)',
                color: 'white',
                padding: '0.5rem 1rem',
                borderRadius: '0.5rem',
                border: 'none',
                cursor: 'pointer',
                backdropFilter: 'blur(8px)',
                transition: 'all 0.2s'
              }}
            >
              🌍 World View
            </button>
          )}
        </div>
        
        <div style={{ 
            marginTop: '1rem', 
            display: 'flex', 
            flexWrap: 'wrap', 
            gap: '0.75rem'
          }}>
          <div className="stats-badge" style={{ padding: '0.5rem 1rem', borderRadius: '2rem', fontSize: '0.875rem', fontWeight: '500' }}>
            📍 {countriesData.length} Countries
          </div>
          <div className="stats-badge" style={{ padding: '0.5rem 1rem', borderRadius: '2rem', fontSize: '0.875rem', fontWeight: '500' }}>
            ⚽ Live Football Data  
          </div>
          <div className="stats-badge" style={{ padding: '0.5rem 1rem', borderRadius: '2rem', fontSize: '0.875rem', fontWeight: '500' }}>
            🗺️ Real-time API
          </div>
          
          {/* App Mode Indicator */}
          <div className="stats-badge" style={{ 
            padding: '0.5rem 1rem', 
            borderRadius: '2rem', 
            fontSize: '0.875rem', 
            fontWeight: '500',
            backgroundColor: appMode === 'world' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(34, 197, 94, 0.1)',
            color: appMode === 'world' ? '#3b82f6' : '#22c55e'
          }}>
            {appMode === 'world' && '🌍 World View'}
            {appMode === 'country' && '🗺️ Country View'}
            {appMode === 'stadium' && '🏟️ Stadium View'}
          </div>
        </div>
        
        {/* Journey Mode Selector - Only show in world view */}
        {!selectedCountry && (
          <div style={{ marginTop: '1rem' }}>
            <select 
              value={currentJourney?.id || ''}
              onChange={(e) => {
                if (e.target.value) {
                  const journey = JOURNEY_TYPES[e.target.value];
                  setCurrentJourney(journey);
                  setJourneyProgress(0);
                  console.log(`🗺️ JOURNEY STARTED: ${journey.title}`);
                } else {
                  setCurrentJourney(null);
                  setJourneyProgress(0);
                  console.log('🗺️ JOURNEY ENDED: Back to free exploration');
                }
              }}
              style={{
                backgroundColor: 'rgba(255,255,255,0.1)',
                color: 'white',
                border: '1px solid rgba(255,255,255,0.3)',
                borderRadius: '0.5rem',
                padding: '0.5rem 1rem',
                backdropFilter: 'blur(8px)',
                fontSize: '0.9rem',
                cursor: 'pointer'
              }}
            >
              <option value="">🗺️ Free Exploration Mode</option>
              {/* <option value="worldCupWinners">🏆 World Cup Champions Journey</option> */}
              {/* <option value="legendaryStadiums">🏟️ Legendary Stadiums Tour</option> */}
            </select>
            
            {/* Journey Progress Indicator */}
            {currentJourney && (
              <div style={{ 
                marginTop: '0.5rem', 
                padding: '0.5rem 1rem',
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: '0.5rem',
                fontSize: '0.8rem',
                color: 'rgba(255,255,255,0.9)'
              }}>
                📍 {currentJourney.description} • Progress: {journeyProgress}/8 countries
              </div>
            )}
          </div>
        )}
      </header>

      {/* API Status */}
      {(isLoadingCountries || apiError) && (
        <div style={{ position: 'relative', zIndex: 30, margin: '0 1.5rem', padding: '1rem', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '0.5rem', marginBottom: '1rem' }}>
          {isLoadingCountries && (
            <div style={{ color: 'white', textAlign: 'center' }}>
              <div style={{ display: 'inline-block', width: '1rem', height: '1rem', border: '2px solid white', borderTop: '2px solid transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', marginRight: '0.5rem' }}></div>
              Loading countries from football-data.org...
            </div>
          )}
          
          {apiError && (
            <div style={{ color: '#ff6b6b', textAlign: 'center' }}>
              <strong>⚠️ API Error:</strong> {apiError}
              <br />
              <small>Please check your API keys in .env file</small>
            </div>
          )}
        </div>
      )}

      {/* Main Map Container */}
      <main style={{ position: 'relative', zIndex: 10, flex: 1, padding: '0 1.5rem 1.5rem' }}>
        <div className="premium-map-container hover-lift" style={{ position: 'relative', borderRadius: '1.5rem', overflow: 'visible', margin: '2rem 0' }}>
          
          {/* Map Container */}
          <div 
            ref={mapRef} 
            style={{ 
              width: selectedCountry ? 'calc(100% - 400px)' : '100%', // Reserve space for sidebar
              height: '520px', 
              display: countriesData.length > 0 ? 'block' : 'none',
              pointerEvents: 'auto',
              position: 'relative',
              cursor: 'default',
              overflow: 'visible',
              zIndex: 1,
              transition: 'width 0.3s ease' // Smooth resize animation
            }}
          ></div>

          

          {/* Loading placeholder while countries data loads */}
          {countriesData.length === 0 && (
            <div className="map-loading-skeleton" style={{ 
              width: '100%', 
              height: '520px', 
              borderRadius: '1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(34, 139, 34, 0.1)'
            }}>
              <div style={{ textAlign: 'center', color: 'white', width: '280px' }}>
                <div className="loading-pulse" style={{ 
                  width: '3rem', 
                  height: '3rem', 
                  backgroundColor: 'rgba(255,255,255,0.2)',
                  borderRadius: '50%', 
                  margin: '0 auto 1rem' 
                }}></div>
                                
                {/* Real Progress Bar */}
                <div style={{ 
                  width: '100%', 
                  height: '6px', 
                  backgroundColor: 'rgba(255,255,255,0.2)', 
                  borderRadius: '3px', 
                  marginBottom: '0.75rem',
                  overflow: 'hidden'
                }}>
                  <div style={{ 
                    height: '100%', 
                    width: `${totalCountries > 0 ? (loadingProgress / totalCountries) * 100 : 0}%`,
                    background: 'linear-gradient(90deg, #22c55e, #16a34a)', 
                    borderRadius: '3px',
                    transition: 'width 0.3s ease-out',
                    boxShadow: '0 0 10px rgba(34, 197, 94, 0.5)'
                  }}></div>
                </div>

                <p style={{ fontSize: '1.125rem', fontWeight: '500', marginBottom: '0.5rem' }}>
                  {isLoadingCountries ? `Loading Countries (${loadingProgress}/${totalCountries})` : 'Initializing Map...'}
                </p>
                <p style={{ fontSize: '0.875rem', opacity: 0.8 }}>
                  {isLoadingCountries ? 'Fetching real-time football data...' : 'Setting up interactive map...'}
                </p>
                
                <p style={{ fontSize: '0.875rem', opacity: 0.8 }}>
                  {isLoadingCountries ? '...' : 'Initializing map...'}
                </p>
              </div>
            </div>
          )}
          
          {/* Map Status Overlay */}
          {!isMapLoaded && countriesData.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(34, 139, 34, 0.2)', zIndex: 30 }}>
              <div style={{ textAlign: 'center', color: 'white' }}>
                <div style={{ width: '3rem', height: '3rem', border: '4px solid white', borderTop: '4px solid transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 1rem' }}></div>
                <p style={{ fontSize: '1.125rem', fontWeight: '500' }}>Loading World Map...</p>
                <p style={{ fontSize: '0.875rem', opacity: 0.8 }}>Connecting to Google Maps API</p>
              </div>
            </div>
          )}

          {/* Loading Overlay for Country */}
          {isLoading && selectedCountry && (
            <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20, borderRadius: '1rem' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '0.5rem', padding: '1.5rem', textAlign: 'center' }}>
                <div style={{ width: '2rem', height: '2rem', border: '3px solid #22c55e', borderTop: '3px solid transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 0.75rem' }}></div>
                <p style={{ fontWeight: '500', color: '#1f2937' }}>Loading {selectedCountry.name}</p>
                <p style={{ fontSize: '0.875rem', color: '#6b7280' }}>Fetching stadium data...</p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Country Detail Sidebar */}
      {selectedCountry && !isLoading && (
        <aside style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: '24rem', backgroundColor: 'white', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', zIndex: 50, transition: 'transform 0.3s' }}>
          <div style={{ padding: '1.5rem', height: '100%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#1f2937' }}>
                <img 
                  src={selectedCountry.flag} 
                  alt={selectedCountry.name}
                  style={{ width: '32px', height: '24px', marginRight: '8px', borderRadius: '2px' }}
                />
                {selectedCountry.name}
              </h2>
              <button 
                onClick={resetMap}
                style={{ color: '#6b7280', background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {/* Stadium Overview */}
              <div className="stadium-count-card" style={{ backgroundColor: '#f0fdf4', borderRadius: '0.5rem', padding: '1rem', position: 'relative', overflow: 'hidden' }}>
                <div className="stadium-number" style={{ fontSize: '2.5rem', fontWeight: '900', color: '#16a34a', textShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
                  {stadiumPins.length}
                </div>
                <div style={{ color: '#6b7280', fontSize: '1.1rem', fontWeight: '500' }}>
                  Football Stadiums
                </div>
                <div style={{ fontSize: '0.75rem', color: '#16a34a', marginTop: '0.25rem' }}>
                  🟢 Live API Data • {stadiumPins.length} Pins Loaded
                </div>
                <div style={{ fontSize: '0.7rem', color: '#9ca3af', marginTop: '0.5rem', fontStyle: 'italic' }}>
                  ℹ️ Stadium capacity data will be added in a future update
                </div>
              </div>
              
              {/* Top Leagues */}
              <div>
                <h3 style={{ fontWeight: '600', color: '#1f2937', marginBottom: '0.75rem' }}>🏆 Top Leagues</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {selectedCountry.competitions && selectedCountry.competitions.length > 0 ? (
                    selectedCountry.competitions.map((comp, index) => (
                      <div 
                        key={index} 
                        onClick={async () => {
                          console.log('🔄 Switching to league:', comp.name, 'ID:', comp.id);
                          setIsLoading(true);
                          setStadiumPins([]); // Clear old pins
                          setStandings(null); // Clear old standings
                          
                          try {
                            // Load teams for this competition
                            const teamsData = await fgFootballTeams(comp.id);
                            console.log('⚽ FOUND:', teamsData.teams?.length || 0, 'teams in', comp.name);
                            
                            // Load stadiums (copy the geocoding logic from clickCountryFromPopup)
                            const stadiums = [];
                            const countryName = selectedCountry.name === 'England' ? 'United Kingdom' : selectedCountry.name;
                            
                            for (const team of (teamsData.teams || [])) {
                              if (team.venue) {
                                try {
                                  const address = `${team.venue}, ${team.address || ''}, ${countryName}`;
                                  const result = await fgForwardGeocode(address);
                                  
                                  if (result.status === 'OK' && result.results?.[0]) {
                                    const location = result.results[0].geometry.location;
                                    stadiums.push({
                                      name: team.venue,
                                      team: team.name,
                                      city: team.address?.split(',')[0] || team.venue,
                                      coordinates: { lat: location.lat, lng: location.lng },
                                      capacity: 0
                                    });
                                  }
                                } catch (error) {
                                  console.warn('⚠️ Geocoding failed for:', team.venue);
                                }
                              }
                            }
                            
                            console.log('🎯 RESULT:', stadiums.length, 'stadiums found');
                            setStadiumPins(stadiums);
                            
                            // Load standings
                            const standingsData = await fgFootballStandings(comp.id);
                            setStandings(standingsData.standings);
                            
                          } catch (error) {
                            console.error('❌ Error switching league:', error);
                          } finally {
                            setIsLoading(false);
                          }
                        }}
                        style={{ 
                          backgroundColor: '#f9fafb', 
                          borderRadius: '0.5rem', 
                          padding: '0.75rem',
                          cursor: 'pointer',
                          border: '1px solid #e5e7eb',
                          transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f3f4f6'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#f9fafb'}
                      >
                        <div style={{ fontWeight: '500', color: '#1f2937' }}>{comp.name}</div>
                        <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>{comp.type || 'Professional League'}</div>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: '#6b7280', fontStyle: 'italic' }}>Loading league data...</div>
                  )}
                </div>
              </div>

              {/* Enhanced League Selector */}
              {availableLeagues.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <h3 style={{ fontWeight: '600', color: '#1f2937', marginBottom: '0.75rem' }}>
                    🏆 League Selector ({availableLeagues.length} leagues)
                  </h3>
                  
                  <select 
                    value={selectedLeague || 'top'} 
                    onChange={(e) => {
                      const leagueValue = e.target.value;
                      setSelectedLeague(leagueValue);
                      
                      console.log(`🔄 League dropdown changed to: ${leagueValue}`);
                      
                      if (leagueValue === 'top') {
                        // Show top league stadiums only (matches country-click behavior)
                        console.log('🔄 SWITCHING: Back to top league view');
                        
                        if (selectedCountry) {
                          // Get country data and top league
                          const selectedCountryCode = translateCountryNameToCode(selectedCountry) || selectedCountry;
                          
                          // IMPORTANT: Convert code to name (ENG → England) because cache uses full names
                          const countryNameForLookup = COUNTRY_CODE_TO_NAME[selectedCountryCode] || 
                                                      COUNTRY_CODE_TO_NAME[selectedCountry] || 
                                                      selectedCountry;
                          const countryData = cachedStadiums?.countries?.[countryNameForLookup];
                          const topLeague = countryData?.leagues?.[0];
                          
                          // Get all stadiums for country
                          const allStadiums = getStadiumsFromCache(selectedCountryCode || selectedCountry);
                          
                          // Filter to TOP LEAGUE ONLY (same as country click)
                          const topLeagueStadiums = topLeague 
                            ? allStadiums.filter(stadium => stadium.leagueId === topLeague.id)
                            : allStadiums;
                          
                          if (topLeagueStadiums.length > 0) {
                            const stadiumsWithCoords = topLeagueStadiums.map(stadium => ({
                              name: stadium.venue,
                              team: stadium.teamName,
                              lat: stadium.latitude,
                              lng: stadium.longitude,
                              coordinates: { lat: stadium.latitude, lng: stadium.longitude },
                              address: stadium.address || '',
                              capacity: stadium.capacity || 0,
                              leagueName: stadium.leagueName,
                              leagueId: stadium.leagueId,
                              id: stadium.teamId,
                              crestUrl: stadium.crestUrl,
                              clubColors: stadium.clubColors,
                              founded: stadium.founded
                            }));
                            
                            clearAllStadiumMarkers();
                            displayStadiumPins(stadiumsWithCoords, googleMapRef.current);
                            setStadiumPins(stadiumsWithCoords);
                            
                            if (window.currentStadiumMarkers.length > 0 && googleMapRef.current) {
                              const bounds = new window.google.maps.LatLngBounds();
                              window.currentStadiumMarkers.forEach(marker => {
                                bounds.extend(marker.getPosition());
                              });
                              googleMapRef.current.fitBounds(bounds);
                              
                              setTimeout(() => {
                                const currentZoom = googleMapRef.current.getZoom();
                                if (currentZoom > 8) {
                                  googleMapRef.current.setZoom(8);
                                }
                              }, 300);
                            }
                            
                            console.log(`✅ Showing ${stadiumsWithCoords.length} top league stadiums (${topLeague?.name || 'default'})`);
                            
                            // Load standings for top league
                            if (topLeague) {
                              const leagueStandings = getStandingsFromCache(topLeague.id);
                              if (leagueStandings) {
                                setStandings([{
                                  competition: leagueStandings.competition,
                                  standings: leagueStandings.standings
                                }]);
                              }
                            }
                          }
                        }
                        return;
                      }
                      
                      // Find selected league
                      const league = availableLeagues.find(l => l.id.toString() === leagueValue);
                      if (!league) {
                        console.warn('⚠️ League not found');
                        return;
                      }
                      
                      console.log(`🔄 SWITCHING TO: ${league.name} (ID: ${league.id})`);
                      
                      // ===== NEW: FIND WHICH COUNTRY THIS LEAGUE BELONGS TO =====
                      let leagueCountry = null;
                      let leagueStadiums = [];
                      
                      // Search through ALL countries in cache to find this league
                      if (cachedStadiums && cachedStadiums.countries) {
                        const allCountries = Object.keys(cachedStadiums.countries);
                        
                        for (const countryName of allCountries) {
                          const countryData = cachedStadiums.countries[countryName];
                          
                          // Check if this country has this league
                          const hasLeague = countryData.leagues.some(l => l.id === league.id);
                          
                          if (hasLeague) {
                            leagueCountry = countryName;
                            console.log(`🌍 FOUND: ${league.name} belongs to ${countryName}`);
                            
                            // Get all stadiums for this country
                            const allStadiums = getStadiumsFromCache(countryName);
                            
                            // Filter to only this league
                            leagueStadiums = allStadiums.filter(stadium => 
                              stadium.leagueId === league.id
                            );
                            
                            break; // Found it, stop searching
                          }
                        }
                      }
                      
                      if (!leagueCountry || leagueStadiums.length === 0) {
                        console.warn(`⚠️ No stadiums found for ${league.name}`);
                        alert(`No stadiums found for ${league.name}`);
                        return;
                      }
                      
                      console.log(`⚡ FOUND: ${leagueStadiums.length} stadiums for ${league.name} in ${leagueCountry}`);
                      
                      // Transform cache data to display format
                      const stadiumsWithCoords = leagueStadiums.map(stadium => ({
                        name: stadium.venue,
                        team: stadium.teamName,
                        lat: stadium.latitude,
                        lng: stadium.longitude,
                        coordinates: { lat: stadium.latitude, lng: stadium.longitude },
                        address: stadium.address || '',
                        capacity: stadium.capacity || 0,
                        leagueName: stadium.leagueName,
                        leagueId: stadium.leagueId,
                        id: stadium.teamId
                      }));
                      
                      // Update selected country if it changed
                      if (leagueCountry !== selectedCountry) {
                        console.log(`🌍 AUTO-SWITCHING: From ${selectedCountry} → ${leagueCountry}`);
                        setSelectedCountry(leagueCountry);
                      }
                      
                      // Clear existing markers
                      if (window.currentStadiumMarkers) {
                        window.currentStadiumMarkers.forEach(marker => marker.setMap(null));
                        window.currentStadiumMarkers = [];
                      }
                      
                      // Display new stadiums
                      displayStadiumPins(stadiumsWithCoords, googleMapRef.current);
                      setStadiumPins(stadiumsWithCoords);
                      
                      // Auto-zoom to fit all stadiums
                      if (window.currentStadiumMarkers.length > 0 && googleMapRef.current) {
                        const bounds = new window.google.maps.LatLngBounds();
                        
                        window.currentStadiumMarkers.forEach(marker => {
                          bounds.extend(marker.getPosition());
                        });
                        
                        googleMapRef.current.fitBounds(bounds);
                        
                        setTimeout(() => {
                          const currentZoom = googleMapRef.current.getZoom();
                          if (currentZoom > 9) {
                            googleMapRef.current.setZoom(9);
                          }
                        }, 300);
                        
                        console.log(`🗺️ Zoomed to fit ${window.currentStadiumMarkers.length} ${league.name} stadiums`);
                      }
                      
                      // Load standings for this league
                      const leagueStandings = getStandingsFromCache(league.id);
                      if (leagueStandings) {
                        setStandings([{
                          competition: leagueStandings.competition,
                          standings: leagueStandings.standings
                        }]);
                        console.log(`⚡ STANDINGS: Loaded for ${league.name}`);
                      }
                      
                      console.log(`✅ COMPLETE: Switched to ${league.name} (${leagueCountry}) - ${stadiumsWithCoords.length} stadiums`);
                    }}
                    style={{
                      width: '100%',
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border: '1px solid #d1d5db',
                      backgroundColor: 'white',
                      fontSize: '0.875rem'
                    }}
                  >
                    <option value="top">🏆 Top Leagues ({stadiumPins.length} stadiums)</option>
                    {availableLeagues.map(league => (
                      <option key={league.id} value={league.id}>
                        {league.type === 'League' ? '🏟️' : '🏆'} {league.name}
                      </option>
                    ))}
                  </select>
                  
                  {selectedLeague && selectedLeague !== 'top' && (
                    <div style={{
                      marginTop: '0.5rem',
                      padding: '0.5rem',
                      backgroundColor: '#f0f9ff',
                      borderRadius: '0.5rem',
                      fontSize: '0.75rem',
                      color: '#3b82f6'
                    }}>
                      📊 Showing stadiums from selected league only
                    </div>
                  )}
                </div>
              )}

              {/* Stadium List */}
              {stadiumPins.length > 0 && (
                <div>
                  {(() => {
                    // Filter stadiums based on selected league
                    const filteredStadiums = stadiumPins.filter(stadium => {
                      if (!selectedLeague || selectedLeague === 'all') return true;
                      
                      switch (selectedLeague) {
                        case 'top':
                          return stadium.isTopLeague;
                        case 'capacity':
                          return stadium.capacity > 25000;
                        case 'premium':
                          return stadium.capacity > 40000 || stadium.name.toLowerCase().includes('stadium');
                        default:
                          return true;
                      }
                    });
                    
                    return (
                      <>
                        <h3 style={{ fontWeight: '600', color: '#1f2937', marginBottom: '0.75rem' }}>
                          🏟️ Stadiums ({filteredStadiums.length})
                        </h3>
                        <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          {filteredStadiums.slice(0, 10).map((stadium, index) => (
                            <div
                              key={stadium.id}
                              style={{
                                backgroundColor: selectedStadium?.id === stadium.id ? '#e0f2fe' : '#f9fafb',
                                borderRadius: '0.5rem',
                                padding: '0.75rem',
                                cursor: 'pointer',
                                border: selectedStadium?.id === stadium.id ? '2px solid #3b82f6' : '1px solid transparent',
                                transition: 'all 0.2s'
                              }}
                              onClick={() => {
                                setSelectedStadium(stadium);
                                if (googleMapRef.current && stadium.coordinates) {
                                  googleMapRef.current.panTo(stadium.coordinates);
                                  googleMapRef.current.setZoom(15);
                                }
                              }}
                            >
                              <div style={{ fontWeight: '500', color: '#1f2937', fontSize: '0.9rem' }}>
                                {stadium.name}
                                {stadium.team && (
                                  <span style={{ fontWeight: '400', color: '#6b7280', marginLeft: '0.5rem' }}>
                                    • {stadium.team}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '2px' }}>
                                📍 {stadium.city} • 👥 {stadium.capacity?.toLocaleString() || 'Unknown'} capacity
                              </div>
                            </div>
                          ))}
                          
                          {filteredStadiums.length > 10 && (
                            <div style={{
                              textAlign: 'center',
                              padding: '0.75rem',
                              color: '#6b7280',
                              fontSize: '0.875rem',
                              fontStyle: 'italic'
                            }}>
                              + {filteredStadiums.length - 10} more stadiums available
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}

              {/* Loading Stadiums */}
              {isLoadingStadiums && (
                <div style={{ 
                  backgroundColor: '#f0f9ff', 
                  borderRadius: '0.5rem', 
                  padding: '1rem',
                  textAlign: 'center'
                }}>
                  <div style={{ 
                    width: '2rem', 
                    height: '2rem', 
                    border: '3px solid #3b82f6', 
                    borderTop: '3px solid transparent', 
                    borderRadius: '50%', 
                    animation: 'spin 1s linear infinite', 
                    margin: '0 auto 0.5rem' 
                  }}></div>
                  <p style={{ color: '#3b82f6', fontWeight: '500', margin: 0 }}>
                    Loading stadiums...
                  </p>
                </div>
              )}
              {/* League Standings */}
              {standings && standings.length > 0 && (
                <div style={{ marginTop: '1.5rem' }}>
                  <h3 style={{ 
                    fontSize: '1.1rem', 
                    fontWeight: '700', 
                    marginBottom: '1rem',
                    color: '#1f2937',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem'
                  }}>
                    📊 League Standings
                  </h3>
                  <div style={{ 
                    overflowX: 'auto',
                    backgroundColor: '#fff',
                    borderRadius: '0.5rem',
                    border: '1px solid #e5e7eb'
                  }}>
                    <table style={{ 
                      width: '100%', 
                      fontSize: '0.85rem',
                      borderCollapse: 'collapse'
                    }}>
                      <thead>
                        <tr style={{ 
                          backgroundColor: '#f9fafb',
                          borderBottom: '2px solid #e5e7eb'
                        }}>
                          <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontWeight: '600' }}>#</th>
                          <th style={{ padding: '0.75rem 0.5rem', textAlign: 'left', fontWeight: '600' }}>Team</th>
                          <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontWeight: '600' }}>P</th>
                          <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontWeight: '600' }}>W</th>
                          <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontWeight: '600' }}>D</th>
                          <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontWeight: '600' }}>L</th>
                          <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontWeight: '600', color: '#16a34a' }}>Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {standings[0]?.standings?.table?.map((team, idx) => (
                          <tr key={idx} style={{ 
                            borderBottom: '1px solid #f3f4f6',
                            backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa'
                          }}>
                            <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontWeight: '600', color: '#6b7280' }}>
                              {team.position}
                            </td>
                            <td style={{ padding: '0.75rem 0.5rem', fontWeight: '500' }}>
                              {team.team.name}
                            </td>
                            <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>{team.playedGames}</td>
                            <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>{team.won}</td>
                            <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>{team.draw}</td>
                            <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>{team.lost}</td>
                            <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontWeight: '700', color: '#16a34a' }}>
                              {team.points}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Block 3 Preview */}
              {/* <div style={{ backgroundColor: '#eff6ff', borderRadius: '0.5rem', padding: '1rem' }}>
                <h3 style={{ fontWeight: '600', color: '#1e40af', marginBottom: '0.5rem' }}>🚀 Block 3 Preview</h3>
                <ul style={{ fontSize: '0.875rem', color: '#1e40af', margin: 0, paddingLeft: '1rem' }}>
                  <li>🔄 Real-time data sync</li>
                  <li>💾 Advanced caching</li>
                  <li>📊 Performance metrics</li>
                  <li>🛡️ Error handling</li>
                </ul>
              </div> */} {/* Hide for now */}
            </div>
          </div>
        </aside>
      )}

      {/* Footer */}
      <footer style={{ 
        position: 'fixed',
        bottom: '10px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        padding: '0.5rem 1rem', 
        textAlign: 'center', 
        fontSize: '0.75rem', 
        color: 'rgba(255,255,255,0.9)',
        background: 'rgba(0,0,0,0.7)',
        borderRadius: '1rem',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.1)',
        maxWidth: '400px'
      }}>
        <div>✅ Global Football Data - Real-time & Accurate</div>
        <div style={{ marginTop: '0.25rem' }}>🎯 Hover over countries to explore</div>
      </footer>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        
        /* Premium Football Globe Styles */
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
        
        * {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        }
        
        .premium-container {
          background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
          min-height: 100vh;
        }
        
        .glassmorphism {
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.2);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
        
        .premium-header {
          background: rgba(0, 0, 0, 0.4);
          backdrop-filter: blur(20px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .premium-map-container {
        background: rgba(15, 23, 42, 0.9);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(34, 197, 94, 0.3);
        box-shadow: 
          0 0 0 1px rgba(34, 197, 94, 0.2),
          0 4px 6px -1px rgba(0, 0, 0, 0.1),
          0 20px 25px -5px rgba(0, 0, 0, 0.2),
          0 10px 10px -5px rgba(0, 0, 0, 0.1),
          inset 0 1px 0 rgba(255, 255, 255, 0.1);
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        max-height: 520px; /* ADD: Prevent overflow */
        overflow: hidden;   /* ADD: Hide overflow */
      }

        .premium-map-container:hover {
          transform: translateY(-1px);
          box-shadow: 
            0 0 0 1px rgba(34, 197, 94, 0.3),
            0 6px 8px -1px rgba(0, 0, 0, 0.15),
            0 25px 30px -5px rgba(0, 0, 0, 0.25),
            0 15px 15px -5px rgba(0, 0, 0, 0.15),
            inset 0 1px 0 rgba(255, 255, 255, 0.15);
        }
        
        .hover-lift:hover {
          transform: translateY(-2px);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .football-field-enhanced {
          background: 
            radial-gradient(circle at 50% 50%, rgba(34, 197, 94, 0.15) 0%, transparent 70%),
            linear-gradient(90deg, rgba(255,255,255,0.03) 0%, transparent 50%, rgba(255,255,255,0.03) 100%),
            repeating-linear-gradient(
              90deg,
              transparent,
              transparent 98px,
              rgba(255,255,255,0.02) 100px
            );
          opacity: 0.4;
          animation: fieldPulse 4s ease-in-out infinite;
        }

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
          .info-window-enhanced {
            position: relative;
            overflow: hidden;
          }

          .info-window-enhanced::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, #22c55e 0%, #3b82f6 50%, #22c55e 100%);
            background-size: 200% 100%;
            animation: shimmerTop 2s linear infinite;
          }

          @keyframes shimmerTop {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
          }

        .info-window-animated {
          border-radius: 8px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.2);
          backdrop-filter: blur(10px);
        }

        @keyframes fieldPulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.3; }
        }
        
        .pulse {
          animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }

        .loading-pulse {
          animation: loadingPulse 1.5s ease-in-out infinite;
        }

        @keyframes loadingPulse {
          0%, 100% {
            transform: scale(1);
            opacity: 0.7;
          }
          50% {
            transform: scale(1.1);
            opacity: 1;
          }
        }

        @keyframes progressMove {
          0% { width: 0%; transform: translateX(-100%); }
          50% { width: 70%; transform: translateX(0%); }
          100% { width: 100%; transform: translateX(100%); }
        }

        .map-loading-skeleton::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255,255,255,0.05) 50%,
            transparent 100%
          );
          animation: shimmer 2s infinite;
        }

        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }

        .stadium-count-card {
          transition: all 0.3s ease;
          border: 1px solid rgba(34, 197, 94, 0.2);
        }

        .stadium-count-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 25px rgba(34, 197, 94, 0.15);
        }

        .stadium-number {
          background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .stadium-count-card::before {
          content: '';
          position: absolute;
          top: 0;
          right: 0;
          width: 40px;
          height: 40px;
          background: radial-gradient(circle, rgba(34, 197, 94, 0.1) 0%, transparent 70%);
          border-radius: 50%;
        }
        
        .premium-button {
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.8) 0%, rgba(22, 163, 74, 0.9) 100%);
          border: 1px solid rgba(34, 197, 94, 0.5);
          backdrop-filter: blur(10px);
          transition: all 0.3s ease;
        }
        
        .premium-button:hover {
          background: linear-gradient(135deg, rgba(34, 197, 94, 1) 0%, rgba(22, 163, 74, 1) 100%);
          box-shadow: 0 0 20px rgba(34, 197, 94, 0.4);
          transform: translateY(-1px);
        }
        
        .stats-badge {
          background: rgba(34, 197, 94, 0.1);
          border: 1px solid rgba(34, 197, 94, 0.3);
          color: #22c55e;
        }
        .info-window-enhanced::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, #22c55e 0%, #3b82f6 50%, #22c55e 100%);
            background-size: 200% 100%;
            animation: shimmerTop 2s linear infinite;
          }
      `}</style>
    </div>
  );
};

export default FootballGlobe;