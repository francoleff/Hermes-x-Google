"""Mix the soundtrack: bundled music + SFX on the same 114.84 BPM grid as the video."""
import os, subprocess

SK = os.path.expanduser('~/.hermes/profiles/code/skills/creative/brag/assets')
MUSIC = f'{SK}/music/happy-beats-business-moves-vol-11-by-ende-dot-app.mp3'
SFX = f'{SK}/sfx'
BEAT = 60 / 114.84
DB = [0, 1.602, 3.704, 5.80, 7.91, 10.01, 12.12, 14.22, 16.34, 18.44, 20.54, 22.65, 24.75]
DUR = 24.75

ev = []  # (time, file, gain_db)
# S1: tabs pop in on 8th notes, soft impact on the drop
for i in range(6):
    ev.append((0.04 + i * BEAT / 2 + 0.03, f'interface/drop_00{1 + i % 3}.ogg', -22))
ev.append((DB[1], 'impact/impactSoft_medium_001.ogg', -15))
# S2: window lands, sidebar click
ev.append((DB[2] + 0.05, 'impact/impactSoft_medium_004.ogg', -19))
click1 = DB[2] + 3 * BEAT
ev.append((click1, 'interface/click_003.ogg', -12))
# S3: click into search, type on 16ths, Enter on the downbeat, results land
ev.append((DB[4] + 0.2, 'interface/click_002.ogg', -14))
tType = DB[4] + 0.42
for i in range(11):
    ev.append((tType + i * BEAT / 4, f'keyboard/keypress-{(i * 7) % 32 + 1:03d}.wav', -11))
ev.append((DB[5], 'keyboard/keypress-020.wav', -8))
ev.append((DB[5] + 0.03, 'interface/bong_001.ogg', -22))
# S4: message sent, tool calls tick in on beats
ev.append((DB[6] + 0.4, 'casino/card-slide-1.ogg', -20))
for k, tt in enumerate([DB[6] + 2 * BEAT, DB[6] + 3 * BEAT, DB[7], DB[7] + BEAT]):
    ev.append((tt, 'interface/click_005.ogg', -17))
    if k < 3:
        ev.append((tt + 0.42, 'ui/click2.ogg', -21))
# S5: approval card, approve click, doc slides in
ev.append((DB[8], 'interface/bong_001.ogg', -18))
clickA = DB[8] + 2 * BEAT
ev.append((clickA, 'interface/click_003.ogg', -11))
ev.append((clickA + 0.3, 'impact/impactSoft_medium_002.ogg', -18))
ev.append((DB[9], 'casino/card-slide-1.ogg', -16))
# S6: outro sheet + logo tiles
ev.append((DB[10], 'impact/impactSoft_heavy_002.ogg', -14))
ev.append((DB[10] + 2 * BEAT, 'impact/impactSoft_medium_003.ogg', -19))

cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', MUSIC]
for _, f, _ in ev:
    cmd += ['-i', f'{SFX}/{f}']
parts = [f'[0:a]atrim=0:{DUR},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st={DUR - 1.3}:d=1.3,volume=-1dB[m]']
labels = []
for i, (t, _, g) in enumerate(ev, start=1):
    ms = int(round(t * 1000))
    parts.append(f'[{i}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume={g}dB,adelay={ms}|{ms}[s{i}]')
    labels.append(f'[s{i}]')
# SFX bus: soften highs, put it in a small room so it sits inside the music
parts.append(f'{"".join(labels)}amix=inputs={len(labels)}:normalize=0,lowpass=f=9000,aecho=0.8:0.6:35|70:0.18|0.08[fx]')
parts.append('[m][fx]amix=inputs=2:normalize=0,alimiter=limit=0.89:level=disabled,atrim=0:%s[out]' % DUR)
cmd += ['-filter_complex', ';'.join(parts), '-map', '[out]', '-ar', '44100', '-c:a', 'pcm_s16le', 'mix.wav']
subprocess.run(cmd, check=True)
print('events', len(ev))
