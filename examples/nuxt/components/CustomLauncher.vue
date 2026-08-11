<script setup lang="ts">
// The headless composable, for hosts that want their own controls rather than
// the built-in toolbar.
import { useRageKit } from "ragekit/vue";

const { isOpen, toggle, engine } = useRageKit({
  initialTool: "flamethrower",
  history: true,
});
</script>

<template>
  <span>
    <button type="button" :aria-pressed="isOpen" @click="toggle">
      {{ isOpen ? "Put it out" : "Set it on fire" }}
    </button>
    <button v-if="isOpen" type="button" @click="engine?.clear()">Repair</button>
  </span>
</template>
