<script setup lang="ts">
import { RageKit } from "ragekit/vue";
import { ref } from "vue";
import CustomLauncher from "../components/CustomLauncher.vue";

const open = ref(false);
</script>

<template>
  <main style="max-width: 720px; margin: 0 auto; padding: 4rem 1.5rem; font-family: system-ui">
    <h1>A perfectly ordinary page</h1>
    <p>
      Everything here is real DOM. The destroyer captures it into a canvas, hides the original,
      and lets the visitor take the copy apart.
    </p>

    <button type="button" :aria-pressed="open" @click="open = true">Destroy this page</button>
    <CustomLauncher />

    <!-- Safe during SSR: the component renders nothing until it is mounted. -->
    <RageKit v-if="open" :engine-options="{ history: true }" @close="open = false" />
  </main>
</template>
