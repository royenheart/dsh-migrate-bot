#!/bin/bash
# Harbor's entry point of the verifier: judge.mjs prints the checks and, last, {"score": 0-100}; the reward is score / 100.
mkdir -p /logs/verifier
node /tests/judge.mjs 2>&1 | tee /logs/verifier/judge.log
node -e '
const lines = require("node:fs").readFileSync("/logs/verifier/judge.log", "utf8").trim().split("\n")
let score = 0
try { score = JSON.parse(lines.at(-1)).score } catch {}
require("node:fs").writeFileSync("/logs/verifier/reward.txt", `${Math.max(0, Math.min(100, score)) / 100}\n`)
'
