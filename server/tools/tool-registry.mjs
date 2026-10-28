/**
 * Generic declarative registry, called by runtime adapters and future planners.
 * It discovers descriptions and invokes lazy implementations; it does not build
 * prompts, implement finance, persist state or select an agent's research goal.
 */
export class ToolRegistry {
  #entries = new Map();
  #loaders = new Map();
  #context;
  #policy;
  #execution;
  constructor({ entries = [], context = {}, policy = {}, execution } = {}) {
    this.#context = context;
    this.#execution = execution;
    this.#policy = structuredClone(policy);
    for (const entry of entries) this.register(entry);
  }
  /** Composition registers one descriptor+loader; duplicate/invalid names fail before execution. */
  register(entry) {
    if (
      !entry ||
      !/^[A-Za-z][\w-]*$/.test(entry.name || "") ||
      typeof entry.description !== "string" ||
      !entry.description.trim() ||
      entry.parameters?.type !== "object" ||
      typeof entry.load !== "function"
    )
      throw new Error("工具注册项缺少名称、描述、参数schema或loader");
    if (this.#entries.has(entry.name))
      throw new Error("工具重复注册：" + entry.name);
    const { load, ...metadata } = entry;
    this.#entries.set(entry.name, { ...structuredClone(metadata), load });
    return this;
  }
  /** Agent/runtime lists only its enabled subset. Filtering cannot widen caller permissions. */
  list({ categories } = {}) {
    return [...this.#entries.values()]
      .filter(
        (e) =>
          isToolEnabled(e, this.#policy) &&
          (!categories || categories.includes(e.category)),
      )
      .map(({ load, ...e }) => structuredClone(e));
  }
  /** Single execution boundary. Denied tools never load; failed loading may be retried. */
  async invoke(name, args = {}, metadata = {}) {
    const entry = this.#entries.get(name);
    if (!entry) throw new Error("未知或未注册的工具：" + name);
    if (!isToolEnabled(entry, this.#policy))
      throw new Error(
        "当前研究任务不提供此工具；仅报告时禁止外部取数，不查询外部信息",
      );
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("工具参数必须是对象");
    let loading = this.#loaders.get(name);
    if (!loading) {
      loading = Promise.resolve()
        .then(() => entry.load(this.#context))
        .then((handler) => {
          if (typeof handler !== "function")
            throw new Error("工具loader未返回执行函数");
          return handler;
        });
      this.#loaders.set(name, loading);
      loading.catch(() => {
        if (this.#loaders.get(name) === loading) this.#loaders.delete(name);
      });
    }
    const handler = await loading;
    if (this.#execution) {
      const { load, ...descriptor } = entry;
      return this.#execution.run({
        entry: structuredClone(descriptor),
        args,
        callId: metadata.callId,
        execute: (context) => handler(args, context),
      });
    }
    return handler(args, this.#context);
  }
}

/** Registry/router share descriptor policy; metadata alone never overrides source permissions. */
export function isToolEnabled(
  entry,
  { sourceMode, mode = "research", categories } = {},
) {
  return (
    !!entry &&
    (!sourceMode ||
      !entry.sourceModes ||
      entry.sourceModes.includes(sourceMode)) &&
    (!entry.modes || entry.modes.includes(mode)) &&
    (!categories || categories.includes(entry.category))
  );
}

/** Runtime adapter converts discoverable metadata to provider-native tool schema; no implementation loads. */
export function modelTool(entry) {
  return {
    type: "function",
    function: {
      name: entry.name,
      description: entry.description,
      parameters: structuredClone(entry.parameters),
    },
  };
}
