"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

// Loaded on demand: a normal page visit should not pay for the engine.
const RageLayer = dynamic(() => import("ragelayer/react").then((module) => module.RageLayer), {
  ssr: false,
});

export function DestroyButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" aria-pressed={open} onClick={() => setOpen(true)}>
        Destroy this page
      </button>
      {open && <RageLayer engineOptions={{ history: true }} onClose={() => setOpen(false)} />}
    </>
  );
}
