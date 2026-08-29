# Next.js (App Router)

```sh
bun run build      # from the repository root, to produce dist/
cd examples/nextjs
bun install
npm install --no-save --package-lock=false --audit=false --fund=false ../..
bun run dev
```

`DestroyButton` is a Client Component. RageLayer entry is already marked `"use client"`, but
the trigger needs its own directive because it holds state.

The component is loaded with `next/dynamic` so a normal page visit never downloads the engine —
the ~130 KB gzip only arrives when someone actually asks to break the page.
