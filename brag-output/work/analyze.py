"""Analyze candidate music (structure, key) and SFX (duration, brightness). Read-only."""
import glob, json, os, sys
import numpy as np
import librosa

os.chdir(os.path.dirname(os.path.abspath(__file__)))
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def key_of(y, sr):
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best = max(((np.corrcoef(np.roll(p, k), chroma)[0, 1], NOTES[k] + m) for p, m in ((MAJ, ' major'), (MIN, ' minor')) for k in range(12)))
    return best[1]


def music(name):
    y, sr = librosa.load(f'dl/music/{name}.mp3', sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units='time')
    rms = librosa.feature.rms(y=y, hop_length=512)[0]
    t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=512)
    per_s = [20 * np.log10(rms[(t >= s) & (t < s + 1)].mean() + 1e-9) for s in range(int(t[-1]))]
    onset = librosa.onset.onset_strength(y=y, sr=sr)
    print(f'== {name}: tempo {float(np.atleast_1d(tempo)[0]):.2f}, key {key_of(y, sr)}, dur {len(y)/sr:.1f}s')
    print('   dB/s:', ' '.join(f'{v:.0f}' for v in per_s))
    print('   beats:', ' '.join(f'{b:.2f}' for b in beats[:24]), '...', ' '.join(f'{b:.2f}' for b in beats[-8:]))
    json.dump({'beats': [float(b) for b in beats], 'db_per_s': [float(v) for v in per_s]}, open(f'dl/{name}.analysis.json', 'w'))


def sfx():
    for f in sorted(glob.glob('dl/sfx/*.mp3')):
        y, sr = librosa.load(f, sr=44100, mono=True)
        yt, _ = librosa.effects.trim(y, top_db=40)
        cent = librosa.feature.spectral_centroid(y=yt, sr=sr).mean() if len(yt) > 2048 else 0
        f0 = librosa.yin(yt, fmin=150, fmax=2000, sr=sr) if len(yt) > 4096 else [0]
        pitch = np.median(f0)
        note = librosa.hz_to_note(pitch) if pitch > 0 else '-'
        print(f'{os.path.basename(f):32s} trimmed {len(yt)/sr:5.2f}s  centroid {cent:6.0f}Hz  pitch~{note}')


for n in sys.argv[1:]:
    music(n)
sfx()
