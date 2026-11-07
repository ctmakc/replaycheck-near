#!/usr/bin/env bash
# Builds contracts/replay-market into res/replay_market.wasm. Needs rustup with the
# wasm32-unknown-unknown target (rust-toolchain.toml pins 1.86). near-sdk 5.27 is selected by
# Cargo.lock; `.cargo/config.toml` lets cargo fall back from newer releases that want rustc 1.95.
set -euo pipefail
cd "$(dirname "$0")/../contracts/replay-market"
RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" cargo build --release --target wasm32-unknown-unknown
mkdir -p res
cp "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/replaycheck_market.wasm" res/replay_market.wasm
ls -la res/replay_market.wasm
