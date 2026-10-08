import hashlib
import json
from pathlib import Path
import random
import re
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
evidence = (config.parent / evidence_path).read_text()
code, findings = scan(evidence, evidence_path)
if code != 0 or findings:
    raise SystemExit("Verified acceptance source hashes must pass secret scanning.")

for change in ["credential", "source_hash"]:
    altered = json.loads(evidence)
    if change == "credential":
        altered["api_key"] = candidate
    else:
        altered["source"]["files"]["src/ports/authentication.ts"] = hashlib.sha256(
            candidate.encode()
        ).hexdigest()
    code, findings = scan(json.dumps(altered, indent=2), evidence_path)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("Other values in the acceptance snapshot must fail secret scanning.")

source_line = next(line for line in evidence.splitlines() if '"src/ports/authentication.ts"' in line)
code, findings = scan(f'{source_line} "api_key": "{candidate}"', evidence_path)
if code != 1 or not any("api_key" in finding.get("Match", "") for finding in findings):
    raise SystemExit("A credential beside an allowed source hash must fail secret scanning.")

code, findings = scan(evidence, "docs/research/unverified-snapshot.json")
if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
    raise SystemExit("Source hash exceptions must be limited to the verified snapshot.")

fingerprint_fields = {
    "projectKeySha256",
    "src/ports/authentication.ts",
    "src/ports/key-store.ts",
    "src/providers/agent-browser/credentials.ts",
    "src/providers/direct/oauth.ts",
    "src/providers/discovered/oauth.ts",
    "src/providers/environment/key-store.ts",
    "src/providers/keychain/key-store.ts",
    "src/server/access.ts",
    "src/server/deployment-auth.ts",
    "src/server/runtime-auth.ts",
    "src/web/lib/api.ts",
    "src/web/pages/credentials.tsx",
}
changed_digest = hashlib.sha256(candidate.encode()).hexdigest()
for filename in [
    "docs/testing/composio-proxy/cp03.v2.inputs.json",
    "docs/testing/composio-proxy/cp03.v2.results.json",
    "docs/testing/composio-proxy/cp06.v2.source.json",
    "docs/testing/composio-proxy/cp06.v2.upgrade.a02.source.json",
]:
    snapshot = (config.parent / filename).read_text()
    code, findings = scan(snapshot, filename)
    if code != 0 or findings:
        raise SystemExit("Verified Composio evidence fingerprints must pass secret scanning.")
    fingerprints = set()
    for line in snapshot.splitlines():
        match = re.fullmatch(r'\s*"([^"]+)": "([a-f0-9]{64})",?', line)
        if match and match[1] in fingerprint_fields:
            fingerprints.add((match[1], match[2]))
    if not fingerprints:
        raise SystemExit("The Composio snapshot must exercise a fingerprint exception.")
    for field, digest in sorted(fingerprints):
        source_line = f'"{field}": "{digest}"'
        for altered in [
            f'"{field}": "{changed_digest}"',
            f'"api_key": "{digest}"',
            f'{source_line}, "api_key": "{candidate}"',
            f'{source_line}\n"api_key": "{candidate}"',
        ]:
            code, findings = scan(altered, filename)
            if code != 1 or not any(
                finding.get("RuleID") == "generic-api-key"
                and ("api_key" not in altered or "api_key" in finding.get("Match", ""))
                for finding in findings
            ):
                raise SystemExit("Changed fingerprints and adjacent credentials must fail scanning.")
    for unverified in ["nested/" + filename, "docs/testing/composio-proxy/unverified.json"]:
        code, findings = scan(snapshot, unverified)
        if code != 1 or not any(
            finding.get("RuleID") == "generic-api-key" for finding in findings
        ):
            raise SystemExit("Composio fingerprint exceptions must require their exact paths.")

runner_path = "docs/testing/composio-proxy/cp04.v1.results.json"
code, findings = scan((config.parent / runner_path).read_text(), runner_path)
if code != 0 or findings:
    raise SystemExit("The verified frozen runner source must pass secret scanning.")

property_reference = "const attachment = { s3key: " + "executedAttachment.s3key" + " };"
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
