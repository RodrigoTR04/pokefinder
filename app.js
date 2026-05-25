/* PokéFinder — app.js */

const CACHE_KEY_THEME = 'pokefinder:theme';

// TTL constants kept for any residual code references
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
const ARTWORK_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/';

const TYPE_COLORS = {
  normal: '#A8A878', fire: '#F08030', water: '#6890F0', electric: '#F8D030',
  grass: '#78C850', ice: '#98D8D8', fighting: '#C03028', poison: '#A040A0',
  ground: '#E0C068', flying: '#A890F0', psychic: '#F85888', bug: '#A8B820',
  rock: '#B8A038', ghost: '#705898', dragon: '#7038F8', dark: '#705848',
  steel: '#B8B8D0', fairy: '#EE99AC',
};

const GAME_ORDER = [
  'red','blue','yellow',
  'gold','silver','crystal',
  'ruby','sapphire','emerald','firered','leafgreen',
  'diamond','pearl','platinum','heartgold','soulsilver',
  'black','white','black-2','white-2',
  'x','y','omega-ruby','alpha-sapphire',
  'sun','moon','ultra-sun','ultra-moon','lets-go-pikachu','lets-go-eevee',
  'sword','shield',
  'brilliant-diamond','shining-pearl','legends-arceus',
  'scarlet','violet',
  'legends-z-a',
];

const GAME_DISPLAY_NAMES = {
  'red': 'Red', 'blue': 'Blue', 'yellow': 'Yellow',
  'gold': 'Gold', 'silver': 'Silver', 'crystal': 'Crystal',
  'ruby': 'Ruby', 'sapphire': 'Sapphire', 'emerald': 'Emerald',
  'firered': 'FireRed', 'leafgreen': 'LeafGreen',
  'diamond': 'Diamond', 'pearl': 'Pearl', 'platinum': 'Platinum',
  'heartgold': 'HeartGold', 'soulsilver': 'SoulSilver',
  'black': 'Black', 'white': 'White', 'black-2': 'Black 2', 'white-2': 'White 2',
  'x': 'X', 'y': 'Y', 'omega-ruby': 'Omega Ruby', 'alpha-sapphire': 'Alpha Sapphire',
  'sun': 'Sun', 'moon': 'Moon', 'ultra-sun': 'Ultra Sun', 'ultra-moon': 'Ultra Moon',
  'lets-go-pikachu': "Let's Go, Pikachu!", 'lets-go-eevee': "Let's Go, Eevee!",
  'sword': 'Sword', 'shield': 'Shield',
  'brilliant-diamond': 'Brilliant Diamond', 'shining-pearl': 'Shining Pearl',
  'legends-arceus': 'Legends: Arceus',
  'scarlet': 'Scarlet', 'violet': 'Violet',
  'legends-z-a': 'Legends: Z-A',
};

const POKEDEX_FOR_GAME = {
  'sword': ['galar'], 'shield': ['galar'],
  'brilliant-diamond': ['updated-sinnoh'], 'shining-pearl': ['updated-sinnoh'],
  'legends-arceus': ['hisui'],
  'scarlet': ['paldea'], 'violet': ['paldea'],
};

const DLC_POKEDEX = {
  'isle-of-armor': ['sword','shield'],
  'crown-tundra': ['sword','shield'],
  'kitakami': ['scarlet','violet'],
  'blueberry': ['scarlet','violet'],
};

const STAT_ABBR = { hp: 'HP', attack: 'Atk', defense: 'Def', 'special-attack': 'SpA', 'special-defense': 'SpD', speed: 'Spe' };

const els = {
  html: document.documentElement,
  themeToggle: document.getElementById('themeToggle'),
  searchInput: document.getElementById('searchInput'),
  searchSpinner: document.getElementById('searchSpinner'),
  suggestionsList: document.getElementById('suggestionsList'),
  detailsSection: document.getElementById('detailsSection'),
  pokeArtwork: document.getElementById('pokeArtwork'),
  pokeName: document.getElementById('pokeName'),
  pokeId: document.getElementById('pokeId'),
  typeBadges: document.getElementById('typeBadges'),
  appearsInSection: document.getElementById('appearsInSection'),
  pokeHeight: document.getElementById('pokeHeight'),
  pokeWeight: document.getElementById('pokeWeight'),
  abilitiesList: document.getElementById('abilitiesList'),
  statsList: document.getElementById('statsList'),
  speciesGrid: document.getElementById('speciesGrid'),
  evoChainWrap: document.getElementById('evoChainWrap'),
  movesFilters: document.getElementById('movesFilters'),
  movesContent: document.getElementById('movesContent'),
  encountersContent: document.getElementById('encountersContent'),
  pokedexEntries: document.getElementById('pokedexEntries'),
  tabStrip: document.getElementById('tabStrip'),
};

// allNames is populated from window.POKEDEX_INDEX on boot
let allNames = [];
// nameToId maps lowercase name -> id for fast lookup
let nameToId = {};
let currentSuggestions = [];
let activeSuggestionIdx = -1;
let debounceTimer = null;
let lastSearchedName = null;

let currentPoke = null;
let currentSpecies = null;
let currentEncounters = null;
let movesLoaded = false;
let movesData = null;
let activeTab = 'overview';

/* ——— Theme ——— */
function initTheme() {
  const stored = localStorage.getItem(CACHE_KEY_THEME);
  const preferred = stored || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  els.html.setAttribute('data-theme', preferred);
}

els.themeToggle.addEventListener('click', () => {
  const next = els.html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  els.html.setAttribute('data-theme', next);
  localStorage.setItem(CACHE_KEY_THEME, next);
});

/* ——— Bundled data loading ——— */

// Load all chunks in parallel by injecting script tags.
// Returns a Promise that resolves when all chunks are loaded.
function loadChunks() {
  const manifest = window.POKEDEX_MANIFEST;
  if (!manifest || !manifest.chunks || !manifest.chunks.length) {
    console.warn('[pokefinder] POKEDEX_MANIFEST not available — chunks not loaded');
    return Promise.resolve();
  }

  const base = (function detectBase() {
    // Works for file://, http://, and GitHub Pages
    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
      if (s.src && s.src.includes('pokedex-manifest.js')) {
        return s.src.replace('pokedex-manifest.js', '');
      }
    }
    // Fallback: derive from current document URL
    const loc = window.location.href;
    return loc.substring(0, loc.lastIndexOf('/') + 1) + 'data/';
  })();

  const promises = manifest.chunks.map(filename => {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = base + filename;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load chunk: ' + filename));
      document.head.appendChild(script);
    });
  });

  return Promise.all(promises);
}

/* ——— Name list from POKEDEX_INDEX ——— */
function loadNames() {
  const index = window.POKEDEX_INDEX;
  if (index && Array.isArray(index) && index.length > 0) {
    allNames = index.map(p => p.name);
    nameToId = {};
    index.forEach(p => { nameToId[p.name] = p.id; });
    console.log(`[pokefinder] name list from POKEDEX_INDEX (${allNames.length} entries)`);
    return;
  }
  throw new Error('POKEDEX_INDEX not available. Make sure pokedex-index.js is loaded before app.js.');
}

/* ——— Search & Suggestions ——— */
function getIdFromName(name) {
  return nameToId[name] || null;
}

function filterNames(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  if (allNames.length === 0) {
    console.warn('[pokefinder] filterNames called but allNames is empty — name list may not have loaded');
    return [];
  }
  const starts = allNames.filter(n => n.startsWith(q));
  const contains = allNames.filter(n => !n.startsWith(q) && n.includes(q));
  return [...starts, ...contains].slice(0, 8);
}

function capitalize(str) {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function renderSuggestions(names) {
  currentSuggestions = names;
  activeSuggestionIdx = -1;
  if (names.length === 0) { hideSuggestions(); return; }
  els.suggestionsList.innerHTML = names.map((name, i) => {
    const id = getIdFromName(name);
    const spriteUrl = id ? `${SPRITE_BASE}${id}.png` : '';
    return `<li class="suggestion-item" role="option" aria-selected="false" data-name="${name}" data-idx="${i}">
      ${spriteUrl ? `<img class="suggestion-sprite" src="${spriteUrl}" alt="" loading="lazy" />` : '<span class="suggestion-sprite"></span>'}
      <span class="suggestion-name">${capitalize(name)}</span>
    </li>`;
  }).join('');
  els.suggestionsList.removeAttribute('hidden');
  els.searchInput.setAttribute('aria-expanded', 'true');
  els.suggestionsList.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('mousedown', e => { e.preventDefault(); selectSuggestion(item.dataset.name); });
  });
}

function hideSuggestions() {
  els.suggestionsList.setAttribute('hidden', '');
  els.searchInput.setAttribute('aria-expanded', 'false');
  currentSuggestions = [];
  activeSuggestionIdx = -1;
}

function updateActiveSuggestion(idx) {
  els.suggestionsList.querySelectorAll('.suggestion-item').forEach((item, i) => {
    item.setAttribute('aria-selected', String(i === idx));
    if (i === idx) item.classList.add('active'); else item.classList.remove('active');
  });
}

function selectSuggestion(name) {
  els.searchInput.value = capitalize(name);
  hideSuggestions();
  loadPokemon(name);
}

els.searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const val = els.searchInput.value.trim();
  if (!val) { hideSuggestions(); return; }
  debounceTimer = setTimeout(() => renderSuggestions(filterNames(val)), 300);
});

els.searchInput.addEventListener('keydown', e => {
  if (!currentSuggestions.length) {
    if (e.key === 'Enter') { const val = els.searchInput.value.trim().toLowerCase(); if (val) loadPokemon(val); }
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSuggestionIdx = Math.min(activeSuggestionIdx + 1, currentSuggestions.length - 1);
    updateActiveSuggestion(activeSuggestionIdx);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestionIdx = Math.max(activeSuggestionIdx - 1, -1);
    updateActiveSuggestion(activeSuggestionIdx);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = activeSuggestionIdx >= 0 ? currentSuggestions[activeSuggestionIdx] : currentSuggestions[0];
    if (target) selectSuggestion(target);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

els.searchInput.addEventListener('blur', () => { setTimeout(hideSuggestions, 120); });

/* ——— Tab strip ——— */
els.tabStrip.addEventListener('click', e => {
  const chip = e.target.closest('.tab-chip');
  if (!chip) return;
  const tab = chip.dataset.tab;
  switchTab(tab);
});

function switchTab(tab) {
  activeTab = tab;
  els.tabStrip.querySelectorAll('.tab-chip').forEach(c => {
    const active = c.dataset.tab === tab;
    c.classList.toggle('active', active);
    c.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tab}`);
  });
  if (tab === 'moves' && !movesLoaded && currentPoke) {
    renderMovesTab(currentPoke);
  }
}

/* ——— UI State Machine ——— */
// state: 'loading' | 'ready' (idle/error agora silent)
function setUiState(state, errorMsg) {
  if (state === 'ready') {
    els.detailsSection.removeAttribute('hidden');
  } else {
    els.detailsSection.setAttribute('hidden', '');
    if (state === 'error' && errorMsg) console.warn('PokéFinder:', errorMsg);
  }
}

/* ——— Pokémon Data Loading ——— */
function loadPokemon(name) {
  const normalized = name.toLowerCase().trim();
  lastSearchedName = normalized;
  movesLoaded = false;
  movesData = null;

  // Clear stale content from all tab panes before showing loading state
  [els.statsList, els.speciesGrid, els.evoChainWrap,
   els.movesFilters, els.movesContent,
   els.encountersContent, els.pokedexEntries,
   els.typeBadges, els.abilitiesList, els.appearsInSection].forEach(el => {
    if (el) el.innerHTML = '';
  });

  setUiState('loading');
  switchTab('overview');

  // Resolve id from name
  const id = nameToId[normalized];
  if (!id) {
    setUiState('error', `"${capitalize(normalized)}" not found. Check the spelling and try again.`);
    return;
  }

  const doc = window.POKEDEX && window.POKEDEX[id];
  if (!doc) {
    setUiState('error', `Data for "${capitalize(normalized)}" not loaded yet. The Pokédex may still be loading — try again in a moment.`);
    return;
  }

  renderFromLocalDoc(doc);
  setUiState('ready');
  els.detailsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ——— Conflict chip helper ——— */
function conflictChip(conflicts) {
  if (!conflicts || !conflicts.length) return '';
  const detail = conflicts.map(c => `${c.source}: ${JSON.stringify(c.value)}`).join(' | ');
  return `<span class="conflict-chip" title="Sources disagree: ${detail.replace(/"/g, '&quot;')}">⚠ conflict</span>`;
}

/* ——— Render from local static doc ——— */
function renderFromLocalDoc(doc) {
  // Build poke-like object the existing renderers expect
  const poke = {
    id: doc.id,
    name: doc.name,
    height: Math.round((doc.height_m || 0) * 10),
    weight: Math.round((doc.weight_kg || 0) * 10),
    types: (doc.types || []).map(t => ({ type: { name: t } })),
    abilities: (doc.abilities || []).map(a => ({ ability: { name: a.name }, is_hidden: a.is_hidden, slot: a.slot })),
    stats: Object.entries(doc.stats || {}).map(([name, val]) => ({
      stat: { name },
      base_stat: typeof val === 'object' ? val.value : val,
    })),
    sprites: { other: { 'official-artwork': { front_default: doc.artwork_url } } },
    moves: [], // handled separately below
    game_indices: [],
    _localDoc: doc, // carry along for extended rendering
  };

  const species = doc.species ? {
    name: doc.name,
    habitat: doc.species.habitat ? { name: doc.species.habitat } : null,
    color: doc.species.color ? { name: doc.species.color } : null,
    shape: doc.species.shape ? { name: doc.species.shape } : null,
    generation: doc.species.generation ? { name: doc.species.generation } : null,
    growth_rate: doc.species.growth_rate ? { name: doc.species.growth_rate } : null,
    capture_rate: doc.species.capture_rate,
    base_happiness: doc.species.base_happiness,
    egg_groups: (doc.species.egg_groups || []).map(n => ({ name: n })),
    hatch_counter: doc.species.hatch_counter,
    gender_rate: doc.species.gender_rate,
    pokedex_numbers: [],
    flavor_text_entries: (doc.flavor_texts || []).map(ft => ({
      language: { name: 'en' },
      version: { name: ft.game },
      flavor_text: ft.text,
    })),
    evolution_chain: doc.evolution?.chain ? { url: '__local__' } : null,
    _evoChainLocal: doc.evolution?.chain || null,
  } : null;

  // Convert local locations to encounters format expected by renderEncounters
  const encounters = [];
  const byLocGame = {};
  (doc.locations || []).forEach(loc => {
    const key = `${loc.game}__${loc.location}`;
    if (!byLocGame[key]) byLocGame[key] = { game: loc.game, location: loc.location, rarity: loc.rarity };
  });
  // Group by location area for renderEncounters
  const locAreaMap = {};
  (doc.locations || []).forEach(loc => {
    const areaKey = loc.location;
    if (!locAreaMap[areaKey]) locAreaMap[areaKey] = { location_area: { name: loc.location.replace(/ /g, '-').toLowerCase() }, version_details: [] };
    let vd = locAreaMap[areaKey].version_details.find(v => v.version.name === loc.game);
    if (!vd) {
      vd = { version: { name: loc.game }, encounter_details: [{ method: { name: 'walk' }, min_level: 0, max_level: 0, chance: loc.rarity ? parseInt(loc.rarity) || 0 : 0 }] };
      locAreaMap[areaKey].version_details.push(vd);
    }
  });
  Object.values(locAreaMap).forEach(e => encounters.push(e));

  currentPoke = poke;
  currentSpecies = species;
  currentEncounters = encounters;

  // Render main details
  const artwork = doc.artwork_url || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${doc.id}.png`;
  els.pokeArtwork.src = artwork;
  els.pokeArtwork.alt = capitalize(poke.name);

  // Name + type badges with optional conflict chips
  els.pokeName.textContent = capitalize(poke.name);
  els.pokeId.textContent = `#${String(poke.id).padStart(4, '0')}`;

  let typesHTML = poke.types.map(t => {
    const type = t.type.name;
    const color = TYPE_COLORS[type] || '#888';
    return `<span class="type-badge" style="background:${color}">${capitalize(type)}</span>`;
  }).join('');
  if (doc.types_conflicts) typesHTML += conflictChip(doc.types_conflicts);
  els.typeBadges.innerHTML = typesHTML;

  // Appears in from local locations
  renderAppearsInFromLocal(doc, encounters);

  // Height / weight with conflict chips
  const heightVal = doc.height_m != null ? `${Number(doc.height_m).toFixed(1)} m` : '—';
  const weightVal = doc.weight_kg != null ? `${Number(doc.weight_kg).toFixed(1)} kg` : '—';
  els.pokeHeight.innerHTML = heightVal + (doc.height_conflicts ? conflictChip(doc.height_conflicts) : '');
  els.pokeWeight.innerHTML = weightVal + (doc.weight_conflicts ? conflictChip(doc.weight_conflicts) : '');

  els.abilitiesList.innerHTML = poke.abilities.map(a => {
    const hidden = a.is_hidden ? '<span class="ability-hidden-badge">Hidden</span>' : '';
    return `<li class="ability-item">${capitalize(a.ability.name)} ${hidden}</li>`;
  }).join('');

  // Stats with conflict chips
  renderStatsFromLocal(doc.stats);
  renderSpeciesInfo(species);

  // Evolution — use local chain if present, else skip
  if (doc.evolution?.chain) {
    els.evoChainWrap.innerHTML = '';
    const html = buildEvoChainHTML(doc.evolution.chain);
    els.evoChainWrap.innerHTML = html;
    els.evoChainWrap.querySelectorAll('.evo-card-item').forEach(card => {
      card.addEventListener('click', () => loadPokemon(card.dataset.name));
    });
    if (doc.evolution.bulbapedia_condition) {
      els.evoChainWrap.insertAdjacentHTML('beforeend',
        `<p class="evo-condition-note" style="margin-top:8px;font-size:.82rem;color:var(--text-secondary)">Bulbapedia: ${doc.evolution.bulbapedia_condition}</p>`);
    }
  } else {
    els.evoChainWrap.innerHTML = '<p class="no-encounters">No evolution data available.</p>';
  }

  renderEncounters(encounters);
  renderPokedexEntries(species);

  // Moves tab from bundled learnset (lazy — will load on tab switch)
  poke._learnsetLocal = doc.learnset || [];
  poke._moveMeta = doc.move_meta || {};
}

function renderAppearsInFromLocal(doc, encounters) {
  const wildGames = new Set((doc.locations || []).map(l => l.game));
  const gameIndexGames = new Set();
  const pokedexGames = new Set();

  const badges = GAME_ORDER.map(game => {
    const displayName = GAME_DISPLAY_NAMES[game] || capitalize(game);
    if (game === 'legends-z-a') return `<span class="appears-badge gray" title="Data not yet available">${displayName}</span>`;
    if (wildGames.has(game)) return `<span class="appears-badge green" title="Encounterable in the wild">${displayName}</span>`;
    return `<span class="appears-badge gray" title="Not in this game">${displayName}</span>`;
  }).join('');

  els.appearsInSection.innerHTML = `<div class="appears-in-title">Appears in</div><div class="appears-in-grid">${badges}</div>`;
}

function renderStatsFromLocal(stats) {
  if (!stats) { els.statsList.innerHTML = ''; return; }
  const STAT_ORDER = ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'];
  const statEntries = STAT_ORDER.map(key => ({ name: key, val: stats[key] })).filter(s => s.val !== undefined);
  els.statsList.innerHTML = statEntries.map(({ name, val }) => {
    const hasConflict = typeof val === 'object' && val._conflicts;
    const numVal = hasConflict ? val.value : (typeof val === 'object' && val.value !== undefined ? val.value : val);
    const label = STAT_ABBR[name] || capitalize(name);
    const pct = Math.min((numVal / 255) * 100, 100).toFixed(2);
    const tier = numVal >= 100 ? 'tier-high' : numVal >= 50 ? 'tier-mid' : 'tier-low';
    const chip = hasConflict ? conflictChip(val._conflicts) : '';
    return `<div class="stat-row">
      <span class="stat-label">${label}</span>
      <div class="stat-bar-track"><div class="stat-bar-fill ${tier}" data-width="${pct}"></div></div>
      <span class="stat-value">${numVal}${chip}</span>
    </div>`;
  }).join('');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.statsList.querySelectorAll('.stat-bar-fill').forEach(bar => {
        bar.style.width = bar.dataset.width + '%';
      });
    });
  });
}

/* ——— Render ——— */
function renderDetails(poke, species, encounters) {
  const artwork = poke.sprites?.other?.['official-artwork']?.front_default
    || `${ARTWORK_BASE}${poke.id}.png`;
  els.pokeArtwork.src = artwork;
  els.pokeArtwork.alt = capitalize(poke.name);

  els.pokeName.textContent = capitalize(poke.name);
  els.pokeId.textContent = `#${String(poke.id).padStart(4, '0')}`;

  els.typeBadges.innerHTML = poke.types.map(t => {
    const type = t.type.name;
    const color = TYPE_COLORS[type] || '#888';
    return `<span class="type-badge" style="background:${color}">${capitalize(type)}</span>`;
  }).join('');

  renderAppearsIn(poke, species, encounters);

  els.pokeHeight.textContent = `${(poke.height / 10).toFixed(1)} m`;
  els.pokeWeight.textContent = `${(poke.weight / 10).toFixed(1)} kg`;

  els.abilitiesList.innerHTML = poke.abilities.map(a => {
    const hidden = a.is_hidden ? '<span class="ability-hidden-badge">Hidden</span>' : '';
    return `<li class="ability-item">${capitalize(a.ability.name)} ${hidden}</li>`;
  }).join('');

  renderStats(poke.stats);
  renderSpeciesInfo(species);
  renderEvolution(species);
  renderEncounters(encounters);
  renderPokedexEntries(species);
}

/* ——— Appears In ——— */
function renderAppearsIn(poke, species, encounters) {
  const wildGames = new Set();
  if (encounters) {
    encounters.forEach(enc => {
      enc.version_details.forEach(vd => wildGames.add(vd.version.name));
    });
  }

  const gameIndexGames = new Set((poke.game_indices || []).map(gi => gi.version.name));

  const pokedexGames = new Set();
  if (species && species.pokedex_numbers) {
    species.pokedex_numbers.forEach(pn => {
      const dexName = pn.pokedex.name;
      const directGames = POKEDEX_FOR_GAME[dexName];
      if (directGames) directGames.forEach(g => pokedexGames.add(g));
      const dlcGames = DLC_POKEDEX[dexName];
      if (dlcGames) dlcGames.forEach(g => pokedexGames.add(g));
    });
  }

  const badges = GAME_ORDER.map(game => {
    const displayName = GAME_DISPLAY_NAMES[game] || capitalize(game);
    if (game === 'legends-z-a') {
      return `<span class="appears-badge gray" title="Data not yet available in PokéAPI">${displayName}</span>`;
    }
    if (wildGames.has(game)) {
      return `<span class="appears-badge green" title="Encounterable in the wild">${displayName}</span>`;
    }
    if (gameIndexGames.has(game) || pokedexGames.has(game)) {
      return `<span class="appears-badge yellow" title="Obtainable but not wild">${displayName}</span>`;
    }
    return `<span class="appears-badge gray" title="Not in this game">${displayName}</span>`;
  }).join('');

  els.appearsInSection.innerHTML = `
    <div class="appears-in-title">Appears in</div>
    <div class="appears-in-grid">${badges}</div>
  `;
}

/* ——— Stats ——— */
function renderStats(stats) {
  els.statsList.innerHTML = stats.map(s => {
    const label = STAT_ABBR[s.stat.name] || capitalize(s.stat.name);
    const val = s.base_stat;
    const pct = Math.min((val / 255) * 100, 100).toFixed(2);
    const tier = val >= 100 ? 'tier-high' : val >= 50 ? 'tier-mid' : 'tier-low';
    return `<div class="stat-row">
      <span class="stat-label">${label}</span>
      <div class="stat-bar-track"><div class="stat-bar-fill ${tier}" data-width="${pct}"></div></div>
      <span class="stat-value">${val}</span>
    </div>`;
  }).join('');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.statsList.querySelectorAll('.stat-bar-fill').forEach(bar => {
        bar.style.width = bar.dataset.width + '%';
      });
    });
  });
}

/* ——— Species Info ——— */
function renderSpeciesInfo(species) {
  if (!species) { els.speciesGrid.innerHTML = ''; return; }

  const genderRate = species.gender_rate;
  let genderText;
  if (genderRate === -1) {
    genderText = 'Genderless';
  } else {
    const female = (genderRate * 12.5).toFixed(1);
    const male = (100 - genderRate * 12.5).toFixed(1);
    genderText = `${male}% M / ${female}% F`;
  }

  const items = [
    { label: 'Habitat', value: species.habitat?.name ? capitalize(species.habitat.name) : '—' },
    { label: 'Color', value: capitalize(species.color?.name || '—') },
    { label: 'Shape', value: species.shape?.name ? capitalize(species.shape.name) : '—' },
    { label: 'Generation', value: formatGeneration(species.generation?.name) },
    { label: 'Growth Rate', value: capitalize(species.growth_rate?.name || '—') },
    { label: 'Capture Rate', value: species.capture_rate != null ? `${((species.capture_rate / 255) * 100).toFixed(1)}%` : '—' },
    { label: 'Base Happiness', value: species.base_happiness != null ? String(species.base_happiness) : '—' },
    { label: 'Egg Groups', value: species.egg_groups?.length ? species.egg_groups.map(g => capitalize(g.name)).join(', ') : '—' },
    { label: 'Hatch Counter', value: species.hatch_counter != null ? `${species.hatch_counter} cycles` : '—' },
    { label: 'Gender', value: genderText },
  ];

  els.speciesGrid.innerHTML = items.map(item => `
    <div class="species-item">
      <span class="species-item-label">${item.label}</span>
      <span class="species-item-value">${item.value}</span>
    </div>
  `).join('');
}

function formatGeneration(name) {
  if (!name) return '—';
  const roman = name.replace('generation-', '').toUpperCase();
  const map = { I:'I', II:'II', III:'III', IV:'IV', V:'V', VI:'VI', VII:'VII', VIII:'VIII', IX:'IX' };
  return `Generation ${map[roman] || roman}`;
}

/* ——— Evolution Chain ——— */
async function renderEvolution(species) {
  els.evoChainWrap.innerHTML = '<div class="no-encounters">Loading evolution chain…</div>';
  if (!species || !species.evolution_chain?.url) {
    els.evoChainWrap.innerHTML = '<p class="no-encounters">No evolution data available.</p>';
    return;
  }

  try {
    const cacheKey = `pokefinder:evo:${species.evolution_chain.url}`;
    let chainData = getCachedData(cacheKey, CACHE_TTL);
    if (!chainData) {
      const res = await fetch(species.evolution_chain.url);
      if (!res.ok) throw new Error('Failed to fetch evolution chain');
      chainData = await res.json();
      setCachedData(cacheKey, chainData, CACHE_TTL);
    }
    const html = buildEvoChainHTML(chainData.chain);
    els.evoChainWrap.innerHTML = html;
    els.evoChainWrap.querySelectorAll('.evo-card-item').forEach(card => {
      card.addEventListener('click', () => loadPokemon(card.dataset.name));
    });
  } catch (e) {
    els.evoChainWrap.innerHTML = '<p class="no-encounters">Could not load evolution chain.</p>';
  }
}

function buildEvoChainHTML(chain) {
  const stages = [];
  collectChainStages(chain, stages, null);
  return renderEvoStages(stages);
}

function collectChainStages(node, stages, parentName) {
  const name = node.species.name;
  const id = extractIdFromUrl(node.species.url);
  stages.push({ name, id, evolvesTo: node.evolves_to, details: node.evolution_details, parentName });
  node.evolves_to.forEach(child => collectChainStages(child, stages, name));
}

function renderEvoStages(stages) {
  if (!stages.length) return '<p class="no-encounters">No evolution data.</p>';

  const roots = stages.filter(s => !s.parentName);
  if (roots.length === 0) return '';

  return buildStageHTML(roots[0], stages);
}

function buildStageHTML(stage, allStages) {
  const children = allStages.filter(s => s.parentName === stage.name);
  const cardHTML = evoCardHTML(stage);

  if (children.length === 0) return cardHTML;

  if (children.length === 1) {
    const child = children[0];
    const arrowHTML = evoArrowHTML(child.details);
    return `<div class="evo-stage-row">
      ${cardHTML}
      ${arrowHTML}
      ${buildStageHTML(child, allStages)}
    </div>`;
  }

  const branchItems = children.map(child => {
    const arrowHTML = evoArrowHTML(child.details);
    return `<div class="evo-branch-entry">
      ${arrowHTML}
      ${buildStageHTML(child, allStages)}
    </div>`;
  }).join('');

  return `<div class="evo-stage-row">
    ${cardHTML}
    <div class="evo-branch-col">${branchItems}</div>
  </div>`;
}

function evoCardHTML(stage) {
  const spriteUrl = `${ARTWORK_BASE}${stage.id}.png`;
  return `<div class="evo-card-item" data-name="${stage.name}" title="${capitalize(stage.name)}">
    <img class="evo-sprite" src="${spriteUrl}" alt="${capitalize(stage.name)}" loading="lazy" />
    <span class="evo-name">${capitalize(stage.name)}</span>
    <span class="evo-id">#${String(stage.id).padStart(3,'0')}</span>
  </div>`;
}

function evoArrowHTML(details) {
  const condition = details && details.length ? buildEvoCondition(details[0]) : '';
  return `<div class="evo-arrow-wrap">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    ${condition ? `<span class="evo-condition">${condition}</span>` : ''}
  </div>`;
}

function buildEvoCondition(d) {
  const parts = [];
  if (d.min_level) parts.push(`Lv. ${d.min_level}`);
  if (d.item) parts.push(`Use ${capitalize(d.item.name)}`);
  if (d.held_item) parts.push(`Hold ${capitalize(d.held_item.name)}`);
  if (d.known_move) parts.push(`Knows ${capitalize(d.known_move.name)}`);
  if (d.known_move_type) parts.push(`Knows ${capitalize(d.known_move_type.name)}-type`);
  if (d.location) parts.push(`At ${capitalize(d.location.name)}`);
  if (d.min_happiness) parts.push(`High Friendship${d.time_of_day ? ` (${d.time_of_day})` : ''}`);
  if (d.min_affection) parts.push(`High Affection`);
  if (d.needs_overworld_rain) parts.push('During Rain');
  if (d.gender === 1) parts.push('(Female)');
  if (d.gender === 2) parts.push('(Male)');
  if (d.party_species) parts.push(`With ${capitalize(d.party_species.name)}`);
  if (d.party_type) parts.push(`${capitalize(d.party_type.name)}-type in party`);
  if (d.trade_species) parts.push(`Trade for ${capitalize(d.trade_species.name)}`);
  if (d.turn_upside_down) parts.push('Upside Down');
  if (!parts.length && d.trigger) {
    if (d.trigger.name === 'trade') parts.push('Trade');
    else if (d.trigger.name === 'use-item') parts.push('Use item');
    else if (d.trigger.name === 'shed') parts.push('Shed');
    else if (d.trigger.name === 'spin') parts.push('Spin');
    else if (d.trigger.name === 'tower-of-darkness') parts.push('Tower of Darkness');
    else if (d.trigger.name === 'tower-of-waters') parts.push('Tower of Waters');
    else if (d.trigger.name === 'three-critical-hits') parts.push('3 Crits');
    else if (d.trigger.name === 'take-damage') parts.push('Take damage');
    else if (d.trigger.name === 'other') parts.push('Special');
    else parts.push(capitalize(d.trigger.name));
  }
  return parts.join(', ');
}

function extractIdFromUrl(url) {
  const m = url.match(/\/(\d+)\/?$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Generation number -> representative version-group label for filter UI
const GEN_LABEL = {
  1: 'Gen I (RBY)', 2: 'Gen II (GSC)', 3: 'Gen III (RSE)',
  4: 'Gen IV (DPPt)', 5: 'Gen V (BW)', 6: 'Gen VI (XY)',
  7: 'Gen VII (SM)', 8: 'Gen VIII (SwSh)', 9: 'Gen IX (SV)',
};

/* ——— Moves Tab ——— */
function renderMovesTab(poke) {
  movesLoaded = true;
  els.movesFilters.innerHTML = '';
  els.movesContent.innerHTML = '';

  // Build rows from bundled learnset
  const learnset = poke._learnsetLocal || [];
  const moveMeta = poke._moveMeta || {};

  if (!learnset.length) {
    els.movesContent.innerHTML = '<p class="no-encounters">No move data available.</p>';
    return;
  }

  const rows = learnset.map(r => {
    const meta = moveMeta[r.move] || {};
    return {
      name: r.move,
      displayName: capitalize(r.move),
      type: meta.type || '—',
      damageClass: meta.category || 'status',
      power: meta.power ?? null,
      accuracy: meta.accuracy ?? null,
      pp: meta.pp ?? null,
      method: r.method,
      level: r.level ?? null,
      gen: r.gen ?? null,
      versionGroup: r.vg || (r.gen ? `gen-${r.gen}` : 'unknown'),
    };
  });

  movesData = rows;
  buildMovesUI(rows);
}

function buildMovesUI(rows) {
  const allVersionGroups = [...new Set(rows.map(r => r.versionGroup))].sort((a, b) => {
    // gen-N virtual keys: sort numerically
    const ga = a.match(/^gen-(\d+)$/), gb = b.match(/^gen-(\d+)$/);
    if (ga && gb) return parseInt(ga[1]) - parseInt(gb[1]);
    if (ga) return 1; if (gb) return -1;
    const ia = GAME_ORDER.indexOf(vgToGame(a));
    const ib = GAME_ORDER.indexOf(vgToGame(b));
    return ia - ib;
  });

  const latestVG = allVersionGroups[allVersionGroups.length - 1] || '';

  let activeMethod = 'level-up';
  let activeVG = latestVG;

  function renderFilters() {
    const methods = ['All', 'Level-up', 'TM/HM', 'Egg', 'Tutor'];
    const methodValues = { 'All': 'all', 'Level-up': 'level-up', 'TM/HM': 'machine', 'Egg': 'egg', 'Tutor': 'tutor' };

    const chips = methods.map(m => {
      const val = methodValues[m];
      const isActive = activeMethod === val;
      return `<button class="filter-chip${isActive ? ' active' : ''}" data-method="${val}">${m}</button>`;
    }).join('');

    const options = allVersionGroups.map(vg => {
      const label = vgDisplayName(vg);
      return `<option value="${vg}"${vg === activeVG ? ' selected' : ''}>${label}</option>`;
    }).join('');

    els.movesFilters.innerHTML = `
      <span class="filter-label">Method</span>${chips}
      <span class="filter-label" style="margin-left:8px">Game</span>
      <select class="filter-select" id="vgSelect">${options}</select>
    `;

    els.movesFilters.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        activeMethod = chip.dataset.method;
        renderFilters();
        renderTable();
      });
    });

    document.getElementById('vgSelect').addEventListener('change', e => {
      activeVG = e.target.value;
      renderTable();
    });
  }

  function renderTable() {
    let filtered = rows.filter(r => r.versionGroup === activeVG);
    if (activeMethod !== 'all') filtered = filtered.filter(r => r.method === activeMethod);

    const deduped = [];
    const seen = new Set();
    filtered.forEach(r => {
      const key = `${r.name}|${r.method}|${r.level}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(r); }
    });

    if (activeMethod === 'level-up') {
      deduped.sort((a, b) => a.level - b.level || a.displayName.localeCompare(b.displayName));
    } else {
      deduped.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    if (!deduped.length) {
      els.movesContent.innerHTML = `<p class="no-encounters">No moves found for these filters.</p>`;
      return;
    }

    const trs = deduped.map(r => {
      const typeColor = TYPE_COLORS[r.type] || '#888';
      const typeCell = r.type !== '—' ? `<span class="move-type-cell" style="background:${typeColor}">${capitalize(r.type)}</span>` : '—';
      const dmgClass = r.damageClass;
      const dmgBadge = `<span class="move-dmg-badge ${dmgClass}">${capitalize(dmgClass)}</span>`;
      const lvlCell = r.method === 'level-up' ? `<span class="move-level-cell">${r.level > 0 ? r.level : '—'}</span>` : '—';
      return `<tr>
        <td>${r.displayName}</td>
        <td>${typeCell}</td>
        <td>${dmgBadge}</td>
        <td>${r.power ?? '—'}</td>
        <td>${r.accuracy != null ? r.accuracy + '%' : '—'}</td>
        <td>${r.pp ?? '—'}</td>
        <td>${methodLabel(r.method)}</td>
        <td>${lvlCell}</td>
      </tr>`;
    }).join('');

    els.movesContent.innerHTML = `<div class="moves-table-wrap">
      <table class="moves-table">
        <thead><tr>
          <th>Move</th><th>Type</th><th>Class</th><th>Power</th><th>Acc</th><th>PP</th><th>Method</th><th>Lv</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
  }

  renderFilters();
  renderTable();
}

function methodLabel(method) {
  const map = { 'level-up': 'Level-up', 'machine': 'TM/HM', 'egg': 'Egg', 'tutor': 'Tutor', 'form-change': 'Form' };
  return map[method] || capitalize(method);
}

function vgToGame(vg) {
  // gen-N virtual version groups sort by N
  const genMatch = vg.match(/^gen-(\d+)$/);
  if (genMatch) return vg;
  const first = vg.split('-')[0];
  return first;
}

function vgDisplayName(vg) {
  // gen-N virtual version groups from Showdown learnset
  const genMatch = vg.match(/^gen-(\d+)$/);
  if (genMatch) return GEN_LABEL[parseInt(genMatch[1])] || `Gen ${genMatch[1]}`;
  const parts = vg.split('-');
  return parts.map(p => GAME_DISPLAY_NAMES[p] || capitalize(p)).join('/');
}

/* ——— Encounters ——— */
function renderEncounters(encounters) {
  if (!encounters || encounters.length === 0) {
    els.encountersContent.innerHTML = `<p class="no-encounters">Not encounterable in the wild in any main series game — obtain via evolution, trade, event, or breeding.</p>`;
    return;
  }

  const byGame = {};
  encounters.forEach(enc => {
    enc.version_details.forEach(vd => {
      const game = vd.version.name;
      if (!byGame[game]) byGame[game] = [];
      const locationName = humanizeLocationName(enc.location_area.name);
      vd.encounter_details.forEach(ed => {
        byGame[game].push({
          location: locationName,
          method: capitalize(ed.method.name),
          minLevel: ed.min_level,
          maxLevel: ed.max_level,
          chance: ed.chance,
        });
      });
    });
  });

  const games = Object.keys(byGame).sort((a, b) => {
    const ia = GAME_ORDER.indexOf(a);
    const ib = GAME_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  els.encountersContent.innerHTML = games.map(game => {
    const displayName = GAME_DISPLAY_NAMES[game] || capitalize(game);
    const rows = byGame[game];
    const tableRows = rows.map(r => {
      const lvl = r.minLevel === r.maxLevel ? `Lv ${r.minLevel}` : `Lv ${r.minLevel}–${r.maxLevel}`;
      return `<tr>
        <td>${r.location}</td>
        <td>${r.method}</td>
        <td>${lvl}</td>
        <td><span class="chance-pill">${r.chance}%</span></td>
      </tr>`;
    }).join('');

    return `<div class="encounters-game-block">
      <div class="game-title">${displayName}</div>
      <div class="encounters-table-wrap">
        <table class="encounters-table">
          <thead><tr><th>Location</th><th>Method</th><th>Level</th><th>Chance</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

/* ——— Pokédex Entries ——— */
function renderPokedexEntries(species) {
  if (!species) { els.pokedexEntries.innerHTML = '<p class="no-encounters">No data.</p>'; return; }

  const entries = species.flavor_text_entries.filter(e => e.language.name === 'en');

  const byGame = {};
  entries.forEach(e => {
    const game = e.version.name;
    if (!byGame[game]) byGame[game] = [];
    byGame[game].push(cleanFlavorText(e.flavor_text));
  });

  const ordered = GAME_ORDER.filter(g => byGame[g]);
  const extra = Object.keys(byGame).filter(g => !GAME_ORDER.includes(g)).sort();
  const allGames = [...ordered, ...extra];

  if (!allGames.length) {
    els.pokedexEntries.innerHTML = '<p class="no-encounters">No English Pokédex entries found.</p>';
    return;
  }

  els.pokedexEntries.innerHTML = allGames.map(game => {
    const displayName = GAME_DISPLAY_NAMES[game] || capitalize(game);
    const texts = [...new Set(byGame[game])];
    return texts.map(text => `
      <div class="pokedex-entry">
        <div class="pokedex-game-name">${displayName}</div>
        <div class="pokedex-flavor">${text}</div>
      </div>
    `).join('');
  }).join('');
}

/* ——— Helpers ——— */
function humanizeLocationName(name) {
  return name.replace(/-area$/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').trim();
}

function cleanFlavorText(text) {
  return text
    .replace(/\f/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/­/g, '')
    .replace(//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ——— Suggestions container bootstrap ——— */
// Ensure the suggestions list is a direct child of .search-container (position:relative)
// and is styled for correct absolute positioning above other content.
function bootstrapSuggestionsContainer() {
  const container = els.suggestionsList.closest('.search-container') || els.suggestionsList.parentElement;
  if (container && getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  // Apply positioning defensively in JS so it works even if CSS is partially missing
  const sl = els.suggestionsList;
  sl.style.position = 'absolute';
  sl.style.top = 'calc(100% + 8px)';
  sl.style.left = '0';
  sl.style.right = '0';
  sl.style.zIndex = '1000';
  sl.style.maxHeight = '400px';
  sl.style.overflowY = 'auto';
}

/* ——— localStorage helpers (used by residual evolution cache code) ——— */
function getCachedData(key, ttl) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > ttl) { localStorage.removeItem(key); return null; }
    return data;
  } catch (_) { return null; }
}

function setCachedData(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch (_) {}
}

/* ——— Loading banner ——— */
let loadingBanner = null;

function showLoadingBanner(msg) {
  if (loadingBanner) { loadingBanner.textContent = msg; return; }
  loadingBanner = document.createElement('div');
  loadingBanner.id = 'pokedexLoadBanner';
  loadingBanner.style.cssText = [
    'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
    'background:var(--card-bg,#1e2535)', 'color:var(--text-primary,#e2e8f0)',
    'border:1px solid var(--card-border,rgba(255,255,255,.08))',
    'border-radius:8px', 'padding:8px 20px', 'font-size:.85rem',
    'z-index:9999', 'box-shadow:0 4px 24px rgba(0,0,0,.4)',
    'pointer-events:none',
  ].join(';');
  loadingBanner.textContent = msg;
  document.body.appendChild(loadingBanner);
}

function hideLoadingBanner() {
  if (loadingBanner) {
    loadingBanner.remove();
    loadingBanner = null;
  }
}

/* ——— Init ——— */
async function init() {
  initTheme();
  bootstrapSuggestionsContainer();

  // Register service worker for offline caching of sprites and app shell
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('[pokefinder] SW registration failed:', err);
    });
  }

  // Load name list from bundled POKEDEX_INDEX (synchronous — already in memory)
  try {
    loadNames();
  } catch (err) {
    showSearchError('Could not load Pokemon list. Reload to retry.');
    return;
  }

  // Load all data chunks in parallel, show progress banner
  showLoadingBanner('Loading Pokedex...');
  els.searchSpinner.classList.add('visible');
  try {
    await loadChunks();
    const loaded = window.POKEDEX ? Object.keys(window.POKEDEX).length : 0;
    console.log(`[pokefinder] POKEDEX ready: ${loaded} entries`);
  } catch (err) {
    console.warn('[pokefinder] chunk load error:', err);
    showSearchError('Some data failed to load. The app may be partially offline.');
  } finally {
    els.searchSpinner.classList.remove('visible');
    hideLoadingBanner();
  }
}

function showSearchError(msg) {
  const existing = document.getElementById('searchLoadError');
  if (existing) return;
  const err = document.createElement('p');
  err.id = 'searchLoadError';
  err.textContent = msg;
  err.style.cssText = 'margin-top:8px;font-size:0.82rem;color:var(--error-text,#f87171);text-align:center;';
  const container = els.suggestionsList.closest('.search-container') || els.suggestionsList.parentElement;
  if (container) container.appendChild(err);
}

init();
