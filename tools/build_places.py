#!/usr/bin/env python3
"""Build the towns-and-cities overlay.

Reads assets/projection.json so the dots land in exactly the same coordinate
space as the hand-drawn outline. Run build_basemap.py first.

Source: geonames cities500 (every place of 500 people or more).
    python tools/build_places.py path/to/cities500.json
"""
import json
import math
import sys


def tier(pop):
    if pop >= 200_000:
        return 0
    if pop >= 60_000:
        return 1
    if pop >= 15_000:
        return 2
    return 3


def main(src, out="assets/places.json"):
    pr = json.load(open("assets/projection.json"))
    unit, scale, lat0 = pr["unit"], pr["scale"], pr["lat0"]
    minx, miny = pr["minx"], pr["miny"]
    k = math.cos(math.radians(lat0)) * scale

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
        if not (49.5 <= lat <= 59.5 and -11.5 <= lon <= 2.6):
            continue
        places.append({
            "n": c["name"],
            "x": round((lon * k - minx) * unit, 1),
            "y": round((-lat * scale - miny) * unit, 1),
            "p": pop,
            "t": tier(pop),
        })

    places.sort(key=lambda p: -p["p"])
    json.dump({"places": places}, open(out, "w", encoding="utf-8"), separators=(",", ":"))
    by_tier = {}
    for p in places:
        by_tier[p["t"]] = by_tier.get(p["t"], 0) + 1
    print(f"{len(places)} places -> {out}   by tier: {by_tier}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "cities500.json")
