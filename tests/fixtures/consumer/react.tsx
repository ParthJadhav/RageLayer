import { RageKit, useRageKit } from "ragekit/react";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof RageKit>;

const props = {
  soundDefault: false,
  toolStyle: "emoji",
  loadout: "chaos",
  engineOptions: { captureContent: false, quality: "low", history: true },
} satisfies Props;

export function Consumer() {
  const { engine, isOpen, toggle } = useRageKit({ initialTool: "hammer" });
  return (
    <>
      <button type="button" onClick={toggle}>
        {isOpen ? "Close" : "Open"}
      </button>
      {isOpen ? <RageKit {...props} onClose={() => engine?.clear()} /> : null}
    </>
  );
}
