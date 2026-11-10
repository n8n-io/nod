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
    with tempfile.TemporaryDirectory(prefix="nod-secret-regression-") as directory:
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

analytics_path = "src/shared/posthog-host.json"
analytics = (config.parent / analytics_path).read_text()
code, findings = scan(analytics, analytics_path)
if code != 0 or findings:
    raise SystemExit("The public PostHog ingestion token must pass secret scanning.")

for secret in ["phx_" + candidate[:44], "phs_" + candidate[:44], "phc_" + candidate[:44], candidate]:
    with_secret = {**json.loads(analytics), "api_key": secret}
    code, findings = scan(json.dumps(with_secret), analytics_path)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("Other tokens beside the public token must fail secret scanning.")

for filename in ["app.ts", "nested/src/shared/posthog-host.json"]:
    code, findings = scan(analytics, filename)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("The public token exception must be limited to its configuration file.")

synthetic = f'api_key = "{candidate}"'
for filename in [
    "tests/app.test.ts",
    "desktop/test/app.test.mjs",
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
for filename in ["docs/testing/run.json", "docs/research/run.json"]:
    code, findings = scan(records, filename)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("Unverified source hash records must fail secret scanning.")

for content, filename in [
    (records, "docs/app.json"),
    (records, "nested/docs/testing/run.json"),
    (f'{{\n  "api_key": "{digest}"\n}}\n', "docs/testing/run.json"),
    (f'{{\n  "src/ports/key-store.ts": "{candidate}"\n}}\n', "docs/testing/run.json"),
    (f'{{\n  "src/ports/key-store.ts": "{digest}", "api_key": "{candidate}"\n}}\n', "docs/testing/run.json"),
    (f'{records}api_key = "{candidate}"\n', "docs/testing/run.json"),
]:
    code, findings = scan(content, filename)
    if code != 1 or not any(
        finding.get("RuleID") == "generic-api-key"
        and ("api_key" not in content or "api_key" in finding.get("Match", ""))
        for finding in findings
    ):
        raise SystemExit("Unverified evidence fields and adjacent credentials must fail scanning.")

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

changed_digest = hashlib.sha256(candidate.encode()).hexdigest()
composio = json.loads(
    (config.parent / ".github/fixtures/composio-secret-scanner.json").read_text()
)
for filename, fingerprints in composio["fingerprints"].items():
    if not fingerprints:
        raise SystemExit("The Composio snapshot must exercise a fingerprint exception.")
    snapshot = "".join(f'"{field}": "{digest}"\n' for digest, field in fingerprints)
    changed = "".join(f'"{field}": "{changed_digest}"\n' for _, field in fingerprints)
    code, findings = scan(snapshot, filename)
    if code != 0 or findings:
        raise SystemExit("Allowlisted fingerprints must pass only at their exact artifact path.")
    for content, target in [
        (changed, filename),
        (snapshot, "docs/testing/composio-proxy/new-source.json"),
        (snapshot, "nested/" + filename),
        (snapshot, "docs/composio-source.json"),
        (f'"api_key": "{fingerprints[0][0]}"\n', filename),
        (f'{snapshot}api_key = "{candidate}"\n', filename),
        (f'{snapshot.rstrip()} api_key = "{candidate}"\n', filename),
    ]:
        code, findings = scan(content, target)
        if code != 1 or not any(
            finding.get("RuleID") == "generic-api-key"
            and ("api_key" not in content or "api_key" in finding.get("Match", ""))
            for finding in findings
        ):
            raise SystemExit("Altered fingerprints, paths, fields and adjacent credentials must fail.")

runner_path = "docs/testing/composio-proxy/cp04.v1.results.json"
property_reference = "const attachment = { " + "".join(composio["propertyReference"]) + "};"
code, findings = scan(property_reference, runner_path)
if code != 0 or findings:
    raise SystemExit("The verified frozen runner source must pass secret scanning.")

for altered in [
    f'const attachment = {{ s3key: "{candidate}" }};',
    f'{property_reference} api_key = "{candidate}"',
    f'{property_reference}\napi_key = "{candidate}"',
]:
    code, findings = scan(altered, runner_path)
    if code != 1 or not any(
        finding.get("RuleID") == "generic-api-key"
        and ("api_key" not in altered or "api_key" in finding.get("Match", ""))
        for finding in findings
    ):
        raise SystemExit("Credentials replacing or beside the property reference must fail scanning.")

for filename in ["nested/" + runner_path, "docs/testing/composio-proxy/unverified.json"]:
    code, findings = scan(property_reference, filename)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("The source-expression exception must require its exact artifact path.")

print("Secret scanning configuration regression passed.")
