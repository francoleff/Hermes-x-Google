"""Usage: stills.py <html> <outdir> t1 t2 ...  — renders stills, prints page errors."""
import sys, os, glob
from playwright.sync_api import sync_playwright
EXE = glob.glob(os.path.expanduser('~/Library/Caches/ms-playwright/chromium_headless_shell-1234/*/chrome-headless-shell'))[0]
html, outdir, times = sys.argv[1], sys.argv[2], [float(x) for x in sys.argv[3:]]
os.makedirs(outdir, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE, args=['--allow-file-access-from-files'])
    pg = b.new_page(viewport={'width': 1920, 'height': 1080})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto('file://' + os.path.abspath(html)); pg.evaluate('window.ready')
    for t in times:
        pg.evaluate(f'render({t})'); pg.screenshot(path=f'{outdir}/t{t:06.2f}.png')
    print('errors:', errs)
    b.close()
