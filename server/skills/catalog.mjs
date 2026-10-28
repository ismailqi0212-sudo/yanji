/** App-owned task skills: trusted instructions loaded by allowlisted ID, never user files. */
import fs from "node:fs";
const catalog = JSON.parse(
  fs.readFileSync(
    new URL("../../shared/research-skills.json", import.meta.url),
    "utf8",
  ),
);
export function getResearchSkill(id) {
  if (!id) return null;
  const skill = catalog.find((s) => s.id === id);
  if (!skill) throw new Error("不支持的研究任务");
  return {
    ...skill,
    instructions: fs.readFileSync(
      new URL(`./${skill.id}/SKILL.md`, import.meta.url),
      "utf8",
    ),
  };
}
