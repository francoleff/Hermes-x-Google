import sys, os, glob, time
from multiprocessing import Process
from playwright.sync_api import sync_playwright
EXE = glob.glob(os.path.expanduser('~/Library/Caches/ms-playwright/chromium_headless_shell-1234/*/chrome-headless-shell'))[0]
FPS = 30
def work(idx, n, total):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=['--allow-file-access-from-files'])
        pg = b.new_page(viewport={'width': 1920, 'height': 1080})
        pg.goto('file://' + os.path.abspath('video.html')); pg.evaluate('window.ready')
        for f in range(idx, total, n):
            pg.evaluate(f'render({f / FPS})')
            pg.screenshot(path=f'frames/f{f:05d}.png')
        b.close()
if __name__ == '__main__':
    os.makedirs('frames', exist_ok=True)
    total = int(round(24.75 * FPS))
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    t = time.time()
    ps = [Process(target=work, args=(i, n, total)) for i in range(n)]
    [x.start() for x in ps]; [x.join() for x in ps]
    print('frames', len(glob.glob('frames/*.png')), 'of', total, 'in', round(time.time() - t), 's')
