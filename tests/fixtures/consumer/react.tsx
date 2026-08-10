import { DesktopDestroyer, useDesktopDestroyer } from "desktop-destroyer/react";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof DesktopDestroyer>;

const props = {
  soundDefault: false,
  toolStyle: "emoji",
  loadout: "chaos",
  engineOptions: { captureContent: false, quality: "low", history: true },
} satisfies Props;

export function Consumer() {
  const { engine, isOpen, toggle } = useDesktopDestroyer({ initialTool: "hammer" });
  return (
    <>
      <button type="button" onClick={toggle}>
        {isOpen ? "Close" : "Open"}
      </button>
      {isOpen ? <DesktopDestroyer {...props} onClose={() => engine?.clear()} /> : null}
    </>
  );
}
