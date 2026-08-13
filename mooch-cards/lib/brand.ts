// Mooch brand tokens, mirrored from mooch.agency (tokens.css).
// Monochrome, Instrument Serif display, system-sans support. No accent colour:
// hierarchy comes from serif-vs-sans, scale, and ink-vs-muted. Anything imported
// from here flows through every template.

export const brand = {
  colors: {
    // Light is the site's primary surface (paper/ink). A dark colophon variant
    // lives below for white-on-black cards.
    bg: '#ffffff', // paper
    black: '#000000', // display type: headlines are pure black on the site
    ink: '#1d1d1f', // body text
    muted: '#6e6e73', // secondary text, mono labels
    mutedSmall: '#5a5a5f', // higher-contrast muted for text below ~24px
    hairline: '#d2d2d7', // rules, dividers, the watermark quote glyph

    // Dark colophon variant (matches .colophon-dark on the site).
    bgDark: '#000000',
    paper: '#ffffff',
    mutedDark: '#8e8e93',
  },
  type: {
    // Display type. Instrument Serif ships one weight (400) and reads as a
    // display face at size; emphasis is the italic, mixed in per-word. Headlines
    // use the italic on the one word that carries the line (the site's move).
    serif: 'Instrument Serif',
    // Body copy: Inter stands in for the site's system sans (SF Pro isn't
    // embeddable).
    sans: 'Inter',
    // Labels, eyebrows, wordmark: the site sets these in system mono, tiny,
    // uppercase, wide-tracked. IBM Plex Mono stands in (SF Mono isn't embeddable).
    mono: 'IBM Plex Mono',
    // Display tracking/leading, matched to styleguide: tight and black.
    displayTracking: '-0.02em',
    displayLeading: 1.0,
    sizes: {
      display: 128, // single huge focal element (stat number, definition term)
      hero: 104, // hero titles, hook
      large: 76, // quotes, cta prompt, section titles
      base: 34, // body, bullets
      small: 24, // byline
      label: 21, // mono eyebrows and wordmark
      caption: 18, // footnotes
    },
    weights: {
      regular: 400,
      medium: 500,
      bold: 700,
    },
  },
  spacing: {
    base: 8,
    outer: 96, // roomier margins suit the serif; near the site's --rhythm feel
  },
} as const
