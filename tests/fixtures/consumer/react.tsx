import { RageLayer, useRageLayer } from "ragelayer/react";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof RageLayer>;

const props = {
  soundDefault: false,
  toolStyle: "emoji",
  engineOptions: { captureContent: false, quality: "low", history: true },
} satisfies Props;

export function Consumer() {
  const { engine, isOpen, toggle } = useRageLayer({ initialTool: "hammer" });
  return (
    <>
      <button type="button" onClick={toggle}>
        {isOpen ? "Close" : "Open"}
      </button>
      {isOpen ? <RageLayer {...props} onClose={() => engine?.clear()} /> : null}
    </>
  );
}
