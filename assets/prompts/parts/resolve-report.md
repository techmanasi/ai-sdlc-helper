Write your report to {{LOG}}/resolve-conflicts-report.md, one line per conflicted file and a verdict:
FILE: <path> :: <what you kept from each side, and why that keeps both sides' commitments>
VERDICT: SAFE

When you are not sure the result keeps both sides' commitments, do not guess: write VERDICT: DOUBT and one line
DOUBT: <the file, both sides' intent, and the open question>
naming the exact conflict and the question the developer must decide. The pipeline then stops without pushing and asks the developer.
