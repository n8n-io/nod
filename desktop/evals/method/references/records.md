# Evaluation records

Use one row per case in the matrix. Use one record per attempt. Store a private answer key away from the agent input and from Git when it contains private data.

## Case matrix row

| Field               | Record                                                   |
| ------------------- | -------------------------------------------------------- |
| Case ID and version | Stable ID, such as T01.v1                                |
| Source task         | Link to the real user task or issue                      |
| User prompt         | Exact text the agent will receive                        |
| Setup               | Account, source state, test data, time zone, and channel |
| Expected result     | Observable output and action                             |
| Answer key          | Private location or source snapshot ID                   |
| Action limit        | Writes or external actions allowed for this run          |
| Checks              | Stable check IDs from the table below                    |
| Holdouts            | Separate case IDs with changed inputs                    |
| Run rule            | Model, commit, time limit, and repeat count              |

## Check row

| Field          | Record                                                    |
| -------------- | --------------------------------------------------------- |
| Check ID       | Stable ID, such as T01-C3                                 |
| Applies when   | Condition fixed before the first run                      |
| Pass condition | One result that can be checked as yes or no               |
| Evidence       | Trace event, source page, file, UI state, or human review |
| Method         | Code, human, or model judge                               |

Write separate checks when two parts can fail independently. For a research sheet, “the file has ten rows” and “each contact role has a source” are separate checks. A source link passes only when its page supports the stated fact.

## Attempt record

| Field            | Record                                                     |
| ---------------- | ---------------------------------------------------------- |
| Case and attempt | Case version and attempt number                            |
| Build            | Commit, model, environment, and channel                    |
| Inputs           | Prompt hash, file hashes, and source snapshot ID           |
| Time and cost    | Start, end, elapsed time, and measured or unavailable cost |
| Agent work       | Task ID, tool trace, output artifact names and hashes      |
| Checks           | Pass, fail, not applicable, or error, each with evidence   |
| Case result      | Pass, fail, blocked, or not run                            |
| Review           | Human source or UI review and unresolved limits            |

## Hypothesis record

| Field              | Record                                             |
| ------------------ | -------------------------------------------------- |
| Red check          | Case ID, check ID, and attempt                     |
| Hypothesis         | General cause that can be tested                   |
| Prediction         | Trace or output expected if the hypothesis is true |
| Rejection evidence | Observation that would rule it out                 |
| Change             | Code or evaluator change, with a reason            |
| Retest             | Frozen case, held-out case, and regression results |

Keep the original red attempt. If a source changed or the check was wrong, record that fact and create a new case version. Do not replace the old score.
