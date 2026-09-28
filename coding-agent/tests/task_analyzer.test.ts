import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTask } from "../task/analyzer.ts";

test("任务分析器生成结构化规格和四类执行步骤", async () => {
  const result = await analyzeTask("增加配置校验", async () => JSON.stringify({
    outcome: "planned",
    specification: {
      objective: "为配置模块增加输入校验",
      scope: ["配置解析"],
      non_goals: ["不修改模型调用"],
      constraints: ["保持现有配置兼容"],
      acceptance_criteria: ["非法配置被拒绝", "测试通过"],
    },
    steps: [
      { kind: "analysis", title: "分析配置", description: "确认配置入口和现有约束" },
      { kind: "implementation", title: "实现校验", description: "增加明确的校验错误" },
      { kind: "testing", title: "补充测试", description: "覆盖有效和无效配置" },
      { kind: "verification", title: "运行验证", description: "类型检查和测试通过" },
    ],
  }));

  assert.equal(result.outcome, "planned");
  if (result.outcome !== "planned") return;
  assert.equal(result.specification.objective, "为配置模块增加输入校验");
  assert.deepEqual(result.steps.map((step) => step.kind), [
    "analysis", "implementation", "testing", "verification",
  ]);
});

test("任务分析器将关键信息不足识别为待澄清", async () => {
  const result = await analyzeTask("优化这里", async () => JSON.stringify({
    outcome: "needs_clarification",
    objective: "优化未指定模块",
    questions: ["需要优化哪个模块？"],
  }));
  assert.deepEqual(result, {
    outcome: "needs_clarification",
    objective: "优化未指定模块",
    questions: ["需要优化哪个模块？"],
  });
});

test("任务分析器拒绝非法 JSON 和缺少必要类型的计划", async () => {
  await assert.rejects(() => analyzeTask("目标", async () => "not-json"), /合法的任务分析 JSON/);
  await assert.rejects(
    () => analyzeTask("目标", async () => JSON.stringify({
      outcome: "planned",
      specification: {
        objective: "目标",
        scope: ["范围"],
        non_goals: [],
        constraints: [],
        acceptance_criteria: ["验证通过"],
      },
      steps: [{ kind: "analysis", title: "分析", description: "分析代码" }],
    })),
    /缺少 implementation 步骤/,
  );
});
