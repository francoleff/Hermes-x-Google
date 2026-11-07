import sys, os, glob
from playwright.sync_api import sync_playwright
EXE = glob.glob(os.path.expanduser('~/Library/Caches/ms-playwright/chromium_headless_shell-1234/*/chrome-headless-shell'))[0]
html, out, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE); pg = b.new_page(viewport={'width': w, 'height': h})
    pg.goto('file://' + os.path.abspath(html)); pg.wait_for_timeout(800); pg.screenshot(path=out); b.close()
