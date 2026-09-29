/**
 * The plugin object the cordis LOADER actually receives.
 *
 * `@deepseek-ai/cordis-plugin-loader#unwrapExports` PREFERS a module's `default`
 * export over its namespace (`exports = exports.default ?? exports`), and the
 * registry builds the plugin's runtime from whatever object that returns
 * (`runtime = { name, callback, fibers, Config: plugin.Config }`). Settings then
 * read the schema off that runtime (`@deepseek-ai/dsh-settings#schema`:
 * `entry.fiber?.runtime?.Config`), and `describe()` SKIPS every entry without
 * one.
 *
 * So a `default` export that omits `Config` does not degrade gracefully: the
 * plugin loads, applies, serves every route, and its settings namespace simply
 * does not exist. The page reports
 * 「设置里没有命名空间 opencode-go-native」 while every other surface is green —
 * which is exactly how this shipped from 0.1.7 on, because nothing in the suite
 * looked at the object the loader builds.
 *
 * This test unwraps both faces the loader can see (the built `lib/`, which is
 * what a profile loads, and `src/`, which is what gets edited) and pins the
 * fields the host consumes.
 *
 * @module tests/loader-contract
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * The loader's own rule, replicated (`cordis-plugin-loader`, `unwrapExports`).
 * @param {object} exports - a module namespace, as `import()` returns it.
 * @returns {object} the plugin object the registry will use.
 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports
  const value = exports.default ?? exports
  if (!value.__esModule) return value
  return value.default ?? value
}

const FACES = [
  ['lib (what a profile loads)', () => import('../lib/index.js')],
  ['src (what gets edited)', () => import('../src/index.js')],
]

for (const [label, load] of FACES) {
  test(`${label}: the unwrapped plugin object carries the schema the host reads`, async () => {
    const module = await load()
    const plugin = unwrapExports(module)

    // The three fields the loader/registry consumes besides the schema.
    assert.equal(typeof plugin.apply, 'function', 'the registry resolves the callback from `apply`')
    assert.equal(plugin.name, 'opencode-go-native', 'the entry name the loader reports')
    assert.deepEqual(plugin.inject, ['llm'], 'declared services must survive unwrapping')

    // The field whose absence is SILENT: `runtime.Config` is copied from this
    // object, and `SettingsForms.describe()` drops an entry it cannot find.
    assert.notEqual(plugin.Config, undefined,
      'the unwrapped plugin object has no Config: the settings namespace would not exist')
    assert.equal(plugin.Config, module.Config, 'one schema, reachable from both faces')
    assert.ok('toJSON' in plugin.Config, 'the host accepts a schema only with "toJSON" in it')
  })
}
