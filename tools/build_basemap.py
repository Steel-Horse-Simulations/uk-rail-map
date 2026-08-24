#!/usr/bin/env python3
"""Whole-UK base map: real coastline, heavily simplified, 90/45 edges, rounded corners."""
import json, math

SEA   = "#E4F3F9"
COL = {"Isle of Man": "#EDEDED", "England": "#FFFFFF", "Scotland": "#C0D9F0", "Wales": "#F3CFCF",
       "Northern Ireland": "#D6EFD2", "Ireland": "#BFE6C8",
       "Isle of Man": "#EDEDED", "France": "#EDEDED"}
WANT = list(COL)

LAT0 = 55.0
K = 190.0
LAT_MAX, LAT_MIN = 59.15, 49.75
LON_MIN, LON_MAX = -11.2, 2.6

def proj(lon, lat):
    return (lon*math.cos(math.radians(LAT0))*K, -lat*K)

def ring_area(r):
    a = 0.0
    for (x1, y1), (x2, y2) in zip(r, r[1:]+r[:1]):
        a += x1*y2 - x2*y1
    return abs(a)/2

def dp(pts, tol):
    if len(pts) < 3: return pts
    dmax, idx = 0.0, 0
    a, b = pts[0], pts[-1]
    dx, dy = b[0]-a[0], b[1]-a[1]
    L = math.hypot(dx, dy) or 1e-9
    for i in range(1, len(pts)-1):
        d = abs(dy*(pts[i][0]-a[0]) - dx*(pts[i][1]-a[1]))/L
        if d > dmax: dmax, idx = d, i
    if dmax > tol:
        return dp(pts[:idx+1], tol)[:-1] + dp(pts[idx:], tol)
    return [a, b]

def thin(pts, gap):
    keep = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0]-keep[-1][0], p[1]-keep[-1][1]) >= gap:
            keep.append(p)
    if len(keep) > 3 and math.hypot(keep[0][0]-keep[-1][0], keep[0][1]-keep[-1][1]) < gap:
        keep.pop()
    return keep

def octi_sym(pts):
    """90/45 only; decomposition is independent of which way the ring is walked"""
    out = []
    for a, b in zip(pts, pts[1:]+pts[:1]):
        out.append(a)
        dx, dy = b[0]-a[0], b[1]-a[1]
        if abs(dx) < 1e-9 or abs(dy) < 1e-9 or abs(abs(dx)-abs(dy)) < 1e-9:
            continue
        p, q = (a, b) if (a[0], a[1]) < (b[0], b[1]) else (b, a)
        ddx, ddy = q[0]-p[0], q[1]-p[1]
        m = min(abs(ddx), abs(ddy))
        sx = (ddx > 0) - (ddx < 0); sy = (ddy > 0) - (ddy < 0)
        mid = ((p[0]+sx*(abs(ddx)-m), p[1]) if abs(ddx) > abs(ddy)
               else (p[0], p[1]+sy*(abs(ddy)-m)))
        out.append(mid)
    clean = []
    for p in out:
        if not clean or math.hypot(p[0]-clean[-1][0], p[1]-clean[-1][1]) > 1e-6:
            clean.append(p)
    return clean

def collapse(pts):
    """drop collinear points and spikes"""
    for _ in range(4):
        n = len(pts); out = []
        for i in range(n):
            p0, p1, p2 = pts[i-1], pts[i], pts[(i+1) % n]
            v1 = (p1[0]-p0[0], p1[1]-p0[1]); v2 = (p2[0]-p1[0], p2[1]-p1[1])
            l1 = math.hypot(*v1) or 1e-9; l2 = math.hypot(*v2) or 1e-9
            cr = (v1[0]*v2[1]-v1[1]*v2[0])/(l1*l2)
            dt = (v1[0]*v2[0]+v1[1]*v2[1])/(l1*l2)
            if abs(cr) < 1e-6 and dt > 0: continue      # collinear
            if dt < -0.999: continue                    # spike
            out.append(p1)
        if len(out) == len(pts): break
        pts = out
        if len(pts) < 4: break
    return pts

def _seg_x(p1, p2, p3, p4):
    d1 = (p2[0]-p1[0], p2[1]-p1[1]); d2 = (p4[0]-p3[0], p4[1]-p3[1])
    den = d1[0]*d2[1] - d1[1]*d2[0]
    if abs(den) < 1e-12: return None
    t = ((p3[0]-p1[0])*d2[1] - (p3[1]-p1[1])*d2[0]) / den
    u = ((p3[0]-p1[0])*d1[1] - (p3[1]-p1[1])*d1[0]) / den
    if 1e-7 < t < 1-1e-7 and 1e-7 < u < 1-1e-7:
        return (p1[0]+d1[0]*t, p1[1]+d1[1]*t)
    return None

def unwind(pts):
    """split the ring at any self-crossing and keep the larger loop, so no
    sub-loop can cancel the winding and punch a hole in the fill"""
    for _ in range(60):
        n = len(pts); hit = None
        for i in range(n):
            a1, a2 = pts[i], pts[(i+1) % n]
            for j in range(i+2, n):
                if i == 0 and j == n-1: continue
                b1, b2 = pts[j], pts[(j+1) % n]
                P = _seg_x(a1, a2, b1, b2)
                if P: hit = (i, j, P); break
            if hit: break
        if not hit: return pts
        i, j, P = hit
        inner = [P] + pts[i+1:j+1]
        outer = pts[:i+1] + [P] + pts[j+1:]
        cand = [c for c in (inner, outer) if len(c) >= 5]
        if not cand: return pts
        pts = max(cand, key=ring_area)
    return pts

def unloop(pts, G):
    """the octilinear pass can pinch a ring against itself, leaving a hole where the
    winding cancels; find repeated grid points and drop the smaller sub-loop"""
    for _ in range(24):
        key = {}
        found = None
        for i, p in enumerate(pts):
            k = (round(p[0]/G), round(p[1]/G))
            if k in key:
                found = (key[k], i); break
            key[k] = i
        if not found: break
        i, j = found
        inner = pts[i:j]
        outer = pts[:i] + pts[j:]
        if len(outer) < 5:
            break
        pts = outer if ring_area(outer) >= ring_area(inner) else inner
        if len(pts) < 5: break
    return pts

def destair(pts, G):
    """turn short staircase runs into single straight or diagonal edges.
    Purely local, so a shared border simplifies the same way from either side."""
    for _ in range(4):
        n = len(pts)
        if n < 8: break
        drop = [False]*n
        for i in range(n):
            if drop[i-1]: continue
            p0, p1, p2 = pts[i-1], pts[i], pts[(i+1) % n]
            l1 = math.hypot(p1[0]-p0[0], p1[1]-p0[1])
            l2 = math.hypot(p2[0]-p1[0], p2[1]-p1[1])
            if l1 > G*1.6 or l2 > G*1.6: continue
            dx, dy = p2[0]-p0[0], p2[1]-p0[1]
            L = math.hypot(dx, dy) or 1e-9
            dev = abs(dy*(p1[0]-p0[0]) - dx*(p1[1]-p0[1]))/L
            if dev <= G*0.85:
                drop[i] = True
        keep = [p for i, p in enumerate(pts) if not drop[i]]
        if len(keep) == len(pts) or len(keep) < 8: break
        pts = collapse(octi_sym(keep))
    return pts

def octi(pts, snap):
    pts = [(round(x/snap)*snap, round(y/snap)*snap) for x, y in pts]
    out = []
    for a, b in zip(pts, pts[1:]+pts[:1]):
        out.append(a)
        dx, dy = b[0]-a[0], b[1]-a[1]
        if abs(dx) < 1e-9 or abs(dy) < 1e-9 or abs(abs(dx)-abs(dy)) < 1e-9:
            continue
        m = min(abs(dx), abs(dy))
        sx = (dx > 0) - (dx < 0); sy = (dy > 0) - (dy < 0)
        if abs(dx) > abs(dy):
            out.append((a[0]+sx*(abs(dx)-m), a[1]))
        else:
            out.append((a[0], a[1]+sy*(abs(dy)-m)))
    clean = []
    for p in out:
        if not clean or math.hypot(p[0]-clean[-1][0], p[1]-clean[-1][1]) > 1e-6:
            clean.append(p)
    return clean

def rounded(pts, r):
    n = len(pts)
    if n < 3: return ""
    seg = [math.hypot(pts[(i+1) % n][0]-pts[i][0], pts[(i+1) % n][1]-pts[i][1]) for i in range(n)]
    rad = [min(r, seg[i-1]*0.5, seg[i]*0.5) for i in range(n)]
    for _ in range(3):
        for i in range(n):
            j = (i+1) % n
            if rad[i]+rad[j] > seg[i] > 0:
                k = seg[i]/(rad[i]+rad[j]); rad[i] *= k; rad[j] *= k
    d = []
    for i in range(n):
        p0, p1, p2 = pts[i-1], pts[i], pts[(i+1) % n]
        l1 = math.hypot(p1[0]-p0[0], p1[1]-p0[1]) or 1e-9
        l2 = math.hypot(p2[0]-p1[0], p2[1]-p1[1]) or 1e-9
        u1 = ((p1[0]-p0[0])/l1, (p1[1]-p0[1])/l1)
        u2 = ((p2[0]-p1[0])/l2, (p2[1]-p1[1])/l2)
        rr = rad[i]
        a = (p1[0]-u1[0]*rr, p1[1]-u1[1]*rr)
        b = (p1[0]+u2[0]*rr, p1[1]+u2[1]*rr)
        d.append((f"M {a[0]:.1f} {a[1]:.1f}" if not d else f"L {a[0]:.1f} {a[1]:.1f}")
                 + f" Q {p1[0]:.1f} {p1[1]:.1f} {b[0]:.1f} {b[1]:.1f}")
    return " ".join(d) + " Z"

# ------------------------------------------------------------------ load
data = json.load(open("/home/claude/subunits.geojson"))
shapes = []          # (subunit, projected ring, area)
for f in data["features"]:
    su = f["properties"].get("SUBUNIT")
    if su not in WANT: continue
    geom = f["geometry"]
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        ring = poly[0]
        lons = [p[0] for p in ring]; lats = [p[1] for p in ring]
        if max(lats) < LAT_MIN or min(lats) > LAT_MAX: continue
        if max(lons) < LON_MIN or min(lons) > LON_MAX: continue
        if su == "France" and (min(lons) > 2.6 or max(lats) < 49.0): continue
        pr = [proj(*p) for p in ring]
        shapes.append((su, pr, ring_area(pr), min(lats), max(lats), min(lons), max(lons)))

# only the mainlands plus Skye and islands that carry a railway
ISLANDS = {                       # name: (lon0, lon1, lat0, lat1)
    "Skye":         (-6.90, -5.65, 57.00, 57.75),
    "Anglesey":     (-4.80, -4.00, 53.10, 53.48),
    "Isle of Wight":(-1.62, -1.03, 50.55, 50.82),
}
BIG = 12000.0                                     # GB, Ireland, NI, Wales, France
kept = []
for su, pr, area, la0, la1, lo0, lo1 in shapes:
    if area >= BIG:
        kept.append((su, pr, area)); continue
    cx, cy = (lo0+lo1)/2, (la0+la1)/2
    for nm, (a0, a1, b0, b1) in ISLANDS.items():
        if a0 <= cx <= a1 and b0 <= cy <= b1 and area > 60:
            kept.append((su, pr, area)); break
kept.sort(key=lambda t: -t[2])
mainland_area = kept[0][2]

# ------------------------------------------------------------------ clip
def clip(pts, x0, y0, x1, y1):
    """Sutherland-Hodgman against the map window"""
    def half(pl, inside, isect):
        out = []
        for a, b in zip(pl, pl[1:]+pl[:1]):
            ia, ib = inside(a), inside(b)
            if ia: out.append(a)
            if ia != ib: out.append(isect(a, b))
        return out
    edges = [
        (lambda p: p[0] >= x0, lambda a, b: (x0, a[1]+(b[1]-a[1])*(x0-a[0])/((b[0]-a[0]) or 1e-9))),
        (lambda p: p[0] <= x1, lambda a, b: (x1, a[1]+(b[1]-a[1])*(x1-a[0])/((b[0]-a[0]) or 1e-9))),
        (lambda p: p[1] >= y0, lambda a, b: (a[0]+(b[0]-a[0])*(y0-a[1])/((b[1]-a[1]) or 1e-9), y0)),
        (lambda p: p[1] <= y1, lambda a, b: (a[0]+(b[0]-a[0])*(y1-a[1])/((b[1]-a[1]) or 1e-9), y1)),
    ]
    for ins, isc in edges:
        pts = half(pts, ins, isc)
        if not pts: return []
    return pts

X0, _ = proj(LON_MIN, 0); X1, _ = proj(LON_MAX, 0)
_, Y0 = proj(0, LAT_MAX); _, Y1 = proj(0, LAT_MIN)
PAD = 46.0
W = X1-X0 + PAD*2
H = Y1-Y0 + PAD*2

out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" '
       f'viewBox="0 0 {W:.0f} {H:.0f}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">',
       f'<rect width="{W:.0f}" height="{H:.0f}" fill="{SEA}"/>',
       f'<g transform="translate({PAD-X0:.1f},{PAD-Y0:.1f})">']

drawn = 0
for su, pr, area in kept:
    pr = clip(pr, X0-40, Y0-40, X1+40, Y1+40)
    if len(pr) < 4: continue
    big = area > 8000.0
    G = 23.5 if big else max(5.0, math.sqrt(area)/6.0)
    if math.hypot(pr[0][0]-pr[-1][0], pr[0][1]-pr[-1][1]) < 1e-9:
        pr = pr[:-1]
    pts = []
    for _ in range(6):
        p = [(round(x/G)*G, round(y/G)*G) for x, y in pr]
        d2 = [p[0]]
        for q in p[1:]:
            if math.hypot(q[0]-d2[-1][0], q[1]-d2[-1][1]) > 1e-9: d2.append(q)
        p = collapse(octi_sym(d2))
        p = destair(p, G)
        p = collapse(unwind(collapse(unloop(p, G))))
        if len(p) >= 5:
            pts = p; break
        G *= 0.6
    if len(pts) < 5: continue
    out.append(f'<path d="{rounded(pts, 9.0)}" fill="{COL[su]}" stroke="{COL[su]}" stroke-width="7" stroke-linejoin="round"/>')
    drawn += 1

out.append('</g></svg>')
open("/home/claude/out/uk-base.svg", "w").write("\n".join(out))
print("shapes drawn:", drawn, "size", round(W), round(H))
