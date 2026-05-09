// redact.test.mjs — SUP-391 W6.D Auto-Context redaction utility.

import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, detectSecretShapes, SECRET_PATTERN_NAMES } from "../plugins/codex/scripts/lib/redact.mjs";

test("redact: openai sk- token", () => {
  const t = "sk" + "-proj-abc123XYZ456defghi789jklmnop";
  const r = redactSecrets(`auth token: ${t}`);
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /proj-abc/);
});

test("redact: github fine-grained PAT", () => {
  // Split prefix to avoid GitHub Secret Scanning push-protection on this
  // test fixture; runtime concatenation produces the full token shape that
  // the redact regex matches.
  const t = "github" + "_pat_" + "11AOSMFXQ0Lkwr" + "PW1aHNOh_IeG80KVO5Ra7atMU3n8";
  const r = redactSecrets(`use ${t} for auth`);
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /11AOSMFX/);
});

test("redact: github classic PAT", () => {
  const t = "ghp" + "_lLhgefdOcocGa8p0MJ" + "AAqyzLc8Hv9c4Jh1cA";
  const r = redactSecrets(`token=${t}`);
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /lLhgefd/);
});

test("redact: AWS access key", () => {
  const t = "AKI" + "AIOSFODNN7EXAMPLE";
  const r = redactSecrets(`Use ${t} for s3 upload`);
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /OSFODNN7/);
});

test("redact: Google API key", () => {
  // Real Google API keys are 39 chars: AIza + 35 word chars.
  const t = "AIz" + "aSyDABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const r = redactSecrets(`call ${t} to use API`);
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /SyDABCDEFG/);
});

test("redact: Slack bot token", () => {
  // Split prefix to dodge GitHub Secret Scanning on the fixture.
  const t = "xox" + "b-1234567890-098765" + "4321-abcdefghij1234567890";
  const r = redactSecrets(`slack: ${t}`);
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /1234567890-/);
});

test("redact: JWT", () => {
  const r = redactSecrets("Bearer eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4");
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /eyJh/);
});

test("redact: PEM private key block", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAabc...XYZ
-----END RSA PRIVATE KEY-----`;
  const r = redactSecrets(`config: ${pem}\nrest`);
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /MIIEowIBAA/);
});

test("redact: kv-style password= preserves key", () => {
  const r = redactSecrets("config: password=hunter2-secret-pw");
  assert.match(r, /password=\[REDACTED\]/);
  assert.doesNotMatch(r, /hunter2/);
});

test("redact: kv-style api_key=", () => {
  const r = redactSecrets("API_KEY=topsecret123");
  assert.match(r, /API_KEY=\[REDACTED\]/);
});

test("redact: kv-style auth-token: with quotes", () => {
  const r = redactSecrets("auth_token: \"my-secret-token-here\"");
  assert.match(r, /auth_token=\[REDACTED\]/);
});

test("redact: multiple secrets in same line", () => {
  const aws = "AKI" + "AIOSFODNN7EXAMPLE";
  const gh = "ghp" + "_" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const r = redactSecrets(`aws=${aws} github=${gh}`);
  // Both should be redacted
  const matches = r.match(/\[REDACTED\]/g);
  assert.ok(matches && matches.length >= 2, `expected ≥2 redactions, got: ${r}`);
});

test("redact: clean text untouched", () => {
  const text = "This is a normal commit message about adding a new feature.";
  assert.equal(redactSecrets(text), text);
});

test("redact: empty string", () => {
  assert.equal(redactSecrets(""), "");
});

test("redact: non-string input passes through", () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
});

test("detectSecretShapes: returns matched pattern names", () => {
  const aws = "AKI" + "AIOSFODNN7EXAMPLE";
  const gh = "github" + "_pat_" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const names = detectSecretShapes(`aws=${aws} ${gh}`);
  assert.ok(names.includes("aws-access-key"));
  assert.ok(names.includes("github-pat-fine-grained"));
});

test("detectSecretShapes: empty for clean text", () => {
  assert.deepEqual(detectSecretShapes("hello world, this is a test"), []);
});

test("SECRET_PATTERN_NAMES: includes all expected categories", () => {
  const expected = ["sk-prefixed-token", "github-pat-fine-grained", "aws-access-key", "google-api-key", "jwt", "kv-secret"];
  for (const name of expected) {
    assert.ok(SECRET_PATTERN_NAMES.includes(name), `missing pattern: ${name}`);
  }
});
