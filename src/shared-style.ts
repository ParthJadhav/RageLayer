/**
 * A `<style>` block shared by every mounted toolbar instance: the first
 * `acquire` adds it to `<head>`, the last `release` removes it, so mounting
 * several toolbars never stacks copies.
 */
export function sharedStyle(attribute: string, value: string, css: string) {
  let uses = 0;
  let element: HTMLStyleElement | null = null;
  return {
    acquire() {
      if (typeof document === "undefined") return;
      uses += 1;
      // Another copy of this module may already have installed the sheet.
      if (element || document.head.querySelector(`style[${attribute}="${value}"]`)) return;
      element = document.createElement("style");
      element.setAttribute(attribute, value);
      element.textContent = css;
      document.head.appendChild(element);
    },
    release() {
      uses = Math.max(0, uses - 1);
      if (uses > 0 || !element) return;
      element.remove();
      element = null;
    },
  };
}
