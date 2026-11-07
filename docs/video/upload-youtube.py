# Upload public/demo.mp4 to YouTube Studio (@maxhacksca) through the owner's logged-in Chrome.
# Run:  BH_OWNER_WHY="YouTube Studio @maxhacksca: hackathon demo upload" browser-harness < docs/video/upload-youtube.py
# Notes from domain-skills/youtube-studio/upload.md: focus emulation first; title/description are contenteditable;
# radios by name; #next-button x3; #done-button; the youtu.be link is in the dialog right after the upload starts.
import json, os, time

VIDEO = "/data/projects/replaycheck-near/public/demo.mp4"
SRT = "/data/projects/replaycheck-near/docs/video/out/demo.srt"
CHANNEL = "UCMwR9oFA5WVCCnDgQ5PD85A"
TITLE = "ReplayCheck on NEAR — a QA agent that gets paid in NEAR and pays its own browser worker (NEAR Hackathon 2026)"
DESC = """A QA agent that replays your sign-in and checkout in a real browser after every release, settled on NEAR.

The customer funds a job on a market contract with the hash of the task list inside (escrow). The agent accepts, rents browser minutes and plain-language judgements from a second agent over HTTP 402 (near402: the worker answers 402 with an invoice, the agent pays through pay(to, memo) on the same contract, the worker verifies the NEP-297 event from the receipt). Delivery is the report's SHA-256 and the pass count on-chain; the same call releases the escrow. The customer re-hashes the report and compares.

Live demo (testnet, no wallet needed): https://replaycheck-near.mmix.biz
Code (MIT): https://github.com/ctmakc/replaycheck-near
Contract: market.rc-f44644.testnet

Built at NEAR Hackathon 2026 by INNOVA CONSULT LTD, Ottawa. Tracks: Agent Economy, Autonomous Business, Open Innovation.

0:00 The problem
0:12 A customer funds a job (escrow + task hash)
0:24 The agent accepts
0:32 Paying the browser worker over HTTP 402
0:50 Two flows replayed
0:58 Delivery is a hash; escrow released
1:10 The report and what the agent bought
1:22 The agent's books on-chain
"""

cdp("Emulation.setFocusEmulationEnabled", enabled=True)
open_url(f"https://studio.youtube.com/channel/{CHANNEL}/videos/upload?d=ud", reload=True)
wait(4)
upload_file("input[type=file][name=Filedata]", VIDEO)

def q(sel):
    return js(f"(()=>{{const el=document.querySelector({json.dumps(sel)});return el?{{ok:true,text:(el.innerText||el.value||'').slice(0,200)}}:null}})()")

for i in range(40):
    if q("ytcp-uploads-dialog #title-textarea #textbox"): break
    wait(1)
else:
    raise SystemExit("upload dialog did not open")
wait(2)

def set_editable(sel, text):
    ok = js(f"(()=>{{const el=document.querySelector({json.dumps(sel)});if(!el)return false;el.focus();const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);return true}})()")
    if not ok: raise SystemExit("no field " + sel)
    type_text(text)
    wait(0.5)

set_editable("ytcp-uploads-dialog #title-textarea #textbox", TITLE)
set_editable("ytcp-uploads-dialog #description-textarea #textbox", DESC)
js("(()=>{const r=document.querySelector('tp-yt-paper-radio-button[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]');if(r){r.click();return true}return false})()")
wait(1)
link = ""
for i in range(60):
    link = js("(()=>{const a=[...document.querySelectorAll('ytcp-uploads-dialog a')].find(a=>/youtu\\.be\\//.test(a.href||a.textContent));return a?(a.href||a.textContent):''})()") or ""
    if link: break
    wait(2)
print("link:", link)
for step in range(3):
    js("(()=>{const b=document.querySelector('ytcp-uploads-dialog #next-button');if(b){b.click();return true}return false})()")
    wait(2)
# visibility
js("(()=>{const r=document.querySelector('tp-yt-paper-radio-button[name=PUBLIC]');if(r){r.click();return true}return false})()")
wait(1)
# wait until processing allows publishing (done button enabled)
for i in range(90):
    st = js("(()=>{const b=document.querySelector('ytcp-uploads-dialog #done-button');if(!b)return 'none';return b.hasAttribute('disabled')?'disabled':'ready'})()")
    if st == "ready": break
    wait(3)
js("(()=>{const b=document.querySelector('ytcp-uploads-dialog #done-button');if(b){b.click();return true}return false})()")
wait(4)
print("done:", json.dumps({"link": link, "status": q("ytcp-uploads-dialog") and "dialog still open" or "closed"}))
screenshot("/data/projects/grant-ops-v3/data/submission-proofs/near-replaycheck-youtube-1107.png")
