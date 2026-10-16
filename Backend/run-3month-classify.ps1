# run-3month-classify.ps1
#
# Safe, resumable runner for TruFinity 3-month Gmail classification.
# Covers 2026-07-16 through 2026-10-16 across service@, support@, billing@trufinity.ca.
#
# MAX_RANGE_DAYS = 90 in the CLI, so the 92-day window is split into two non-overlapping
# sub-windows using the CLI's >=from, <to (exclusive upper bound) semantics:
#   Window 1: 2026-07-16 -> 2026-10-14  (exactly 90 days; July16..Oct13 inclusive)
#   Window 2: 2026-10-14 -> 2026-10-16  (2 days; Oct14..Oct15 inclusive)
# Together they cover 2026-07-16 (inclusive) to 2026-10-16 (exclusive) with no gap/overlap.
#
# PREREQUISITES (verify before running):
#   1. SSH tunnel active on 127.0.0.1:5434 -> TruFinity EC2 (32.192.192.80:5432)
#   2. dist/ is current: run 'npx tsc' in Backend/ if any source changed since last build
#   3. ANTHROPIC_API_KEY and Gmail service-account credentials are present in .env
#   4. GMAIL_CLASSIFIER_MODEL and GMAIL_CLASSIFIER_PROMPT_VERSION in .env must match the
#      values used in all previous batches (idempotency key includes both fields)
#
# SAFETY INVARIANTS ENFORCED BY THIS SCRIPT:
#   --no-notifications  : hardcoded on every invocation; SmtpWorkItemNotifier is never
#                         constructed. email_notification_deliveries is never written.
#                         A non-zero Notifications sent count halts the runner immediately.
#   DB_PORT=5434        : hardcoded; never uses port 5432 (local DB) or 5433 (wrong host).
#   GMAIL_CLASSIFIER_ENABLED=true : required for the CLI to run.
#   GMAIL_CLASSIFIER_MAX_RETRIES=0: no per-message Anthropic retry within a run. Transient
#                         failures are retried on the next script invocation only.
#   Idempotency         : The CLI eligibility query excludes messages already classified
#                         under the current model+prompt_version BEFORE any Gmail fetch or
#                         Anthropic call. No successful message is re-processed.
#   Hard call cap       : --max-calls 500 and --batch-limit 500 bound each invocation to
#                         at most 500 Gmail fetches and 500 Anthropic attempts.
#   Fatal-error halt    : Any non-zero CLI exit stops the ENTIRE runner immediately.
#                         Investigate the output before re-running.
#   No background workers: node dist/scripts/google-gmail-historical-classify.js starts no
#                         schedulers, workers, or PM2 processes; exits via db.destroy().
#   SIGINT/Ctrl-C       : CLI handles SIGINT gracefully. Runner finally block cleans up
#                         environment variables even on interruption.
#
# COMPLETION DETECTION:
#   A combination is done when the CLI reports Eligible < 500 (BATCH_LIMIT).
#   The flag "STOPPED by batch limit" is NOT reliable: it is only set when the for-loop
#   breaks mid-iteration, NOT when the loop exhausts all 500 returned rows naturally while
#   more rows exist in the database. Eligible count < 500 is the correct signal.
#
# RESUMABILITY:
#   Re-running from the beginning is always safe. Already-classified messages are excluded
#   by the DB eligibility query (no Anthropic call or Gmail fetch occurs for them).
#   Completed combinations return Eligible: 0 and finish in seconds on re-run.
#
# EXPECTED RUNTIME  (based on observed ~3.7 s/message including 200ms delay):
#   service@ window 1 remaining  ~100-200 messages  ~6-12 min
#   service@ window 2            ~10-20  messages   ~1 min
#   support@ window 1            ~200-400 messages  ~12-25 min
#   support@ window 2            ~10-20  messages   ~1 min
#   billing@ window 1            ~150-350 messages  ~9-22 min
#   billing@ window 2            ~5-15   messages   ~1 min
#   Total estimate: 40-62 minutes.
#
# ESTIMATED COST (observed 1,249 input + 56 output tokens/message):
#   ~800-1,000 remaining messages at illustrative Haiku rates ($1/M input, $5/M output):
#   Total estimate: ~$1.40 (confirm current provider rates before running).

$ErrorActionPreference = "Stop"

# ---- Configuration -------------------------------------------------------

$DIST_SCRIPT              = "dist\scripts\google-gmail-historical-classify.js"
$BATCH_LIMIT              = 500
$MAX_CALLS                = 500
$DELAY_MS                 = 200
$MAX_RUNS_PER_COMBINATION = 5     # 5 x 500 = up to 2,500 messages per combination

$WIN1_FROM = "2026-07-16"
$WIN1_TO   = "2026-10-14"
$WIN2_FROM = "2026-10-14"
$WIN2_TO   = "2026-10-16"

$MAILBOXES = @(
    "service@trufinity.ca",
    "support@trufinity.ca",
    "billing@trufinity.ca"
)

$WINDOWS = @(
    @{ From = $WIN1_FROM; To = $WIN1_TO; Label = "WIN1-90d" },
    @{ From = $WIN2_FROM; To = $WIN2_TO; Label = "WIN2-2d"  }
)

# ---- Preflight -----------------------------------------------------------

if (-not (Test-Path $DIST_SCRIPT)) {
    Write-Error "Compiled script not found at '$DIST_SCRIPT'. Run 'npx tsc' first."
    exit 1
}

Write-Host "============================================================"
Write-Host "TruFinity 3-Month Gmail Classification Runner"
Write-Host "Mailboxes : $($MAILBOXES -join ', ')"
Write-Host "Window 1  : $WIN1_FROM -> $WIN1_TO (90 days, exclusive upper bound)"
Write-Host "Window 2  : $WIN2_FROM -> $WIN2_TO (2 days, exclusive upper bound)"
Write-Host "Batch cap : $BATCH_LIMIT messages / $MAX_CALLS Anthropic calls per run"
Write-Host "Delay     : $DELAY_MS ms between messages"
Write-Host "Notify    : DISABLED (--no-notifications on every invocation)"
Write-Host "DB        : 127.0.0.1:5434 (TruFinity tunnel)"
Write-Host "Started   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "============================================================"
Write-Host ""

# ---- Set process-scoped env vars (inherited by child Node processes) -----
# dotenv does NOT override existing env vars, so these take precedence over .env.

$env:DB_PORT                      = "5434"
$env:DB_HOST                      = "127.0.0.1"
$env:DB_NAME                      = "trufinity"
$env:GMAIL_CLASSIFIER_ENABLED     = "true"
$env:GMAIL_CLASSIFIER_MAX_RETRIES = "0"

# ---- Accumulated totals across all combinations --------------------------

$totalSucceeded    = 0
$totalFailed       = 0
$totalInputTokens  = 0
$totalOutputTokens = 0
$totalEscalation   = 0
$totalSkipped      = 0

$totalStart = Get-Date
$fatalError = $false
$anyWarning = $false

# ---- Helper: parse an integer from captured output ----------------------

function Get-ParsedInt([string]$Text, [string]$Pattern, [int]$Fallback) {
    if ($Text -match $Pattern) { return [int]$Matches[1] }
    return $Fallback
}

# ---- Main classification loop -------------------------------------------

try {
    foreach ($mailbox in $MAILBOXES) {
        if ($fatalError) { break }

        foreach ($window in $WINDOWS) {
            if ($fatalError) { break }

            $label = "$mailbox  $($window.Label)  [$($window.From) -> $($window.To)]"
            Write-Host ""
            Write-Host "==== START: $label  $(Get-Date -Format 'HH:mm:ss') ===="

            $runs = 0
            $done = $false

            while (-not $done -and $runs -lt $MAX_RUNS_PER_COMBINATION) {
                $runs++
                Write-Host "  [run $runs/$MAX_RUNS_PER_COMBINATION]  $(Get-Date -Format 'HH:mm:ss')"

                $nodeArgs = @(
                    $DIST_SCRIPT,
                    "--mailbox",     $mailbox,
                    "--from",        $window.From,
                    "--to",          $window.To,
                    "--batch-limit", "$BATCH_LIMIT",
                    "--max-calls",   "$MAX_CALLS",
                    "--delay-ms",    "$DELAY_MS",
                    "--no-notifications"
                )

                # Pipe output through ForEach-Object for near-real-time display and capture.
                $runLines = [System.Collections.Generic.List[string]]::new()
                # Windows PowerShell represents native stderr records as errors.  With the
                # script-wide Stop policy, a sanitized diagnostic on stderr could terminate
                # this wrapper before it captured the CLI summary and exit code.  Temporarily
                # continue only while collecting the child streams; the explicit exit-code
                # check below remains the authoritative fatal-error gate.
                $runnerErrorAction = $ErrorActionPreference
                try {
                    $ErrorActionPreference = 'Continue'
                    & node @nodeArgs 2>&1 | ForEach-Object {
                        Write-Host "    $_"
                        [void]$runLines.Add([string]$_)
                    }
                } finally {
                    $ErrorActionPreference = $runnerErrorAction
                }
                $exitCode   = $LASTEXITCODE
                $outputText = $runLines -join "`n"

                # ---- Fatal: stop the entire runner on non-zero CLI exit ----
                if ($exitCode -ne 0) {
                    Write-Host ""
                    Write-Host "  [FATAL] CLI exited with code $exitCode. Stopping all classification." -ForegroundColor Red
                    Write-Host "  Investigate the output above before re-running." -ForegroundColor Red
                    $fatalError = $true
                    $done       = $true
                    break
                }

                # ---- Notification safety guard --------------------------------
                # --no-notifications is hardcoded, but verify the output confirms
                # zero deliveries. Any non-zero count means the flag was not honoured.
                $notifSent = Get-ParsedInt $outputText "Notifications sent:\s+(\d+)" 0
                if ($notifSent -gt 0) {
                    Write-Host ""
                    Write-Host "  [FATAL] Unexpected: Notifications sent = $notifSent. Stopping immediately." -ForegroundColor Red
                    $fatalError = $true
                    $done       = $true
                    break
                }

                # ---- Accumulate stats for this run ---------------------------
                $runSucceeded  = Get-ParsedInt $outputText "Succeeded:\s+(\d+)"           0
                $runFailed     = Get-ParsedInt $outputText "Failed:\s+(\d+)"              0
                $runInput      = Get-ParsedInt $outputText "Input tokens:\s+(\d+)"        0
                $runOutput     = Get-ParsedInt $outputText "Output tokens:\s+(\d+)"       0
                $runEscalation = Get-ParsedInt $outputText "ESCALATION:\s+(\d+)"          0
                $runSkipped    = Get-ParsedInt $outputText "Skipped \(classified\):\s+(\d+)" 0

                $totalSucceeded    += $runSucceeded
                $totalFailed       += $runFailed
                $totalInputTokens  += $runInput
                $totalOutputTokens += $runOutput
                $totalEscalation   += $runEscalation
                $totalSkipped      += $runSkipped

                Write-Host "  [stats] succeeded=$runSucceeded failed=$runFailed skipped=$runSkipped escalation=$runEscalation input_tokens=$runInput output_tokens=$runOutput"

                # A zero process exit is not sufficient when individual rows failed:
                # successful rows are committed and failed rows remain eligible for a
                # later idempotent retry. Stop before declaring this combination done.
                if ($runFailed -gt 0) {
                    Write-Host "  [FATAL] $runFailed message(s) failed. Successful classifications were retained; inspect and re-run to resume failed rows." -ForegroundColor Red
                    $fatalError = $true
                    $done       = $true
                    break
                }

                # ---- Completion detection ------------------------------------
                # Done when Eligible < BATCH_LIMIT: the DB returned fewer rows than
                # the query LIMIT, proving no more unclassified messages remain.
                # Do NOT use "STOPPED by batch limit" -- it is not set when the
                # for-loop exhausts all returned rows naturally before hitting the cap.
                $eligibleCount = Get-ParsedInt $outputText "Eligible:\s+(\d+)" -1

                if ($eligibleCount -lt 0) {
                    Write-Host "  [WARN] Cannot parse Eligible count. Assuming combination complete." -ForegroundColor Yellow
                    $anyWarning = $true
                    $done = $true
                } elseif ($eligibleCount -lt $BATCH_LIMIT) {
                    $done = $true
                    if ($eligibleCount -eq 0) {
                        Write-Host "  [DONE] Eligible: 0. No messages remaining." -ForegroundColor Green
                    } else {
                        Write-Host "  [DONE] Eligible: $eligibleCount (< $BATCH_LIMIT). All messages processed." -ForegroundColor Green
                    }
                } else {
                    Write-Host "  [CONTINUE] Eligible: $eligibleCount = $BATCH_LIMIT. More may remain. Re-running..."
                }
            }

            if (-not $done -and -not $fatalError) {
                Write-Host "  [WARN] Reached $MAX_RUNS_PER_COMBINATION run cap. Re-run this script to continue." -ForegroundColor Yellow
                $anyWarning = $true
            }

            Write-Host "==== END:   $label  $(Get-Date -Format 'HH:mm:ss') ===="
        }
    }
}
finally {
    # Always restore env vars, even on Ctrl-C or unexpected termination.
    Remove-Item Env:\DB_PORT                      -ErrorAction SilentlyContinue
    Remove-Item Env:\DB_HOST                      -ErrorAction SilentlyContinue
    Remove-Item Env:\DB_NAME                      -ErrorAction SilentlyContinue
    Remove-Item Env:\GMAIL_CLASSIFIER_ENABLED     -ErrorAction SilentlyContinue
    Remove-Item Env:\GMAIL_CLASSIFIER_MAX_RETRIES -ErrorAction SilentlyContinue
}

# ---- Overall summary -----------------------------------------------------

$elapsed = (Get-Date) - $totalStart
$elapsedH = [int]$elapsed.TotalHours
$elapsedM = $elapsed.Minutes
$elapsedS = $elapsed.Seconds

Write-Host ""
Write-Host "============================================================"
Write-Host "=== OVERALL TOTALS ==="
Write-Host "  Total succeeded:         $totalSucceeded"
Write-Host "  Total failed:            $totalFailed"
Write-Host "  Total skipped (dup):     $totalSkipped"
Write-Host "  Total escalations:       $totalEscalation"
Write-Host "  Total input tokens:      $totalInputTokens"
Write-Host "  Total output tokens:     $totalOutputTokens"
Write-Host "  Total elapsed:           ${elapsedH}h ${elapsedM}m ${elapsedS}s"
Write-Host "============================================================"

if ($fatalError) {
    Write-Host "RESULT: FATAL ERROR -- runner stopped early. Investigate output above." -ForegroundColor Red
    exit 1
} elseif ($anyWarning) {
    Write-Host "RESULT: Completed with warnings. Re-run to finish remaining combinations." -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "RESULT: All 6 combinations complete. 3-month classification is done." -ForegroundColor Green
    exit 0
}
