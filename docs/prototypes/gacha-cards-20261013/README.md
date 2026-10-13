# Card background prototype

A disposable, local prototype based on `claude/tender-lovelace-34czn7` at
`6855d50230bd59f2c842dc6af4b2a901d8ed9fdb`.

The displayed rarities are **N, U, S, SR, SSR, SEC**. Existing material keys
and draw probabilities are retained. Card numerals use the bundled Anton font;
page text uses the app's existing fonts. The power label is LP.

Four background treatments are available: digital panels, diagonal ribbons,
ornaments and petals, and aurora with constellations. SSR and SEC retain the
outer frame when a cutout layer is present and omit it when using original
full art. The two dark private samples always use original full art.

## Preview

From the repository root:

```sh
python docs/prototypes/gacha-cards-20261013/preview.py
```

Open:

```text
http://127.0.0.1:8767/docs/prototypes/gacha-cards-20261013/index.html?variant=digital#s2
```

The server binds to loopback and serves only this prototype, shared styles,
fonts, and scratch sample images. It does not expose the library or repository
metadata. Without private samples, the page uses its procedural demo artwork.

## Private sample preparation

Original images, cutouts, inference environments, models, reports, and exported
HTML are local scratch data and are not committed. Place working copies in
`.tmp/card-background-study/samples/`:

| File | Use |
| --- | --- |
| `art1.webp` | Bright portrait; generate `cut1.webp` |
| `art2.webp` | Bright full-body image; generate `cut2.webp` |
| `art3.jpg` | Dark original full art |
| `art4.jpg` | Dark original full art |

`prepare-samples.py` requires NumPy, Pillow, and ONNX Runtime in a separately
approved local Python environment. It uses the official
[isnet-anime model](https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx)
at `.tmp/card-background-study/models/isnet-anime.onnx` and verifies its published
MD5, `6f184e756bb3bd901c8849220a83e38e`, before inference. It writes only scratch
cutouts and a report; source originals and the production library are untouched.

Run that script with the prepared environment's Python. Uploaded images in the
page are local browser previews; automatic inference for new uploads is not
implemented. A matching transparent foreground can be supplied separately.

## Offline export

After preparing all four originals and both cutouts:

```sh
python docs/prototypes/gacha-cards-20261013/export-preview.py
```

The output is `.tmp/card-background-study/card-background-preview.html`. It
embeds sample images, shared styles, and fonts. Treat this file as private:
sharing it also shares the embedded artwork.

Anton is distributed under the SIL Open Font License; see `fonts/OFL.txt`.

## Verification limits

JavaScript syntax, rarity mappings, sample/tier/background selection, original
art overrides, offline export, model inference, and local HTTP routes were
checked. Cutout composites were visually inspected. Browser rendering and
interaction were not inspected because no browser surface was connected.
This prototype is not native Desktop or Android acceptance evidence.
