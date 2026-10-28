/** Assembler-only compression of message copies; trace and raw observations stay intact. */
export function compactObservations(messages) {
  const indices = messages.flatMap((message, index) =>
    message.role === "tool" && message.content?.length > 600 ? [index] : [],
  );
  if (indices.length <= 10) return;
  for (const index of indices.slice(0, -6))
    messages[index] = {
      ...messages[index],
      content:
        "[旧观察已收起，完整记录保存在本地任务记忆。需要精确原文时请调用工具重新读取。]",
    };
}
