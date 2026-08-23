# Vanilla JavaScript

No build step and no framework. Serve the repository root and open this page:

```sh
bun run build      # from the repository root, to produce dist/
python3 -m http.server 4321
# then open http://127.0.0.1:4321/examples/vanilla/
```

Shows two things:

- `createRageLayer()`, the lazy lifecycle controller that does no browser work until
  `open()`;
- `ToolbarModel`, driving a toolbar built entirely from the host's own markup — the same model the
  built-in toolbars use, so the shortcuts and roving focus come for free.
