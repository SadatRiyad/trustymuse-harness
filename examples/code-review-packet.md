# Packet for Claude, normal account

Task type: code_review
Slot: coding
Title: Review budget guard in budget.ts
Tier: 2

## Safety rules for this packet
Do not include any password, API key, or secret in your reply.
Do not invent facts, links, prices, or dates. If a fact is missing, say it is missing.
Keep the tone clear and natural. Avoid generic filler.

## Task
Review the file src/budget.ts in the TrustyMUSE Harness V1 skeleton. Check these points: does a cap of 0 block every paid call, does the 80 percent warning trigger at the right point, does the hard stop trigger when spend would exceed the cap, and is there any path where a negative amount or a missing usage file could bypass the guard. List each finding with the exact file and line, and say if it is a blocker, a fix, or a note. Do not rewrite the file.

## Context
Harness: TrustyMUSE Harness V1, local only, Node with TypeScript.
Budget: monthly cap default 0 in USD, stored in state/usage.json per month.
Policy: no auto publish, send, merge, or deploy. HOLD fails closed.

## Expected output format
Return a clear review with headings, a findings table, and a short checklist at the end.

## Verification
Check every finding against the exact file and line. No fix is applied without user approval for that exact item.

## How to return the result
Paste the full result back to TrustyMUSE. Keep the headings from the expected format.
