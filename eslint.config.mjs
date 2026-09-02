// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  rules: {
    // Тексты интерфейса — на русском, кавычки-ёлочки внутри строк не должны ловиться линтером.
    'vue/no-irregular-whitespace': 'off'
  }
})
