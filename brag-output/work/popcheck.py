"""Pop-to-music ratio: SFX bus (as mixed, +6 dB) vs the music bed (-2 dB) in the same 80 ms window at each pop."""
import json, os
import numpy as np
import soundfile as sf
import librosa
os.chdir(os.path.dirname(os.path.abspath(__file__)))
fx, sr = sf.read('sfx90.wav'); fx = fx.mean(axis=1) * 10 ** (6 / 20)
mu, _ = librosa.load('dl/music/pop-track-03.mp3', sr=sr, mono=True, offset=2.0, duration=90)
mu = mu * 10 ** (-2 / 20)
rms = lambda a: 20 * np.log10(np.sqrt(np.mean(a ** 2)) + 1e-9)
for kinds in (('pop',), ('tick',), ('click',), ('key',)):
    cues = [c for c in json.load(open('cues90.json'))['cues'] if c['kind'] in kinds]
    d = np.array([rms(fx[int(c['t'] * sr):int((c['t'] + 0.08) * sr)]) - rms(mu[int(c['t'] * sr):int((c['t'] + 0.08) * sr)]) for c in cues])
    print(f'{kinds[0]:6s} SFX minus music: median {np.median(d):+.1f} dB  (10th {np.percentile(d, 10):+.1f}, 90th {np.percentile(d, 90):+.1f})')
