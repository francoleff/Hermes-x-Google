"""Fit a fixed tempo grid (period + phase) to the onset envelope, and find which beat is the bar downbeat."""
import os
import numpy as np
import librosa
os.chdir(os.path.dirname(os.path.abspath(__file__)))
y, sr = librosa.load('dl/music/pop-track-03.mp3', sr=22050, mono=True)
hop = 128
env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
# low-band onset for kick detection
yl = librosa.effects.preemphasis(y, coef=-0.97)
S = np.abs(librosa.stft(y, hop_length=hop))
freqs = librosa.fft_frequencies(sr=sr)
kick = np.maximum(0, np.diff(S[freqs < 150].sum(axis=0), prepend=0))
fr = sr / hop
def score(e, p, ph, t0=4.0, t1=91.0):
    ts = np.arange(ph, t1, p); ts = ts[ts >= t0]
    idx = np.round(ts * fr).astype(int)
    return sum(e[max(0, i - 2):i + 3].max() for i in idx) / len(idx)
best = max(((score(env, p, ph), p, ph) for p in np.arange(0.5500, 0.5600, 0.00005) for ph in np.arange(0, p, 0.004)))
_, P, PH = best
print(f'period {P:.5f}s = {60/P:.3f} bpm, phase {PH:.4f}s, score {best[0]:.3f}')
first = PH + P * np.ceil((4.2 - PH) / P)
print('first beat after intro:', round(first, 4))
# downbeat: which of 4 beat phases has the strongest kick
for k in range(4):
    print(' bar phase', k, round(first + k * P, 4), 'kick', round(score(kick, 4 * P, (first + k * P) % (4 * P)), 2))
# residual check: local onset peak offset per beat over the track
ts = np.arange(first, 91, P)
offs = []
for t in ts:
    i = int(round(t * fr)); w = env[i - 6:i + 7]
    offs.append((np.argmax(w) - 6) / fr * 1000)
offs = np.array(offs)
print('median |offset| ms', np.median(np.abs(offs)).round(1), ' 90th pct', np.percentile(np.abs(offs), 90).round(1))
