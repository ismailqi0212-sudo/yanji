/** Resolve evidence scope from this conversation and the user's explicit request. */
export function resolveSourcePolicy(chat, question, options = {}) {
  const hasDocuments = !!chat.documents?.length;
  const text = String(question || "").replace(/\s+/g, "");
  // Remove negative search clauses before detecting requests to fetch outside material.
  const positive = text.replace(
    /(?:不要|不用|无需|不必|不需要)(?:再|额外|另外)?(?:查询|查找|搜索|搜集|检索|使用|用)?(?:外部(?:数据|信息|资料|来源)?|网络(?:数据|信息)?|公开数据|上网|联网|搜索|搜集|检索)/g,
    "",
  );
  const reportOnly =
    /(?:仅|只)(?:依据|根据|按照|按|使用|用|看|从|基于)[^，。；;]{0,16}(?:报告|财报|年报|季报|材料|附件|文档)/.test(
      text,
    ) ||
    /(?:不要|不用|无需|不必|不需要)(?:再|额外|另外)?(?:查询|查找|搜索|搜集|检索|使用|用)?(?:外部|网络|公开数据|上网|联网)/.test(
      text,
    );
  const externalOnly =
    /(?:仅|只)(?:查|用|搜索|看|从|根据|使用)[^，。；;]{0,10}(?:公开|网络|外部|联网|网上)/.test(
      positive,
    ) ||
    /(?:不使用|不用|忽略|不要用)[^，。；;]{0,8}(?:上传|附件|报告|财报|材料)/.test(
      text,
    );
  const asksForReport =
    /(?:按照|根据|依据|基于)(?:我|本对话|已上传|上传|这些|这几份|附件|上述|提供的)?的?(?:报告|财报|年报|材料|附件)/.test(
      text,
    );
  if (asksForReport && !hasDocuments && !externalOnly)
    throw new Error("你要求依据报告，但本对话还没有报告，请先上传材料");
  if (reportOnly && !externalOnly) {
    if (!hasDocuments)
      throw new Error("你要求依据报告，但本对话还没有报告，请先上传材料");
    return {
      sourceMode: "documents",
      sourceReason: "用户要求依据报告或不使用外部信息",
    };
  }
  if (externalOnly)
    return { sourceMode: "external", sourceReason: "用户明确只使用外部信息" };
  // The old API option remains usable by integrations; the UI no longer sends it.
  if (["documents", "hybrid", "external"].includes(options.sourceMode))
    return {
      sourceMode: options.sourceMode,
      sourceReason: "调用方明确指定资料范围",
    };
  const localSearch =
    /(?:搜索|检索|查找|搜一下|搜集|收集)(?:本对话|已上传|上传|这些|这几份|这份)?(?:报告|财报|年报|附件|文档|材料)(?:中|里|内|的)?/.test(
      positive,
    );
  const outside =
    /搜集|上网|联网|公开数据|外部(?:信息|资料|数据)|(?:搜索|搜一下|查找|检索)(?!报告|财报|年报|附件|文档|材料)|最新(?:股价|行情|公告)|实时(?:股价|行情)|今日股价|当前(?:股价|估值)/.test(
      positive,
    );
  if (
    hasDocuments &&
    outside &&
    (!localSearch ||
      /联网|上网|外部|公开数据|最新(?:股价|行情|公告)/.test(positive))
  )
    return {
      sourceMode: "hybrid",
      sourceReason: "已上传报告，并明确请求补充外部信息",
    };
  return {
    sourceMode: hasDocuments ? "documents" : "external",
    sourceReason: hasDocuments
      ? "默认优先使用当前对话的报告"
      : "本对话没有材料，使用可用的公开数据工具",
  };
}
