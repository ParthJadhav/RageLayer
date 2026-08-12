/**
 * Side-effecting entry: importing it registers `<rage-layer>`.
 *
 *     import "ragelayer/element";
 *
 * Use the named exports from this module instead if you want to choose the tag
 * name or subclass the element.
 */

import { defineRageLayerElement } from "./element";

defineRageLayerElement();

export {
  defineRageLayerElement,
  RageLayerElement,
  type RageLayerElementConfig,
  TAG_NAME,
} from "./element";
