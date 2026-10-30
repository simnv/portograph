# Text and port geometry

Core measurements use checked-in numeric glyph advances from Verdana regular and bold, at weights
400 and 700. The table covers printable ASCII, Latin-1 and the Cyrillic block. It contains no font
outlines. Run `uv run scripts/font-metrics.py` on macOS to regenerate it from the installed fonts.

Render with `Verdana`, `font-kerning: none`, and `font-variant-ligatures: none`. Verdana is the
measured font and the only one: there is no fallback stack, because a fallback has other metrics.
The core does not inspect installed fonts; the CLI warns when Verdana is missing (`bin/font-check.mjs`).
Unknown code points reserve one em each and are returned in `unsupportedCharacters` for a caller diagnostic. This is a sizing fallback, not
full Unicode shaping. Tabs expand to four spaces. CRLF, CR and LF separate lines. The returned
canonical lines are also the renderer's input.

Default text is 12 px. Line height is the ceiling of the font's ascent, descent and line gap,
scaled to that size. Multiline width is the widest line; an empty string has no lines and zero
height. Port text defaults to 8 px. A pill has 3 px horizontal padding, a minimum unrotated size
of 24×10 px, and radius 2 (ticket 34; 3 before). Measured sizes round outward. `100G` therefore needs 28×10 px (26×10 with Arial metrics).

The JPEG and d3-fd `src/nodes/interfaceNode.ts` put the pill's long axis along the port's normal.
Top and bottom pills and their text rotate −90°. Left and right pills stay horizontal. This
corrects the earlier pipeline prose that inverted those sides. `placePortPill` returns both the
unrotated `size` and final `bounds`, with an anchor exactly on the node boundary. Renderers use
these final bounds and rotate only the text around its center; they must not rotate the rectangle
again. An offset is measured from the left edge for top/bottom, or from the top for left/right.

Port pitch is `max(12, largest tangential pill extent + 4)`. Under this orientation, the
unrotated pill height is the tangential extent for every side. Longer text increases protrusion
along the normal; clearance checks still use the complete rendered pill bounds.

`uv run scripts/font-reference.py` measures SVG `getBBox()` in a fresh temporary Chrome profile.
It writes [the browser reference](../../test/fixtures/text/chrome-reference.json). Tests compare
both weights for `100G`, proportional Latin text, an unkerned pair, and the Cyrillic provider
label. The golden's only port label is `100G`; its Chrome width is 21.46875 px at weight 400 and 23.5625 px at weight 700.

The browser probe and font extractor run outside `src`. The library has no browser or font-file
runtime dependency.
