#!/usr/bin/env python3
"""Build the towns-and-cities overlay.

Projects every settlement in the UK, Ireland and the Isle of Man into the same
pixel space as assets/uk-base.svg, so the dots land where they belong on the
coastline. Tiers let the editor thin the layer out as you zoom away.

Source: geonames cities500 (every place of 500 people or more).
Run from the project root:  python tools/build_places.py path/to/cities500.json
"""
import json
import math
import sys

# these must match tools/build_basemap.py exactly
LAT0 = 55.0
K = 190.0
LAT_MAX, LAT_MIN = 59.15, 49.75
LON_MIN, LON_MAX = -11.2, 2.6
PAD = 46.0


def proj(lon, lat):
    return (lon * math.cos(math.radians(LAT0)) * K, -lat * K)


X0, _ = proj(LON_MIN, 0)
_, Y0 = proj(0, LAT_MAX)


def tier(pop):
    if pop >= 200_000:
        return 0
    if pop >= 60_000:
        return 1
    if pop >= 15_000:
        return 2
    return 3


def main(src, out="assets/places.json"):
    data = json.load(open(src, encoding="utf-8"))
    places = []
    for c in data:
        if c.get("country") not in ("GB", "IE", "IM"):
            continue
        try:
            lat = float(c["lat"])
            lon = float(c["lon"])
            pop = int(c.get("pop") or 0)
        except (TypeError, ValueError):
            continue
        if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
            continue
        x, y = proj(lon, lat)
        places.append({
            "n": c["name"],
            "x": round(x - X0 + PAD, 1),
            "y": round(y - Y0 + PAD, 1),
            "p": pop,
            "t": tier(pop),
        })

    # biggest first, so a truncated read still gets the important ones
    places.sort(key=lambda p: -p["p"])
    json.dump({"places": places}, open(out, "w", encoding="utf-8"), separators=(",", ":"))
    by_tier = {}
    for p in places:
        by_tier[p["t"]] = by_tier.get(p["t"], 0) + 1
    print(f"{len(places)} places -> {out}   by tier: {by_tier}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "cities500.json")
