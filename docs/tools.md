# Tool gallery

Every screenshot below is generated from the current build by
[`scripts/screenshots.mjs`](../scripts/screenshots.mjs), which drives the
[demo page](./demo/) with real pointer input in headless Chrome.
Regenerate them any time with `bun run screenshots`.

## The demo page, pristine

The engine is open (toolbar at the bottom) but nothing has been destroyed yet — an undamaged
page is bit-identical to the raster.

![Pristine demo page with the tool toolbar](./screenshots/demo-page.png)

## Hammer

Each spot takes escalating blows — dent, spreading cracks, deep splintering — then fractures
into rigid-body debris that tumbles and piles up.

![Hammer cracks and fractured debris](./screenshots/hammer.png)

## Gun

Held trigger goes full-auto: aimed spray, transparent holes punched through the real content,
casings and barrel smoke.

![Full-auto bullet spray across the hero](./screenshots/gun.png)

## Flamethrower

Fire catches, burns, deepens, then breaks through to the void. It spreads on its own fuel
field and keeps eating the page after you release.

![Fire spreading across the page](./screenshots/flamethrower.png)

## Chainsaw

Tears gashes and strips — close a loop and the enclosed piece drops out whole, carrying its
slice of the page with it.

![A closed chainsaw loop dropping a piece out of the page](./screenshots/chainsaw.png)

## Paintball

Splatters that drip and dry, clipped to surviving page pixels.

![Paint splats across the page](./screenshots/paintball.png)

## Water hose

Hold to spray. Water sheets down the page under gravity, puts out fires it reaches, and rinses
paint, soot and rime off surviving pixels — washing cleans stains but does not repair structure,
so a hole stays a hole.

![Water sheeting down the page and dousing a fire](./screenshots/water.png)

## Broom

Drag to sweep. The only genuinely restorative tool: it repairs the page back to the pristine
capture under the bristles, and swats any bugs it passes over. Sweeping intact page leaves it
exactly intact, with no seam where the sweep passed.

![A half-swept page: bullet holes on the right, repaired page on the left](./screenshots/broom.png)

## Black hole

Held: thin-lens gravitational deflection, frame-dragging swirl, photon ring, opaque horizon.
It rips elements loose and hauls debris in on an inverse-linear pull with a capture funnel at the horizon, then detonates on release.

![Black hole lensing the page mid-hold](./screenshots/blackhole.png)

## Lightning

A forking bolt with sub-branches and restrike flicker, an ionized burn channel, ground
crawlers, a crater, and fires.

![Lightning strike with forked branches](./screenshots/lightning.png)

## Rocket launcher

Click to launch. The rocket leaves the muzzle along the tool's aim with a backblast and recoil,
arms only once it has actually flown, then detonates on impact — so the crater is never where the
click was.

![A rocket mid-flight, trailing smoke away from the launch point](./screenshots/rocket.png)

## Demolition

Click page furniture — cards, images, paragraphs — to knock the whole element loose as a single
rigid body rather than fracturing it. Elements are measured from the live layout at capture time,
so what you can see is what you can pull out.

![Whole cards knocked loose from the page and falling](./screenshots/demolition.png)

## Bugs

Click to release a bug. They crawl over the surviving page, avoid the void, and can be squashed
with any impact tool, shot, or swept up with the broom.

![Bugs crawling across the surviving page](./screenshots/bugs.png)

## Freeze ray + hammer: frost shatter

A frozen patch doesn't tear like paper — it comes apart like glass: more, lighter,
blue-tinted shards with a crystalline glint twinkling over the break for an instant.

![Frozen page shattering under the hammer](./screenshots/frost-shatter.png)

## Gravity gun

Hold over wreckage to pull rigid chunks into orbit, then release to launch the nearest piece along
the tool's aim. Using it around a sticky-bomb blast triggers the orbital-bomb combo.

## Laser cutter

Drag for a precise heated kerf. Paper yields quickly; metal and stone require dwell. Laser against
frozen material causes a thermal-shock fracture.

## Acid sprayer

Hold to paint corrosive droplets. Each marked material has its own resistance; acid meeting fire
causes a volatile-corrosion blast.

## Wrecking ball

Swing the pointer. Impact force is derived from motion speed and material density, so deliberate
arcs hit harder than small movements.

## Sticky bombs

Click to attach up to eight timed charges. Charges remain visible on the surface, spark near the
end of their fuse, then fracture and ignite the attachment point.

## Glitch gun

Corrupts the page with bounded RGB slices, pulses, and occasional structural faults. Glitch plus
lightning triggers reality overload.

## Materials and combos

Add `data-ragekit-material="glass|metal|wood|stone|rubber|ice|paper"` to page regions to change their
behavior. See the [advanced systems guide](./advanced.md) for all seven combos and custom materials.

## A mixed session

Gun, hammer, flamethrower and paintball together — smoke plumes, live fires, crack webs,
splats, and the debris heap at the bottom of the window.

![Aftermath of a mixed destruction session](./screenshots/aftermath.png)
