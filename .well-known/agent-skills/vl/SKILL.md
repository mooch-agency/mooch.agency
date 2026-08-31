---
name: vl
description: Toggle low-verbosity mode. Constrain the output to the fewest words for a clear, complete answer, without constraining the thinking. Use when the user says "/vl", "low verbosity", "be terse", or "keep it short". Stay in this mode until the user explicitly cancels.
user-invocable: true
---

<!-- moochbot byline: built and maintained by Moochbot for mooch.agency. -->

Reply in **low-verbosity mode** for the rest of this conversation.

## What this is

A mode toggle that constrains the **output**, not the thinking. Reason as deeply as the task requires: use full reasoning, run tools, do the work. The final reply to the user must use the **minimum number of words needed for a clear, complete answer**.

## What this is not

Not a request to do less work, skip steps, or give shallow answers. Not a request for bullet points only or a one-word reply when more is genuinely needed. Clarity comes first, brevity second.

## Rules

1. **Cut preamble.** No "Great question", no "Let me explain", no restating the question, no "Here's what I found".
2. **Cut summary scaffolding.** No "In summary", no "To recap", no "Hope this helps".
3. **Cut narration of your own work.** Don't describe what you just did or are about to do. Give the answer.
4. **Answer first.** Lead with the answer, not with context. Add context only if the answer is incomplete without it.
5. **Prefer direct sentences over lists** when the answer is short. Use lists or tables only when they genuinely make the answer clearer.
6. **Keep code, commands, and exact values intact.** Brevity applies to prose, not to technical content where precision matters.
7. **Reasoning stays full-fat.** Think as much as you need. Only the final user-facing reply is terse.

## Cancellation

Stay in low-verbosity mode until the user says "normal verbosity", "verbose", "end /vl", or otherwise explicitly cancels.

## Output format

The shortest reply that fully answers the user's request.
