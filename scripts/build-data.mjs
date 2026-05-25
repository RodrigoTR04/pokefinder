/**
 * PokéFinder — build-data.mjs
 * Multi-source Pokémon data pipeline.
 * Sources: PokéAPI, Bulbapedia MediaWiki, Showdown (pkmn/data + play.pokemonshowdown.com)
 *
 * CLI: --range=N-M  --only=<id>  --force  --verbose
 * Output: data/pokemon/{id}.json  +  data/index.json
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.cache');
const DATA_DIR = path.join(ROOT, 'data');
const POKEMON_DIR = path.join(DATA_DIR, 'pokemon');

// ─── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (key) => { const a = args.find(a => a.startsWith(`--${key}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const hasFlag = (key) => args.includes(`--${key}`);

const FORCE   = hasFlag('force');
const VERBOSE = hasFlag('verbose');

let rangeStart = 1, rangeEnd = 1025;
let explicitIds = null; // set by --ids=

const rangeArg = getArg('range');
if (rangeArg) {
  const [s, e] = rangeArg.split('-').map(Number);
  rangeStart = s || 1;
  rangeEnd   = e || s || 1025;
}
const onlyArg = getArg('only');
if (onlyArg) { rangeStart = rangeEnd = parseInt(onlyArg, 10); }
const idsArg = getArg('ids');
if (idsArg) {
  explicitIds = idsArg.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

const log  = (...a) => console.log('[BUILD]', ...a);
const vlog = (...a) => { if (VERBOSE) console.log('[BUILD:V]', ...a); };

// ─── Rate limiters ───────────────────────────────────────────────────────────
function makeRateLimiter(rps) {
  const interval = 1000 / rps;
  let last = 0;
  return async () => {
    const now = Date.now();
    const wait = interval - (now - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
  };
}

const pokeapiLimiter   = makeRateLimiter(10);
const bulbaLimiter     = makeRateLimiter(1);
const showdownLimiter  = makeRateLimiter(5);

// ─── HTTP + cache ────────────────────────────────────────────────────────────
const UA_BULBA = 'PokeFinder-Data-Build/1.0 (https://github.com/user/pokefinder)';

async function ensureCacheDir(source) {
  const dir = path.join(CACHE_DIR, source);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cachedFetch(source, key, url, limiter, extraHeaders = {}, retries = 3) {
  const cacheFile = path.join(CACHE_DIR, source, `${key}.json`);
  if (!FORCE) {
    try {
      const raw = await fs.readFile(cacheFile, 'utf8');
      vlog(`cache hit ${source}/${key}`);
      return JSON.parse(raw);
    } catch (_) {}
  }

  await ensureCacheDir(source);

  for (let attempt = 1; attempt <= retries; attempt++) {
    await limiter();
    try {
      const headers = { 'User-Agent': UA_BULBA, ...extraHeaders };
      const res = await fetch(url, { headers });
      if (res.status === 429 || res.status >= 500) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        log(`rate/server error ${res.status} for ${url}, retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const data = await res.json();
      await fs.writeFile(cacheFile, JSON.stringify(data));
      return data;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

// ─── Showdown bulk data ───────────────────────────────────────────────────────
async function loadShowdownData() {
  log('Loading Showdown pokedex.json …');
  const pokedex  = await cachedFetch('showdown', 'pokedex',  'https://play.pokemonshowdown.com/data/pokedex.json',  showdownLimiter);
  log('Loading Showdown moves.json …');
  const moves    = await cachedFetch('showdown', 'moves',    'https://play.pokemonshowdown.com/data/moves.json',    showdownLimiter);
  log('Loading Showdown learnsets.json …');
  const learnsets = await cachedFetch('showdown', 'learnsets', 'https://play.pokemonshowdown.com/data/learnsets.json', showdownLimiter);
  log('Showdown data loaded.');
  return { pokedex, moves, learnsets };
}

// ─── PokéAPI fetches ──────────────────────────────────────────────────────────
const POKEAPI = 'https://pokeapi.co/api/v2';

async function fetchPokeAPI(endpoint, cacheKey) {
  return cachedFetch('pokeapi', cacheKey, `${POKEAPI}/${endpoint}`, pokeapiLimiter);
}

// ─── Bulbapedia wikitext ──────────────────────────────────────────────────────
async function fetchBulbapedia(name) {
  const page = `${name}_(Pokémon)`;
  const encoded = encodeURIComponent(page);
  const url = `https://bulbapedia.bulbagarden.net/w/api.php?action=parse&page=${encoded}&format=json&prop=wikitext&origin=*`;
  const key = `bulba_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  try {
    const data = await cachedFetch('bulbapedia', key, url, bulbaLimiter);
    return data?.parse?.wikitext?.['*'] || null;
  } catch (err) {
    vlog(`Bulbapedia error for ${name}: ${err.message}`);
    return null;
  }
}

// ─── Bulbapedia wikitext parsers ──────────────────────────────────────────────

// Map Bulbapedia full game names (from v= / v2= params) to PokéAPI slugs.
// Keys are the exact strings appearing in the wikitext templates.
const BULBA_GAME_NAME_MAP = {
  // Gen 1
  'Red': 'red', 'Blue': 'blue', 'Yellow': 'yellow',
  // Gen 2
  'Gold': 'gold', 'Silver': 'silver', 'Crystal': 'crystal',
  // Gen 3
  'Ruby': 'ruby', 'Sapphire': 'sapphire', 'Emerald': 'emerald',
  'FireRed': 'firered', 'LeafGreen': 'leafgreen',
  'Colosseum': 'colosseum', 'XD': 'xd',
  // Gen 4
  'Diamond': 'diamond', 'Pearl': 'pearl', 'Platinum': 'platinum',
  'HeartGold': 'heartgold', 'SoulSilver': 'soulsilver',
  'Pal Park': 'pal-park',
  // Gen 5
  'Black': 'black', 'White': 'white',
  'Black 2': 'black-2', 'White 2': 'white-2',
  // Gen 6
  'X': 'x', 'Y': 'y',
  'Omega Ruby': 'omega-ruby', 'Alpha Sapphire': 'alpha-sapphire',
  // Gen 7
  'Sun': 'sun', 'Moon': 'moon',
  'Ultra Sun': 'ultra-sun', 'Ultra Moon': 'ultra-moon',
  "Let's Go Pikachu": 'lets-go-pikachu', "Let's Go Eevee": 'lets-go-eevee',
  // Gen 8
  'Sword': 'sword', 'Shield': 'shield',
  'Expansion Pass': 'sword-shield-expansion',
  'Brilliant Diamond': 'brilliant-diamond', 'Shining Pearl': 'shining-pearl',
  'Legends: Arceus': 'legends-arceus',
  // Gen 9
  'Scarlet': 'scarlet', 'Violet': 'violet',
  'The Hidden Treasure of Area Zero': 'scarlet-violet-dlc',
  'Legends: Z-A': 'legends-z-a',
  // misc
  'Pokéwalker': 'pokéwalker', 'PokÃ©walker': 'pokéwalker',
  'Mega Dimension': 'mega-dimension',
};

// Fallback: legacy abbreviation map (for any old-style templates or prose)
const BULBA_GAME_ABBR_MAP = {
  'RBY': ['red','blue','yellow'],
  'RB': ['red','blue'], 'R': ['red'], 'B': ['blue'], 'Y': ['yellow'],
  'GSC': ['gold','silver','crystal'],
  'GS': ['gold','silver'], 'G': ['gold'], 'S': ['silver'], 'C': ['crystal'],
  'RSE': ['ruby','sapphire','emerald'],
  'RS': ['ruby','sapphire'], 'Ru': ['ruby'], 'Sa': ['sapphire'], 'E': ['emerald'],
  'FRLG': ['firered','leafgreen'],
  'FR': ['firered'], 'LG': ['leafgreen'],
  'DPPt': ['diamond','pearl','platinum'],
  'DP': ['diamond','pearl'], 'D': ['diamond'], 'P': ['pearl'], 'Pt': ['platinum'],
  'HGSS': ['heartgold','soulsilver'],
  'HG': ['heartgold'], 'SS': ['soulsilver'],
  'BW': ['black','white'],
  'B2W2': ['black-2','white-2'],
  'B2': ['black-2'], 'W2': ['white-2'],
  'XY': ['x','y'],
  'ORAS': ['omega-ruby','alpha-sapphire'],
  'OR': ['omega-ruby'], 'AS': ['alpha-sapphire'],
  'SM': ['sun','moon'],
  'USUM': ['ultra-sun','ultra-moon'],
  'LGPE': ['lets-go-pikachu','lets-go-eevee'],
  'SwSh': ['sword','shield'], 'Sw': ['sword'], 'Sh': ['shield'],
  'BDSP': ['brilliant-diamond','shining-pearl'],
  'BD': ['brilliant-diamond'], 'SP': ['shining-pearl'],
  'LA': ['legends-arceus'],
  'SV': ['scarlet','violet'],
};

/**
 * Convert a Bulbapedia game name (from v= param) to an array of PokéAPI slugs.
 */
function resolveGameName(rawName) {
  if (!rawName) return [];
  const name = rawName.trim();
  if (BULBA_GAME_NAME_MAP[name]) return [BULBA_GAME_NAME_MAP[name]];
  if (BULBA_GAME_ABBR_MAP[name]) return BULBA_GAME_ABBR_MAP[name];
  // fallback: lowercase + hyphenate
  return [name.toLowerCase().replace(/[':,!]/g, '').replace(/\s+/g, '-')];
}

/**
 * Clean wiki markup from an area/location string.
 * Handles:
 *   [[Link]]                  → "Link"
 *   [[Link|Display]]          → "Display"
 *   [[Link#anchor|Display]]   → "Display"
 *   {{rt|24|Kanto}}           → "Route 24 (Kanto)"
 *   {{rt|24}}                 → "Route 24"
 *   {{FB|Kanto|Power Plant}}  → "Power Plant"
 *   {{safari|Hoenn}}          → "Safari Zone (Hoenn)"
 *   {{loc|X}}                 → "X"
 *   {{DL|...|Display}}        → "Display"
 *   {{tt|Text|Tooltip}}       → "Text"
 *   {{sup/t|M}}               → ""  (superscript method tag, discard)
 *   {{dotw|Fr}}               → ""  (day-of-week tag, discard)
 *   <br>                      → ", "
 *   <small>...</small>        → " ..."
 */
function cleanAreaString(raw) {
  if (!raw) return '';
  let s = raw;

  // {{rt|N|Region}} → "Route N (Region)"  |  {{rt|N}} → "Route N"
  s = s.replace(/\{\{rt\|(\d+)\|([^}]+)\}\}/g, (_, n, region) => `Route ${n} (${region.trim()})`);
  s = s.replace(/\{\{rt\|(\d+)\}\}/g, (_, n) => `Route ${n}`);

  // {{FB|Region|Place}} → "Place"
  s = s.replace(/\{\{FB\|[^|]+\|([^}]+)\}\}/g, (_, place) => place.trim());

  // {{safari|Region}} → "Safari Zone (Region)"  |  {{safari}} → "Safari Zone"
  s = s.replace(/\{\{safari\|([^}]+)\}\}/g, (_, region) => `Safari Zone (${region.trim()})`);
  s = s.replace(/\{\{safari\}\}/g, 'Safari Zone');

  // {{DL|List|Display}} → "Display"
  s = s.replace(/\{\{DL\|[^|]+\|([^}]+)\}\}/g, (_, display) => display.trim());

  // {{tt|Text|Tooltip}} → "Text"
  s = s.replace(/\{\{tt\|([^|]+)\|[^}]+\}\}/g, (_, text) => text.trim());

  // {{loc|X}} → "X"
  s = s.replace(/\{\{loc\|([^}]+)\}\}/g, (_, loc) => loc.trim());

  // {{pkmn|...}} → discard (link to game feature)
  s = s.replace(/\{\{pkmn\|[^}]+\}\}/g, '');

  // {{sup/t|M}} etc., {{dotw|Fr}} etc. → discard (method/day superscripts)
  s = s.replace(/\{\{(?:sup\/[a-z]+|dotw)\|[^}]+\}\}/g, '');

  // Any remaining {{template}} → discard
  s = s.replace(/\{\{[^}]*\}\}/g, '');

  // [[Link|Display]] → "Display"
  s = s.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, (_, display) => display.trim());

  // [[Link]] → "Link"
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, link) => {
    // strip anchor (#...) if present
    return link.replace(/#.*$/, '').trim();
  });

  // <br> and <br/> → ", "
  s = s.replace(/<br\s*\/?>/gi, ', ');

  // <small>...</small> → content
  s = s.replace(/<small>([^<]*)<\/small>/gi, (_, content) => ` ${content.trim()}`);

  // Strip remaining HTML tags
  s = s.replace(/<[^>]+>/g, '');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Remove asterisk footnote markers (from {{tt|*|...}})
  s = s.replace(/\*/g, '');

  // Clean up empty parentheses like "()" or "( )" that may remain after stripping templates
  s = s.replace(/\(\s*\)/g, '');

  // Remove trailing/leading commas or separators
  s = s.replace(/^[,\s]+|[,\s]+$/g, '');

  // Final collapse
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Extract entries from a single {{Availability/EntryN|...}} template string.
 * Returns array of { game, location, rarity, method, levels, source }.
 * Returns [] for /None variants (meaning "not available").
 */
function parseAvailabilityEntry(templateText) {
  // Skip /None variants — these mean the Pokémon is NOT in that game
  if (/Availability\/Entry\d+\/None/i.test(templateText)) return [];

  // Extract everything between the first | and the closing }}
  const innerMatch = templateText.match(/\{\{Availability\/Entry\d+\|(.+)\}\}$/s);
  if (!innerMatch) return [];

  // Parse key=value pairs. We must split carefully since nested {{ }} and [[ ]] can contain |.
  // Track depth for both {{ }} (curly) and [[ ]] (square bracket) contexts.
  const inner = innerMatch[1];
  const parts = [];
  let curlyDepth = 0, squareDepth = 0, current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    const ch2 = inner[i+1];
    if (ch === '{' && ch2 === '{') { curlyDepth++; current += ch; }
    else if (ch === '}' && ch2 === '}') { curlyDepth--; current += ch; }
    else if (ch === '[' && ch2 === '[') { squareDepth++; current += ch; }
    else if (ch === ']' && ch2 === ']') { squareDepth--; current += ch; }
    else if (ch === '|' && curlyDepth === 0 && squareDepth === 0) { parts.push(current); current = ''; }
    else { current += ch; }
  }
  if (current) parts.push(current);

  const params = {};
  parts.forEach(part => {
    const eq = part.indexOf('=');
    if (eq > -1) {
      const key = part.slice(0, eq).trim().toLowerCase();
      const val = part.slice(eq + 1).trim();
      params[key] = val;
    }
  });

  // Game names: v= is game 1, v2= is game 2 (Entry2), v3= would be game 3 etc.
  const gameNames = [];
  for (let i = 1; i <= 6; i++) {
    const key = i === 1 ? 'v' : `v${i}`;
    if (params[key]) gameNames.push(params[key]);
  }

  const rawArea = params.area || params.location || '';
  if (!rawArea && !gameNames.length) return [];

  const location = cleanAreaString(rawArea);
  // Only include if we have a real location (not just event/trade references we want to keep)
  if (!location) return [];

  const rarity = params.rarity || params.chance || null;
  const results = [];
  gameNames.forEach(rawGame => {
    const slugs = resolveGameName(rawGame);
    slugs.forEach(slug => {
      results.push({
        game: slug,
        location,
        rarity: rarity || null,
        method: null,
        levels: null,
        source: 'bulbapedia',
      });
    });
  });
  return results;
}

/**
 * Strategy 1: {{Availability/EntryN|v=...|v2=...|area=...}} templates.
 * These cover the vast majority of Bulbapedia game-location data.
 * Uses a depth-aware extractor to handle nested {{ }} in area= values.
 */
function strategy1_availabilityEntries(wikitext) {
  const rows = [];
  // Match full {{Availability/EntryN[/None]|...}} including nested {{ }}
  // Two-pass: find start positions, then extract with brace counting
  const startRe = /\{\{Availability\/Entry\d+/gi;
  let startMatch;
  while ((startMatch = startRe.exec(wikitext)) !== null) {
    const start = startMatch.index;
    let depth = 0, i = start;
    while (i < wikitext.length) {
      if (wikitext[i] === '{' && wikitext[i+1] === '{') { depth++; i += 2; }
      else if (wikitext[i] === '}' && wikitext[i+1] === '}') {
        depth--;
        i += 2;
        if (depth === 0) break;
      } else { i++; }
    }
    const templateText = wikitext.slice(start, i);
    rows.push(...parseAvailabilityEntry(templateText));
  }
  return rows;
}

/**
 * Strategy 2: Plain wiki tables in the ==Game locations== section.
 * Fallback for pages that use {| ... |} tables instead of Availability templates.
 */
function strategy2_wikiTables(wikitext) {
  const rows = [];
  const locSecMatch = wikitext.match(/==\s*Game locations?\s*==\s*([\s\S]*?)(?:(?:^|\n)==[^=])/im)
    || wikitext.match(/==\s*Game locations?\s*==([\s\S]*?)(?:==|$)/i);
  if (!locSecMatch) return rows;

  const section = locSecMatch[1];
  // Find table rows: lines starting with |- then | col1 || col2
  const rowRe = /^\|\s*([^|{[\n]+?)\s*\|\|\s*([^|\n]+?)\s*(?:\|\|\s*([^|\n]*))?$/gm;
  let m;
  while ((m = rowRe.exec(section)) !== null) {
    const col1 = m[1].trim();
    const col2 = cleanAreaString(m[2].trim());
    if (!col2 || col2 === '—' || col2 === '-') continue;
    // col1 should look like a game name or abbreviation
    const gameNames = resolveGameName(col1);
    if (!gameNames.length) continue;
    gameNames.forEach(g => rows.push({ game: g, location: col2, rarity: m[3] ? m[3].trim() : null, method: null, levels: null, source: 'bulbapedia' }));
  }
  return rows;
}

/**
 * Strategy 3: Bullet lists under ===Generation N=== or ===Game=== headings within Game locations.
 * e.g.  * {{game|Red|Blue}}: [[Route 24]]
 */
function strategy3_bulletLists(wikitext) {
  const rows = [];
  const locSecMatch = wikitext.match(/==\s*Game locations?\s*==([\s\S]*?)(?:^==(?!=)|$)/im);
  if (!locSecMatch) return rows;

  const section = locSecMatch[1];
  // Bullet items: * games: location
  const bulletRe = /^\*\s*(.+?):\s*(.+)$/gm;
  let m;
  while ((m = bulletRe.exec(section)) !== null) {
    const gamePart = m[1];
    const locPart = cleanAreaString(m[2]);
    if (!locPart) continue;

    // Extract game names from {{game|Red|Blue}} or plain text
    const gameNames = [];
    const gameTemplateRe = /\{\{game\|([^}]+)\}\}/gi;
    let gm;
    while ((gm = gameTemplateRe.exec(gamePart)) !== null) {
      gm[1].split('|').forEach(n => { if (n.trim()) gameNames.push(n.trim()); });
    }
    if (!gameNames.length) {
      // try plain comma/and separated game names
      gamePart.split(/,|and/).forEach(n => {
        const clean = n.replace(/\{\{[^}]+\}\}|\[\[[^\]]+\]\]|'{2,}/g, '').trim();
        if (clean) gameNames.push(clean);
      });
    }

    gameNames.forEach(rawGame => {
      resolveGameName(rawGame).forEach(slug => {
        rows.push({ game: slug, location: locPart, rarity: null, method: null, levels: null, source: 'bulbapedia' });
      });
    });
  }
  return rows;
}

/**
 * Strategy 4: Plain prose — last resort.
 * Matches "In Pokémon X and Y, <name> can be found at [[Location]]"
 */
function strategy4_prose(wikitext, pokemonName) {
  const rows = [];
  const proseRe = /[Ii]n\s+(?:Pok[eé]mon\s+)?([A-Z][A-Za-z\s,]+?),?\s+(?:\S+\s+)?can be found (?:at|in)\s+(.+?)(?:\.|,|$)/g;
  let m;
  while ((m = proseRe.exec(wikitext)) !== null) {
    const loc = cleanAreaString(m[2]);
    if (!loc) continue;
    m[1].split(/\band\b/).forEach(gamePart => {
      resolveGameName(gamePart.trim()).forEach(slug => {
        rows.push({ game: slug, location: loc, rarity: null, method: null, levels: null, source: 'bulbapedia' });
      });
    });
  }
  return rows;
}

function parseGameLocations(wikitext, pokemonName) {
  if (!wikitext) return { rows: [], strategy: null };

  // Strategy 1: Availability/Entry templates (primary — covers 95%+ of pages)
  let rows = strategy1_availabilityEntries(wikitext);
  if (rows.length >= 1) return { rows, strategy: 1 };

  // Strategy 2: Plain wiki tables in Game locations section
  rows = strategy2_wikiTables(wikitext);
  if (rows.length >= 1) return { rows, strategy: 2 };

  // Strategy 3: Bullet lists under generation sub-headings
  rows = strategy3_bulletLists(wikitext);
  if (rows.length >= 1) return { rows, strategy: 3 };

  // Strategy 4: Plain prose
  rows = strategy4_prose(wikitext, pokemonName);
  if (rows.length >= 1) return { rows, strategy: 4 };

  return { rows: [], strategy: null };
}

function parseEvolutionConditions(wikitext) {
  if (!wikitext) return null;
  const evoSection = wikitext.match(/==\s*Evolution\s*==\s*([\s\S]*?)(?:==(?!=)|$)/i);
  if (!evoSection) return null;
  const text = evoSection[1]
    .replace(/\{\{[^}]+\}\}/g, '') // strip templates
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // clean links
    .replace(/'+/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  return text.length > 10 ? text.slice(0, 500) : null;
}

// ─── Showdown slug helper ─────────────────────────────────────────────────────
function toShowdownSlug(name) {
  // Showdown keys are lowercase, no spaces/hyphens/special chars
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Conflict tracking ────────────────────────────────────────────────────────
function withConflict(chosenSource, chosenValue, others) {
  const conflicts = others.filter(o => o.value !== undefined && JSON.stringify(o.value) !== JSON.stringify(chosenValue));
  if (!conflicts.length) return { value: chosenValue };
  return {
    value: chosenValue,
    _conflicts: [{ source: chosenSource, value: chosenValue }, ...conflicts],
  };
}

// ─── Main per-pokémon builder ─────────────────────────────────────────────────
async function buildPokemon(id, showdown) {
  const { pokedex: sdPokedex, learnsets: sdLearnsets, moves: sdMoves } = showdown;

  // 1. PokéAPI base
  vlog(`  fetching pokeapi/pokemon/${id}`);
  const poke = await fetchPokeAPI(`pokemon/${id}`, `pokemon_${id}`);

  vlog(`  fetching pokeapi/pokemon-species/${id}`);
  const species = await fetchPokeAPI(`pokemon-species/${id}`, `species_${id}`);

  vlog(`  fetching pokeapi/pokemon/${id}/encounters`);
  const apiEncounters = await fetchPokeAPI(`pokemon/${id}/encounters`, `encounters_${id}`);

  // Evolution chain
  let evoChain = null;
  if (species?.evolution_chain?.url) {
    const chainId = species.evolution_chain.url.match(/\/(\d+)\/?$/)?.[1];
    if (chainId) {
      vlog(`  fetching evo chain ${chainId}`);
      evoChain = await fetchPokeAPI(`evolution-chain/${chainId}`, `evo_chain_${chainId}`);
    }
  }

  // 2. Showdown lookup
  const sdSlug = toShowdownSlug(poke.name);
  const sdEntry = sdPokedex[sdSlug] || sdPokedex[toShowdownSlug(species?.name || '')] || null;
  const sdLearnset = sdLearnsets[sdSlug]?.learnset || sdLearnsets[toShowdownSlug(species?.name || '')]?.learnset || null;

  // 3. Bulbapedia
  const displayName = (species?.name || poke.name).split('-')[0];
  const bulbaName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
  vlog(`  fetching bulbapedia for ${bulbaName}`);
  const wikitext = await fetchBulbapedia(bulbaName);
  const { rows: bulbaLocations, strategy: bulbaStrategy } = parseGameLocations(wikitext, bulbaName);
  if (wikitext && bulbaLocations.length === 0) {
    log(`WARN bulbapedia location parse empty for ${bulbaName} (#${id}) — falling back to pokeapi`);
  } else if (bulbaLocations.length > 0) {
    vlog(`  bulbapedia strategy=${bulbaStrategy} rows=${bulbaLocations.length}`);
  }
  const bulbaEvoCond = parseEvolutionConditions(wikitext);

  // ─── Reconcile stats ─────────────────────────────────────────────────────
  const apiStats = {};
  poke.stats.forEach(s => { apiStats[s.stat.name] = s.base_stat; });

  // Showdown stat keys: hp, atk, def, spa, spd, spe
  const sdStatMap = { hp: 'hp', atk: 'attack', def: 'defense', spa: 'special-attack', spd: 'special-defense', spe: 'speed' };
  const stats = {};
  if (sdEntry?.baseStats) {
    for (const [sdKey, apiKey] of Object.entries(sdStatMap)) {
      const sdVal = sdEntry.baseStats[sdKey];
      const apiVal = apiStats[apiKey];
      const chosen = sdVal !== undefined ? sdVal : apiVal;
      stats[apiKey] = sdVal !== undefined && apiVal !== undefined && sdVal !== apiVal
        ? { value: chosen, _conflicts: [{ source: 'showdown', value: sdVal }, { source: 'pokeapi', value: apiVal }] }
        : chosen;
    }
  } else {
    poke.stats.forEach(s => { stats[s.stat.name] = s.base_stat; });
  }

  // ─── Types ───────────────────────────────────────────────────────────────
  const apiTypes = poke.types.map(t => t.type.name);
  const sdTypes  = sdEntry?.types?.map(t => t.toLowerCase()) || null;
  const typesField = sdTypes
    ? withConflict('showdown', sdTypes, [{ source: 'pokeapi', value: apiTypes }])
    : { value: apiTypes };

  // ─── Encounters / locations ───────────────────────────────────────────────
  // PokéAPI structured encounters
  const apiLocRows = [];
  if (Array.isArray(apiEncounters)) {
    apiEncounters.forEach(enc => {
      enc.version_details.forEach(vd => {
        vd.encounter_details.forEach(ed => {
          apiLocRows.push({
            game: vd.version.name,
            location: enc.location_area.name.replace(/-area$/, '').replace(/-/g, ' '),
            method: ed.method.name,
            min_level: ed.min_level,
            max_level: ed.max_level,
            chance: ed.chance,
            source: 'pokeapi',
          });
        });
      });
    });
  }

  // ── Location reconciliation: Bulbapedia is AUTHORITATIVE ────────────────────
  // 1. Build a lookup for PokéAPI rows keyed by "game|location" for detail merge.
  const apiByKey = new Map();
  apiLocRows.forEach(r => {
    const key = `${r.game}|${r.location.toLowerCase()}`;
    if (!apiByKey.has(key)) apiByKey.set(key, []);
    apiByKey.get(key).push(r);
  });

  // 2. For each Bulbapedia row, merge in PokéAPI method/level/chance where key matches.
  const mergedBulba = bulbaLocations.map(br => {
    const key = `${br.game}|${br.location.toLowerCase()}`;
    const apiMatches = apiByKey.get(key) || [];
    if (apiMatches.length > 0) {
      const best = apiMatches[0];
      return {
        ...br,
        method: best.method || null,
        levels: best.min_level != null ? `${best.min_level}-${best.max_level}` : null,
        chance: best.chance ?? null,
      };
    }
    return br;
  });

  // 3. PokéAPI-only rows (game NOT covered by Bulbapedia) are kept as supplemental.
  const bulbaGameSet = new Set(bulbaLocations.map(r => r.game));
  const supplemental = apiLocRows.filter(r => !bulbaGameSet.has(r.game));

  const locations = [...mergedBulba, ...supplemental];

  // ─── Learnset / Moves ─────────────────────────────────────────────────────
  // Showdown learnset format: { moveName: ['9L1', '8M', ...] }
  // Codes: <gen><method><detail>  L=level-up, M=machine, T=tutor, E=egg, S=special
  const learnset = [];
  if (sdLearnset) {
    for (const [moveName, codes] of Object.entries(sdLearnset)) {
      const sdMoveData = sdMoves[moveName] || {};
      const apiMove = poke.moves.find(m => m.move.name === moveName || m.move.name === moveName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
      codes.forEach(code => {
        const gen  = parseInt(code[0], 10);
        const meth = code[1];
        const detail = code.slice(2);
        const methodMap = { L: 'level-up', M: 'machine', T: 'tutor', E: 'egg', S: 'special', R: 'reminder' };
        learnset.push({
          move: moveName,
          type: (sdMoveData.type || '').toLowerCase(),
          category: (sdMoveData.category || '').toLowerCase(),
          power: sdMoveData.basePower || null,
          accuracy: sdMoveData.accuracy || null,
          pp: sdMoveData.pp || null,
          gen,
          method: methodMap[meth] || meth,
          level: meth === 'L' ? parseInt(detail, 10) : null,
          source: 'showdown',
        });
      });
    }
  } else if (poke.moves) {
    // fallback to PokéAPI moves
    poke.moves.forEach(m => {
      m.version_group_details.forEach(vgd => {
        learnset.push({
          move: m.move.name,
          gen: null,
          method: vgd.move_learn_method.name,
          level: vgd.level_learned_at || null,
          version_group: vgd.version_group.name,
          source: 'pokeapi',
        });
      });
    });
  }

  // ─── Flavor texts ─────────────────────────────────────────────────────────
  const flavorTexts = (species?.flavor_text_entries || [])
    .filter(e => e.language.name === 'en')
    .map(e => ({
      game: e.version.name,
      text: e.flavor_text.replace(/\f|\n/g, ' ').replace(/\s+/g, ' ').trim(),
    }));

  // ─── Evolution ────────────────────────────────────────────────────────────
  const evolution = {
    chain: evoChain?.chain || null,
    bulbapedia_condition: bulbaEvoCond || null,
  };

  // ─── Abilities ────────────────────────────────────────────────────────────
  const abilities = poke.abilities.map(a => ({
    name: a.ability.name,
    is_hidden: a.is_hidden,
    slot: a.slot,
  }));

  // ─── Height / Weight ─────────────────────────────────────────────────────
  const sdHeight = sdEntry?.heightm || null;
  const apiHeight = poke.height / 10;
  const sdWeight = sdEntry?.weightkg || null;
  const apiWeight = poke.weight / 10;

  const heightField = sdHeight !== null
    ? withConflict('showdown', sdHeight, [{ source: 'pokeapi', value: apiHeight }])
    : apiHeight;
  const weightField = sdWeight !== null
    ? withConflict('showdown', sdWeight, [{ source: 'pokeapi', value: apiWeight }])
    : apiWeight;

  // ─── Assemble final doc ───────────────────────────────────────────────────
  const doc = {
    id: poke.id,
    name: poke.name,
    display_name: species?.name || poke.name,
    types: typesField.value,
    ...(typesField._conflicts ? { types_conflicts: typesField._conflicts } : {}),
    height_m: typeof heightField === 'object' && heightField.value !== undefined ? heightField.value : heightField,
    ...(typeof heightField === 'object' && heightField._conflicts ? { height_conflicts: heightField._conflicts } : {}),
    weight_kg: typeof weightField === 'object' && weightField.value !== undefined ? weightField.value : weightField,
    ...(typeof weightField === 'object' && weightField._conflicts ? { weight_conflicts: weightField._conflicts } : {}),
    stats,
    abilities,
    sprite_url: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${poke.id}.png`,
    artwork_url: poke.sprites?.other?.['official-artwork']?.front_default || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${poke.id}.png`,
    species: {
      habitat: species?.habitat?.name || null,
      color: species?.color?.name || null,
      shape: species?.shape?.name || null,
      generation: species?.generation?.name || null,
      growth_rate: species?.growth_rate?.name || null,
      capture_rate: species?.capture_rate ?? null,
      base_happiness: species?.base_happiness ?? null,
      egg_groups: (species?.egg_groups || []).map(g => g.name),
      hatch_counter: species?.hatch_counter ?? null,
      gender_rate: species?.gender_rate ?? null,
      is_legendary: species?.is_legendary || false,
      is_mythical: species?.is_mythical || false,
    },
    locations,
    learnset,
    flavor_texts: flavorTexts,
    evolution,
    _sources: {
      pokeapi: true,
      bulbapedia: wikitext !== null,
      bulbapedia_location_strategy: bulbaStrategy,
      bulbapedia_location_rows: bulbaLocations.length,
      showdown: sdEntry !== null,
    },
    _generated_at: new Date().toISOString(),
  };

  return doc;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const startTime = Date.now();
let errors = [];
let successes = 0;

// Handle SIGINT
process.on('SIGINT', () => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\nInterrupted. ${successes} succeeded, ${errors.length} errored, ${elapsed}s elapsed.`);
  if (errors.length) log('Errors:', errors.map(e => `#${e.id}(${e.reason})`).join(', '));
  process.exit(1);
});

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(POKEMON_DIR, { recursive: true });

  if (explicitIds) {
    log(`IDs: ${explicitIds.join(', ')}  Force: ${FORCE}  Verbose: ${VERBOSE}`);
  } else {
    log(`Range: ${rangeStart}–${rangeEnd}  Force: ${FORCE}  Verbose: ${VERBOSE}`);
  }

  // Load Showdown data upfront
  const showdown = await loadShowdownData();

  const idList = explicitIds || Array.from({ length: rangeEnd - rangeStart + 1 }, (_, i) => rangeStart + i);
  const total = idList.length;
  const indexEntries = [];

  for (const id of idList) {
    try {
      vlog(`Processing #${id} …`);
      const doc = await buildPokemon(id, showdown);
      const outPath = path.join(POKEMON_DIR, `${doc.id}.json`);
      await fs.writeFile(outPath, JSON.stringify(doc, null, 2));
      indexEntries.push({
        id: doc.id,
        name: doc.name,
        types: doc.types,
        sprite_url: doc.sprite_url,
      });
      successes++;

      const done = idList.indexOf(id) + 1;
      if (done % 10 === 0 || done === total) {
        const pct = ((done / total) * 100).toFixed(0);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = done / elapsed;
        const remaining = (total - done) / rate;
        const etaMin = Math.ceil(remaining / 60);
        log(`${done}/${total} done (${pct}%, eta ${etaMin}m)`);
      }
    } catch (err) {
      log(`error pokemon=${id} reason=${err.message}`);
      errors.push({ id, reason: err.message });
    }
  }

  // Write index
  const index = {
    generated_at: new Date().toISOString(),
    count: indexEntries.length,
    pokemon: indexEntries,
  };
  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));
  log(`index.json written (${indexEntries.length} entries)`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Done. ${successes} succeeded, ${errors.length} errored, ${elapsed}s total.`);
  if (errors.length) {
    log('Errors:', errors.map(e => `#${e.id}(${e.reason})`).join(', '));
  }
}

main().catch(err => { console.error('[BUILD] fatal:', err); process.exit(1); });
