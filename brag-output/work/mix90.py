"""Build the 90 s soundtrack: Mixkit music + the composition's own SFX cue list.

Pops are pitched onto the F-major pentatonic (the song's key) and climb through runs.
Run with the brag skill's uv env (librosa/numpy/soundfile):
  uv run --project <brag>/scripts python -I mix90.py
"""
import json, os, subprocess
import numpy as np
import librosa
import soundfile as sf

os.chdir(os.path.dirname(os.path.abspath(__file__)))
SR = 44100
BRAG = os.path.expanduser('~/.hermes/profiles/code/skills/creative/brag/assets/sfx')
MIX = 'dl/sfx'
MUSIC = 'dl/music/pop-track-03.mp3'
MUSIC_OFFSET = 2.0

cues = json.load(open('cues90.json'))
DUR = cues['duration']
cues = cues['cues']

# semitone ladder from the sample's own pitch onto F-major pentatonic: C5 D5 F5 G5 A5 C6 D6
# (soap-bubble sits at ~F#5, so F5 = -1)
LADDER = [-6, -4, -1, 1, 3, 6, 8]

KIND = {
    #        file,                                   base gain dB, pitched?, max length s, lowpass
    'pop':     (f'{MIX}/soap-bubble.mp3',              -5, True,  0.35),
    'tick':    (f'{MIX}/message-pop.mp3',              -6, True,  0.20),
    'card':    (f'{MIX}/dry-popup.mp3',                -12, False, 0.40),
    'click':   (f'{MIX}/modern-tech-select.mp3',       -5, False, 0.20),
    'confirm': (f'{MIX}/digital-quick-tone.mp3',       -12, False, 0.80),
    'warn':    (f'{MIX}/interface-option-select.mp3',  -11, False, 0.60),
    'whoosh':  (f'{MIX}/air-woosh.mp3',                -14, False, 0.90),
    'swish':   (f'{MIX}/explainer-pops-whoosh.mp3',    -17, False, 0.30),
    'impact':  (f'{MIX}/movie-whoosh-impact.mp3',      -14, False, 3.00),
    'drop':    (f'{BRAG}/impact/impactSoft_medium_001.ogg', -13, False, 0.4),
}
KEYS = sorted(f'{BRAG}/keyboard/keypress-{i:03d}.wav' for i in range(1, 33))

_cache = {}


def load(path, max_len):
    if path not in _cache:
        y, _ = librosa.load(path, sr=SR, mono=True)
        y, _ = librosa.effects.trim(y, top_db=45)
        y = y[: int(max_len * SR)]
        fade = min(len(y), int(0.03 * SR))
        y[-fade:] *= np.linspace(1, 0, fade)
        y = y / (np.abs(y).max() + 1e-9)
        _cache[path] = y
    return _cache[path]


def pitch(y, semis):
    if semis == 0:
        return y
    ratio = 2 ** (semis / 12)
    return librosa.resample(y, orig_sr=SR * ratio, target_sr=SR)  # faster + higher, like a tape speed-up


out = np.zeros((2, int((DUR + 3) * SR)), dtype=np.float32)
last = {}
placed = 0
for c in cues:
    kind, t = c['kind'], c['t']
    # keep repeated tiny sounds from machine-gunning
    gap = {'pop': 0.06, 'tick': 0.06, 'key': 0.045, 'swish': 0.25, 'whoosh': 0.3}.get(kind, 0.03)
    if t - last.get(kind, -9) < gap:
        continue
    last[kind] = t
    if kind == 'key':
        y = load(KEYS[(c['note'] * 7 + int(t * 1000)) % len(KEYS)], 0.2)
        gain = -6 + c['g']
    else:
        path, gain, pitched, max_len = KIND[kind]
        y = load(path, max_len)
        if pitched:
            y = pitch(y, LADDER[c['note'] % len(LADDER)])
        gain += c['g']
    amp = 10 ** (gain / 20)
    pan = 0.5 + 0.18 * np.sin(t * 7.3)  # deterministic gentle stereo spread
    i0 = int(t * SR)
    seg = y[: out.shape[1] - i0] * amp
    out[0, i0:i0 + len(seg)] += seg * np.sqrt(1 - pan)
    out[1, i0:i0 + len(seg)] += seg * np.sqrt(pan)
    placed += 1

sf.write('sfx90.wav', out.T, SR)
print('placed', placed, 'of', len(cues), 'peak', float(np.abs(out).max()))

# music + bus processing + master
filt = (
    f'[0:a]atrim=start={MUSIC_OFFSET}:duration={DUR},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st={DUR - 1.2}:d=1.2,volume=-2dB[m];'
    f'[1:a]atrim=0:{DUR},highpass=f=120,lowpass=f=10000,aecho=0.8:0.55:28|61:0.16|0.07,volume=6dB,asplit=2[fx][sc];'
    # gentle ducking: the music dips ~2-3 dB under each pop so the pops read without being loud
    f'[m][sc]sidechaincompress=threshold=0.02:ratio=2.5:attack=5:release=180:makeup=1[md];'
    f'[md][fx]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.2:LRA=9[out]'
)
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', MUSIC, '-i', 'sfx90.wav', '-filter_complex', filt,
                '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', 'mix90.wav'], check=True)
print('wrote mix90.wav')
