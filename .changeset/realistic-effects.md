---
"desktop-destroyer": minor
---

Realistic feedback effects, all procedural and physically motivated:

- **Impact dust** — rigid debris chunks that land hard (or slam into each other) now knock a puff of pale paper dust loose at the contact point. Hooked into the physics solver's contact pass with a hard impulse threshold, rate-gated, and scaled by the quality profile.
- **Ember dynamics** — burning pages shed drifting embers that ride the thermal plume, sway, flicker, and cool through the full white-orange → orange → dull-red arc (new `emberDark` sprite) before dying.
- **Bullet ricochet** — an occasional round glances off instead of biting clean: a tight spark fan and exit streak leave along the deflected barrel line (aimed off `engine.toolAim`), with a graze of dust and a metallic tink.
- **Water splashback** — hose droplets now splash *directionally*, keeping part of their arriving momentum, and one in three genuinely bounces back off the page and lands again downstream.
- **Frost shatter glint** — fracturing frozen page throws a brief crystalline twinkle over the break, so ice reads as glass catching the light rather than pale paper.
- **Smoke turbulence** — smoke columns curl with a second, height-keyed sway frequency so neighbouring puffs shear against each other instead of swaying in step. One extra `sin` per puff, no allocations.
