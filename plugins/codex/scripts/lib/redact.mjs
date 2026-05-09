// redact.mjs — secret-redaction utility (SUP-391 W6.D).
//
// Auto-Context (cwd / branch / git status / git log / git diff names) is
// prefixed to codex prompts before being shipped to OpenAI. If a commit
// message, branch name, or filename contains a secret, the leak is
// silent and irreversible. This module replaces well-known secret
// patterns with `[REDACTED]` before the text crosses the codex/OpenAI
// boundary.
//
// Defense-in-depth, not perfect:
// - We catch common token shapes (sk-*, ghp_*, AKIA*, AIza*, JWT, PEM,
//   `password=`, etc.). High-entropy strings without a recognized
//   prefix may still slip through — that's a tradeoff against false
//   positives in normal commit messages.
// - Apply at every boundary: --context flag (codex-companion.mjs),
//   Auto-Context block (agent prompt rule + this util), team_send text
//   (defense-in-depth even though inbox is local).
//
// Refs SUP-391 (this file), SUP-384 (W6.A — sandbox containment), SUP-375
// (Auto-Context introduction).

const SECRET_PATTERNS = [
  // OpenAI / Anthropic / Stripe family
  { name: "sk-prefixed-token", re: /sk-[A-Za-z0-9_\-]{20,}/g },
  // GitHub fine-grained PAT
  { name: "github-pat-fine-grained", re: /github_pat_[A-Za-z0-9_]{30,}/g },
  // GitHub classic / OAuth tokens
  { name: "github-classic", re: /\bghp_[A-Za-z0-9]{30,}/g },
  { name: "github-oauth", re: /\bgho_[A-Za-z0-9]{30,}/g },
  { name: "github-server-token", re: /\bghs_[A-Za-z0-9]{30,}/g },
  // AWS access key ID
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API key
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  // Slack bot / user / app
  { name: "slack-token", re: /\bxox[bpoa]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{20,}/g },
  // PEM-formatted private keys (entire block too large; just header)
  { name: "pem-private-key", re: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g },
  // JWT (3 base64url segments separated by dots)
  { name: "jwt", re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g },
  // key=value style — covers password= / token= / secret= / api_key=
  // Captures the value up to whitespace or quote close.
  { name: "kv-secret", re: /\b(password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|bearer)\s*[:=]\s*["']?([^\s"'`]+)/gi }
];

/**
 * Replace recognized secret patterns with [REDACTED].
 * Returns the redacted string (no info on what was replaced — by design,
 * we don't want the diff to leak the secret shape).
 */
export function redactSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, (match, group1, group2) => {
      // For kv-secret pattern, preserve the key=value structure but redact
      // the value. group1 = key name, group2 = value.
      if (group1 && group2) {
        return `${group1}=[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return out;
}

/**
 * Diagnostic helper — returns the names of patterns that matched (without
 * the matched text). Useful for logs that want to know "redaction
 * happened" without re-leaking the secret.
 */
export function detectSecretShapes(text) {
  if (typeof text !== "string") return [];
  const found = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) found.push(name);
    re.lastIndex = 0;  // reset for stateful /g regex
  }
  return found;
}

export const SECRET_PATTERN_NAMES = SECRET_PATTERNS.map((p) => p.name);
