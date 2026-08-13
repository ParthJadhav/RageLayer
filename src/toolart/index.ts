/**
 * Hand-drawn pseudo-3D tool renderings — a hammer with a forged steel head, a
 * pistol whose slide cycles, a chainsaw whose chain crawls. Pure canvas vector
 * work, so there are still no image assets and nothing to load.
 *
 * - `./primitives` — shared materials, shading helpers, and the conventions
 *   every drawing follows.
 * - `./base` — the everyday toolset. `./heavy` — the ordnance.
 * - `./icons` — baking any of them into a toolbar icon.
 */

export {
  broomArt,
  chainsawArt,
  flamethrowerArt,
  gunArt,
  hammerArt,
  paintballArt,
  waterHoseArt,
} from "./base";
export {
  blackHoleArt,
  bugsArt,
  demolitionArt,
  lightningArt,
  rocketArt,
} from "./heavy";
export { toolIconDataUrl } from "./icons";
