"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

// Loaded on demand: a normal page visit should not pay for the engine.
const RageKit = dynamic(() => import("ragekit/react").then((module) => module.RageKit), {
  ssr: false,
});

export function DestroyButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" aria-pressed={open} onClick={() => setOpen(true)}>
        Destroy this page
      </button>
      {open && <RageKit engineOptions={{ history: true }} onClose={() => setOpen(false)} />}
    </>
  );
}
