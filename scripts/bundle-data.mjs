/**
 * PokeFinder -- bundle-data.mjs
 * Slims the 1025 per-pokemon JSON files and emits sharded JS bundles
 * for fully offline use (works from file:// without a server).
 *
 * Output:
 *   data/pokedex-index.js       -- window.POKEDEX_INDEX: minimal list for autocomplete
 *   data/pokedex-manifest.js    -- window.POKEDEX_MANIFEST: chunk filenames + metadata
 *   data/pokedex-chunk-N.js     -- window.POKEDEX shards (~200 pokemon each)
 *
 * No npm deps required. Node 18+.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const POKEMON_DIR = path.join(ROOT, 'data', 'pokemon');
const OUT_DIR = path.join(ROOT, 'data');

const CHUNK_SIZE = 200; // pokemon per chunk

// ---- Evo chain slimmer -------------------------------------------------------
// Remove null/false/empty fields from PokéAPI evolution_details entries.
const EVO_DETAIL_SKIP_WHEN_NULL = [
  'base_form','gender','held_item','item','known_move','known_move_type',
  'location','min_affection','min_beauty','min_damage_taken','min_happiness',
  'min_move_count','min_steps','party_species','party_type','region',
  'relative_physical_stats','trade_species',
];
const EVO_DETAIL_SKIP_WHEN_FALSE = ['needs_multiplayer','needs_overworld_rain','turn_upside_down'];
const EVO_DETAIL_SKIP_WHEN_EMPTY_STRING = ['time_of_day'];

function slimEvoDetail(d) {
  if (!d) return d;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (EVO_DETAIL_SKIP_WHEN_NULL.includes(k) && v === null) continue;
    if (EVO_DETAIL_SKIP_WHEN_FALSE.includes(k) && v === false) continue;
    if (EVO_DETAIL_SKIP_WHEN_EMPTY_STRING.includes(k) && v === '') continue;
    if (k === 'trigger' && v && typeof v === 'object') {
      // keep only name, drop url
      out[k] = { name: v.name };
      continue;
    }
    out[k] = v;
  }
  return out;
}

function slimEvoNode(node) {
  if (!node) return null;
  const slimDetails = (node.evolution_details || [])
    .map(slimEvoDetail)
    .filter(d => d && Object.keys(d).length > 0);

  return {
    species: { name: node.species.name, url: node.species.url },
    ...(slimDetails.length ? { evolution_details: slimDetails } : {}),
    ...(node.is_baby ? { is_baby: true } : {}),
    evolves_to: (node.evolves_to || []).map(slimEvoNode).filter(Boolean),
  };
}

// ---- Learnset slimmer --------------------------------------------------------
// The Showdown learnset repeats full move metadata (type/power/accuracy/pp) for
// every (move, gen, method) row. We dedupe: one metadata entry per move name,
// and keep only (move, gen, method, level) per row.
function slimLearnset(rows) {
  if (!rows || !rows.length) return { moves: {}, learnset: [] };

  const movesMeta = {};
  const learnsetRows = [];
  const seen = new Set();

  for (const r of rows) {
    const moveName = r.move;
    // Store metadata once per move
    if (!movesMeta[moveName] && (r.type || r.power || r.accuracy || r.pp)) {
      movesMeta[moveName] = {
        ...(r.type ? { type: r.type } : {}),
        ...(r.category ? { category: r.category } : {}),
        ...(r.power != null ? { power: r.power } : {}),
        ...(r.accuracy != null ? { accuracy: r.accuracy } : {}),
        ...(r.pp != null ? { pp: r.pp } : {}),
      };
    }
    // Dedup rows by (move, gen, method, level)
    const key = `${moveName}|${r.gen ?? ''}|${r.method}|${r.level ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      const row = { move: moveName, method: r.method };
      if (r.gen != null) row.gen = r.gen;
      if (r.level != null) row.level = r.level;
      if (r.version_group) row.vg = r.version_group;
      learnsetRows.push(row);
    }
  }

  return { moves: movesMeta, learnset: learnsetRows };
}

// ---- Main slimmer per doc ----------------------------------------------------
function slimDoc(doc) {
  // Stats: if value is an object with _conflicts, keep only {value, _conflicts},
  // otherwise keep the scalar.
  const stats = {};
  for (const [k, v] of Object.entries(doc.stats || {})) {
    if (typeof v === 'object' && v !== null && v.value !== undefined) {
      stats[k] = v._conflicts ? { value: v.value, _conflicts: v._conflicts } : v.value;
    } else {
      stats[k] = v;
    }
  }

  // Flavor texts: EN only (already filtered by build-data.mjs), dedup by text
  const seenTexts = new Set();
  const flavorTexts = (doc.flavor_texts || []).filter(ft => {
    if (seenTexts.has(ft.text)) return false;
    seenTexts.add(ft.text);
    return true;
  });

  // Evolution chain: slim the tree
  const evoChain = doc.evolution?.chain ? slimEvoNode(doc.evolution.chain) : null;

  // Learnset: extract metadata table + slim rows
  const { moves: moveMeta, learnset } = slimLearnset(doc.learnset || []);

  // Locations: drop 'source' field (always 'bulbapedia' or 'pokeapi', not needed at runtime)
  const locations = (doc.locations || []).map(loc => {
    const out = { game: loc.game, location: loc.location };
    if (loc.rarity != null) out.rarity = loc.rarity;
    if (loc.method) out.method = loc.method;
    if (loc.levels) out.levels = loc.levels;
    if (loc.chance != null) out.chance = loc.chance;
    return out;
  });

  // Types: keep only array value (drop _conflicts object wrapper if no conflict)
  const types = Array.isArray(doc.types) ? doc.types : (doc.types?.value || doc.types || []);

  // Conflicts: include only if non-empty
  const out = {
    id: doc.id,
    name: doc.name,
    types,
    height_m: doc.height_m,
    weight_kg: doc.weight_kg,
    stats,
    abilities: (doc.abilities || []).map(a => ({
      name: a.name,
      is_hidden: a.is_hidden,
      slot: a.slot,
    })),
    sprite_url: doc.sprite_url,
    artwork_url: doc.artwork_url,
    species: doc.species || null,
    flavor_texts: flavorTexts,
    evolution: {
      ...(evoChain ? { chain: evoChain } : {}),
      ...(doc.evolution?.bulbapedia_condition ? { bulbapedia_condition: doc.evolution.bulbapedia_condition } : {}),
    },
    locations,
    move_meta: moveMeta,
    learnset,
  };

  // Conflicts: only if present
  if (doc.types_conflicts?.length) out.types_conflicts = doc.types_conflicts;
  if (doc.height_conflicts?.length) out.height_conflicts = doc.height_conflicts;
  if (doc.weight_conflicts?.length) out.weight_conflicts = doc.weight_conflicts;

  return out;
}

// ---- Main -------------------------------------------------------------------
async function main() {
  console.log('[bundle] Reading pokemon files...');
  const files = await fs.readdir(POKEMON_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json')).sort((a, b) => {
    return parseInt(a) - parseInt(b);
  });

  console.log(`[bundle] Found ${jsonFiles.length} files`);

  const indexEntries = [];
  const allSlimmed = [];
  let totalInputBytes = 0;
  let totalOutputBytes = 0;

  for (const file of jsonFiles) {
    const filePath = path.join(POKEMON_DIR, file);
    const raw = await fs.readFile(filePath, 'utf8');
    totalInputBytes += raw.length;
    const doc = JSON.parse(raw);
    const slimmed = slimDoc(doc);
    const slimmedStr = JSON.stringify(slimmed);
    totalOutputBytes += slimmedStr.length;
    allSlimmed.push(slimmed);
    indexEntries.push({
      id: slimmed.id,
      name: slimmed.name,
      types: slimmed.types,
    });
  }

  console.log(`[bundle] Input: ${(totalInputBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[bundle] Slimmed output: ${(totalOutputBytes / 1024 / 1024).toFixed(1)} MB`);

  // ---- pokedex-index.js ----
  const indexJs = `window.POKEDEX_INDEX = ${JSON.stringify(indexEntries)};\n`;
  await fs.writeFile(path.join(OUT_DIR, 'pokedex-index.js'), indexJs, 'utf8');
  console.log(`[bundle] pokedex-index.js written (${(indexJs.length / 1024).toFixed(1)} KB)`);

  // ---- chunks ----
  const chunks = [];
  for (let i = 0; i < allSlimmed.length; i += CHUNK_SIZE) {
    chunks.push(allSlimmed.slice(i, i + CHUNK_SIZE));
  }

  const chunkFilenames = [];
  let totalChunkBytes = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkPokemon = chunks[ci];
    const entries = chunkPokemon.map(p => `${p.id}:${JSON.stringify(p)}`).join(',');
    const chunkJs = `(window.POKEDEX=window.POKEDEX||{});Object.assign(window.POKEDEX,{${entries}});\n`;
    const filename = `pokedex-chunk-${ci}.js`;
    const outPath = path.join(OUT_DIR, filename);
    await fs.writeFile(outPath, chunkJs, 'utf8');
    chunkFilenames.push(filename);
    totalChunkBytes += chunkJs.length;
    console.log(`[bundle] ${filename}: ${(chunkJs.length / 1024).toFixed(1)} KB (${chunkPokemon.length} pokemon)`);
  }

  console.log(`[bundle] Total chunks: ${(totalChunkBytes / 1024 / 1024).toFixed(1)} MB across ${chunkFilenames.length} files`);

  // ---- pokedex-manifest.js ----
  const manifest = {
    chunks: chunkFilenames,
    total: allSlimmed.length,
    generated_at: new Date().toISOString(),
  };
  const manifestJs = `window.POKEDEX_MANIFEST = ${JSON.stringify(manifest)};\n`;
  await fs.writeFile(path.join(OUT_DIR, 'pokedex-manifest.js'), manifestJs, 'utf8');
  console.log(`[bundle] pokedex-manifest.js written`);

  // ---- Sample output: Charizard #6 ----
  const charizard = allSlimmed.find(p => p.id === 6);
  if (charizard) {
    const beforeKB = (JSON.parse(await fs.readFile(path.join(POKEMON_DIR, '6.json'), 'utf8')), (await fs.stat(path.join(POKEMON_DIR, '6.json'))).size / 1024).toFixed(1);
    const afterKB = (JSON.stringify(charizard).length / 1024).toFixed(1);
    console.log(`\n[bundle] Sample -- Charizard #6:`);
    console.log(`  Before: ${beforeKB} KB | After: ${afterKB} KB`);
    console.log(`  Fields: ${Object.keys(charizard).join(', ')}`);
    console.log(`  Learnset rows: ${charizard.learnset.length} (was 665)`);
    console.log(`  Move metadata entries: ${Object.keys(charizard.move_meta).length}`);
    console.log(`  Flavor texts (deduped): ${charizard.flavor_texts.length}`);
    console.log(`  Locations: ${charizard.locations.length}`);
  }

  console.log('\n[bundle] Done.');
}

main().catch(err => { console.error('[bundle] fatal:', err); process.exit(1); });
