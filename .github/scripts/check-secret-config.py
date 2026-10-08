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


def scan(content, filename="app.ts", history=False):
    with tempfile.TemporaryDirectory(prefix="otto-secret-regression-") as directory:
        fixture = Path(directory) / "source"
        fixture.mkdir()
        source = fixture / filename
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(content)
        if history:
            for arguments in [
                ["init", "--quiet"],
                ["add", "."],
                [
                    "-c", "user.name=Secret scanner regression",
                    "-c", "user.email=scanner@example.test",
                    "-c", "commit.gpgsign=false",
                    "commit", "--quiet", "-m", "Generated scanner fixture",
                ],
            ]:
                subprocess.run(
                    ["git", "-c", "core.hooksPath=/dev/null", *arguments],
                    cwd=fixture,
                    capture_output=True,
                    text=True,
                    check=True,
                )
        report = Path(directory) / "findings.json"
        result = subprocess.run(
            [
                scanner,
                "git" if history else "dir",
                "--no-banner",
                "--redact",
                "--config",
                str(config),
                "--gitleaks-ignore-path",
                str(config.parent / ".gitleaksignore"),
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

acceptance_path = "docs/research/apps-acceptance-b8e489cb.json"
acceptance_secret = "\n" * 95 + '{\n"src/ports/authentication.ts": "' + candidate + '"\n}'
for history in [False, True]:
    code, findings = scan(acceptance_secret, acceptance_path, history=history)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit(
            "Historical source hashes must not exempt new secrets at the same path and line."
        )

print("Secret scanning configuration regression passed.")
