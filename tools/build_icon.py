import cairosvg, io
from PIL import Image

# full detail: three services, a shared corridor and an interchange
BIG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="56" fill="#16202B"/>
  <rect x="14" y="14" width="228" height="228" rx="44" fill="#E4F3F9"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M32 96 H108 L164 40" stroke="#0A55C4" stroke-width="26"/>
    <path d="M32 132 H120 L188 200" stroke="#0E8A3E" stroke-width="26"/>
    <path d="M96 216 L96 150 L150 96 H226" stroke="#E2620E" stroke-width="26"/>
  </g>
  <line x1="96" y1="96" x2="96" y2="132" stroke="#16202B" stroke-width="46" stroke-linecap="round"/>
  <line x1="96" y1="96" x2="96" y2="132" stroke="#ffffff" stroke-width="30" stroke-linecap="round"/>
</svg>'''

# small sizes: one bold corner, one interchange, nothing else to muddy it
SMALL = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="52" fill="#16202B"/>
  <rect x="6" y="6" width="244" height="244" rx="46" fill="#E4F3F9"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 76 H128 L214 162" stroke="#0A55C4" stroke-width="50"/>
    <path d="M20 180 H128" stroke="#E2620E" stroke-width="50"/>
  </g>
  <line x1="128" y1="76" x2="128" y2="180" stroke="#16202B" stroke-width="92" stroke-linecap="round"/>
  <line x1="128" y1="76" x2="128" y2="180" stroke="#ffffff" stroke-width="62" stroke-linecap="round"/>
</svg>'''

def png(svg, s):
    return Image.open(io.BytesIO(
        cairosvg.svg2png(bytestring=svg.encode(), output_width=s, output_height=s))).convert('RGBA')

open('out/icon.svg', 'w').write(BIG)
sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [png(SMALL if s <= 32 else BIG, s) for s in sizes]
imgs[-1].save('out/icon.ico', format='ICO', sizes=[(s, s) for s in sizes])
imgs[-1].save('out/icon.png')

strip = Image.new('RGBA', (sum(i.width for i in imgs) + 24 * len(imgs), 300), (255, 255, 255, 255))
x = 12
for i in imgs:
    strip.paste(i, (x, 150 - i.height // 2), i)
    x += i.width + 24
strip.save('out/icon-preview.png')
print('ok')
