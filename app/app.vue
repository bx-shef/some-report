<script setup lang="ts">
import { pageTitle } from '~/utils/pageTitle'

useHead({
  htmlAttrs: { lang: 'ru' },
  titleTemplate: title => pageTitle(title ?? undefined)
})
</script>

<template>
  <B24App>
    <NuxtPage />
  </B24App>
</template>
