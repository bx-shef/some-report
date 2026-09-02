<script setup lang="ts">
useHead({
  htmlAttrs: { lang: 'ru' },
  titleTemplate: title => (title ? `${title} — Аналитика по лидам` : 'Аналитика по лидам')
})
</script>

<template>
  <B24App>
    <NuxtPage />
  </B24App>
</template>
