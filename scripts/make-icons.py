"""Render the Restless icon (graphite tile + amber signal trace) to PNGs for the extension and desktop app.
Run from the repo root: python3 scripts/make-icons.py"""
import os
from playwright.sync_api import sync_playwright

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="{s}" height="{s}">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#1b2230"/>
  <rect x="4.5" y="4.5" width="119" height="119" rx="27.5" fill="none" stroke="#3a4458"/>
  <polyline points="18,74 38,74 50,34 70,98 84,52 94,74 110,74" fill="none" stroke="#f2b544"
    stroke-width="{w}" stroke-linejoin="round" stroke-linecap="round"/>
</svg>"""

targets = [("apps/extension/icons/icon-%d.png" % s, s) for s in (16, 32, 48, 128)] + [("apps/desktop/build/icon.png", 1024)]

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    for path, size in targets:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        stroke = 14 if size <= 32 else 10
        pg.set_viewport_size({"width": size, "height": size})
        pg.set_content(f"<html><body style='margin:0;background:transparent'>{SVG.format(s=size, w=stroke)}</body></html>")
        pg.locator("svg").screenshot(path=path, omit_background=True)
        print("wrote", path)
    b.close()
