# PokéFinder

Search any Pokémon by name and explore its stats, abilities, evolution chain, moves, encounter locations, and all Pokédex flavor texts — in a glassmorphism UI with light/dark theme.

## Tabs

- **Overview** — base stats, species info grid (habitat, color, egg groups, gender ratio, etc.), and "Appears in" game badges (green = wild, yellow = obtainable, gray = absent).
- **Evolution** — full evolution chain with conditions, clickable stage cards that reload the panel.
- **Moves** — filterable table by method (Level-up / TM/HM / Egg / Tutor) and game version; move details cached in localStorage for 30 days.
- **Locations** — wild encounter table grouped by game in canonical generation order.
- **Pokédex Entries** — all English flavor texts grouped by game version.

## Deploy on GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages**.
3. Set Source to **Deploy from a branch**, select **main** and **/ (root)**, then save.
4. Live at `https://<your-username>.github.io/pokefinder/`.

No build step needed — open `index.html` directly or serve from any static host.

## Attribution

Pokémon data from [PokéAPI](https://pokeapi.co). Sprites © Nintendo / Game Freak / The Pokémon Company.
