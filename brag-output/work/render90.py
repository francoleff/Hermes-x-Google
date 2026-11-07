"""Usage: render90.py <html> <framesdir> <workers> [--sfx out.json]
Renders every frame at 30 fps (parallel workers; each frame is a pure function of time).
With --sfx, only exports the composition's registered sound cues and exits."""
import sys, os, glob, time, json
from multiprocessing import Process
from playwright.sync_api import sync_playwright

EXE = glob.glob(os.path.expanduser('~/Library/Caches/ms-playwright/chromium_headless_shell-1234/*/chrome-headless-shell'))[0]
FPS = 30


def page(p, html):
    b = p.chromium.launch(executable_path=EXE, args=['--allow-file-access-from-files'])
    pg = b.new_page(viewport={'width': 1920, 'height': 1080})
    pg.goto('file://' + os.path.abspath(html))
    pg.evaluate('window.ready')
    return b, pg


def work(html, out, idx, n, total):
    with sync_playwright() as p:
        b, pg = page(p, html)
        for f in range(idx, total, n):
            path = f'{out}/f{f:05d}.png'
            if os.path.exists(path):
                continue
            pg.evaluate(f'render({f / FPS})')
            pg.screenshot(path=path)
        b.close()


if __name__ == '__main__':
    html, out = sys.argv[1], sys.argv[2]
    if '--sfx' in sys.argv:
        with sync_playwright() as p:
            b, pg = page(p, html)
            cues = pg.evaluate('window.collectSFX()')
            json.dump({'duration': pg.evaluate('window.DURATION'), 'cues': cues}, open(sys.argv[sys.argv.index('--sfx') + 1], 'w'), indent=0)
            print('cues', len(cues))
            b.close()
        sys.exit(0)
    n = int(sys.argv[3])
    os.makedirs(out, exist_ok=True)
    with sync_playwright() as p:
        b, pg = page(p, html)
        total = int(round(pg.evaluate('window.DURATION') * FPS))
        b.close()
    t = time.time()
    ps = [Process(target=work, args=(html, out, i, n, total)) for i in range(n)]
    [x.start() for x in ps]
    [x.join() for x in ps]
    print('frames', len(glob.glob(f'{out}/*.png')), 'of', total, 'in', round(time.time() - t), 's')
