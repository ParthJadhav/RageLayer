# SvelteKit

```sh
bun run build      # from the repository root, to produce dist/
cd examples/sveltekit
bun install
bun run dev
```

Svelte has no first-party component, and does not need one: the `<rage-kit>` custom
element is a full toolbar that works here unchanged. It is imported inside `onMount` so the
registration side effect never runs on the server.

`src/routes/+page.svelte` also shows the `use:rageKit` action, which turns any button
into a launcher when you want to supply your own UI.
