"""Block the coastline out on a coarse grid, the way the poster is drawn:
decide land or sea per cell, then chamfer the coastal corners so staircases
become clean 45-degree runs. Borders are shared cell edges, so they cannot gap."""
import json, math
from shapely.geometry import Polygon, box, Point
from shapely.ops import unary_union
from shapely.prepared import prep

LAT0, K = 55.0, 5000.0
LAT_MAX, LAT_MIN = 59.15, 49.75
LON_MIN, LON_MAX = -11.2, 2.6
PAD = 1050.0
CELL = 750.0        # how coarsely the coast is blocked out; the whole idea

COL = {"England": "#FFFFFF", "Scotland": "#C0D9F0", "Wales": "#F3CFCF",
       "Northern Ireland": "#D6EFD2", "Ireland": "#BFE6C8", "France": "#EDEDED"}
SEA = "#E4F3F9"
ORDER = ["England", "Scotland", "Wales", "Northern Ireland", "Ireland", "France"]

def proj(lon, lat):
    return (lon * math.cos(math.radians(LAT0)) * K, -lat * K)

X0, _ = proj(LON_MIN, 0); X1, _ = proj(LON_MAX, 0)
_, Y0 = proj(0, LAT_MAX); _, Y1 = proj(0, LAT_MIN)

import sys
# Natural Earth subunits, downloaded once from
# https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_map_subunits.geojson
SRC = sys.argv[1] if len(sys.argv) > 1 else "subunits.geojson"
data = json.load(open(SRC))
polys = {}
for f in data["features"]:
    su = f["properties"].get("SUBUNIT")
    if su not in COL: continue
    g = f["geometry"]
    rings = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    ps = []
    for r in rings:
        pr = [proj(*p) for p in r[0]]
        if len(pr) < 4: continue
        pl = Polygon(pr)
        if not pl.is_valid: pl = pl.buffer(0)
        if not pl.is_empty: ps.append(pl)
    if ps:
        polys[su] = unary_union(ps)

prepped = {su: prep(p) for su, p in polys.items()}

cols = int((X1 - X0) / CELL) + 1
rows = int((Y1 - Y0) / CELL) + 1
label = {}
for j in range(rows):
    for i in range(cols):
        cx = X0 + (i + 0.5) * CELL
        cy = Y0 + (j + 0.5) * CELL
        pt = Point(cx, cy)
        for su in ORDER:
            if su in prepped and prepped[su].contains(pt):
                label[(i, j)] = su
                break

land = set(label)

# ---------------------------------------------------------------- small islands
# A cell is about 17 km across, so the Solent and the Menai Strait are a fraction
# of one — Wight and Anglesey can never separate themselves at this coarseness.
# They are placed instead: take the real footprint, then nudge it seaward by whole
# cells until it stands clear of the mainland. The same thing a draughtsman does.
FORCE = {
    "Isle of Wight": ("England", (-1.62, -1.03, 50.55, 50.82)),
    "Anglesey":      ("Wales",   (-4.80, -4.00, 53.10, 53.48)),
}

def footprint(lon0, lon1, lat0, lat1, owner):
    """Cells the island really covers, by area rather than by centre point."""
    from shapely.geometry import box as _box
    x0, y1_ = proj(lon0, lat0)
    x1_, y0_ = proj(lon1, lat1)
    region = _box(min(x0, x1_), min(y0_, y1_), max(x0, x1_), max(y0_, y1_))
    # take the island's own landmass, not whatever else the box overlaps —
    # Anglesey's box catches a slice of mainland Wales otherwise
    whole = polys[owner]
    parts = list(whole.geoms) if whole.geom_type == "MultiPolygon" else [whole]
    biggest = max(pl.area for pl in parts)
    island = [pl for pl in parts
              if pl.area < biggest * 0.3 and region.contains(pl.representative_point())]
    if not island:
        return set()
    shape = unary_union(island).intersection(region)
    if shape.is_empty:
        return set()
    cells = set()
    i0 = int((min(x0, x1_) - X0) / CELL) - 1
    i1 = int((max(x0, x1_) - X0) / CELL) + 1
    j0 = int((min(y0_, y1_) - Y0) / CELL) - 1
    j1 = int((max(y0_, y1_) - Y0) / CELL) + 1
    for j in range(j0, j1 + 1):
        for i in range(i0, i1 + 1):
            cell = _box(X0 + i * CELL, Y0 + j * CELL, X0 + (i + 1) * CELL, Y0 + (j + 1) * CELL)
            if shape.intersection(cell).area > cell.area * 0.18:
                cells.add((i, j))
    return cells

def clear_of_land(cells, mainland):
    """No cell of the island may touch, even diagonally, a cell of the mainland."""
    for i, j in cells:
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                n = (i + di, j + dj)
                if n not in cells and n in mainland:
                    return False
    return True

FORCED_CELLS = set()
for name, (owner, bbox) in FORCE.items():
    cells = footprint(*bbox, owner)
    if not cells:
        print("  could not place", name)
        continue
    mainland = set(land)
    for c in cells:
        mainland.discard(c)
    # try the smallest nudge that gets it clear, seaward first
    offsets = sorted(
        [(di, dj) for di in range(-3, 4) for dj in range(-3, 4)],
        key=lambda o: (abs(o[0]) + abs(o[1]), -o[1], abs(o[0])),
    )
    placed = None
    for di, dj in offsets:
        moved = {(i + di, j + dj) for i, j in cells}
        if moved & mainland:
            continue
        if clear_of_land(moved, mainland):
            placed = moved
            break
    if placed is None:
        print("  no clear spot for", name)
        continue
    for c in cells:
        label.pop(c, None)
    for c in placed:
        label[c] = owner
        FORCED_CELLS.add(c)
    print(f"  {name}: {len(placed)} cells, nudged {di},{dj}")

land = set(label)
print("land cells:", len(land), f"grid {cols}x{rows}")

def is_sea(i, j):
    return (i, j) not in land

def rings_for(cells):
    u = unary_union([box(X0 + i * CELL, Y0 + j * CELL,
                         X0 + (i + 1) * CELL, Y0 + (j + 1) * CELL) for i, j in cells])
    gs = list(u.geoms) if u.geom_type == "MultiPolygon" else [u]
    return [(list(g.exterior.coords)[:-1], g.area) for g in gs]

def chamfer(ring):
    """Cut half a cell off every corner that faces the sea. Consecutive cuts on a
    one-cell staircase join up into a continuous 45-degree edge."""
    n = len(ring)
    out = []
    for idx in range(n):
        p0, p1, p2 = ring[idx - 1], ring[idx], ring[(idx + 1) % n]
        i = int(round((p1[0] - X0) / CELL)); j = int(round((p1[1] - Y0) / CELL))
        l1 = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        l2 = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        if l1 < 1e-9 or l2 < 1e-9:
            out.append(p1); continue
        cut = min(CELL / 2, l1 / 2, l2 / 2)
        u1 = ((p1[0] - p0[0]) / l1, (p1[1] - p0[1]) / l1)
        u2 = ((p2[0] - p1[0]) / l2, (p2[1] - p1[1]) / l2)
        out.append((p1[0] - u1[0] * cut, p1[1] - u1[1] * cut))
        out.append((p1[0] + u2[0] * cut, p1[1] + u2[1] * cut))
    # drop points that now sit on a straight run
    keep = []
    m = len(out)
    for idx in range(m):
        a, b, c = out[idx - 1], out[idx], out[(idx + 1) % m]
        v1 = (b[0] - a[0], b[1] - a[1]); v2 = (c[0] - b[0], c[1] - b[1])
        l1 = math.hypot(*v1) or 1e-9; l2 = math.hypot(*v2) or 1e-9
        if abs(v1[0] / l1 - v2[0] / l2) < 1e-9 and abs(v1[1] / l1 - v2[1] / l2) < 1e-9:
            continue
        keep.append(b)
    return keep

def path_d(ring, r=85.0):
    n = len(ring)
    d = []
    for idx in range(n):
        p0, p1, p2 = ring[idx - 1], ring[idx], ring[(idx + 1) % n]
        l1 = math.hypot(p1[0] - p0[0], p1[1] - p0[1]) or 1e-9
        l2 = math.hypot(p2[0] - p1[0], p2[1] - p1[1]) or 1e-9
        rr = min(r, l1 / 2, l2 / 2)
        u1 = ((p1[0] - p0[0]) / l1, (p1[1] - p0[1]) / l1)
        u2 = ((p2[0] - p1[0]) / l2, (p2[1] - p1[1]) / l2)
        a = (p1[0] - u1[0] * rr, p1[1] - u1[1] * rr)
        b = (p1[0] + u2[0] * rr, p1[1] + u2[1] * rr)
        d.append((f"M {a[0]:.1f} {a[1]:.1f}" if not d else f"L {a[0]:.1f} {a[1]:.1f}")
                 + f" Q {p1[0]:.1f} {p1[1]:.1f} {b[0]:.1f} {b[1]:.1f}")
    return " ".join(d) + " Z"

W = X1 - X0 + PAD * 2
H = Y1 - Y0 + PAD * 2
out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" '
       f'viewBox="0 0 {W:.0f} {H:.0f}">',
       f'<rect width="{W:.0f}" height="{H:.0f}" fill="{SEA}"/>',
       f'<g transform="translate({PAD - X0:.1f},{PAD - Y0:.1f})">']

ISLANDS = {   # name: (lon0, lon1, lat0, lat1)
    "Skye":          (-6.90, -5.65, 57.00, 57.75),
    "Anglesey":      (-4.80, -4.00, 53.10, 53.48),
    "Isle of Wight": (-1.62, -1.03, 50.55, 50.82),
}
KEEP_BOXES = []
for a0, a1, b0, b1 in ISLANDS.values():
    x0, y1_ = proj(a0, b0)
    x1_, y0_ = proj(a1, b1)
    KEEP_BOXES.append((min(x0, x1_), max(x0, x1_), min(y0_, y1_), max(y0_, y1_)))

def wanted(ring, area, biggest):
    if area >= biggest * 0.5:
        return True                      # the mainland itself
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    cell = (int((cx - X0) / CELL), int((cy - Y0) / CELL))
    if cell in FORCED_CELLS:
        return True                      # an island we placed deliberately
    return any(x0 <= cx <= x1_ and y0_ <= cy <= y1_ for x0, x1_, y0_, y1_ in KEEP_BOXES)

n = 0
for su in ORDER:
    cells = [c for c, s in label.items() if s == su]
    if not cells: continue
    parts = rings_for(cells)
    biggest = max(a for _, a in parts)
    for ring, area in parts:
        if not wanted(ring, area, biggest): continue
        out.append(f'<path d="{path_d(chamfer(ring))}" fill="{COL[su]}" '
                   f'stroke="{COL[su]}" stroke-width="275" stroke-linejoin="round"/>')
        n += 1
out.append("</g></svg>")
open("assets/uk-base.svg", "w").write("\n".join(out))
print("shapes:", n, "size", round(W), round(H))
