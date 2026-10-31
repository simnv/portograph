# /// script
# requires-python = ">=3.11"
# ///
"""Capture SVG text widths in an isolated Chrome profile; no core browser dependency."""
import json
import re
import subprocess
import tempfile
from pathlib import Path

samples = [
    {"text": text, "fontSize": size, "weight": weight}
    for text, size in [("100G", 8), ("WWWiii", 12), ("Провайдеры / Контрагенты", 12), ("AV", 12)]
    for weight in [400, 700]
]
chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
html = """<!doctype html><meta charset="utf-8"><svg xmlns="http://www.w3.org/2000/svg"></svg>
<pre id="result"></pre><script>
const samples = SAMPLES;
const svg = document.querySelector('svg');
for (const sample of samples) {
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('font-family', 'Verdana');
  text.setAttribute('font-size', sample.fontSize);
  text.setAttribute('font-weight', sample.weight);
  text.style.fontKerning = 'none';
  text.style.fontVariantLigatures = 'none';
  text.textContent = sample.text;
  svg.append(text);
  const box = text.getBBox();
  sample.width = box.width;
  sample.height = box.height;
}
document.querySelector('#result').textContent = JSON.stringify(samples);
</script>""".replace("SAMPLES", json.dumps(samples, ensure_ascii=False))
with tempfile.TemporaryDirectory(prefix="portograph-font-") as directory:
    root = Path(directory)
    page = root / "measure.html"
    page.write_text(html)
    result = subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--no-first-run",
         f"--user-data-dir={root / 'profile'}", "--dump-dom", page.as_uri()],
        check=True, text=True, capture_output=True, timeout=30,
    )
    match = re.search(r'<pre id="result">(.*?)</pre>', result.stdout, re.S)
    if not match:
        raise RuntimeError("Chrome did not produce SVG measurements")
    measured = json.loads(match.group(1))
version = subprocess.check_output([chrome, "--version"], text=True).strip()
evidence = {"fontFamily": "Verdana", "fontKerning": "none", "fontVariantLigatures": "none",
            "browser": version, "samples": measured}
destination = Path("test/fixtures/text/chrome-reference.json")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(evidence, ensure_ascii=False, indent=2))
