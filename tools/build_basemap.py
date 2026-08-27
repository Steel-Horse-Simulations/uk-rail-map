#!/usr/bin/env python3
"""The UK and Ireland outline, drawn by hand.

Every corner below was chosen deliberately, in the idiom of the printed national
rail maps: long straight runs, 45-degree diagonals, no attempt to follow the real
coast bay for bay. One grid unit is roughly 20 km.

Countries share their border coordinates exactly — the same list is walked
forwards by one country and backwards by its neighbour — so a border can never
leave a gap or overlap.

Edit the coordinate lists to reshape the map. Nothing here is derived from data.
"""
import math

UNIT = 900.0          # map units per grid unit (about 20 km)
PAD = 3.0             # grid units of sea around the edge

SEA = "#E4F3F9"
COL = {
    "England": "#FFFFFF",
    "Scotland": "#C0D9F0",
    "Wales": "#F3CFCF",
    "Northern Ireland": "#D6EFD2",
    "Ireland": "#BFE6C8",
    "France": "#EDEDED",
    "Skye": "#C0D9F0",
    "Isle of Wight": "#FFFFFF",
    "Anglesey": "#F3CFCF",
}

# ---------------------------------------------------------------- the drawing
# Each corner is a real place, chosen by hand. Between them the outline runs
# straight or at 45 degrees, the way these maps are drawn. Move a place, or add
# one, to reshape that stretch of coast.
S = 5.55                    # grid units per degree of latitude (1 unit ~ 20 km)
LAT0 = 55.0

def g(lat, lon):
    return (round(lon * math.cos(math.radians(LAT0)) * S), round(-lat * S))

BORDER_SCOT_ENG = [g(54.99, -3.06), g(55.20, -2.40), g(55.60, -2.15), g(55.77, -2.00)]

COAST_SCOTLAND = [
    g(55.77, -2.00),   # Berwick-upon-Tweed
    g(56.00, -2.52),   # Dunbar
    g(56.02, -3.70),   # the Forth, cutting west to Grangemouth
    g(56.28, -2.60),   # Fife Ness
    g(56.46, -2.97),   # Dundee, the Tay
    g(56.56, -2.58),   # Arbroath
    g(57.15, -2.09),   # Aberdeen
    g(57.69, -2.00),   # Fraserburgh
    g(57.67, -2.52),   # Banff
    g(57.48, -4.23),   # Inverness, the Moray Firth
    g(57.88, -4.03),   # Dornoch
    g(58.44, -3.09),   # Wick
    g(58.64, -3.02),   # Duncansby Head
    g(58.60, -3.52),   # Thurso
    g(58.62, -5.00),   # Cape Wrath
    g(57.90, -5.16),   # Ullapool
    g(57.72, -5.70),   # Gairloch
    g(57.28, -5.72),   # Kyle of Lochalsh
    g(56.82, -5.11),   # Fort William
    g(56.41, -5.47),   # Oban
    g(55.86, -5.42),   # Tarbert
    g(55.31, -5.60),   # Mull of Kintyre
    g(55.96, -4.82),   # Gourock, back up the Clyde
    g(55.46, -4.63),   # Ayr
    g(54.90, -5.03),   # Stranraer
    g(54.99, -3.06),   # the Solway
]

COAST_ENGLAND_EAST = [
    g(55.77, -2.00),   # Berwick-upon-Tweed
    g(55.02, -1.42),   # Newcastle
    g(54.58, -1.23),   # Middlesbrough
    g(54.49, -0.61),   # Whitby
    g(54.08, -0.19),   # Bridlington
    g(53.74, -0.33),   # the Humber
    g(53.57, -0.08),   # Grimsby
    g(53.14, 0.34),    # Skegness
    g(52.75, 0.40),    # the Wash
    g(52.94, 0.49),    # Hunstanton
    g(52.93, 1.30),    # Cromer
    g(52.61, 1.73),    # Great Yarmouth
    g(51.96, 1.35),    # Felixstowe
    g(51.54, 0.71),    # Southend, the Thames
    g(51.39, 1.38),    # Margate
    g(51.13, 1.31),    # Dover
    g(50.86, 0.57),    # Hastings
    g(50.82, -0.14),   # Brighton
    g(50.80, -1.09),   # Portsmouth
    g(50.72, -1.88),   # Bournemouth
    g(50.61, -2.46),   # Weymouth
    g(50.62, -3.41),   # Exmouth
    g(50.37, -4.14),   # Plymouth
    g(50.07, -5.71),   # Land's End
    g(50.41, -5.08),   # Newquay
    g(50.83, -4.55),   # Bude
    g(51.08, -4.06),   # Barnstaple
    g(51.45, -2.59),   # Bristol, the Severn
    g(51.64, -2.68),   # Chepstow
]

BORDER_WALES_ENG = [
    g(51.64, -2.68),   # Chepstow
    g(52.06, -3.00),   # the Marches
    g(52.86, -3.06),   # Oswestry
    g(53.20, -3.00),   # the Dee at Chester
]

COAST_WALES = [
    g(53.20, -3.00),   # the Dee
    g(53.32, -3.83),   # Llandudno
    g(53.14, -4.27),   # Caernarfon
    g(52.79, -4.75),   # the Llyn peninsula
    g(52.41, -4.08),   # Aberystwyth
    g(52.08, -4.66),   # Cardigan
    g(51.88, -5.27),   # St Davids
    g(51.62, -3.94),   # Swansea
    g(51.48, -3.18),   # Cardiff
    g(51.64, -2.68),   # Chepstow
]

COAST_ENGLAND_NW = [
    g(53.20, -3.00),   # the Dee
    g(53.41, -3.00),   # Liverpool
    g(53.82, -3.05),   # Blackpool
    g(54.11, -3.23),   # Barrow
    g(54.55, -3.59),   # Whitehaven
    g(54.99, -3.06),   # the Solway
]

BORDER_IRELAND_NI = [
    g(54.50, -8.19),   # Ballyshannon
    g(54.30, -7.30),   # Fermanagh
    g(54.05, -6.20),   # Carlingford Lough
]

COAST_NI = [
    g(54.05, -6.20),   # Carlingford Lough
    g(54.60, -5.93),   # Belfast
    g(54.85, -5.82),   # Larne
    g(55.20, -6.24),   # Ballycastle
    g(55.20, -6.65),   # Portrush
    g(55.00, -7.32),   # Derry
    g(54.50, -8.19),   # Ballyshannon
]

COAST_IRELAND = [
    g(54.50, -8.19),   # Ballyshannon
    g(54.27, -8.48),   # Sligo
    g(54.23, -9.99),   # Belmullet
    g(53.49, -10.02),  # Clifden
    g(53.27, -9.05),   # Galway
    g(52.56, -9.93),   # Loop Head
    g(52.14, -10.27),  # Dingle
    g(51.88, -9.58),   # Kenmare
    g(51.85, -8.30),   # Cork
    g(52.15, -7.00),   # Waterford
    g(52.25, -6.34),   # Rosslare
    g(52.98, -6.04),   # Wicklow
    g(53.35, -6.26),   # Dublin
    g(54.05, -6.20),   # Carlingford Lough
]

def block(lat, lon, w, h):
    x, y = g(lat, lon)
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]

SKYE = block(57.55, -6.45, 2, 2)
ANGLESEY = block(53.42, -4.65, 2, 1)
WIGHT = block(50.62, -1.50, 2, 1)
FRANCE = [g(51.10, 1.90), g(51.10, 3.40), g(49.20, 3.40), g(49.20, 0.40), g(49.90, 1.30)]

# ---------------------------------------------------------------- assembly
def rev(seq):
    return list(reversed(seq))

def join(*parts):
    """Stitch runs together, dropping the duplicated joint between them."""
    out = []
    for part in parts:
        for p in part:
            if not out or out[-1] != p:
                out.append(p)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out

SHAPES = [
    ("Scotland", join(COAST_SCOTLAND, rev(BORDER_SCOT_ENG))),
    ("England", join(BORDER_SCOT_ENG, COAST_ENGLAND_EAST, rev(BORDER_WALES_ENG), COAST_ENGLAND_NW)),
    ("Wales", join(BORDER_WALES_ENG, COAST_WALES)),
    ("Northern Ireland", join(COAST_NI, rev(BORDER_IRELAND_NI))),
    ("Ireland", join(BORDER_IRELAND_NI, COAST_IRELAND)),
    ("France", FRANCE),
    ("Skye", SKYE),
    ("Anglesey", ANGLESEY),
    ("Isle of Wight", WIGHT),
]

def legalise(ring):
    """Every edge must be horizontal, vertical or exactly diagonal. Where a hand
    coordinate is not, insert the corner that makes it so: straight run first,
    then the diagonal."""
    out = []
    n = len(ring)
    for i in range(n):
        a = ring[i]
        b = ring[(i + 1) % n]
        out.append(a)
        dx, dy = b[0] - a[0], b[1] - a[1]
        if dx == 0 or dy == 0 or abs(dx) == abs(dy):
            continue
        m = min(abs(dx), abs(dy))
        sx = (dx > 0) - (dx < 0)
        sy = (dy > 0) - (dy < 0)
        if abs(dx) > abs(dy):
            out.append((b[0] - sx * m, a[1]))
        else:
            out.append((a[0], b[1] - sy * m))
    return out

def path_d(ring, r=0.28):
    pts = [(x * UNIT, y * UNIT) for x, y in ring]
    n = len(pts)
    d = []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        l1 = math.hypot(p1[0] - p0[0], p1[1] - p0[1]) or 1e-9
        l2 = math.hypot(p2[0] - p1[0], p2[1] - p1[1]) or 1e-9
        rr = min(r * UNIT, l1 / 2, l2 / 2)
        u1 = ((p1[0] - p0[0]) / l1, (p1[1] - p0[1]) / l1)
        u2 = ((p2[0] - p1[0]) / l2, (p2[1] - p1[1]) / l2)
        a = (p1[0] - u1[0] * rr, p1[1] - u1[1] * rr)
        b = (p1[0] + u2[0] * rr, p1[1] + u2[1] * rr)
        d.append((f"M {a[0]:.1f} {a[1]:.1f}" if not d else f"L {a[0]:.1f} {a[1]:.1f}")
                 + f" Q {p1[0]:.1f} {p1[1]:.1f} {b[0]:.1f} {b[1]:.1f}")
    return " ".join(d) + " Z"

xs = [x for _, ring in SHAPES for x, _ in ring]
ys = [y for _, ring in SHAPES for _, y in ring]
MINX, MAXX = min(xs) - PAD, max(xs) + PAD
MINY, MAXY = min(ys) - PAD, max(ys) + PAD
W = (MAXX - MINX) * UNIT
H = (MAXY - MINY) * UNIT

out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" '
       f'viewBox="0 0 {W:.0f} {H:.0f}">',
       f'<rect width="{W:.0f}" height="{H:.0f}" fill="{SEA}"/>',
       f'<g transform="translate({-MINX * UNIT:.1f},{-MINY * UNIT:.1f})">']
for name, ring in SHAPES:
    out.append(f'<path d="{path_d(legalise(ring))}" fill="{COL[name]}"/>')
out.append("</g></svg>")

open("assets/uk-base.svg", "w").write("\n".join(out))

# ---------------------------------------------------------------- editable form
# The app edits the outline directly, so write it out as data too: rings of grid
# points, with the border points pinned between neighbouring countries so moving
# one moves both.
import json as _json

RINGS = {name: legalise(ring) for name, ring in SHAPES}

def pin(a_name, b_name, run):
    """Mark the points of `run` as shared between two countries."""
    out = []
    for pt in run:
        ia = RINGS[a_name].index(pt) if pt in RINGS[a_name] else None
        ib = RINGS[b_name].index(pt) if pt in RINGS[b_name] else None
        if ia is not None and ib is not None:
            out.append((ia, ib))
    return out

shapes = []
for name, ring in SHAPES:
    shapes.append({
        "id": name.lower().replace(" ", "-"),
        "name": name,
        "fill": COL[name],
        "ring": [{"x": x - MINX, "y": y - MINY} for x, y in RINGS[name]],
        "shared": {},
    })

by_name = {s["name"]: s for s in shapes}
for a_name, b_name, run in (
    ("Scotland", "England", BORDER_SCOT_ENG),
    ("Wales", "England", BORDER_WALES_ENG),
    ("Northern Ireland", "Ireland", BORDER_IRELAND_NI),
):
    for ia, ib in pin(a_name, b_name, legalise(list(run)) if False else list(run)):
        by_name[a_name]["shared"][str(ia)] = f'{by_name[b_name]["id"]}:{ib}'
        by_name[b_name]["shared"][str(ib)] = f'{by_name[a_name]["id"]}:{ia}'

_json.dump({"unit": UNIT, "radius": 0.28, "shapes": shapes},
           open("assets/outline.json", "w"), indent=1)
print("  border points pinned:",
      sum(len(s["shared"]) for s in shapes) // 2)

# the towns overlay has to sit in exactly this coordinate space
import json as _json
_json.dump({"unit": UNIT, "scale": S, "lat0": LAT0, "minx": MINX, "miny": MINY},
           open("assets/projection.json", "w"), indent=2)
print(f"hand-drawn outline: {len(SHAPES)} shapes, {round(W)} x {round(H)} units, "
      f"origin at grid ({MINX}, {MINY})")
