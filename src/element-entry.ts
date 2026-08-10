/**
 * Side-effecting entry: importing it registers `<desktop-destroyer>`.
 *
 *     import "desktop-destroyer/element";
 *
 * Use the named exports from this module instead if you want to choose the tag
 * name or subclass the element.
 */

import { defineDesktopDestroyerElement } from "./element";

defineDesktopDestroyerElement();

export {
  DesktopDestroyerElement,
  type DesktopDestroyerElementConfig,
  defineDesktopDestroyerElement,
  TAG_NAME,
} from "./element";
