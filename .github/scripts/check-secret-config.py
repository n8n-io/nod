import hashlib
import json
from pathlib import Path
import random
import string
import subprocess
import sys
import tempfile


scanner = sys.argv[1]
config = Path(__file__).resolve().parents[2] / ".gitleaks.toml"
sql = "UPDATE tasks SET status='waiting_credentials',waiting_reason='credentials'"


def scan(content, filename="app.ts"):
    with tempfile.TemporaryDirectory(prefix="otto-secret-regression-") as directory:
        fixture = Path(directory) / "source"
        fixture.mkdir()
        source = fixture / filename
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(content)
        report = Path(directory) / "findings.json"
        result = subprocess.run(
            [
                scanner,
                "dir",
                "--no-banner",
                "--redact",
                "--config",
                str(config),
                "--report-format",
                "json",
                "--report-path",
                str(report),
                ".",
            ],
            cwd=fixture,
            capture_output=True,
            text=True,
            check=False,
        )
        findings = json.loads(report.read_text()) if report.exists() else []
        return result.returncode, findings


code, findings = scan(sql)
if code != 0 or findings:
    raise SystemExit("The exact SQL status assignment must pass secret scanning.")

candidate = "".join(random.Random(271828).choices(string.ascii_letters + string.digits, k=64))
code, findings = scan(f'{sql}; api_key = "{candidate}"')
if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
    raise SystemExit("A generated secret beside the SQL assignment must fail secret scanning.")

analytics_path = "src/shared/analytics.ts"
analytics = (config.parent / analytics_path).read_text()
code, findings = scan(analytics, analytics_path)
if code != 0 or findings:
    raise SystemExit("The public PostHog ingestion token must pass secret scanning.")

for secret in ["phx_" + candidate[:44], "phs_" + candidate[:44], "phc_" + candidate[:44], candidate]:
    code, findings = scan(f'{analytics}\napi_key = "{secret}"', analytics_path)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("Other tokens beside the public token must fail secret scanning.")

for filename in ["app.ts", "nested/src/shared/analytics.ts"]:
    code, findings = scan(analytics, filename)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("The public token exception must be limited to its configuration file.")

evidence_path = "docs/research/apps-acceptance-b8e489cb.json"
code, findings = scan((config.parent / evidence_path).read_text(), evidence_path)
if code != 0 or findings:
    raise SystemExit("Verified acceptance source hashes must pass secret scanning.")

synthetic = f'api_key = "{candidate}"'
for filename in [
    "tests/app.test.ts",
    "desktop/test/app.test.mjs",
    "deployment/cloudflare/tests/app.ts",
    "deployment/e2b/live_boundary_test.py",
    "deployment/n8n/app.test.mjs",
    "tests/fixtures/app.json",
    "evals/src/world/app.ts",
]:
    code, findings = scan(synthetic, filename)
    if code != 0 or findings:
        raise SystemExit("Synthetic values in tests must pass secret scanning.")

for filename in ["src/app.ts", "src/contests/app.ts", "src/latest.ts", "evals/src/app.ts", "docs/testing/run.json"]:
    code, findings = scan(synthetic, filename)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("The test exception must be limited to tests.")

digest = hashlib.sha256(candidate.encode()).hexdigest()
records = f'{{\n  "src/ports/key-store.ts": "{digest}",\n  "projectKeySha256": "{digest}"\n}}\n'
code, findings = scan(records, "docs/testing/run.json")
if code != 0 or findings:
    raise SystemExit("Source hash records in test evidence must pass secret scanning.")

for content, filename in [
    (records, "docs/app.json"),
    (f'{{\n  "api_key": "{digest}"\n}}\n', "docs/testing/run.json"),
    (f'{{\n  "src/ports/key-store.ts": "{digest}", "api_key": "{candidate}"\n}}\n', "docs/testing/run.json"),
]:
    code, findings = scan(content, filename)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("The evidence exception must be limited to source hash records in test evidence.")

provider_keys = {
    "github-pat": "ghp_" + candidate[:36],
    "composio-api-key": "ak_" + candidate[:24],
    "e2b-api-key": "e2b_" + digest[:40],
}
for rule, key in provider_keys.items():
    for filename in ["tests/app.test.ts", "docs/testing/run.json", "src/app.ts"]:
        code, findings = scan(f'const value = "{key}";', filename)
        if code != 1 or not any(finding.get("RuleID") == rule for finding in findings):
            raise SystemExit("Provider key formats must fail secret scanning everywhere.")

print("Secret scanning configuration regression passed.")
