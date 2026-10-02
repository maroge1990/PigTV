# Pig family brand standard 1.0

Approved 2 October 2026. The user approved the reviewed pack except radiating rays and authorised implementation. This standard supersedes the draft for ongoing work; retain review documents as historical evidence.

## Identity

The complete pig is the primary family mark. Use large crops or isolated details as secondary artwork in spacious welcome, empty-state or promotional compositions. Do not turn a motif into an unlabeled control. Related products may pair the pig with their own approved name; PigTV remains the product name for these clients.

Use `assets/pig-master-transparent.png` as the source. The 1000 x 797 master preserves the original interior artwork and colours while removing the white exterior matte. Transparent 512 px and 256 px copies are supplied. Preserve alpha; never flatten the master against white. Do not distort, recolour or silently redraw it. The OS-required tinted icon is an explicit platform exception.

The optical anchor is **49.9694% across and 40.5360% down**. Place that point at the intended visual centre, not the centre of the image rectangle. Align a composed pig/wordmark group by visible artwork, with clear space starting at 15% of visible face width. Centre control labels and navigation groups where appropriate; keep reading content left aligned.

Use supplied light/dark wordmark artwork. The approved authoring face is Arial Rounded MT Bold, rendered into transparent PNGs to ensure identical consumer artwork without distributing a font. The native asset generator requires that face and fails explicitly if it is missing. Interface text uses native platform type and Dynamic Type, or Inter/system sans-serif on the web.

## Semantic colour

Exact values and provenance live in `brand-tokens.json`. Light canvas is #FBF8FA, surface #FFFFFF and raised surface #F2ECF0. Dark canvas is #15111A, surface #1E1925 and raised surface #251E2E.

Light action/focus is #D6336C with white action labels; light accent text and hover use #B02356. Dark action/focus is #EF7AAE with #442A19 action labels; dark hover is #F6B7D4. Primary/secondary text use their documented roles. Meaningful control edges use control-border, never decorative border alone. Status retains success/warning/danger meanings, accompanied by text or symbols.

Native system-owned text, controls and status treatments may retain platform semantic colours where replacing them would alter accessibility or behaviour. Playback keeps protected dark surfaces, white labels and fixed rose #EF7AAE accent in both appearances. Channel and programme artwork retain their colours.

## Shapes and spacing

Use four shape roles: compact controls/cells, content cards, spacious hero framing, and capsule choices/actions. Web uses existing 6/10/16 px radii; touch keeps native controls, 14-16 pt content cards and 22 pt heroes; TV retains 10 pt compact, 18 pt cards and 32 pt heroes. These are corresponding roles rather than forced identical geometry. The spacing vocabulary is 4/8/12/16/24/32/48. Do not change information density, target size, continuation clipping or focus traversal merely to match a number.

## Selection, focus and interaction

- Persistent selection: accent at 14% opacity over a surface plus a short inset accent bar. Centre it beneath chip/tab labels; use a leading bar on rows.
- Focus: separate outer accent ring. Focus may move without changing selection; both signals coexist on the selected focused control.
- Preserve existing press, hover, disabled, loading, error, scaling, activation and accessibility behaviour.
- Application-owned selection does not use ticks. Success/completed-status symbols are not selection and may remain.
- Native menus, pickers and system TV tabs preserve their platform semantics and rendering. In tvOS tabs, moving focus selects the tab; native pills remain and use the theme's contrasting label role.

## Light effects

Soft halo is the default for splash and sign-in. Bloom is an optional approved decorative treatment. **Rays are excluded.** Use approved rose/pale pink with alpha, centred on the pig's optical anchor. Keep effects behind opaque form surfaces, away from dense guide content and playback controls, and outside hit-testing/focus/accessibility.

No extra startup delay or animation was added. Existing native startup animation, reduced-motion behaviour and slow-start indication remain. Native sign-in decoration honours reduced transparency. Any new motion requires review.

## Platform implementation

Web uses semantic CSS variables and existing component classes. Actual login now uses the cleaned pig and common raster wordmark, with a quiet halo behind the opaque form. Routes, validation, authentication and responsive structure remain intact. Navigation, caption selection and Sport category toggles expose graphical selected state and accessible semantics.

Swift uses named adaptive colour assets and existing shared control styles. SwiftUI backgrounds, UIKit containers, guide collection views and tab backgrounds share the canvas role. The cleaned pig and alpha-based anchor are used at identity entry points. The generator produces light/dark launch assets and icons, shared wordmarks, tvOS parallax layers and Top Shelf art; launch and first splash frame share geometry.

## Validation and release

See `05-implementation-record.md` for actual checks and limitations. The 16 approved solid colour pairs pass their specified thresholds. Fixture captures are isolated evidence, not certification of every live state. Physical-TV viewing distance, device HDR/moving-video contrast and final release checks remain required before release.

Implementation is local. Nothing was pushed, deployed or released. Review new colours, redraws, product names, motion, navigation or control geometry separately. Record approved changes and platform exceptions in a dated version history.
