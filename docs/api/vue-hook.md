# Vue Hook (`@soroban-resurrect/vue-hook`)

## `useSorobanResurrect(config)` composable

Creates and manages a `SorobanResurrect` instance scoped to the calling
component. Accepts a ref, getter, or plain `SorobanResurrectConfig`; recreates
the SDK when the config changes and cleans up subscriptions, TTL watches, and
active submissions when the config changes or the component unmounts.

```ts
const { state, isProcessing, submitWithRestore, reset, cancel } = useSorobanResurrect(config)

const pending = submitWithRestore(transaction, wallet)
cancel() // stops active local workflows; already-submitted on-chain transactions cannot be undone
const result = await pending // cancellation is returned as a failed ResurrectResult
```

`cancel()` aborts all active `submitWithRestore` calls and is safe when no call
is active. Cancellation prevents subsequent SDK workflow steps, but cannot
reverse a transaction already submitted to the network or dismiss a wallet
prompt that the wallet adapter does not support aborting.

## `SorobanResurrectPlugin` — shared instance via `app.use()`

Install the plugin to construct **one** `SorobanResurrect` instance and provide
it to the whole app, so components consume it with `injectSorobanResurrect()` —
no manual `provide` / `inject` wiring.

```ts
import { createApp } from 'vue'
import { SorobanResurrectPlugin } from '@soroban-resurrect/vue-hook'
import App from './App.vue'

createApp(App)
  .use(SorobanResurrectPlugin, {
    config: { rpcUrl: 'https://soroban-testnet.stellar.org' },
  })
  .mount('#app')
```

```vue
<script setup lang="ts">
import { injectSorobanResurrect } from '@soroban-resurrect/vue-hook'

const resurrect = injectSorobanResurrect()

async function submit(transaction, wallet) {
  return resurrect.submitWithRestore({ transaction, wallet })
}
</script>
```

### API

| Export                          | Description                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SorobanResurrectPlugin`        | Vue plugin. `app.use(SorobanResurrectPlugin, { config })`. Throws if `config` is missing.             |
| `injectSorobanResurrect()`      | Returns the shared `SorobanResurrect`. Must run in `setup()`. Throws if the plugin was not installed. |
| `SOROBAN_RESURRECT_KEY`         | The `InjectionKey` used internally — for advanced/SSR wiring.                                         |
| `SorobanResurrectPluginOptions` | `{ config: SorobanResurrectConfig }`.                                                                 |
