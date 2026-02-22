import sys
from PIL import Image

for path in sys.argv[1:]:
    try:
        img = Image.open(path).convert("RGBA")
        new_data = []
        for r, g, b, a in img.getdata():
            mag = max(r, g, b)
            if mag < 18:
                new_data.append((0, 0, 0, 0))
            elif mag < 100:
                new_alpha = int((mag - 18) / 82 * 255)
                # Boost brightness of the semi-transparent pixels to avoid grey borders
                factor = 255.0 / (new_alpha if new_alpha > 0 else 1)
                new_data.append((
                    min(255, int(r * factor)), 
                    min(255, int(g * factor)), 
                    min(255, int(b * factor)), 
                    new_alpha
                ))
            else:
                new_data.append((r, g, b, a))
        img.putdata(new_data)
        img.save(path, "PNG")
        print("Processed " + path)
    except Exception as e:
        print("Error on " + path + ": " + str(e))
