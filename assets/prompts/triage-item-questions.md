
If something needs the person's decision, do not use AskUserQuestion. Write at most 4 questions to `{{QUESTIONS_FILE}}` instead, each in this form, and end your turn without writing the brief:

```
### Q1: <short title>
<the question>
**Suggested:** <your recommendation>
**Answer:**
```

Leave `**Answer:**` empty. You will be resumed when the questions are answered; put the answers into the brief as decisions. Ask nothing the code and conventions already settle.
