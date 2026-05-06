/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Mercury.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 */
import { runChildProcess, buildMercuryEnv, renderTemplate, ensureAbsoluteDirectory, } from "@mercuryai/adapter-utils/server-utils";
import { HERMES_CLI, DEFAULT_TIMEOUT_SEC, DEFAULT_GRACE_SEC, VALID_PROVIDERS, } from "../shared/constants.js";
// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
function cfgString(v) {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v) {
    return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v) {
    return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v) {
    return Array.isArray(v) && v.every((i) => typeof i === "string")
        ? v
        : undefined;
}
// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------
const DEFAULT_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Mercury-managed company.

IMPORTANT: Use \`terminal\` tool with \`curl\` for ALL Mercury API calls (web_extract and browser cannot access localhost).

Your Mercury identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{mercuryApiUrl}}

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -X PATCH "{{mercuryApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST "{{mercuryApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here>"}'\`
4. If this issue has a parent (check the issue body or comments for references like TRA-XX), post a brief notification on the parent issue so the parent owner knows:
   \`curl -s -X POST "{{mercuryApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented. Read it:
   \`curl -s "{{mercuryApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s "{{mercuryApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"status\"]:>12} {i[\"priority\"]:>6} {i[\"title\"]}') for i in issues if i['status'] not in ('done','cancelled')]" \`

2. If issues found, pick the highest priority one that is not done/cancelled and work on it:
   - Read the issue details: \`curl -s "{{mercuryApiUrl}}/issues/ISSUE_ID"\`
   - Do the work in the project directory: {{projectName}}
   - When done, mark complete and post a comment (see Workflow steps 2-4 above)

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s "{{mercuryApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"title\"]}') for i in issues if not i.get('assigneeAgentId')]" \`
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH "{{mercuryApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;
function buildPrompt(ctx, config) {
    const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;
    const taskId = cfgString(ctx.config?.taskId);
    const taskTitle = cfgString(ctx.config?.taskTitle) || "";
    const taskBody = cfgString(ctx.config?.taskBody) || "";
    const commentId = cfgString(ctx.config?.commentId) || "";
    const wakeReason = cfgString(ctx.config?.wakeReason) || "";
    const agentName = ctx.agent?.name || "Hermes Agent";
    const companyName = cfgString(ctx.config?.companyName) || "";
    const projectName = cfgString(ctx.config?.projectName) || "";
    // Build API URL — ensure it has the /api path
    let mercuryApiUrl = cfgString(config.mercuryApiUrl) ||
        process.env.MERCURY_API_URL ||
        "http://127.0.0.1:3100/api";
    // Ensure /api suffix
    if (!mercuryApiUrl.endsWith("/api")) {
        mercuryApiUrl = mercuryApiUrl.replace(/\/+$/, "") + "/api";
    }
    const vars = {
        agentId: ctx.agent?.id || "",
        agentName,
        companyId: ctx.agent?.companyId || "",
        companyName,
        runId: ctx.runId || "",
        taskId: taskId || "",
        taskTitle,
        taskBody,
        commentId,
        wakeReason,
        projectName,
        mercuryApiUrl,
    };
    // Handle conditional sections: {{#key}}...{{/key}}
    let rendered = template;
    // {{#taskId}}...{{/taskId}} — include if task is assigned
    rendered = rendered.replace(/\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g, taskId ? "$1" : "");
    // {{#noTask}}...{{/noTask}} — include if no task
    rendered = rendered.replace(/\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g, taskId ? "" : "$1");
    // {{#commentId}}...{{/commentId}} — include if comment exists
    rendered = rendered.replace(/\{\{#commentId\}\}([\s\S]*?)\{\{\/commentId\}\}/g, commentId ? "$1" : "");
    // Replace remaining {{variable}} placeholders
    return renderTemplate(rendered, vars);
}
// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------
/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;
/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;
/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX = /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;
/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;
// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------
/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw) {
    return raw
        .split("\n")
        .filter((line) => {
        const t = line.trim();
        if (!t)
            return true; // keep blank lines for paragraph separation
        if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[mercury]"))
            return false;
        if (t.startsWith("session_id:"))
            return false;
        if (/^\[\d{4}-\d{2}-\d{2}T/.test(t))
            return false;
        if (/^\[done\]\s*┊/.test(t))
            return false;
        if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t))
            return false;
        if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t))
            return false;
        return true;
    })
        .map((line) => {
        let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
        t = t.replace(/^\[done\]\s*/, "").trim();
        return t;
    })
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------
function parseHermesOutput(stdout, stderr) {
    const combined = stdout + "\n" + stderr;
    const result = {};
    // In quiet mode, Hermes outputs:
    //   <response text>
    //
    //   session_id: <id>
    const sessionMatch = stdout.match(SESSION_ID_REGEX);
    if (sessionMatch?.[1]) {
        result.sessionId = sessionMatch?.[1] ?? null;
        // The response is everything before the session_id line
        const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
        if (sessionLineIdx > 0) {
            result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
        }
    }
    else {
        // Legacy format (non-quiet mode)
        const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
        if (legacyMatch?.[1]) {
            result.sessionId = legacyMatch?.[1] ?? null;
        }
        // In non-quiet mode, extract clean response from stdout by
        // filtering out tool lines, system messages, and noise
        const cleaned = cleanResponse(stdout);
        if (cleaned.length > 0) {
            result.response = cleaned;
        }
    }
    // Extract token usage
    const usageMatch = combined.match(TOKEN_USAGE_REGEX);
    if (usageMatch) {
        result.usage = {
            inputTokens: parseInt(usageMatch[1], 10) || 0,
            outputTokens: parseInt(usageMatch[2], 10) || 0,
        };
    }
    // Extract cost
    const costMatch = combined.match(COST_REGEX);
    if (costMatch?.[1]) {
        result.costUsd = parseFloat(costMatch[1]);
    }
    // Check for error patterns in stderr
    if (stderr.trim()) {
        const errorLines = stderr
            .split("\n")
            .filter((line) => /error|exception|traceback|failed/i.test(line))
            .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
        if (errorLines.length > 0) {
            result.errorMessage = errorLines.slice(0, 5).join("\n");
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------
export async function execute(ctx) {
    const config = (ctx.agent?.adapterConfig ?? {});
    // ── Resolve configuration ──────────────────────────────────────────────
    const hermesCmd = cfgString(config.hermesCommand) || HERMES_CLI;
    const model = cfgString(config.model);
    const provider = cfgString(config.provider);
    const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
    const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
    const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
    const extraArgs = cfgStringArray(config.extraArgs);
    const persistSession = cfgBoolean(config.persistSession) !== false;
    const worktreeMode = cfgBoolean(config.worktreeMode) === true;
    const checkpoints = cfgBoolean(config.checkpoints) === true;
    // ── Build prompt ───────────────────────────────────────────────────────
    const prompt = buildPrompt(ctx, config);
    // ── Build command args ─────────────────────────────────────────────────
    // Use -Q (quiet) to get clean output: just response + session_id line
    const useQuiet = cfgBoolean(config.quiet) !== false; // default true
    const args = ["chat", "-q", prompt];
    if (useQuiet)
        args.push("-Q");
    if (model) {
        args.push("-m", model);
    }
    // Only pass --provider if it's a valid Hermes provider choice.
    if (provider && VALID_PROVIDERS.includes(provider)) {
        args.push("--provider", provider);
    }
    if (toolsets) {
        args.push("-t", toolsets);
    }
    if (worktreeMode)
        args.push("-w");
    if (checkpoints)
        args.push("--checkpoints");
    if (cfgBoolean(config.verbose) === true)
        args.push("-v");
    // Tag sessions as "tool" source so they don't clutter the user's session history.
    // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
    args.push("--source", "tool");
    // Session resume
    const prevSessionId = cfgString(ctx.runtime?.sessionParams?.sessionId);
    if (persistSession && prevSessionId) {
        args.push("--resume", prevSessionId);
    }
    if (extraArgs?.length) {
        args.push(...extraArgs);
    }
    // ── Build environment ──────────────────────────────────────────────────
    const env = {
        ...process.env,
        ...buildMercuryEnv(ctx.agent),
    };
    if (ctx.runId)
        env.MERCURY_RUN_ID = ctx.runId;
    const taskId = cfgString(ctx.config?.taskId);
    if (taskId)
        env.MERCURY_TASK_ID = taskId;
    const userEnv = config.env;
    if (userEnv && typeof userEnv === "object") {
        Object.assign(env, userEnv);
    }
    // ── Resolve working directory ──────────────────────────────────────────
    const cwd = cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
    try {
        await ensureAbsoluteDirectory(cwd);
    }
    catch {
        // Non-fatal
    }
    // ── Log start ──────────────────────────────────────────────────────────
    await ctx.onLog("stdout", `[hermes] Starting Hermes Agent (model=${model ?? "configured-default"}, timeout=${timeoutSec}s)\n`);
    if (prevSessionId) {
        await ctx.onLog("stdout", `[hermes] Resuming session: ${prevSessionId}\n`);
    }
    // ── Execute ────────────────────────────────────────────────────────────
    // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
    // Mercury renders all stderr as red/error in the UI.
    // Wrap onLog to reclassify benign stderr lines as stdout.
    const wrappedOnLog = async (stream, chunk) => {
        if (stream === "stderr") {
            const trimmed = chunk.trimEnd();
            // Benign patterns that should NOT appear as errors:
            // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
            // - MCP server registration messages
            // - Python import/site noise
            const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
                /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
                /Successfully registered all tools/.test(trimmed) ||
                /MCP [Ss]erver/.test(trimmed) ||
                /tool registered successfully/.test(trimmed) ||
                /Application initialized/.test(trimmed);
            if (isBenign) {
                return ctx.onLog("stdout", chunk);
            }
        }
        return ctx.onLog(stream, chunk);
    };
    const result = await runChildProcess(ctx.runId, hermesCmd, args, {
        cwd,
        env,
        timeoutSec,
        graceSec,
        onLog: wrappedOnLog,
    });
    // ── Parse output ───────────────────────────────────────────────────────
    const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");
    await ctx.onLog("stdout", `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`);
    if (parsed.sessionId) {
        await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
    }
    // ── Build result ───────────────────────────────────────────────────────
    const executionResult = {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        provider: provider || null,
        model: model || null,
    };
    if (parsed.errorMessage) {
        executionResult.errorMessage = parsed.errorMessage;
    }
    if (parsed.usage) {
        executionResult.usage = parsed.usage;
    }
    if (parsed.costUsd !== undefined) {
        executionResult.costUsd = parsed.costUsd;
    }
    // Summary from agent response
    if (parsed.response) {
        executionResult.summary = parsed.response.slice(0, 2000);
    }
    // Set resultJson so Mercury can persist run metadata (used for UI display + auto-comments)
    executionResult.resultJson = {
        result: parsed.response || "",
        session_id: parsed.sessionId || null,
        usage: parsed.usage || null,
        cost_usd: parsed.costUsd ?? null,
    };
    // Store session ID for next run
    if (persistSession && parsed.sessionId) {
        executionResult.sessionParams = { sessionId: parsed.sessionId };
        executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
    }
    return executionResult;
}
