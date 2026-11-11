/**
 * 配置读取的小工具。
 *
 * schemastery 的 `.volatile()` 字段在运行期被解析成一个带 `.get()` 的稳定引用
 * （设置页保存后原地热更新），而普通字段是普通值。两种形态都要能读。
 *
 * @module dsh-session-enhance/lib/compact/options
 */

/**
 * 读取一个插件配置项，兼容 volatile 引用与普通值。
 *
 * @param {unknown} config - 插件配置对象（`apply(ctx, config)` 的第二个参数）。
 * @param {string} key - 配置键。
 * @param {unknown} fallback - 缺失时的回退值。
 * @returns {unknown} 当前值。
 */
export function readOption(config, key, fallback) {
  if (config === null || typeof config !== 'object') return fallback;
  const value = /** @type {Record<string, unknown>} */ (config)[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof /** @type {any} */ (value).get === 'function') {
    const live = /** @type {any} */ (value).get();
    return live === undefined || live === null ? fallback : live;
  }
  return value;
}
