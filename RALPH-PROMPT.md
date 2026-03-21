# Ralph Loop: NotebookLM Plugin Validation

Validate ALL features of the notebooklm-ai-plugin at C:\Users\jdnic\dev\ai\notebooklm-ai-plugin against the reference implementation notebooklm-py.

## Test Notebook
ID: d2032eea-9ee9-4d2d-86c5-133a1478b7c1

## Auth
If ANY command fails with "redirected to login" or "cookies expired", run:
```
npx -y bun skills/notebooklm/scripts/main.ts login --force
```
Then retry the failed command.

## Test Checklist
Run each command. If it fails, fix the code and retry. Track results in RALPH-RESULTS.md.

### 1. Auth
```
npx -y bun skills/notebooklm/scripts/main.ts login --force
```

### 2. Chat
```
npx -y bun skills/notebooklm/scripts/main.ts chat --question "Summarize this notebook in 2 sentences" --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```
EXPECT: Answer text with citations.

### 3. Sources List
```
npx -y bun skills/notebooklm/scripts/main.ts sources list --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```
EXPECT: List of sources with IDs, titles, types.

### 4. Add URL Source
```
npx -y bun skills/notebooklm/scripts/main.ts sources add-url "https://docs.anthropic.com/en/docs/about-claude/models" --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```
EXPECT: "Source added successfully"

### 5. Add Text Source
```
npx -y bun skills/notebooklm/scripts/main.ts sources add-text --title "Ralph Test" --content "Testing from Ralph Loop" --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```
EXPECT: "Text source added successfully"

### 6. Add File Source
```
echo "Ralph Loop test file content" > /tmp/ralph-test.txt
npx -y bun skills/notebooklm/scripts/main.ts sources add-file /tmp/ralph-test.txt --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```
EXPECT: "File source added successfully"

### 7. Delete Source (cleanup test sources from steps 4-6)
Get source IDs from step 3 re-run, then delete the test ones.

### 8. Notes Create
```
npx -y bun skills/notebooklm/scripts/main.ts notes create --title "Ralph Note" --content "Created by Ralph Loop" --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```
EXPECT: Note ID returned.

### 9. Notes List
```
npx -y bun skills/notebooklm/scripts/main.ts notes list --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```
EXPECT: Shows the created note.

### 10. Notes Update
Use the note ID from step 8:
```
npx -y bun skills/notebooklm/scripts/main.ts notes update <noteId> --title "Updated Ralph" --content "Updated by Ralph" --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```

### 11. Notes Delete
```
npx -y bun skills/notebooklm/scripts/main.ts notes delete <noteId> --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```

### 12. Research Fast
```
npx -y bun skills/notebooklm/scripts/main.ts research fast --query "Claude Code best practices" --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```
EXPECT: Completes with summary and sources found.

### 13. Research Status
```
npx -y bun skills/notebooklm/scripts/main.ts research status --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1
```

### 14. Generate Report
```
npx -y bun skills/notebooklm/scripts/main.ts generate report --format briefing --instructions "Key exam topics" --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1 --output /tmp/ralph-report.md
```
EXPECT: Markdown file saved with content.

### 15. Generate Infographic
```
npx -y bun skills/notebooklm/scripts/main.ts generate infographic --orientation portrait --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1 --output /tmp/ralph-infographic.png
```
EXPECT: PNG file saved.

### 16. Generate Quiz
```
npx -y bun skills/notebooklm/scripts/main.ts generate quiz --difficulty medium --notebook d2032eea-9ee9-4d2d-86c5-133a1478b7c1 --json
```
EXPECT: JSON with HTML content.

### 17. Notebook Management
```
npx -y bun skills/notebooklm/scripts/main.ts notebooks list
npx -y bun skills/notebooklm/scripts/main.ts notebooks search "Architect"
```

## Completion
Write results to RALPH-RESULTS.md with PASS/FAIL for each test.
If ALL tests pass, output: <promise>ALL VALIDATED</promise>
If any test fails, fix the code and the loop will retry.
