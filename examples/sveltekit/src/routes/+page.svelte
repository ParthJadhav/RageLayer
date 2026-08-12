<script lang="ts">
import { rageLayer } from "ragelayer/svelte";
import { onMount } from "svelte";

let open = $state(false);

// Registering the custom element is a browser-only side effect, so it is
// imported after mount rather than at module scope.
onMount(() => {
  import("ragelayer/element");
});
</script>

<main>
  <h1>A perfectly ordinary page</h1>
  <p>
    Everything here is real DOM. The destroyer captures it into a canvas, hides the original, and
    lets the visitor take the copy apart.
  </p>

  <!-- The ready-made toolbar, as an element. -->
  <button type="button" aria-pressed={open} onclick={() => (open = true)}>
    Destroy this page
  </button>

  <!-- Your own launcher, driving the engine directly. -->
  <button use:rageLayer={{ initialTool: "chainsaw" }}>Just the chainsaw</button>
</main>

{#if open}
  <rage-layer
    initial-tool="hammer"
    onragelayer-close={() => (open = false)}
  ></rage-layer>
{/if}

<style>
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 4rem 1.5rem;
    font-family: system-ui, sans-serif;
  }
</style>
