---
name: baby-app
description: Spin up a throwaway design prototype, iterate until it feels right, then extract what worked. Use when exploring a design idea, testing an interaction, or discovering what you want before committing to a proper build. Triggers on "baby app", "/baby-app", "throwaway prototype", "design spike", "vibe the design", or "let's explore [UI thing] before building it".
user-invocable: true
---

<!-- moochbot byline: built and maintained by Moochbot for mooch.agency. -->

Spin up a throwaway design prototype, iterate until it feels right, then extract the patterns. Discovery only, not for shipping.

## Usage

```
/baby-app <what you're exploring>
```

Example: `/baby-app settings page with dark mode and billing section`

## Step 1: Set up the baby repo

Create a timestamped throwaway directory named after the thing being explored:

```bash
BABY_NAME="baby-$(date +%Y%m%d)-[short-slug-of-what-being-explored]"
mkdir ~/$BABY_NAME && cd ~/$BABY_NAME
```

Scaffold a minimal Next.js app with Tailwind. No tests. No CI. No architecture concerns.

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --no-src-dir --import-alias "@/*" --yes
```

Tell the user the directory name and confirm this is a zero-stakes repo: anything goes.

## Step 2: Build the design

Implement the design described in the user's request. Constraints:

- Move fast. Skip permissions assumed.
- No tests required.
- No backend unless strictly needed for the interaction to make sense.
- Use Tailwind utility classes throughout, which makes pattern extraction easier later.
- Prioritise: does it *feel* right? Is the layout clear? Does the interaction make sense?

If the brief is ambiguous, generate 2 variations and tell the user what you tried and what you skipped.

## Step 3: Deploy a preview

```bash
cd ~/$BABY_NAME && npx vercel --yes
```

Share the preview URL in chat. This is what gets shared with reviewers: a live link, not a screenshot.

**Pause here.** Say: "Click around. Share the link with a reviewer if useful. Come back with what felt right and what didn't."

Wait for the user's feedback before continuing.

## Step 4: Iterate

Apply feedback. Redeploy after each round:

```bash
npx vercel --yes
```

Keep iterating until the user says it's right. The goal is to nail the feel, not to ship clean code.

## Step 5: Extract patterns

Once the user is happy, extract what worked into a design notes file. Be specific and concrete, no vague summaries.

Create `~/design-notes/[slug]-[date].md`:

```markdown
# Design notes: [what was explored]: [date]

## Colours
- Primary: [hex]
- Background: [hex]
- Surface: [hex]
- Text primary / secondary: [hex]

## Spacing
- Base unit: [Xpx]
- Section gaps: [Xpx]
- Component padding: [values]

## Typography
- Heading: [weight, size, tracking]
- Body: [weight, size, line-height]
- Label / caption: [weight, size]

## Component patterns
[Name each component that worked. Describe specifically what made it work.]
- e.g. "Toggle: rounded-full, 44px wide, subtle shadow. No label inside the track."
- e.g. "Card: 1px border, no shadow, 8px radius. Hover: border darkens."

## What reviewers said
[Direct quotes or paraphrased feedback]

## Worth lifting verbatim
[Specific code snippets worth copying to the real project]

## What to avoid
[Things tried that didn't work, so we don't try them again]
```

Tell the user the full path to the saved file.

## Step 6: Hand off

Tell the user:

- The final preview URL
- Where the design notes file is saved
- "When you're ready to build this for real, start a new plan that references these notes. Don't build on top of this repo."
- How to delete the baby repo: `rm -rf ~/$BABY_NAME`

The baby app is evidence. Not foundation.
