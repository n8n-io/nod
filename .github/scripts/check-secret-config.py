import hashlib
import json
from pathlib import Path
import random
import re
import string
import subprocess
import sys
import tempfile
import tomllib


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
digest = hashlib.sha256(b"fixture").hexdigest()
evidence = f'{{\n  "files": {{\n    "src/server/access.ts": "{digest}",\n    "src/ports/key-store.ts": "{digest}"\n  }}\n}}\n'
code, findings = scan(evidence, evidence_path)
if code != 0 or findings:
    raise SystemExit("Source file hashes in app acceptance evidence must pass secret scanning.")

hex_token = hashlib.sha256(candidate.encode()).hexdigest()
for content, filename in [
    (evidence.replace(digest, candidate, 1), evidence_path),
    (f'{evidence}api_key = "{candidate}"\n', evidence_path),
    (f'{{\n  "api_key": "{hex_token}"\n}}\n', evidence_path),
    (f'{{\n  "src/server/access-token": "{hex_token}"\n}}\n', evidence_path),
    (f'{{\n  "config/access.ts": "{hex_token}"\n}}\n', evidence_path),
    (evidence, "app.json"),
]:
    code, findings = scan(content, filename)
    if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
        raise SystemExit("The evidence exception must cover only source hashes in evidence files.")

repository = config.parent
source_hash = re.compile(
    next(
        allowlist["regexes"][0]
        for allowlist in tomllib.loads(config.read_text())["allowlists"]
        if "apps-acceptance" in "".join(allowlist.get("paths", []))
    )
)
for record in sorted((repository / "docs" / "research").glob("apps-acceptance-*.json")):
    commit = record.stem.rsplit("-", 1)[1]
    for line in record.read_text().splitlines():
        match = source_hash.fullmatch(line)
        if not match:
            continue
        path, value = match.groups()
        source = subprocess.run(
            ["git", "-C", str(repository), "show", f"{commit}:{path}"],
            capture_output=True,
            check=False,
        )
        if source.returncode != 0 or hashlib.sha256(source.stdout).hexdigest() != value:
            raise SystemExit(f"{record.name}: {path} is not that file's SHA-256 at {commit}.")

print("Secret scanning configuration regression passed.")
