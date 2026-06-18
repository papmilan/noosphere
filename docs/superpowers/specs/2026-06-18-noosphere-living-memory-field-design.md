# Noosphere Living Memory Field Design

## Goal

Redesign the Noosphere homepage as a public marketing landing page that still preserves the existing local product controls. The design direction is "Living Memory Field": a kinetic, dark, 3D-led brand surface for shared AI-agent project memory.

## Reference

Buzzworthy Studio is a motion reference, not an identity reference. Borrow the feeling of a pulsing geometric 3D hero, bold first-viewport composition, tactile hover states, and scroll-led reveals. Do not copy its colors, layout, typography, agency language, project sections, or visual identity.

## Audience

Primary visitors are developers and technical AI users who need continuity between agent sessions and tools. They should understand that Noosphere is not another chat UI; it is a shared memory layer that keeps project context available across CLIs, IDEs, local models, HTTP clients, and MCP clients.

## Visual Direction

Use a dark, immersive brand system:

- Graphite/near-black base.
- Deep teal and blue-green surfaces.
- Electric mint as the main signal color.
- Warm coral sparingly for high-value calls to action.
- Pale blue-white text.

The first screen should feel like an active memory field: a pulsing WebGL mesh with moving points, connecting lines, and subtle deformation. The object should rotate continuously, respond to pointer movement on capable devices, and remain visible without trapping the layout in a card.

## Page Structure

1. Hero: Noosphere brand, public claim, animated 3D memory field, and two calls to action: install and try recall.
2. Problem: agents forget decisions, constraints, and handoffs as work crosses tools.
3. How it works: capture, store, recall, continue.
4. Walrus-backed continuity: durable shared memory, semantic recall, local watcher, privacy defaults.
5. Demo controls: existing Remember and Recall forms restyled as a product demo/control surface.
6. Project and setup controls: existing project registration and credential setup remain available, visually secondary.
7. Install: existing OS tabs and copy buttons remain, with clearer public-facing copy.

## Interaction And Motion

- Hero 3D object: real animated canvas/WebGL, not a static SVG.
- Scroll reveal: sections enter with varied transforms tied to their purpose, not identical fade-ins everywhere.
- Process section: steps should feel like memory moving between layers.
- Buttons: hover lift, internal sheen or magnetic movement, press feedback, and focus-visible outlines.
- Background: subtle field lines or particles may move slowly, but text readability wins.
- Reduced motion: disable continuous rotation, scroll choreography, and nonessential transforms while keeping the hero object or fallback visible.

## Technical Plan

The current site is a static HTML/CSS/JS surface in `noosphere-relayer/public/`. Keep the implementation dependency-light and local:

- Use Three.js from a CDN module import in `app.js` for the hero scene if available.
- Provide a canvas fallback if WebGL or the CDN import fails.
- Keep existing API form IDs and JavaScript behavior intact.
- Restructure `index.html` around marketing sections while preserving all required form elements.
- Replace the current Swiss-style CSS with the new dark visual system.
- Add IntersectionObserver-driven reveal classes in `app.js`.
- Avoid breaking the local relayer endpoints or install copy behavior.

## Verification

After implementation:

- Run the relevant relayer/static checks available in the repo.
- Serve or open the site through the local relayer/static server.
- Use browser verification at desktop and mobile widths.
- Confirm the hero canvas is nonblank and animated.
- Confirm buttons animate and remain keyboard-focusable.
- Confirm reduced-motion CSS exists.
- Confirm existing Remember, Recall, Projects, Setup, OS tabs, and copy controls still have their IDs and handlers.
