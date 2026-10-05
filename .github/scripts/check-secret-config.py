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


def scan(content, path="app.ts"):
    with tempfile.TemporaryDirectory(prefix="otto-secret-regression-") as directory:
        fixture = Path(directory) / "source"
        fixture.mkdir()
        source = fixture / path
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
                str(fixture),
            ],
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

analytics = "src/shared/analytics.ts"
project_token = "phc_" + candidate[:44]
public_config = f'export const posthogConfig = {{ apiKey: "{project_token}" }};'
code, findings = scan(public_config, analytics)
if code != 0 or findings:
    raise SystemExit("The public PostHog project token must pass in its configuration file.")

for secret in ["phx_" + candidate[:44], "phs_" + candidate[:44], candidate]:
    code, findings = scan(f'{public_config}\napi_key = "{secret}"', analytics)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("Private tokens beside the public PostHog token must remain detectable.")

code, findings = scan(public_config)
if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
    raise SystemExit("The PostHog exception must not apply outside its configuration file.")

print("Secret scanning configuration regression passed.")
