# Working on this project

Read this before changing anything. It records decisions made with the project's
owner over a long design conversation, most of which are not recoverable from the
code alone. Where the code and this document disagree, the document is the intent
and the code is probably the bug.

Read `src/core` before editing it. The geometry engine is the hard part and most
of it exists to satisfy a specific complaint that was made about an earlier draft.

---

## What this is

A Windows desktop editor for schematic railway maps of the UK and Ireland, drawn
in the London Underground idiom. One canvas holds the whole network. There are no
inset or detail maps — that idea was deliberately dropped, because the map is
zoomable on screen rather than printed.

Built with Electron and TypeScript. `src/core` has no Electron or DOM imports so
the same rendering code can run on a website later; keep it that way.

---

## The model

- A **route** is the base layer: physical track, holding every station along it
  in order. Routes may share track with other routes.
- A **service** is drawn on one or more routes, with its own colour and its own
  stopping pattern. It can start or finish partway along a route.
- A station a service passes without stopping keeps its tick for the services
  that do stop; the passing line simply runs by.
- A **route with no services** is drawn grey, with grey station names. Where only
  part of a route is served, only that part takes colour.
- Metro and heritage lines are their own routes, separate from main ones, but may
  share a station with a main route where they do in reality (the example given
  was the Strathspey Railway sharing Aviemore with the Highland Main Line).
- Bus and ferry links are standalone: no base route needed.

---

## The visual language

Every one of these was asked for specifically. Do not quietly change them.

**Track**
- 90 and 45 degrees only, never anything else. Stations too.
- Gaps between parallel lines equal the line width.
- Corners are rounded and **concentric**: bundled lines keep an even gap round a
  bend, so the inner lane needs a tighter radius than the outer.
- Neighbouring corners **negotiate**: where two bends are too close to fit, both
  radii shrink proportionally. Without this you get S-kinks where a line steps
  sideways over one cell. This was a repeated complaint.
- A service that continues past a station where another terminates must **stay
  straight**. Lanes hold their position along a whole corridor and never
  re-centre when a neighbour joins or leaves.
- Where a service joins a corridor partway, existing lines hold; the newcomer
  takes the outside lane.
- Two one-way services on the same corridor must never cross over. Lane order is
  global rather than per-step, which is what guarantees it.
- Every station sits on a **straight** section, never on a curve. Put bends on
  plain waypoints between stations.

**Line styles**
- Main: solid, full width.
- Metro: same width, drawn as an outline.
- Heritage: thinner.
- Under construction: outlined and hatched.
- Ferry: long dashes. Bus: dotted.

**Station markers**
- Ordinary stop: a short tick in the **colour of the service that stops there**,
  sticking out of **one side only**, as long as the line is wide plus a little, so
  it just grazes the next line along.
- Interchange: white bar with a black border, snapped to 45 degrees. Whether a
  station is an interchange is a **per-station setting**, never inferred from how
  many services call.
- Where a non-stopping line runs between two interchange blobs, the blobs are
  joined by a narrower bordered bar running **underneath** it. Its white interior
  is about a third the width of the interchange dot's.
- End of a line: a dot, but **only** where the station is set to Terminus or
  ticked as an interchange. Otherwise a normal tick. One service terminating gets
  the dot outlined in its own colour; several get black.
- A station may occupy **several cells**; large termini need the room, with
  services terminating at different points along the bar.
- Big stations form a **T**, centred on the main arm — the arm where services
  terminate. The secondary arm is where services pass through. If services
  terminate from two opposite directions, the through route joins into the ends
  and there is no T at all.
- Metro station: white dot with a border in the line's colour, outer diameter
  exactly the line width. Where a metro shares a station with a main line, use the
  normal interchange dot.
- A bus or ferry stop with no rail is a grey dot, unless two bus or ferry routes
  meet there, in which case it is an interchange dot.
- No park and ride markers. Airport symbol goes **after** the station name.

**One-way**
- Solid filled chevrons spanning the **full line width**, arms at 45 degrees, flat
  ends, ending flush with the edge of the line. Evenly spaced along the run.
- A service can be one-way throughout, or on chosen stretches.

**Labels**
- Station names take the operator's colour where a single operator calls; black
  where several; grey for metro; grey for an unserved route; black until an
  operator's colour is set. Manual override available.
- Where a line leaves the map: a borderless capsule with **black** text, its
  background split evenly between the services leaving, with 45-degree joins
  between the colours. Keep the arrowheads on the lines as well as the bubble.

**Bus and ferry glyphs**
- One picture per line, sitting **beside** the line with its base against it,
  travelling along it, facing away from the rail end. Which side is a setting.
  Roughly at the midpoint, but movable.
- Most ferry routes are better as a **box and arrow** at the map edge listing
  destinations, rather than a drawn line to a stop. Short hops stay as lines.

**Land and sea**
- England white, Scotland light blue, Wales light red, Ireland light emerald,
  Northern Ireland a slightly different green, sea pale blue. No borders drawn
  anywhere — the colour change is the border.
- Coastline is 90 and 45 degrees with curved corners, no jagged edges, at roughly
  the level of the National Rail "Railway 200" map: simple but still detailed
  enough to read.
- Only Skye and islands that carry a railway are shown. Islands must not touch the
  mainland.
- **The coastline pipeline order matters.** Snap to a grid *first*, then convert
  to 90/45, then merge staircase runs. Simplifying first and octilinearising after
  produces blobs — that was tried and rejected. Snapping first is also what makes
  shared country borders line up exactly, and the 45-degree decomposition is made
  direction-independent so a border simplifies the same way from either side.
- Self-crossings in the outline are found and removed, otherwise the winding
  cancels and punches sea-coloured holes in the land.

---

## Editing behaviour

- Everything snaps to a grid, 90 and 45 degrees only.
- Routes, segments and individual stations can be **locked**. Locked geometry is
  fixed: re-routing works around it, and the app should say so rather than quietly
  moving it.
- Any route can be re-aligned at any time; nothing is baked once made.
- Adding a station to a route that is not in line inserts a **bend
  automatically**. There are always two ways round a corner — offer both.
- Towns overlay from the embedded gazetteer, with a population-floor slider.
  Clicking a town places a station already named after it.
- OpenRailwayMap was discussed as a positioning aid: a linked geographic pane and
  ghost markers showing each station's true position work at any distortion; a
  tile underlay only lines up before things are nudged.

---

## Shipping

- **The version in `package.json` is what ships.** Every push to `main` builds a
  Windows installer and publishes it to Releases, but only if that version has not
  been released yet. Bump it to ship.
- The updater reads GitHub Releases. The repo must stay public, or the app would
  need a token baked into it.
- No code signing, so SmartScreen warns on first install. Accepted.
- Assets are compiled into the bundle by `scripts/embed-assets.js` rather than
  read from disk. This is deliberate: reading them at runtime broke repeatedly
  when packaging layout shifted. Do not go back to runtime file reads.
- `npm run typecheck` generates the embedded assets first, so it works on a fresh
  clone where `src/generated` does not exist.

---

## Not built yet

- Operators exist, but there is no station database or search.
- Ferry and bus glyphs, off-map bubbles, chevrons on chosen stretches, the
  interchange link bar and the T-shape all exist in the renderer but have no UI.
- No PDF export button in the window, though the main process can do it.
- Trams and buses were to be a second map inside the same project, sharing the
  station database and the outline. Not started.
- Interactive HTML export for the website. `src/core` is DOM-free so it can be
  reused directly.

---

## Bugs that shipped, and why

Real faults from real releases. Reintroducing any of these is a regression.

- **Never string a service's routes end to end.** A branch leaves from the middle
  of its parent, so joining one route's last cell to the next route's first
  describes track that does not exist, and the octilinear check rightly refuses
  it. `serviceRuns` returns one run per route; where they meet at a junction they
  simply meet.
- **Never let one bad leg kill the drawing.** When `renderSvg` throws, the canvas
  keeps the last good picture — so every later edit silently does nothing and the
  app appears broken in ways unrelated to the real fault. It cost a whole release
  and a confusing bug report. Skip the leg and carry on.
- **Build each UI list in one place.** A duplicate copy of the routes list meant
  branches never appeared nested, despite the nesting code being correct.
- **Scale sizes from the line width**, never fixed units. A hardcoded 2.6-unit
  marker outline was invisible at one grid pitch and swamped the line at another.
- **Grid pitch and drawing weight are separate settings.** Coarsening the pitch to
  get thicker lines rounded every station onto a grid kilometres across and
  collapsed neighbours together. Pitch controls placement; weight controls
  thickness.
- **Check that ids in index.html match the ones app.ts reaches for.** Removing a
  feature has twice taken neighbouring handlers with it — dark mode, Save and
  Export SVG were all silently left without handlers. A short script comparing
  `id="..."` in the HTML against `$('#...')` in the renderer catches it in
  seconds and is worth running before shipping.

---

## Order of work agreed with the owner

1. Branches and shared sections
   - branches: done (v0.12.0, repaired in v0.12.1)
   - shared sections: next. Two routes pointing at one piece of railway; offered
     when a route is drawn over stations already on another; editing one moves
     both; must be able to span an area boundary
2. **Areas** — named containers placed on the map. They nest, cannot overlap and
   size themselves to their contents. One shared scale for all of them; the
   coastline does not grow with them and becomes a rough backdrop, as on the
   Underground and Railway 200 maps
3. **Connections between areas** — build to the edge and it continues into
   whatever lies beyond; neighbours' routes show as labelled stubs at the edge;
   he chooses which stub joins which; crossings held at the same height; warnings
   for stray ends and for connections disturbed by moving an area, each resolved
   by confirming or redrawing
4. **Services mode** — a separate mode, working one area at a time. Per-area start
   and end dropdowns where either end may be set to the neighbouring area, which
   is how a service continues; calls set by tick or by clicking the station; a
   list of unfinished services; continue-to-next and back-to-previous buttons
5. **Ordering and banding**, inside services mode — per route and per shared
   section rather than one global list, with a warning when an ordering forces a
   service to cross others at a junction, and colour banding along shared track
6. **Via selection**, where a route offers two ways round

## Parked — do not build without asking

- Showing that a station is only called at when a service runs one way
- One-way sections between particular stations, with a direction toggle

## How the owner works

- He tests on Windows and reports against a numbered checklist. Supply one with
  every change: what to try, what should happen, and what is most likely wrong.
- He would rather be asked than have things guessed at, and asks for questions one
  area at a time — a long list at once is worse than none.
- New ideas go on a list; finish the checklist in hand before starting them.
- Design conversations happen in the Claude chat app, which holds the full history
  and specification. Building happens here.
