# PigTV brand standard (Pig family 1.6.0)

The source of truth is the Pig-Branding kit, version 1.6.0 (`Pig-Branding/docs/pig-family-brand-guide.md`, `docs/integration.md`, `tokens/brand-tokens.json`). This note only records what PigTV takes from it and where. When the kit changes, re-copy the files below rather than editing them here.

## What PigTV vendors

| PigTV path | From the kit |
| --- | --- |
| `docs/brand-tokens.json` | `tokens/brand-tokens.json` (1.6.0), copied verbatim. |
| `public/css/pig-radiance.css`, `public/css/pig-glass.css` | `tokens/pig-radiance.css`, `tokens/pig-glass.css`, copied verbatim. Do not edit them. |
| `public/img/brand/` | `assets/products/pigtv/`: `mark.svg`, `wordmark-{light,dark}.svg`, `lockup-{horizontal,stacked}-{light,dark}.svg`, and from `icons/`: `favicon-{light,dark}.ico`, `web-small-{light,dark}.svg`, `web-{light,dark}-{180,192,512}.png`. |
| `public/site.webmanifest` | Based on `web-manifest.example.json`, with real URLs (`start_url` and `scope` are `/`). |

`*-light` files are for light backgrounds (dark text), `*-dark` files for dark backgrounds. The palette is the same as 1.0 and lives in `public/css/main.css` as `--color-*` tokens (dark in `:root`, light in `[data-theme="light"]`). `public/js/theme.js` always writes the resolved `data-theme` on `<html>`. A small alias block in `main.css` defines every `--pig-*` role the vendored CSS reads as `var(--color-...)`, so it follows the theme.

## Identity

PigTV uses its own product pig (a pig-shaped TV screen), never the generic family pig. The navbar shows the horizontal lockup (`.brand-lockup`, 120 px wide, theme-switched by `[data-theme]`), the sign-in page the stacked lockup (`.login-lockup`), the loading splash the mark. Use the supplied SVGs at their intrinsic proportions and do not reassemble a pig and wordmark by hand. The accessible name "PigTV" appears once per lockup (`role="img"` and `aria-label`).

## Classes in use

| Class | Where |
| --- | --- |
| `pig-canvas-bloom` | `<body>` of `index.html` and `login.html`: the corner bloom on the canvas. `#app`, `.main-content` and pages stay transparent so it shows in gaps; cards and bars are opaque above it. The live player area is an opaque media surface. |
| `pig-splash` | The initial Home loading state in `index.html` (`.page-splash`): mark centred, text below, `--pig-r` about 1.35 times the visible pig. HomePage replaces it when it renders. |
| `pig-glass` | The navbar only (the floating control layer). |
| `pig-amount` | Figures only: channel numbers, EPG times, recording times and sizes, Status page durations, times, sizes and counts, backup link counts, the player quality badge. Wrap the figure in a span when it sits in words. |

## Rules

- Glass is for the floating control layer only. Never on cards, lists or content, and never on the player. Playback keeps its protected dark surfaces (`.watch-*`, captions and overflow menus). The mobile dropdown stays on the more opaque `--glass-bg`, because it is nested inside the glass navbar and cannot blur the page behind it.
- Radiance is never behind forms or reading content. The sign-in halo sits only behind the pig of the lockup. With `prefers-reduced-transparency` the halo and bloom are removed and glass becomes a solid surface.
- Only one primary action per screen is full-strength accent (`.btn-primary`).
- Playback surfaces, channel artwork and programme artwork keep their own colours.
