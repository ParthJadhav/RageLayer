# Nuxt 3

```sh
bun run build      # from the repository root, to produce dist/
cd examples/nuxt
bun install
npm install --no-save --package-lock=false --audit=false --fund=false ../..
bun run dev
```

Shows both Vue integrations:

- `pages/index.vue` renders the ready-made `<RageLayer>` component. It renders nothing
  until it is mounted in a browser, so no `<ClientOnly>` wrapper is needed.
- `components/CustomLauncher.vue` uses the headless `useRageLayer` composable to drive the
  engine from your own controls.
