import type { RedactionFinding, SkillEvidence } from "./draft_types.ts";

type Rule = { category: RedactionFinding["category"]; pattern: RegExp; replacement: string };

const RULES: Rule[] = [
  { category: "secret", pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: "${API_KEY}" },
  { category: "credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, replacement: "Bearer ${TOKEN}" },
  { category: "credential", pattern: /\b(password|token|secret)\s*[=:]\s*[^\s,;]+/gi, replacement: "$1=${REDACTED}" },
  { category: "absolute_path", pattern: /[A-Za-z]:\\(?:[^\r\n:*?"<>|]+\\)*[^\r\n:*?"<>|]*/g, replacement: "${PROJECT_PATH}" },
  { category: "absolute_path", pattern: /\/(?:home|Users|tmp)\/[^\s]+/g, replacement: "${LOCAL_PATH}" },
  { category: "temporary_identifier", pattern: /\b(?:session|turn)-[A-Za-z0-9-]{6,}\b/gi, replacement: "${RUNTIME_ID}" },
];

const HIGH_RISK_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/i,
  /[A-Za-z]:\\(?:[^\r\n:*?"<>|]+\\)+/,
  /\/(?:home|Users)\/[^\s]+/,
];

export function assertNoSensitiveContent(value: string): void {
  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error("Skill 草稿仍包含高风险凭据或本地路径，已拒绝保存。");
  }
}

export function redactSkillEvidence(evidence: SkillEvidence): {
  evidence: SkillEvidence;
  findings: RedactionFinding[];
} {
  const findings: RedactionFinding[] = [];
  const redact = (value: string, location: string): string => {
    let result = value;
    for (const rule of RULES) {
      result = result.replace(rule.pattern, (match) => {
        findings.push({ category: rule.category, replacement: rule.replacement, location });
        return match.replace(rule.pattern, rule.replacement);
      });
    }
    return result;
  };
  return {
    evidence: {
      ...evidence,
      userGoal: redact(evidence.userGoal, "userGoal"),
      steps: evidence.steps.map((step, index) => ({ ...step, summary: redact(step.summary, `steps[${index}]`) })),
      validation: evidence.validation.map((item, index) => ({ ...item, command: redact(item.command, `validation[${index}]`) })),
      changedFiles: evidence.changedFiles.map((file, index) => redact(file, `changedFiles[${index}]`)),
    },
    findings,
  };
}
