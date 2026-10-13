import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import uuid
import zlib

from PIL import Image, PngImagePlugin

from runtime import rgb
from scan_worker import image_size


class ImageSizeTests(unittest.TestCase):
    def setUp(self):
        # Python 3.14's Windows mkdtemp mode (0o700) prevents sandbox access.
        self.root = Path(tempfile.gettempdir()) / f"image-size-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.addCleanup(shutil.rmtree, self.root)

    def assert_size_matches(self, path, expected):
        rendered = rgb(path)
        self.addCleanup(rendered.close)
        self.assertEqual(rendered.size, expected)
        with Image.open(path) as source:
            image_type = type(source)
        # A size lookup must not fall back to loading or decoding the image.
        with patch.object(image_type, "load", side_effect=AssertionError("pixel load")):
            self.assertEqual(image_size(path), rendered.size)

    def test_jpeg_exif_orientations(self):
        with Image.new("RGB", (37, 19), "red") as image:
            for orientation in range(1, 9):
                with self.subTest(orientation=orientation):
                    exif = Image.Exif()
                    exif[0x0112] = orientation
                    path = self.root / f"orientation-{orientation}.jpg"
                    image.save(path, exif=exif)
                    self.assert_size_matches(path, (19, 37) if orientation >= 5 else (37, 19))

    def test_png_alpha_without_exif(self):
        path = self.root / "alpha.png"
        with Image.new("RGBA", (37, 19), (255, 0, 0, 64)) as image:
            image.save(path)
        self.assert_size_matches(path, (37, 19))

    def test_png_exif_orientations(self):
        with Image.new("RGBA", (37, 19), (255, 0, 0, 64)) as image:
            for orientation in range(1, 9):
                with self.subTest(orientation=orientation):
                    exif = Image.Exif()
                    exif[0x0112] = orientation
                    path = self.root / f"orientation-{orientation}.png"
                    image.save(path, exif=exif)
                    self.assert_size_matches(path, (19, 37) if orientation >= 5 else (37, 19))

    def test_png_exif_after_pixels(self):
        path = self.root / "late-exif.png"
        with Image.new("RGBA", (37, 19), (255, 0, 0, 64)) as image:
            image.save(path)
        exif = Image.Exif()
        exif[0x0112] = 6
        payload = b"eXIf" + exif.tobytes()[6:]
        chunk = struct.pack(">I", len(payload) - 4) + payload + struct.pack(">I", zlib.crc32(payload))
        data = path.read_bytes()
        path.write_bytes(data[:-12] + chunk + data[-12:])
        self.assert_size_matches(path, (19, 37))

    def test_png_xmp_orientation_after_pixels(self):
        path = self.root / "xmp.png"
        metadata = PngImagePlugin.PngInfo()
        metadata.add(b"iTXt", b'XML:com.adobe.xmp\0\0\0\0\0<tiff:Orientation>8</tiff:Orientation>',
                     after_idat=True)
        with Image.new("RGBA", (37, 19), (255, 0, 0, 64)) as image:
            image.save(path, pnginfo=metadata)
        self.assert_size_matches(path, (19, 37))

    def test_animated_gif_first_frame(self):
        path = self.root / "animated.gif"
        with Image.new("RGB", (37, 19), "red") as first, Image.new("RGB", (37, 19), "blue") as second:
            first.save(path, save_all=True, append_images=[second], duration=100, loop=0)
        with Image.open(path) as source:
            self.assertEqual(source.n_frames, 2)
        self.assert_size_matches(path, (37, 19))

    def test_animated_webp_exif_orientations(self):
        with Image.new("RGBA", (37, 19), "red") as first, Image.new("RGBA", (37, 19), "blue") as second:
            for orientation in range(1, 9):
                with self.subTest(orientation=orientation):
                    path = self.root / f"animated-{orientation}.webp"
                    exif = Image.Exif()
                    exif[0x0112] = orientation
                    first.save(path, save_all=True, append_images=[second], duration=100, loop=0,
                               lossless=True, exif=exif)
                    with Image.open(path) as source:
                        self.assertEqual(source.n_frames, 2)
                    self.assert_size_matches(path, (19, 37) if orientation >= 5 else (37, 19))


if __name__ == "__main__":
    unittest.main()
