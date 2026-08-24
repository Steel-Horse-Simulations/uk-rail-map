# UK Rail Map

A desktop editor for schematic railway maps of the UK and Ireland, in the London
Underground idiom: octilinear track, bundled parallel services, tick marks for
calls, capsule interchanges.

See `CLAUDE.md` for the full design brief — the visual rules, the geometry
constraints and the decisions behind them.

## The model

- A **route** is the base layer — physical track, holding every station along it.
- A **service** is drawn on a route, or several routes, with its own colour and
  its own stopping pattern. It can start or finish partway along a route.
- Routes can share track. Where they do, services bundle into parallel lanes and
  keep their lane along the whole corridor, so nothing shuffles sideways when a
  neighbour terminates.

## Running it

```bash
npm install
npm start
```

## Releasing

```bash
npm version patch      # bumps package.json and tags
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which builds the Windows
installer and publishes it to GitHub Releases. Installed copies check that feed
on launch, download in the background, and offer a restart.

Before the first release, set your GitHub username in two places:
`package.json` under `build.publish.owner`, and the Help menu link in
`src/main/main.ts`.

## Layout

```
src/core/model.ts       stations, routes, services, operators, the project file
src/core/geometry.ts    octilinear steps, lane assignment, corner rounding
src/core/render.ts      SVG output — also used for export and, later, the web build
src/main/               Electron main process, file dialogs, PDF export, updates
src/renderer/           the editor window
assets/uk-base.svg      generated coastline
tools/build_basemap.py  regenerates that coastline from Natural Earth data
                        (needs `pip install shapely`)
tools/build_places.py   regenerates the towns overlay
```

`src/core` deliberately has no DOM or Electron dependencies, so the same
rendering code can be reused on the web later.
