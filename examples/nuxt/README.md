# Nuxt 3

```sh
bun run build      # from the repository root, to produce dist/
cd examples/nuxt
bun install
bun run dev
```

Shows both Vue integrations:

- `pages/index.vue` renders the ready-made `<DesktopDestroyer>` component. It renders nothing
  until it is mounted in a browser, so no `<ClientOnly>` wrapper is needed.
- `components/CustomLauncher.vue` uses the headless `useDesktopDestroyer` composable to drive the
  engine from your own controls.
