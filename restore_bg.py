from PIL import Image
import sys

path = sys.argv[1]
img = Image.open(path).convert("RGBA")

# Create a new image with black background
bg = Image.new("RGBA", img.size, (2, 3, 5, 255))  # #020305
bg.paste(img, mask=img)
bg = bg.convert("RGB")  # Flatten to remove alpha entirely
bg.save(path, "PNG", quality=100)
print(f"Restored black background on {path}")
