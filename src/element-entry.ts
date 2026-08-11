/**
 * Side-effecting entry: importing it registers `<rage-kit>`.
 *
 *     import "ragekit/element";
 *
 * Use the named exports from this module instead if you want to choose the tag
 * name or subclass the element.
 */

import { defineRageKitElement } from "./element";

defineRageKitElement();

export {
  defineRageKitElement,
  RageKitElement,
  type RageKitElementConfig,
  TAG_NAME,
} from "./element";
