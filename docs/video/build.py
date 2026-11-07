#!/usr/bin/env python3
"""Cuts docs/video/out/raw.webm by the recorder's marks, speeds up the waiting, lays a narration
(edge-tts) and burns subtitles. Output: public/demo.mp4 + docs/video/out/demo.srt.

    python3 docs/video/build.py            # EDGE_TTS=/data/venvs/edge-tts/bin/edge-tts by default
"""
import json, os, pathlib, subprocess, hashlib, shlex

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "out"; TTS = OUT / "tts"; TTS.mkdir(parents=True, exist_ok=True)
EDGE = os.environ.get("EDGE_TTS", "/data/venvs/edge-tts/bin/edge-tts")
VOICE = os.environ.get("VOICE", "en-US-AndrewNeural")
RAW = OUT / "raw.webm"
FINAL = HERE.parents[1] / "public" / "demo.mp4"
m = json.loads((OUT / "marks.json").read_text())
marks = {x["name"]: x["t"] / 1000 for x in m["marks"]}

# scene: (name, text, min visual seconds, speed factor for the raw segment)
SCENES = [
    ("hero", "ReplayCheck replays your sign-in and checkout in a real browser after every release. On NEAR, every step of a run is a transaction, and the agent pays its own supplier.", 0, 1),
    ("run", "A customer funds a job on the market contract: a small fee in escrow, with the hash of the task list inside. The agent can only be paid for exactly those flows.", 0, 1),
    ("accepted", "The agent accepts. The deadline starts; if no report comes, the customer takes the deposit back on their own.", 0, 1),
    ("renting", "Then it rents a browser from another agent. The worker answers HTTP 402 with an invoice. The agent pays through the contract with a one-time memo. The worker reads the receipt on-chain and opens Chromium.", 0, 1),
    ("task1", "Two flows: a good sign-in, and a wrong password judged by a local model that is paid the same way.", 0, 12),
    ("delivered", "Delivery is a hash. The report's SHA-256 and the pass count go on-chain, and the same call releases the escrow to the agent. The board stamps it paid.", 0, 1),
    ("report", "The customer re-hashes the report and compares. Underneath: everything the agent bought for this run, each line with its transaction.", 0, 1),
    ("books", "The agent keeps its books on-chain. Revenue from deliveries, cost from payments to the worker, margin read from the chain, not from a database it controls.", 0, 1),
    ("end", "Repo and live demo are in the post. Built at NEAR Hackathon by INNOVA CONSULT, Ottawa.", 0, 1),
]
ORDER = [s[0] for s in SCENES]

def tts(text):
    key = hashlib.sha1((VOICE + text).encode()).hexdigest()[:10]
    mp3 = TTS / f"{key}.mp3"
    if not mp3.exists():
        subprocess.run([EDGE, "--voice", VOICE, "--rate=+4%", "--text", text, "--write-media", str(mp3)], check=True, capture_output=True)
    d = float(subprocess.run(["ffprobe", "-v", "0", "-show_entries", "format=duration", "-of", "csv=p=0", str(mp3)], capture_output=True, text=True).stdout.strip())
    return mp3, d

segs = []  # (src_start, src_end, speed, mp3, narration_dur, name)
for i, (name, text, minvis, speed) in enumerate(SCENES):
    start = marks[name]
    end = marks[ORDER[i + 1]] if i + 1 < len(ORDER) else None
    if end is None:  # last scene: to the end of the raw video
        end = float(subprocess.run(["ffprobe", "-v", "0", "-show_entries", "format=duration", "-of", "csv=p=0", str(RAW)], capture_output=True, text=True).stdout.strip())
    mp3, d = tts(text)
    segs.append([start, end, speed, mp3, d, name])

# Each scene must last at least its narration + 0.6 s. Speed factor is applied to the raw segment;
# if the sped-up segment is shorter than the narration, lower the speed so it fits; if a 1x
# segment is shorter than the narration, hold the last frame (tpad).
vf_parts, af_parts, srt, t_out = [], [], [], 0.0
for k, (s, e, speed, mp3, d, name) in enumerate(segs):
    raw_len = e - s
    need = d + 0.6
    if speed > 1 and raw_len / speed < need:
        speed = max(1.0, raw_len / need)
    out_len = raw_len / speed
    pad = max(0.0, need - out_len)
    vf_parts.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=(PTS-STARTPTS)/{speed:.4f}" + (f",tpad=stop_mode=clone:stop_duration={pad:.3f}" if pad > 0 else "") + f"[v{k}]")
    af_parts.append(f"[{k+1}:a]adelay={int(t_out*1000)}|{int(t_out*1000)}[a{k}]")
    def ts(x): h = int(x // 3600); mn = int(x % 3600 // 60); sc = x % 60; return f"{h:02d}:{mn:02d}:{sc:06.3f}".replace('.', ',')
    srt.append(f"{k+1}\n{ts(t_out + 0.1)} --> {ts(t_out + d)}\n{segs[k][3] and SCENES[k][1]}\n")
    t_out += out_len + pad
concat = "".join(f"[v{k}]" for k in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=0[vcat]"
amix = "".join(f"[a{k}]" for k in range(len(segs))) + f"amix=inputs={len(segs)}:normalize=0,volume=1.6[aout]"
(OUT / "demo.srt").write_text("\n".join(srt))
srt_path = str(OUT / "demo.srt").replace(":", "\\:")
filt = ";".join(vf_parts + [concat] + af_parts + [amix]) + f";[vcat]subtitles='{srt_path}':force_style='FontName=Barlow,FontSize=15,PrimaryColour=&H00F2F3EE,OutlineColour=&H80000000,BorderStyle=3,Outline=0,Shadow=0,MarginV=28'[vout]"
cmd = ["ffmpeg", "-y", "-i", str(RAW)] + sum([["-i", str(sg[3])] for sg in segs], []) + ["-filter_complex", filt, "-map", "[vout]", "-map", "[aout]", "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(FINAL)]
print(" ".join(shlex.quote(c) for c in cmd)[:400] + " …")
subprocess.run(cmd, check=True)
dur = subprocess.run(["ffprobe", "-v", "0", "-show_entries", "format=duration", "-of", "csv=p=0", str(FINAL)], capture_output=True, text=True).stdout.strip()
print("final", FINAL, f"{float(dur):.1f}s", f"{FINAL.stat().st_size/1e6:.1f} MB")
