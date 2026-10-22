import json
import shutil
import subprocess
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


root = Path(__file__).resolve().parent
node = shutil.which("node")
if node is None:
    raise SystemExit("Node.js is required to format fixtures; make node available on PATH.")
formatter = root.parent.parent / "node_modules" / "prettier" / "bin" / "prettier.cjs"
if not formatter.is_file():
    raise SystemExit("Local Prettier is missing; install repository dependencies before generating fixtures.")
if sys.argv[1:] not in ([], ["--v2"]):
    raise SystemExit("Use --v2 for the revised report inputs, or no arguments for v1.")
version = 2 if sys.argv[1:] else 1
cases = [
    {
        "id": "health-results-base",
        "lab": "Northbridge Laboratory",
        "report": "NB-2026-1001",
        "patient": "Alex Rowan",
        "date": "2026-10-01",
        "rows": [
            ["Hemoglobin", "12.8", "g/dL", "13.5 - 17.5"],
            ["Platelets", "430", "10^9/L", "150 - 400"],
            ["Leukocytes", "7.0", "10^9/L", "4.0 - 11.0"],
            ["Sodium", "135", "mmol/L", "135 - 145"],
            ["Potassium", "4.2", "mmol/L", "3.5 - 5.1"],
            ["Glucose", "99", "mg/dL", "70 - 99"],
            ["Creatinine", "0.95", "mg/dL", "0.70 - 1.20"],
        ],
        "events": [],
    },
    {
        "id": "health-results-appointment",
        "lab": "Harbour Clinical Laboratory",
        "report": "HC-2026-0930",
        "patient": "Sam Linden",
        "date": "2026-09-30",
        "rows": [
            ["Hemoglobin", "142", "g/L", "130 - 170"],
            ["Ferritin", "18", "ug/L", "30 - 300"],
            ["C-reactive protein", "7.2", "mg/L", "0 - 5.0"],
            ["Sodium", "145", "mmol/L", "135 - 145"],
            ["Platelets", "150", "10^9/L", "150 - 400"],
            ["HbA1c", "40", "mmol/mol", "20 - 42"],
        ],
        "events": [
            {
                "id": "fixture-calendar-language-exam",
                "summary": "Portuguese language exam",
                "description": "Language course assessment. Bring student ID.",
                "start": {
                    "dateTime": "2026-10-10T10:00:00+01:00",
                    "timeZone": "Europe/Lisbon",
                },
                "end": {
                    "dateTime": "2026-10-10T11:30:00+01:00",
                    "timeZone": "Europe/Lisbon",
                },
                "status": "confirmed",
                "htmlLink": "https://calendar.google.com/calendar/u/0/r/eventedit/fixture-calendar-language-exam",
            },
            {
                "id": "fixture-calendar-results-review",
                "summary": "Results review - Dr Mira Vale",
                "description": "Review Harbour Clinical Laboratory report HC-2026-0930 with Dr Mira Vale. Bring the report; discuss whether further tests are needed.",
                "start": {
                    "dateTime": "2026-10-12T11:30:00+01:00",
                    "timeZone": "Europe/Lisbon",
                },
                "end": {
                    "dateTime": "2026-10-12T12:00:00+01:00",
                    "timeZone": "Europe/Lisbon",
                },
                "status": "confirmed",
                "htmlLink": "https://calendar.google.com/calendar/u/0/r/eventedit/fixture-calendar-results-review",
            },
        ],
    },
]

for case in cases:
    scenario_id = case["id"] + ("-v2" if version == 2 else "")
    filename = scenario_id + ".pdf"
    document = canvas.Canvas(str(root / filename), pagesize=A4, invariant=1)
    document.setTitle(case["lab"] + " - " + case["report"])
    document.setAuthor(case["lab"] if version == 2 else "nod synthetic acceptance fixture")
    document.setFillColor(colors.HexColor("#263746"))
    document.setFont("Helvetica-Bold", 20)
    document.drawString(48, 783, case["lab"])
    document.setFillColor(colors.HexColor("#8a3434"))
    document.setFont("Helvetica-Bold", 10)
    document.drawString(48, 761, "Laboratory report" if version == 2 else "SYNTHETIC TEST REPORT - NOT A REAL PATIENT")
    document.setFillColor(colors.black)
    document.setFont("Helvetica", 11)
    for index, line in enumerate(
        [
            "Report: " + case["report"],
            "Patient: " + case["patient"] + ("" if version == 2 else " (fictional adult)"),
            "Sample collected: " + case["date"],
            "Reference intervals below apply to this sample." if version == 2 else "Reference intervals below apply to this synthetic sample.",
            "" if version == 2 else "Both endpoints of each listed interval are included.",
        ]
    ):
        document.drawString(48, 728 - index * 19, line)
    alternate = case["id"] == "health-results-appointment"
    headers = (
        ["Test", "Reference interval", "Unit", "Result"]
        if alternate
        else ["Test", "Result", "Unit", "Reference interval"]
    )
    columns = [48, 238, 333, 427]
    document.setFillColor(colors.HexColor("#e9eef2"))
    document.rect(42, 600, 511, 30, fill=1, stroke=0)
    document.setFillColor(colors.black)
    document.setFont("Helvetica-Bold", 10)
    for x, label in zip(columns, headers):
        document.drawString(x, 612, label)
    document.setFont("Helvetica", 11)
    for index, row in enumerate(case["rows"]):
        y = 581 - index * 31
        values = [row[0], row[3], row[2], row[1]] if alternate else row
        for x, value in zip(columns, values):
            document.drawString(x, y, value)
        document.setStrokeColor(colors.HexColor("#d9e0e5"))
        document.line(42, y - 10, 553, y - 10)
    document.setFont("Helvetica-Bold", 12)
    document.drawString(48, 315, "Clinician note")
    document.setFont("Helvetica", 11)
    for index, line in enumerate(
        [
            "Discuss these results with the requesting clinician.",
            "Recommended repeat blood test date: 2026-10-16.",
            "" if version == 2 else "A result outside a reference interval is not a diagnosis.",
            "" if version == 2 else "No diagnosis or treatment recommendation is given in this report.",
        ]
    ):
        document.drawString(48, 292 - index * 20, line)
    document.setFont("Helvetica", 9)
    document.setFillColor(colors.HexColor("#53616e"))
    document.drawString(48, 57, case["report"] if version == 2 else "Generated exclusively for controlled software evaluation.")
    document.drawRightString(547, 57, "Page 1 of 1")
    document.save()
    message_id = "fixture-" + case["report"].lower()
    data = {
        "id": scenario_id,
        "accountEmail": "work@example.test",
        "messages": [
            {
                "id": message_id,
                "threadId": message_id + "-thread",
                "from": "results@" + ("northbridge" if not alternate else "harbour") + ".example.test",
                "to": "work@example.test",
                "subject": "Your laboratory report " + case["report"],
                "body": "Your report is attached. Please discuss the results with your requesting clinician." + ("" if version == 2 else " This is synthetic test data only."),
                "date": case["date"] + "T16:00:00+01:00",
                "labelIds": ["INBOX", "UNREAD"],
            }
        ],
        "attachments": [
            {
                "messageId": message_id,
                "attachmentId": message_id + "-report",
                "name": filename,
                "mimeType": "application/pdf",
            }
        ],
        "calendarEvents": case["events"],
    }
    if alternate:
        data["profile"] = {
            "name": "Sam Linden",
            "location": "Lisbon, Portugal",
            "phone": "",
            "preferences": "The user said these were routine tests requested at an annual check-up and that they currently feel well. They prefer to discuss further testing with their usual clinician.",
        }
        data["schedules"] = [
            {
                "title": "Prepare for the results review",
                "prompt": "Remind me to bring my Harbour Clinical Laboratory report HC-2026-0930 to my appointment with Dr Mira Vale tomorrow at 11:30.",
                "kind": "once",
                "runAt": "2026-10-11T18:00:00+01:00",
                "timeZone": "Europe/Lisbon",
            }
        ]
    elif version == 2:
        data["profile"] = {
            "name": case["patient"],
            "location": "Lisbon, Portugal",
            "phone": "",
            "preferences": "",
        }
    json_path = root / (scenario_id + ".json")
    json_path.write_text(json.dumps(data, indent=2) + "\n")
    try:
        subprocess.run(
            [node, str(formatter), "--write", str(json_path)],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        details = (error.stderr or error.stdout or "No diagnostic output.").strip()
        raise SystemExit(
            f"Prettier failed to format {json_path.name} (exit {error.returncode}): {details}"
        ) from None
    except OSError as error:
        raise SystemExit(f"Could not run Node.js to format {json_path.name}: {error}") from None
