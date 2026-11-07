# X post draft — ReplayCheck on NEAR (for the owner to post)

Rules (nearhackathon.com/HACKATHON.md): the human posts it; it must say the project was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, and attach the demo video or screenshots. Video: `public/demo.mp4` (also https://replaycheck-near.mmix.biz/demo.mp4). Attach the video file to the post.

---

A prompt change that passes review still breaks sign-in. Who pays for the test, and who holds the money until the report exists?

ReplayCheck on NEAR: a QA agent that replays your flows in a real browser, gets paid through an escrow contract, and pays its own browser worker over HTTP 402 with one-time memos. Delivery is the report hash on-chain; the same call releases the fee.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon @NearBuilders

Live (testnet, no wallet needed): https://replaycheck-near.mmix.biz
Code: https://github.com/ctmakc/replaycheck-near

Question for builders: would you let a CI pipeline gate a release on `passed == total` read from a contract, if the report hash is there too?

---

Short variant (if the first is over the limit):

A QA agent that gets paid in NEAR and pays its own browser worker over HTTP 402. Escrow in, report hash out, fee released in the same call. Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
Live: https://replaycheck-near.mmix.biz · Code: https://github.com/ctmakc/replaycheck-near
Would you gate a release on a pass count read from the chain?
